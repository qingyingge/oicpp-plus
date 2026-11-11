'use strict';
/**
 * instant-scenario.js — 把被测程序压到 <1ms，看一轮里的时间到底在哪
 *
 * 常规场景（Sort/Graph/Range）里一轮 0.6~2.7s，其中 95%+ 是用户程序自己的计算，
 * 引擎的开销埋在噪声里量不出来。反过来，让三个程序都只活 <1ms（静态二进制、
 * 一次 write、立刻 exit），一轮里的时间就只剩两块可解释的东西：
 *
 *   1. 进程创建本身（posix_spawn + 管道 + 收割），这是「对拍每轮得起 3~4 个进程」
 *      的定义成本，不是实现缺陷；
 *   2. 引擎自己干的活（JS 循环、结果对象、napi 往返、postMessage）。
 *
 * 分账不用改生产代码：worker 本来就逐组回报 genMs / stdMs / testMs，于是
 *
 *     每轮未归因开销 = 外层墙钟 − (genMs + pairMs)
 *
 * 用法：
 *   node benchmark/instant-scenario.js [--threads 1] [--tests 300] [--reps 5]
 *
 * 读法：最后一行的「引擎自身/一次 spawn」是可信指标 —— 它把机器速度约掉了，
 * 而绝对 ms 在不同机器上差一个数量级。引擎自身不该比多起一个进程还贵。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Worker } = require('worker_threads');

const ROOT = path.resolve(__dirname, '..');
const arg = (name, def) => {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const THREADS = Number(arg('threads', 1));
const TESTS = Number(arg('tests', 300));
const REPS = Number(arg('reps', 5));

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-instant-'));
const cleanup = () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch (_) { } };
process.on('exit', cleanup);

const compile = (name, body) => {
    const src = path.join(T, name + '.c');
    const exe = path.join(T, name);
    fs.writeFileSync(src, body);
    const r = spawnSync('g++', ['-O2', '-static', '-o', exe, src], { cwd: T });
    if (r.status !== 0) {
        console.log('[SKIP] 编不出静态小程序（需要 g++）: ' + String(r.stderr || '').slice(0, 160));
        process.exit(0);
    }
    return exe;
};

// 三个程序都只活 <1ms：一次 write，立刻 exit。数据量刻意压到几字节，
// 这样「搬运」那一块也不参与，剩下的时间才只有进程创建 + 引擎自己。
const GEN = compile('gen_instant', '#include <unistd.h>\nint main(){ static const char s[]="1 2\\n"; write(1,s,4); return 0; }\n');
const STD = compile('std_instant', '#include <unistd.h>\nint main(){ static const char s[]="3\\n"; write(1,s,2); return 0; }\n');
const CUR = compile('cur_instant', '#include <unistd.h>\nint main(){ static const char s[]="3\\n"; write(1,s,2); return 0; }\n');
const TRUE = compile('noop', 'int main(){ return 0; }\n');

// ---- 0. 先证明程序本身确实 <1ms（否则后面所有分账都是拿用户计算当引擎开销）----
const fast = require(path.join(ROOT, 'fastspawn.node'));
const timeRun = (prog, n) => {
    for (let i = 0; i < 10; i++) fast.run(prog, null, 20000);
    const t = Date.now();
    for (let i = 0; i < n; i++) fast.run(prog, null, 20000);
    return (Date.now() - t) / n;
};
const noopMs = timeRun(TRUE, 60);
const stdMs = timeRun(STD, 60);
const printMs = stdMs - noopMs;
console.log(`单次 spawn+一次 write：${stdMs.toFixed(2)}ms   其中「空转就退出」${noopMs.toFixed(2)}ms，`
    + `程序自己那一次 write ≈ ${printMs.toFixed(2)}ms`);
if (stdMs > 1) {
    console.log(`[提示] 本机一次 spawn 就要 ${stdMs.toFixed(1)}ms —— 绝对值不可与其他机器比较，`
        + `只看最后的比值。`);
}

// ---- 1. 引擎一轮：gen(child_process) + pair(native) + 判定 + post ----
function engineRound(checker) {
    return new Promise((resolve, reject) => {
        const per = Math.ceil(TESTS / THREADS);
        const worker = path.join(ROOT, 'src', 'main-process', 'compare-worker.js');
        const t0 = Date.now();
        let got = 0, genAcc = 0, pairAcc = 0, doneCount = 0;
        const ws = [];
        for (let i = 0; i < THREADS; i++) {
            const start = i * per + 1;
            const count = Math.min(per, TESTS - start + 1);
            if (count <= 0) continue;
            const w = new Worker(worker);
            w.on('message', (m) => {
                if (m.type === 'progress') { got++; genAcc += m.genMs || 0; pairAcc += m.testMs || 0; }
                else if (m.type === 'error') { got++; }
                else if (m.type === 'done') {
                    ws.push(w);
                    if (ws.length === Math.min(THREADS, Math.ceil(TESTS / per))) {
                        const wall = Date.now() - t0;
                        for (const x of ws) x.terminate();
                        resolve({ wall, rounds: got, genSum: genAcc, pairSum: pairAcc });
                    }
                }
            });
            w.on('error', reject);
            w.postMessage({
                type: 'run-tests', startIdx: start, count,
                gen: GEN, stdPath: STD, testPath: CUR,
                timeout: 2000, generatorTimeout: 2000,
                spjPath: checker || '', useTestlib: !!checker, freopen: null
            });
        }
    });
}

(async () => {
    const acc = [];
    for (let r = 0; r < REPS; r++) acc.push(await engineRound());
    acc.sort((a, b) => (a.wall / a.rounds) - (b.wall / b.rounds));
    const mid = acc[Math.floor(acc.length / 2)];
    const perRoundWall = mid.wall / mid.rounds * THREADS;
    const perRoundGen = mid.genSum / mid.rounds;
    const perRoundPair = mid.pairSum / mid.rounds;
    const unattributed = perRoundWall - perRoundGen - perRoundPair;

    // 一次 native spawn 的成本，作为「值不值」的尺子
    const oneSpawn = stdMs;

    console.log(`\n每轮分账（${THREADS} 线程 × ${TESTS} 组，${REPS} 轮取中位）`);
    console.log(`  墙钟/轮                 ${perRoundWall.toFixed(2)}ms`);
    console.log(`  ├ 生成器（native 异步）     ${perRoundGen.toFixed(2)}ms`);
    console.log(`  ├ 被测对（native pair）   ${perRoundPair.toFixed(2)}ms`);
    console.log(`  └ 未归因（JS 循环/对象/post） ${unattributed.toFixed(2)}ms  = ${(unattributed / perRoundWall * 100).toFixed(1)}%`);
    console.log(`  生成器走 native 的话大概能省（同一次 spawn 的成本差）: 见 instant vs child_process 对比`);

    // 生成器那一腿现在走 native 异步，所以这一行量的是「异步版还有多少可省」，
    // 而不再是一次否决理由：曾经这里是 child_process 32.4 vs native 10.9，
    // 接上异步 native 之后实测一轮 51.8ms → 32.4ms（1.60×，threads=1）。
    const cpCost = await (async () => {
        const cp = require('child_process');
        const one = () => new Promise((res) => {
            const p = cp.spawn(GEN, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true });
            let n = 0;
            p.stdout.on('data', d => { n += d.length; });
            p.stdin.end();
            p.on('close', () => res(n));
        });
        for (let i = 0; i < 8; i++) await one();
        const t = Date.now();
        for (let i = 0; i < 40; i++) await one();
        return (Date.now() - t) / 40;
    })();
    const nativeGen = stdMs;
    console.log(`\n  生成器那一腿：child_process ${cpCost.toFixed(2)}ms vs native ${nativeGen.toFixed(2)}ms`
        + `（差 ${(cpCost - nativeGen).toFixed(2)}ms/轮 —— 已走异步 native；同步版被否决是因为`
        + ` 'stop' 进不去，异步版两边都要）`);

    // ---- SPJ：再加一个 checker 进程，量它那一腿 ----
    // checker 只吃文件，所以这一腿 = 1 次进程创建 + 每轮 3 次写盘（临时文件按分片固定，
    // 收尾才删，不在热路径上）。拿它和「一次 spawn」比，就能看出落盘那一块到底有没有代价。
    const CHK = compile('chk_instant', '#include <unistd.h>\nint main(){ static const char s[]="ok 1 token\\n"; write(1,s,11); return 0; }\n');
    let spj = { wall: 0, rounds: 0, genSum: 0, pairSum: 0 };
    if (Number(arg('spj', 1)) === 1) {
        const accSpj = [];
        for (let r = 0; r < REPS; r++) accSpj.push(await engineRound(CHK));
        accSpj.sort((a, b) => (a.wall / a.rounds) - (b.wall / b.rounds));
        spj = accSpj[Math.floor(accSpj.length / 2)];
        const spjPerRound = spj.wall / spj.rounds * THREADS;
        const checkerLeg = spjPerRound - perRoundWall;
        console.log(`\nSPJ 同一条管线（三个被测程序都不到 1ms，checker 是立即退出的静态二进制）`);
        console.log(`  墙钟/轮                 ${spjPerRound.toFixed(2)}ms`);
        console.log(`  ├ checker 那一腿        ${checkerLeg.toFixed(2)}ms  = 一次进程创建的 ${(checkerLeg / oneSpawn).toFixed(2)}×`);
        console.log(`  └ 相对无 SPJ            ${(spjPerRound / perRoundWall).toFixed(3)}×`);
        if (spj.rounds !== TESTS) {
            console.log(`  [警告] SPJ 只跑完 ${spj.rounds}/${TESTS} 组，读数不可信（checker 应当判全部通过）`);
        }
    }

    const ratio = unattributed / oneSpawn;
    console.log(`\n  可信指标 —— 引擎自身每轮开销 / 一次进程创建成本 = ${ratio.toFixed(3)}`);
    console.log(`  （比值把机器速度约掉了：绝对 ms 在不同机器上差一个数量级）`);
    process.exit(0);
})().catch(e => { console.log('[FAIL] ' + ((e && e.stack) || e)); process.exit(1); });
