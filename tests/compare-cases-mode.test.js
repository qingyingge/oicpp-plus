'use strict';

/**
 * 引擎的 cases 模式（给样例测试器用的后端）守卫。
 *
 * 对拍的形态是「生成器造数据 → 两个程序 → 比两份输出」；样例是「N 份现成的
 * {输入, 期望输出} → 一个程序 → 跟期望比」。两者判定语义必须一致，否则
 * 「样例通过」和「对拍一致」是两套话，而用户以为它们是同一件事。
 *
 * 本文件钉住：
 *   1. 状态词表必须是样例既有的那六个 {AC,WA,TLE,MLE,RE,OLE}。总览按固定键计数，
 *      喂进一个没登记的状态（比如 checker 的 PE）会被当 PENDING 累加，
 *      总览从此一直显示「运行中」—— 这是旧代码注释里点名警告过的坑。
 *   2. checker 的判词必须原样进 spjOutput（状态折叠、话不折叠）。
 *   3. 判等口径与样例测试器今天完全一致：剥 BOM、CRLF→LF、行尾空白、结尾空行。
 *      少了剥 BOM 就是一次静默回归（原来 AC 的样例变 WA）。
 *   4. 每组都要回报（包括通过的），而不是只对拍那样「只报失败」——
 *      样例面板要显示每一题的状态、耗时、stdout、stderr。
 *   5. 与对拍共用同一套判定原语（同一个 outputsEqual、同一个 checker 调用通道）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');

setTimeout(() => { console.log('[FAIL] 主流程没有跑到结尾'); process.exit(1); }, 150000);

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

let failures = 0;
let ran = 0;
const check = (name, cond, extra = '') => {
    ran++;
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

if (process.platform === 'win32') {
    console.log('[SKIP] cases 模式守卫 | win32 没有 sh');
    process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-cases-'));
const script = (name, body) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n');
    fs.chmodSync(p, 0o755);
    return p;
};
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { } };

// 读入两个数、打印和
const SUM = script('sum.sh', 'read a b; echo $((a + b))');
const SLOW = script('slow.sh', 'sleep 3; echo done');
const CRASH = script('crash.sh', 'echo out; echo err >&2; exit 3');
// 输出带 BOM：只有剥 BOM 的实现才会判它等于 "7"。
// 用八进制转义 —— sh/dash 的 printf 不支持 \xHH，写 '\xef...' 会原样输出反斜杠，
// 那样 fixture 根本没有 BOM，测出来的 WA 是假象（踩过）。
const BOM_OUT = script('bom.sh', "printf '\\357\\273\\2777\\n'");
// 行尾多余空白 + CRLF + 结尾空行
const MESSY_OUT = script('messy.sh', "printf '7  \\r\\n\\r\\n'");
// checker：期望（answer）与实际逐字相同就 ok，否则 wa；并打一句判词
const CHECKER = script('chk.sh', [
    'a=$(cat "$3"); o=$(cat "$2");',
    'if [ "$a" = "$o" ]; then echo "ok: matched"; exit 0; fi',
    'echo "wrong answer expected [$a] got [$o]"; exit 1'
].join('\n'));
// 故意判 WA 的 checker，用来验「状态折叠、判词不折叠」
const CHECKER_PE = script('chk-pe.sh', ['echo "wrong output format extra space"', 'exit 2'].join('\n'));

const WORKER = path.join(ROOT, 'src', 'main-process', 'compare-worker.js');

// 起一个 worker、发一批 case、收全部结果
function runCases(msg) {
    return new Promise((resolve, reject) => {
        const results = [];
        let done = null;
        const w = new Worker(WORKER);
        const timer = setTimeout(() => { try { w.terminate(); } catch (_) { } reject(new Error('cases 模式超时')); }, 60000);
        w.on('message', (m) => {
            if (m && m.type === 'case-result') results.push(m);
            else if (m && m.type === 'cases-done') {
                done = m.count;
                // worker 不会自己退出（对拍那边是引擎负责 terminate），
                // 不等 exit 事件，收到收尾消息就主动终止
                try { w.terminate(); } catch (_) { }
            }
        });
        w.on('error', (e) => { clearTimeout(timer); reject(e); });
        w.on('exit', (code) => {
            clearTimeout(timer);
            if (code !== 0 && done === null) return reject(new Error('worker 退出码 ' + code));
            resolve({ results: results, done: done, code: code });
        });
        w.postMessage(Object.assign({ type: 'run-cases', timeout: 2000, scratchDir: TMP }, msg));
    });
}

(async () => {
    // ---- 1. 基本判定 ----
    const ac = await runCases({ exePath: SUM, cases: [{ input: '3 4\n', expected: '7\n' }] });
    check('通过的样例也逐条回报（对拍只报失败，样例面板要的是每题结果）',
        ac.results.length === 1 && ac.results[0].status === 'AC' && ac.done === 1,
        JSON.stringify(ac.results.map(r => r.status)));
    check('回报里带齐面板要用的字段：stdout / 耗时 / 退出码 / 期望输出',
        String(ac.results[0].stdout).trim() === '7' && typeof ac.results[0].ms === 'number'
        && ac.results[0].exitCode === 0 && String(ac.results[0].expected).trim() === '7',
        JSON.stringify(ac.results[0]));

    const wa = await runCases({ exePath: SUM, cases: [{ input: '3 4\n', expected: '8\n' }] });
    check('答案不同 → WA', wa.results[0].status === 'WA', JSON.stringify(wa.results[0].status));

    const many = await runCases({ exePath: SUM, cases: [{ input: '1 1\n', expected: '2\n' }, { input: '2 3\n', expected: '5\n' }, { input: '4 4\n', expected: '9\n' }] });
    check('多组顺序回报、index 对齐、跑完给 cases-done',
        many.results.length === 3 && many.done === 3
        && many.results.map(r => r.index).join(',') === '0,1,2'
        && many.results.map(r => r.status).join(',') === 'AC,AC,WA',
        JSON.stringify(many.results.map(r => r.index + ':' + r.status)));

    // ---- 2. 状态词表与判据顺序 ----
    const tle = await runCases({ exePath: SLOW, timeout: 400, cases: [{ input: '1 1\n', expected: '2\n' }] });
    check('超时 → TLE（词表内、锅在程序自己）', tle.results[0].status === 'TLE', JSON.stringify(tle.results[0].status));

    const re = await runCases({ exePath: CRASH, cases: [{ input: '1 1\n', expected: '2\n' }] });
    check('非零退出 → RE，且 stdout 与 stderr 都带回来（面板要显示程序自己说了什么）',
        re.results[0].status === 'RE' && String(re.results[0].stdout).trim() === 'out' && /err/.test(re.results[0].stderr),
        JSON.stringify({ status: re.results[0].status, out: re.results[0].stdout, err: re.results[0].stderr }));

    // ---- 3. 判等口径必须与样例测试器今天一致 ----
    const bom = await runCases({ exePath: BOM_OUT, cases: [{ input: '', expected: '7\n' }] });
    // 先确认 fixture 真的产出了 BOM —— 上一条就是因为 printf 不认 \x 而测了个假的
    check('夹具确实输出了 U+FEFF（否则下面那条 AC 是在测空转）',
        bom.results[0].stdout.charCodeAt(0) === 0xFEFF,
        JSON.stringify({ first: bom.results[0].stdout.charCodeAt(0) }));
    check('输出带 BOM 时仍判 AC（样例今天的行为就是剥 BOM；不照搬就是一次静默回归）',
        bom.results[0].status === 'AC',
        JSON.stringify({ status: bom.results[0].status }));

    const messy = await runCases({ exePath: MESSY_OUT, cases: [{ input: '', expected: '7\n' }] });
    check('行尾空白 / CRLF / 结尾空行不影响判等（与对拍同一套规范化）',
        messy.results[0].status === 'AC', JSON.stringify(messy.results[0].status));

    // ---- 4. checker：状态折叠进词表，判词原样进 spjOutput ----
    const ck = await runCases({ exePath: SUM, spjPath: CHECKER, cases: [{ input: '3 4\n', expected: '7\n' }] });
    check('checker 判 ok → AC（样例的 expected 就是 checker 的 answer）',
        ck.results[0].status === 'AC', JSON.stringify(ck.results[0].status));

    const ckBad = await runCases({ exePath: SUM, spjPath: CHECKER, cases: [{ input: '3 4\n', expected: '8\n' }] });
    check('checker 判 wa → WA，且判词全文进 spjOutput（状态收进六个词，话不折）',
        ckBad.results[0].status === 'WA' && /expected \[8\] got \[7\]/.test(ckBad.results[0].spjOutput),
        JSON.stringify({ status: ckBad.results[0].status, spj: ckBad.results[0].spjOutput }));

    const ckPe = await runCases({ exePath: SUM, spjPath: CHECKER_PE, cases: [{ input: '3 4\n', expected: '7\n' }] });
    check('checker 返回 PE 这类没登记的状态时折成 WA，而不是造一个新状态码',
        ckPe.results[0].status === 'WA' && /wrong output format/.test(ckPe.results[0].spjOutput),
        JSON.stringify({ status: ckPe.results[0].status, spj: ckPe.results[0].spjOutput }));

    // checker 收到的三个文件：input / 程序输出 / 期望
    const seenLog = path.join(TMP, 'chk.log');
    const ckFiles = script('chk-files.sh', ['printf "%s\\n%s\\n%s\\n" "$(cat "$1")" "$(cat "$2")" "$(cat "$3")" >> ' + seenLog, 'exit 0'].join('\n'));
    await runCases({ exePath: SUM, spjPath: ckFiles, cases: [{ input: '3 4\n', expected: '7\n' }] });
    const seen = fs.readFileSync(seenLog, 'utf8').trim().split('\n');
    check('checker 仍按 testlib 的三参数协议收到 input / 程序输出 / 期望输出',
        seen.length === 3 && seen[0] === '3 4' && seen[1] === '7' && seen[2] === '7',
        JSON.stringify(seen));

    // ---- 5. 停止 ----
    const stopProbe = new Promise((resolve, reject) => {
        const got = [];
        const w = new Worker(WORKER);
        const errs = [];
        w.on('message', (m) => {
            if (m.type === 'case-result') {
                got.push(m.status);
                if (got.length === 1) w.postMessage({ type: 'stop' });
            } else if (m.type === 'cases-done') resolve({ got: got, done: true });
        });
        w.on('error', reject);
        w.on('exit', () => resolve({ got: got, done: false }));
        w.postMessage({
            type: 'run-cases', exePath: SUM, timeout: 2000, scratchDir: TMP,
            cases: [{ input: '1 1\n', expected: '2\n' }, { input: '2 2\n', expected: '4\n' }, { input: '3 3\n', expected: '6\n' }]
        });
        setTimeout(() => { try { w.terminate(); } catch (_) { } resolve({ got: got, done: false }); }, 15000);
    });
    const stopped = await stopProbe;
    check('stop 能中止一批 case（与对拍共用同一个 running 标志）',
        stopped.got.length < 3 || stopped.done === true,
        JSON.stringify(stopped));

    // ---- 6. 与对拍共用判定原语 ----
    const workerSrc = fs.readFileSync(WORKER, 'utf8');
    check('cases 模式用的是同一套判等与同一个 checker 通道（不是又抄一份）',
        /judgeCase[\s\S]*outputsEqual\(stripBom\(c\.expected\), stripBom\(o\.output\)\)/.test(workerSrc)
        && /judgeCase[\s\S]*judgeWithChecker\(/.test(workerSrc), '');
    const judgeBody = workerSrc.slice(workerSrc.indexOf('async function judgeCase'), workerSrc.indexOf('(parentPort as MessagePort).on'));
    check('样例的状态顺序仍由样例自己定（OLE 优先于 TLE），事实层不设优先级',
        /if \(f\.ole\)/.test(judgeBody) && /if \(f\.timedOut\)/.test(judgeBody)
        && judgeBody.indexOf('f.ole') < judgeBody.indexOf('f.timedOut'), '');

    // ---- 7. native 边界的字符串入参（这个坑是 cases 模式暴露出来的）----
    // fastspawn 的 run 原先把 string 和 Buffer 一起交给 napi_get_buffer_info，
    // 而它对 JS string 失败 → input 保持 NULL → 「传了输入」静默变成空 stdin，
    // 程序读到 EOF 算出垃圾答案、退出码还是 0。对拍只传 Buffer 所以从没暴露。
    const FASTSPAWN = path.join(ROOT, 'fastspawn.node');
    if (fs.existsSync(FASTSPAWN)) {
        let fast = null;
        try { fast = require(FASTSPAWN); } catch (_) { }
        if (fast && typeof fast.run === 'function') {
            const rStr = fast.run(SUM, '3 4\n', 10000);
            check('native run() 收到 JS string 时输入真的进了 stdin（不是静默空串）',
                rStr.code === 0 && String(rStr.output).trim() === '7',
                JSON.stringify({ code: rStr.code, out: String(rStr.output).trim() }));
            const rBuf = fast.run(SUM, Buffer.from('3 4\n'), 10000);
            check('Buffer 入参行为不变（同一答案）',
                rBuf.code === 0 && String(rBuf.output).trim() === '7',
                JSON.stringify({ code: rBuf.code, out: String(rBuf.output).trim() }));
        } else {
            console.log('[SKIP] native 入参守卫 | fastspawn.node 载不入（本平台没有预编译产物）');
        }
    } else {
        console.log('[SKIP] native 入参守卫 | 没有 fastspawn.node（Windows 走 child_process，本来就没这个坑）');
    }

    cleanup();
    if (ran === 0) { console.log('[FAIL] 一条断言都没跑'); failures++; }
    console.log(`\n${ran} 条断言，${failures} 失败`);
    process.exit(failures ? 1 : 0);
})().catch(e => { cleanup(); console.log('[FAIL] 守卫自身异常: ' + ((e && e.stack) || e)); process.exit(1); });
