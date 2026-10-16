import * as fs from 'fs';
import { spawnSync } from 'child_process';

export interface ChildProcessLike {
    pid?: number;
    kill?: (signal?: NodeJS.Signals | number) => void;
}

export function terminateProcessTree(child: ChildProcessLike | null | undefined, signal: NodeJS.Signals = 'SIGKILL'): void {
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
    try { child.kill?.(signal); } catch (_) { }
}

export function detachedSpawnOptions(): { detached?: boolean } {
    return process.platform !== 'win32' ? { detached: true } : {};
}

export interface ResourceLimitedSpawnResult {
    command: string;
    args: string[];
    hardMemoryLimit: boolean;
    limitBytes: number;
}

export function getResourceLimitedSpawn(executablePath: string, args: string[] = [], memoryLimitMb: number = 0): ResourceLimitedSpawnResult | null {
    const limitMb = Number(memoryLimitMb);
    if (process.platform !== 'linux' || !Number.isFinite(limitMb) || limitMb <= 0) {
        return null;
    }
    const prlimitPath = ['/usr/bin/prlimit', '/bin/prlimit'].find((candidate) => fs.existsSync(candidate));
    if (!prlimitPath) return null;
    const limitBytes = Math.max(1, Math.floor(limitMb * 1024 * 1024));
    return {
        command: prlimitPath,
        args: ['--as', String(limitBytes), '--', executablePath, ...args],
        hardMemoryLimit: true,
        limitBytes
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        detachedSpawnOptions,
        getResourceLimitedSpawn,
        terminateProcessTree
    };
}