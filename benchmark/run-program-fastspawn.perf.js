'use strict';

/**
 * run-program 快路径性能对比：fastspawn.runAsync vs child_process.spawn
 *
 * run-program 主进程 handler（src/main.ts）在未设内存限制时，优先走
 * fastspawn.runAsync（libuv 线程池，不阻塞主线程），与对拍引擎共用
 * native 后端。本脚本对比两者在「运行一个读 stdin 原样输出的脚本」上的
 * 耗时，验证快路径确实更快。
 *
 * 对拍引擎已有实测：生成器 child_process 32.4 ms vs native 10.9 ms。
 *
 * 用法: node benchmark/run-program-fastspawn.perf.js
 * 前置: pnpm run prebuild:native（生成 fastspawn.node）
 * win32 或无 .node 时跳过，不判 FAIL。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE_PATH = path.join(ROOT, 'fastspawn.node');
let fast = null;
let fastAvailable = false;
try {
    fast = require(NODE_PATH);
    fastAvailable = typeof fast.runAsync === 'function';
} catch (_) { /* fastspawn.node 不存在，后面跳过 */ }

const ITER = 60;
const input = 'hello world\n'.repeat(100); // ~1.2 KB 输入

// 构造一个最轻量的子进程：读 stdin，原样写 stdout，立即退出
const script = path.join(os.tmpdir(), 'oicpp-perf-echo.sh');
fs.writeFileSync(script, '#!/bin/sh\ncat\n');
fs.chmodSync(script, 0o755);

function hrStart() { return process.hrtime.bigint(); }
function hrMs(t0) { return Number(process.hrtime.bigint() - t0) / 1_000_000; }

// 传统 child_process.spawn
function spawnRun(inputData) {
    return new Promise((resolve) => {
        const t0 = hrStart();
        const p = spawn(script, [], { stdio: ['pipe', 'pipe', 'pipe'] });
        p.stdout.on('data', () => {}); // 消耗输出，避免管道满
        p.on('close', () => resolve(hrMs(t0)));
        p.stdin.write(inputData);
        p.stdin.end();
    });
}

// fastspawn.runAsync（run-program 快路径实际使用的入口）
function fastspawnRun(inputData) {
    return new Promise((resolve) => {
        const t0 = hrStart();
        fast.runAsync(script, inputData, 10000, undefined, []).then(() => {
            resolve(hrMs(t0));
        });
    });
}

async function bench() {
    // warmup
    await spawnRun(input);
    if (fastAvailable) await fastspawnRun(input);

    let spawnTotal = 0;
    let fastTotal = 0;
    for (let i = 0; i < ITER; i++) {
        spawnTotal += await spawnRun(input);
        if (fastAvailable) fastTotal += await fastspawnRun(input);
    }

    const spawnAvg = spawnTotal / ITER;
    console.log('child_process.spawn  平均: ' + spawnAvg.toFixed(2) + ' ms (' + ITER + ' 次)');

    if (!fastAvailable) {
        console.log('[SKIP] fastspawn.node 不存在或无 runAsync，需先跑 pnpm run prebuild:native');
        console.log('[SKIP] 无法对比，快路径未验证');
        process.exit(0);
    }

    const fastAvg = fastTotal / ITER;
    const pct = ((spawnAvg - fastAvg) / spawnAvg * 100).toFixed(1);
    console.log('fastspawn.runAsync 平均: ' + fastAvg.toFixed(2) + ' ms (' + ITER + ' 次)');
    console.log('快路径提升: ' + pct + '% (' + (spawnAvg - fastAvg).toFixed(2) + ' ms/次)');

    if (pct > 0) {
        console.log('[PASS] fastspawn 快路径确实更快');
    } else {
        console.log('[WARN] fastspawn 未更快（本机波动，可多跑几次）');
    }
}

bench().catch((e) => {
    console.error('[FAIL]', e);
    process.exit(1);
});
