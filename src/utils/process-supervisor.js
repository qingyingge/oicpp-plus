'use strict';

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

module.exports = {
    detachedSpawnOptions,
    terminateProcessTree
};
