/**
 * 子进程的内存观测与上限（跨平台）。
 *
 * 单列成文件的原因：这套逻辑原本散在 main.ts 的 run-program 里，而 worker 端的
 * cases 模式（样例测试器后端）需要同样的读数与上限判定。留在主进程就只能再抄一份，
 * 两份实现对「同一个程序用了多少内存」迟早给出两个答案。
 *
 * 平台差异（有意保留，不是没做完）：
 *   · linux —— prlimit 给 RLIMIT_AS 硬上限（内核直接杀，报 OOM 退出），
 *              峰值靠轮询 /proc/<pid>/status 的 VmRSS。
 *              prlimit 带命令时是 exec 而非 fork，所以 spawn 返回的 pid 就是目标本身，
 *              轮询量到的也是它 —— 这点由 tests/memory-limit.test.js 钉住。
 *   · win32  —— 没有 prlimit。优先用 memwatch 附着读 PeakWorkingSetSize
 *              （内核维护的高水位，不受采样间隔影响），它不在位时退回 tasklist 轮询。
 *              tasklist 是「两次采样之间」的读数，短命进程的峰值永远采不到，
 *              这正是 #368「内存显示 0.0MB」的成因，所以 memwatch 在位时不再轮询。
 *   · 其它   —— ps -o rss= 轮询，只读不算上限。
 */
import * as fs from 'fs';
import { spawn } from 'child_process';

export interface MemWatchReport {
    peakBytes: number;
    privateBytes: number;
    exceeded: boolean;
}

/**
 * 读一次目标的驻留内存（字节）。读不到就返回 0 —— 调用方拿它做峰值比较，
 * 返回 0 只会少报，不会误判超限；抛错则会打断整次运行。
 */
export function readProcessMemoryBytes(pid: number | undefined): Promise<number> {
    return new Promise((resolve) => {
        if (!pid) { resolve(0); return; }
        if (process.platform === 'linux') {
            fs.readFile(`/proc/${pid}/status`, 'utf8', (error: NodeJS.ErrnoException | null, content: string) => {
                if (error) { resolve(0); return; }
                const match = content.match(/^VmRSS:\s+(\d+)\s+kB$/m);
                resolve(match ? Number(match[1]) * 1024 : 0);
            });
            return;
        }
        if (process.platform === 'win32') {
            const tasklist = spawn('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
            let output = '';
            tasklist.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
            tasklist.on('close', () => {
                const match = output.match(/"([\d,.]+)\s*K"/i);
                resolve(match ? Number(String(match[1]).replace(/[^\d]/g, '')) * 1024 : 0);
            });
            tasklist.on('error', () => resolve(0));
            return;
        }
        const ps = spawn('ps', ['-o', 'rss=', '-p', String(pid)]);
        let output = '';
        ps.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        ps.on('close', () => resolve((Number(output.trim()) || 0) * 1024));
        ps.on('error', () => resolve(0));
    });
}

/**
 * 解析 memwatch 的一行报告：`<peak> <private> <exceeded> <ok>`。
 * attach 失败或字段不足时返回 null，让调用方回退到轮询读数 —— 观测手段缺席不能
 * 变成「内存没占用」，也不能让一次正常运行报错。
 */
export function parseMemWatchReport(text: string): MemWatchReport | null {
    const raw = String(text || '').trim();
    if (!raw || raw.startsWith('attach-failed')) return null;
    const parts = raw.split(/\s+/);
    if (parts.length < 4) return null;
    const peakBytes = Number(parts[0]);
    const privateBytes = Number(parts[1]);
    const ok = Number(parts[3]) === 1;
    if (!ok || !Number.isFinite(peakBytes) || !Number.isFinite(privateBytes)) return null;
    return { peakBytes, privateBytes, exceeded: Number(parts[2]) === 1 };
}

/**
 * 附着到已在运行的进程上读内核维护的峰值。不接管 stdio、不参与进程生命周期，
 * 所以目标的启动路径完全不变，只是多一个兄弟进程负责读。
 *
 * memwatch 可执行文件的路径解析依赖 electron（数据根 + 现场编译产物），所以由调用方
 * 把路径传进来 —— 这个模块必须能在 worker 线程里用，那里没有 app 对象。
 * 传入空串（没找到/没编出来）时返回 null，调用方退回轮询。
 */
export interface MemWatchHandle {
    child: import('child_process').ChildProcess;
    report: Promise<string>;
}

const MEMWATCH_REPORT_TIMEOUT_MS = 3000;
const activeMemWatchProcesses = new Set<import('child_process').ChildProcess>();

export function startMemWatch(pid: number | undefined, limitBytes: number, memWatchPath: string): MemWatchHandle | null {
    if (process.platform !== 'win32' || !pid || !memWatchPath) {
        return null;
    }

    const limit = Math.max(0, Math.floor(Number(limitBytes) || 0));

    let child: import('child_process').ChildProcess;
    try {
        child = spawn(memWatchPath, [String(pid), String(limit)], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore'],
            shell: false
        });
    } catch (_) {
        return null;
    }

    const chunks: Buffer[] = [];
    child.stdout?.on('data', (data: Buffer) => {
        chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });

    // 报告必须限时：memwatch 卡住时不能让一次运行永远收不了尾。
    const report = new Promise<string>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks).toString('utf8'));
        };
        const timer = setTimeout(finish, MEMWATCH_REPORT_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
        child.on('close', () => { clearTimeout(timer); finish(); });
        child.on('error', () => { clearTimeout(timer); finish(); });
    });

    activeMemWatchProcesses.add(child);
    const forget = () => activeMemWatchProcesses.delete(child);
    child.on('close', forget);
    child.on('error', forget);

    return { child, report };
}

export function resolveMemWatchReport(handle: MemWatchHandle | null): Promise<MemWatchReport | null> {
    if (!handle) return Promise.resolve(null);
    return handle.report
        .then((text) => parseMemWatchReport(text))
        .catch(() => null);
}

/** 退出前清掉所有还在读峰值的 memwatch 兄弟进程（否则它们会活过主进程）。 */
export function killAllMemWatch(): void {
    for (const child of activeMemWatchProcesses) {
        try { child.kill(); } catch (_) { }
    }
    activeMemWatchProcesses.clear();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        readProcessMemoryBytes,
        parseMemWatchReport,
        startMemWatch,
        resolveMemWatchReport,
        killAllMemWatch
    };
}
