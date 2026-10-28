'use strict';

/**
 * 对拍的时限锚点守卫（V16 的产物）。
 *
 * 实验十一之后的一轮设计探索里，「让 std/test 在生成器还没跑完时就开始算」被提出过：
 * 实测每组墙钟 Range −32% / Sort −40% / Graph −36%，看着很香。它不可实现，原因是
 * **时限与投递时刻互相不可兼得**，两个方向都会出错，且都错得无声：
 *
 *   锚在 spawn  →  子进程被算上了生成器的那段时间。只要 timeout < 投递完成的墙钟时间，
 *                  两个都正确的程序会被判成 std_tle / test_tle。（实测：投递耗时 1073ms、
 *                  时限 1000ms 时返回 0/137/137，而两个程序本身都只需要 157-195ms。）
 *   锚在输入投递完成  →  子进程白拿「投递前它自己在空转的那段 CPU」。只要这段空转超过
 *                  时限余额，错误答案也能带着正确输出跑完。（实测：range_bit/range_segtree
 *                  需要 787/911ms CPU，时限 500ms，融合版返回 0/0/0 且答案全对 = 假 AC。）
 *
 * 唯一与 V11 语义等价的策略就是「生成器退出之前一个字节都不许投」，于是那 −32% 整个消失。
 * 本文件把这条策略钉成行为断言：生成器慢、std/test 快且答案正确、时限短于生成器耗时时，
 * 必须判通过；一旦有人改成提前投递，这里就会红。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：引擎没有发出 complete');
    process.exit(1);
}, 60000);

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

// 被测形状需要 shell 脚本，win32 上没有 sh
if (process.platform === 'win32') {
    skip('对拍时限锚点守卫', 'win32 没有 sh；该不变式由 compare-worker 的结构守卫覆盖');
    process.exit(0);
}

const TMP = path.join(ROOT, 'benchmark', 'logs', '_anchor-tmp');
fs.mkdirSync(TMP, { recursive: true });
const script = (name, body) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n');
    fs.chmodSync(p, 0o755);
    return p;
};

// 生成器耗时 2.2s；std/test 各自只要几十 ms，且答案一致。
// 时限设 800ms < 生成器耗时，所以「提前投递」必然把 std/test 打死在生成器窗口里。
const GEN_SLOW = script('slowgen.sh', 'sleep 2.2; echo 42');
const STD = script('answer.sh', 'cat >/dev/null; echo ans=42');
const TEST_SAME = script('answer2.sh', 'cat >/dev/null; echo ans=42');
// 故意不同的一份，用来验证反方向没被做坏（时限宽松时必须正常报 mismatch，不能全过）
const TEST_DIFF = script('wrong.sh', 'cat >/dev/null; echo ans=43');

const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 尽力 */ } };

const { CompareEngineV2 } = require(path.join(ROOT, 'src', 'main-process', 'compare-engine-v2.js'));

function runEngine(cfg) {
    return new Promise((resolve) => {
        const e = new CompareEngineV2();
        const ev = { progress: 0, errors: [], warnings: [] };
        e.on('progress', () => { ev.progress++; });
        e.on('error', d => ev.errors.push({ type: d.type, code: d.code, message: String(d.message || '').slice(0, 60) }));
        e.on('warning', d => ev.warnings.push(d.code));
        e.on('complete', () => resolve(ev));
        e.on('stopped', () => resolve(ev));
        e.start(Object.assign({ totalTests: 1, threadCount: 1, timeLimit: 800, generatorTimeout: 20000 }, cfg));
    });
}

(async () => {
    const t0 = Date.now();
    const ok = await runEngine({ generator: GEN_SLOW, stdExe: STD, testExe: TEST_SAME });
    const wall = Date.now() - t0;

    check('生成器慢于时限、std/test 快于时限时判通过（时限只该算子进程自己的运行）',
        ok.progress === 1 && ok.errors.length === 0,
        JSON.stringify({ progress: ok.progress, errors: ok.errors, wallMs: wall }));

    // 这一条才是本文件真正钉住的东西：一旦出现 *_tle，说明有人把投递提前了，
    // 于是子进程在替生成器等待的时间买单。
    check('没有任何 *_tle：出现即说明子进程开始替生成器的窗口付时限',
        !ok.errors.some(e => /_tle$/.test(e.type)), JSON.stringify(ok.errors));

    const bad = await runEngine({ generator: GEN_SLOW, stdExe: STD, testExe: TEST_DIFF });
    check('反方向没被做坏：答案不同时仍逐组报 mismatch（不能为了躲时限问题而全判通过）',
        bad.progress === 0 && bad.errors.length === 1 && bad.errors[0].type === 'mismatch',
        JSON.stringify(bad));

    // 真超时的样子：子进程自己不读完输入前不会结束，给一个必定超时的时限
    const spinner = script('spinner.sh', 'i=0; while [ $i -lt 200000 ]; do i=$((i+1)); done; echo x');
    const tle = await runEngine({ generator: GEN_SLOW, stdExe: spinner, testExe: spinner });
    check('子进程真超时仍然报 std_tle/std_timeout（守卫不是把时限关掉）',
        tle.errors.length === 1 && tle.errors[0].type === 'std_tle' && tle.errors[0].code === 'std_timeout',
        JSON.stringify(tle.errors[0]));

    cleanup();
    if (ran === 0) { console.log('[FAIL] 一条断言都没跑'); failures++; }
    console.log(`\n${ran} 条断言，${failures} 失败`);
    process.exit(failures ? 1 : 0);
})().catch(e => { cleanup(); console.log('[FAIL] 守卫自身异常: ' + ((e && e.stack) || e)); process.exit(1); });
