/**
 * 重建自本次会话开始时读到的工作区版本（未提交的 timeout-wrapper 重构）。
 * 原文件 src/main-process/compare-worker-v6.ts 被优化改动覆盖，这里留一份副本，
 * 一是保住这份在制品，二是让 A/B 能在完全相同的条件下重跑而不是只靠历史记录。
 * 仅用于基准对照，不参与生产。
 */
import { parentPort, MessagePort } from 'worker_threads';
import { spawn, SpawnOptions } from 'child_process';
import { Readable, Writable } from 'stream';
import * as path from 'path';
import * as fs from 'fs';

interface GeneratorSpec {
    executablePath?: string;
    path?: string;
    exe?: string;
    args?: string[];
    workingDirectory?: string;
    cwd?: string;
}

interface RunTestsMessage {
    type: string;
    startIdx: number;
    count: number;
    gen: string | GeneratorSpec;
    stdPath: string;
    testPath: string;
    timeout: number;
    generatorTimeout: number;
}

interface WrapperResult {
    exitCode: number | null;
    timedOut: boolean;
    signal: string | null;
    stdout: string;
    stderr: string;
    ms: number;
    truncated: boolean;
}

interface FailExtra {
    rawInput?: Buffer | string | null;
    rawStd?: Buffer | string | null;
    rawTest?: Buffer | string | null;
    exitCode?: number | null;
    includeStdMs?: boolean;
    includeTestMs?: boolean;
}

const MAX_CAPTURED_INPUT_BYTES = 1024 * 1024;
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;

function resolveWrapperPath(): string {
    const candidates: string[] = [
        path.resolve(__dirname, 'timeout-wrapper.js'),
        path.resolve(__dirname, '..', 'timeout-wrapper.js'),
    ];
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'timeout-wrapper.js'));
    }
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return candidates[0]!;
}

const WRAPPER_PATH = resolveWrapperPath();

function captureText(value: Buffer | string | null | undefined, limit: number): { text: string; truncated: boolean } {
    if (value == null) return { text: '', truncated: false };
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const truncated = buf.length > limit;
    return { text: (truncated ? buf.subarray(0, limit) : buf).toString('utf8'), truncated };
}

function normalizeOutput(value: Buffer | string | null | undefined): string {
    return Buffer.from(value || '')
        .toString('utf8')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n+$/, '');
}

function outputsEqual(left: Buffer | string | null | undefined, right: Buffer | string | null | undefined): boolean {
    return normalizeOutput(left) === normalizeOutput(right);
}

async function runWithWrapper(
    exePath: string,
    input: Buffer | string | null,
    timeout: number
): Promise<WrapperResult> {
    const args = [
        '--timeout=' + (Number.isFinite(timeout) && timeout > 0 ? timeout : 0),
        '--',
        exePath
    ];

    const proc = spawn(process.execPath, [WRAPPER_PATH, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
    } as SpawnOptions);

    if (input !== null && input !== undefined) {
        try {
            await new Promise<void>((resolve) => {
                const stdin = proc.stdin as Writable;
                stdin.on('error', () => resolve());
                stdin.write(input);
                stdin.end();
                resolve();
            });
        } catch {}
    }

    let stdoutData = '';
    for await (const chunk of proc.stdout as Readable) {
        stdoutData += chunk.toString('utf8');
    }

    await new Promise<void>((resolve) => proc.on('close', resolve));

    const lines = stdoutData.trim().split('\n').filter(l => l.trim());
    const lastLine = lines[lines.length - 1] || '{}';
    let result: WrapperResult;
    try {
        result = JSON.parse(lastLine);
    } catch {
        result = {
            exitCode: -1,
            timedOut: false,
            signal: null,
            stdout: '',
            stderr: 'wrapper output parse failed: ' + lastLine.slice(0, 200),
            ms: 0,
            truncated: false
        };
    }

    return result;
}

async function runGenerator(gen: string | GeneratorSpec, timeout: number): Promise<WrapperResult> {
    let exe: string | null = null, args: string[] = [], cwd: string | undefined = undefined;
    if (typeof gen === 'string') {
        exe = gen;
    } else if (gen && typeof gen === 'object') {
        exe = gen.executablePath || gen.path || gen.exe || '';
        args = gen.args || [];
        cwd = gen.workingDirectory || gen.cwd || undefined;
    }
    if (!exe) return { exitCode: -2, timedOut: false, signal: null, stdout: '', stderr: 'missing generator executable', ms: 0, truncated: false };

    const proc = spawn(exe, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        cwd
    } as SpawnOptions);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let outputTruncated = false;
    const MAX_OUTPUT = 64 * 1024 * 1024;

    const append = (target: Buffer[], data: Buffer | string) => {
        if (outputTruncated) return;
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        const remaining = MAX_OUTPUT - outputBytes;
        if (remaining <= 0 || buffer.length > remaining) {
            outputTruncated = true;
            if (remaining > 0) target.push(buffer.subarray(0, remaining));
            try { proc.kill('SIGKILL'); } catch {}
            return;
        }
        target.push(buffer);
        outputBytes += buffer.length;
    };

    (proc.stdout as Readable).on('data', data => append(stdout, data));
    (proc.stderr as Readable).on('data', data => append(stderr, data));

    const t0 = Date.now();

    return new Promise((resolve) => {
        let timer: NodeJS.Timeout | null = null;
        const onClose = (code: number | null, signal: string | null) => {
            if (timer) clearTimeout(timer);
            const exitCode = typeof code === 'number' ? code : (signal ? -1 : -1);
            const timedOut = code === null && signal === 'SIGKILL';
            resolve({
                exitCode,
                timedOut,
                signal,
                stdout: Buffer.concat(stdout).toString('utf8').replace(/\r\n/g, '\n'),
                stderr: Buffer.concat(stderr).toString('utf8').replace(/\r\n/g, '\n'),
                ms: Date.now() - t0,
                truncated: outputTruncated
            });
        };
        const onError = (err: Error) => {
            if (timer) clearTimeout(timer);
            resolve({
                exitCode: -1,
                timedOut: false,
                signal: null,
                stdout: '',
                stderr: err.message,
                ms: Date.now() - t0,
                truncated: false
            });
        };
        proc.on('close', onClose);
        proc.on('error', onError);

        if (timeout > 0) {
            timer = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch {}
            }, timeout);
        }
    });
}

let running = false;

(parentPort as MessagePort).on('message', async (msg: RunTestsMessage) => {
    if (msg.type === 'run-tests') {
        running = true;
        const { startIdx, count, gen, stdPath, testPath, timeout, generatorTimeout } = msg;
        const genTimeout = (Number.isFinite(generatorTimeout) && generatorTimeout > 0) ? generatorTimeout : 0;
        let lastGenMs = 0, lastStdMs = 0, lastTestMs = 0;

        const fail = (i: number, kind: string, code: string, detail: string, extra: FailExtra = {}) => {
            const input = captureText(extra.rawInput, MAX_CAPTURED_INPUT_BYTES);
            const std = extra.rawStd !== undefined ? captureText(extra.rawStd, MAX_CAPTURED_OUTPUT_BYTES) : null;
            const test = extra.rawTest !== undefined ? captureText(extra.rawTest, MAX_CAPTURED_OUTPUT_BYTES) : null;
            (parentPort as MessagePort).postMessage({
                type: 'error',
                testIndex: i,
                kind,
                code,
                exitCode: extra.exitCode,
                message: String(detail || ''),
                genMs: lastGenMs,
                stdMs: extra.includeStdMs ? lastStdMs : undefined,
                testMs: extra.includeTestMs ? lastTestMs : undefined,
                input: input.text,
                inputTruncated: input.truncated,
                stdOutput: std ? std.text : undefined,
                stdOutputTruncated: std ? std.truncated : undefined,
                testOutput: test ? test.text : undefined,
                testOutputTruncated: test ? test.truncated : undefined
            });
        };

        for (let i = startIdx; i < startIdx + count && running; i++) {
            let genOut: WrapperResult | null = null;
            const rawInput = () => (genOut ? genOut.stdout : null);
            try {
                genOut = await runGenerator(gen, genTimeout);
                if (!running) break;
                lastGenMs = genOut.ms || 0;
                if (genOut.timedOut || genOut.exitCode !== 0 || genOut.signal) {
                    fail(i, 'generator', genOut.timedOut ? 'gen_timeout' : (genOut.signal ? 'gen_error' : 'gen_exit'),
                        genOut.stderr || (genOut.signal ? 'generator killed by ' + genOut.signal : 'generator exit ' + genOut.exitCode), { rawInput: rawInput(), exitCode: genOut.exitCode });
                    continue;
                }

                const [stdR, testR] = await Promise.all([
                    runWithWrapper(stdPath, genOut.stdout, timeout),
                    runWithWrapper(testPath, genOut.stdout, timeout)
                ]);
                if (!running) break;
                lastStdMs = stdR.ms;
                lastTestMs = testR.ms;

                const spawnExtra = { rawInput: rawInput(), includeStdMs: true, includeTestMs: true };

                if (stdR.timedOut) { fail(i, 'std_tle', 'std_timeout', 'standard program timed out', spawnExtra); continue; }
                if (stdR.exitCode !== 0 || stdR.signal) { fail(i, 'std_re', stdR.signal ? 'std_error' : 'std_exit', stdR.stderr || (stdR.signal ? 'standard program killed by ' + stdR.signal : 'standard program exit ' + stdR.exitCode), { ...spawnExtra, exitCode: stdR.exitCode }); continue; }
                if (testR.timedOut) { fail(i, 'test_tle', 'test_timeout', 'test program timed out', spawnExtra); continue; }
                if (testR.exitCode !== 0 || testR.signal) { fail(i, 'test_re', testR.signal ? 'test_error' : 'test_exit', testR.stderr || (testR.signal ? 'test program killed by ' + testR.signal : 'test program exit ' + testR.exitCode), { ...spawnExtra, exitCode: testR.exitCode }); continue; }
                if (stdR.truncated || testR.truncated) { fail(i, 'output_limit', 'output_limit', 'program output exceeded limit', spawnExtra); continue; }

                if (!outputsEqual(stdR.stdout, testR.stdout)) {
                    fail(i, 'mismatch', 'mismatch', 'outputs differ', { ...spawnExtra, rawStd: stdR.stdout, rawTest: testR.stdout });
                    continue;
                }
                (parentPort as MessagePort).postMessage({ type: 'progress', testIndex: i, genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, genLen: Buffer.from(genOut.stdout).length });
            } catch (e) {
                fail(i, 'exception', 'exception', e && (e as Error).message ? (e as Error).message : String(e), { rawInput: rawInput() });
            }
        }
        (parentPort as MessagePort).postMessage({ type: 'done' });
    } else if (msg.type === 'stop') {
        running = false;
    }
});
