'use strict';
/**
 * equiv-check.js — 判定等价性对照器
 *
 * 性能优化最危险的失效方式是「跑得快了，但结论变了」。wall/TPS 的对比只能证明快，
 * 证明不了对。这里对同一批数据、同一组用例，逐条比较各 worker 产出的 kind 序列，
 * 只有完全一致的实现才允许进入基准环节。
 *
 * 用法：node benchmark/equiv-check.js --cases 6 --worker V11=src/... --worker V12=...
 *
 * 注意 worker 的收尾方式：带 parentPort 消息监听器的 worker **不会自己退出**
 * （端口把 handle 一直挂着）。必须收到 done 后显式 terminate()，只监听 'exit'
 * 会永远等下去 —— 这个坑在写这个脚本时真实踩过一次，表现为整卡死而无输出。
 */
const path = require('path');
const { Worker } = require('worker_threads');

const ROOT = path.resolve(__dirname, '..');
const PROGS = path.join(ROOT, 'compare-benchmark', 'progs');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const CASES = parseInt(flag('cases', '6'), 10);
const WORKERS = [];
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--worker' && argv[i + 1]) {
        const eq = argv[i + 1].indexOf('=');
        WORKERS.push({ name: argv[i + 1].slice(0, eq), path: argv[i + 1].slice(eq + 1) });
    }
}
if (WORKERS.length < 2) { console.error('至少两个 --worker name=path'); process.exit(2); }

// 覆盖三种输出形状：单行大输出 / 多行大输出 / 极小输出，外加一个必然不等价的对照
const SCENARIOS = [
    ['Sort', 'gen_sort', 'sort_std', 'sort_mergesort'],
    ['Range', 'gen_range', 'range_bit', 'range_segtree'],
    ['Graph', 'gen_graph', 'sp_dijkstra', 'sp_spfa'],
    // std 与 test 故意指向不同程序：所有实现都必须逐组报 mismatch，谁报成 ok 谁错
    ['ForceDiff', 'gen_graph', 'sp_dijkstra', 'range_bit']
];

const HARD_TIMEOUT = 240000;
const guard = setTimeout(() => {
    console.log('[FAIL] 等价性对照整体超时未收束');
    process.exit(1);
}, HARD_TIMEOUT);
guard.unref && guard.unref();

function drive(workerPath, sc, n) {
    return new Promise((resolve) => {
        const rows = [];
        const w = new Worker(path.resolve(ROOT, workerPath));
        let settled = false;
        const done = () => { if (settled) return; settled = true; try { w.terminate(); } catch (_) { } resolve(rows); };
        w.on('message', (m) => {
            if (m.type === 'progress') rows.push({ i: m.testIndex, kind: 'ok' });
            else if (m.type === 'error') rows.push({ i: m.testIndex, kind: m.kind, code: m.code });
            else if (m.type === 'done') done();
        });
        w.on('error', (e) => { rows.push({ i: -1, kind: 'worker_crash', code: e.message }); done(); });
        w.on('exit', done);
        w.postMessage({
            type: 'run-tests', startIdx: 1, count: n,
            gen: path.join(PROGS, sc[1]), stdPath: path.join(PROGS, sc[2]), testPath: path.join(PROGS, sc[3]),
            timeout: 20000, generatorTimeout: 20000
        });
        setTimeout(() => { rows.push({ i: -2, kind: 'timeout' }); done(); }, 120000).unref();
    });
}

const sig = (rows) => rows.map(r => r.kind).sort().join(',');

(async () => {
    console.log('等价性对照（每场景 ' + CASES + ' 组）: ' + WORKERS.map(w => w.name).join(' vs '));
    let bad = 0;
    for (const sc of SCENARIOS) {
        const results = {};
        for (const w of WORKERS) results[w.name] = sig(await drive(w.path, sc, CASES));
        const names = WORKERS.map(w => w.name);
        const allSame = names.every(n => results[n] === results[names[0]]);
        // ForceDiff 必须逐组 mismatch：用来抓「把不等判成相等」的方向性错误
        const diffOk = sc[0] !== 'ForceDiff' || names.every(n => /^mismatch,/.test(results[n]) && results[n].split(',').length === CASES);
        if (!allSame || !diffOk) bad++;
        console.log('  ' + sc[0].padEnd(10) + (allSame ? 'SAME  ' : '**DIFF**') + '  ' +
            names.map(n => n + '=' + results[n]).join('  |  '));
        if (!diffOk) console.log('      ! ForceDiff 没有逐组报 mismatch');
    }
    clearTimeout(guard);
    console.log(bad ? '\n等价性不通过：' + bad + ' 个场景结论不一致' : '\n全部一致，可以进入基准环节');
    process.exit(bad ? 1 : 0);
})();
