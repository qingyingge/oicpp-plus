/**
 * compare-worker-v6.js — V6 Native posix_spawn worker
 * 每个线程内完全同步: spawn+IO 在 C 层完成, 无事件循环开销.
 * 并行度 = 线程数 (每线程独立跑完整测试).
 * 生成器始终走 child_process（支持 args/cwd，兼容 Python 生成器）；
 * std/test 优先 fastspawn，加载失败时回退 child_process。
 */
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

// fastspawn.node 在打包配置里位于 asarUnpack，因此它不在 app.asar 内，而被搬到
// app.asar.unpacked/。worker 里写死相对路径 require('../../fastspawn.node') 命中的是
// app.asar 根目录，在打包后必然 MODULE_NOT_FOUND。逐个候选探测，开发态与打包态都能命中。
function loadFastspawn() {
    const candidates = [path.resolve(__dirname, '..', '..', 'fastspawn.node')];
    if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'fastspawn.node'));
    }
    let lastError = null;
    for (const candidate of candidates) {
        try {
            if (!fs.existsSync(candidate)) continue;
            return require(candidate);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error(`fastspawn.node not found (tried: ${candidates.join(', ')})`);
}

let fast = null;
try {
    fast = loadFastspawn();
} catch (e) {
    // 告警是模块级的，同一个 worker 里只上报一次，避免每次对拍刷屏。
    parentPort.postMessage({ type: 'fastspawn-load-warning', message: e.message });
}

const { spawn } = require('child_process');
const { terminateProcessTree } = require('../utils/process-supervisor');
const MAX_WORKER_OUTPUT_BYTES = 64 * 1024 * 1024;
// 超时 kill 之后等待进程真正退出的上限；超过就放行，把清理失败降级为一条告警。
const PROCESS_EXIT_GRACE_MS = 5000;
// 回传给渲染层的诊断数据上限：截断时必须显式标记，否则导出的测试数据会被静默砍掉
const MAX_CAPTURED_INPUT_BYTES = 1024 * 1024;
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;

function captureText(value, limit) {
    if (value == null) return { text: '', truncated: false };
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const truncated = buf.length > limit;
    return { text: (truncated ? buf.subarray(0, limit) : buf).toString('utf8'), truncated };
}

function normalizeOutput(value) {
    return Buffer.from(value || '')
        .toString('utf8')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n+$/, '');
}

function outputsEqual(left, right) {
    return normalizeOutput(left) === normalizeOutput(right);
}

function spawnProcess(exePath, args, cwd) {
    return new Promise((resolve) => {
        const proc = /** @type {any} */ (spawn(exePath, args || [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: process.platform !== 'win32',
            cwd
        }));
        activeProcesses.add(proc);
        const stdout = [], stderr = [];
        let outputBytes = 0;
        let outputTruncated = false;
        const append = (target, data) => {
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
        proc.stdout.on('data', data => append(stdout, data));
        proc.stderr.on('data', data => append(stderr, data));
        proc._collect = () => Buffer.concat(stdout);
        proc._stderr = () => Buffer.concat(stderr).toString('utf8');
        proc._outputTruncated = () => outputTruncated;
        proc._done = false;
        proc._result = null;
        proc._collectors = [];
        proc.on('close', (code) => { activeProcesses.delete(proc); proc._result = { exitCode: code, outputTruncated }; proc._done = true; for (const cb of proc._collectors) cb(proc._result); proc._collectors = []; });
        proc.on('error', (err) => { activeProcesses.delete(proc); proc._result = { exitCode: -1, error: err.message, outputTruncated }; proc._done = true; for (const cb of proc._collectors) cb(proc._result); proc._collectors = []; });
        resolve(proc);
    });
}

function waitForResult(proc, timeout) {
    if (proc._done) return Promise.resolve(proc._result);
    return new Promise((resolve) => {
        let timer = null;
        const cb = (result) => { if (timer) { clearTimeout(timer); timer = null; } resolve(result); };
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

function killProc(proc) { terminateProcessTree(proc); }

function writeInput(proc, input) {
    return new Promise((resolve) => {
        // 子进程可能在读完输入前就退出（编译失败、std 先崩），此时 write 触发
        // EPIPE。stdin 是 EventEmitter，没有 error 监听就会变成未捕获异常，
        // 直接打崩整个 worker（一组测试失败 → 剩余测试组全部丢失）。
        // 必须在 write 之前挂上。
        try {
            proc.stdin.on('error', () => { resolve(false); });
        } catch (_) { /* stdin 不可用时下面自然失败 */ }
        try {
            if (proc.stdin.destroyed || proc.stdin.writableEnded) { resolve(false); return; }
            proc.stdin.write(input);
            proc.stdin.end();
            resolve(true);
        } catch(_) { resolve(false); }
    });
}

async function runJs(exePath, input, timeout, args, cwd) {
    const t0 = Date.now();
    const proc = await spawnProcess(exePath, args, cwd);
    if (input !== null && input !== undefined) await writeInput(proc, input);
    const r = await waitForResult(proc, timeout);
    const output = (r.exitCode === -1 || r.exitCode === -3) ? null : proc._collect();
    return { code: r.exitCode, output, outputTruncated: !!r.outputTruncated || !!proc._outputTruncated?.(), timeout: !!r.timeout, error: r.error, ms: Date.now() - t0 };
}

function runFast(exePath, input, timeout) {
    if (!fast) {
        return { code: -1, output: null, timeout: false, error: 'fastspawn module not loaded', ms: 0 };
    }
    const t0 = Date.now();
    const r = fast.run(exePath, input, timeout);
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

function runFastPair(stdPath, testPath, input, timeout) {
    if (!fast) {
        return { code1: -1, code2: -1, out1: null, out2: null, ms: 0, error: 'fastspawn module not loaded' };
    }
    const t0 = Date.now();
    const r = fast.runPair(stdPath, testPath, input, timeout);
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

async function runGenerator(gen, timeout) {
    let exe = null, args = [], cwd = undefined;
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
const activeProcesses = new Set();

parentPort.on('message', async (msg) => {
    if (msg.type === 'run-tests') {
        running = true;
        const { startIdx, count, gen, stdPath, testPath, timeout, generatorTimeout } = msg;
        const useFast = !!fast;
        const genTimeout = (Number.isFinite(generatorTimeout) && generatorTimeout > 0) ? generatorTimeout : 0;
        let lastGenMs = 0, lastStdMs = 0, lastTestMs = 0;

        // code 是给渲染层做 i18n 映射用的稳定标识，message 仅作技术细节，不再直接进 UI
        const fail = (i, kind, code, detail, extra = {}) => {
            const input = captureText(extra.rawInput, MAX_CAPTURED_INPUT_BYTES);
            const std = extra.rawStd !== undefined ? captureText(extra.rawStd, MAX_CAPTURED_OUTPUT_BYTES) : null;
            const test = extra.rawTest !== undefined ? captureText(extra.rawTest, MAX_CAPTURED_OUTPUT_BYTES) : null;
            parentPort.postMessage({
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
            let genOut = null;
            const rawInput = () => (genOut ? genOut.output : null);
            try {
                genOut = await runGenerator(gen, genTimeout);
                if (!running) break;
                lastGenMs = genOut.ms || 0;
                if (genOut.timeout || genOut.error || genOut.code !== 0) {
                    fail(i, 'generator', genOut.timeout ? 'gen_timeout' : (genOut.error ? 'gen_error' : 'gen_exit'),
                        genOut.error || ('generator exit ' + genOut.code), { rawInput: rawInput(), exitCode: genOut.code });
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
                    parentPort.postMessage({ type: 'progress', testIndex: i, genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, genLen: genOut.output.length });
                } else {
                    const stdR = await runJs(stdPath, genOut.output, timeout);
                    if (!running) break;
                    lastStdMs = stdR.ms || 0;
                    const testR = await runJs(testPath, genOut.output, timeout);
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
                    parentPort.postMessage({ type: 'progress', testIndex: i, genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, genLen: genOut.output.length });
                }
            } catch(e) {
                fail(i, 'exception', 'exception', e && e.message ? e.message : String(e), { rawInput: rawInput() });
            }
        }
        parentPort.postMessage({ type: 'done' });
    } else if (msg.type === 'stop') {
        running = false;
        for (const proc of activeProcesses) killProc(proc);
        activeProcesses.clear();
    }
});
