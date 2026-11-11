'use strict';

/**
 * freopen 型程序进入 HPC 对拍引擎的行为守卫。
 *
 * 这类程序不看父进程重定向的 stdin/stdout，而是自己 `freopen("data.in","r",stdin)`
 * 按相对路径开文件。以前它们只能整轮退回渲染层的旧引擎（每测三次 IPC 往返、没有
 * native spawn、没有 worker 并行）—— 那正是「勾了 freopen 就慢一个数量级」的原因。
 *
 * 现在的做法：每个 worker × 每个角色一个**固定复用**的工作目录，输入落文件、stdin 让位、
 * 输出从文件回收。本文件钉住这件事里会静默出错的几处：
 *
 *   1. 角色之间必须分目录。两个程序都往相对路径上的同一个名字写 data.out，共用目录时
 *      后写的盖掉先写的 —— 而如果两者答案本来就相同，覆盖后判等照样「通过」，
 *      于是一次都没被看出来。所以这里用角色标记文件做结构性证据，不靠结论推断。
 *   2. worker 之间也必须分目录。并发跑时如果 slot 只按角色命名，两个 worker 会把不同的
 *      输入写进同一个路径，表现为随机 WA。
 *   3. stdin 该让位给文件。配了输入文件名还照投 stdin，等于同时存在两个真相来源。
 *   4. 输出文件不存在时回退到 stdout（旧引擎同规则）—— 直接当空会让一批程序集体变 WA。
 *   5. 回收时必须按字节上限读。readFileSync 一整份的话，一个死循环写文件的程序
 *      会把 worker 的内存吃掉，而它本来只是该被判 OLE。
 *   6. 文件名带路径分隔符时不能逃出 slot（引擎侧再洗一次，不信任渲染层洗过）。
 *   7. slot 目录数量不随测试组数增长 —— 这是「不引入新的递归删除」的前提。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾');
    process.exit(1);
}, 180000);

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

let failures = 0;
let ran = 0;
const check = (name, cond, extra = '') => {
    ran++;
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};
const skip = (name, why) => { console.log(`[SKIP] ${name} | ${why}`); };

if (process.platform === 'win32') {
    skip('freopen 引擎守卫', 'win32 没有 sh；引擎侧 freopen 由 POSIX 覆盖，Windows 走同一条 child_process 分支');
    process.exit(0);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-freopen-'));
const script = (name, body) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, '#!/bin/sh\n' + body + '\n');
    fs.chmodSync(p, 0o755);
    return p;
};
const cleanup = () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { } };

const GEN = script('gen.sh', 'echo 17 4');
// 各自在自己的 cwd 里读 data.in、写 data.out，并留下只有自己能写下的角色标记
const STD = script('std.sh', 'echo std > std.marker; cat data.in > data.out');
const CUR = script('cur.sh', 'echo cur > cur.marker; cat data.in > data.out');
// 只往 stdout 打、根本不写文件 —— 用来验「文件不存在就回退 stdout」那条兜底
const NOFILE = script('nofile.sh', 'cat >/dev/null; echo FROM_STDOUT > /dev/null; echo FROM_STDOUT');
const CHECKER_AGREE = script('chk-agree.sh', [
    'i=$(cat "$1"); o=$(cat "$2");',
    'if [ -n "$i" ] && [ "$i" = "$o" ]; then exit 0; fi',
    'exit 1'
].join('\n'));

const { CompareEngine } = require(path.join(ROOT, 'src', 'main-process', 'compare-engine.js'));

function runEngine(cfg) {
    return new Promise((resolve) => {
        const e = new CompareEngine();
        const ev = { progress: 0, errors: [], warnings: [] };
        let settled = false;
        const finish = () => { if (settled) return; settled = true; resolve(ev); };
        e.on('progress', () => { ev.progress++; });
        e.on('error', d => ev.errors.push({ type: d.type, code: d.code, message: String(d.message || ''), stdOutput: d.stdOutput, testOutput: d.testOutput, input: d.input }));
        e.on('warning', d => ev.warnings.push(d.code));
        e.on('complete', finish);
        e.on('stopped', finish);
        e.start(Object.assign({ totalTests: 1, threadCount: 1, timeLimit: 15000, generatorTimeout: 15000 }, cfg));
    });
}

const base = (extra) => Object.assign({ generator: GEN, stdExe: STD, testExe: CUR }, extra || {});
const INOUT = { freopen: { inputFile: 'data.in', outputFile: 'data.out' } };

// slot 目录：每个 worker 一个 w<startIdx>，里面 std/ 与 test/ 两个角色目录
const slotBase = path.join(TMP, 'freopen_runs');
const slotTree = () => {
    if (!fs.existsSync(slotBase)) return {};
    const out = {};
    for (const workerDir of fs.readdirSync(slotBase)) {
        const wpath = path.join(slotBase, workerDir);
        if (!fs.statSync(wpath).isDirectory()) continue;
        out[workerDir] = {};
        for (const role of fs.readdirSync(wpath)) {
            const rpath = path.join(wpath, role);
            out[workerDir][role] = fs.readdirSync(rpath).sort();
        }
    }
    return out;
};

(async () => {
    // ---- 1. 基本形态：freopen 程序在引擎里跑通，判等口径不变 ----
    const ok = await runEngine(base({ freopen: INOUT.freopen }));
    check('freopen 程序跑在新引擎上：文本判等通过，无错误',
        ok.progress === 1 && ok.errors.length === 0, JSON.stringify(ok));

    // 两个程序都只往文件写、stdout 全程为空。若引擎收的是 stdout，这里会是「两个空串相等」
    // 而判通过；收的确实是文件内容，才判得出差异，且回传的就是文件里的那句。
    const CUR_OTHER = script('cur-other.sh', 'echo 99 > data.out');
    const recovered = await runEngine(base({ testExe: CUR_OTHER, freopen: INOUT.freopen }));
    check('回收的是文件内容而不是空的 stdout（否则两个空串“相等”会假判通过）',
        recovered.errors.length === 1 && recovered.errors[0].type === 'mismatch'
        && String(recovered.errors[0].stdOutput).trim() === '17 4'
        && String(recovered.errors[0].testOutput).trim() === '99',
        JSON.stringify(recovered.errors[0] && { type: recovered.errors[0].type, std: recovered.errors[0].stdOutput, test: recovered.errors[0].testOutput }));

    // ---- 2. 角色分目录（结构性证据：标记文件不串门）----
    const tree = slotTree();
    const workerDirs = Object.keys(tree);
    const stdFiles = (tree[workerDirs[0] || ''] || {}).std || [];
    const curFiles = (tree[workerDirs[0] || ''] || {}).test || [];
    check('正解与被测各占一个角色目录（共用目录时后写的 data.out 会盖掉先写的）',
        workerDirs.length === 1 && stdFiles.length > 0 && curFiles.length > 0
        && stdFiles.indexOf('std.marker') >= 0 && stdFiles.indexOf('cur.marker') < 0
        && curFiles.indexOf('cur.marker') >= 0 && curFiles.indexOf('std.marker') < 0,
        JSON.stringify(tree));

    // ---- 3. worker 分目录 + 组数不堆目录 ----
    fs.rmSync(slotBase, { recursive: true, force: true });
    const uniq = script('gen-uniq.sh', 'date +%s%N');
    const echoIn = script('echo-in.sh', 'cat data.in > data.out');
    const par = await runEngine(base({
        generator: uniq, stdExe: echoIn, testExe: echoIn,
        totalTests: 8, threadCount: 4, freopen: INOUT.freopen
    }));
    const parTree = slotTree();
    const workers = Object.keys(parTree);
    check('4 worker 并发：8 组全过（slot 只按角色命名时两组会撞在同一个 data.in 上，表现为随机 WA）',
        par.progress === 8 && par.errors.length === 0,
        JSON.stringify({ progress: par.progress, errors: par.errors.slice(0, 2) }));
    check('每个 worker 各自一套目录，互不共用',
        workers.length === 4, JSON.stringify(workers));
    check('目录数量不随测试组数增长（8 组仍只有 4×2 个 slot，这是不引入递归删除的前提）',
        workers.reduce((n, w) => n + Object.keys(parTree[w]).length, 0) === 8,
        JSON.stringify(parTree));

    // ---- 4. stdin 让位给文件 ----
    // 让程序自己报告「stdin 里到底有没有东西」，再和一个固定输出对比：
    // 只投 stdin / 只落文件 两种情形会给出不同结论，比「两个都一样所以没报错」有说服力。
    const PROBE = script('probe.sh', 'if read line; then echo "GOT:$line" > data.out; else echo EMPTY > data.out; fi');
    const FIXED = script('fixed.sh', 'printf "GOT:17 4\\n" > data.out');
    const stdinOn = await runEngine(base({
        stdExe: PROBE, testExe: FIXED, freopen: { inputFile: '', outputFile: 'data.out' }
    }));
    check('没配输入文件名时 stdin 照投（探针读出 17 4，与固定输出一致）',
        stdinOn.progress === 1 && stdinOn.errors.length === 0,
        JSON.stringify(stdinOn.errors[0] || stdinOn));

    const stdinOff = await runEngine(base({
        stdExe: PROBE, testExe: FIXED, freopen: INOUT.freopen
    }));
    check('配了输入文件名后 stdin 被清空（探针只读到空，两个真相来源只能留一个）',
        stdinOff.errors.length === 1 && stdinOff.errors[0].type === 'mismatch'
        && String(stdinOff.errors[0].stdOutput).trim() === 'EMPTY',
        JSON.stringify(stdinOff.errors[0] && { type: stdinOff.errors[0].type, std: stdinOff.errors[0].stdOutput }));

    // ---- 5. 输出文件不存在 → 回退 stdout（旧引擎同规则）----
    const fallback = await runEngine(base({ stdExe: NOFILE, testExe: NOFILE, freopen: INOUT.freopen }));
    check('程序没写输出文件时回退到它的 stdout，不当成空输出判 WA',
        fallback.progress === 1 && fallback.errors.length === 0,
        JSON.stringify(fallback));

    // ---- 5b. 上一轮留下的 data.out 不能冒充本轮结果 ----
    // slot 目录是长期复用的：程序这一轮没写输出文件（条件写、提前 return、写错名字）时，
    // 若不清掉旧文件，读回来的就是上一轮的内容，回退分支根本不触发。
    // 设计成「第 1 轮写、第 2 轮不写」，两轮都和一个稳定写 V1 的程序比：
    //   清掉了 → 第 2 轮拿到 stdout，判出差异（对的）
    //   没清掉 → 第 2 轮拿到上一轮的 V1，两边相等，假判通过（静默错判）
    fs.rmSync(slotBase, { recursive: true, force: true });
    const COUNT = path.join(TMP, 'round-count');
    const genTwice = script('gen-twice.sh', `n=$(cat ${COUNT} 2>/dev/null || echo 0); n=$((n+1)); echo $n > ${COUNT}; if [ "$n" -le 1 ]; then echo WRITE; else echo SKIP; fi`);
    const conditional = script('cond.sh', 'if [ "$(cat data.in)" = "WRITE" ]; then echo V1 > data.out; else echo STDOUT_ONLY; fi');
    const alwaysV1 = script('always-v1.sh', 'cat data.in >/dev/null; echo V1 > data.out');
    const stale = await runEngine({
        generator: genTwice, stdExe: conditional, testExe: alwaysV1,
        totalTests: 2, threadCount: 1, timeLimit: 15000, generatorTimeout: 15000,
        freopen: INOUT.freopen
    });
    check('第二轮程序没写输出文件时不会捡到上一轮的陈旧内容（假判通过比报错危险得多）',
        stale.progress === 1 && stale.errors.length === 1
        && String(stale.errors[0].stdOutput).trim() === 'STDOUT_ONLY'
        && stale.errors[0].type === 'mismatch',
        JSON.stringify({ progress: stale.progress, errors: stale.errors.map(e => e.type + ':' + e.stdOutput) }));

    // ---- 6. 路径清洗：带分隔符的文件名不能逃出 slot ----
    fs.rmSync(slotBase, { recursive: true, force: true });
    // 程序读的是 data.in，而这次给的文件名是 ../evil.in，所以程序自己会失败 ——
    // 这里要看的不是判定结果，而是「那个名字最终落在了哪里」。
    const escapee = await runEngine(base({ freopen: { inputFile: '../evil.in', outputFile: '../evil.out' } }));
    const walk = (dir, acc) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(p, acc); else acc.push(p);
        }
        return acc;
    };
    const allFiles = walk(TMP, []).map(f => path.basename(f));
    const escaped = allFiles.filter(f => f === 'evil.in' || f === 'evil.out');
    const sanitizedInSlot = allFiles.indexOf('..evil.in') >= 0;
    check('文件名里的 ../ 被洗掉：没有任何文件落在 slot 之外，清洗后的名字留在 slot 里',
        escaped.length === 0 && sanitizedInSlot,
        JSON.stringify({ escaped: escaped, sanitizedInSlot: sanitizedInSlot, mode: escapee.mode }));

    // ---- 7. 有界读取的形状锁：回收绝不能整份吸入内存 ----
    const workerSrc = fs.readFileSync(path.join(ROOT, 'src', 'main-process', 'compare-worker.js'), 'utf8');
    const readBody = workerSrc.slice(workerSrc.indexOf('function readSlotOutput'));
    const bounded = /Math\.min\(size, MAX_WORKER_OUTPUT_BYTES\)/.test(readBody)
        && /truncated:\s*o\.truncated \|\| size > len/.test(readBody);
    check('回收按 MAX_WORKER_OUTPUT_BYTES 有界读，并把超限折算成 truncated（→ output_limit）',
        readBody.length > 40 && bounded, JSON.stringify(readBody.slice(0, 90)));
    check('读不到文件时才回退 stdout（早退分支不改判定）',
        /catch \(_\) \{\s*return o;/.test(readBody), JSON.stringify((/catch[\s\S]{0,40}/.exec(readBody) || [''])[0]));

    // ---- 8. freopen + SPJ 同时开 ----
    fs.rmSync(slotBase, { recursive: true, force: true });
    const spjRun = await runEngine(base({
        stdExe: STD, testExe: CUR, spjExe: CHECKER_AGREE, useTestlib: true, freopen: INOUT.freopen
    }));
    check('freopen 与 SPJ 同时启用：先回收文件输出，再交给 checker 判定',
        spjRun.progress === 1 && spjRun.errors.length === 0,
        JSON.stringify({ progress: spjRun.progress, errors: spjRun.errors.slice(0, 1) }));

    const spjBad = await runEngine(base({
        stdExe: STD, testExe: script('cur-wrong.sh', 'cat data.in > data.out; echo extra >> data.out'),
        spjExe: CHECKER_AGREE, useTestlib: true, freopen: INOUT.freopen
    }));
    check('freopen 下 checker 判出的差异报 spj_wa，而不是文本 mismatch',
        spjBad.errors.length === 1 && spjBad.errors[0].type === 'spj_wa',
        JSON.stringify(spjBad.errors[0]));

    if (ran === 0) { console.log('[FAIL] 一条断言都没跑'); failures++; }
    cleanup();
    console.log(`\n${ran} 条断言，${failures} 失败`);
    process.exit(failures ? 1 : 0);
})().catch(e => { cleanup(); console.log('[FAIL] 守卫自身异常: ' + ((e && e.stack) || e)); process.exit(1); });
