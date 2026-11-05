"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.readProcessMemoryBytes = readProcessMemoryBytes;
exports.parseMemWatchReport = parseMemWatchReport;
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
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
/**
 * 读一次目标的驻留内存（字节）。读不到就返回 0 —— 调用方拿它做峰值比较，
 * 返回 0 只会少报，不会误判超限；抛错则会打断整次运行。
 */
function readProcessMemoryBytes(pid) {
    return new Promise((resolve) => {
        if (!pid) {
            resolve(0);
            return;
        }
        if (process.platform === 'linux') {
            fs.readFile(`/proc/${pid}/status`, 'utf8', (error, content) => {
                if (error) {
                    resolve(0);
                    return;
                }
                const match = content.match(/^VmRSS:\s+(\d+)\s+kB$/m);
                resolve(match ? Number(match[1]) * 1024 : 0);
            });
            return;
        }
        if (process.platform === 'win32') {
            const tasklist = (0, child_process_1.spawn)('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
            let output = '';
            tasklist.stdout?.on('data', (chunk) => { output += chunk.toString(); });
            tasklist.on('close', () => {
                const match = output.match(/"([\d,.]+)\s*K"/i);
                resolve(match ? Number(String(match[1]).replace(/[^\d]/g, '')) * 1024 : 0);
            });
            tasklist.on('error', () => resolve(0));
            return;
        }
        const ps = (0, child_process_1.spawn)('ps', ['-o', 'rss=', '-p', String(pid)]);
        let output = '';
        ps.stdout?.on('data', (chunk) => { output += chunk.toString(); });
        ps.on('close', () => resolve((Number(output.trim()) || 0) * 1024));
        ps.on('error', () => resolve(0));
    });
}
/**
 * 解析 memwatch 的一行报告：`<peak> <private> <exceeded> <ok>`。
 * attach 失败或字段不足时返回 null，让调用方回退到轮询读数 —— 观测手段缺席不能
 * 变成「内存没占用」，也不能让一次正常运行报错。
 */
function parseMemWatchReport(text) {
    const raw = String(text || '').trim();
    if (!raw || raw.startsWith('attach-failed'))
        return null;
    const parts = raw.split(/\s+/);
    if (parts.length < 4)
        return null;
    const peakBytes = Number(parts[0]);
    const privateBytes = Number(parts[1]);
    const ok = Number(parts[3]) === 1;
    if (!ok || !Number.isFinite(peakBytes) || !Number.isFinite(privateBytes))
        return null;
    return { peakBytes, privateBytes, exceeded: Number(parts[2]) === 1 };
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        readProcessMemoryBytes,
        parseMemWatchReport
    };
}
