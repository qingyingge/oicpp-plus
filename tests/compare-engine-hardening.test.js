'use strict';

// 对拍引擎（compare-engine-v2）的加固点：超时归一化、分片、run id 隔离、
// 截断标记转发、完成数不足告警、停止语义。
//
// 这一批原先有两条致命结构问题：
//   1) H1/H3 的检查写在 `engine.start().then(...)` 里，而文件末尾是同步
//      `process.exit(failures ? 1 : 0)` —— then 回调永远排不到，断言从来没执行过；
//      更要命的是 `calls.posted.every(...)` 在 posted 为空时恒为 true，
//      旧的沙箱没传 __dirname，start() 在 path.join 处就抛了，posted 一直是空数组，
//      于是「0 原样透传」这条守卫是拿着零个 worker 在给自己发绿。
//   2) 大量守卫锁的是源码字面量，tsc printer 一拆行就误报，语义错了却照样绿。
// 现在整个文件跑在异步 main 里，每条断言都等真实事件落地；确实跑不了的
// （worker 里的 spawn 顺序、fastspawn.cc 的出参）保留文本锁并注明原因。

const fs = require('fs');
const path = require('path');
const events = require('events');
const { classMethod, funcDecl, toFn } = require('./fixtures/source-extract');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const engineSrc = read('src', 'main-process', 'compare-engine-v2.js');
const workerSrc = read('src', 'main-process', 'compare-worker-v6.js');
const comparerSrc = read('src', 'renderer', 'js', 'sidebar', 'codeComparer.js');
const i18nSrc = read('src', 'renderer', 'js', 'i18n.js');
const fastspawnSrc = read('fastspawn.cc');
const zh = JSON.parse(read('src', 'lang', 'zh-cn.json'));
const en = JSON.parse(read('src', 'lang', 'en.json'));

const ENGINE_DIR = path.join(root, 'src', 'main-process');
const CPU_COUNT = 8;
const EVENTS = ['progress', 'error', 'warning', 'complete', 'stopped'];

// ---------------------------------------------------------------------------
// 假 worker 的引擎：把 require( 换名后用 new Function 直接跑真实源码。
// 用 new Function 而不是 vm.createContext，是为了拿到真实的全局对象集合 ——
// 旧沙箱只列了九个构造器，还漏了 __dirname，导致 start() 提前抛出而断言空跑。
// ---------------------------------------------------------------------------

function loadEngine(throwOnCreate = 0) {
    const workers = [];
    let alreadyThrew = false;
    // stop() 排的「2 秒后收尸」定时器在这里必须是可观测的：真实句柄没暴露出来，
    // 进程内看不到「退出时被它按住」，而漏 .unref() 的代价正是主进程退不掉。
    // 把它换成记账桩（形参遮蔽全局，只影响引擎函数作用域内），unref 与到期回调都能直接数。
    const timers = [];
    const fakeSetTimeout = (fn, ms) => {
        const rec = { fn, ms, unref: 0, ref: 0 };
        rec.handle = {
            unref: () => { rec.unref++; return rec.handle; },
            ref: () => { rec.ref++; return rec.handle; },
            hasRef: () => rec.unref === 0
        };
        timers.push(rec);
        return rec.handle;
    };
    class FakeWorker extends events.EventEmitter {
        constructor(workerPath) {
            super();
            // 让第 N 个 worker 建不出来：start() 会在半途抛进 catch，
            // 而前面已经建好的 worker 从没收到过 done，监听器仍然挂着 ——
            // 这才是 isCurrentRun() 唯一能被真实触发的窗口。只炸一次，
            // 否则下一轮重建 worker 会撞上同一个条件，把隔离场景变成报错场景。
            if (throwOnCreate && !alreadyThrew && workers.length + 1 === throwOnCreate) {
                alreadyThrew = true;
                throw new Error('worker spawn failed');
            }
            this.path = workerPath;
            this.posted = [];
            this.terminated = 0;
            workers.push(this);
        }
        postMessage(msg) { this.posted.push(msg); }
        terminate() { this.terminated++; }
        // 测试驱动用：模拟 worker 主动上报一条消息
        report(msg) { this.emit('message', msg); }
        emit(evt, ...args) {
            // EventEmitter 在没人监听 error 时会把 error 直接抛出来，真 worker 不会。
            // settle() 摘掉监听器之后再触发 error 恰好是这里要观察的场景，所以没人听就当无事发生。
            if (evt === 'error' && this.listenerCount('error') === 0) return false;
            return super.emit(evt, ...args);
        }
    }
    const fakeRequire = (name) => {
        if (name === 'worker_threads') return { Worker: FakeWorker };
        if (name === 'os') return { cpus: () => new Array(CPU_COUNT).fill({ model: 'fake' }) };
        return require(name);
    };
    const exportsObj = {};
    const factory = new Function('module', 'exports', '__dirname', '__require__', 'setTimeout', 'clearTimeout',
        engineSrc.replace(/require\(/g, '__require__(') + '\nreturn CompareEngineV2;');
    const Engine = factory({ exports: exportsObj }, exportsObj, ENGINE_DIR, fakeRequire,
        fakeSetTimeout, () => { });
    return { Engine, workers, timers };
}

function makeEngine(throwOnCreate = 0) {
    const { Engine, workers, timers } = loadEngine(throwOnCreate);
    const engine = new Engine();
    const seen = [];
    for (const evt of EVENTS) engine.on(evt, (payload) => seen.push({ evt, payload }));
    return {
        engine,
        workers,
        seen,
        timers,
        // 到期时真的发生什么，由用例点名驱动，不靠睡 2 秒
        fireTimers: () => { for (const t of timers.splice(0, timers.length)) t.fn(); },
        of: (evt) => seen.filter((s) => s.evt === evt).map((s) => s.payload),
        start: (config) => engine.start(Object.assign({
            totalTests: 5, threadCount: 1, generator: 'gen.exe', stdExe: 'std.exe', testExe: 'test.exe'
        }, config))
    };
}

// 让本轮跑完：前 doneTests 个 worker 各上报若干 progress，然后 done
// 返回实际上报过的 testIndex 序列，供断言逐条比对转发是否保序保值
function finishRun(ctx, { completed = 5, doneWorkers = null, withErrors = 0 } = {}) {
    const workers = ctx.workers;
    const list = doneWorkers === null ? workers : workers.slice(0, doneWorkers);
    let left = completed;
    const fed = [];
    workers.forEach((w, i) => {
        // 均摊到每个 worker，保证 completed 精确可控
        const share = i === workers.length - 1 ? left : Math.max(0, Math.ceil(left / (workers.length - i)));
        for (let k = 0; k < share; k++) {
            const testIndex = i * 10 + k + 1;
            fed.push(testIndex);
            w.report({ type: 'progress', testIndex });
            left--;
        }
        for (let k = 0; k < (i === 0 ? withErrors : 0); k++) {
            w.report({ type: 'error', testIndex: 900 + k, kind: 'std_tle', code: 'std_timeout' });
        }
    });
    list.forEach((w) => w.report({ type: 'done' }));
    return fed;
}

// await 一个永不 settle 的 promise 时，Node 不会因为「还有代码没跑」而报错：
// 事件循环被抽干就直接以 0 退出，后面的断言一条不剩，看着还是绿的。
// 本项目里最容易触发的场景是「坏配置被放行 → start() 真的跑了一轮 → 等 worker 的 done」。
// 所以留一个不带 unref 的看门狗定时器：正常收尾时 process.exit 会把它带走，
// 只有主流程半途挂死才会等到它，此时必须报 FAIL 而不是静默成功。
setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：某个 await 永不 settle（多半是守卫被变异掉后坏配置真的跑起来了）');
    process.exit(1);
}, 20000);

(async () => {
    // ---- 先证明这套假件真的能把引擎跑起来（否则后面全是空跑） ----

    {
        const ctx = makeEngine();
        check('引擎类加载成功', typeof ctx.engine === 'object' && typeof ctx.engine.start === 'function');
        const running = ctx.start({ totalTests: 5, threadCount: 2 });
        check('start() 在首个 await 前就同步建好 worker', ctx.workers.length === 2, `workers=${ctx.workers.length}`);
        check('worker 路径按 __dirname 解析到 compare-worker-v6.js',
            ctx.workers[0].path === path.join(ENGINE_DIR, 'compare-worker-v6.js'), ctx.workers[0].path);
        check('start() 期间状态是 running', ctx.engine.state === 'running', ctx.engine.state);
        check('派发给 worker 的消息是 worker 侧真的在分发的那种',
            ctx.workers[0].posted[0].type === 'run-tests'
            && new RegExp(`['"]${ctx.workers[0].posted[0].type}['"]`).test(workerSrc),
            JSON.stringify(ctx.workers[0].posted[0].type));
        const fed = finishRun(ctx, { completed: 5 });
        await running;
        check('跑完后状态回到 idle', ctx.engine.state === 'idle', ctx.engine.state);
        check('每个 worker 都被 terminate', ctx.workers.every((w) => w.terminated === 1),
            JSON.stringify(ctx.workers.map((w) => w.terminated)));
        check('complete 事件恰好一次', ctx.of('complete').length === 1);
        check('progress 事件按完成数逐条发出', ctx.of('progress').length === 5, `progress=${ctx.of('progress').length}`);
        check('progress.current 是 1..5 递增的完成数，不是总数',
            JSON.stringify(ctx.of('progress').map((p) => p.current)) === '[1,2,3,4,5]',
            JSON.stringify(ctx.of('progress').map((p) => p.current)));
        check('progress.total 全程等于总组数',
            ctx.of('progress').every((p) => p.total === 5) && ctx.of('progress').length === 5);
        check('progress.testIndex 原样转达 worker 报的组号（保序保值）',
            JSON.stringify(ctx.of('progress').map((p) => p.testIndex)) === JSON.stringify(fed),
            `${JSON.stringify(ctx.of('progress').map((p) => p.testIndex))} vs ${JSON.stringify(fed)}`);
        // done 之后 settle() 必须把监听器摘掉：_runId 要到下一轮 start() 才换，
        // 本轮结束后的残留消息仍然「属于当前 run」，只能靠摘监听器挡住
        ctx.workers[0].report({ type: 'progress', testIndex: 99 });
        ctx.workers[0].report({ type: 'error', testIndex: 99, kind: 'std_re', code: 'std_error' });
        ctx.workers[0].emit('error', new Error('late crash'));
        ctx.workers[0].emit('exit', 1);
        check('worker 报过 done 之后再发消息/再崩/再退出，都不再计数、不再广播、不再补发 complete',
            ctx.of('progress').length === 5 && ctx.of('error').length === 0
            && ctx.of('complete').length === 1 && ctx.engine._completed === 5,
            `progress=${ctx.of('progress').length} error=${ctx.of('error').length} `
            + `complete=${ctx.of('complete').length} completed=${ctx.engine._completed}`);
    }

    // ---- H1: timeLimit / generatorTimeout 归一化（0 = 不限时，不能被 || 兜底） ----

    {
        const postedFor = async (config) => {
            const ctx = makeEngine();
            const running = ctx.start(config);
            const posted = ctx.workers.map((w) => w.posted[0]);
            finishRun(ctx, { completed: config.totalTests });
            await running;
            return posted;
        };
        const timeoutOf = (config) => postedFor(Object.assign({ totalTests: 2, threadCount: 2 }, config))
            .then((list) => list.map((m) => m.timeout));

        check('timeLimit=5000 原样透传', (await timeoutOf({ timeLimit: 5000 })).join(',') === '5000,5000');
        check('timeLimit=0 透传 0（不限时），而不是被兜底成 5000',
            (await timeoutOf({ timeLimit: 0 })).join(',') === '0,0',
            JSON.stringify(await timeoutOf({ timeLimit: 0 })));
        check('timeLimit 缺失是 0 而不是默认值', (await timeoutOf({})).join(',') === '0,0');
        check('timeLimit 负数是 0（不做 abs 也不当 1ms）', (await timeoutOf({ timeLimit: -5 })).join(',') === '0,0');
        check('timeLimit=Infinity 是 0', (await timeoutOf({ timeLimit: Infinity })).join(',') === '0,0');
        check('timeLimit=NaN 是 0', (await timeoutOf({ timeLimit: NaN })).join(',') === '0,0');

        const gen = (await postedFor({ totalTests: 2, threadCount: 2, timeLimit: 1000, generatorTimeout: 0 }))
            .map((m) => m.generatorTimeout);
        check('generatorTimeout=0 独立透传，不被 timeLimit 顶替',
            gen.join(',') === '0,0', JSON.stringify(gen));
        const both = await postedFor({ totalTests: 2, threadCount: 2, timeLimit: 1000, generatorTimeout: 250 });
        check('两个字段各走各的：timeout=1000 / generatorTimeout=250',
            both.every((m) => m.timeout === 1000 && m.generatorTimeout === 250), JSON.stringify(both));
    }

    // ---- 分片：区间必须无缝无重叠地覆盖 1..totalTests ----

    {
        const shardsFor = async (totalTests, threadCount) => {
            const ctx = makeEngine();
            const running = ctx.start({ totalTests, threadCount });
            const shards = ctx.workers.map((w) => ({ start: w.posted[0].startIdx, count: w.posted[0].count }));
            finishRun(ctx, { completed: totalTests });
            await running;
            return shards;
        };
        const covered = (shards) => {
            const seenIdx = new Set();
            for (const s of shards) {
                for (let i = s.start; i < s.start + s.count; i++) {
                    if (seenIdx.has(i)) return { dup: i };
                    seenIdx.add(i);
                }
            }
            for (let i = 1; i <= shards.total; i++) if (!seenIdx.has(i)) return { missing: i };
            return { ok: true };
        };
        const probe = (shards, total) => Object.assign(shards, { total });

        const five = probe(await shardsFor(5, 2), 5);
        check('5 组 2 线程切成 3+2', JSON.stringify(five) === '[{"start":1,"count":3},{"start":4,"count":2}]',
            JSON.stringify(five));
        check('切分覆盖 1..5 且不重不漏', covered(five).ok === true, JSON.stringify(covered(five)));

        const one = probe(await shardsFor(1, 8), 1);
        check('只有 1 组时不会切出空 worker', one.length === 1, JSON.stringify(one));
        check('1 组的切分仍覆盖到位', covered(one).ok === true, JSON.stringify(one));

        const many = probe(await shardsFor(3, 100), 3);
        check('线程数超过组数时按组数收敛', many.length === 3, `workers=${many.length}`);
        check('线程数超过组数时切分仍完整', covered(many).ok === true, JSON.stringify(many));

        const capped = probe(await shardsFor(1000, 1000), 1000);
        check('线程数封顶 32', capped.length === 32, `workers=${capped.length}`);
        check('封顶后 1..1000 仍全覆盖', covered(capped).ok === true, JSON.stringify(covered(capped)));

        // 100 份 / 上限 32 片 → 每片 4 份，只有 25 片分得到用例；
        // 分不到份数的线程必须直接不建 worker，否则白起 7 个进程
        const sparse = probe(await shardsFor(100, 100), 100);
        check('分不满一片就不建空 worker（25 片而不是 32 片）',
            sparse.length === 25, `workers=${sparse.length}`);
        check('少建 worker 后 1..100 仍不重不漏', covered(sparse).ok === true, JSON.stringify(covered(sparse)));

        const defaults = probe(await shardsFor(4, undefined), 4);
        check('threadCount 缺失时按 CPU 数（8）收敛到组数', defaults.length === 4, JSON.stringify(defaults));
        const bogus = probe(await shardsFor(4, 0), 4);
        check('threadCount=0 走 CPU 数而不是 0 个 worker', bogus.length === 4, JSON.stringify(bogus));
        const negative = probe(await shardsFor(4, -3), 4);
        check('threadCount 负数走 CPU 数', negative.length === 4, JSON.stringify(negative));
        const fractional = probe(await shardsFor(4, 2.5), 4);
        check('threadCount 非整数走 CPU 数（不 Math.floor 出一个线程）',
            fractional.length === 4, JSON.stringify(fractional));
    }

    // ---- 参数校验：坏配置不得建 worker，且必须 emit 出可展示的引擎错误 ----

    {
        const rejected = async (config) => {
            const ctx = makeEngine();
            const started = ctx.start(config);
            // 正确实现里 start() 一定 settle（catch 发错误 + finally 复位状态）。
            // 直接 await 的话，一旦校验被变异掉，这行就会把整个测试挂成静默退出，
            // 所以只等一个宏任务，把「没 settle」本身当成失败证据。
            let settled = false;
            started.then(() => { settled = true; }, () => { settled = true; });
            await new Promise((resolve) => setTimeout(resolve, 0));
            return {
                settled,
                errors: ctx.of('error'),
                workers: ctx.workers.length,
                state: ctx.engine.state
            };
        };
        for (const bad of [0, -1, 1.5, 100001, 'abc', undefined, NaN]) {
            const r = await rejected({ totalTests: bad });
            check(`totalTests=${String(bad)} 被拒且不建 worker`,
                r.settled === true && r.workers === 0 && r.errors.length === 1
                && r.errors[0].type === 'engine' && r.errors[0].code === 'engine_start',
                `settled=${r.settled} workers=${r.workers} ` + JSON.stringify(r.errors.map((e) => e.message)));
        }
        const missingExe = await rejected({ stdExe: '', testExe: 'test.exe' });
        check('缺 std 路径时报错点名缺哪个', missingExe.settled === true && missingExe.errors.length === 1
            && missingExe.errors[0].message.includes('Missing executable paths')
            && missingExe.errors[0].message.includes('std='), JSON.stringify(missingExe.errors));
        const missingTest = await rejected({ stdExe: 'std.exe', testExe: '' });
        check('缺测试程序路径同样被拒（三个路径缺一不可）',
            missingTest.settled === true && missingTest.workers === 0 && missingTest.errors.length === 1
            && missingTest.errors[0].message.includes('test='), JSON.stringify(missingTest.errors));
        const blankGen = await rejected({ generator: '   ' });
        check('生成器是空白串也算没配（不 spawn 空命令）',
            blankGen.settled === true && blankGen.workers === 0 && blankGen.errors.length === 1);
        const objExe = (() => {
            const ctx = makeEngine();
            const running = ctx.start({ totalTests: 2, threadCount: 1, generator: { executablePath: 'g.exe' }, stdExe: { path: 's.exe' }, testExe: 't.exe' });
            const posted = ctx.workers.map((w) => w.posted[0]);
            finishRun(ctx, { completed: 2 });
            return running.then(() => posted);
        })();
        const posted = await objExe;
        check('可执行文件传对象时按 executablePath/path 解析',
            posted[0].stdPath === 's.exe' && typeof posted[0].gen === 'object', JSON.stringify(posted[0]));
        check('坏配置跑完状态仍回 idle（不会卡在 running）',
            (await rejected({ totalTests: 0 })).state === 'idle');
    }

    // ---- M4（引擎侧）：截断标记必须转发成严格布尔 ----

    {
        const forward = async (msg) => {
            const ctx = makeEngine();
            const running = ctx.start({ totalTests: 1, threadCount: 1 });
            ctx.workers[0].report(Object.assign({ type: 'error', testIndex: 7 }, msg));
            finishRun(ctx, { completed: 0 });
            ctx.workers[0].report({ type: 'done' });
            await running;
            return ctx.of('error')[0];
        };
        const full = await forward({
            kind: 'output_limit', code: 'output_limit', exitCode: 0, message: 'too long',
            stdOutput: 'S', testOutput: 'T', input: 'I',
            inputTruncated: true, stdOutputTruncated: true, testOutputTruncated: true,
            genMs: 11, stdMs: 22, testMs: 33
        });
        const FLAGS = ['inputTruncated', 'stdOutputTruncated', 'testOutputTruncated'];
        const flagsOf = (err) => FLAGS.map((f) => err[f]);
        check('三个截断标记都转发成 true',
            JSON.stringify(flagsOf(full)) === '[true,true,true]', JSON.stringify(flagsOf(full)));

        const bare = await forward({});
        check('worker 漏字段时三个标记补成 false（不能是 undefined）',
            JSON.stringify(flagsOf(bare)) === '[false,false,false]', JSON.stringify(flagsOf(bare)));
        check('worker 没带的输出字段补成空串',
            bare.input === '' && bare.stdOutput === '' && bare.testOutput === '',
            JSON.stringify([bare.input, bare.stdOutput, bare.testOutput]));
        check('worker 报了的输出正文原样转发',
            full.input === 'I' && full.stdOutput === 'S' && full.testOutput === 'T',
            JSON.stringify([full.input, full.stdOutput, full.testOutput]));
        check('kind/code/exitCode/耗时逐项转发',
            full.type === 'output_limit' && full.code === 'output_limit' && full.exitCode === 0
            && full.testNumber === 7 && full.genMs === 11 && full.stdMs === 22 && full.testMs === 33
            && full.message === 'too long',
            JSON.stringify(full));

        // 三个标记逐个验假值归一：只查其中两个曾让 testOutputTruncated 的 `|| true` 变异漏网
        for (const flag of FLAGS) {
            const falsy = await forward({ [flag]: 0 });
            const truthy = await forward({ [flag]: 'yes' });
            check(`${flag} 假值归 false / 非空字符串归 true`,
                falsy[flag] === false && truthy[flag] === true,
                JSON.stringify([falsy[flag], truthy[flag]]));
        }
    }

    // ---- H3: run id 隔离 —— 上一轮的迟到消息不得污染新一轮 ----

    {
        const ctx = makeEngine();
        const first = ctx.start({ totalTests: 4, threadCount: 1 });
        const oldWorkers = ctx.workers.slice();
        finishRun(ctx, { completed: 4 });
        oldWorkers.forEach((w) => w.report({ type: 'done' }));
        await first;

        const second = ctx.start({ totalTests: 4, threadCount: 1 });
        const fresh = ctx.workers.filter((w) => !oldWorkers.includes(w));
        check('第二轮建了新的 worker 而不是复用', fresh.length === 1, `fresh=${fresh.length}`);
        oldWorkers[0].report({ type: 'progress', testIndex: 1 });
        oldWorkers[0].report({ type: 'error', testIndex: 2, kind: 'std_re', code: 'std_error' });
        check('上一轮迟到的 progress 不计入本轮完成数', ctx.engine._completed === 0, `completed=${ctx.engine._completed}`);
        check('上一轮迟到的 error 不转发给 UI', ctx.of('error').filter((e) => e.testNumber === 2).length === 0,
            JSON.stringify(ctx.of('error')));
        fresh[0].report({ type: 'progress', testIndex: 1 });
        check('本轮自己的 progress 正常计入', ctx.engine._completed === 1, `completed=${ctx.engine._completed}`);
        finishRun({ workers: fresh, engine: ctx.engine }, { completed: 3 });
        await second;
        check('迟到消息把旧轮 settle 掉后不影响新轮完成数', ctx.engine._completed === 4, `completed=${ctx.engine._completed}`);

        // 半途建不出 worker 时，第一轮唯一的 worker 从没 settle，监听器还挂着；
        // 新一轮开始后它收到的消息必须靠 run id 挡掉，否则完成数会张冠李戴
        const aborted = makeEngine(2);
        await aborted.start({ totalTests: 4, threadCount: 2 });
        check('半途抛错也发 engine_start 并把状态复位',
            aborted.engine.state === 'idle' && aborted.of('error').length === 1
            && aborted.of('error')[0].code === 'engine_start', JSON.stringify(aborted.of('error')));
        const stale = aborted.workers[0];
        const before = aborted.of('error').length;
        const rerun = aborted.start({ totalTests: 2, threadCount: 1 });
        const live = aborted.workers[aborted.workers.length - 1];
        check('重开一轮用的是新 worker', live !== stale, `workers=${aborted.workers.length}`);
        stale.report({ type: 'progress', testIndex: 1 });
        stale.report({ type: 'error', testIndex: 99, kind: 'std_re', code: 'std_error' });
        check('旧 worker 迟到的 progress 不计入新一轮完成数',
            aborted.engine._completed === 0, `completed=${aborted.engine._completed}`);
        check('旧 worker 迟到的 error 不转发给 UI',
            aborted.of('error').length === before && aborted.of('error').slice(before).length === 0,
            JSON.stringify(aborted.of('error').slice(before)));
        live.report({ type: 'progress', testIndex: 1 });
        check('新一轮自己的 progress 正常计入',
            aborted.engine._completed === 1, `completed=${aborted.engine._completed}`);
        live.report({ type: 'done' });
        await rerun;
    }

    // ---- M3: 完成数不足要报 incomplete_run，且只报计数不拼英文 ----

    {
        const ctx = makeEngine();
        const running = ctx.start({ totalTests: 6, threadCount: 2 });
        finishRun(ctx, { completed: 2 });
        await running;
        const warnings = ctx.of('warning');
        check('完成数不足时发一条 incomplete_run 告警',
            warnings.length === 1 && warnings[0].code === 'incomplete_run' && warnings[0].type === 'incomplete_run',
            JSON.stringify(warnings));
        check('告警给出 completed/total/missing 三个计数',
            warnings[0].completed === 2 && warnings[0].total === 6 && warnings[0].missing === 4,
            JSON.stringify(warnings && warnings[0]));
        check('告警不在引擎层拼英文文案（交给渲染层按 i18n 组装）',
            warnings[0].message === '' && !/[A-Za-z]{4,}/.test(JSON.stringify(warnings[0].message)),
            JSON.stringify(warnings[0].message));
        check('complete 事件仍带 total/completed/failed',
            JSON.stringify(ctx.of('complete')[0]) === '{"total":6,"completed":2,"failed":0}',
            JSON.stringify(ctx.of('complete')[0]));

        const ok = makeEngine();
        const okRun = ok.start({ totalTests: 6, threadCount: 2 });
        finishRun(ok, { completed: 6 });
        await okRun;
        check('全部跑完时不发 incomplete_run', ok.of('warning').length === 0, JSON.stringify(ok.of('warning')));
        check('全部跑完时 complete 计数是 6/6',
            JSON.stringify(ok.of('complete')[0]) === '{"total":6,"completed":6,"failed":0}');

        const stopped = makeEngine();
        const stopRun = stopped.start({ totalTests: 6, threadCount: 2 });
        stopped.workers[0].report({ type: 'progress', testIndex: 1 });
        await stopped.engine.stop();
        check('stop() 后状态是 stopping', stopped.engine.state === 'stopping', stopped.engine.state);
        finishRun(stopped, { completed: 1 });   // stop 前已报 1 条，这里再 1 条 = 共 2 条
        await stopRun;
        check('手动停止不发 incomplete_run 告警', stopped.of('warning').length === 0, JSON.stringify(stopped.of('warning')));
        check('手动停止发 stopped 而不是 complete',
            stopped.of('complete').length === 0 && stopped.of('stopped').length === 1);
        check('stopped 事件同样带 total/completed/failed',
            JSON.stringify(stopped.of('stopped')[0]) === '{"total":6,"completed":2,"failed":0}',
            JSON.stringify(stopped.of('stopped')[0]));
    }

    // ---- fastspawn 退化告警：一次对拍只说一遍，但不能永久压制 ----

    {
        const ctx = makeEngine();
        const running = ctx.start({ totalTests: 4, threadCount: 2 });
        ctx.workers.forEach((w) => w.report({ type: 'fastspawn-load-warning', message: 'MODULE_NOT_FOUND' }));
        finishRun(ctx, { completed: 4 });
        await running;
        const warns = ctx.of('warning');
        check('多个 worker 各报一次 fastspawn 退化只发一条告警',
            warns.length === 1 && warns[0].code === 'fastspawn_fallback', JSON.stringify(warns));
        check('退化告警保留原始原因', String(warns[0].message).includes('MODULE_NOT_FOUND'), warns[0].message);
        check('退化告警不占用错误计数', warns.length === 1 && ctx.of('error').length === 0);

        const second = ctx.start({ totalTests: 1, threadCount: 1 });
        ctx.workers[ctx.workers.length - 1].report({ type: 'fastspawn-load-warning', message: 'again' });
        finishRun({ workers: [ctx.workers[ctx.workers.length - 1]], engine: ctx.engine }, { completed: 1 });
        await second;
        check('下一轮重新允许上报（去重标志是每轮的，不是进程级）',
            ctx.of('warning').filter((w) => w.code === 'fastspawn_fallback').length === 2,
            JSON.stringify(ctx.of('warning').map((w) => w.message)));
    }

    // ---- worker 崩溃 / 提前退出 ----

    {
        const ctx = makeEngine();
        const running = ctx.start({ totalTests: 3, threadCount: 1 });
        ctx.workers[0].report({ type: 'progress', testIndex: 1 });
        ctx.workers[0].emit('error', new Error('worker died'));
        await running;
        const errs = ctx.of('error');
        check('worker 崩溃上报成 worker_crash 而不是张冠李戴',
            errs.length === 1 && errs[0].type === 'worker_crash' && errs[0].testNumber === 0
            && errs[0].message === 'worker died', JSON.stringify(errs));
        check('崩溃计入 failed，并由 incomplete_run 指出缺口',
            JSON.stringify(ctx.of('complete')[0]) === '{"total":3,"completed":1,"failed":1}'
            && ctx.of('warning').length === 1 && ctx.of('warning')[0].missing === 2,
            JSON.stringify({ c: ctx.of('complete')[0], w: ctx.of('warning') }));

        const exitOnly = makeEngine();
        const exitRun = exitOnly.start({ totalTests: 3, threadCount: 1 });
        exitOnly.workers[0].emit('exit', 0);
        await exitRun;
        check('worker 正常 exit 不报崩溃，只留缺口告警',
            exitOnly.of('error').length === 0 && exitOnly.of('warning').length === 1);

        const duringStop = makeEngine();
        const stopErr = duringStop.start({ totalTests: 3, threadCount: 1 });
        await duringStop.engine.stop();
        duringStop.workers[0].emit('error', new Error('killed by stop'));
        duringStop.workers.forEach((w) => w.report({ type: 'done' }));
        await stopErr;
        check('停止期间被 kill 的 worker 不再报 worker_crash',
            duringStop.of('error').length === 0, JSON.stringify(duringStop.of('error')));
    }

    // ---- H4: 状态机与 stop 语义 ----

    {
        const ctx = makeEngine();
        const first = ctx.start({ totalTests: 2, threadCount: 1 });
        // 守卫正常时 start() 在首个 await 前就同步 reject；守卫被删掉时它会真的开第二轮，
        // 而第二轮的 worker 我们不会喂 done，直接 await 会把整个测试挂成静默退出。
        const again = ctx.start({ totalTests: 2, threadCount: 1 });
        let threw = null;
        again.catch((error) => { threw = error; });
        await new Promise((resolve) => setTimeout(resolve, 0));
        check('running 中重入 start 直接抛 Engine already running',
            threw instanceof Error && threw.message === 'Engine already running', String(threw && threw.message));
        check('重入被拒时不新建 worker', ctx.workers.length === 1, `workers=${ctx.workers.length}`);
        ctx.workers[0].report({ type: 'progress', testIndex: 1 });
        ctx.workers[0].report({ type: 'done' });
        await first;
        check('被拒的重入没有打断第一轮',
            ctx.of('complete').length === 1 && ctx.engine.state === 'idle',
            JSON.stringify({ c: ctx.of('complete').length, s: ctx.engine.state }));

        const stoppingProbe = makeEngine();
        const stopFirst = stoppingProbe.start({ totalTests: 2, threadCount: 1 });
        await stoppingProbe.engine.stop();
        const again2 = stoppingProbe.start({ totalTests: 2, threadCount: 1 });
        let secondThrew = null;
        again2.catch((error) => { secondThrew = error; });
        await new Promise((resolve) => setTimeout(resolve, 0));
        check('stopping 中同样拒绝重入', secondThrew !== null && secondThrew.message === 'Engine already running',
            String(secondThrew && secondThrew.message));
        check('stopping 中重入不新建 worker', stoppingProbe.workers.length === 1,
            `workers=${stoppingProbe.workers.length}`);
        check('stop() 给每个 worker 发了 stop 指令',
            stoppingProbe.workers[0].posted.some((m) => m.type === 'stop'),
            JSON.stringify(stoppingProbe.workers[0].posted));
        check('stop() 是 fire-and-forget：不 await worker 收尸',
            stoppingProbe.engine.state === 'stopping' && stoppingProbe.workers[0].terminated === 0,
            `terminated=${stoppingProbe.workers[0].terminated}`);
        // 原来是 /2000\)\s*\.unref\(\)/.test(engineSrc)：把 setTimeout 换成记账桩之后
        // 「句柄被 unref 过」和「到期真把 worker 收掉」都能直接数出来，文本锁就不需要了。
        // 延迟的具体毫秒数是可调参数，只锁它是正数（漏成 0 就是立刻收尸，语义变了）。
        check('stop() 排了一个收尸定时器，句柄净 unref（否则主进程退不出去）',
            stoppingProbe.timers.length === 1
            && stoppingProbe.timers[0].unref === 1 && stoppingProbe.timers[0].ref === 0
            && Number.isFinite(stoppingProbe.timers[0].ms) && stoppingProbe.timers[0].ms > 0,
            JSON.stringify(stoppingProbe.timers.map((t) => ({ ms: t.ms, unref: t.unref, ref: t.ref }))));
        check('收尸定时器到期才 terminate，每个 stop 时的 worker 各一次',
            stoppingProbe.workers.every((w) => w.terminated === 0)
            && (() => { stoppingProbe.fireTimers(); return true; })()
            && stoppingProbe.workers.length === 1 && stoppingProbe.workers[0].terminated === 1,
            JSON.stringify(stoppingProbe.workers.map((w) => w.terminated)));
        stoppingProbe.workers.forEach((w) => w.report({ type: 'done' }));
        await stopFirst;

        const idle = makeEngine();
        await idle.engine.stop();
        check('idle 状态调用 stop() 什么都不做', idle.workers.length === 0 && idle.seen.length === 0);
        check('idle 状态 stop() 不把状态改成 stopping（否则下一轮开局就被自己拦住）',
            idle.engine.state === 'idle', idle.engine.state);
        const afterIdleStop = idle.start({ totalTests: 1, threadCount: 1 });
        check('空跑一次 stop() 后仍能正常开新轮', idle.workers.length === 1, `workers=${idle.workers.length}`);
        idle.workers[0].report({ type: 'done' });
        await afterIdleStop;
    }

    // ---- M7: 引擎错误码 → 文案的映射必须真落到两语言包都存在的键 ----

    {
        const getEngineErrorMessage = classMethod(comparerSrc, 'getEngineErrorMessage');
        check('方法体抽取成功: getEngineErrorMessage', getEngineErrorMessage.length > 0);
        const method = toFn(getEngineErrorMessage);
        check('重建成功: getEngineErrorMessage', typeof method === 'function');

        const mapLiteral = /const map = \{([\s\S]*?)\n\s*\};/.exec(getEngineErrorMessage);
        check('映射表可定位', mapLiteral !== null);
        const entries = [...(mapLiteral ? mapLiteral[1] : '').matchAll(/^\s*([a-z_]+):\s*'compare\.([A-Za-z]+)'/gm)];
        check('映射表非空', entries.length > 0, `${entries.length} 项`);

        // 台账的判断前提是「i18n.t 缺实参时原样留着 {token}」。这条前提本身也要跑行为：
        // 直接重建 i18n 的 t()，用桩 this 喂词条表，而不是正则锁 `: match` 那种字面量。
        {
            const tSrc = classMethod(i18nSrc, 't');
            check('方法体抽取成功: i18n.t', tSrc.length > 0);
            const realT = toFn(tSrc);
            check('重建成功: i18n.t', typeof realT === 'function');
            const dict = {
                'cmp.plain': '无占位符',
                'cmp.one': '退出码: {code}',
                'cmp.two': '{error} / {code}',
                'cmp.num': 42
            };
            const self = {
                _messages: dict,
                _fallbackMessages: {},
                _getNested: (obj, key) => obj[key]
            };
            const tr = (key, params) => realT.call(self, key, params);
            check('t() 命中词条时返回译文', tr('cmp.plain') === '无占位符', JSON.stringify(tr('cmp.plain')));
            check('t() 查不到键时返回裸键名（不是空串）',
                tr('cmp.absent') === 'cmp.absent', JSON.stringify(tr('cmp.absent')));
            check('传了 params 对象才做占位符替换',
                tr('cmp.one', { code: 139 }) === '退出码: 139', JSON.stringify(tr('cmp.one', { code: 139 })));
            check('params 不是对象时整条原文返回',
                tr('cmp.one', 'x') === '退出码: {code}', JSON.stringify(tr('cmp.one', 'x')));
            check('params 缺该键时保留裸 {token}（这就是台账要盯的可见缺陷）',
                tr('cmp.one', {}) === '退出码: {code}', JSON.stringify(tr('cmp.one', {})));
            check('params 值为 null/undefined 时同样保留裸 token',
                tr('cmp.one', { code: null }) === '退出码: {code}'
                && tr('cmp.one', { code: undefined }) === '退出码: {code}');
            check('多个占位符各自独立判定',
                tr('cmp.two', { error: 'boom' }) === 'boom / {code}', JSON.stringify(tr('cmp.two', { error: 'boom' })));
            check('非字符串词条被 String() 化而不是抛异常',
                tr('cmp.num') === '42', JSON.stringify(tr('cmp.num')));
        }

        const realWindow = global.window;
        try {
            let call = null;
            global.window = { i18n: { t: (key, params) => { call = { key, params }; return key; } } };
            const run = (error) => { call = null; return { out: method.call(null, error), got: call }; };

            const missing = [];
            for (const [, code, key] of entries) {
                const r = run({ code });
                if (r.got.key !== `compare.${key}`) missing.push(`${code}->${r.got.key}`);
                if (zh.compare?.[key] === undefined) missing.push(`zh:compare.${key}`);
                if (en.compare?.[key] === undefined) missing.push(`en:compare.${key}`);
            }
            check('每个引擎错误码都落到两语言包都存在的键上', missing.length === 0, missing.join(', '));

            // 占位符必须由实际传入的实参覆盖，否则界面直接显示 {code}
            const unsubstituted = [];
            for (const [, code] of entries) {
                const variants = code.endsWith('_exit') ? [{ code, exitCode: 3, message: 'boom' }, { code }]
                    : code.endsWith('_error') ? [{ code, exitCode: 1, message: 'boom' }, { code }]
                        : [{ code, message: 'boom' }];
                for (const variant of variants) {
                    const r = run(variant);
                    const template = zh.compare[r.got.key.replace('compare.', '')];
                    const wanted = [...String(template).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
                    for (const token of wanted) {
                        if (!r.got.params || !(token in r.got.params)) {
                            unsubstituted.push(`${code}/${r.got.key}/{${token}}`);
                        }
                    }
                }
            }
            console.log(`[INFO] 当前会露出裸占位符的组合: ${unsubstituted.join(', ') || '（无）'}`);
            // 已知缺陷台账：只许减不许增。子进程被信号杀掉时 exitCode 是 null，
            // *_exit 三个键走无参分支；compare.incompleteRun 恒走无参分支。
            // 修法：给这几个分支也传实参（exitCode ?? 空串 / 把已跑组数填进 {error}），
            // 或者把模板里的占位符去掉。修一条就把对应项从下面删掉。
            const ledgerBaseline = [
                'gen_exit/compare.genExit/{code}',
                'std_exit/compare.stdExit/{code}',
                'test_exit/compare.testExit/{code}',
                'incomplete_run/compare.incompleteRun/{error}'
            ];
            const KNOWN_UNSUBSTITUTED = new Set(ledgerBaseline);
            const actual = new Set(unsubstituted);
            const grown = [...actual].filter((k) => !KNOWN_UNSUBSTITUTED.has(k));
            const stale = [...KNOWN_UNSUBSTITUTED].filter((k) => !actual.has(k));
            check('占位符露出台账：没有新增组合', grown.length === 0, grown.join(', '));
            check('占位符露出台账：修好的项要同步从台账删掉', stale.length === 0, stale.join(', '));
            // 与 i18n.t 同一条替换规则（上面已用真实 t() 跑出「缺实参留裸 token」这条行为），
            // 用来算实参是否把模板填满
            const fill = (template, params) => String(template).replace(/\{(\w+)\}/g,
                (match, name) => (params && params[name] !== undefined && params[name] !== null) ? String(params[name]) : match);
            const filledExit = run({ code: 'std_exit', exitCode: 139 });
            check('拿到数值退出码时 *_exit 文案被填满，不留裸 token',
                !/\{\w+\}/.test(fill(zh.compare.stdExit, filledExit.got.params)),
                fill(zh.compare.stdExit, filledExit.got.params));
            const filledError = run({ code: 'test_error', message: 'boom', exitCode: 2 });
            check('异常类文案同样被实参填满',
                !/\{\w+\}/.test(fill(zh.compare.testRe, filledError.got.params)),
                fill(zh.compare.testRe, filledError.got.params));

            const exitCode = run({ code: 'gen_exit', exitCode: 139, message: 'segv' });
            check('退出类错误把 exitCode 作为 code 实参传给文案',
                exitCode.got.key === 'compare.genExit' && exitCode.got.params.code === 139
                && exitCode.got.params.error === 'segv', JSON.stringify(exitCode.got));
            const exitNoCode = run({ code: 'gen_exit' });
            check('exitCode 非有限值时走无参分支（不把 undefined 传进文案）',
                exitNoCode.got.params === undefined && exitNoCode.got.key === 'compare.genExit',
                JSON.stringify(exitNoCode.got));
            // 子进程被信号杀掉时 worker 传上来的是 null，超时/异常路径还可能是 NaN、字符串
            for (const bad of [null, NaN, Infinity, -Infinity, '139', {}]) {
                const r = run({ code: 'std_exit', exitCode: bad, message: 'x' });
                check(`exitCode=${String(bad)} 不是有限数时不传实参（免得文案写成「退出码: ${String(bad)}」）`,
                    r.got.params === undefined && r.got.key === 'compare.stdExit', JSON.stringify(r.got));
            }
            const negZero = run({ code: 'std_exit', exitCode: -0 });
            check('退出码 0 仍是有限值，照常带实参',
                negZero.got.params.code === 0, JSON.stringify(negZero.got));
            const errKind = run({ code: 'test_error', message: 'boom', exitCode: 2 });
            check('异常类错误同时带上 message 与 exitCode',
                errKind.got.key === 'compare.testRe' && errKind.got.params.error === 'boom'
                && errKind.got.params.code === 2, JSON.stringify(errKind.got));
            const errNullExit = run({ code: 'std_error', message: 'x', exitCode: null });
            check('exitCode 为 null 时传空串而不是 null',
                errNullExit.got.params.code === '', JSON.stringify(errNullExit.got));
            const fallback = run({ code: 'no_such_code' });
            check('未知错误码回退到通用引擎错误键',
                fallback.got.key === 'compare.engineError' && fallback.got.params === undefined,
                JSON.stringify(fallback.got));
            const emptyError = run({});
            check('错误对象没有 code 时同样回退而不是抛异常',
                emptyError.got.key === 'compare.engineError');
            check('回退用的通用键在模板里不需要占位符',
                !/\{\w+\}/.test(String(zh.compare.engineError)), String(zh.compare.engineError));
        }
        finally {
            global.window = realWindow;
        }
    }

    // ---------------------------------------------------------------------------
    // 以下几处无法在本环境真跑，保留源码结构锁并注明原因：
    //   · worker 的 spawn/write 顺序 —— 需要真起子进程，且 EPIPE 时序不可复现
    //   · fastspawn.cc —— C++ 源码，本环境没有编译器，只能做静态检查
    //   · onCompareError 回调里的字段接线 —— 那段要跑起来得把整套对拍 UI 的
    //     DOM/task/IPC 全桩出来，成本远超收益；改成「两个字段必须来自不同表达式」
    //     这种最小结构锁，配合上面 buildEngineErrorText 的行为断言一起用
    // 这些锁的共同点是锁「相对顺序 / 出参存在」，不锁排版。
    // ---------------------------------------------------------------------------

    {
        const writeInput = funcDecl(workerSrc, 'writeInput');
        check('函数体抽取成功: writeInput', writeInput.length > 0);
        const listenIdx = writeInput.indexOf("proc.stdin.on('error'");
        const writeIdx = writeInput.indexOf('proc.stdin.write(input)');
        check('H2 writeInput 给 stdin 挂了 error 监听', listenIdx !== -1);
        check('H2 error 监听在 write 之前注册（否则 EPIPE 打崩 worker）',
            listenIdx !== -1 && writeIdx !== -1 && listenIdx < writeIdx,
            `listen=${listenIdx} write=${writeIdx}`);

        const runFast = funcDecl(workerSrc, 'runFast');
        check('函数体抽取成功: runFast', runFast.length > 0);
        check('M4 runFast 采用 native 回传的 truncated', /outputTruncated: !!r\.truncated/.test(runFast));
        const runFastPair = funcDecl(workerSrc, 'runFastPair');
        check('函数体抽取成功: runFastPair', runFastPair.length > 0);
        check('M4 runFastPair 采用 native 回传的 truncated', /truncated1: !!r\.truncated/.test(runFastPair));
        // 注释里保留了「原先靠 output.length >= ... 猜」的说明，判残留要看去掉整行注释后的代码
        const workerCode = workerSrc.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
        check('M4 两条路径都不再用长度猜截断',
            !/\.length >= MAX_WORKER_OUTPUT_BYTES/.test(workerCode),
            `${(workerCode.match(/\.length >= MAX_WORKER_OUTPUT_BYTES/g) || []).length} 处残留`);
        check('M4 长度上限本身仍在做缓冲记账（不是被误删的常量）',
            /MAX_WORKER_OUTPUT_BYTES - outputBytes/.test(workerCode));
    }

    {
        check('H1 native 侧把 timeoutMs<=0 映射为无截止时间',
            /const int64_t NO_DEADLINE = INT64_MAX;/.test(fastspawnSrc) &&
            /int64_t deadlineMs = \(timeoutMs > 0\) \? \(nowMs\(\) \+ timeoutMs\) : NO_DEADLINE;/.test(fastspawnSrc));
        check('H1 使用 INT64_MAX 需要 stdint.h', /#include <stdint\.h>/.test(fastspawnSrc));
        check('H1 超时判断只比 deadline', /if \(nowMs\(\) >= deadlineMs\)/.test(fastspawnSrc));
        check('写入循环在不限时下无限期等 POLLOUT', /poll\(&writeFd, 1, -1\)/.test(fastspawnSrc));
        check('drainBoth 的 poll 仍按 500ms 分段', /int to = \(remain > 500\) \? 500 : \(int\)remain;/.test(fastspawnSrc));
        check('M4 drainBoth 回传 drop 标志', /if \(truncatedOut\) \*truncatedOut = ob\.drop;/.test(fastspawnSrc));
        check('M4 runOne 出参带 truncated',
            /int64_t timeoutMs, char\*\* out, size_t\* outLen, int\* truncated\)/.test(fastspawnSrc) &&
            /if \(truncated\) \*truncated = \(truncatedOut \|\| truncatedErr\) \? 1 : 0;/.test(fastspawnSrc));
        check('M4 napi 返回值暴露 truncated', /napi_set_named_property\(env, result, "truncated", rTrunc\);/.test(fastspawnSrc));
        const runOneDecl = /static int runOne\([^;]*int\* truncated\)/.test(fastspawnSrc);
        const callSites = [...fastspawnSrc.matchAll(/runOne\(([^;]*?)\);/g)].map((m) => m[1]);
        const allPass = callSites.every((args) => /truncated/.test(args));
        check('M4 runOne 定义与所有调用点都带 truncated',
            runOneDecl && callSites.length >= 4 && allPass,
            `${callSites.length} 个调用点, 全部传参=${allPass}`);
        check('花括号平衡（无法编译时至少做静态检查）',
            (fastspawnSrc.match(/\{/g) || []).length === (fastspawnSrc.match(/\}/g) || []).length,
            `${(fastspawnSrc.match(/\{/g) || []).length} vs ${(fastspawnSrc.match(/\}/g) || []).length}`);
    }

    // 引擎错误事件 → errorResult 的字段接线（在 onCompareError 回调里，跑不起来，见上方说明）
    {
        const wiring = /errorMessage:\s*this\.getEngineErrorMessage\(error\)\s*,\s*rawErrorMessage:\s*error\.message\s*\|\|\s*''/;
        check('本地化文案与原始 message 分别从不同来源接线（raw 不是本地化的复制）',
            wiring.test(comparerSrc), '没找到 errorMessage/rawErrorMessage 相邻接线');
        check('接线只有一处（别处再抄一份会各自漂移）',
            (comparerSrc.match(/rawErrorMessage:/g) || []).length === 1,
            `${(comparerSrc.match(/rawErrorMessage:/g) || []).length} 处`);
    }

    // 渲染层的收尾两件事：错误类型归类（漏一个就掉进 WA 分支）、正文拼装顺序
    {
        const engineTypes = ['generator', 'std_tle', 'std_re', 'test_tle', 'test_re',
            'output_limit', 'worker_crash', 'engine', 'exception', 'fastspawn_fallback', 'incomplete_run'];
        const isEngineErrorType = toFn(classMethod(comparerSrc, 'isEngineErrorType'));
        check('方法体重建成功: isEngineErrorType', typeof isEngineErrorType === 'function');
        const misclassified = engineTypes.filter((kind) => isEngineErrorType(kind) !== true);
        check('引擎错误类型逐个命中白名单（漏一个就被当成 WA 渲染）',
            misclassified.length === 0, misclassified.join(','));
        check('output_limit 在名单里（曾经漏登记）', isEngineErrorType('output_limit') === true);
        check('普通答案错误不被误归为引擎错误',
            isEngineErrorType('wrong_answer') === false && isEngineErrorType('') === false
            && isEngineErrorType(undefined) === false);

        const buildErrText = toFn(classMethod(comparerSrc, 'buildEngineErrorText'));
        check('方法体重建成功: buildEngineErrorText', typeof buildErrText === 'function');
        const onlyLocalized = buildErrText({ errorMessage: '本地化文案', rawErrorMessage: '' });
        check('只有本地化文案时正文就是它本身',
            onlyLocalized === '本地化文案', JSON.stringify(onlyLocalized));
        const both = buildErrText({ errorMessage: '本地化文案', rawErrorMessage: 'boom' });
        check('本地化文案打头、原始细节追加在后（英文不顶掉中文）',
            both === '本地化文案\n[boom]', JSON.stringify(both));
        const sameRaw = buildErrText({ errorMessage: 'same', rawErrorMessage: 'same' });
        check('原始细节与本地化一致时不重复追加', sameRaw === 'same', JSON.stringify(sameRaw));
        const blankRaw = buildErrText({ errorMessage: 'only', rawErrorMessage: '   ' });
        check('原始细节只有空白时不追加空方括号', blankRaw === 'only', JSON.stringify(blankRaw));
        const noLocalized = buildErrText({ rawErrorMessage: 'raw only' });
        check('缺本地化文案时仍露出原始细节（不渲染空正文）',
            noLocalized === '[raw only]', JSON.stringify(noLocalized));
        const trimmed = buildErrText({ errorMessage: 'L', rawErrorMessage: '  R \n' });
        check('原始细节两端空白被裁掉', trimmed === 'L\n[R]', JSON.stringify(trimmed));
        const nothing = buildErrText({});
        check('两个字段都缺时返回空串而不是抛异常',
            nothing === '', JSON.stringify(nothing));
    }

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
    process.exit(failures ? 1 : 0);
})().catch((error) => {
    console.error('[ERROR] 引擎行为段异常:', error);
    process.exit(1);
});
