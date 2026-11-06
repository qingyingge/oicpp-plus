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
 * compare-worker.js — Native posix_spawn worker
 * 每个线程内完全同步: spawn+IO 在 C 层完成, 无事件循环开销.
 * 并行度 = 线程数 (每线程独立跑完整测试).
 * 生成器始终走 child_process（支持 args/cwd，兼容 Python 生成器）；
 * std/test 优先 fastspawn，加载失败时回退 child_process；
 * checker（SPJ）只在 testlib 模式下跑，它是第 4 个进程、且只吃文件，
 * 所以走 child_process 的 argv 通道，不动 native 的固定双进程接口。
 */
const worker_threads_1 = require("worker_threads");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
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
const child_process_1 = require("child_process");
const process_supervisor_1 = require("../utils/process-supervisor");
const memory_limit_1 = require("../utils/memory-limit");
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
/**
 * 字节级的「规范化后判等」，一次扫描出结论。返回 null 表示**这里定不了论**，调用方必须回落。
 *
 * 为什么要多这一档：normalizeOutput 是「utf8 解码 + 4 趟 replace/split/join」，在 MB 级
 * 输出上是裸 .equals 短路的几百倍。而「答案相同、只差行尾空白或结尾换行」在对拍里是常态
 * 而不是意外，于是**一个 AC 结论**也要付这笔钱：实测 1MB 输出每轮 66ms → 162ms
 * （equal 一档 0.18ms → 109ms，占整轮 67%）。
 *
 * 判据仍然只有一份，就是 normalizeOutput。这里做的是它的字节等价形：两侧规范化后写进
 * 同一块缓冲的两段，再 memcmp。纯 ASCII 时两个视角逐字等价（可剥的行尾空白只有空格/Tab，
 * 行分隔只有 \n，它们都是单字节且不会出现在多字节序列内部），所以能直接定「不等」。
 *
 * 唯一的分叉点是非法 UTF-8：解码会把不同的坏字节并成同一个 U+FFFD，字节视角可能判成不等
 * 而字符串视角判成相等。所以**带高位字节且这里判出不等时不下结论**，交回 normalizeOutput
 * 终裁 —— 与 fastspawn.cc 的 normalizeInPlace 用 anyHigh 拒绝定论是同一个手法。
 */
function equalNormalizedBytes(left, right) {
    const buf = Buffer.allocUnsafe(left.length + right.length + 1);
    let sawHighByte = false;
    // 写侧：把 src 规范化进 dst 的 off 段，返回有效长度。行尾空白「不写出去」而不是
    // 写出去再擦掉，所以 contentEnd 记的是本行最后一个非空白字节的右边界。
    const write = (src, off) => {
        let w = off, contentEnd = off;
        const n = src.length;
        for (let i = 0; i < n; i++) {
            // i < n = src.length，越界读不到；noUncheckedIndexedAccess 不看这个，
            // 所以在这里收一次形。写成 `if (c === undefined) continue` 是给不可能发生的
            // 情况加一条永远不执行的分支，运行时和读者两头都是噪声。
            const c = src[i];
            if (c >= 0x80)
                sawHighByte = true;
            if (c === 13) {
                // \r 只在紧跟 \n 时丢；孤立 \r 是内容（normalizeOutput 也只替换 \r\n）
                if (i + 1 < n && src[i + 1] === 10)
                    continue;
                buf[w++] = c;
                contentEnd = w;
                continue;
            }
            if (c === 10) {
                w = contentEnd;
                buf[w++] = c;
                contentEnd = w;
                continue;
            }
            buf[w++] = c;
            if (c !== 32 && c !== 9)
                contentEnd = w;
        }
        w = contentEnd; // 末行可能没有换行
        while (w > off && buf[w - 1] === 10)
            w--; // 剥结尾连续换行
        return w - off;
    };
    const n1 = write(left, 0);
    const base = left.length + 1;
    const n2 = write(right, base);
    if (n1 !== n2)
        return sawHighByte ? null : false;
    if (buf.compare(buf, 0, n1, base, base + n2) !== 0)
        return sawHighByte ? null : false;
    return true;
}
function outputsEqual(left, right) {
    // 逐字节相同是对拍里的高频主情形；先裸比较短路，MB 级输出免掉两侧各一轮
    // Buffer.from 复制 + utf8 解码 + 4 趟 replace/split/join。判等口径没变：
    // 不相同（含 string 混入）仍回到唯一一套 normalizeOutput。
    if (Buffer.isBuffer(left) && Buffer.isBuffer(right)
        && (left === right || (left.length === right.length && left.equals(right)))) {
        return true;
    }
    // 两侧都是 Buffer 时先走单遍字节判等；只有它「定不了论」才落到下面的字符串终裁，
    // 所以 MB 级差异从「两趟解码 + 8 趟字符串流水线」降到一次扫描 + 一次 memcmp。
    if (Buffer.isBuffer(left) && Buffer.isBuffer(right)) {
        const fast = equalNormalizedBytes(left, right);
        if (fast !== null)
            return fast;
    }
    return normalizeOutput(left) === normalizeOutput(right);
}
function spawnProcess(exePath, args, cwd, memoryLimitMb) {
    return new Promise((resolve) => {
        // 内存上限用 prlimit 包一层（Linux 的 RLIMIT_AS 硬 cap）。它带命令时是 exec
        // 而非 fork，所以 spawn 返回的 pid 就是目标本身 —— /proc 峰值采样量的正是它。
        // 由主进程的 utils/memory-limit 与这里共用同一个实现，判据不会分叉。
        const limited = (memoryLimitMb && memoryLimitMb > 0)
            ? (0, process_supervisor_1.getResourceLimitedSpawn)(exePath, args || [], memoryLimitMb)
            : null;
        const launchPath = limited ? limited.command : exePath;
        const launchArgs = limited ? limited.args : (args || []);
        // 全平台 detached（win32 = DETACHED_PROCESS，不分配控制台）——这是权衡后的
        // 最终选择，两种模式对 console 依赖程序的行为差异实测于 docs/PERFORMANCE.md：
        //   隐藏控制台（旧）：getch/kbhit 绕过重定向的 stdin 读 CONIN$ → 永挂；
        //                     system("pause") 碰巧被 conhost 快速放行。
        //   DETACHED（现在）：pause 永挂（→按超时如实上报）；getch 读 stdin 见 EOF 立返。
        // 判定一致性优先：DETACHED 下所有 stdin 语义统一为「读重定向、EOF 即止」，
        // 与 OJ 评测环境同构；隐藏控制台则同时存在「读不到的一把键」和「永挂」两种
        // 幽灵路径。另外 DETACHED 每进程快 23ms（省 conhost 分配）。
        // POSIX detached 同时给出独立进程组供 kill(-pid)。win32 杀树走 taskkill /T。
        const proc = (0, child_process_1.spawn)(launchPath, launchArgs, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: true,
            cwd
        });
        activeProcesses.add(proc);
        const stdout = [], stderr = [];
        let outputBytes = 0;
        let outputTruncated = false;
        const append = (target, data) => {
            if (outputTruncated)
                return;
            const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
            const remaining = MAX_WORKER_OUTPUT_BYTES - outputBytes;
            if (remaining <= 0 || buffer.length > remaining) {
                outputTruncated = true;
                if (remaining > 0)
                    target.push(buffer.subarray(0, remaining));
                (0, process_supervisor_1.terminateProcessTree)(proc);
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
        // close(code, signal)：子进程被信号杀死时 code 为 null，这是唯一没被归一化的退出状态。
        // 下游 `code !== 0 && code !== null` 会把它当成成功，于是拿崩溃前截断的输出继续与
        // 标准程序比对（恰好相同就误判成通过）。这里折算成 -1，与 error/超时分支一致。
        proc.on('close', (code, signal) => { activeProcesses.delete(proc); proc._result = { exitCode: (typeof code === 'number' ? code : -1), signal: signal || null, outputTruncated }; proc._done = true; for (const cb of proc._collectors)
            cb(proc._result); proc._collectors = []; });
        proc.on('error', (err) => { activeProcesses.delete(proc); proc._result = { exitCode: -1, error: err.message, outputTruncated }; proc._done = true; for (const cb of proc._collectors)
            cb(proc._result); proc._collectors = []; });
        resolve(proc);
    });
}
function waitForResult(proc, timeout) {
    if (proc._done)
        return Promise.resolve(proc._result);
    return new Promise((resolve) => {
        let timer = null;
        const cb = (result) => { if (timer) {
            clearTimeout(timer);
            timer = null;
        } resolve(result); };
        proc._collectors.push(cb);
        if (timeout > 0) {
            timer = setTimeout(() => {
                proc._collectors = proc._collectors.filter(c => c !== cb);
                (0, process_supervisor_1.terminateProcessTree)(proc);
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
function killProc(proc) { (0, process_supervisor_1.terminateProcessTree)(proc); }
// 回退路径生成器预取开关（环境变量 OICPP_COMPARE_PREFETCH=0 关闭）：
// 预取让每个 worker 并发进程数 2→3，短程序场景（gen 占主导）净赚，
// 长程序场景在 CPU 饱和机器上反而挤掉 std/test 的核。默认开，benchmark 可 A/B。
const PREFETCH_ENABLED = process.env['OICPP_COMPARE_PREFETCH'] !== '0';
// 不限时（0）时给 native 同步调用兜一个墙钟上限：fastspawn 会把 0 当成
// NO_DEADLINE(=INT64_MAX)，此时死循环的程序永远不返回，worker 线程被占死，
// postMessage('stop') 与 worker.terminate() 都打不断，整轮对拍就此挂死。
// 60s 远大于任何正常测试点，又足以把死循环判成 TLE。
const UNLIMITED_RUN_FALLBACK_MS = 60 * 1000;
function effectiveRunTimeout(timeout) {
    return (Number.isFinite(timeout) && timeout > 0) ? timeout : UNLIMITED_RUN_FALLBACK_MS;
}
// worker 被 terminate 时不会执行 stop 消息，Windows 回退路径下的子进程
// 会变成孤儿继续跑；进程退出钩子是唯一能兜住它们的时机
process.on('exit', () => {
    for (const proc of activeProcesses) {
        try {
            killProc(proc);
        }
        catch (_) { }
    }
    activeProcesses.clear();
});
function writeInput(proc, input) {
    return new Promise((resolve) => {
        // 子进程可能在读完输入前就退出（编译失败、std 先崩），此时 write 触发
        // EPIPE。stdin 是 EventEmitter，没有 error 监听就会变成未捕获异常，
        // 直接打崩整个 worker（一组测试失败 → 剩余测试组全部丢失）。
        // 必须在 write 之前挂上。
        try {
            proc.stdin.on('error', () => { resolve(false); });
        }
        catch (_) { /* stdin 不可用时下面自然失败 */ }
        try {
            if (proc.stdin.destroyed || proc.stdin.writableEnded) {
                resolve(false);
                return;
            }
            proc.stdin.write(input);
            proc.stdin.end();
            resolve(true);
        }
        catch (_) {
            resolve(false);
        }
    });
}
async function runJs(exePath, input, timeout, args, cwd, wantStderr) {
    const t0 = Date.now();
    const proc = await spawnProcess(exePath, args, cwd);
    if (input !== null && input !== undefined)
        await writeInput(proc, input);
    const r = await waitForResult(proc, timeout);
    const output = (r.exitCode === -1 || r.exitCode === -3) ? null : proc._collect();
    return { code: r.exitCode, output, outputTruncated: !!r.outputTruncated || !!proc._outputTruncated?.(), timeout: !!r.timeout, error: r.error, signal: r.signal || null, ms: Date.now() - t0, stderr: wantStderr ? proc._stderr() : undefined };
}
function runFast(exePath, input, timeout, cwd) {
    if (!fast) {
        return { code: -1, output: null, timeout: false, error: 'fastspawn module not loaded', ms: 0 };
    }
    const t0 = Date.now();
    const r = fast.run(exePath, input, effectiveRunTimeout(timeout), cwd);
    // 截断标志由 native 侧回报。原先靠 output.length >= MAX_WORKER_OUTPUT_BYTES 猜，
    // 而 native 的 MAX_OUTPUT(64MB) 与 JS 的 MAX_WORKER_OUTPUT_BYTES(32MB) 不等，
    // 落在两者之间的截断完全察觉不到，会拿残缺输出判等。
    return {
        code: r.code, output: r.output,
        outputTruncated: !!r.truncated,
        timeout: r.code === -3,
        error: r.code === -3 ? 'TLE' : null,
        // 与回退路同一套分类：被信号杀死（崩溃/OOM）要区别于「自己非零退出」
        signal: (typeof r.signal === 'number' && r.signal > 0) ? String(r.signal) : null,
        ms: Date.now() - t0
    };
}
function runFastPair(stdPath, testPath, input, timeout, cwdStd, cwdTest) {
    if (!fast) {
        return {
            std: { code: -1, output: null, truncated: false, timeout: false, error: 'fastspawn module not loaded', signal: null, ms: 0 },
            test: { code: -1, output: null, truncated: false, timeout: false, error: 'fastspawn module not loaded', signal: null, ms: 0 },
            error: 'fastspawn module not loaded'
        };
    }
    const t0 = Date.now();
    const r = fast.runPair(stdPath, testPath, input, effectiveRunTimeout(timeout), false, cwdStd, cwdTest);
    const ms = Date.now() - t0;
    // 截断标志以 native 回传的 r.truncated 为准，不用长度猜（native 的 MAX_OUTPUT
    // 与 JS 的 MAX_WORKER_OUTPUT_BYTES 不相等，落在两者之间的截断靠长度根本察觉不到，
    // 会拿残缺输出判等）。
    return {
        std: outcomeFromFast(r.code1, r.out1, !!r.truncated, r.signal1, ms),
        test: outcomeFromFast(r.code2, r.out2, !!r.truncated, r.signal2, ms)
    };
}
async function runGenerator(gen, timeout) {
    let exe = null, args = [], cwd = undefined;
    if (typeof gen === 'string') {
        exe = gen;
    }
    else if (gen && typeof gen === 'object') {
        exe = gen.executablePath || gen.path || gen.exe || '';
        args = gen.args || [];
        cwd = gen.workingDirectory || gen.cwd || undefined;
    }
    if (!exe)
        return { code: -2, error: 'missing generator executable', output: null, ms: 0 };
    // 生成器优先走 native 异步：实测这一腿 child_process 32.4ms vs native 10.9ms，
    // 而三个程序都 <1ms 的轻量对拍里，一轮 51.8ms 有 29.1ms 就是它 —— 几乎全是
    // Node spawn 的固定开销，不是用户程序在算。异步保证 'stop' 仍能中途杀。
    if (fast && typeof fast.runAsync === 'function') {
        const t0 = Date.now();
        const r = await fast.runAsync(exe, null, effectiveRunTimeout(timeout), cwd, args);
        return {
            code: r.code,
            output: r.output,
            outputTruncated: !!r.truncated,
            timeout: r.code === -3,
            error: null,
            signal: (typeof r.signal === 'number' && r.signal > 0) ? String(r.signal) : null,
            ms: Date.now() - t0
        };
    }
    return await runJs(exe, null, timeout, args, cwd);
}
// ---------------------------------------------------------------------------
// 判定阶梯：快路与回退路共用同一套顺序。
// 两条路径原先各抄一遍（顺序稍有出入，回退路能识别 signal 而快路不能），
// 加一种判定就得同步改两处。现在执行层只负责把结果归一化成 ProgramOutcome，
// 判定顺序只有一份。
// ---------------------------------------------------------------------------
function outcomeFromFast(code, output, truncated, signal, ms) {
    // native 用 -3 表示到点、-2 表示 spawn/写失败，两者都只体现在 code 上；
    // error 留空，让 -2 继续报成 *_exit（与改造前的分类一致，不改既有码表）。
    return {
        code,
        output,
        truncated: !!truncated,
        timeout: code === -3,
        error: null,
        signal: (typeof signal === 'number' && signal > 0) ? signal : null,
        ms
    };
}
function outcomeFromJs(r) {
    return {
        code: r.code,
        output: r.output,
        truncated: !!r.outputTruncated,
        timeout: !!r.timeout,
        error: r.error || null,
        signal: r.signal || null,
        ms: r.ms
    };
}
function factsOfProgram(o, who) {
    const timedOut = o.timeout;
    const crashed = !timedOut && !!(o.error || o.signal);
    const exitNonZero = !timedOut && !crashed && o.code !== 0 && o.code !== null;
    const detail = timedOut ? who + ' program timed out'
        : crashed ? (o.error || (who + ' program killed by ' + String(o.signal)))
            : exitNonZero ? (who + ' program exit ' + String(o.code))
                : o.truncated ? who + ' program output exceeded limit'
                    : '';
    return {
        timedOut,
        crashed,
        exitNonZero,
        ole: o.truncated,
        exitCode: o.code,
        detail,
        clean: !timedOut && !crashed && !exitNonZero && !o.truncated
    };
}
// 对拍的阶梯：TLE → 运行错误/非零退出 → 输出超限 → 判定。
// 顺序与改造前逐字一致（被信号杀死要排在退出码之前，否则 SIGSEGV 会被报成「退出码 -1」）。
function verdictForProgram(role, o) {
    const who = role === 'std' ? 'standard' : 'test';
    const f = factsOfProgram(o, who);
    if (f.timedOut)
        return { kind: role + '_tle', code: role + '_timeout', detail: f.detail, exitCode: f.exitCode };
    if (f.crashed)
        return { kind: role + '_re', code: role + '_error', detail: f.detail, exitCode: f.exitCode };
    if (f.exitNonZero)
        return { kind: role + '_re', code: role + '_exit', detail: f.detail, exitCode: f.exitCode };
    return null;
}
// testlib checker 的退出码来自 resultExitCode()：_ok=0、_wa=1、_pe=2、_fail=3、
// _dirt=4、_points=5、_partially(n)=16+n。参数写错或 testlib 自身异常时
// __testlib_help()/quit(_fail) 也是 3 —— 那是评测器的问题，不能算到被测程序头上。
function verdictFromChecker(r) {
    const comment = captureText([r.output, r.stderr].filter(Boolean).join('\n'), MAX_CAPTURED_OUTPUT_BYTES).text.trim();
    if (r.timeout)
        return { kind: 'spj_tle', code: 'spj_timeout', detail: comment || 'checker timed out', exitCode: r.code };
    if (r.error || r.signal)
        return { kind: 'spj_error', code: 'spj_error', detail: comment || r.error || ('checker killed by ' + String(r.signal)), exitCode: r.code };
    if (r.code === 0)
        return null;
    if (r.code === 1)
        return { kind: 'spj_wa', code: 'spj_wa', detail: comment || 'wrong answer', exitCode: r.code };
    if (r.code === 2 || r.code === 4)
        return { kind: 'spj_pe', code: 'spj_pe', detail: comment || 'presentation error', exitCode: r.code };
    if (r.code === 3)
        return { kind: 'spj_error', code: 'spj_fail', detail: comment || 'checker reported FAIL', exitCode: r.code };
    if (r.code === 5 || r.code >= 16)
        return { kind: 'spj_wa', code: 'spj_partial', detail: comment || 'partially correct', exitCode: r.code };
    return { kind: 'spj_error', code: 'spj_error', detail: comment || ('checker exit ' + String(r.code)), exitCode: r.code };
}
function asBuffer(value) {
    if (value == null)
        return Buffer.alloc(0);
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
}
function prepareCheckerSlots(scratchDir, tag) {
    return {
        dir: scratchDir,
        inFile: path.join(scratchDir, `oicpp_spj_${tag}_in.txt`),
        outFile: path.join(scratchDir, `oicpp_spj_${tag}_out.txt`),
        ansFile: path.join(scratchDir, `oicpp_spj_${tag}_ans.txt`)
    };
}
// taskkill 返回后句柄可能还没释放（见 waitForResult 里同样的处理），
// 删不掉就留给下一次覆盖，不能让它盖掉判定结论。
function removeCheckerSlots(slots) {
    for (const file of [slots.inFile, slots.outFile, slots.ansFile]) {
        try {
            fs.unlinkSync(file);
        }
        catch (_) { }
    }
}
// checker 是整轮第四个进程，且串行卡在判定前 —— 它走 child_process 时实测一次 25ms,
// 而同样的进程 native 起只要 8ms。SPJ 轮因此比非 SPJ 轮贵 41ms，纯属进程创建的固定开销。
async function runChecker(spjPath, slots, timeout) {
    const args = [slots.inFile, slots.outFile, slots.ansFile];
    if (fast && typeof fast.runAsync === 'function') {
        const t0 = Date.now();
        const r = await fast.runAsync(spjPath, null, effectiveRunTimeout(timeout), slots.dir, args);
        return {
            code: r.code,
            output: r.output,
            outputTruncated: !!r.truncated,
            timeout: r.code === -3,
            error: null,
            signal: (typeof r.signal === 'number' && r.signal > 0) ? String(r.signal) : null,
            ms: Date.now() - t0,
            stderr: r.stderr == null ? '' : String(r.stderr)
        };
    }
    return await runJs(spjPath, null, timeout, args, slots.dir, true);
}
async function judgeWithChecker(spjPath, slots, input, answer, actual, timeout) {
    try {
        fs.writeFileSync(slots.inFile, asBuffer(input));
        fs.writeFileSync(slots.outFile, asBuffer(actual));
        fs.writeFileSync(slots.ansFile, asBuffer(answer));
        return verdictFromChecker(await runChecker(spjPath, slots, timeout));
    }
    catch (e) {
        return { kind: 'spj_error', code: 'spj_error', detail: e.message || String(e) };
    }
}
function prepareFreopenSlots(scratchDir, startIdx, inputFile, outputFile) {
    const base = path.join(scratchDir, 'freopen_runs', `w${startIdx}`);
    const make = (role) => {
        const dir = path.join(base, role);
        fs.mkdirSync(dir, { recursive: true });
        return { dir, inputFile, outputFile };
    };
    return { std: make('std'), test: make('test') };
}
// 输入落文件后 stdin 就该是空的（与旧引擎 runInput 的取舍一致）：程序要么读文件，
// 要么在 EOF 上如实结束。两个 slot 各写一份同样的内容 —— 共用一份就会互相覆盖。
//
// 同时必须先把上一轮的 data.out 删掉。slot 目录是长期复用的，程序这一轮没写输出文件时
// （条件写、提前 return、干脆写错名字），readSlotOutput 会读到上一轮那个名字一样的
// 陈旧文件，然后回退分支根本不触发 —— 判定于是拿的是别轮的数据，而结论看起来完全正常。
// 这是「静默错判」里最坏的一种，删除只有一次 unlink，不是递归删除。
function armSlot(slot, data) {
    if (slot.inputFile)
        fs.writeFileSync(path.join(slot.dir, slot.inputFile), asBuffer(data));
    if (slot.outputFile) {
        try {
            fs.unlinkSync(path.join(slot.dir, slot.outputFile));
        }
        catch (_) { }
    }
}
// 输出从文件回收。按字节上限读，绝不能 readFileSync 一整份 —— 一个死循环写文件的
// 程序会把 worker 的内存吃掉，而它本来只是该被判 OLE。
// 文件不存在时回退到 stdout：老代码里 freopen 输出走的就是这条兜底（有些程序只写
// 部分情形到文件），改成「读不到就算空」会让这批程序集体变 WA。
function readSlotOutput(slot, o) {
    if (!slot || !slot.outputFile)
        return o;
    const file = path.join(slot.dir, slot.outputFile);
    let fd = -1;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, MAX_WORKER_OUTPUT_BYTES);
        const buf = Buffer.alloc(len);
        const got = fs.readSync(fd, buf, 0, len, 0);
        return { ...o, output: buf.slice(0, got), truncated: o.truncated || size > len };
    }
    catch (_) {
        return o;
    }
    finally {
        if (fd >= 0) {
            try {
                fs.closeSync(fd);
            }
            catch (_) { }
        }
    }
}
// checker 的结论折进样例既有的状态词表：{AC,WA,TLE,MLE,RE,OLE}。
// 词表不能随意扩 —— 样例总览按固定键计数，喂进一个没登记的码（比如 PE）会被当成
// PENDING 累加，总览从此一直显示「运行中」。checker 的原话另有去处（spjOutput 文本框）。
function caseStatusFromChecker(desc) {
    if (!desc)
        return 'AC';
    if (desc.code === 'spj_timeout')
        return 'TLE';
    if (desc.code === 'spj_wa' || desc.code === 'spj_pe' || desc.code === 'spj_partial')
        return 'WA';
    return 'RE';
}
// 样例测试器今天比较前会剥掉 UTF-8 BOM（Windows 编辑器存出来的期望输出、以及不少
// 题面下载的数据都带 BOM）。对拍的规范化不剥是有道理的：两个程序同源，BOM 要么都
// 有要么都没有。样例是「程序输出 vs 人手写的期望」，一边有 BOM 一边没有是常态 ——
// 不照搬这条，切换后原来 AC 的样例会变 WA，而且看起来像程序写错了。
function stripBom(value) {
    if (value == null)
        return value;
    if (Buffer.isBuffer(value)) {
        return (value.length >= 3 && value[0] === 0xEF && value[1] === 0xBB && value[2] === 0xBF)
            ? value.subarray(3) : value;
    }
    return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}
// 有上限时 500ms 采一次（与主进程 run-program 同一档），没上限就不采
const MEMORY_SAMPLE_MS = 500;
/**
 * cases 模式跑一个程序，附带内存峰值与超限判定。
 *
 * 不能走 native：posix_spawn 没有 setrlimit 这条路，RLIMIT_AS 只能靠 prlimit 包一层。
 * prlimit 带命令时 exec 而非 fork，所以峰值采样量到的仍是目标本身。
 *
 * 已知盲区（与主进程 run-program 完全一致，不是这次引入的）：Linux 上峰值靠 500ms
 * 轮询，跑完得比一个采样周期还快的程序会报 0 内存；而 prlimit 是硬 cap，超限的程序
 * 往往是自己 malloc 失败退出（报成 RE）而不是被轮询抓到（报 MLE）。win32 由 memwatch
 * 读内核维护的高水位避开前半段，后半段两边一样。
 */
async function runCaseProgram(msg, input) {
    const t0 = Date.now();
    const limitMb = Number(msg.memoryLimitMb) || 0;
    const limitBytes = limitMb > 0 ? limitMb * 1024 * 1024 : 0;
    const proc = await spawnProcess(msg.exePath, undefined, undefined, limitMb);
    await writeInput(proc, input);
    // win32 由 memwatch 读内核维护的峰值（轮询采不到短命进程的高点，那正是
    // mywwzh/oicpp#368「内存显示 0.0MB」的成因）；其它平台它返回 null，退回轮询。
    const memWatch = (0, memory_limit_1.startMemWatch)(proc.pid, limitBytes, msg.memWatchPath || '');
    let peakBytes = 0;
    let exceeded = false;
    let inflight = null;
    const sample = () => {
        if (inflight)
            return inflight;
        inflight = (0, memory_limit_1.readProcessMemoryBytes)(proc.pid)
            .then((bytes) => {
            if (bytes > peakBytes)
                peakBytes = bytes;
            if (limitBytes > 0 && bytes > limitBytes && !exceeded) {
                exceeded = true;
                killProc(proc);
            }
        })
            .catch(() => { })
            .then(() => { inflight = null; });
        return inflight;
    };
    const timer = limitBytes > 0 ? setInterval(sample, MEMORY_SAMPLE_MS) : null;
    if (timer && typeof timer.unref === 'function')
        timer.unref();
    const r = await waitForResult(proc, msg.timeout);
    if (timer)
        clearInterval(timer);
    const output = (r.exitCode === -1 || r.exitCode === -3) ? null : proc._collect();
    const watchReport = await (0, memory_limit_1.resolveMemWatchReport)(memWatch);
    if (watchReport) {
        if (watchReport.peakBytes > peakBytes)
            peakBytes = watchReport.peakBytes;
        if (watchReport.exceeded)
            exceeded = true;
    }
    return {
        code: r.exitCode, output,
        outputTruncated: !!r.outputTruncated || !!proc._outputTruncated?.(),
        timeout: !!r.timeout, error: r.error, signal: r.signal || null,
        ms: Date.now() - t0, stderr: proc._stderr(),
        memoryBytes: peakBytes, memoryLimitExceeded: exceeded
    };
}
async function judgeCase(c, o, memory, msg, tag) {
    const f = factsOfProgram(o, 'program');
    // 顺序沿用样例测试器今天的判据（OLE → MLE → TLE → RE → 判定），与对拍的优先级不同是
    // 有意的：超限被杀之后一定伴随「非零退出/signal」，把 MLE 排在它们之后就永远报不出来。
    if (f.ole)
        return { status: 'OLE', spjOutput: '' };
    if (memory.exceeded)
        return { status: 'MLE', spjOutput: '' };
    if (f.timedOut)
        return { status: 'TLE', spjOutput: '' };
    if (f.crashed || f.exitNonZero)
        return { status: 'RE', spjOutput: '' };
    if (msg.spjPath) {
        // 样例的 expected 就是 checker 的 answer —— 这正是「有基准」那一侧的用法。
        // 用后即删：一次跑完的用例彼此无关，留文件就是留残骸。
        const slots = prepareCheckerSlots(msg.scratchDir, tag);
        try {
            const desc = await judgeWithChecker(msg.spjPath, slots, c.input, c.expected, o.output, msg.timeout);
            return { status: caseStatusFromChecker(desc), spjOutput: desc ? desc.detail : '' };
        }
        finally {
            removeCheckerSlots(slots);
        }
    }
    // BOM 只在这条文本比对分支剥：样例测试器今天的 SPJ 路径传的是 trimEnd 后的原文，
    // 照搬才是「行为不变」，顺手也给 checker 剥 BOM 反而是改动旧行为。
    return { status: outputsEqual(stripBom(c.expected), stripBom(o.output)) ? 'AC' : 'WA', spjOutput: '' };
}
worker_threads_1.parentPort.on('message', async (msg) => {
    if (msg.type !== 'run-cases')
        return;
    running = true;
    const cases = Array.isArray(msg.cases) ? msg.cases : [];
    for (let i = 0; i < cases.length && running; i++) {
        const c = cases[i];
        if (!c)
            continue;
        const started = Date.now();
        let o;
        let stderr = '';
        let memoryBytes = 0;
        let memoryExceeded = false;
        try {
            const limitMb = Number(msg.memoryLimitMb) || 0;
            if (fast && limitMb <= 0) {
                const r = fast.run(msg.exePath, c.input, effectiveRunTimeout(msg.timeout));
                o = outcomeFromFast(r.code, r.output, !!r.truncated, r.signal, Date.now() - started);
                stderr = r.stderr ? Buffer.from(r.stderr).toString('utf8') : '';
            }
            else {
                // 有内存上限时只能走 child_process（prlimit 包一层），native 没有 setrlimit 这条路
                const r = await runCaseProgram(msg, c.input);
                o = outcomeFromJs(r);
                stderr = r.stderr || '';
                memoryBytes = r.memoryBytes;
                memoryExceeded = r.memoryLimitExceeded;
            }
            const verdict = await judgeCase(c, o, { exceeded: memoryExceeded }, msg, 'c' + i);
            const shown = captureText(o.output, MAX_CAPTURED_OUTPUT_BYTES);
            worker_threads_1.parentPort.postMessage({
                type: 'case-result',
                index: i,
                status: verdict.status,
                exitCode: o.code,
                ms: o.ms || (Date.now() - started),
                stdout: shown.text,
                stdoutTruncated: shown.truncated,
                stderr: stderr,
                expected: c.expected,
                spjOutput: verdict.spjOutput,
                memoryBytes: memoryBytes,
                memoryLimitExceeded: memoryExceeded
            });
        }
        catch (e) {
            worker_threads_1.parentPort.postMessage({
                type: 'case-result',
                index: i,
                status: 'RE',
                exitCode: null,
                ms: Date.now() - started,
                stdout: '',
                stdoutTruncated: false,
                stderr: e.message || String(e),
                expected: c.expected,
                spjOutput: '',
                memoryBytes: memoryBytes,
                memoryLimitExceeded: false
            });
        }
    }
    worker_threads_1.parentPort.postMessage({ type: 'cases-done', count: cases.length });
});
let running = false;
const activeProcesses = new Set();
worker_threads_1.parentPort.on('message', async (msg) => {
    if (msg.type === 'run-tests') {
        running = true;
        const { startIdx, count, gen, stdPath, testPath, timeout, generatorTimeout } = msg;
        // checker 只在 testlib 模式（引擎发了 spjPath）时启用；文本判等路径完全不变。
        const spjPath = typeof msg.spjPath === 'string' ? msg.spjPath : '';
        // checker 的临时文件与 freopen 的 slot 目录都写在被测程序所在目录
        // （数据根下的 compare），不新建顶层目录，也就没有新的递归删除要过数据根闸门。
        const scratchDir = path.dirname(testPath);
        const freopenInput = String((msg.freopen && msg.freopen.inputFile) || '');
        const freopenOutput = String((msg.freopen && msg.freopen.outputFile) || '');
        const freopenOn = !!(freopenInput || freopenOutput);
        // 要 cwd 而 native 没有这个能力时，整轮走 child_process（它的 cwd 全平台都有）。
        // 绝不能带着被忽略的 cwd 继续跑 native：两个程序会把 data.out 写进同一个文件。
        const useFast = !!fast && !(freopenOn && fast.cwdSupported === false);
        const slots = freopenOn
            ? prepareFreopenSlots(scratchDir, startIdx, freopenInput, freopenOutput)
            : null;
        // checker 的三个临时文件按分片固定，逐轮覆盖。名字里的 tag 用 w<startIdx>，
        // 与样例模式的 c<i> 形状不同，两条路径同时跑也删不到对方的文件。
        const chkSlots = spjPath ? prepareCheckerSlots(scratchDir, 'w' + startIdx) : null;
        const genTimeout = (Number.isFinite(generatorTimeout) && generatorTimeout > 0) ? generatorTimeout : 0;
        let lastGenMs = 0, lastStdMs = 0, lastTestMs = 0;
        // 回退路径的生成器预取：std/test 并发期间事件循环是空的，提前把下一组
        // 生成器进程起出来，每测耗时从 gen+max(std,test) 收敛到 max(gen, max(std,test))。
        // fastpath 的 runFastPair 是同步 native 调用，会占死本线程事件循环，
        // 预取的生成器子进程写满管道缓冲区就得等 —— 没有重叠收益，不预取。
        let pendingGen = null;
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
                genOut = pendingGen ? await pendingGen : await runGenerator(gen, genTimeout);
                pendingGen = null;
                if (!running)
                    break;
                lastGenMs = genOut.ms || 0;
                if (genOut.timeout || genOut.error || genOut.signal || genOut.code !== 0) {
                    fail(i, 'generator', genOut.timeout ? 'gen_timeout' : (genOut.error || genOut.signal ? 'gen_error' : 'gen_exit'), genOut.error || (genOut.signal ? 'generator killed by ' + genOut.signal : 'generator exit ' + genOut.code), { rawInput: rawInput(), exitCode: genOut.code });
                    continue;
                }
                // 执行层按模式分派（native 双进程 / native 单进程 / child_process），
                // 判定层只有一份阶梯。
                // 文本判等必须跑正解；SPJ 跑不跑正解取决于用户有没有填 —— 只验性质的
                // checker 不需要基准，最优化题的 checker 需要，所以两种都得能走。
                const needStd = !spjPath || !!stdPath;
                // freopen：输入各写一份到自己的 slot（内容相同，目录不同），stdin 让位给文件；
                // 顺带清掉上一轮的输出文件，不能让陈旧内容冒充本轮结果
                if (slots) {
                    armSlot(slots.std, genOut.output);
                    armSlot(slots.test, genOut.output);
                }
                const stdinPayload = (slots && freopenInput) ? '' : genOut.output;
                const stdCwd = slots ? slots.std.dir : undefined;
                const curCwd = slots ? slots.test.dir : undefined;
                let std = null;
                let cur;
                if (needStd && useFast) {
                    if (!running)
                        break;
                    const pair = runFastPair(stdPath, testPath, stdinPayload, timeout, stdCwd, curCwd);
                    std = pair.std;
                    cur = pair.test;
                }
                else if (needStd) {
                    if (PREFETCH_ENABLED && running && i + 1 < startIdx + count)
                        pendingGen = runGenerator(gen, genTimeout);
                    const stdR0 = runJs(stdPath, stdinPayload, timeout, undefined, stdCwd);
                    const testR0 = runJs(testPath, stdinPayload, timeout, undefined, curCwd);
                    const [stdR, testR] = await Promise.all([stdR0, testR0]);
                    if (!running)
                        break;
                    std = outcomeFromJs(stdR);
                    cur = outcomeFromJs(testR);
                }
                else if (useFast) {
                    if (!running)
                        break;
                    // 只有一个程序时 native 也有单进程入口，不必降级到 child_process
                    cur = outcomeFromJs(runFast(testPath, stdinPayload, timeout, curCwd));
                }
                else {
                    if (PREFETCH_ENABLED && running && i + 1 < startIdx + count)
                        pendingGen = runGenerator(gen, genTimeout);
                    cur = outcomeFromJs(await runJs(testPath, stdinPayload, timeout, undefined, curCwd));
                    if (!running)
                        break;
                }
                // freopen 的结果在文件里，stdout 是空的；文件读不到时沿用 stdout（旧引擎同规则）
                if (std)
                    std = readSlotOutput(slots ? slots.std : null, std);
                cur = readSlotOutput(slots ? slots.test : null, cur);
                lastStdMs = std ? std.ms : 0;
                lastTestMs = cur.ms;
                const roundExtra = { rawInput: rawInput(), includeStdMs: true, includeTestMs: true };
                // 没跑正解就没有「正解输出」可回传，双栏视图据此藏掉那一节
                const rawStd = std ? std.output : undefined;
                // 顺序与改造前逐字一致：std 超时/运行错误 → cur 超时/运行错误 → 输出超限 → 判定。
                if (std) {
                    const stdVerdict = verdictForProgram('std', std);
                    if (stdVerdict) {
                        fail(i, stdVerdict.kind, stdVerdict.code, stdVerdict.detail, { ...roundExtra, exitCode: stdVerdict.exitCode });
                        continue;
                    }
                }
                const curVerdict = verdictForProgram('test', cur);
                if (curVerdict) {
                    fail(i, curVerdict.kind, curVerdict.code, curVerdict.detail, { ...roundExtra, exitCode: curVerdict.exitCode });
                    continue;
                }
                if ((std && std.truncated) || cur.truncated) {
                    fail(i, 'output_limit', 'output_limit', 'program output exceeded limit', roundExtra);
                    continue;
                }
                // SPJ 下判等权整个交给 checker；无 checker 时仍是规范化文本判等
                // （那条分支里 std 必然存在，只有它才可能给出「两边文本相同」这个结论）。
                let judged = null;
                if (chkSlots) {
                    judged = await judgeWithChecker(spjPath, chkSlots, rawInput(), std ? std.output : null, cur.output, timeout);
                    // 按停止时 checker 是被 cancelAll 杀掉的，不先看 running 就会把它报成「checker 挂了」
                    if (!running)
                        break;
                }
                else if (std) {
                    judged = outputsEqual(std.output, cur.output) ? null : { kind: 'mismatch', code: 'mismatch', detail: 'outputs differ' };
                }
                if (judged) {
                    fail(i, judged.kind, judged.code, judged.detail, { ...roundExtra, exitCode: judged.exitCode, rawStd: rawStd, rawTest: cur.output });
                    continue;
                }
                worker_threads_1.parentPort.postMessage({ type: 'progress', testIndex: i, genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, genLen: genOut.output.length });
            }
            catch (e) {
                fail(i, 'exception', 'exception', e && e.message ? e.message : String(e), { rawInput: rawInput() });
            }
        }
        // 分片收尾才删：逐轮 unlink 三次是纯开销，checker 每轮都要重新读这三个名字。
        // 走到这里既覆盖正常跑完，也覆盖 'stop'（循环条件里 running 变假后 break 出来）。
        if (chkSlots)
            removeCheckerSlots(chkSlots);
        worker_threads_1.parentPort.postMessage({ type: 'done' });
    }
    else if (msg.type === 'stop') {
        running = false;
        // native 异步起的子进程不在 activeProcesses 里（它们在 C 侧由线程池等），
        // 所以除了杀 child_process 那批，还得让 addon 把它登记过的进程组一起收掉。
        if (fast && typeof fast.cancelAll === 'function') {
            try {
                fast.cancelAll();
            }
            catch (_) { }
        }
        for (const proc of activeProcesses)
            killProc(proc);
        activeProcesses.clear();
    }
});
