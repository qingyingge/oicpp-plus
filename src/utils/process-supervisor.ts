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
        // 必须写成 --as=<bytes>：util-linux 的 prlimit 把这些资源选项定义成
        // 「参数可选」，`--as 4294967296` 里的数字不会被当成限制值，而是被当成
        // 要执行的命令 —— prlimit 直接报「执行 4294967296 失败: 没有那个文件或目录」
        // 并以非零退出。后果是 Linux 上一设内存上限就跑不出结果（程序根本没启动，
        // 上层看到的是一条 RE），内存限制从来没有真正生效过。
        args: ['--as=' + String(limitBytes), '--', executablePath, ...args],
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