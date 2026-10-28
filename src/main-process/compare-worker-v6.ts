/**
 * compare-worker-v6.js — V6 Native posix_spawn worker
 * 每个线程内完全同步: spawn+IO 在 C 层完成, 无事件循环开销.
 * 并行度 = 线程数 (每线程独立跑完整测试).
 * 生成器始终走 child_process（支持 args/cwd，兼容 Python 生成器）；
 * std/test 优先 fastspawn，加载失败时回退 child_process。
 */
import { parentPort, MessagePort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';

interface FastspawnRunResult {
    code: number;
    output: string | null;
    truncated: boolean;
}

interface FastspawnPairRunResult {
    code1: number;
    code2: number;
    out1: string | null;
    out2: string | null;
    truncated: boolean;
}

interface FastspawnModule {
    run: (exe: string, input: Buffer | string | null, timeout: number) => FastspawnRunResult;
    runPair: (std: string, test: string, input: Buffer | string | null, timeout: number) => FastspawnPairRunResult;
}

// fastspawn.node 在打包配置里位于 asarUnpack，因此它不在 app.asar 内，而被搬到
// app.asar.unpacked/。worker 里写死相对路径 require('../../fastspawn.node') 命中的是
// app.asar 根目录，在打包后必然 MODULE_NOT_FOUND。逐个候选探测，开发态与打包态都能命中。
function loadFastspawn(): FastspawnModule | null {
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

let fast: FastspawnModule | null = null;
try {
    fast = loadFastspawn();
} catch (e) {
    // 告警是模块级的，同一个 worker 里只上报一次，避免每次对拍刷屏。
    (parentPort as MessagePort).postMessage({ type: 'fastspawn-load-warning', message: (e as Error).message });
}

import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import { terminateProcessTree } from '../utils/process-supervisor';

interface ProcResult {
    exitCode: number;
    error?: string;
    signal?: string | null;
    outputTruncated?: boolean;
    timeout?: boolean;
}

interface WorkerProc extends ReturnType<typeof spawn> {
    _collect: () => Buffer;
    _stderr: () => string;
    _outputTruncated: () => boolean;
    _done: boolean;
    _result: ProcResult | null;
    _collectors: Array<(result: ProcResult) => void>;
}

interface RunResult {
    code: number;
    output: Buffer | string | null;
    outputTruncated?: boolean;
    timeout?: boolean;
    error?: string | null;
    signal?: string | null;
    ms: number;
}

interface FastPairResult {
    code1: number;
    code2: number;
    out1: string | null;
    out2: string | null;
    truncated1?: boolean;
    truncated2?: boolean;
    ms: number;
    error?: string;
}

interface GeneratorSpec {
    executablePath?: string;
    path?: string;
    exe?: string;
    args?: string[];
    workingDirectory?: string;
    cwd?: string;
}

interface FailExtra {
    rawInput?: Buffer | string | null;
    rawStd?: Buffer | string | null;
    rawTest?: Buffer | string | null;
    exitCode?: number | null;
    includeStdMs?: boolean;
    includeTestMs?: boolean;
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

/**
 * 对拍工作进程的句柄：在标准 ChildProcess 上扩展了对拍自定义属性。
 * @typedef {{
 *   _collect: () => Buffer,
 *   _stderr: () => string,
 *   _outputTruncated: () => boolean,
 *   _done: boolean,
 *   _result: { exitCode: number, error?: string, outputTruncated?: boolean, timeout?: boolean } | null,
 *   _collectors: Array<Function>,
 * } & import('child_process').ChildProcess} WorkerProc
 */
const MAX_WORKER_OUTPUT_BYTES = 64 * 1024 * 1024;
// 超时 kill 之后等待进程真正退出的上限；超过就放行，把清理失败降级为一条告警。
const PROCESS_EXIT_GRACE_MS = 5000;
// 回传给渲染层的诊断数据上限：截断时必须显式标记，否则导出的测试数据会被静默砍掉
const MAX_CAPTURED_INPUT_BYTES = 1024 * 1024;
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;

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
    // 逐字节相同是对拍里的高频主情形；先裸比较短路，MB 级输出免掉两侧各一轮
    // Buffer.from 复制 + utf8 解码 + 4 趟 replace/split/join。判等口径没变：
    // 不相同（含 string 混入）仍回到唯一一套 normalizeOutput。
    if (Buffer.isBuffer(left) && Buffer.isBuffer(right)
        && (left === right || (left.length === right.length && left.equals(right)))) {
        return true;
    }
    return normalizeOutput(left) === normalizeOutput(right);
}

function spawnProcess(exePath: string, args?: string[], cwd?: string): Promise<WorkerProc> {
    return new Promise((resolve) => {
        const proc = (spawn(exePath, args || [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: process.platform !== 'win32',
            cwd
        }) as WorkerProc);
        activeProcesses.add(proc);
        const stdout: Buffer[] = [], stderr: Buffer[] = [];
        let outputBytes = 0;
        let outputTruncated = false;
        const append = (target: Buffer[], data: Buffer | string) => {
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
        (proc.stdout as Readable).on('data', data => append(stdout, data));
        (proc.stderr as Readable).on('data', data => append(stderr, data));
        proc._collect = () => Buffer.concat(stdout);
        proc._stderr = () => Buffer.concat(stderr).toString('utf8');
        proc._outputTruncated = () => outputTruncated;
        proc._done = false;
        proc._result = null;
        proc._collectors = [];
        // close(code, signal)：子进程被信号杀死时 code 为 null，这是唯一没被归一化的退出状态。
        // 下游 `code !== 0 && code !== null` 会把它当成成功，于是拿崩溃前截断的输出继续与
        // 标准程序比对（恰好相同就误判成通过）。这里折算成 -1，与 error/超时分支一致。
        proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => { activeProcesses.delete(proc); proc._result = { exitCode: (typeof code === 'number' ? code : -1), signal: signal || null, outputTruncated }; proc._done = true; for (const cb of proc._collectors) cb(proc._result); proc._collectors = []; });
        proc.on('error', (err: Error) => { activeProcesses.delete(proc); proc._result = { exitCode: -1, error: err.message, outputTruncated }; proc._done = true; for (const cb of proc._collectors) cb(proc._result); proc._collectors = []; });
        resolve(proc);
    });
}

function waitForResult(proc: WorkerProc, timeout: number): Promise<ProcResult> {
    if (proc._done) return Promise.resolve(proc._result as ProcResult);
    return new Promise((resolve) => {
        let timer: NodeJS.Timeout | null = null;
        const cb = (result: ProcResult) => { if (timer) { clearTimeout(timer); timer = null; } resolve(result); };
        proc._collectors.push(cb);
        if (timeout > 0) {
            timer = setTimeout(() => {
                proc._collectors = proc._collectors.filter(c => c !== cb);
                terminateProcessTree(proc);
                // taskkill 返回后目标进程的映像尚未从系统卸载，此刻渲染层去删 exe 会拿到
                // EPERM/EBUSY。超时是整条对拍里进程存活最久的那一个（退出最晚），所以这里
                // 必须等到 'close' 才放行，且要有上限，不能让清理被一个赖着不走的进程卡死。
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

// 回退路径生成器预取开关（环境变量 OICPP_COMPARE_PREFETCH=0 关闭）：
// 预取让每个 worker 并发进程数 2→3，短程序场景（gen 占主导）净赚，
// 长程序场景在 CPU 饱和机器上反而挤掉 std/test 的核。默认开，benchmark 可 A/B。
const PREFETCH_ENABLED = process.env['OICPP_COMPARE_PREFETCH'] !== '0';

// 不限时（0）时给 native 同步调用兜一个墙钟上限：fastspawn 会把 0 当成
// NO_DEADLINE(=INT64_MAX)，此时死循环的程序永远不返回，worker 线程被占死，
// postMessage('stop') 与 worker.terminate() 都打不断，整轮对拍就此挂死。
// 60s 远大于任何正常测试点，又足以把死循环判成 TLE。
const UNLIMITED_RUN_FALLBACK_MS = 60 * 1000;

function effectiveRunTimeout(timeout: number): number {
    return (Number.isFinite(timeout) && timeout > 0) ? timeout : UNLIMITED_RUN_FALLBACK_MS;
}

// worker 被 terminate 时不会执行 stop 消息，Windows 回退路径下的子进程
// 会变成孤儿继续跑；进程退出钩子是唯一能兜住它们的时机
process.on('exit', () => {
    for (const proc of activeProcesses) {
        try { killProc(proc); } catch (_) {}
    }
    activeProcesses.clear();
});

function writeInput(proc: WorkerProc, input: Buffer | string): Promise<boolean> {
    return new Promise((resolve) => {
        // 子进程可能在读完输入前就退出（编译失败、std 先崩），此时 write 触发
        // EPIPE。stdin 是 EventEmitter，没有 error 监听就会变成未捕获异常，
        // 直接打崩整个 worker（一组测试失败 → 剩余测试组全部丢失）。
        // 必须在 write 之前挂上。
        try {
            (proc.stdin as Writable).on('error', () => { resolve(false); });
        } catch (_) { /* stdin 不可用时下面自然失败 */ }
        try {
            if ((proc.stdin as Writable).destroyed || (proc.stdin as Writable).writableEnded) { resolve(false); return; }
            (proc.stdin as Writable).write(input);
            (proc.stdin as Writable).end();
            resolve(true);
        } catch(_) { resolve(false); }
    });
}

async function runJs(exePath: string, input: Buffer | string | null, timeout: number, args?: string[], cwd?: string): Promise<RunResult> {
    const t0 = Date.now();
    const proc = await spawnProcess(exePath, args, cwd);
    if (input !== null && input !== undefined) await writeInput(proc, input);
    const r = await waitForResult(proc, timeout);
    const output = (r.exitCode === -1 || r.exitCode === -3) ? null : proc._collect();
    return { code: r.exitCode, output, outputTruncated: !!r.outputTruncated || !!proc._outputTruncated?.(), timeout: !!r.timeout, error: r.error, signal: r.signal || null, ms: Date.now() - t0 };
}

function runFast(exePath: string, input: Buffer | string | null, timeout: number): RunResult {
    if (!fast) {
        return { code: -1, output: null, timeout: false, error: 'fastspawn module not loaded', ms: 0 };
    }
    const t0 = Date.now();
    const r = fast.run(exePath, input, effectiveRunTimeout(timeout));
    // 截断标志由 native 侧回报。原先靠 output.length >= MAX_WORKER_OUTPUT_BYTES 猜，
    // 而 native 的 MAX_OUTPUT(64MB) 与 JS 的 MAX_WORKER_OUTPUT_BYTES(32MB) 不等，
    // 落在两者之间的截断完全察觉不到，会拿残缺输出判等。
    return {
        code: r.code, output: r.output,
        outputTruncated: !!r.truncated,
        timeout: r.code === -3,
        error: r.code === -3 ? 'TLE' : null,
        ms: Date.now() - t0
    };
}

function runFastPair(stdPath: string, testPath: string, input: Buffer | string | null, timeout: number): FastPairResult {
    if (!fast) {
        return { code1: -1, code2: -1, out1: null, out2: null, ms: 0, error: 'fastspawn module not loaded' };
    }
    const t0 = Date.now();
    const r = fast.runPair(stdPath, testPath, input, effectiveRunTimeout(timeout));
    const ms = Date.now() - t0;
    return {
        code1: r.code1, code2: r.code2,
        out1: r.out1, out2: r.out2,
        // 同上：以 native 回传的 truncated 为准，不用长度猜
        truncated1: !!r.truncated,
        truncated2: !!r.truncated,
        ms
    };
}

async function runGenerator(gen: string | GeneratorSpec, timeout: number): Promise<RunResult> {
    let exe: string | null = null, args: string[] = [], cwd: string | undefined = undefined;
    if (typeof gen === 'string') {
        exe = gen;
    } else if (gen && typeof gen === 'object') {
        exe = gen.executablePath || gen.path || gen.exe || '';
        args = gen.args || [];
        cwd = gen.workingDirectory || gen.cwd || undefined;
    }
    if (!exe) return { code: -2, error: 'missing generator executable', output: null, ms: 0 };
    return await runJs(exe, null, timeout, args, cwd);
}

let running = false;
const activeProcesses = new Set<WorkerProc>();

(parentPort as MessagePort).on('message', async (msg: RunTestsMessage) => {
    if (msg.type === 'run-tests') {
        running = true;
        const { startIdx, count, gen, stdPath, testPath, timeout, generatorTimeout } = msg;
        const useFast = !!fast;
        const genTimeout = (Number.isFinite(generatorTimeout) && generatorTimeout > 0) ? generatorTimeout : 0;
        let lastGenMs = 0, lastStdMs = 0, lastTestMs = 0;
        // 回退路径的生成器预取：std/test 并发期间事件循环是空的，提前把下一组
        // 生成器进程起出来，每测耗时从 gen+max(std,test) 收敛到 max(gen, max(std,test))。
        // fastpath 的 runFastPair 是同步 native 调用，会占死本线程事件循环，
        // 预取的生成器子进程写满管道缓冲区就得等 —— 没有重叠收益，不预取。
        let pendingGen: Promise<RunResult> | null = null;

        // code 是给渲染层做 i18n 映射用的稳定标识，message 仅作技术细节，不再直接进 UI
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
            let genOut: RunResult | null = null;
            const rawInput = () => (genOut ? genOut.output : null);
            try {
                genOut = pendingGen ? await pendingGen : await runGenerator(gen, genTimeout);
                pendingGen = null;
                if (!running) break;
                lastGenMs = genOut.ms || 0;
                if (genOut.timeout || genOut.error || genOut.signal || genOut.code !== 0) {
                    fail(i, 'generator', genOut.timeout ? 'gen_timeout' : (genOut.error || genOut.signal ? 'gen_error' : 'gen_exit'),
                        genOut.error || (genOut.signal ? 'generator killed by ' + genOut.signal : 'generator exit ' + genOut.code), { rawInput: rawInput(), exitCode: genOut.code });
                    continue;
                }

                if (useFast) {
                    if (!running) break;
                    const pair = runFastPair(stdPath, testPath, genOut.output, timeout);
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
                    (parentPort as MessagePort).postMessage({ type: 'progress', testIndex: i, genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, genLen: (genOut.output as Buffer).length });
                } else {
                    if (PREFETCH_ENABLED && running && i + 1 < startIdx + count) pendingGen = runGenerator(gen, genTimeout);
                    const stdR0 = runJs(stdPath, genOut.output, timeout);
                    const testR0 = runJs(testPath, genOut.output, timeout);
                    const [stdR, testR] = await Promise.all([stdR0, testR0]);
                    if (!running) break;
                    lastStdMs = stdR.ms || 0;
                    lastTestMs = testR.ms || 0;

                    const spawnExtra = { rawInput: rawInput(), includeStdMs: true, includeTestMs: true };
                    if (stdR.timeout) { fail(i, 'std_tle', 'std_timeout', 'standard program timed out', spawnExtra); continue; }
                    // signal 分支要在退出码分支之前：被信号杀死时 exitCode 已被折算成 -1，
                    // 只看退出码会把 SIGSEGV/SIGABRT 报成普通的「退出码 -1」
                    if (stdR.error || stdR.signal || (stdR.code !== 0 && stdR.code !== null)) { fail(i, 'std_re', (stdR.error || stdR.signal) ? 'std_error' : 'std_exit', stdR.error || (stdR.signal ? 'standard program killed by ' + stdR.signal : 'standard program exit ' + stdR.code), { ...spawnExtra, exitCode: stdR.code }); continue; }
                    if (testR.timeout) { fail(i, 'test_tle', 'test_timeout', 'test program timed out', spawnExtra); continue; }
                    if (testR.error || testR.signal || (testR.code !== 0 && testR.code !== null)) { fail(i, 'test_re', (testR.error || testR.signal) ? 'test_error' : 'test_exit', testR.error || (testR.signal ? 'test program killed by ' + testR.signal : 'test program exit ' + testR.code), { ...spawnExtra, exitCode: testR.code }); continue; }
                    if (stdR.outputTruncated || testR.outputTruncated) { fail(i, 'output_limit', 'output_limit', 'program output exceeded limit', spawnExtra); continue; }

                    if (!outputsEqual(stdR.output, testR.output)) {
                        fail(i, 'mismatch', 'mismatch', 'outputs differ', { ...spawnExtra, rawStd: stdR.output, rawTest: testR.output });
                        continue;
                    }
                    (parentPort as MessagePort).postMessage({ type: 'progress', testIndex: i, genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, genLen: (genOut.output as Buffer).length });
                }
            } catch(e) {
                fail(i, 'exception', 'exception', e && (e as Error).message ? (e as Error).message : String(e), { rawInput: rawInput() });
            }
        }
        (parentPort as MessagePort).postMessage({ type: 'done' });
    } else if (msg.type === 'stop') {
        running = false;
        for (const proc of activeProcesses) killProc(proc);
        activeProcesses.clear();
    }
});
