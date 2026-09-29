'use strict';

// CPU 逻辑核心数探测：os.cpus() 在部分平台首次调用要花上百毫秒且同步阻塞
// 主进程，而 get-cpu-threads 会被对拍器初始化等启动关键路径调用。这里把结果
// 与进程生命周期解耦：一次性缓存 + 启动后的空闲时段预热，让关键路径上的调用
// 基本都变成缓存命中。

const os = require('os');

const DEFAULT_CPU_THREADS = 2;
const WARM_UP_DELAY_MS = 2000;

let cachedCpuThreads = null;

function detectCpuThreads() {
    try {
        const cpus = os.cpus();
        const count = Array.isArray(cpus) && cpus.length > 0 ? cpus.length : DEFAULT_CPU_THREADS;
        return Math.max(1, count);
    } catch (_) {
        return DEFAULT_CPU_THREADS;
    }
}

function getCpuThreads() {
    if (cachedCpuThreads === null) {
        cachedCpuThreads = detectCpuThreads();
    }
    return cachedCpuThreads;
}

// 在启动后的空闲时段提前探测：那次同步开销就落在无人交互的时段，
// 而不是对拍器初始化等启动关键路径上。
function scheduleCpuThreadsWarmUp(delayMs = WARM_UP_DELAY_MS) {
    if (cachedCpuThreads !== null) return;
    const timer = setTimeout(() => {
        try {
            getCpuThreads();
        } catch (_) { }
    }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
}

function resetCpuThreadsCache() {
    cachedCpuThreads = null;
}

module.exports = {
    DEFAULT_CPU_THREADS,
    detectCpuThreads,
    getCpuThreads,
    scheduleCpuThreadsWarmUp,
    resetCpuThreadsCache
};
