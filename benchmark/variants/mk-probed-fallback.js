'use strict';
/**
 * mk-probed-fallback.js — 由 benchmark/variants/worker-v11-fallback.js 生成
 * 「带计时的回退路径」变体。
 *
 * 为什么用补丁而不是手写一份探针：被测代码必须是**出厂那一段**，
 * 只是往里插计时点；手写就会和真实路径漂移，测到的不是同一件事。
 * 每一处 replace 都断言命中次数，插入点漂移时立刻失败，不会静默产出错探针。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'worker-v11-fallback.js');
const OUT = path.join(__dirname, 'worker-v11-fallback-probed.js');

let s = fs.readFileSync(SRC, 'utf8');

function sub(needle, repl, expect = 1) {
    const n = s.split(needle).length - 1;
    if (n !== expect) {
        throw new Error('补丁命中 ' + n + ' 次（期望 ' + expect + '）: ' + needle.slice(0, 70).replace(/\n/g, '\\n'));
    }
    s = s.replace(needle, () => repl);
}

/* ---------- 1. 探针运行时 ---------- */
sub('const process_supervisor_1 = require("/tmp/oicpp-plus/src/utils/process-supervisor");',
`const process_supervisor_1 = require("/tmp/oicpp-plus/src/utils/process-supervisor");
/* ===== PROBE RUNTIME (由 mk-probed-fallback.js 插入) ===== */
const PB_REC = new WeakMap();
const PB_OUT = process.env.OICPP_PROBE_OUT || '';
let PB_GC_MS = 0, PB_GC_N = 0;
try {
    const { PerformanceObserver } = require('perf_hooks');
    new PerformanceObserver((list) => {
        for (const e of list.getEntries()) { PB_GC_MS += e.duration; PB_GC_N++; }
    }).observe({ entryTypes: ['gc'] });
} catch (_) { /* 没有 gc 观测就少一列，不影响其余计时 */ }
const PB_now = () => Number(process.hrtime.bigint()) / 1e6;
const PB_d = (t0) => PB_now() - t0;
function PB_attach(proc) {
    const rec = { spawnMs: 0, cbOutMs: 0, cbErrMs: 0, chunksOut: 0, chunksErr: 0,
        bytesOut: 0, bytesErr: 0, concatOutMs: 0, concatErrMs: 0, concatOutBytes: 0,
        writeCallMs: 0, drains: 0, stdinFinishMs: -1, exitMs: -1, closeMs: -1,
        pid: proc.pid, exe: '', t0: PB_now(), gcN0: PB_GC_N, gcMs0: PB_GC_MS };
    PB_REC.set(proc, rec);
    return rec;
}
function PB_of(proc) { return PB_REC.get(proc) || PB_attach(proc); }
function PB_cb(rec, which, fn, len) {
    const t = PB_now();
    fn();
    const d = PB_now() - t;
    if (which === 'out') { rec.cbOutMs += d; rec.chunksOut++; rec.bytesOut += len; }
    else { rec.cbErrMs += d; rec.chunksErr++; rec.bytesErr += len; }
}
function PB_wrap(rec, field, fn) { const t = PB_now(); const v = fn(); rec[field] += PB_now() - t; return v; }
function PB_emit(tag, rec, extra) {
    if (!PB_OUT) return;
    const line = Object.assign({ tag, exe: rec.exe, spawnMs: +rec.spawnMs.toFixed(3),
        exitMs: +rec.exitMs.toFixed(1), closeMs: +rec.closeMs.toFixed(1),
        cbOutMs: +rec.cbOutMs.toFixed(3), cbErrMs: +rec.cbErrMs.toFixed(3),
        chunksOut: rec.chunksOut, bytesOut: rec.bytesOut,
        concatOutMs: +rec.concatOutMs.toFixed(3), concatOutBytes: rec.concatOutBytes,
        writeCallMs: +rec.writeCallMs.toFixed(3), drains: rec.drains,
        stdinFinishMs: +rec.stdinFinishMs.toFixed(1),
        gcMs: +(PB_GC_MS - rec.gcMs0).toFixed(2), gcN: PB_GC_N - rec.gcN0 }, extra || {});
    fs.appendFileSync(PB_OUT, JSON.stringify(line) + '\\n');
}
/* ===== END PROBE RUNTIME ===== */`);

/* ---------- 2. spawn() 自身耗时 + exit/close 时间戳 ---------- */
sub(`        const proc = (0, child_process_1.spawn)(exePath, args || [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: process.platform !== 'win32',
            cwd
        });`,
`        const __pt = PB_now();
        const proc = (0, child_process_1.spawn)(exePath, args || [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            detached: process.platform !== 'win32',
            cwd
        });
        const __rec = PB_attach(proc);
        __rec.spawnMs = PB_now() - __pt;
        __rec.exe = exePath;
        proc.on('exit', () => { __rec.exitMs = PB_now() - __rec.t0; });`);

/* ---------- 3. data 回调计时 ---------- */
sub("        proc.stdout.on('data', (data) => append(stdout, data, true));\n        proc.stderr.on('data', (data) => append(stderr, data, false));",
`        proc.stdout.on('data', (data) => PB_cb(__rec, 'out', () => append(stdout, data, true), data.length));
        proc.stderr.on('data', (data) => PB_cb(__rec, 'err', () => append(stderr, data, false), data.length));`);

/* ---------- 4. close 事件计时 + concat 计时 ---------- */
sub(`        proc.on('close', (code, signal) => {
            activeProcesses.delete(proc);`,
`        proc.on('close', (code, signal) => {
            __rec.closeMs = PB_now() - __rec.t0;
            activeProcesses.delete(proc);`);

sub("        wrapped._collect = () => Buffer.concat(stdout);\n        wrapped._stderr = () => Buffer.concat(stderr).toString('utf8');",
`        wrapped._collect = () => { const __b = PB_wrap(__rec, 'concatOutMs', () => Buffer.concat(stdout)); __rec.concatOutBytes = __b.length; return __b; };
        wrapped._stderr = () => PB_wrap(__rec, 'concatErrMs', () => Buffer.concat(stderr).toString('utf8'));`);

/* ---------- 5. stdin 写入：调用耗时 / drain 次数 / finish 时刻 ---------- */
sub(`        try {
            if (stdin)
                stdin.on('error', () => { resolve(false); });
        }
        catch (_) { /* stdin 不可用时下面自然失败 */ }`,
`        const __wrec = PB_of(proc);
        if (stdin) {
            stdin.on('drain', () => { __wrec.drains++; });
            stdin.on('finish', () => { __wrec.stdinFinishMs = PB_now() - __wrec.t0; });
            stdin.on('close', () => { if (__wrec.stdinFinishMs < 0) __wrec.stdinFinishMs = PB_now() - __wrec.t0; });
        }
        try {
            if (stdin)
                stdin.on('error', () => { resolve(false); });
        }
        catch (_) { /* stdin 不可用时下面自然失败 */ }`);

sub(`            stdin.write(input);
            stdin.end();
            resolve(true);`,
`            const __wt = PB_now();
            stdin.write(input);
            stdin.end();
            __wrec.writeCallMs += PB_now() - __wt;
            resolve(true);`);

/* ---------- 6. runJs 汇总一行；runJsPair 的 JS 判等耗时 ---------- */
sub(`    const signalName = r.signal || null;`,
`    const __rrec = PB_of(proc);
    __rrec.totalMs = Date.now() - t0;
    PB_emit('child', __rrec, { inBytes: (input && input.length) || 0, exitCode: r.exitCode });
    const signalName = r.signal || null;`);

/* judgePair 只在回退路径需要 JS 判等，计时整个调用即判等成本 */
sub('                const verdict = judgePair(outcome);',
`                const __jt = PB_now();
                const verdict = judgePair(outcome);
                PB_JUDGE.push(PB_now() - __jt);`);

sub('let running = false;',
`const PB_JUDGE = [];
let running = false;`);

/* 每个测试结束落一行 pair（判等成本、pair 墙钟、输入体积） */
sub(`                worker_threads_1.parentPort.postMessage({
                    type: 'progress', testIndex: i,`,
`                if (PB_OUT) fs.appendFileSync(PB_OUT, JSON.stringify({ tag: 'pair', testIndex: i,
                    pairMs: +outcome.ms.toFixed(1), judgeMs: +(PB_JUDGE.pop() || 0).toFixed(3),
                    genMs: lastGenMs, inBytes: genOut.output ? genOut.output.length : 0,
                    verdict: verdict.failed ? verdict.kind : 'ok' }) + '\\n');
                worker_threads_1.parentPort.postMessage({
                    type: 'progress', testIndex: i,`);

fs.writeFileSync(OUT, s);
console.log('wrote ' + OUT + ' (' + s.length + ' bytes)');
