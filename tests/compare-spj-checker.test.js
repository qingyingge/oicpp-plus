'use strict';

/**
 * SPJ（checker）进入 HPC 对拍引擎的行为守卫。
 *
 * 在这之前，勾了 testlib 的对拍整轮退回渲染层的旧引擎（codeComparer 的 runComparison），
 * 新引擎只认「两个程序的文本输出逐字节/规范化相等」。引擎侧的配置字段（spjExe/useTestlib）
 * 其实一直在发，只是 CompareConfig 没声明，被静默丢掉。
 *
 * 现在的形态：gen → (正解 ∥ 被测) → checker，其中**正解可选**。checker 分两类，两种都要能走：
 *   · 只验性质的（「这是不是合法解 / 是否达到最优」）不需要基准 → 正解留空，answer 是空文件，
 *     少跑一个进程；
 *   · 要基准的（最优化题比最优值、计分类）→ 正解填上，它的输出就是 answer。
 * 状态与文案由 checker 自己决定，引擎不加猜测。
 *
 * 本文件钉住这件事里最容易静默出错的部分：
 *   1. testlib 恒要求三个位置参数 `<input> <participant_output> <answer>`，且三个路径
 *      都必须真实存在（打不开 answer 会直接 testlib FAIL）—— 空文件 ≠ 不传文件。
 *   2. answer 装的是不是正解输出、没填正解时是不是真的一个进程都没多跑。
 *   3. 退出码语义按 testlib 的 resultExitCode()：0=ok、1=wa、2=pe、3=fail、4=dirt、
 *      5=points、16+n=partially。其中 **3（FAIL）是评测器或数据自己的问题**，不能折算成
 *      被测程序的 WA —— 判成 WA 会把「checker 写错了」伪装成「程序答案不对」，用户会去
 *      改一个本来就对的程序。
 *   4. checker 的判词（quitf 的第二参数）必须传回渲染层。只报「答案错误」而不报
 *      「第 3 个 token 不对」，对拍器就退化成一个只会说「不」的黑盒。
 *   5. 并发隔离：checker 只吃文件，这是整条管线里唯一落盘的环节。scratch 文件名带
 *      分片起点 startIdx，worker 之间不共享；撞名会表现为随机的 spj_wa。
 *   6. 反向边界：勾了 testlib 却不带 checker（只用 testlib 生成器）是合法组合，必须照常
 *      走文本判等并跑正解；「未勾 testlib 时即便发来 spjExe 也不许启用 checker」是同一条
 *      边界的另一半。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：引擎没有发出 complete');
    process.exit(1);
}, 180000);

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

let failures = 0;
let ran = 0;
const check = (name, cond, extra = '') => {
    ran++;
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};
const skip = (name, why) => {
    console.log(`[SKIP] ${name} | ${why}`);
};

// 桩程序是 sh 脚本，win32 没有 sh（与 compare-timeout-anchor 同一口径）。
// 被测的判定逻辑本身与平台无关：Windows 上引擎走 child_process 路径，checker 也走同一条。
if (process.platform === 'win32') {
    skip('SPJ checker 引擎守卫', 'win32 没有 sh；checker 判定路径由 POSIX 覆盖，Windows 走同一条 JS 回退实现');
    process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-spj-'));
const LOG = path.join(TMP, 'checker-log.txt');
const STDLOG = path.join(TMP, 'std-was-run.txt');
const script = (name, body) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n');
    fs.chmodSync(p, 0o755);
    return p;
};

// 三份内容互不相同：生成器出 I、正解出 A、被测出 O。
// answer 里装的到底是谁的输出、正解到底有没有被跑，全靠这三者区分开才看得出来。
const GEN = script('gen.sh', 'echo I');
const STD = script('std.sh', `echo ran >> ${STDLOG}; cat >/dev/null; echo A`);
const CUR = script('cur.sh', 'cat >/dev/null; echo O');
// 与正解输出一致的一份被测程序，用来验证「没 checker 时仍走文本判等」那条反向边界
const CUR_SAME_AS_STD = script('cur-echo-ans.sh', 'cat >/dev/null; echo A');

// checker：把 argv、三个文件的内容与「文件是否存在」记进日志，再按 CODE 退出，
// 并按 testlib 的样子把判词写到 stdout 和 stderr 两边（判词落在哪侧都该回到 UI）。
const checker = (name, code, verdict) => script(name, [
    `printf 'argc=%s\\n' "$#" >> ${LOG}`,
    `for a in "$@"; do printf 'arg=%s\\n' "$a" >> ${LOG}; done`,
    `for a in "$@"; do printf 'content=%s\\n' "$(cat "$a" 2>/dev/null)" >> ${LOG}; printf 'exists=%s\\n' "$([ -f "$a" ] && echo yes || echo no)" >> ${LOG}; done`,
    `printf 'checker stdout: %s\\n' '${verdict}'`,
    `printf 'checker stderr: %s\\n' '${verdict}' >&2`,
    `exit ${code}`
].join('\n'));

const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 尽力 */ } };
const resetLog = () => { try { fs.writeFileSync(LOG, ''); fs.writeFileSync(STDLOG, ''); } catch (_) { } };
const readLog = () => { try { return fs.readFileSync(LOG, 'utf8'); } catch (_) { return ''; } };
const stdRan = () => { try { return fs.readFileSync(STDLOG, 'utf8').trim().length > 0; } catch (_) { return false; } };

const { CompareEngine } = require(path.join(ROOT, 'src', 'main-process', 'compare-engine.js'));

function runEngine(cfg) {
    return new Promise((resolve) => {
        const e = new CompareEngine();
        const ev = { progress: 0, errors: [], warnings: [] };
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve(ev);
        };
        e.on('progress', () => { ev.progress++; });
        e.on('error', d => {
            ev.errors.push({ type: d.type, code: d.code, message: String(d.message || ''), stdOutput: d.stdOutput, testOutput: d.testOutput });
        });
        e.on('warning', d => ev.warnings.push(d.code));
        e.on('complete', finish);
        e.on('stopped', finish);
        e.start(Object.assign({ totalTests: 1, threadCount: 1, timeLimit: 15000, generatorTimeout: 15000 }, cfg));
    });
}

const spj = (exe, extra) => Object.assign({ generator: GEN, stdExe: STD, testExe: CUR, spjExe: exe, useTestlib: true }, extra || {});
// 正解留空的同一套配置：SPJ 下合法，且这一轮不该有任何正解进程
const spjNoStd = (exe, extra) => spj(exe, Object.assign({ stdExe: '' }, extra || {}));

const lines = (text, prefix) => text.split('\n').filter(l => l.startsWith(prefix)).map(l => l.slice(prefix.length));
// 跑一遍「永远判 ok」的 checker，只为了把 argv/文件现场记进日志
const probe = async (cfg) => {
    resetLog();
    const ev = await runEngine(Object.assign({}, cfg, { spjExe: checker('chk-probe.sh', 0, 'ok') }));
    const log = readLog();
    return { ev, contents: lines(log, 'content='), exists: lines(log, 'exists='), argvCount: lines(log, 'argc=').join('') };
};

(async () => {
    // ---- 1. argv 协议 ----
    const withStd = await probe(spj(''));
    check('填了正解：三个参数依次是 input / 被测输出 / 正解输出（answer 就是基准）',
        withStd.argvCount === '3' && withStd.contents.length === 3
        && withStd.contents[0] === 'I' && withStd.contents[1] === 'O' && withStd.contents[2] === 'A',
        JSON.stringify(withStd.contents));
    check('填了正解：正解确实被跑了一次（没跑就没有基准）',
        stdRan(), `stdRan=${stdRan()}`);

    const noStd = await probe(spjNoStd(''));
    check('正解留空：answer 是空文件，但文件必须存在（testlib 打不开 answer 会直接 FAIL，空≠缺）',
        noStd.contents.length === 3 && noStd.contents[0] === 'I' && noStd.contents[1] === 'O' && noStd.contents[2] === ''
        && noStd.exists.length === 3 && noStd.exists.every(v => v === 'yes'),
        JSON.stringify({ contents: noStd.contents, exists: noStd.exists }));
    check('正解留空：一个正解进程都不起（多跑的不是「慢一点」，是白跑一遍判定对象不同的东西）',
        !stdRan(), `stdRan=${stdRan()}`);

    const paths = lines(readLog(), 'arg=');
    check('argv 是落在磁盘上的临时文件（不是 stdin，也不是内存句柄）',
        paths.length === 3 && paths.every(p => p.indexOf('oicpp_spj_') !== -1), JSON.stringify(paths));

    const judged = await runEngine(spj(checker('chk-judged.sh', 0, 'ok')));
    check('判定权整个在 checker：被测输出与正解文本不同时也不报 mismatch',
        judged.progress === 1 && judged.errors.length === 0 && !judged.errors.some(e => e.type === 'mismatch'),
        JSON.stringify(judged));

    // ---- 2. 退出码语义 ----
    const wa = await runEngine(spj(checker('chk-wa.sh', 1, '3rd word differs')));
    check('退出码 1 → spj_wa/spj_wa（被测程序的答案问题）',
        wa.errors.length === 1 && wa.errors[0].type === 'spj_wa' && wa.errors[0].code === 'spj_wa',
        JSON.stringify(wa.errors));
    check('checker 的判词回到 message（只说「答案错误」等于把对拍器变成黑盒）',
        wa.errors.length === 1 && wa.errors[0].message.indexOf('3rd word differs') !== -1,
        JSON.stringify(wa.errors[0] && wa.errors[0].message));
    check('WA 把两份输出都带回（有正解时双栏视图有内容可显示）',
        wa.errors.length === 1 && String(wa.errors[0].stdOutput).trim() === 'A' && String(wa.errors[0].testOutput).trim() === 'O',
        JSON.stringify({ s: wa.errors[0] && wa.errors[0].stdOutput, t: wa.errors[0] && wa.errors[0].testOutput }));

    const waNoStd = await runEngine(spjNoStd(checker('chk-wa2.sh', 1, 'not optimal')));
    check('正解留空时不谎报正解输出（stdOutput 必须为空，双栏视图据此藏掉那一节）',
        waNoStd.errors.length === 1 && !waNoStd.errors[0].stdOutput && String(waNoStd.errors[0].testOutput).trim() === 'O',
        JSON.stringify(waNoStd.errors));

    const pe = await runEngine(spj(checker('chk-pe.sh', 2, 'extra whitespace')));
    check('退出码 2 → spj_pe（PE 与 WA 是两种结论，文案不同）',
        pe.errors.length === 1 && pe.errors[0].code === 'spj_pe', JSON.stringify(pe.errors));

    const dirt = await runEngine(spj(checker('chk-dirt.sh', 4, 'extra tokens')));
    check('退出码 4（_dirt，testlib 归一成 PE）→ spj_pe',
        dirt.errors.length === 1 && dirt.errors[0].code === 'spj_pe', JSON.stringify(dirt.errors));

    const failed = await runEngine(spj(checker('chk-fail.sh', 3, 'FAIL: cannot open answer')));
    check('退出码 3（testlib FAIL）归到引擎错误侧、不报成被测程序的 WA',
        failed.errors.length === 1 && failed.errors[0].type === 'spj_error' && failed.errors[0].code === 'spj_fail',
        JSON.stringify(failed.errors));

    const partial = await runEngine(spj(checker('chk-partial.sh', 17, 'partially correct (15)')));
    check('退出码 16+n（部分正确）算「未被接受」而不是 checker 故障',
        partial.errors.length === 1 && partial.errors[0].type === 'spj_wa' && partial.errors[0].code === 'spj_partial',
        JSON.stringify(partial.errors));

    const unknown = await runEngine(spj(checker('chk-unknown.sh', 9, 'what')));
    check('非 testlib 的陌生退出码归成 checker 错误（不猜成 WA）',
        unknown.errors.length === 1 && unknown.errors[0].type === 'spj_error', JSON.stringify(unknown.errors));

    // ---- 3. 反向边界：没 checker / 没勾 testlib 时，正解照旧要跑 ----
    resetLog();
    const noChecker = await runEngine({ generator: GEN, stdExe: STD, testExe: CUR_SAME_AS_STD, useTestlib: true });
    check('勾了 testlib 但没有 checker：不报错，按文本判等跑完',
        noChecker.progress === 1 && noChecker.errors.length === 0, JSON.stringify(noChecker));
    check('这种组合下正解仍然要跑（没 checker 就没有别的判定来源）',
        stdRan(), `stdRan=${stdRan()}`);

    const noCheckerDiff = await runEngine({ generator: GEN, stdExe: STD, testExe: CUR, useTestlib: true });
    check('同上但两份输出不同：报的是文本 mismatch，而不是任何 spj_* 结论',
        noCheckerDiff.errors.length === 1 && noCheckerDiff.errors[0].type === 'mismatch',
        JSON.stringify(noCheckerDiff.errors));

    resetLog();
    const notTestlib = await runEngine({ generator: GEN, stdExe: STD, testExe: CUR_SAME_AS_STD, spjExe: checker('chk-unused.sh', 1, 'should not run'), useTestlib: false });
    check('未勾 testlib 时 spjExe 被忽略：仍走文本判等，且 checker 一次都没跑',
        notTestlib.progress === 1 && notTestlib.errors.length === 0 && readLog() === '',
        JSON.stringify({ progress: notTestlib.progress, errors: notTestlib.errors, log: readLog() }));

    // ---- 4. 并发隔离：多 worker 各自的分片不能撞在同一组 scratch 文件上 ----
    resetLog();
    const uniqGen = script('gen-uniq.sh', 'date +%s%N; sleep 0.05');
    const echo = script('echo-stdin.sh', 'cat');
    // checker 要求 in 与 out 内容一致、answer 存在且为空；不满足就 exit 1 并留下现场
    const agree = script('chk-agree.sh', [
        'i=$(cat "$1"); o=$(cat "$2");',
        `if [ ! -f "$3" ]; then printf 'answer missing: %s\\n' "$3" >> ${LOG}; exit 1; fi`,
        `if [ -s "$3" ]; then printf 'answer not empty\\n' >> ${LOG}; exit 1; fi`,
        'if [ -n "$i" ] && [ "$i" = "$o" ]; then exit 0; fi',
        `printf 'mismatch in=[%s] out=[%s]\\n' "$i" "$o" >> ${LOG}`,
        'exit 1'
    ].join('\n'));
    const par = await runEngine(spjNoStd(agree, { generator: uniqGen, testExe: echo, totalTests: 8, threadCount: 4 }));
    check('4 worker 并发跑 SPJ（单进程路径）：8 组全部通过（撞 scratch 会表现为随机 spj_wa）',
        par.progress === 8 && par.errors.length === 0,
        JSON.stringify({ progress: par.progress, errors: par.errors.slice(0, 2), log: readLog().slice(0, 160) }));
    check('并发跑完正解依然一次都没被调起来',
        !stdRan(), `stdRan=${stdRan()}`);

    // 有正解时 answer 不再为空，换一个要求 in==out==ans 的 checker
    const agreeStd = script('chk-agree-std.sh', [
        'i=$(cat "$1"); o=$(cat "$2"); a=$(cat "$3");',
        'if [ -n "$i" ] && [ "$i" = "$o" ] && [ "$i" = "$a" ]; then exit 0; fi',
        `printf 'mismatch in=[%s] out=[%s] ans=[%s]\\n' "$i" "$o" "$a" >> ${LOG}`,
        'exit 1'
    ].join('\n'));
    const parStd = await runEngine(spj(agreeStd, { generator: uniqGen, stdExe: echo, testExe: echo, totalTests: 8, threadCount: 4 }));
    check('4 worker 并发跑 SPJ（双进程路径 + 正解当基准）：8 组全部通过',
        parStd.progress === 8 && parStd.errors.length === 0,
        JSON.stringify({ progress: parStd.progress, errors: parStd.errors.slice(0, 2) }));

    // ---- 5. 每组用完就删：不留 oicpp_spj_* 残骸 ----
    const strays = fs.readdirSync(TMP).filter(f => f.indexOf('oicpp_spj_') === 0);
    check('跑完后对拍目录里没有残留的 checker 临时文件',
        strays.length === 0, JSON.stringify(strays));

    // ---- 6. checker 自己卡住要报 checker 超时，不是被测程序的 TLE ----
    const slow = script('chk-slow.sh', 'sleep 3; exit 0');
    const tle = await runEngine(spj(slow, { timeLimit: 400 }));
    check('checker 超时 → spj_tle/spj_timeout（与 *_tle 区分开，锅不在被测程序）',
        tle.errors.length === 1 && tle.errors[0].type === 'spj_tle' && tle.errors[0].code === 'spj_timeout',
        JSON.stringify(tle.errors));

    // ---- 7. 旧引擎（freopen 回退路径）与引擎侧口径一致：没正解也能判 ----
    // 三个方法与那条正解判据都从 codeComparer 的产物源码里抽出来真跑，不在测试里
    // 重抄一份 —— 重抄的那份不会随源文改动而变红，正是「注释声称一致、实际早已漂移」。
    const comparerSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'sidebar', 'codeComparer.js'), 'utf8');
    // 类方法在产物里固定 4 空格缩进、闭合花括号也独占一行 4 空格。收口只认这一种缩进，
    // 用 \s* 会提前停在内层的 `};` 上，抽出来半个函数体。
    const methodOf = (name) => {
        const m = new RegExp('\\n    ' + name + '\\s*\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n    \\}').exec(comparerSrc);
        return m ? { args: m[1], body: m[2] } : null;
    };
    const toFn = (m) => (m ? new Function(m.args, m.body) : null);
    const api = {
        isSpjActive: toFn(methodOf('isSpjActive')),
        requiresStandardProgram: toFn(methodOf('requiresStandardProgram')),
        notRunProgramOutput: toFn(methodOf('notRunProgramOutput'))
    };
    const guardCond = /if \((stdOutput\.outputLimitExceeded[^)]*)\)/.exec(comparerSrc);
    const stdFails = guardCond ? new Function('stdOutput', 'return !!(' + guardCond[1] + ');') : null;

    check('三个方法、「正解是否出错」那条判据都从 codeComparer 抽到了',
        !!(api.isSpjActive && api.requiresStandardProgram && api.notRunProgramOutput && stdFails),
        JSON.stringify({ isSpj: !!api.isSpjActive, requires: !!api.requiresStandardProgram, notRun: !!api.notRunProgramOutput, guard: !!stdFails }));

    const spjTask = (cfg) => ({ config: cfg });
    check('旧引擎同样不再要求正解：SPJ + freopen 时 requiresStandardProgram 为假',
        api.requiresStandardProgram.call(api, spjTask({ useTestlib: true, spjPath: 'spj.cpp', freopenInputFile: 'a.in', freopenOutputFile: 'a.out' })) === false,
        JSON.stringify(api.requiresStandardProgram.call(api, spjTask({ useTestlib: true, spjPath: 'spj.cpp', freopenInputFile: 'a.in' }))));
    check('没 checker 时正解仍然必填（文本判等没有别的基准）',
        api.requiresStandardProgram.call(api, spjTask({ useTestlib: false, spjPath: '', freopenInputFile: 'a.in' })) === true,
        JSON.stringify(api.requiresStandardProgram.call(api, spjTask({ useTestlib: true, spjPath: '', freopenInputFile: 'a.in' }))));

    // 占位结果必须骗不过那条真实判据：一旦触发，没填正解的 freopen+SPJ 对拍会把
    // 每一组都报成「正解失败」，而真实原因只是用户压根没打算跑正解。
    const placeholder = api.notRunProgramOutput.call(api);
    check('占位的正解结果不触发旧引擎任何一条正解失败判据',
        stdFails(placeholder) === false && placeholder.output === '' && placeholder.exitCode === 0,
        JSON.stringify({ trips: stdFails(placeholder), placeholder: placeholder }));
    check('占位结果的空输出正是 checker 的 answer（空文件，不是缺文件）',
        typeof placeholder.output === 'string' && placeholder.output.length === 0,
        JSON.stringify(placeholder.output));

    if (ran === 0) { console.log('[FAIL] 一条断言都没跑'); failures++; }
    cleanup();
    console.log(`\n${ran} 条断言，${failures} 失败`);
    process.exit(failures ? 1 : 0);
})().catch(e => { cleanup(); console.log('[FAIL] 守卫自身异常: ' + ((e && e.stack) || e)); process.exit(1); });
