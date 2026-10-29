/**
 * 【归档副本，非生产代码】被否决的 timeout-wrapper 方案的唯一存留：
 *   src/main-process/timeout-wrapper.* 已于 V20 收尾时删除（该架构实测慢原生路径一倍，
 *   且 asarUnpack 未覆盖本文件，打包后子进程读不到）。
 *   本副本仅用于让 docs/BENCHMARK_REPORT.md 实验十一里「工作区版 vs V11」那张
 *   2.47x / 2.46x / 1.99x 的对照表可以继续复现。
 *   生产路径是 compare-worker-v6.js 的 native + runJs 双路径，不引用本文件。
 */
"use strict";
/**
 * timeout-wrapper.ts — 单进程超时包装器
 * 用法: node timeout-wrapper.js --timeout=1000 -- program.exe [args...]
 * 返回: 单行 JSON 到 stdout
 *   {"exitCode":0,"timedOut":false,"signal":null,"stdout":"...","stderr":"...","ms":123,"truncated":false}
 */
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024; // 64MB
const PROCESS_EXIT_GRACE_MS = 500;
function parseArgs(argv) {
    let timeoutMs = 0;
    let doubleDashIndex = -1;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg)
            continue;
        if (arg.startsWith('--timeout=')) {
            timeoutMs = parseInt(arg.slice('--timeout='.length), 10);
        }
        else if (arg === '--') {
            doubleDashIndex = i;
            break;
        }
    }
    if (doubleDashIndex === -1 || doubleDashIndex + 1 >= argv.length) {
        return null;
    }
    const command = argv[doubleDashIndex + 1];
    const args = argv.slice(doubleDashIndex + 2);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
        return null;
    }
    return { timeoutMs, command, args };
}
function captureStream(stream, limit) {
    return new Promise((resolve) => {
        const chunks = [];
        let total = 0;
        let truncated = false;
        stream.on('data', (chunk) => {
            if (truncated)
                return;
            const remaining = limit - total;
            if (remaining <= 0) {
                truncated = true;
                return;
            }
            if (chunk.length > remaining) {
                chunks.push(chunk.subarray(0, remaining));
                truncated = true;
            }
            else {
                chunks.push(chunk);
                total += chunk.length;
            }
        });
        stream.on('end', () => resolve({ data: Buffer.concat(chunks), truncated }));
        stream.on('error', () => resolve({ data: Buffer.concat(chunks), truncated }));
    });
}
async function runWithTimeout(command, args, timeoutMs, input) {
    const t0 = Date.now();
    const options = {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
        // detached: true 会导致 Linux 上进程组管理问题，子进程无法正常运行
    };
    const proc = (0, child_process_1.spawn)(command, args, options);
    // 写入 stdin（不等待 drain，直接写入并 end；小数据量直接进入管道缓冲区）
    if (input && input.length > 0) {
        try {
            const stdin = proc.stdin;
            stdin.on('error', () => { }); // 忽略 EPIPE 等错误
            stdin.write(input);
            stdin.end();
        }
        catch {
            // 忽略写入错误
        }
    }
    // 并行收集 stdout/stderr
    const [stdoutRes, stderrRes] = await Promise.all([
        captureStream(proc.stdout, MAX_OUTPUT_BYTES),
        captureStream(proc.stderr, MAX_OUTPUT_BYTES)
    ]);
    // 等待进程退出或超时
    let exitCode = null;
    let signal = null;
    let timedOut = false;
    const waitPromise = new Promise((resolve) => {
        proc.on('close', (code, sig) => {
            exitCode = code;
            signal = sig;
            resolve();
        });
        proc.on('error', () => resolve());
    });
    if (timeoutMs > 0) {
        const timeoutPromise = new Promise((resolve) => {
            const timer = setTimeout(() => {
                timedOut = true;
                // 尝试杀死进程
                try {
                    proc.kill('SIGKILL');
                }
                catch { }
                // 给一点时间让进程真正退出
                setTimeout(resolve, PROCESS_EXIT_GRACE_MS);
            }, timeoutMs);
            proc.on('close', () => clearTimeout(timer));
        });
        await Promise.race([waitPromise, timeoutPromise]);
    }
    else {
        await waitPromise;
    }
    // 如果进程还没退出，强制等待一下
    if (exitCode === null && !timedOut) {
        await new Promise(r => setTimeout(r, PROCESS_EXIT_GRACE_MS));
    }
    const ms = Date.now() - t0;
    return {
        exitCode,
        timedOut,
        signal,
        stdout: stdoutRes.data.toString('utf8').replace(/\r\n/g, '\n'),
        stderr: stderrRes.data.toString('utf8').replace(/\r\n/g, '\n'),
        ms,
        truncated: stdoutRes.truncated || stderrRes.truncated
    };
}
function normalizeOutput(output) {
    return output
        .split('\n')
        .map(line => line.replace(/[ \t]+$/, ''))
        .join('\n')
        .replace(/\n+$/, '');
}
async function main() {
    const parsed = parseArgs(process.argv.slice(2));
    if (!parsed) {
        console.error('Usage: node timeout-wrapper.js --timeout=<ms> -- <command> [args...]');
        process.exit(1);
    }
    const { timeoutMs, command, args } = parsed;
    // CLI 使用时从 stdin 读取输入
    let input;
    if (!process.stdin.isTTY) {
        const chunks = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        input = Buffer.concat(chunks);
        if (input.length === 0)
            input = undefined;
    }
    try {
        const result = await runWithTimeout(command, args, timeoutMs, input);
        // 输出归一化用于比对
        const normalizedStdout = normalizeOutput(result.stdout);
        const normalizedStderr = normalizeOutput(result.stderr);
        console.log(JSON.stringify({
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            signal: result.signal,
            stdout: normalizedStdout,
            stderr: normalizedStderr,
            ms: result.ms,
            truncated: result.truncated
        }));
    }
    catch (e) {
        console.error(JSON.stringify({
            exitCode: -1,
            timedOut: false,
            signal: null,
            stdout: '',
            stderr: String(e),
            ms: 0,
            truncated: false
        }));
        process.exit(1);
    }
}
main();
