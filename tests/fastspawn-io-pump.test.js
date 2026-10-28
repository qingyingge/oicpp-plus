'use strict';

/**
 * fastspawn 原生层的**行为**守卫（不是读源码比正则）。
 *
 * 覆盖两类曾经真实出问题、且只能真跑才能发现的问题：
 *
 *  A. stdin 写入循环误杀健康子进程。判错写成
 *         if (wr <= 0 && errno != EINTR) kill(-pid, SIGKILL);
 *     而 poll() 超时返回 0 **且不改动 errno**，errno 仍是上一步 write 留下的
 *     EAGAIN —— 于是「子进程还没来得及读」被当成错误。触发门槛只是输入大于管道
 *     缓冲，也就是任何真实规模的生成数据；被杀后收割状态折算成 128+9=137，
 *     对拍里表现为 std_re「standard program exit 137」。
 *     实测修复前：单次 run(range_bit, 3.5MB, 20000ms) 在 139ms 就被杀。
 *
 *  B. 「先把 stdin 全写完，再 drain 输出」的两段式写法会死锁：边读边写的程序
 *     把输出管道写满后停住不再读输入，而我们还堵在写输入上、没开始收它的输出。
 *
 * 另外锁住 C 层判等归一化器与 JS normalizeOutput 的逐条等价 —— 它写错会把 AC
 * 判成 WA 且毫无痕迹，是本项目最坏的失效模式。
 *
 * 用法：node tests/fastspawn-io-pump.test.js
 * win32（不构建 .node）或构建产物缺失时跳过，不判 FAIL。
 */

const fs = require('fs');
const path = require('path');

// 挂死不等于通过：某个同步调用卡住时进程可能一直不退出，也可能事件循环排空后
// 以 0 退出码收尾而后半截断言一条不发。留一个不 unref 的定时器顶成失败。
setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：某个 native 同步调用没有返回');
    process.exit(1);
}, 60000);

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

let failures = 0;
let skipped = 0;
let ran = 0;
const check = (name, cond, extra = '') => {
    ran++;
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};
const skip = (name, why) => {
    skipped++;
    console.log(`[SKIP] ${name} | ${why}`);
};

// ---------------------------------------------------------------------------
// 前置：原生模块只在 POSIX 上构建
// ---------------------------------------------------------------------------
if (process.platform === 'win32') {
    skip('fastspawn 原生层行为守卫', 'win32 不构建 .node（scripts/build-fastspawn.js 直接跳过），回退路径由 worker 侧守卫覆盖');
    process.exit(0);
}

const NODE_PATH = path.join(ROOT, 'fastspawn.node');
if (!fs.existsSync(NODE_PATH)) {
    skip('fastspawn 原生层行为守卫', `${NODE_PATH} 不存在 —— 需要先跑 pnpm run prebuild:native`);
    process.exit(0);
}

let fast;
try {
    fast = require(NODE_PATH);
} catch (e) {
    skip('fastspawn 原生层行为守卫', `.node 加载失败：${e.message}`);
    process.exit(0);
}
if (typeof fast.runPair !== 'function' || typeof fast.normalizeCompare !== 'function') {
    skip('fastspawn 原生层行为守卫', 'fastspawn.node 过旧：缺 runPair/normalizeCompare，请重新 pnpm run prebuild:native');
    process.exit(0);
}

// 临时脚本目录：这些子进程只用来构造「读得不快 / 不读 / 狂写 stderr」这几种形状
const TMP = path.join(ROOT, 'benchmark', 'logs', '_fastspawn-tmp');
fs.mkdirSync(TMP, { recursive: true });
function script(name, body) {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n');
    fs.chmodSync(p, 0o755);
    return p;
}

// 输入必须大于管道容量（Linux 默认 64KB，本模块会尝试放大到 1MB）。
// 取 2MB：两种容量下都能真实触发 EAGAIN 分支。
const BIG = Buffer.alloc(2 * 1024 * 1024);
for (let i = 0; i < BIG.length; i++) BIG[i] = 48 + (i % 10); // 全是可打印 ASCII 数字

const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* 尽力 */ } };

// ---------------------------------------------------------------------------
// A/B 组：大输入下的进程管理
// ---------------------------------------------------------------------------
{
    // cat 会把输入原样吐出来：输出规模 ≥ 输入规模，两段式写法在这里必然死锁，
    // 误杀 bug 也在这里必然触发（写第一笔就 EAGAIN）。
    const t0 = Date.now();
    const r = fast.run('/bin/cat', BIG, 20000);
    check('cat 回读 2MB：退出码 0（既没被误杀成 137，也没因死锁被判超时）',
        r.code === 0, `code=${r.code} (0=ok, -3=TLE, 137=被 SIGKILL) ms=${Date.now() - t0}`);
    check('cat 回读 2MB：输出与输入逐字节相同（stdin 未被静默截断）',
        !!r.output && r.output.length === BIG.length && r.output.equals(BIG),
        `in=${BIG.length} out=${r.output ? r.output.length : 'null'}`);
}
{
    // 子进程根本不读 stdin，截止时间必定落在「写输入」的过程中。
    // 这正是原先被 SIGKILL 后折算成 137 的那个时机 —— 现在必须是 TLE。
    const sleeper = script('sleeper.sh', 'sleep 5');
    const t0 = Date.now();
    const r = fast.run(sleeper, BIG, 400);
    check('截止时间落在写 stdin 期间时判超时(-3)，而不是被杀后的 137',
        r.code === -3, `code=${r.code} ms=${Date.now() - t0}`);
    check('该判定不拖到 sleep 自然结束（超时后立即收割）',
        Date.now() - t0 < 2500, `${Date.now() - t0}ms`);
}
{
    // 提前退出且不再读输入：拿到的必须是程序自己的退出码，而不是 -2 / 137。
    const early = script('early.sh', 'exit 7');
    const r = fast.run(early, BIG, 20000);
    check('程序不读输入就退出时，报它自己的退出码而不是误杀',
        r.code === 7, `code=${r.code}`);
}
{
    // stderr 曾被 runOne 直接 free 掉，RE 只剩一个「exit 139」而无从展示原因
    const noisy = script('noisy.sh', 'cat >/dev/null; echo "ASan: heap-buffer-overflow" >&2; exit 3');
    const r = fast.run(noisy, BIG, 20000);
    check('stderr 回传，退出码同时保留（原生路径曾经看不到 stderr）',
        r.code === 3 && /heap-buffer-overflow/.test(r.stderr.toString()),
        `code=${r.code} stderr=${JSON.stringify(r.stderr.toString().slice(0, 40))}`);
}
{
    // output_limit 只看 stdout。一个正常退出但狂写日志的程序不该被判输出超限。
    const bigerr = script('bigerr.sh', 'cat >/dev/null; i=0; while [ $i -lt 4000 ]; do echo "log line $i aaaaaaaaaa" >&2; i=$((i+1)); done; exit 0');
    const r = fast.run(bigerr, BIG, 60000);
    const errKB = Math.round(r.stderr.length / 1024);
    check('大 stderr 不再触发 output_limit（truncated 只反映 stdout）',
        r.code === 0 && r.truncated === false,
        `code=${r.code} stdout截断=${r.truncated} stderr捕获=${errKB}KB errTruncated=${r.errTruncated}`);
    check('stderr 有独立上限，只留前缀而不是整段',
        r.stderr.length <= 64 * 1024 + 1, `stderr=${errKB}KB`);
}

// ---------------------------------------------------------------------------
// C 组：runPair 的原生判等
// ---------------------------------------------------------------------------
{
    // 两个都读完输入、但答案不同的程序 —— 对拍里 std/test 的真实形状
    const progA = script('progA.sh', 'cat >/dev/null; echo "ans=1"');
    const progB = script('progB.sh', 'cat >/dev/null; echo "ans=2"');
    const same = fast.runPair(progA, progA, BIG, 20000, true);
    check('runPair(compare) 两程序答案一致时判相等',
        same.code1 === 0 && same.code2 === 0 && same.normEqual === 1,
        `codes=${same.code1}/${same.code2} normEqual=${same.normEqual}`);
    // 相等时不回传两段输出：这是本次最大的单项收益（省掉 MB 级跨边界拷贝 + JS 归一化）
    check('判相等时不回传 out1/out2（省掉跨边界拷贝）',
        same.out1 && same.out1.length === 0 && same.out2 && same.out2.length === 0,
        `len=${same.out1 && same.out1.length}/${same.out2 && same.out2.length}`);

    const diff = fast.runPair(progA, progB, BIG, 20000, true);
    check('runPair(compare) 两程序答案不同时判不等',
        diff.code1 === 0 && diff.code2 === 0 && diff.normEqual === 0,
        `normEqual=${diff.normEqual}`);
    // 不等时 diff 视图要看原文，所以必须把两段都带回来
    check('判不等时回传两段输出供 diff 视图展示',
        /ans=1/.test(diff.out1 ? diff.out1.toString() : '') && /ans=2/.test(diff.out2 ? diff.out2.toString() : ''),
        `${JSON.stringify(diff.out1 && diff.out1.toString())} vs ${JSON.stringify(diff.out2 && diff.out2.toString())}`);

    // 行尾空白 / CRLF 差异必须判等，否则用户会被假 WA 淹没
    const progTrail = script('progTrail.sh', 'cat >/dev/null; printf "ans=1 \\r\\n"');
    const trailPair = fast.runPair(progA, progTrail, BIG, 20000, true);
    check('行尾空格与 CRLF 差异在 C 层仍然判等（与 JS 归一化同语义）',
        trailPair.normEqual === 1,
        `normEqual=${trailPair.normEqual} a=${JSON.stringify(trailPair.out1 && trailPair.out1.toString())}`);
}

// ---------------------------------------------------------------------------
// D 组：C 归一化器与 JS normalizeOutput 逐条等价（假 WA 的最后一道闸）
// ---------------------------------------------------------------------------
{
    // 参照物直接从生产 worker 源码里抽出来跑，不在测试里重抄一份 ——
    // 重抄的那份会跟着源码漂移，然后两边都「对」。
    const { funcDecl, toFn } = require('./fixtures/source-extract');
    const workerSrc = fs.readFileSync(path.join(ROOT, 'src', 'main-process', 'compare-worker-v6.js'), 'utf8');
    const normalizeOutput = toFn(funcDecl(workerSrc, 'normalizeOutput'));
    check('能从 worker 源码抽出真实 normalizeOutput 作为参照物',
        typeof normalizeOutput === 'function',
        typeof normalizeOutput);
    if (typeof normalizeOutput !== 'function') {
        finish();
    }

    const CASES = [
        ['', ''], ['a', 'a'], ['a\n', 'a'], ['\n', ''], ['   ', ''],
        ['a\nb  ', 'a\nb'], ['a\r', 'a\r'], ['a\r\n', 'a'], ['a\r\r\n', 'a\r'],
        ['\n\na', '\n\na'], ['a\n\n\n', 'a'], ['a \t \nb\t', 'a\nb'],
        ['\r\n\r\na', '\n\na'], ['a\n\nb', 'a\n\nb'], ['\r', '\r'], ['\r\r', '\r\r'],
        ['x \n y \n', 'x\ny'], ['a\r\n\r\nb\r\n', 'a\n\nb'], ['a\n\r', 'a\n\r'],
        ['1 2\n', '1 2\n'], ['a\tb\n', 'a\tb\n'], ['\t\n', '']
    ];
    let normBad = 0;
    for (const [s] of CASES) {
        const got = fast.normalizeCompare(Buffer.from(s, 'utf8'), Buffer.from('', 'utf8'));
        const want = normalizeOutput(s);
        if (got.a.toString('utf8') !== want) {
            normBad++;
            if (normBad <= 3) console.log('       差异: ' + JSON.stringify(s) + ' C=' + JSON.stringify(got.a.toString()) + ' JS=' + JSON.stringify(want));
        }
    }
    check('C 归一化结果与 JS normalizeOutput 逐条相同（手写边界用例）',
        normBad === 0, `${CASES.length} 条中 ${normBad} 条不一致`);

    // 定种子 fuzz：字母表专门挑 \r / \n / 空格 / 制表符的组合，
    // 这三个的交互正是归一化最容易写错的地方。
    let seed = 20261028;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const ALPHA = ['a', 'b', '\n', '\r', ' ', '\t', '\r\n', '\n\n', ' \n', '\t ', '\r\r\n', 'a\r\n', '  \t\n'];
    let fuzzBad = 0, eqCount = 0, neCount = 0;
    for (let i = 0; i < 4000; i++) {
        const mk = () => { let s = ''; const n = Math.floor(rnd() * 8); for (let j = 0; j < n; j++) s += ALPHA[Math.floor(rnd() * ALPHA.length)]; return s; };
        const x = mk();
        const y = rnd() < 0.5 ? x : x + mk();
        const r = fast.normalizeCompare(Buffer.from(x), Buffer.from(y));
        const ja = normalizeOutput(x), jb = normalizeOutput(y);
        // 非 ASCII 必须不裁（真实数据都是 ASCII，但这是唯一防住「字节不同而解码相同」的闸）
        const wantVerdict = (r.high1 || r.high2) ? -1 : (ja === jb ? 1 : 0);
        if (r.a.toString('utf8') !== ja || r.b.toString('utf8') !== jb || r.verdict !== wantVerdict) {
            fuzzBad++;
            if (fuzzBad <= 3) console.log('       fuzz 差异: ' + JSON.stringify([x, y]) + ' C=' + JSON.stringify([r.a.toString(), r.b.toString(), r.verdict]) + ' JS=' + JSON.stringify([ja, jb, wantVerdict]));
        }
        if (wantVerdict === 1) eqCount++; else neCount++;
    }
    check('C 归一化 + 判等与 JS 完全一致（4000 条定种子 fuzz）',
        fuzzBad === 0, `不一致 ${fuzzBad}，判等 ${eqCount} 条 / 判不等 ${neCount} 条`);

    // 非 ASCII 分歧：存在「字节不同但 UTF-8 解码相同」的输入，JS 判相等。
    // C 若在这里自己下结论就会造出假 WA，所以必须回 -1 交给 JS。
    const nonAscii = fast.normalizeCompare(Buffer.from([0xc3, 0x28, 0x6c, 0x6f]), Buffer.from([0xff, 0x28, 0x6c, 0x6f]));
    check('出现非 ASCII 字节时 C 层不下判等结论（交回 outputsEqual 终裁）',
        nonAscii.verdict === -1 && nonAscii.high1 === true,
        `verdict=${nonAscii.verdict} high1=${nonAscii.high1}`);
}

finish();

function finish() {
    cleanup();
    console.log(`\n${ran} 条断言，${failures} 失败，${skipped} 跳过`);
    if (ran === 0 && skipped === 0) {
        console.log('[FAIL] 一条断言都没跑：守卫失效');
        failures++;
    }
    process.exit(failures ? 1 : 0);
}
