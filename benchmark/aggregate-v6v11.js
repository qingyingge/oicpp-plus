'use strict';
// 汇总 benchmark/logs/v6v11/ 下的交错 A/B，输出 V6 vs V11 对照。
// 关键：V6 的 TPS 不能直接比 —— 被误杀的那组 ~150ms 就"结束"了，
// 跑得快的原因是它根本没跑完。所以同时给「报告 TPS」「完成组数」
// 和「每个真正跑完的组的 wall 成本」三个口径。
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '..', 'benchmark', 'logs', 'v6v11');
const files = fs.readdirSync(dir).filter(f => /^rep\d+-\w+-(V6|V11)\.jsonl$/.test(f));

const by = {};   // scen -> worker -> [{wall, ok, failed, kinds, perStage}]
for (const f of files) {
    const m = /^rep(\d+)-(\w+)-(V6|V11)\.jsonl$/.exec(f);
    const [, , scen, who] = m;
    const rows = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').map(JSON.parse);
    const s = rows.find(r => r.type === 'summary');
    if (!s) continue;
    const okRows = rows.filter(r => r.ok);
    const failRows = rows.filter(r => r.scenario && !r.ok);
    const kinds = {};
    for (const r of failRows) kinds[(r.kind || '?') + ':' + String(r.message || '').slice(0, 30)] = (kinds[(r.kind || '?') + ':' + String(r.message || '').slice(0, 30)] || 0) + 1;
    const avg = (arr, k) => (arr.length ? arr.reduce((t, r) => t + (r[k] || 0), 0) / arr.length : 0);
    ((by[scen] = by[scen] || {})[who] = by[scen][who] || []).push({
        wall: s.wallMs, ok: s.ok, failed: s.failed, tps: s.tps, kinds,
        gen: avg(okRows, 'genMs'), std: avg(okRows, 'stdMs'), test: avg(okRows, 'testMs')
    });
}

const med = (a, f) => { const v = a.map(f).sort((x, y) => x - y); return v[Math.floor(v.length / 2)]; };
const THREADS = (() => { if (typeof require('os').availableParallelism === 'function') return require('os').availableParallelism(); return require('os').cpus().length; })();

const scen = ['Sort', 'Graph', 'Range'].filter(s => by[s]);
console.log(`交错 A/B：${scen.length} 场景 × 25 组 × ${Math.max(...scen.flatMap(s => Object.values(by[s]).map(a => a.length)))} 轮，threads=${THREADS}（本机可用 CPU）\n`);

console.log('组数与耗时（中位数）');
console.log('场景    引擎  ok/总   失败   wall(ms)  每组wall(ms)  报告TPS');
const eff = {};
for (const s of scen) {
    for (const who of ['V6', 'V11']) {
        const a = by[s][who];
        if (!a || !a.length) continue;
        const wall = med(a, r => r.wall), ok = med(a, r => r.ok), failed = med(a, r => r.failed);
        const perWall = (wall * THREADS) / Math.max(ok, 1);
        eff[s + who] = { wall, ok, perWall };
        console.log(`${s.padEnd(7)} ${who.padEnd(5)} ${String(ok).padStart(2)}/${a[0].ok + a[0].failed || 25}  ${String(failed).padStart(4)}  ${String(wall).padStart(8)}   ${String(Math.round(perWall)).padStart(9)}   ${a.reduce((t, r) => t + r.tps, 0) / a.length}`);
    }
    console.log('');
}

console.log('已完成组的阶段耗时（中位，仅统计真跑完的组）');
console.log('场景    引擎   gen(ms)  std/test(ms)  gen+max');
for (const s of scen) {
    for (const who of ['V6', 'V11']) {
        const a = by[s][who];
        if (!a || !a.length) continue;
        const okAny = a.filter(r => r.ok > 0);
        if (!okAny.length) { console.log(`${s.padEnd(7)} ${who.padEnd(5)}  —— 没有任何组真正跑完`); continue; }
        const g = med(okAny, r => r.gen), st = med(okAny, r => r.std), te = med(okAny, r => r.test);
        console.log(`${s.padEnd(7)} ${who.padEnd(5)} ${g.toFixed(0).padStart(7)}  ${(Math.max(st, te)).toFixed(0).padStart(11)}  ${(g + Math.max(st, te)).toFixed(0).padStart(7)}`);
    }
}

console.log('\n失败构成（这决定了上面的 TPS 有多可信）');
for (const s of scen) {
    for (const who of ['V6', 'V11']) {
        const a = by[s][who]; if (!a) continue;
        const merged = {};
        for (const r of a) for (const [k, n] of Object.entries(r.kinds)) merged[k] = (merged[k] || 0) + n;
        const tot = Object.values(merged).reduce((x, y) => x + y, 0);
        console.log(`${s.padEnd(7)} ${who.padEnd(5)} ${tot ? JSON.stringify(merged) : '无失败'}`);
    }
}

console.log('\n有效吞吐（真正跑完的组 / 墙钟）');
for (const s of scen) {
    const v6 = eff[s + 'V6'], v11 = eff[s + 'V11'];
    if (!v6 || !v11) continue;
    const t6 = v6.ok / v6.wall * 1000, t11 = v11.ok / v11.wall * 1000;
    console.log(`${s.padEnd(7)} V6=${t6.toFixed(2)}  V11=${t11.toFixed(2)}  有效完成量 V11/V6 = ${v11.ok / (v6.ok || 1)}x` +
        `   （每组真实成本 V6=${Math.round(v6.perWall)}ms V11=${Math.round(v11.perWall)}ms）`);
}
