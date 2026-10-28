"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * compare-worker-v6.ts — V11 原生 posix_spawn worker
 *
 * 每个线程内 std/test 由 fastspawn 同步执行（spawn + IO 全在 C 层，无事件循环开销），
 * 并行度 = 线程数。加载不到原生模块时回退 child_process —— Windows 上走的就是这条，
 * scripts/build-fastspawn.js 在非 POSIX 平台不产出 .node，所以回退路径也必须是快的。
 *
 * 两条路径的判定逻辑合用在 judgePair 里：同一种失败必须产出同一个 kind / code /
 * message，否则用户在 Linux 上和 Windows 上看到的对拍结论会不一样，而这类分裂
 * 只有对照两台机器才能发现。
 */
const worker_threads_1 = require("worker_threads");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const process_supervisor_1 = require("/tmp/oicpp-plus/src/utils/process-supervisor");
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
            if (!fs.existsSync(candidate))
                continue;
            return require(candidate);
        }
        catch (error) {
            lastError = error;
        }
    }
    throw lastError || new Error(`fastspawn.node not found (tried: ${candidates.join(', ')})`);
}
let fast = null;
try {
    fast = loadFastspawn();
}
catch (e) {
    // 告警是模块级的，同一个 worker 里只上报一次，避免每次对拍刷屏。
    worker_threads_1.parentPort.postMessage({ type: 'fastspawn-load-warning', message: e.message });
}
const MAX_WORKER_OUTPUT_BYTES = 64 * 1024 * 1024;
// 超时 kill 之后等待进程真正退出的上限；超过就放行，把清理失败降级为一条告警。
const PROCESS_EXIT_GRACE_MS = 5000;
// 回传给渲染层的诊断数据上限：截断时必须显式标记，否则导出的测试数据会被静默砍掉
const MAX_CAPTURED_INPUT_BYTES = 1024 * 1024;
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;
// worker 被 terminate 时不会执行 stop 消息，Windows 回退路径下的子进程
// 会变成孤儿继续跑；进程退出钩子是唯一能兜住它们的时机
const activeProcesses = new Set();
// native 只回传信号的编号，而 message 要能读出「SIGSEGV」这种名字。
// 表里只放会被程序真实触发的信号：没列到的回落成 "signal N"，
// 宁可描述粗一点，也好过两边路径对同一次崩溃给出不同措辞之外再丢信息。
const SIGNAL_NAMES = {
    4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE',
    9: 'SIGKILL', 10: 'SIGUSR1', 11: 'SIGSEGV', 12: 'SIGUSR2', 13: 'SIGPIPE',
    14: 'SIGALRM', 15: 'SIGTERM'
};
function signalName(signum) {
    return SIGNAL_NAMES[signum] || 'signal ' + signum;
}
function captureText(value, limit) {
    if (value == null)
        return { text: '', truncated: false };
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
// 判等的参照物。native 已经能自己判（并且只在纯 ASCII 时下结论），
// 非 ASCII 与回退路径仍然走这里，两条路共用同一份语义定义。
function outputsEqual(left, right) {
    return normalizeOutput(left) === normalizeOutput(right);
}
function killProc(proc) {
    (0, process_supervisor_1.terminateProcessTree)(proc);
}
process.on('exit', () => {
    for (const proc of activeProcesses) {
        try {
            killProc(proc);
        }
        catch (_) { /* 退出钩子里不能再抛 */ }
    }
    activeProcesses.clear();
});
// 不限时（0）时给 native 同步调用兜一个墙钟上限：fastspawn 会把 0 当成
// NO_DEADLINE(=INT64_MAX)，此时死循环的程序永远不返回，worker 线程被占死，
// postMessage('stop') 与 worker.terminate() 都打不断，整轮对拍就此挂死。
// 60s 远大于任何正常测试点，又足以把死循环判成 TLE。
const UNLIMITED_RUN_FALLBACK_MS = 60 * 1000;
function effectiveRunTimeout(timeout) {
    return (Number.isFinite(timeout) && timeout > 0) ? timeout : UNLIMITED_RUN_FALLBACK_MS;
}
function spawnProcess(exePath, args, cwd) {
    return new Promise((resolve) => {
        const proc = (0, child_process_1.spawn)(exePath, args || [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: process.platform !== 'win32',
            cwd
        });
        activeProcesses.add(proc);
        const stdout = [];
        const stderr = [];
        // stdout 与 stderr 各自记账。共用一个上限的话，一个狂写 stderr 的程序
        // 会把 stdout 的额度吃光，真正的对拍输出被截断却没有任何地方说明。
        let outputBytes = 0;
        let outputTruncated = false;
        let errorBytes = 0;
        const append = (target, data, isStdout) => {
            const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
            if (isStdout) {
                if (outputTruncated)
                    return;
                const remaining = MAX_WORKER_OUTPUT_BYTES - outputBytes;
                if (remaining <= 0 || buffer.length > remaining) {
                    outputTruncated = true;
                    if (remaining > 0)
                        target.push(buffer.subarray(0, remaining));
                    (0, process_supervisor_1.terminateProcessTree)(proc);
                    return;
                }
                outputBytes += buffer.length;
            }
            else {
                // stderr 只用来解释「为什么失败」，留够一屏就不要再存了，
                // 但必须继续读：不读的话子进程写满管道会卡死，超时被误报成 TLE。
                if (errorBytes < MAX_CAPTURED_OUTPUT_BYTES) {
                    const room = MAX_CAPTURED_OUTPUT_BYTES - errorBytes;
                    const slice = buffer.length > room ? buffer.subarray(0, room) : buffer;
                    target.push(slice);
                    errorBytes += slice.length;
                }
                return;
            }
            target.push(buffer);
        };
        proc.stdout.on('data', (data) => append(stdout, data, true));
        proc.stderr.on('data', (data) => append(stderr, data, false));
        const wrapped = proc;
        wrapped._collect = () => Buffer.concat(stdout);
        wrapped._stderr = () => Buffer.concat(stderr).toString('utf8');
        wrapped._outputTruncated = () => outputTruncated;
        wrapped._done = false;
        wrapped._result = null;
        wrapped._collectors = [];
        // close(code, signal)：子进程被信号杀死时 code 为 null，这是唯一没被归一化的退出状态。
        // 下游 `code !== 0 && code !== null` 会把它当成成功，于是拿崩溃前截断的输出继续与
        // 标准程序比对（恰好相同就误判成通过）。这里折算成 -1，与 error/超时分支一致。
        proc.on('close', (code, signal) => {
            activeProcesses.delete(proc);
            wrapped._result = { exitCode: (typeof code === 'number' ? code : -1), signal: signal || null, outputTruncated };
            wrapped._done = true;
            for (const cb of wrapped._collectors)
                cb(wrapped._result);
            wrapped._collectors = [];
        });
        proc.on('error', (err) => {
            activeProcesses.delete(proc);
            wrapped._result = { exitCode: -1, error: err.message, outputTruncated };
            wrapped._done = true;
            for (const cb of wrapped._collectors)
                cb(wrapped._result);
            wrapped._collectors = [];
        });
        resolve(proc);
    });
}
function waitForResult(proc, timeout) {
    const wrapped = proc;
    if (wrapped._done && wrapped._result)
        return Promise.resolve(wrapped._result);
    return new Promise((resolve) => {
        let timer = null;
        const cb = (result) => {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            resolve(result);
        };
        wrapped._collectors.push(cb);
        if (timeout > 0) {
            timer = setTimeout(() => {
                wrapped._collectors = wrapped._collectors.filter((c) => c !== cb);
                (0, process_supervisor_1.terminateProcessTree)(proc);
                // taskkill 返回后目标进程的映像尚未从系统卸载，此刻渲染层去删 exe 会拿到
                // EPERM/EBUSY。超时是整条对拍里进程存活最久的那一个（退出最晚），所以这里
                // 必须等到 'close' 才放行，且要有上限，不能让清理被一个赖着不走的进程卡死。
                if (wrapped._done) {
                    resolve({ exitCode: -1, timeout: true, error: 'timeout' });
                    return;
                }
                const giveUp = setTimeout(() => {
                    resolve({ exitCode: -1, timeout: true, error: 'timeout' });
                }, PROCESS_EXIT_GRACE_MS);
                wrapped._collectors.push((result) => {
                    clearTimeout(giveUp);
                    resolve({ ...result, exitCode: -1, timeout: true, error: 'timeout' });
                });
            }, timeout);
        }
    });
}
function writeInput(proc, input) {
    return new Promise((resolve) => {
        const stdin = proc.stdin;
        // 子进程可能在读完输入前就退出（编译失败、std 先崩），此时 write 触发
        // EPIPE。stdin 是 EventEmitter，没有 error 监听就会变成未捕获异常，
        // 直接打崩整个 worker（一组测试失败 → 剩余测试组全部丢失）。
        // 必须在 write 之前挂上。
        try {
            if (stdin)
                stdin.on('error', () => { resolve(false); });
        }
        catch (_) { /* stdin 不可用时下面自然失败 */ }
        try {
            if (!stdin || stdin.destroyed || stdin.writableEnded) {
                resolve(false);
                return;
            }
            stdin.write(input);
            stdin.end();
            resolve(true);
        }
        catch (_) {
            resolve(false);
        }
    });
}
async function runJs(exePath, input, timeout, args, cwd) {
    const t0 = Date.now();
    const proc = await spawnProcess(exePath, args, cwd);
    if (input !== null && input !== undefined)
        await writeInput(proc, input);
    const r = await waitForResult(proc, timeout);
    const wrapped = proc;
    const output = (r.exitCode === -1 || r.exitCode === -3) ? null : wrapped._collect();
    const signalName = r.signal || null;
    return {
        code: r.exitCode,
        output,
        stderr: wrapped._stderr(),
        outputTruncated: !!r.outputTruncated || !!wrapped._outputTruncated(),
        timeout: !!r.timeout,
        error: r.error || null,
        // 被信号杀死与程序自己非零退出要走不同的 i18n 文案。JS 路径下
        // close(code, signal) 只在被信号杀死时给出非空 signal（此时 code 为 null，
        // 已在上面折算成 -1），所以 signalName 存在就是「被信号杀死」。
        killedBySignal: !!signalName,
        signalName,
        ms: Date.now() - t0
    };
}
function runFast(exePath, input, timeout) {
    if (!fast)
        return { code: -1, output: null, stderr: '', outputTruncated: false, timeout: false, error: 'fastspawn module not loaded', killedBySignal: false, signalName: null, ms: 0 };
    const t0 = Date.now();
    const r = fast.run(exePath, input, effectiveRunTimeout(timeout));
    // 截断标志由 native 回报，不用长度猜：native 的 MAX_OUTPUT 与 JS 侧的记账
    // 上限一旦不相等，落在两者之间的截断就完全察觉不到，会拿残缺输出判等。
    return {
        code: r.code,
        output: r.code === -1 || r.code === -3 ? null : r.output,
        stderr: r.stderr ? r.stderr.toString('utf8') : '',
        outputTruncated: !!r.truncated,
        timeout: r.code === -3,
        error: r.code === -3 ? 'TLE' : (r.code === -2 ? 'native spawn failed' : null),
        killedBySignal: r.signal > 0,
        signalName: r.signal > 0 ? signalName(r.signal) : null,
        ms: Date.now() - t0
    };
}
// 一次 native 调用跑完 std 与 test（addon 内两个 pthread），并在 C 层判等。
// 判等放在这里的原因：MB 级输出交给 JS 比要先 toString + split/map/join，
// 实测每组 67-292ms，而同尺寸 memcmp 不到 1ms。相等时两段大输出连跨边界
// 的拷贝都省掉了 —— 那正是最常见的路径。
function runFastPair(stdPath, testPath, input, timeout) {
    const t0 = Date.now();
    if (!fast) {
        return {
            stdCode: -1, testCode: -1, stdKilledBySignal: false, testKilledBySignal: false,
            stdSignalName: null, testSignalName: null, stdErr: '', testErr: '',
            stdOut: null, testOut: null, outputTruncated: false, verdict: -1, ms: 0
        };
    }
    const r = fast.runPair(stdPath, testPath, input, effectiveRunTimeout(timeout), true);
    return {
        stdCode: r.code1,
        testCode: r.code2,
        stdKilledBySignal: r.signal1 > 0 || r.code1 === -2,
        testKilledBySignal: r.signal2 > 0 || r.code2 === -2,
        stdSignalName: r.signal1 > 0 ? signalName(r.signal1) : null,
        testSignalName: r.signal2 > 0 ? signalName(r.signal2) : null,
        stdErr: r.stderr1 ? r.stderr1.toString('utf8') : '',
        testErr: r.stderr2 ? r.stderr2.toString('utf8') : '',
        stdOut: r.out1,
        testOut: r.out2,
        outputTruncated: !!r.truncated,
        verdict: typeof r.normEqual === 'number' ? r.normEqual : -1,
        ms: Date.now() - t0
    };
}
// 回退路径的超时由 waitForResult 报成 { exitCode: -1, timeout: true }，
// 而两条路共用的判定只认 -3 这个哨兵。不折算的话 Windows 上一次超时会显示成
// 「标准程序出错」而不是「超时」—— 调查方向被彻底带偏，且 CI 上看不出来。
function outcomeCode(r) {
    return r.timeout ? -3 : r.code;
}
// 一组已跑完的 std/test 归一成 PairOutcome。回退路径靠 Promise.all 并行，
// native 路径本来就在 addon 内并行 —— 两边并行度对齐，否则 Windows 上
// 会静默慢一截，而这种分裂只在两个平台对照时才看得见。
async function runJsPair(stdPath, testPath, input, timeout) {
    const t0 = Date.now();
    const [stdR, testR] = await Promise.all([
        runJs(stdPath, input, timeout),
        runJs(testPath, input, timeout)
    ]);
    return {
        stdCode: outcomeCode(stdR),
        testCode: outcomeCode(testR),
        stdKilledBySignal: stdR.killedBySignal || !!stdR.signalName || !!stdR.error,
        testKilledBySignal: testR.killedBySignal || !!testR.signalName || !!testR.error,
        stdSignalName: stdR.signalName || (stdR.error ? 'spawn error' : null),
        testSignalName: testR.signalName || (testR.error ? 'spawn error' : null),
        stdErr: stdR.error && !stdR.stderr ? stdR.error : stdR.stderr,
        testErr: testR.error && !testR.stderr ? testR.error : testR.stderr,
        stdOut: stdR.output,
        testOut: testR.output,
        outputTruncated: stdR.outputTruncated || testR.outputTruncated,
        // 回退路径不在 C 里判，交回 outputsEqual
        verdict: -1,
        ms: Date.now() - t0
    };
}
function judgeSide(who, code, killedBySignal, sigName, errText) {
    const noun = who === 'std' ? 'standard' : 'test';
    if (code === -3) {
        return { failed: true, kind: who + '_tle', code: who + '_timeout', message: noun + ' program timed out', exitCode: null, withOutputs: false };
    }
    if (code !== 0) {
        // -2 且没有信号名 = 程序压根没起来（native 的 posix_spawn 失败），
        // 这时说「killed by signal」是错的，会把人往完全相反的方向引。
        const fallback = killedBySignal
            ? (sigName ? noun + ' program killed by ' + sigName : noun + ' program could not be started')
            : noun + ' program exit ' + code;
        const message = errText || fallback;
        return { failed: true, kind: who + '_re', code: killedBySignal ? who + '_error' : who + '_exit', message, exitCode: code, withOutputs: false };
    }
    return { failed: false };
}
// 判定顺序：先 std 后 test 的超时/崩溃，再看输出超限，最后才判等。
// 顺序不能换 —— 残缺输出比出「相等」是假的 AC，比出「不等」是假的 WA，
// 两种都不该进入判等。
function judgePair(o) {
    const stdVerdict = judgeSide('std', o.stdCode, o.stdKilledBySignal, o.stdSignalName, o.stdErr);
    if (stdVerdict.failed)
        return stdVerdict;
    const testVerdict = judgeSide('test', o.testCode, o.testKilledBySignal, o.testSignalName, o.testErr);
    if (testVerdict.failed)
        return testVerdict;
    if (o.outputTruncated) {
        return { failed: true, kind: 'output_limit', code: 'output_limit', message: 'program output exceeded limit', exitCode: null, withOutputs: false };
    }
    // verdict === 1：native 已确认相等（只在两侧都是纯 ASCII 时才可能给出）。
    // 其余情况都要用 JS 那份 normalizeOutput 定案。
    if (o.verdict === 1)
        return { failed: false };
    if (o.verdict === 0) {
        return { failed: true, kind: 'mismatch', code: 'mismatch', message: 'outputs differ', exitCode: null, withOutputs: true };
    }
    if (!outputsEqual(o.stdOut, o.testOut)) {
        return { failed: true, kind: 'mismatch', code: 'mismatch', message: 'outputs differ', exitCode: null, withOutputs: true };
    }
    return { failed: false };
}
async function runGenerator(gen, timeout) {
    let exe = '', args = [], cwd = undefined;
    if (typeof gen === 'string') {
        exe = gen;
    }
    else if (gen && typeof gen === 'object') {
        exe = gen.executablePath || gen.path || gen.exe || '';
        args = gen.args || [];
        cwd = gen.workingDirectory || gen.cwd || undefined;
    }
    // 生成器走 child_process：它需要 args 与 cwd（Python 生成器是 解释器 + 脚本参数），
    // 而 native 只支持「无参数直接 exec」。
    if (!exe)
        return { code: -2, output: null, stderr: 'missing generator executable', outputTruncated: false, timeout: false, error: null, killedBySignal: false, signalName: null, ms: 0 };
    return await runJs(exe, null, timeout, args, cwd);
}
let running = false;
worker_threads_1.parentPort.on('message', async (msg) => {
    if (msg.type === 'run-tests') {
        running = true;
        const { startIdx, count, gen, stdPath, testPath, timeout, generatorTimeout } = msg;
        const useFast = false;
        const genTimeout = (Number.isFinite(generatorTimeout) && generatorTimeout > 0) ? generatorTimeout : 0;
        let lastGenMs = 0, lastStdMs = 0, lastTestMs = 0;
        // code 是给渲染层做 i18n 映射用的稳定标识，message 仅作技术细节，不再直接进 UI
        const fail = (i, kind, code, detail, extra = {}) => {
            const input = captureText(extra.rawInput, MAX_CAPTURED_INPUT_BYTES);
            const std = extra.rawStd !== undefined ? captureText(extra.rawStd, MAX_CAPTURED_OUTPUT_BYTES) : null;
            const test = extra.rawTest !== undefined ? captureText(extra.rawTest, MAX_CAPTURED_OUTPUT_BYTES) : null;
            worker_threads_1.parentPort.postMessage({
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
                if (!running)
                    break;
                lastGenMs = genOut.ms || 0;
                if (genOut.timeout || genOut.error || genOut.signalName || genOut.code !== 0) {
                    fail(i, 'generator', genOut.timeout ? 'gen_timeout' : ((genOut.error || genOut.signalName) ? 'gen_error' : 'gen_exit'), genOut.stderr || genOut.error || (genOut.signalName ? 'generator killed by ' + genOut.signalName : 'generator exit ' + genOut.code), { rawInput: rawInput(), exitCode: genOut.code });
                    continue;
                }
                const extra = { rawInput: rawInput(), includeStdMs: true, includeTestMs: true };
                const outcome = useFast
                    ? runFastPair(stdPath, testPath, genOut.output, timeout)
                    : await runJsPair(stdPath, testPath, genOut.output, timeout);
                if (!running)
                    break;
                lastStdMs = outcome.ms;
                lastTestMs = outcome.ms;
                const verdict = judgePair(outcome);
                if (verdict.failed) {
                    fail(i, verdict.kind, verdict.code, verdict.message, verdict.withOutputs
                        ? { ...extra, rawStd: outcome.stdOut, rawTest: outcome.testOut, exitCode: verdict.exitCode }
                        : { ...extra, exitCode: verdict.exitCode });
                    continue;
                }
                worker_threads_1.parentPort.postMessage({
                    type: 'progress', testIndex: i,
                    genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs,
                    // 直接取 length：Buffer.from(buffer) 会把整块输入再拷一份，
                    // 而这里只要一个数字（实测 MB 级输入下这是每组白丢的一次拷贝）
                    genLen: genOut.output ? genOut.output.length : 0
                });
            }
            catch (e) {
                fail(i, 'exception', 'exception', e && e.message ? e.message : String(e), { rawInput: rawInput() });
            }
        }
        worker_threads_1.parentPort.postMessage({ type: 'done' });
    }
    else if (msg.type === 'stop') {
        running = false;
        for (const proc of activeProcesses)
            killProc(proc);
        activeProcesses.clear();
    }
});
