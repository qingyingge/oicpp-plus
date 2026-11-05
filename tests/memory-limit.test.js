'use strict';

/**
 * Linux 内存上限的调用形式守卫。
 *
 * 背景：util-linux 的 prlimit 把 --as 这类资源选项定义成「参数可选」。
 * 写成 `--as 4294967296` 时那个数字不会被当成限制值，而是被当成**要执行的命令**：
 *   prlimit: 执行 4294967296 失败: 没有那个文件或目录
 * 并以非零退出。后果不是「限制没生效」这么轻 —— 程序根本没被启动，上层看到的是一条
 * 莫名其妙的 RE，于是 Linux 上只要设了内存上限就跑不出结果，而这个功能从上线起就这样。
 *
 * 这里钉两件事：
 *   1. 必须写成 --as=<bytes>，且 `--` 分隔符还在原位。
 *   2. 包一层 prlimit 之后 pid 不能变。/proc/<pid> 的峰值采样测的就是 spawn 返回的那个
 *      pid；一旦 prlimit 改成 fork 出目标，测到的就是壳（几十 KB），内存显示永远接近 0，
 *      超限判定也永远不触发。这正是 mywwzh/oicpp#368 那类「内存显示 0.0MB」的形状。
 */

const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

let failures = 0;
let ran = 0;
const check = (name, cond, extra = '') => {
    ran++;
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const supervisor = require(path.join(ROOT, 'src', 'utils', 'process-supervisor.js'));
const getResourceLimitedSpawn = supervisor.getResourceLimitedSpawn;

const prlimitPath = ['/usr/bin/prlimit', '/bin/prlimit'].find(p => { try { return require('fs').existsSync(p); } catch (_) { return false; } });

check('函数存在且导出（main.ts 与 worker 共用这一个实现）',
    typeof getResourceLimitedSpawn === 'function', typeof getResourceLimitedSpawn);

// 不该上限制的组合一律返回 null，调用方据此走普通 spawn
check('没设上限 / 非法上限时返回 null（不能凭空包一层壳）',
    getResourceLimitedSpawn('/bin/true', [], 0) === null
    && getResourceLimitedSpawn('/bin/true', [], NaN) === null
    && getResourceLimitedSpawn('/bin/true', [], -5) === null, '');

if (process.platform !== 'linux' || !prlimitPath) {
    console.log(`[SKIP] prlimit 实测 | 平台 ${process.platform}，prlimit ${prlimitPath || '缺席'}`);
    console.log(`\n${ran} 条断言，${failures} 失败`);
    process.exit(failures ? 1 : 0);
}

const spec = getResourceLimitedSpawn('/bin/echo', ['hi'], 512);
check('拼出来的参数是 --as=<bytes> + -- 分隔符（空格形式会被 prlimit 当成命令名）',
    spec && /^--as=\d+$/.test(spec.args[0]) && spec.args[1] === '--' && spec.command === prlimitPath,
    JSON.stringify(spec && { command: spec.command, args: spec.args.slice(0, 3) }));

// 真跑一次：老写法在这里会直接失败（prlimit 试图 exec 那个数字）
const runOnce = (args) => new Promise((resolve) => {
    const p = cp.spawn(prlimitPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d.toString(); });
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('close', (code) => resolve({ pid: p.pid, out: out.trim(), err: err.trim(), code: code }));
});

const built = getResourceLimitedSpawn('/bin/sh', ['-c', 'echo $$'], 4096);

(async () => {
    const r = await runOnce(built.args);
    check('prlimit 真的接受这套参数并启动了目标（旧写法在这里非零退出、目标根本没跑）',
        r.code === 0 && /^\d+$/.test(r.out),
        JSON.stringify({ code: r.code, out: r.out.slice(0, 20), err: r.err.slice(0, 60) }));

    // 关键：pid 必须是目标自己，不是壳。prlimit 若 fork，spawn 返回的 pid 就量不到目标。
    const self = await runOnce(['--as=4294967296', '--', '/bin/sh', '-c', 'echo $$']);
    check('包一层 prlimit 后 pid 不变（/proc 峰值采样量的就是 spawn 返回的那个 pid）',
        self.code === 0 && String(self.pid) === self.out,
        JSON.stringify({ spawnPid: self.pid, targetPid: self.out }));

    // 反向对照：证明上面两条不是恒真 —— 把参数改回历史写法必须让目标启动失败
    const legacy = await runOnce(['--as', '4294967296', '--', '/bin/sh', '-c', 'echo $$']);
    check('历史写法（空格形式）确实会失败：这一条不成立就说明上面的守卫是空转',
        legacy.code !== 0 || !/^\d+$/.test(legacy.out),
        JSON.stringify({ code: legacy.code, out: legacy.out.slice(0, 20), err: legacy.err.slice(0, 60) }));

    if (ran === 0) { console.log('[FAIL] 一条断言都没跑'); failures++; }
    console.log(`\n${ran} 条断言，${failures} 失败`);
    process.exit(failures ? 1 : 0);
})().catch(e => { console.log('[FAIL] 守卫自身异常: ' + ((e && e.stack) || e)); process.exit(1); });
