'use strict';
/**
 * v18-sharding.js — 静态分片 vs 动态领取，用真实异质负载实测
 *
 * 设计阶段对「动态工作队列」的纸面结论是 0%：基准生成器的耗时变异系数只有 0.059，
 * 均匀负载下 list scheduling 与 ceil() 静态分片的 makespan 相同。纸面结论不能当实测
 * 结论用，所以这里换成**双峰异质**负载（gen_mixed：每组 5k 或 120k-190k 个数字，
 * 规模 cv≈0.86）真跑一遍，并诚实计入动态方案必须付的 IPC 代价 —— 动态领取是每组一次
 * postMessage 往返，静态分片整轮只在启动时发一次。
 *
 * ⚠ 夹具必须先自校验。第一版把 n 放到 400k，而实测 sort_mergesort 在 n>=250000 时
 *   堆破坏崩溃（它的输出 md5 正好是空输入的那个），于是「失败」是夹具造出来的，不是
 *   策略差异 —— 拿那种数据比出来的方向是反的。所以现在任何一轮出现失败就整轮作废。
 *
 * 用法：node benchmark/v18-sharding.js --cpus 0-3 --threads 4 --tests 20 --reps 4
 */
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');

const ROOT = path.resolve(__dirname, '..');
const PROGS = path.join(ROOT, 'compare-benchmark', 'progs');
const MIXED = path.join(ROOT, 'benchmark', 'fixtures', 'gen_mixed');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CPUS = flag('cpus', '0-3');
const T = parseInt(flag('threads', '4'), 10);
const N = parseInt(flag('tests', '20'), 10);
const REPS = parseInt(flag('reps', '4'), 10);
const WORKER = path.resolve(ROOT, flag('worker', 'src/main-process/compare-worker-v6.js'));

if (!fs.existsSync(MIXED)) {
    console.error('缺少夹具：gcc -O2 -o benchmark/fixtures/gen_mixed benchmark/fixtures/gen_mixed.c');
    process.exit(2);
}
console.log('V18 分片策略对照  cpus=' + CPUS + ' threads=' + T + ' tests=' + N + ' reps=' + REPS + ' worker=' + path.basename(WORKER));

const hard = setTimeout(() => { console.log('[FAIL] 整体超时未收束'); process.exit(1); }, 30 * 60 * 1000);
hard.unref();

function msg(start, count) {
    return {
        type: 'run-tests', startIdx: start, count,
        gen: MIXED, stdPath: path.join(PROGS, 'sort_std'), testPath: path.join(PROGS, 'sort_mergesort'),
        timeout: 30000, generatorTimeout: 30000
    };
}

// policy 'static'  = 每 worker 一片 ceil(N/T)，一次发完（与 compare-engine-v2 的分片一致）
// policy 'dynamic' = 每 worker 每次只领 1 组，跑完再领（list scheduling）
function run(policy) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const durations = [];
        let next = 1, doneCount = 0, failures = 0, settled = false;
        const workers = [];
        const settle = () => {
            if (settled) return;
            settled = true;
            clearInterval(poll); clearTimeout(cap);
            workers.forEach(w => { try { w.terminate(); } catch (_) { /* 已退出 */ } });
            resolve({ wall: Date.now() - t0, durations: durations.slice(), failures });
        };
        const spin = (w) => {
            if (next > N) return;
            const idx = next++;
            w.__t0 = Date.now();
            w.postMessage(msg(idx, 1));
        };
        for (let i = 0; i < T; i++) {
            const w = new Worker(WORKER);
            w.on('message', (m) => {
                if (m.type === 'progress') durations.push(Date.now() - w.__t0);
                else if (m.type === 'error') { durations.push(Date.now() - w.__t0); failures++; }
                else if (m.type === 'done') { doneCount++; if (policy === 'dynamic') spin(w); }
            });
            w.on('error', () => { failures++; });
            workers.push(w);
        }
        const per = Math.ceil(N / T);
        let launched = 0;
        if (policy === 'static') {
            workers.forEach((w, i) => {
                const start = i * per + 1;
                const count = Math.min(per, N - start + 1);
                if (count <= 0) return;
                launched++;
                w.__t0 = Date.now();
                w.postMessage(msg(start, count));
            });
        } else {
            workers.forEach(w => { spin(w); launched++; });
        }
        const need = policy === 'static' ? launched : N;
        const poll = setInterval(() => { if (doneCount >= need) settle(); }, 40);
        const cap = setTimeout(settle, 8 * 60 * 1000);
    });
}

const med = a => { const v = a.slice().sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : 0; };
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const cvOf = a => { const m = mean(a); return m ? Math.sqrt(mean(a.map(x => (x - m) ** 2))) / m : 0; };

(async () => {
    const runs = [], allDur = [];
    for (let r = 1; r <= REPS; r++) {
        // 顺序在偶数轮反转，避免「总排后面那个」系统性吃亏
        const order = r % 2 === 0 ? ['dynamic', 'static'] : ['static', 'dynamic'];
        for (const policy of order) {
            const res = await run(policy);
            allDur.push(...res.durations);
            const invalid = res.failures > 0;
            runs.push({ policy, rep: r, invalid, wall: res.wall, failures: res.failures, durations: res.durations });
            console.log('  rep' + r + ' ' + policy.padEnd(8) + ' wall=' + res.wall + 'ms  组=' +
                res.durations.length + '/' + N + '  失败=' + res.failures +
                '  中位=' + med(res.durations) + 'ms' + (invalid ? '   【作废】' : ''));
            await new Promise(z => setTimeout(z, 250));
        }
    }
    const dropped = runs.filter(x => x.invalid).length;
    if (dropped) console.log('\n注意：' + dropped + '/' + runs.length + ' 轮因出现失败被作废（失败组提前结束会让 wall 虚低，不可比）');
    console.log('夹具实际耗时 cv = ' + cvOf(allDur).toFixed(3) + '（基准生成器为 0.059）');

    const byP = {};
    for (const x of runs.filter(v => !v.invalid)) (byP[x.policy] = byP[x.policy] || []).push(x.wall);
    const ss = byP.static || [], dd = byP.dynamic || [];
    if (!ss.length || !dd.length) { console.log('\n有效轮次不足，无法下结论'); process.exit(1); }
    const ms = med(ss), md = med(dd), ratio = md / ms;
    console.log('\n== 结论 ==');
    console.log('  static   makespan 中位 = ' + ms + 'ms   样本 ' + ss.join(', '));
    console.log('  dynamic  makespan 中位 = ' + md + 'ms   样本 ' + dd.join(', '));
    console.log('  dynamic/static = ' + ratio.toFixed(3) +
        (ratio > 1.03 ? '   → 动态更慢：每组一次 IPC 往返的代价超过负载均衡的收益'
            : ratio < 0.97 ? '   → 动态确实更快，值得采纳'
                : '   → 无差别（3% 噪声带内）'));
    clearTimeout(hard);
    process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
