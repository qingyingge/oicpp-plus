/**
 * compare-worker-v6.ts — V6 Native posix_spawn worker
 * 每个线程内完全同步: spawn+IO 在 C 层完成, 无事件循环开销.
 * 并行度 = 线程数 (每线程独立跑完整测试).
 * 生成器始终走 child_process（支持 args/cwd，兼容 Python 生成器）；
 * std/test 优先 fastspawn，加载失败时回退 child_process。
 */
import { parentPort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';

// fastspawn.node 在打包配置里位于 asarUnpack，因此它不在 app.asar 内，而被搬到
// app.asar.unpacked/。worker 里写死相对路径 require('../../fastspawn.node') 命中的是
// app.asar 根目录，在打包后必然 MODULE_NOT_FOUND。逐个候选探测，开发态与打包态都能命中。
function loadFastspawn(): { run: (exe: string, input: string, timeout: number) => { code: number; output: string | null; truncated: boolean }; runPair: (std: string, test: string, input: string, timeout: number) => { code1: number; code2: number; out1: string | null; out2: string | null; truncated: boolean } } | null {
    const candidates = [path.resolve(__dirname, '..', '..', 'fastspawn.node')];
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'fastspawn.node'));
    }
    let lastError: Error | null = null;
    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate)) continue;
            return require(candidate);
        } catch (error) {
            lastError = error as Error;
        }
    }
    throw lastError || new Error(`fastspawn.node not found (tried: ${candidates.join(', ')})`);
}

let fast: ReturnType<typeof loadFastspawn> | null = null;
try {
    fast = loadFastspawn();
} catch (e) {
    // 告警是模块级的，同一个 worker 里只上报一次，避免每次对拍刷屏。
    parentPort?.postMessage({ type: 'fastspawn-load-warning', message: (e as Error).message });
}

import { spawn, SpawnOptions } from 'child_process';
import { terminateProcessTree } from '../utils/process-supervisor';

interface WorkerProc extends ReturnType<typeof spawn> {
    _collect: () => Buffer;
    _stderr: () => string;
    _outputTruncated: () => boolean;
    _done: boolean;
    _result: { exitCode: number; error?: string; outputTruncated?: boolean; timeout?: boolean } | null;
    _collectors: Array<(result: { exitCode: number; error?: string; outputTruncated?: boolean; timeout?: boolean }) => void>;
}

const MAX_WORKER_OUTPUT_BYTES = 64 * 1024 * 1024;
const PROCESS_EXIT_GRACE_MS = 5000;
const MAX_CAPTURED_INPUT_BYTES = 1024 * 1024;
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;

function captureText(value: string | Buffer | null | undefined, limit: number): { text: string; truncated: boolean } {
    if (value == null) return { text: '', truncated: false };
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const truncated = buf.length > limit;
    return { text: (truncated ? buf.subarray(0, limit) : buf).toString('utf8'), truncated };
}

function normalizeOutput(value: string | Buffer | null | undefined): string {
    return Buffer.from(value || '')
        .toString('utf8')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n+$/, '');
}

function outputsEqual(left: string | Buffer | null | undefined, right: string | Buffer | null | undefined): boolean {
    return normalizeOutput(left) === normalizeOutput(right);
}

const activeProcesses = new Set<WorkerProc>();

function spawnProcess(exePath: string, args: string[] = [], cwd?: string): Promise<WorkerProc> {
    return new Promise((resolve) => {
        const proc = spawn(exePath, args || [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: process.platform !== 'win32',
            cwd
        }) as WorkerProc;
        activeProcesses.add(proc);
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let outputTruncated = false;
        const append = (target: Buffer[], data: string | Buffer) => {
            if (outputTruncated) return;
            const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
            const remaining = MAX_WORKER_OUTPUT_BYTES - outputBytes;
            if (remaining <= 0 || buffer.length > remaining) {
                outputTruncated = true;
                if (remaining > 0) target.push(buffer.subarray(0, remaining));
                terminateProcessTree(proc);
                return;
            }
            target.push(buffer);
            outputBytes += buffer.length;
        };
        proc.stdout?.on('data', (data) => append(stdout, data));
        proc.stderr?.on('data', (data) => append(stderr, data));
        proc._collect = () => Buffer.concat(stdout);
        proc._stderr = () => Buffer.concat(stderr).toString('utf8');
        proc._outputTruncated = () => outputTruncated;
        proc._done = false;
        proc._result = null;
        proc._collectors = [];
        proc.on('close', (code: number) => {
            activeProcesses.delete(proc);
            proc._result = { exitCode: code, outputTruncated };
            proc._done = true;
            for (const cb of proc._collectors) cb(proc._result);
            proc._collectors = [];
        });
        proc.on('error', (err: Error) => {
            activeProcesses.delete(proc);
            proc._result = { exitCode: -1, error: err.message, outputTruncated };
            proc._done = true;
            for (const cb of proc._collectors) cb(proc._result);
            proc._collectors = [];
        });
        resolve(proc);
    });
}

function waitForResult(proc: WorkerProc, timeout: number): Promise<{ exitCode: number; error?: string; outputTruncated?: boolean; timeout?: boolean }> {
    if (proc._done) return Promise.resolve(proc._result as { exitCode: number; error?: string; outputTruncated?: boolean; timeout?: boolean });
    return new Promise((resolve) => {
        let timer: NodeJS.Timeout | null = null;
        const cb = (result: { exitCode: number; error?: string; outputTruncated?: boolean; timeout?: boolean }) => {
            if (timer) { clearTimeout(timer); timer = null; }
            resolve(result);
        };
        proc._collectors.push(cb);
        if (timeout > 0) {
            timer = setTimeout(() => {
                proc._collectors = proc._collectors.filter(c => c !== cb);
                terminateProcessTree(proc);
                if (proc._done) {
                    resolve({ exitCode: -1, timeout: true, error: 'timeout' });
                    return;
                }
                const giveUp = setTimeout(() => {
                    resolve({ exitCode: -1, timeout: true, error: 'timeout' });
                }, PROCESS_EXIT_GRACE_MS);
                proc._collectors.push((result) => {
                    clearTimeout(giveUp);
                    resolve({ ...result, exitCode: -1, timeout: true, error: 'timeout' });
                });
            }, timeout);
        }
    });
}

function killProc(proc: WorkerProc): void { terminateProcessTree(proc); }

function writeInput(proc: WorkerProc, input: string): Promise<boolean> {
    return new Promise((resolve) => {
        const stdin = proc.stdin;
        if (!stdin) { resolve(false); return; }
        try {
            stdin.on('error', () => { resolve(false); });
        } catch (_) { }
        try {
            if (stdin.destroyed || stdin.writableEnded) { resolve(false); return; }
            stdin.write(input);
            stdin.end();
            resolve(true);
        } catch (_) { resolve(false); }
    });
}

interface RunResult {
    code: number;
    output: Buffer | null;
    outputTruncated: boolean;
    timeout: boolean;
    error: string | null;
    ms: number;
}

async function runJs(exePath: string, input: string | null, timeout: number, args: string[] = [], cwd?: string): Promise<RunResult> {
    const t0 = Date.now();
    const proc = await spawnProcess(exePath, args, cwd);
    if (input !== null && input !== undefined) await writeInput(proc, input);
    const r = await waitForResult(proc, timeout);
    const output = (r.exitCode === -1 || r.exitCode === -3) ? null : proc._collect();
    return { code: r.exitCode, output, outputTruncated: !!r.outputTruncated || !!proc._outputTruncated(), timeout: !!r.timeout, error: r.error ?? null, ms: Date.now() - t0 };
}

function runFast(exePath: string, input: string, timeout: number): RunResult {
    if (!fast) {
        return { code: -1, output: null, outputTruncated: false, timeout: false, error: 'fastspawn module not loaded', ms: 0 };
    }
    const t0 = Date.now();
    const r = fast.run(exePath, input, timeout);
    return {
        code: r.code, output: r.output === null ? null : Buffer.from(r.output, 'utf8'),
        outputTruncated: !!r.truncated,
        timeout: r.code === -3,
        error: r.code === -3 ? 'TLE' : null,
        ms: Date.now() - t0
    };
}

interface FastPairResult {
    code1: number; code2: number;
    out1: string | null; out2: string | null;
    truncated1: boolean; truncated2: boolean;
    ms: number; error?: string;
}

function runFastPair(stdPath: string, testPath: string, input: string, timeout: number): FastPairResult {
    if (!fast) {
        return { code1: -1, code2: -1, out1: null, out2: null, truncated1: false, truncated2: false, ms: 0, error: 'fastspawn module not loaded' };
    }
    const t0 = Date.now();
    const r = fast.runPair(stdPath, testPath, input, timeout);
    const ms = Date.now() - t0;
    return {
        code1: r.code1, code2: r.code2,
        out1: r.out1, out2: r.out2,
        truncated1: !!r.truncated,
        truncated2: !!r.truncated,
        ms
    };
}

async function runGenerator(gen: string | { executablePath?: string; path?: string; exe?: string; args?: string[]; workingDirectory?: string; cwd?: string }, timeout: number): Promise<RunResult> {
    let exe: string | null = null;
    let args: string[] = [];
    let cwd: string | undefined;
    if (typeof gen === 'string') {
        exe = gen;
    } else if (gen && typeof gen === 'object') {
        exe = gen.executablePath || gen.path || gen.exe || '';
        args = gen.args || [];
        cwd = gen.workingDirectory || gen.cwd;
    }
    if (!exe) return { code: -2, error: 'missing generator executable', output: null, outputTruncated: false, timeout: false, ms: 0 };
    return await runJs(exe, null, timeout, args, cwd);
}

let running = false;

if (parentPort) {
    const port = parentPort;
    port.on('message', async (msg: { type: string; startIdx?: number; count?: number; gen?: string | object; stdPath?: string; testPath?: string; timeout?: number; generatorTimeout?: number }) => {
        if (msg.type === 'run-tests') {
            running = true;
            const { startIdx, count, gen, stdPath, testPath, timeout, generatorTimeout } = msg;
            const useFast = !!fast;
            const genTimeout = (typeof generatorTimeout === 'number' && Number.isFinite(generatorTimeout) && generatorTimeout > 0) ? generatorTimeout : 0;
            let lastGenMs = 0, lastStdMs = 0, lastTestMs = 0;

            const fail = (i: number, kind: string, code: string, detail: string, extra: Record<string, unknown> = {}) => {
                const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
                const rawStd = text(extra['rawStd']);
                const rawTest = text(extra['rawTest']);
                const input = captureText(text(extra['rawInput']) ?? '', MAX_CAPTURED_INPUT_BYTES);
                const std = rawStd !== undefined ? captureText(rawStd, MAX_CAPTURED_OUTPUT_BYTES) : null;
                const test = rawTest !== undefined ? captureText(rawTest, MAX_CAPTURED_OUTPUT_BYTES) : null;
                port.postMessage({
                    type: 'error',
                    testIndex: i,
                    kind,
                    code,
                    exitCode: extra['exitCode'],
                    message: String(detail || ''),
                    genMs: lastGenMs,
                    stdMs: extra['includeStdMs'] ? lastStdMs : undefined,
                    testMs: extra['includeTestMs'] ? lastTestMs : undefined,
                    input: input.text,
                    inputTruncated: input.truncated,
                    stdOutput: std ? std.text : undefined,
                    stdOutputTruncated: std ? std.truncated : undefined,
                    testOutput: test ? test.text : undefined,
                    testOutputTruncated: test ? test.truncated : undefined
                });
            };

            for (let i = startIdx ?? 0; i < (startIdx ?? 0) + (count ?? 0) && running; i++) {
                let genOut: RunResult | null = null;
                const rawInput = () => (genOut ? genOut.output : null);
                try {
                    genOut = await runGenerator(gen ?? '', genTimeout);
                    if (!running) break;
                    lastGenMs = genOut.ms || 0;
                    if (genOut.timeout || genOut.error || (genOut.code !== 0 && genOut.code !== null)) {
                        fail(i, 'generator', genOut.timeout ? 'gen_timeout' : (genOut.error ? 'gen_error' : 'gen_exit'),
                            genOut.error || ('generator exit ' + genOut.code), { rawInput: rawInput(), exitCode: genOut.code });
                        continue;
                    }

                    if (useFast) {
                        if (!running) break;
                        const pair = runFastPair(stdPath ?? '', testPath ?? '', genOut.output?.toString() ?? '', timeout ?? 0);
                        lastStdMs = pair.ms;
                        lastTestMs = pair.ms;

                        const stdCode = pair.code1;
                        const testCode = pair.code2;
                        const stdOut = pair.out1;
                        const testOut = pair.out2;
                        const pairExtra = { rawInput: rawInput(), includeStdMs: true, includeTestMs: true };

                        if (stdCode === -3) { fail(i, 'std_tle', 'std_timeout', 'standard program timed out', pairExtra); continue; }
                        if (stdCode !== 0 && stdCode !== null) { fail(i, 'std_re', 'std_exit', 'standard program exit ' + stdCode, { ...pairExtra, exitCode: stdCode }); continue; }
                        if (testCode === -3) { fail(i, 'test_tle', 'test_timeout', 'test program timed out', pairExtra); continue; }
                        if (testCode !== 0 && testCode !== null) { fail(i, 'test_re', 'test_exit', 'test program exit ' + testCode, { ...pairExtra, exitCode: testCode }); continue; }
                        if (pair.truncated1 || pair.truncated2) { fail(i, 'output_limit', 'output_limit', 'program output exceeded limit', pairExtra); continue; }

                        if (!outputsEqual(stdOut, testOut)) {
                            fail(i, 'mismatch', 'mismatch', 'outputs differ', { ...pairExtra, rawStd: stdOut, rawTest: testOut });
                            continue;
                        }
                        port.postMessage({ type: 'progress', testIndex: i, genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, genLen: genOut.output?.length ?? 0 });
                    } else {
                        const stdR = await runJs(stdPath ?? '', genOut.output?.toString() ?? '', timeout ?? 0);
                        if (!running) break;
                        lastStdMs = stdR.ms || 0;
                        const testR = await runJs(testPath ?? '', genOut.output?.toString() ?? '', timeout ?? 0);
                        if (!running) break;
                        lastTestMs = testR.ms || 0;

                        const spawnExtra = { rawInput: rawInput(), includeStdMs: true, includeTestMs: true };
                        if (stdR.timeout) { fail(i, 'std_tle', 'std_timeout', 'standard program timed out', spawnExtra); continue; }
                        if (stdR.error || (stdR.code !== 0 && stdR.code !== null)) { fail(i, 'std_re', stdR.error ? 'std_error' : 'std_exit', stdR.error || ('standard program exit ' + stdR.code), { ...spawnExtra, exitCode: stdR.code }); continue; }
                        if (testR.timeout) { fail(i, 'test_tle', 'test_timeout', 'test program timed out', spawnExtra); continue; }
                        if (testR.error || (testR.code !== 0 && testR.code !== null)) { fail(i, 'test_re', testR.error ? 'test_error' : 'test_exit', testR.error || ('test program exit ' + testR.code), { ...spawnExtra, exitCode: testR.code }); continue; }
                        if (stdR.outputTruncated || testR.outputTruncated) { fail(i, 'output_limit', 'output_limit', 'program output exceeded limit', spawnExtra); continue; }

                        if (!outputsEqual(stdR.output, testR.output)) {
                            fail(i, 'mismatch', 'mismatch', 'outputs differ', { ...spawnExtra, rawStd: stdR.output, rawTest: testR.output });
                            continue;
                        }
                        port.postMessage({ type: 'progress', testIndex: i, genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, genLen: genOut.output?.length ?? 0 });
                    }
                } catch (e) {
                    fail(i, 'exception', 'exception', e && (e as Error).message ? (e as Error).message : String(e), { rawInput: rawInput() });
                }
            }
            port.postMessage({ type: 'done' });
        } else if (msg.type === 'stop') {
            running = false;
            for (const proc of activeProcesses) killProc(proc);
            activeProcesses.clear();
        }
    });
}