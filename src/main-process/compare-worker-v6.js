/**
 * compare-worker-v6.js — V6 Native posix_spawn worker
 * 每个线程内完全同步: spawn+IO 在 C 层完成, 无事件循环开销.
 * 并行度 = 线程数 (每线程独立跑完整测试).
 * 生成器始终走 child_process（支持 args/cwd，兼容 Python 生成器）；
 * std/test 优先 fastspawn，加载失败时回退 child_process。
 */
const { parentPort } = require('worker_threads');

let fast = null;
try { fast = require('../../fastspawn.node'); } catch(e) { parentPort.postMessage({ type: 'fastspawn-load-error', message: e.message }); }

const { spawn } = require('child_process');

function spawnProcess(exePath, args, cwd) {
    return new Promise((resolve) => {
        const proc = spawn(exePath, args || [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, cwd });
        currentProc = proc;
        const stdout = [], stderr = [];
        proc.stdout.on('data', d => stdout.push(d));
        proc.stderr.on('data', d => stderr.push(d));
        proc._collect = () => Buffer.concat(stdout);
        proc._stderr = () => Buffer.concat(stderr).toString('utf8');
        proc._done = false;
        proc._result = null;
        proc._collectors = [];
        proc.on('close', (code) => { if (currentProc === proc) currentProc = null; proc._result = { exitCode: code }; proc._done = true; for (const cb of proc._collectors) cb(proc._result); proc._collectors = []; });
        proc.on('error', (err) => { if (currentProc === proc) currentProc = null; proc._result = { exitCode: -1, error: err.message }; proc._done = true; for (const cb of proc._collectors) cb(proc._result); proc._collectors = []; });
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
                try { proc.kill('SIGKILL'); } catch(_) {}
                resolve({ exitCode: -1, timeout: true, error: 'timeout' });
            }, timeout);
        }
    });
}

function killProc(proc) { try { proc.kill('SIGKILL'); } catch(_) {} }

function writeInput(proc, input) {
    return new Promise((resolve) => {
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
    if (input) await writeInput(proc, input);
    const r = await waitForResult(proc, timeout);
    const output = (r.exitCode === -1 || r.exitCode === -3) ? null : proc._collect();
    return { code: r.exitCode, output, timeout: !!r.timeout, error: r.error, ms: Date.now() - t0 };
}

function runFast(exePath, input, timeout) {
    if (!fast) {
        return { code: -1, output: null, timeout: false, error: 'fastspawn module not loaded', ms: 0 };
    }
    const t0 = Date.now();
    const r = fast.run(exePath, input, timeout);
    return { code: r.code, output: r.output, timeout: r.code === -3, error: r.code === -3 ? 'TLE' : null, ms: Date.now() - t0 };
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
let currentProc = null;

parentPort.on('message', async (msg) => {
    if (msg.type === 'run-tests') {
        running = true;
        const { startIdx, count, gen, stdPath, testPath, timeout, generatorTimeout } = msg;
        const useFast = !!fast;
        const genTimeout = generatorTimeout || 5000;
        let lastGenMs = 0, lastStdMs = 0, lastTestMs = 0;

        for (let i = startIdx; i < startIdx + count && running; i++) {
            let genOut = null;
            try {
                genOut = await runGenerator(gen, genTimeout);
                lastGenMs = genOut.ms || 0;
                if (genOut.timeout || genOut.error || genOut.code !== 0) {
                    parentPort.postMessage({ type: 'error', testIndex: i, kind: 'generator', message: genOut.error || 'gen fail', genMs: lastGenMs, input: genOut.output ? genOut.output.toString('utf8', 0, 2000) : '' });
                    continue;
                }

                if (useFast) {
                    const pair = runFastPair(stdPath, testPath, genOut.output, timeout);
                    lastStdMs = pair.ms;
                    lastTestMs = pair.ms;

                    const stdCode = pair.code1;
                    const testCode = pair.code2;
                    const stdOut = pair.out1;
                    const testOut = pair.out2;

                    if (stdCode === -3) { parentPort.postMessage({ type: 'error', testIndex: i, kind: 'std_tle', message: 'std TLE', genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, input: genOut.output.toString('utf8', 0, 2000) }); continue; }
                    if (stdCode !== 0 && stdCode !== null) { parentPort.postMessage({ type: 'error', testIndex: i, kind: 'std_re', message: 'std exit ' + stdCode, genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, input: genOut.output.toString('utf8', 0, 2000) }); continue; }
                    if (testCode === -3) { parentPort.postMessage({ type: 'error', testIndex: i, kind: 'test_tle', message: 'test TLE', genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, input: genOut.output.toString('utf8', 0, 2000) }); continue; }
                    if (testCode !== 0 && testCode !== null) { parentPort.postMessage({ type: 'error', testIndex: i, kind: 'test_re', message: 'test exit ' + testCode, genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, input: genOut.output.toString('utf8', 0, 2000) }); continue; }

                    if (!stdOut.equals(testOut)) {
                        parentPort.postMessage({ type: 'error', testIndex: i, kind: 'mismatch', message: 'WA',
                            stdOutput: stdOut.toString('utf8', 0, 200), testOutput: testOut.toString('utf8', 0, 200),
                            genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, input: genOut.output.toString('utf8', 0, 2000) });
                        continue;
                    }
                    parentPort.postMessage({ type: 'progress', testIndex: i, genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, genLen: genOut.output.length });
                } else {
                    const stdR = await runJs(stdPath, genOut.output, timeout);
                    lastStdMs = stdR.ms || 0;
                    const testR = await runJs(testPath, genOut.output, timeout);
                    lastTestMs = testR.ms || 0;

                    if (stdR.timeout) { parentPort.postMessage({ type: 'error', testIndex: i, kind: 'std_tle', message: 'std TLE', genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, input: genOut.output.toString('utf8', 0, 2000) }); continue; }
                    if (stdR.error || (stdR.code !== 0 && stdR.code !== null)) { parentPort.postMessage({ type: 'error', testIndex: i, kind: 'std_re', message: stdR.error || ('std exit ' + stdR.code), genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, input: genOut.output.toString('utf8', 0, 2000) }); continue; }
                    if (testR.timeout) { parentPort.postMessage({ type: 'error', testIndex: i, kind: 'test_tle', message: 'test TLE', genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, input: genOut.output.toString('utf8', 0, 2000) }); continue; }
                    if (testR.error || (testR.code !== 0 && testR.code !== null)) { parentPort.postMessage({ type: 'error', testIndex: i, kind: 'test_re', message: testR.error || ('test exit ' + testR.code), genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, input: genOut.output.toString('utf8', 0, 2000) }); continue; }

                    if (!stdR.output.equals(testR.output)) {
                        parentPort.postMessage({ type: 'error', testIndex: i, kind: 'mismatch', message: 'WA',
                            stdOutput: stdR.output.toString('utf8', 0, 200), testOutput: testR.output.toString('utf8', 0, 200),
                            genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, input: genOut.output.toString('utf8', 0, 2000) });
                        continue;
                    }
                    parentPort.postMessage({ type: 'progress', testIndex: i, genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, genLen: genOut.output.length });
                }
            } catch(e) {
                parentPort.postMessage({
                    type: 'error', testIndex: i, kind: 'exception', message: e.message,
                    input: genOut && genOut.output ? genOut.output.toString('utf8', 0, 2000) : ''
                });
            }
        }
        parentPort.postMessage({ type: 'done' });
    } else if (msg.type === 'stop') {
        running = false;
        if (currentProc) { killProc(currentProc); currentProc = null; }
    }
});
