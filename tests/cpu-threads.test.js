'use strict';

// CPU 核心数探测缓存契约回归：P7
// os.cpus() 首次调用在部分平台要上百毫秒且同步阻塞主进程，
// get-cpu-threads 必须走缓存，并在启动后空闲时段预热。

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.join(__dirname, '..');
const modPath = path.join(root, 'src', 'utils', 'cpu-threads.js');
const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

const cpuThreads = require(modPath);

const first = cpuThreads.getCpuThreads();
const second = cpuThreads.getCpuThreads();
check('P7 getCpuThreads returns a positive thread count', Number.isInteger(first) && first >= 1, String(first));
check('P7 repeated calls are served from the cache', first === second);

// 缓存命中意味着不会再调用 os.cpus()：把模块缓存清掉后打桩验证
cpuThreads.resetCpuThreadsCache();
const os = require('os');
const originalCpus = os.cpus;
let detectCalls = 0;
os.cpus = () => { detectCalls++; return [{ model: 'stub' }]; };
try {
    check('P7 cache miss probes os.cpus once', cpuThreads.getCpuThreads() === 1 && detectCalls === 1, `calls=${detectCalls}`);
    check('P7 warm-up after the cache is filled is a no-op', cpuThreads.scheduleCpuThreadsWarmUp(1) === undefined);

    cpuThreads.resetCpuThreadsCache();
    const timer = cpuThreads.scheduleCpuThreadsWarmUp(1);
    check('P7 warm-up schedules a probe when the cache is cold', !!timer);
} finally {
    os.cpus = originalCpus;
    cpuThreads.resetCpuThreadsCache();
}

check('P7 main routes get-cpu-threads through the cached helper',
    /ipcMain\.handle\('get-cpu-threads',[\s\S]{0,120}getCpuThreads\(\)/.test(mainSource) &&
    !/ipcMain\.handle\('get-cpu-threads',[\s\S]{0,200}os\.cpus\(\)/.test(mainSource));
check('P7 main warms the cache after the window is created',
    /createWindow\(\);[\s\S]{0,200}scheduleCpuThreadsWarmUp\(\)/.test(mainSource));

console.log(`cpu-threads regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
