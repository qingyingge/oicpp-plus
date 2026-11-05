/**
 * compare-worker.js — Native posix_spawn worker
 * 每个线程内完全同步: spawn+IO 在 C 层完成, 无事件循环开销.
 * 并行度 = 线程数 (每线程独立跑完整测试).
 * 生成器始终走 child_process（支持 args/cwd，兼容 Python 生成器）；
 * std/test 优先 fastspawn，加载失败时回退 child_process；
 * checker（SPJ）只在 testlib 模式下跑，它是第 4 个进程、且只吃文件，
 * 所以走 child_process 的 argv 通道，不动 native 的固定双进程接口。
 */
import { parentPort, MessagePort } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';

interface FastspawnRunResult {
    code: number;
    output: Buffer | string | null;
    truncated: boolean;
    signal?: number;
    // 样例面板要展示 stderr（native 侧上限 64KiB），cases 模式会读它
    stderr?: Buffer | string | null;
}

interface FastspawnPairRunResult {
    code1: number;
    code2: number;
    out1: Buffer | string | null;
    out2: Buffer | string | null;
    truncated: boolean;
    signal1?: number;
    signal2?: number;
}

interface FastspawnModule {
    run: (exe: string, input: Buffer | string | null, timeout: number, cwd?: string) => FastspawnRunResult;
    runPair: (std: string, test: string, input: Buffer | string | null, timeout: number, compare?: boolean, cwdStd?: string, cwdTest?: string) => FastspawnPairRunResult;
    cwdSupported?: boolean;
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
    // 只有 checker 需要：testlib 的判词按写法可能落在 stdout 或 stderr 任一侧，
    // 两边都要拿。热路径上每组都做一次 Buffer.concat 不值当，所以按需收集 ——
    // runJs 的 wantStderr 打开才有值。
    stderr?: string;
}

interface FastPairOutcome {
    std: ProgramOutcome;
    test: ProgramOutcome;
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

interface RunTestsMessage {
    type: string;
    startIdx: number;
    count: number;
    gen: string | GeneratorSpec;
    stdPath: string;
    testPath: string;
    timeout: number;
    generatorTimeout: number;
    // SPJ：checker 可执行文件路径。空 = 走文本判等（原有行为）
    spjPath?: string;
    // freopen：程序自己 fopen 的相对文件名。两者都为空 = 走 stdin/stdout（原有行为）
    freopen?: { inputFile?: string; outputFile?: string } | null;
}

interface ProgramOutcome {
    code: number | null;
    output: Buffer | string | null;
    truncated: boolean;
    timeout: boolean;
    error: string | null;
    signal: string | number | null;
    ms: number;
}

interface FailDescriptor {
    kind: string;
    code: string;
    detail: string;
    exitCode?: number | null;
}

interface FailExtra {
    rawInput?: Buffer | string | null;
    rawStd?: Buffer | string | null;
    rawTest?: Buffer | string | null;
    exitCode?: number | null;
    includeStdMs?: boolean;
    includeTestMs?: boolean;
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
        // 全平台 detached（win32 = DETACHED_PROCESS，不分配控制台）——这是权衡后的
        // 最终选择，两种模式对 console 依赖程序的行为差异实测于 docs/PERFORMANCE.md：
        //   隐藏控制台（旧）：getch/kbhit 绕过重定向的 stdin 读 CONIN$ → 永挂；
        //                     system("pause") 碰巧被 conhost 快速放行。
        //   DETACHED（现在）：pause 永挂（→按超时如实上报）；getch 读 stdin 见 EOF 立返。
        // 判定一致性优先：DETACHED 下所有 stdin 语义统一为「读重定向、EOF 即止」，
        // 与 OJ 评测环境同构；隐藏控制台则同时存在「读不到的一把键」和「永挂」两种
        // 幽灵路径。另外 DETACHED 每进程快 23ms（省 conhost 分配）。
        // POSIX detached 同时给出独立进程组供 kill(-pid)。win32 杀树走 taskkill /T。
        const proc = (spawn(exePath, args || [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: true,
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

async function runJs(exePath: string, input: Buffer | string | null, timeout: number, args?: string[], cwd?: string, wantStderr?: boolean): Promise<RunResult> {
    const t0 = Date.now();
    const proc = await spawnProcess(exePath, args, cwd);
    if (input !== null && input !== undefined) await writeInput(proc, input);
    const r = await waitForResult(proc, timeout);
    const output = (r.exitCode === -1 || r.exitCode === -3) ? null : proc._collect();
    return { code: r.exitCode, output, outputTruncated: !!r.outputTruncated || !!proc._outputTruncated?.(), timeout: !!r.timeout, error: r.error, signal: r.signal || null, ms: Date.now() - t0, stderr: wantStderr ? proc._stderr() : undefined };
}

function runFast(exePath: string, input: Buffer | string | null, timeout: number, cwd?: string): RunResult {
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

function runFastPair(stdPath: string, testPath: string, input: Buffer | string | null, timeout: number, cwdStd?: string, cwdTest?: string): FastPairOutcome {
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

// ---------------------------------------------------------------------------
// 判定阶梯：快路与回退路共用同一套顺序。
// 两条路径原先各抄一遍（顺序稍有出入，回退路能识别 signal 而快路不能），
// 加一种判定就得同步改两处。现在执行层只负责把结果归一化成 ProgramOutcome，
// 判定顺序只有一份。
// ---------------------------------------------------------------------------

function outcomeFromFast(code: number, output: Buffer | string | null, truncated: boolean, signal: number | undefined, ms: number): ProgramOutcome {
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

function outcomeFromJs(r: RunResult): ProgramOutcome {
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

interface ProgramFacts {
    // 一个程序这一轮「发生了什么」的事实，不含优先级：对拍与样例对同一组事实的
    // 排序不同（样例先看 OLE 再看 TLE，对拍先判运行错误再看输出超限），
    // 把优先级写死进事实层就会逼第二个消费者去重抄一遍判定。
    timedOut: boolean;
    crashed: boolean;
    exitNonZero: boolean;
    ole: boolean;
    exitCode: number | null;
    detail: string;
    clean: boolean;
}

function factsOfProgram(o: ProgramOutcome, who: string): ProgramFacts {
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
function verdictForProgram(role: 'std' | 'test', o: ProgramOutcome): FailDescriptor | null {
    const who = role === 'std' ? 'standard' : 'test';
    const f = factsOfProgram(o, who);
    if (f.timedOut) return { kind: role + '_tle', code: role + '_timeout', detail: f.detail, exitCode: f.exitCode };
    if (f.crashed) return { kind: role + '_re', code: role + '_error', detail: f.detail, exitCode: f.exitCode };
    if (f.exitNonZero) return { kind: role + '_re', code: role + '_exit', detail: f.detail, exitCode: f.exitCode };
    return null;
}

// testlib checker 的退出码来自 resultExitCode()：_ok=0、_wa=1、_pe=2、_fail=3、
// _dirt=4、_points=5、_partially(n)=16+n。参数写错或 testlib 自身异常时
// __testlib_help()/quit(_fail) 也是 3 —— 那是评测器的问题，不能算到被测程序头上。
function verdictFromChecker(r: RunResult): FailDescriptor | null {
    const comment = captureText([r.output, r.stderr].filter(Boolean).join('\n'), MAX_CAPTURED_OUTPUT_BYTES).text.trim();
    if (r.timeout) return { kind: 'spj_tle', code: 'spj_timeout', detail: comment || 'checker timed out', exitCode: r.code };
    if (r.error || r.signal) return { kind: 'spj_error', code: 'spj_error', detail: comment || r.error || ('checker killed by ' + String(r.signal)), exitCode: r.code };
    if (r.code === 0) return null;
    if (r.code === 1) return { kind: 'spj_wa', code: 'spj_wa', detail: comment || 'wrong answer', exitCode: r.code };
    if (r.code === 2 || r.code === 4) return { kind: 'spj_pe', code: 'spj_pe', detail: comment || 'presentation error', exitCode: r.code };
    if (r.code === 3) return { kind: 'spj_error', code: 'spj_fail', detail: comment || 'checker reported FAIL', exitCode: r.code };
    if (r.code === 5 || r.code >= 16) return { kind: 'spj_wa', code: 'spj_partial', detail: comment || 'partially correct', exitCode: r.code };
    return { kind: 'spj_error', code: 'spj_error', detail: comment || ('checker exit ' + String(r.code)), exitCode: r.code };
}

function asBuffer(value: Buffer | string | null | undefined): Buffer {
    if (value == null) return Buffer.alloc(0);
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

// checker 只吃文件，且 testlib 恒要求三个位置参数都存在（打不开会直接 testlib FAIL），
// 所以这是整条对拍里唯一需要把内存数据落盘的环节。
// answer 是正解的输出；没配正解（SPJ 下合法）时传一个存在的空文件 —— 只验性质的
// checker 不读它，而最优化题那类要基准的 checker 就得让用户把正解填上。
// 文件名带 startIdx —— 每个 worker 的分片起点互不相同，同一 worker 内逐轮串行，
// 因此固定三个名字反复覆盖即可，既不会跨 worker 撞车，也不堆积 per-test 临时文件。
async function judgeWithChecker(spjPath: string, scratchDir: string, tag: string, input: Buffer | string | null, answer: Buffer | string | null, actual: Buffer | string | null, timeout: number): Promise<FailDescriptor | null> {
    const inFile = path.join(scratchDir, `oicpp_spj_${tag}_in.txt`);
    const outFile = path.join(scratchDir, `oicpp_spj_${tag}_out.txt`);
    const ansFile = path.join(scratchDir, `oicpp_spj_${tag}_ans.txt`);
    try {
        fs.writeFileSync(inFile, asBuffer(input));
        fs.writeFileSync(outFile, asBuffer(actual));
        fs.writeFileSync(ansFile, asBuffer(answer));
        const run = await runJs(spjPath, null, timeout, [inFile, outFile, ansFile], scratchDir, true);
        return verdictFromChecker(run);
    } catch (e) {
        return { kind: 'spj_error', code: 'spj_error', detail: (e as Error).message || String(e) };
    } finally {
        // taskkill 返回后句柄可能还没释放（见 waitForResult 里同样的处理），
        // 删不掉就留给下一轮覆盖，不能让它盖掉判定结论。
        for (const file of [inFile, outFile, ansFile]) {
            try { fs.unlinkSync(file); } catch (_) { }
        }
    }
}

// ---------------------------------------------------------------------------
// freopen 型程序（自己 fopen("data.in"/"data.out")）的隔离。
// 这类程序不看父进程重定向的 stdin/stdout，唯一的隔离手段是给每个进程一个
// 自己的工作目录：两个程序都往相对路径上的同一个名字写，共用目录就是互相覆盖，
// 而覆盖后的结论看起来完全正常 —— 这是最坏的一种错。
// 目录按「worker 分片 + 角色」固定命名并长期复用：组跑多少轮都不会在磁盘上
// 堆目录，也不需要任何递归删除（数据根下的递归删除要过闸门，能不引入就不引入）。
// ---------------------------------------------------------------------------

interface FreopenSlot {
    dir: string;
    inputFile: string;
    outputFile: string;
}

interface FreopenSetup {
    std: FreopenSlot;
    test: FreopenSlot;
}

function prepareFreopenSlots(scratchDir: string, startIdx: number, inputFile: string, outputFile: string): FreopenSetup {
    const base = path.join(scratchDir, 'freopen_runs', `w${startIdx}`);
    const make = (role: string): FreopenSlot => {
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
function armSlot(slot: FreopenSlot, data: Buffer | string | null): void {
    if (slot.inputFile) fs.writeFileSync(path.join(slot.dir, slot.inputFile), asBuffer(data));
    if (slot.outputFile) {
        try { fs.unlinkSync(path.join(slot.dir, slot.outputFile)); } catch (_) { }
    }
}

// 输出从文件回收。按字节上限读，绝不能 readFileSync 一整份 —— 一个死循环写文件的
// 程序会把 worker 的内存吃掉，而它本来只是该被判 OLE。
// 文件不存在时回退到 stdout：老代码里 freopen 输出走的就是这条兜底（有些程序只写
// 部分情形到文件），改成「读不到就算空」会让这批程序集体变 WA。
function readSlotOutput(slot: FreopenSlot | null, o: ProgramOutcome): ProgramOutcome {
    if (!slot || !slot.outputFile) return o;
    const file = path.join(slot.dir, slot.outputFile);
    let fd = -1;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, MAX_WORKER_OUTPUT_BYTES);
        const buf = Buffer.alloc(len);
        const got = fs.readSync(fd, buf, 0, len, 0);
        return { ...o, output: buf.slice(0, got), truncated: o.truncated || size > len };
    } catch (_) {
        return o;
    } finally {
        if (fd >= 0) { try { fs.closeSync(fd); } catch (_) { } }
    }
}

interface CaseSpec {
    input: string;
    expected: string;
}

interface RunCasesMessage {
    type: string;
    cases: CaseSpec[];
    exePath: string;
    timeout: number;
    spjPath?: string;
    scratchDir: string;
}

interface CaseResultMessage {
    type: 'case-result';
    index: number;
    status: string;
    exitCode: number | null;
    ms: number;
    stdout: string;
    stdoutTruncated: boolean;
    stderr: string;
    expected: string;
    spjOutput: string;
}

// checker 的结论折进样例既有的状态词表：{AC,WA,TLE,MLE,RE,OLE}。
// 词表不能随意扩 —— 样例总览按固定键计数，喂进一个没登记的码（比如 PE）会被当成
// PENDING 累加，总览从此一直显示「运行中」。checker 的原话另有去处（spjOutput 文本框）。
function caseStatusFromChecker(desc: FailDescriptor | null): string {
    if (!desc) return 'AC';
    if (desc.code === 'spj_timeout') return 'TLE';
    if (desc.code === 'spj_wa' || desc.code === 'spj_pe' || desc.code === 'spj_partial') return 'WA';
    return 'RE';
}

// 样例测试器今天比较前会剥掉 UTF-8 BOM（Windows 编辑器存出来的期望输出、以及不少
// 题面下载的数据都带 BOM）。对拍的规范化不剥是有道理的：两个程序同源，BOM 要么都
// 有要么都没有。样例是「程序输出 vs 人手写的期望」，一边有 BOM 一边没有是常态 ——
// 不照搬这条，切换后原来 AC 的样例会变 WA，而且看起来像程序写错了。
function stripBom(value: Buffer | string | null | undefined): Buffer | string | null | undefined {
    if (value == null) return value;
    if (Buffer.isBuffer(value)) {
        return (value.length >= 3 && value[0] === 0xEF && value[1] === 0xBB && value[2] === 0xBF)
            ? value.subarray(3) : value;
    }
    return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value;
}

async function judgeCase(c: CaseSpec, o: ProgramOutcome, msg: RunCasesMessage, tag: string): Promise<{ status: string; spjOutput: string }> {
    const f = factsOfProgram(o, 'program');
    // 顺序沿用样例测试器今天的判据（OLE → TLE → RE → 判定），与对拍的优先级不同是
    // 有意的：样例里「输出爆掉」比「顺手也超时了」更能解释用户看到的现象。
    if (f.ole) return { status: 'OLE', spjOutput: '' };
    if (f.timedOut) return { status: 'TLE', spjOutput: '' };
    if (f.crashed || f.exitNonZero) return { status: 'RE', spjOutput: '' };
    if (msg.spjPath) {
        // 样例的 expected 就是 checker 的 answer —— 这正是「有基准」那一侧的用法
        const desc = await judgeWithChecker(msg.spjPath, msg.scratchDir, tag, c.input, c.expected, o.output, msg.timeout);
        return { status: caseStatusFromChecker(desc), spjOutput: desc ? desc.detail : '' };
    }
    // BOM 只在这条文本比对分支剥：样例测试器今天的 SPJ 路径传的是 trimEnd 后的原文，
    // 照搬才是「行为不变」，顺手也给 checker 剥 BOM 反而是改动旧行为。
    return { status: outputsEqual(stripBom(c.expected), stripBom(o.output)) ? 'AC' : 'WA', spjOutput: '' };
}

(parentPort as MessagePort).on('message', async (msg: RunCasesMessage) => {
    if (msg.type !== 'run-cases') return;
    running = true;
    const cases = Array.isArray(msg.cases) ? msg.cases : [];
    for (let i = 0; i < cases.length && running; i++) {
        const c = cases[i];
        if (!c) continue;
        const started = Date.now();
        let o: ProgramOutcome;
        let stderr = '';
        try {
            if (fast) {
                const r = fast.run(msg.exePath, c.input, effectiveRunTimeout(msg.timeout));
                o = outcomeFromFast(r.code, r.output, !!r.truncated, r.signal, Date.now() - started);
                stderr = r.stderr ? Buffer.from(r.stderr).toString('utf8') : '';
            } else {
                const r = await runJs(msg.exePath, c.input, msg.timeout, undefined, undefined, true);
                o = outcomeFromJs(r);
                stderr = r.stderr || '';
            }
            const verdict = await judgeCase(c, o, msg, String(i));
            const shown = captureText(o.output, MAX_CAPTURED_OUTPUT_BYTES);
            (parentPort as MessagePort).postMessage({
                type: 'case-result',
                index: i,
                status: verdict.status,
                exitCode: o.code,
                ms: o.ms || (Date.now() - started),
                stdout: shown.text,
                stdoutTruncated: shown.truncated,
                stderr: stderr,
                expected: c.expected,
                spjOutput: verdict.spjOutput
            } as CaseResultMessage);
        } catch (e) {
            (parentPort as MessagePort).postMessage({
                type: 'case-result',
                index: i,
                status: 'RE',
                exitCode: null,
                ms: Date.now() - started,
                stdout: '',
                stdoutTruncated: false,
                stderr: (e as Error).message || String(e),
                expected: c.expected,
                spjOutput: ''
            } as CaseResultMessage);
        }
    }
    (parentPort as MessagePort).postMessage({ type: 'cases-done', count: cases.length });
});

let running = false;
const activeProcesses = new Set<WorkerProc>();

(parentPort as MessagePort).on('message', async (msg: RunTestsMessage) => {
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
        const slots: FreopenSetup | null = freopenOn
            ? prepareFreopenSlots(scratchDir, startIdx, freopenInput, freopenOutput)
            : null;
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

                // 执行层按模式分派（native 双进程 / native 单进程 / child_process），
                // 判定层只有一份阶梯。
                // 文本判等必须跑正解；SPJ 跑不跑正解取决于用户有没有填 —— 只验性质的
                // checker 不需要基准，最优化题的 checker 需要，所以两种都得能走。
                const needStd = !spjPath || !!stdPath;
                // freopen：输入各写一份到自己的 slot（内容相同，目录不同），stdin 让位给文件；
                // 顺带清掉上一轮的输出文件，不能让陈旧内容冒充本轮结果
                if (slots) { armSlot(slots.std, genOut.output); armSlot(slots.test, genOut.output); }
                const stdinPayload = (slots && freopenInput) ? '' : genOut.output;
                const stdCwd = slots ? slots.std.dir : undefined;
                const curCwd = slots ? slots.test.dir : undefined;
                let std: ProgramOutcome | null = null;
                let cur: ProgramOutcome;
                if (needStd && useFast) {
                    if (!running) break;
                    const pair = runFastPair(stdPath, testPath, stdinPayload, timeout, stdCwd, curCwd);
                    std = pair.std;
                    cur = pair.test;
                } else if (needStd) {
                    if (PREFETCH_ENABLED && running && i + 1 < startIdx + count) pendingGen = runGenerator(gen, genTimeout);
                    const stdR0 = runJs(stdPath, stdinPayload, timeout, undefined, stdCwd);
                    const testR0 = runJs(testPath, stdinPayload, timeout, undefined, curCwd);
                    const [stdR, testR] = await Promise.all([stdR0, testR0]);
                    if (!running) break;
                    std = outcomeFromJs(stdR);
                    cur = outcomeFromJs(testR);
                } else if (useFast) {
                    if (!running) break;
                    // 只有一个程序时 native 也有单进程入口，不必降级到 child_process
                    cur = outcomeFromJs(runFast(testPath, stdinPayload, timeout, curCwd));
                } else {
                    if (PREFETCH_ENABLED && running && i + 1 < startIdx + count) pendingGen = runGenerator(gen, genTimeout);
                    cur = outcomeFromJs(await runJs(testPath, stdinPayload, timeout, undefined, curCwd));
                    if (!running) break;
                }
                // freopen 的结果在文件里，stdout 是空的；文件读不到时沿用 stdout（旧引擎同规则）
                if (std) std = readSlotOutput(slots ? slots.std : null, std);
                cur = readSlotOutput(slots ? slots.test : null, cur);
                lastStdMs = std ? std.ms : 0;
                lastTestMs = cur.ms;
                const roundExtra: FailExtra = { rawInput: rawInput(), includeStdMs: true, includeTestMs: true };
                // 没跑正解就没有「正解输出」可回传，双栏视图据此藏掉那一节
                const rawStd = std ? std.output : undefined;

                // 顺序与改造前逐字一致：std 超时/运行错误 → cur 超时/运行错误 → 输出超限 → 判定。
                if (std) {
                    const stdVerdict = verdictForProgram('std', std);
                    if (stdVerdict) { fail(i, stdVerdict.kind, stdVerdict.code, stdVerdict.detail, { ...roundExtra, exitCode: stdVerdict.exitCode }); continue; }
                }
                const curVerdict = verdictForProgram('test', cur);
                if (curVerdict) { fail(i, curVerdict.kind, curVerdict.code, curVerdict.detail, { ...roundExtra, exitCode: curVerdict.exitCode }); continue; }
                if ((std && std.truncated) || cur.truncated) { fail(i, 'output_limit', 'output_limit', 'program output exceeded limit', roundExtra); continue; }

                // SPJ 下判等权整个交给 checker；无 checker 时仍是规范化文本判等
                // （那条分支里 std 必然存在，只有它才可能给出「两边文本相同」这个结论）。
                let judged: FailDescriptor | null = null;
                if (spjPath) {
                    judged = await judgeWithChecker(spjPath, scratchDir, String(startIdx), rawInput(), std ? std.output : null, cur.output, timeout);
                } else if (std) {
                    judged = outputsEqual(std.output, cur.output) ? null : { kind: 'mismatch', code: 'mismatch', detail: 'outputs differ' };
                }
                if (judged) {
                    fail(i, judged.kind, judged.code, judged.detail, { ...roundExtra, exitCode: judged.exitCode, rawStd: rawStd, rawTest: cur.output });
                    continue;
                }
                (parentPort as MessagePort).postMessage({ type: 'progress', testIndex: i, genMs: lastGenMs, stdMs: lastStdMs, testMs: lastTestMs, genLen: (genOut.output as Buffer).length });
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
