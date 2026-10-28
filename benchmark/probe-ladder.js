'use strict';
/**
 * probe-ladder.js — 回退路径开销的逐级归因（单进程、串行、钉核下跑）
 *
 * 每一级只比上一级多一件东西，差值就是那件东西的代价：
 *   childFloor     : stdin 来自**文件 fd**、stdout/stderr 丢弃 —— 只有 spawn+exec+程序自身计算
 *   writeOnly      : 同上但 stdin 由 Node 流写入（读者是 /bin/cat，一直抽干）—— 纯 Node 写机制
 *   noKeep         : spawn + 两条管道都读，但**不留块**（只计数）—— 读侧 libuv/流分派
 *   full           : 生产回退路径（留块 + Buffer.concat）—— 再加上保留与拼接
 *   native         : fastspawn.run —— 同一件事在 C 层做
 *   spawnSync      : 纯 Node 的阻塞式 spawn + C++ 读环 —— 回退路径在不带 .node 时能拿到的最快形态
 * 判等另测：normalize 版 vs Buffer.compare 版。
 *
 * 用法: node benchmark/probe-ladder.js [scenario ...] [reps]
 */
const path = require('path');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROGS = path.join(ROOT, 'compare-benchmark', 'progs');
const DUMP = '/tmp/ladder';
fs.mkdirSync(DUMP, { recursive: true });

const fast = require(path.join(ROOT, 'fastspawn.node'));

const SCEN = {
    Sort: { gen: 'gen_sort', std: 'sort_std', test: 'sort_mergesort', timeout: 10000 },
    Graph: { gen: 'gen_graph', std: 'sp_dijkstra', test: 'sp_spfa', timeout: 5000 },
    Range: { gen: 'gen_range', std: 'range_bit', test: 'range_segtree', timeout: 10000 }
};

const MAX = 64 * 1024 * 1024;
const now = () => Number(process.hrtime.bigint()) / 1e6;
const med = (a) => { const v = a.slice().sort((x, y) => x - y); return v[v.length >> 1]; };
const r2 = (x) => Math.round(x * 100) / 100;

/* ---- 生产回退路径的读侧机制，逐字照搬 compare-worker-v6 的 append/collect ---- */
function runStreams(exe, input, timeout, keep) {
    return new Promise((resolve) => {
        const t0 = now();
        const proc = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
        const chunks = [];
        let outputBytes = 0, cbMs = 0, cbN = 0, errBytes = 0;
        proc.stdout.on('data', (d) => {
            const c0 = now();
            if (keep) { outputBytes += d.length; chunks.push(d); }
            cbN++;
            cbMs += now() - c0;
        });
        proc.stderr.on('data', (d) => { errBytes += d.length; });
        const stdin = proc.stdin;
        stdin.on('error', () => { });
        let writeCallMs = 0, stdinFinishMs = -1;
        stdin.on('finish', () => { stdinFinishMs = now() - t0; });
        const w0 = now();
        if (input !== null) { stdin.write(input); stdin.end(); } else stdin.end();
        writeCallMs = now() - w0;
        let concatMs = 0, outLen = 0;
        const done = (code) => {
            const buf = keep ? (() => { const c0 = now(); const b = Buffer.concat(chunks); concatMs = now() - c0; outLen = b.length; return b; })() : null;
            resolve({ ms: now() - t0, code, out: buf, outLen: keep ? outLen : outputBytes, cbMs, cbN, writeCallMs, stdinFinishMs, concatMs, errBytes });
        };
        proc.on('close', (code) => done(code));
        proc.on('error', () => done(-1));
        const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) { } }, timeout || 60000);
        proc.on('exit', () => clearTimeout(killer));
    });
}

/* childFloor: stdin 走文件 fd，stdout/stderr 丢弃 —— 事件循环里没有任何 IO 回调 */
function runChildFloor(exe, inputFile, timeout) {
    return new Promise((resolve) => {
        const t0 = now();
        const fd = fs.openSync(inputFile, 'r');
        const nullFd = fs.openSync('/dev/null', 'w');
        const proc = spawn(exe, [], { stdio: [fd, nullFd, nullFd] });
        fs.closeSync(fd); fs.closeSync(nullFd);
        proc.on('exit', (code) => resolve({ ms: now() - t0, code }));
        proc.on('error', (e) => resolve({ ms: now() - t0, code: -1, err: String(e) }));
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) { } }, timeout || 60000);
    });
}

function runSpawnSync(exe, input, timeout) {
    const t0 = now();
    const r = spawnSync(exe, [], { input, timeout: timeout || 60000, maxBuffer: MAX, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ms: now() - t0, code: r.status, outLen: r.stdout ? r.stdout.length : 0, err: r.error ? String(r.error) : null };
}

function runNative(exe, input, timeout) {
    const t0 = now();
    const r = fast.run(exe, input, timeout || 60000);
    return { ms: now() - t0, code: r.code, outLen: r.output ? r.output.length : 0 };
}

/* ---- 判等：出厂的 normalize 版 vs 只比字节的最小版 ---- */
function normalizeOutput(value) {
    return Buffer.from(value || '')
        .toString('utf8')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n+$/, '');
}
const slowEqual = (a, b) => normalizeOutput(a) === normalizeOutput(b);
const fastEqual = (a, b) => (a.length === b.length && Buffer.compare(a, b) === 0) || slowEqual(a, b);

async function main() {
    const want = process.argv.slice(2).filter(a => !/^\d+$/.test(a));
    const REPS = parseInt((process.argv.slice(2).find(a => /^\d+$/.test(a)) || '7'), 10);
    const out = {};
    for (const name of (want.length ? want : Object.keys(SCEN))) {
        const s = SCEN[name];
        const genP = path.join(PROGS, s.gen), stdP = path.join(PROGS, s.std), testP = path.join(PROGS, s.test);
        const inF = path.join(DUMP, name + '.in'), stdOutF = path.join(DUMP, name + '.std'), testOutF = path.join(DUMP, name + '.test');
        if (!fs.existsSync(inF)) fs.writeFileSync(inF, fast.run(genP, null, s.timeout).output);
        const input = fs.readFileSync(inF);
        if (!fs.existsSync(stdOutF)) fs.writeFileSync(stdOutF, fast.run(stdP, input, s.timeout).output);
        if (!fs.existsSync(testOutF)) fs.writeFileSync(testOutF, fast.run(testP, input, s.timeout).output);
        const a = fs.readFileSync(stdOutF), b = fs.readFileSync(testOutF);
        const byteIdentical = Buffer.compare(a, b) === 0;

        const R = { in: input.length, out: a.length, byteIdentical };
        // 串行各级，每级 REPS 次取中位（µs -> ms）
        const samples = { native: [], full: [], noKeep: [], sync: [], floor: [], writeOnly: [] };
        for (let i = 0; i < REPS; i++) {
            const n = runNative(stdP, input, s.timeout); samples.native.push(n.ms);
            const y = runSpawnSync(stdP, input, s.timeout); samples.sync.push(y.ms);
            const f = await runStreams(stdP, input, s.timeout, true); samples.full.push(f.ms);
            const k = await runStreams(stdP, input, s.timeout, false); samples.noKeep.push(k.ms);
            const c = await runChildFloor(stdP, inF, s.timeout); samples.floor.push(c.ms);
            const w = await runStreams('/bin/cat', input, s.timeout, false); samples.writeOnly.push(w.ms);
        }
        for (const key of Object.keys(samples)) R[key] = r2(med(samples[key]));
        // 判等：分别跑，取中位
        const slowT = [], fastT = [];
        for (let i = 0; i < Math.max(3, REPS >> 1); i++) {
            let t = now(); slowEqual(a, b); slowT.push(now() - t);
            t = now(); fastEqual(a, b); fastT.push(now() - t);
        }
        R.judgeSlowMs = r2(med(slowT)); R.judgeFastMs = r2(med(fastT));
        R.judgeSame = slowEqual(a, b) === fastEqual(a, b);
        // 整组配对标尺：与生产回退同构（两子并行 + 判等），只换判等
        {
            const slowPair = [], fastPair = [];
            for (let i = 0; i < 3; i++) {
                let t = now();
                await Promise.all([runStreams(stdP, input, s.timeout, true), runStreams(testP, input, s.timeout, true)])
                    .then(([x, y]) => { slowEqual(x.out, y.out); });
                slowPair.push(now() - t);
                t = now();
                await Promise.all([runStreams(stdP, input, s.timeout, true), runStreams(testP, input, s.timeout, true)])
                    .then(([x, y]) => { fastEqual(x.out, y.out); });
                fastPair.push(now() - t);
            }
            R.pairJsSlow = r2(med(slowPair)); R.pairJsFast = r2(med(fastPair));
            R.pairJsSlowRaw = slowPair.map(r2); R.pairJsFastRaw = fastPair.map(r2);
        }
        // 一次 native runPair 的 C 层判等代价：compare 开/关之差
        const withCmp = [], noCmp = [];
        for (let i = 0; i < Math.max(3, REPS >> 1); i++) {
            const t0 = now(); fast.runPair(stdP, testP, input, s.timeout, true); withCmp.push(now() - t0);
            const t1 = now(); fast.runPair(stdP, testP, input, s.timeout, false); noCmp.push(now() - t1);
        }
        R.pairCmpMs = r2(med(withCmp)); R.pairNoCmpMs = r2(med(noCmp));
        R.raw = { native: samples.native.map(r2), sync: samples.sync.map(r2), full: samples.full.map(r2),
            noKeep: samples.noKeep.map(r2), floor: samples.floor.map(r2), writeOnly: samples.writeOnly.map(r2) };
        R.judgeSlowRaw = slowT.map(r2); R.judgeFastRaw = fastT.map(r2);
        R.pairCmpRaw = withCmp.map(r2); R.pairNoCmpRaw = noCmp.map(r2);
        out[name] = R;
        fs.appendFileSync(process.env.LADDER_OUT || '/tmp/ladder/raw.jsonl',
            JSON.stringify({ scenario: name, in: input.length, out: a.length, byteIdentical, ...R }) + '\n');
    }
    console.log('---');
    console.log('列含义(单位 ms，中位): floor=仅 spawn+exec+计算(stdin 文件,输出丢弃) | ' +
        'writeOnly=floor+/bin/cat 收流(Node 写机制) | noKeep=+读侧流分派不留块 | full=生产回退(留块+concat) | ' +
        'sync=spawnSync | native=fastspawn.run | judgeSlow/judgeFast=JS 判等 | pairCmp/pairNoCmp=native runPair 开/关 C 判等');
    for (const [k, v] of Object.entries(out)) console.log(k.padEnd(6) + JSON.stringify(v));
}
main().catch((e) => { console.error(e); process.exit(1); });
