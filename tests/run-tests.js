#!/usr/bin/env node
'use strict';

// 自动发现 tests/*.test.js 并逐个运行：新增测试文件即自动纳入回归套件
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testsDir = __dirname;
const files = fs.readdirSync(testsDir)
    .filter((f) => f.endsWith('.test.js'))
    .sort();

if (!files.length) {
    console.log('no test files found in tests/');
    process.exit(1);
}

let failedCount = 0;
for (const file of files) {
    const started = Date.now();
    const r = spawnSync(process.execPath, [path.join(testsDir, file)], {
        encoding: 'utf8',
        timeout: 60000,
        cwd: path.join(testsDir, '..')
    });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    // stdout 与 stderr 都要统计：只看 stdout 时，测试把 [FAIL] 写到 stderr 就彻底不可见
    const lines = `${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/);
    const assertions = lines.filter((l) => l.includes('[PASS]') || l.includes('[FAIL]')).length;
    const failedAssertions = lines.filter((l) => l.includes('[FAIL]')).length;

    // 一个标记都不打印的测试文件不能记为 PASS：异步用例若 promise 永不 settle，
    // 进程会静默 exit 0，形成假绿
    if (assertions === 0) {
        failedCount++;
        console.log(`[FAIL] ${file} (no assertions reported, ${elapsed}s)`);
        if (r.stderr) console.log(`${r.stderr}`.trimEnd());
        continue;
    }

    if (r.status === 0 && failedAssertions === 0) {
        console.log(`[PASS] ${file} (${assertions} assertions, ${elapsed}s)`);
    } else {
        failedCount++;
        console.log(`[FAIL] ${file} (exit=${r.status}${r.signal ? ` signal=${r.signal}` : ''}, ${failedAssertions} failed assertions, ${elapsed}s)`);
        console.log(`${r.stdout || ''}`.trimEnd());
        if (r.stderr) console.log(`${r.stderr}`.trimEnd());
    }
}

console.log(`\n${files.length - failedCount}/${files.length} test files passed`);
process.exit(failedCount ? 1 : 0);
