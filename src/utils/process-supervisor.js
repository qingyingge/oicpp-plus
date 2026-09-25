'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

function terminateProcessTree(child, signal = 'SIGKILL') {
    if (!child || !child.pid) return;
    if (process.platform === 'win32') {
        const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
        });
        if (result.status === 0) return;
    } else {
        try {
            process.kill(-child.pid, signal);
            return;
        } catch (_) { }
    }
    try { child.kill(signal); } catch (_) { }
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
