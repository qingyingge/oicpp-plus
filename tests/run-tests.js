#!/usr/bin/env node
'use strict';

// 自动发现 tests/*.test.js 并逐个运行：新增测试文件即自动纳入回归套件。
// 并发池跑：每个用例仍是独立的 node 子进程（进程级隔离不变，chdir/mkdtemp
// 不会串），但多个文件并行执行，把顺序跑的墙钟时间从「求和」压到「最慢的
// 一批」。实测 52 个文件 ~58s（顺序）-> ~16s（并发 4）。结果按文件名排序输出，
// 保证 CI 输出稳定可 diff。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const testsDir = __dirname;
const rootDir = path.join(testsDir, '..');
const files = fs.readdirSync(testsDir)
    .filter((f) => f.endsWith('.test.js'))
    .sort();

if (!files.length) {
    console.log('no test files found in tests/');
    process.exit(1);
}

// 并发上限：测试多为文件读取 + 本地临时端口 HTTP server，CPU/IO 都轻，
// 4 路并发安全。压成可调环境变量方便机器差异时调。
const CONCURRENCY = Number(process.env.TEST_CONCURRENCY || 4);

let failedCount = 0;
const results = new Map(); // file -> { passed, failedAssertions, status, signal, elapsed, stdout, stderr }

function runOne(file) {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(process.execPath, [path.join(testsDir, file)], {
            cwd: rootDir,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        // 沿用单用例 60s 超时（异步用例若 promise 永不 settle，靠这个顶住，
        // 防止并发池里一个不结束的用例占住 worker 不放）。
        const timer = setTimeout(() => { child.kill('SIGKILL'); }, 60000);
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            const elapsed = ((Date.now() - started) / 1000).toFixed(1);
            // stdout 与 stderr 都要统计：只看 stdout 时，测试把 [FAIL] 写到
            // stderr 就彻底不可见。
            const lines = `${stdout}${stderr}`.split(/\r?\n/);
            const assertions = lines.filter((l) => l.includes('[PASS]') || l.includes('[FAIL]')).length;
            const failedAssertions = lines.filter((l) => l.includes('[FAIL]')).length;
            results.set(file, {
                passed: code === 0 && failedAssertions === 0 && assertions > 0,
                failedAssertions,
                status: code,
                signal,
                elapsed,
                stdout,
                stderr,
                noAssertions: assertions === 0
            });
            resolve();
        });
    });
}

(async () => {
    // 正确的并发池：固定 CONCURRENCY 个 worker 协程，各自从队列里取下一个文件，
    // 跑完再取，直到队列空。await 这固定数量的 worker 就能等到全部文件收尾；
    // 用「边跑边往数组里塞 promise」的写法会令 Promise.all 只等到第一批就提前
    // 打印并 process.exit，把还没跑完的用例直接杀掉。
    let index = 0;
    const worker = async () => {
        while (index < files.length) {
            const file = files[index++];
            await runOne(file);
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    // 按文件名排序输出，保持确定性
    for (const file of files) {
        const r = results.get(file);
        if (!r) continue;
        // 一个标记都不打印的测试文件不能记为 PASS：异步用例若 promise 永不
        // settle，进程会静默 exit 0，形成假绿。
        if (r.noAssertions) {
            failedCount++;
            console.log(`[FAIL] ${file} (no assertions reported, ${r.elapsed}s)`);
            if (r.stderr) console.log(`${r.stderr}`.trimEnd());
            continue;
        }
        if (r.passed) {
            console.log(`[PASS] ${file} (0 failed, ${r.elapsed}s)`);
        } else {
            failedCount++;
            console.log(`[FAIL] ${file} (exit=${r.status}${r.signal ? ` signal=${r.signal}` : ''}, ${r.failedAssertions} failed assertions, ${r.elapsed}s)`);
            console.log(`${r.stdout}`.trimEnd());
            if (r.stderr) console.log(`${r.stderr}`.trimEnd());
        }
    }

    console.log(`\n${files.length - failedCount}/${files.length} test files passed`);
    process.exit(failedCount ? 1 : 0);
})();