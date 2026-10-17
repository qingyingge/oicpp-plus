'use strict';

const fs = require('fs');
const { spawn } = require('child_process');

// Windows 的 taskkill 一次要 100~300ms，spawnSync 会同步阻塞主进程事件循环
// （对拍超时、run-program 超时、关终端等路径都会踩到）。
// 这里改为异步执行：taskkill /T 负责连坐子孙进程；只有它没生效时才补 kill 目标进程。
const TASKKILL_FALLBACK_MS = 500;
const TASKKILL_HARD_TIMEOUT_MS = 2000;

function killDirectly(child, signal) {
    try { child.kill(signal); } catch (_) { }
}

function isStillRunning(child) {
    return child.exitCode === null && child.signalCode === null;
}

function terminateProcessTree(child, signal = 'SIGKILL') {
    if (!child || !child.pid) return;
    if (process.platform === 'win32') {
        // 必须让 taskkill 抢先拿到进程树快照，所以这里不立刻 kill 目标进程，
        // 否则 /T 找不到父进程就会漏掉子孙（gdb 拉起的被调试程序就是这样）。
        let killer = null;
        try {
            killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore'
            });
        } catch (spawnError) {
            killDirectly(child, signal);
            return;
        }
        if (killer.unref) killer.unref();
        const fallback = () => { if (isStillRunning(child)) killDirectly(child, signal); };
        killer.on('error', fallback);
        killer.on('close', (code) => { if (code !== 0) fallback(); });
        // taskkill 自身卡死时的兜底，避免目标进程永远活着
        const hardTimeout = setTimeout(fallback, TASKKILL_HARD_TIMEOUT_MS);
        if (hardTimeout.unref) hardTimeout.unref();
        return;
    }
    try {
        process.kill(-child.pid, signal);
        return;
    } catch (_) { }
    killDirectly(child, signal);
}

function detachedSpawnOptions() {
    return process.platform !== 'win32' ? { detached: true } : {};
}

function getResourceLimitedSpawn(executablePath, args = [], memoryLimitMb = 0) {
    const limitMb = Number(memoryLimitMb);
    if (process.platform !== 'linux' || !Number.isFinite(limitMb) || limitMb <= 0) {
        return null;
    }
    const prlimitPath = ['/usr/bin/prlimit', '/bin/prlimit'].find((candidate) => fs.existsSync(candidate));
    if (!prlimitPath) return null;
    const limitBytes = Math.max(1, Math.floor(limitMb * 1024 * 1024));
    return {
        command: prlimitPath,
        args: ['--as', String(limitBytes), '--', executablePath, ...(Array.isArray(args) ? args : [])],
        hardMemoryLimit: true,
        limitBytes
    };
}

module.exports = {
    detachedSpawnOptions,
    getResourceLimitedSpawn,
    terminateProcessTree
};
