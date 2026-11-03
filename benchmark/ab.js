'use strict';
/**
 * ab.js — 钉住 CPU 集的交错 A/B 跑批器（对拍引擎专用）
 *
 * 为什么需要它：本机 CPU 亲和性掩码会在一次会话里变化（实测见过 3、4、8 个），
 * 而 os.cpus().length 永远报 8。不钉核的话两次跑的不是同一台机器，中位数没有意义。
 * 另外必须**交错**：串行分批会把负载漂移读成性能差 —— 本轮已经因此得出过一次
 * 「慢的那版更快」的假结论。
 *
 * 用法：
 *   node benchmark/ab.js --cpus 0-3 --threads 4 \
 *        --scenario Sort,Graph,Range --tests 24 --reps 3 \
 *        --worker V11=src/main-process/compare-worker-v6.js \
 *        --worker V12=benchmark/variants/worker-v12.js
 *
 * 日志写到 benchmark/logs/ab-<stamp>/，并打印：
 *   完成组数 / 失败构成 / 墙钟中位数 / 每完成一组的归一化墙钟。
 * 最后一列才是可信指标：被误杀的组「结束」得很快，裸 TPS 会奖励失败。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name, def) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const flagAll = (name) => {
    const out = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--' + name && argv[i + 1]) out.push(argv[i + 1]);
    return out;
};

const CPUS = flag('cpus', '0-3');
const THREADS = parseInt(flag('threads', '4'), 10);
const TESTS = parseInt(flag('tests', '24'), 10);
const REPS = parseInt(flag('reps', '3'), 10);
const SCENARIOS = flag('scenario', 'Sort,Graph,Range').split(',').map(s => s.trim()).filter(Boolean);
const WORKERS = flagAll('worker').map(spec => {
    const eq = spec.indexOf('=');
    return eq < 0 ? { name: spec, path: spec } : { name: spec.slice(0, eq), path: spec.slice(eq + 1) };
});
if (!WORKERS.length) { console.error('至少一个 --worker name=path'); process.exit(2); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.join(ROOT, 'benchmark', 'logs', 'ab-' + stamp);
fs.mkdirSync(OUT, { recursive: true });

const taskset = fs.existsSync('/usr/bin/taskset') || spawnSync('which', ['taskset']).status === 0;
if (!taskset) console.log('! 没有 taskset，本轮结果不可与其他钉核轮次直接比较');

console.log('ab.js  cpus=' + CPUS + ' threads=' + THREADS + ' tests=' + TESTS +
    ' reps=' + REPS + ' scenarios=' + SCENARIOS.join('/') + ' workers=' + WORKERS.map(w => w.name).join('/'));
console.log('logs -> ' + OUT + '\n');

const summaryBy = {};
for (let rep = 1; rep <= REPS; rep++) {
    // 交错顺序：同一轮内把所有 (scenario, worker) 跑完再进下一轮，
    // 且 worker 顺序在偶数轮反转，避免「总是第二个跑的吃亏」这种系统性偏置。
    const order = [];
    for (const sc of SCENARIOS) {
        const ws = (rep % 2 === 0) ? WORKERS.slice().reverse() : WORKERS;
        for (const w of ws) order.push([sc, w]);
    }
    for (const [sc, w] of order) {
        const log = path.join(OUT, 'rep' + rep + '-' + sc + '-' + w.name + '.jsonl');
        const cmd = [process.execPath, path.join(ROOT, 'benchmark', 'bench-logged.js'),
            '--scenario', sc, '--tests', String(TESTS), '--threads', String(THREADS),
            '--worker', w.path, '--log', log];
        const full = taskset ? ['/usr/bin/taskset', '-c', CPUS].concat(cmd) : cmd;
        const r = spawnSync(full[0], full.slice(1), { cwd: ROOT, encoding: 'utf8' });
        const line = (r.stdout || '').split('\n').find(l => l.trim().startsWith(sc)) || ('exit ' + r.status);
        console.log('  rep' + rep + ' ' + sc.padEnd(6) + ' ' + w.name.padEnd(6) + ' ' + line.trim());
        if (r.status !== 0 && !fs.existsSync(log)) console.log('    ! stderr: ' + (r.stderr || '').slice(0, 200));
        if (fs.existsSync(log)) {
            const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
            const s = rows.find(x => x.type === 'summary');
            if (s) ((summaryBy[sc] = summaryBy[sc] || {})[w.name] = summaryBy[sc][w.name] || []).push({
                wall: s.wallMs, ok: s.ok, failed: s.failed, cpu: s.cpuMs || 0, kinds: s.failByKind || {},
                rows: rows.filter(x => x.scenario)
            });
        }
    }
}

const med = (arr, f) => { const v = arr.map(f).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
const sum = (arr, f) => arr.reduce((t, r) => t + f(r), 0);

console.log('\n== 汇总（' + REPS + ' 轮累计，钉核 cpus=' + CPUS + '）==');
console.log('scenario worker  ok/总  失败  墙钟中位  累计墙钟  ms/完成组  CPU ms/完成组  主要失败');
const perCost = {};
const cpuCost = {};
for (const sc of SCENARIOS) {
    const grp = summaryBy[sc] || {};
    for (const w of WORKERS) {
        const a = grp[w.name];
        if (!a || !a.length) continue;
        const ok = sum(a, r => r.ok), failed = sum(a, r => r.failed);
        const wall = med(a, r => r.wall), wallSum = sum(a, r => r.wall);
        // 关键口径：按「真正跑完的组」归一化。0 完成时不做除法。
        const per = ok > 0 ? Math.round(wallSum / ok) : null;
        // CPU/完成组 才是可比的量：它不受亲和性漂移与外部负载影响
        const cpuSum = sum(a, r => r.cpu);
        const cper = ok > 0 ? +(cpuSum / ok).toFixed(1) : null;
        cpuCost[sc + '/' + w.name] = cper;
        perCost[sc + '/' + w.name] = per;
        const kinds = {};
        for (const r of a) for (const [k, n] of Object.entries(r.kinds)) kinds[k] = (kinds[k] || 0) + n;
        const top = Object.entries(kinds).sort((x, y) => y[1] - x[1]).slice(0, 2)
            .map(([k, n]) => k + '×' + n).join(', ') || '无';
        console.log(String(sc).padEnd(9) + String(w.name).padEnd(8) +
            String(ok + '/' + (ok + failed)).padStart(6) + String(failed).padStart(6) +
            String(wall).padStart(10) + String(wallSum).padStart(10) +
            String(per === null ? '  n/a' : per).padStart(11) +
            String(cper === null ? '  n/a' : cper).padStart(15) + '  ' + top);
    }
    console.log('');
}

console.log('== 相对第一个 worker 的成本（墙钟口径 / CPU 口径）==');
for (const sc of SCENARIOS) {
    const base = perCost[sc + '/' + WORKERS[0].name];
    for (const w of WORKERS) {
        const p = perCost[sc + '/' + w.name];
        if (p == null || base == null) { console.log(sc.padEnd(8) + w.name.padEnd(8) + ' 无可比数据（有版本一个组都没跑完）'); continue; }
        const cb = cpuCost[sc + '/' + WORKERS[0].name], cp = cpuCost[sc + '/' + w.name];
        console.log(sc.padEnd(8) + w.name.padEnd(8) + 'wall ' + (base / p).toFixed(3) + 'x   cpu ' +
            (cb && cp ? (cb / cp).toFixed(3) + 'x  (' + cp + 'ms/组)' : 'n/a'));
    }
}
console.log('\n日志目录: ' + OUT);
