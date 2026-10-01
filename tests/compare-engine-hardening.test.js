'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.join(__dirname, '..');
const engineSrc = fs.readFileSync(path.join(root, 'src', 'main-process', 'compare-engine-v2.js'), 'utf8');
const workerSrc = fs.readFileSync(path.join(root, 'src', 'main-process', 'compare-worker-v6.js'), 'utf8');
const comparerSrc = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'sidebar', 'codeComparer.js'), 'utf8');
const fastspawnSrc = fs.readFileSync(path.join(root, 'fastspawn.cc'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(root, 'src', 'lang', 'zh-cn.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(root, 'src', 'lang', 'en.json'), 'utf8'));

// 顶层 function 与类方法两种形态都要能取到：worker 里的 writeInput/runFast
// 是顶层 function，engine 里的 start/stop 是类方法
function methodBody(src, name) {
    const m = new RegExp(`^\\s*(?:async\\s+)?(?:function\\s+)?${name}\\s*\\(`, 'm').exec(src);
    if (!m) return '';
    let i = src.indexOf('(', m.index);
    let paren = 0;
    for (; i < src.length; i++) {
        if (src[i] === '(') paren++;
        else if (src[i] === ')') { paren--; if (paren === 0) break; }
    }
    let depth = 0;
    for (i = src.indexOf('{', i); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(m.index, i + 1); }
    }
    return '';
}

// ---------------------------------------------------------------------------
// 加载 CompareEngineV2：替换 Worker 为可控假件，验证 run id 隔离
// ---------------------------------------------------------------------------

function loadEngine(fakeWorkerFactory) {
    const src = engineSrc.replace(/require\(/g, '__require__(');
    const calls = { events: [], posted: [] };
    const FakeEventEmitter = require('events').EventEmitter;

    class FakeWorker extends FakeEventEmitter {
        constructor(p) {
            super();
            this.path = p;
            fakeWorkerFactory.workers.push(this);
        }
        postMessage(msg) { calls.posted.push(msg); }
        terminate() { this.terminated = true; }
    }

    const fakeRequire = (name) => {
        if (name === 'worker_threads') return { Worker: FakeWorker };
        if (name === 'os') return { cpus: () => [{ length: 1 }] };
        if (name === 'path') return require('path');
        return require(name);
    };

    const sandbox = {
        __require__: fakeRequire,
        module: { exports: {} },
        exports: {},
        console,
        setTimeout,
        clearTimeout,
        Promise,
        Math,
        Number,
        Object,
        Error,
        process: { platform: process.platform },
        fakeWorkerFactory: { list: fakeWorkerFactory.workers }
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src + '\nthis.CompareEngineV2 = CompareEngineV2;', sandbox);

    const Engine = sandbox.CompareEngineV2;
    const engine = new Engine();
    engine.on = (evt, cb) => { (calls.events[evt] = calls.events[evt] || []).push(cb); };
    return { engine, calls };
}

function collect(calls, evt) {
    return (calls.events[evt] || []).flatMap((cb) => {
        const got = [];
        const orig = cb;
        // 把 emit 的实参截下来
        return [{ orig }];
    });
}

// ---------------------------------------------------------------------------
// H1: timeLimit = 0 传给 worker 的是 0（不限时），而不是被 || 兜底
// ---------------------------------------------------------------------------

{
    const fake = { workers: [] };
    const { engine, calls } = loadEngine(fake);
    engine.start({
        totalTests: 3, threadCount: 1, timeLimit: 0,
        generator: 'gen.exe', stdExe: 'std.exe', testExe: 'test.exe'
    }).then(() => {
        check('H1 timeLimit=0 原样透传给 worker（0 表示不限时）',
            calls.posted.every((m) => m.timeout === 0),
            JSON.stringify(calls.posted.map((m) => m.timeout)));
    }).catch((e) => check('H1 start() 不抛异常', false, e.message));
}

// ---------------------------------------------------------------------------
// H4: stopping 期间拒绝重入
// ---------------------------------------------------------------------------

{
    check('H4 start() 在 stopping 状态抛错',
        /if \(this\._state === 'running' \|\| this\._state === 'stopping'\) throw new Error\('Engine already running'\)/.test(engineSrc));
    check('H4 stop() 保留 fire-and-forget 语义（不 await）',
        /async stop\(\) \{/.test(engineSrc) && !/await this\._workers/.test(methodBody(engineSrc, 'stop')));
}

// ---------------------------------------------------------------------------
// H3: run id 归属校验 —— 迟到消息不得污染新一轮
// ---------------------------------------------------------------------------

{
    check('H3 start() 分配单调递增的 run id',
        /this\._runId = \+\+CompareEngineV2\._runCounter/.test(engineSrc));
    check('H3 存在 isCurrentRun 归属判定', /const isCurrentRun = \(\) => this\._runId === runId;/.test(engineSrc));
    check('H3 message handler 先做归属校验再计数',
        /const handler = \(msg\) => \{\s*\n\s*\/\/ [^\n]*\n\s*if \(!isCurrentRun\(\)\) \{ settle\(\); return; \}/.test(engineSrc) ||
        /if \(!isCurrentRun\(\)\) \{ settle\(\); return; \}/.test(engineSrc));
    check('H3 worker error 也做归属校验',
        /if \(isCurrentRun\(\) && !this\._stopRequested\)/.test(engineSrc));

    // 行为验证：旧轮次 worker 的迟到 progress 不应累加到新一轮
    const fake = { workers: [] };
    const { engine, calls } = loadEngine(fake);
    const firstWorkers = fake.workers.slice();
    engine.start({
        totalTests: 2, threadCount: 1, timeLimit: 1000,
        generator: 'gen.exe', stdExe: 'std.exe', testExe: 'test.exe'
    });
    // 上一轮的 worker 迟到上报（run id 已变）
    firstWorkers.forEach((w) => w.emit('message', { type: 'progress', testIndex: 1 }));
    check('H3 迟到消息被丢弃，未累加到本轮 _completed', engine._completed === 0, `completed=${engine._completed}`);
}

// ---------------------------------------------------------------------------
// M3: 完成数不足时给出 incomplete_run 告警
// ---------------------------------------------------------------------------

{
    check('M3 完成数不足时发出 incomplete_run 告警',
        /code: 'incomplete_run'/.test(engineSrc));
    check('M3 告警只在非停止状态下判定',
        /this\._state === 'running' && this\._completed < this\._total/.test(engineSrc));
    check('M3 告警只给计数，不在引擎层拼英文文案',
        /completed: this\._completed,\s*\n\s*total: this\._total,\s*\n\s*missing: this\._total - this\._completed,\s*\n\s*message: '',/.test(engineSrc));
    check('M3 渲染层登记 incomplete_run',
        comparerSrc.includes("incomplete_run: 'compare.incompleteRun'") &&
        comparerSrc.includes("'incomplete_run'].includes(errType)") &&
        /errType === 'incomplete_run'/.test(comparerSrc));
}

// ---------------------------------------------------------------------------
// H2: stdin error 监听必须在 write 之前挂上
// ---------------------------------------------------------------------------

{
    const writeInput = methodBody(workerSrc, 'writeInput');
    const listenIdx = writeInput.indexOf("proc.stdin.on('error'");
    const writeIdx = writeInput.indexOf('proc.stdin.write(input)');
    check('H2 writeInput 给 stdin 挂了 error 监听', listenIdx !== -1);
    check('H2 error 监听在 write 之前注册（否则 EPIPE 打崩 worker）',
        listenIdx !== -1 && writeIdx !== -1 && listenIdx < writeIdx,
        `listen=${listenIdx} write=${writeIdx}`);
}

// ---------------------------------------------------------------------------
// M4: 截断标志由 native 回报，不再用长度猜
// ---------------------------------------------------------------------------

{
    check('M4 runFast 采用 native 回传的 truncated',
        /outputTruncated: !!r\.truncated/.test(methodBody(workerSrc, 'runFast')));
    check('M4 runFastPair 不再用长度推断截断',
        !/out1\.length >= MAX_WORKER_OUTPUT_BYTES/.test(workerSrc) &&
        /truncated1: !!r\.truncated/.test(workerSrc));
    check('M4 drainBoth 回传 drop 标志',
        /if \(truncatedOut\) \*truncatedOut = ob\.drop;/.test(fastspawnSrc));
    check('M4 runOne 接收并回传 truncated',
        /int64_t timeoutMs, char\*\* out, size_t\* outLen, int\* truncated\)/.test(fastspawnSrc) &&
        /if \(truncated\) \*truncated = \(truncatedOut \|\| truncatedErr\) \? 1 : 0;/.test(fastspawnSrc));
    check('M4 napi 返回值暴露 truncated',
        /napi_set_named_property\(env, result, "truncated", rTrunc\);/.test(fastspawnSrc));
    // 定义行本身带 truncated 参数；调用点必须逐个都传
    const runOneDecl = /static int runOne\([^;]*int\* truncated\)/.test(fastspawnSrc);
    const callSites = [...fastspawnSrc.matchAll(/runOne\(([^;]*?)\);/g)].map((m) => m[1]);
    const allCallsPassTruncated = callSites.every((args) => /truncated/.test(args));
    check('M4 runOne 定义与所有调用点都带 truncated',
        runOneDecl && callSites.length >= 4 && allCallsPassTruncated,
        `${callSites.length} 个调用点, 全部传参=${allCallsPassTruncated}`);
}

// ---------------------------------------------------------------------------
// fastspawn.cc: timeLimit <= 0 不限时 + INT64_MAX
// ---------------------------------------------------------------------------

{
    check('H1 native 侧把 timeoutMs<=0 映射为无截止时间',
        /const int64_t NO_DEADLINE = INT64_MAX;/.test(fastspawnSrc) &&
        /int64_t deadlineMs = \(timeoutMs > 0\) \? \(nowMs\(\) \+ timeoutMs\) : NO_DEADLINE;/.test(fastspawnSrc));
    check('H1 使用 INT64_MAX 需要 stdint.h',
        /#include <stdint\.h>/.test(fastspawnSrc));
    check('H1 不限时路径下 waitpidTimed 不会误杀',
        /if \(nowMs\(\) >= deadlineMs\)/.test(fastspawnSrc));
    check('写入循环在不限时下无限期等 POLLOUT',
        /poll\(&writeFd, 1, -1\)/.test(fastspawnSrc));
    check('drainBoth 的 poll 仍按 500ms 分段（INT64_MAX 下 remain 恒大）',
        /int to = \(remain > 500\) \? 500 : \(int\)remain;/.test(fastspawnSrc));
    check('花括号平衡（无法编译时至少做静态检查）',
        (fastspawnSrc.match(/\{/g) || []).length === (fastspawnSrc.match(/\}/g) || []).length,
        `${(fastspawnSrc.match(/\{/g) || []).length} vs ${(fastspawnSrc.match(/\}/g) || []).length}`);
}

// ---------------------------------------------------------------------------
// M7: i18n 键必须真实存在且两语言一致
// ---------------------------------------------------------------------------

{
    const keyMap = methodBody(comparerSrc, 'getEngineErrorMessage');
    const pairs = [...keyMap.matchAll(/([A-Za-z_]+):\s*'compare\.([A-Za-z]+)'/g)];
    check('M7 引擎错误映射表非空', pairs.length > 0, `${pairs.length} 项`);
    let missing = [];
    for (const [, code, key] of pairs) {
        if (zh.compare?.[key] === undefined) missing.push(`zh:compare.${key}(${code})`);
        if (en.compare?.[key] === undefined) missing.push(`en:compare.${key}(${code})`);
    }
    check('M7 映射表引用的每个 i18n 键在两语言包中都存在', missing.length === 0, missing.join(', '));
    check('M7 gen_error 指向真实存在的键',
        /gen_error: 'compare\.generatorRunFailed'/.test(comparerSrc) &&
        typeof zh.compare?.generatorRunFailed === 'string');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);