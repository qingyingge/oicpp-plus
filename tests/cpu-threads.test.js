'use strict';

// CPU 核心数探测缓存契约回归：P7
// os.cpus() 首次调用在部分平台要上百毫秒且同步阻塞主进程，
// get-cpu-threads 必须走缓存，并在启动后空闲时段预热。

const fs = require('fs');
const path = require('path');
const { callbackBody, callStatement } = require('./fixtures/source-extract');

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

// 注册语句抽出来配假 ipcMain 真执行一遍：注册方式、通道名、handler 都成了可观测数据，
// 不再靠「handle 后面 120 个字符里有没有 getCpuThreads()」这种窗口正则。
const cpuStmt = callStatement(mainSource, /^ipcMain\.handle\(\s*'get-cpu-threads'/m);
check('注册语句抽取成功: get-cpu-threads', cpuStmt.length > 0, cpuStmt.slice(0, 60));

const recorded = [];
const ipcStub = {
    handle: (ch, fn) => { recorded.push({ mode: 'handle', ch, fn }); },
    on: (ch, fn) => { recorded.push({ mode: 'on', ch, fn }); }
};
let osCpusCalls = 0;
const osStub = { cpus: () => { osCpusCalls++; return [{ model: 'stub' }]; } };
let cachedCalls = 0;
const SENTINEL = 99;
new Function('ipcMain', 'os', 'getCpuThreads', cpuStmt)(
    ipcStub, osStub, () => { cachedCalls++; return SENTINEL; });
check('P7 get-cpu-threads 只注册 invoke 一条路径',
    recorded.length === 1 && recorded[0].mode === 'handle' && recorded[0].ch === 'get-cpu-threads',
    JSON.stringify(recorded.map((r) => `${r.mode}:${r.ch}`)));

const routedValue = recorded.length === 1 ? recorded[0].fn() : undefined;
check('P7 handler 走缓存 helper，一次都不碰 os.cpus()',
    routedValue === SENTINEL && cachedCalls === 1 && osCpusCalls === 0,
    JSON.stringify({ routedValue, cachedCalls, osCpusCalls }));

// 预热时机：必须是 whenReady 回调里的顶层语句，且在 createWindow() 之后。
// 只看同一层的调用（被挪进 setTimeout 回调算 depth+1），不锁缩进和空行。
const readyBody = callbackBody(mainSource, /app\.whenReady\(\)\s*\.\s*then\(/);
check('whenReady 回调体抽取成功', readyBody.length > 0);
const topLevelAt = (needle) => {
    let depth = 0;
    for (let i = 0; i < readyBody.length; i++) {
        const c = readyBody[i];
        if (c === '{' || c === '(' || c === '[') depth++;
        else if (c === '}' || c === ')' || c === ']') depth--;
        else if (readyBody.startsWith(needle, i)) return { depth, at: i };
    }
    return null;
};
const madeWindow = topLevelAt('createWindow()');
const warmedUp = topLevelAt('scheduleCpuThreadsWarmUp()');
check('P7 缓存在建窗之后、whenReady 顶层预热（不能挪进延迟回调，也不能漏掉）',
    madeWindow !== null && warmedUp !== null &&
    madeWindow.depth === warmedUp.depth && madeWindow.at < warmedUp.at,
    JSON.stringify({ madeWindow, warmedUp }));

console.log(`cpu-threads regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
