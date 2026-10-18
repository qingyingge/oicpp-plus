'use strict';

// 对拍器「显示的完成数 / 进度 / 停止 / 导出数据」必须反映真实执行情况，
// 不能拿计划数充数，也不能静默导出被截断的数据。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { arrowExpr, arrowProp, callbackBody, classMethod, compileMethod, funcDecl, ifStatement, objectConst, scalarConst, toFn } = require('./fixtures/source-extract');
const { runEngine, pick } = require('./fixtures/fake-compare-engine');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const comparerSource = read('src', 'renderer', 'js', 'sidebar', 'codeComparer.js');
const workerSource = read('src', 'main-process', 'compare-worker-v6.js');
const mainSource = read('src', 'main.js');
const preloadSource = read('src', 'preload.js');
const htmlSource = read('src', 'renderer', 'index.html');
const zh = JSON.parse(read('src', 'lang', 'zh-cn.json'));
const en = JSON.parse(read('src', 'lang', 'en.json'));

// ---------------------------------------------------------------------------
// 行为守卫用的真身：把 codeComparer 里几个方法抽出来直接调（纯计算的直接跑，
// 带 IO 的 exportResults 用桩 window.electronAPI 跑，见文件末尾的异步段）。
//
// 这批原先全是「源码长这样」的断言 —— 锁死 `Math.max(0, Math.min(100, (completedTests /
// totalTests) * 100))` 这种整串字面量。排版一改（tsc printer 会拆行）就误报，
// 而真正的语义错误 —— clamp 上下限写反、截断标记退回比对译文、B/KB/MB 阈值挪位、
// flag 与字段错配 —— 只要字面量还在就照样绿。
// 所以下面每个话题都改成真调用，文本断言只留「不该回来的形态」。
// ---------------------------------------------------------------------------

const PURE_METHODS = ['updateProgress', 'getCompletedCount', 'isEngineErrorType',
    'getOutputSizeBytes', 'getOutputSizeText', 'addLineNumbers', 'normalizeForCompare',
    'highlightCharacterDifferences', 'limitOutputLines', 'formatCompareOutput', 'getDifferenceInfo',
    'exportResults'];
const cmp = {};
for (const name of PURE_METHODS) {
    const methodSrc = classMethod(comparerSource, name);
    // 抽取失败必须当场红：拿 undefined 当函数调会整段崩，拿空串做正则会真空通过
    check(`方法体抽取成功: ${name}`, methodSrc.length > 0);
    cmp[name] = toFn(methodSrc);
    check(`重建成功: ${name}`, typeof cmp[name] === 'function');
}
// addLineNumbers 依赖的两个成员：截断文案与 HTML 转义。转义给实现而不是留空，
// 否则「输出必须被转义」这条断言就是在测我的桩。
cmp.getTruncationText = () => '⟪输出已截断⟫';
cmp.escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---------------------------------------------------------------------------
// 渲染层状态机：把 codeComparer 的成员方法抽进 vm 真调。
//
// 为什么走 vm 而不是上面那批 toFn：这些方法里的 document / window / ccInput / logInfo
// 全是自由标识符，new Function 编译出来的函数会解析到 **Node 全局**，测试塞的桩一个都拦不住。
// compileMethod 在 context 里编译，自由标识符才落到桩上；ccInput/ccButton 也从源码抽进来真跑，
// 「只有 <input> 才算输入框」那道 instanceof 门槛就一起被测到了。
// self 用 Proxy：给了真身的走真身，没给的记名字和实参 ——
// 「完成面板收到的是执行数还是计划数」这类断言就此变成 showComplete 的实际入参。
// ---------------------------------------------------------------------------

const INPUT_IDS = new Set(['compare-count', 'compare-threads', 'time-limit', 'compare-use-testlib',
    'compare-spj-path', 'compare-freopen-input-file', 'compare-freopen-output-file']);
const BUTTON_IDS = new Set(['compare-start-btn', 'compare-stop-btn']);

class FakeEl {
    constructor(id) {
        this.id = id;
        this.style = {};
        this._text = '';
        this._html = '';
        // 最近一次写入的是哪一路。showError 有些分支写 textContent、有些写 innerHTML，
        // 两个字段各自留旧值，断言只能读「当前真正显示出来的那一份」。
        this._last = null;
        this.value = '';
        this.checked = false;
        this.children = {};
    }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); this._last = ['textContent', this._text]; }
    get innerHTML() { return this._html; }
    set innerHTML(v) { this._html = String(v); this._last = ['innerHTML', this._html]; }
    get shown() { return this._last ? this._last[1] : ''; }
    get lastKind() { return this._last ? this._last[0] : null; }
    querySelector(sel) {
        if (!this.children[sel]) this.children[sel] = new FakeEl(`${this.id}::${sel}`);
        return this.children[sel];
    }
}
class FakeInput extends FakeEl { }
class FakeButton extends FakeEl { }

// document.createElement 出来的临时节点：escapeHtml 靠「写 textContent、读 innerHTML」
// 这一步浏览器的转义语义活着，所以这里必须把那条规则模型出来，
// 而不是返回原样 —— 否则「差异正文里的 < 被转义」就成了在测我的桩。
class FakeNode {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.style = {};
        this.children = [];
        this._raw = '';
    }
    get textContent() { return this._raw; }
    set textContent(v) { this._raw = String(v); }
    get innerHTML() {
        return this._raw
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    set innerHTML(v) { this._raw = String(v); }
    appendChild(child) { this.children.push(child); return child; }
}

const comparerHarness = (names, own = {}) => {
    const seen = { elements: {}, lookups: [], t: [], logs: [], warns: [], errors: [] };
    const element = (id) => {
        seen.lookups.push(id);
        if (!seen.elements[id]) {
            const Ctor = INPUT_IDS.has(id) ? FakeInput : BUTTON_IDS.has(id) ? FakeButton : FakeEl;
            seen.elements[id] = new Ctor(id);
        }
        return seen.elements[id];
    };
    const api = { stopCompareCalls: 0, stopCompare: () => { api.stopCompareCalls++; return Promise.resolve(); } };
    const ctx = vm.createContext({
        Number, String, Object, Array, JSON, Math, Map, Set, Promise, RegExp, Error, isNaN, parseInt, parseFloat,
        setTimeout, clearTimeout, console,
        document: { getElementById: element, createElement: (tag) => new FakeNode(tag) },
        HTMLInputElement: FakeInput,
        HTMLButtonElement: FakeButton,
        window: {
            i18n: { t: (key, params) => { seen.t.push([key, params]); return params ? `${key}|${JSON.stringify(params)}` : key; } },
            electronAPI: api
        },
        logInfo: (...a) => seen.logs.push(a),
        logWarn: (...a) => seen.warns.push(a),
        logError: (...a) => seen.errors.push(a)
    });
    // 这两个文件级小工具本身就是守卫的一部分（类型门槛写错，renderTask 就什么都写不到）
    for (const [global, pattern] of [['ccInput', /const ccInput = /], ['ccButton', /const ccButton = /]]) {
        const src = arrowExpr(comparerSource, pattern);
        check(`文件级工具抽取成功: ${global}`, src.startsWith('(id) =>'), src.slice(0, 20));
        vm.runInContext(`this.${global} = ${src}`, ctx);
    }
    const real = {};
    for (const name of names) {
        const src = classMethod(comparerSource, name);
        check(`状态机方法抽取成功: ${name}`, src.length > 0);
        real[name] = compileMethod(ctx, src);
        check(`状态机方法可调用: ${name}`, typeof real[name] === 'function');
    }
    const calls = [];
    const target = { calls, tasks: new Map(), ...real, ...own };
    const self = new Proxy(target, {
        get: (t, k) => (k in t ? t[k] : (typeof k === 'string'
            ? (...args) => { t.calls.push({ name: k, args }); } : undefined))
    });
    return { ctx, self, seen, calls, real, api, el: (id) => element(id), named: (id) => seen.elements[id] };
};
// Proxy 记下来的 this.* 调用里挑某个方法的实参表
const argsOf = (calls, name) => calls.filter((c) => c.name === name).map((c) => c.args);
const called = (calls, name) => calls.some((c) => c.name === name);

// ---- 完成数必须是真实执行数，不是计划数 ----
{
    // 任务状态里的 completedTests 初值 + 完成面板的入参，都改成调用真身后的实际值。
    // 原先锁的是 /completedTests:\s*0/ 和 /showComplete\(this\.getCompletedCount\(task\)/ 两行字：
    // 初值改成 100、或者把 totalTests 直接喂给面板，只要那两行字还在就照样绿。
    const h = comparerHarness(['normalizeTaskKey', 'getOrCreateTask']);
    const fresh = h.real.getOrCreateTask.call(h.self, 'a.cpp');
    check('新建任务的初始执行数是 0，不是计划数',
        fresh.state.completedTests === 0 && fresh.state.totalTests === 0,
        JSON.stringify(fresh.state));
    check('新建任务落在 idle，且 errorResult/warningMessage 是空位',
        fresh.state.mode === 'idle' && fresh.state.errorResult === null && fresh.state.warningMessage === null,
        fresh.state.mode);
    check('新建任务的计数齐备（completedTests/failedTests/currentTest/stopped 都有初值）',
        ['completedTests', 'failedTests', 'currentTest', 'stopped'].every((k) => k in fresh.state),
        JSON.stringify(Object.keys(fresh.state)));
    check('同一 key 再取拿到同一个任务对象（重复取不重置计数）',
        h.real.getOrCreateTask.call(h.self, 'a.cpp') === fresh);
    fresh.state.completedTests = 7;
    check('取回后再改的计数不会被第二次 getOrCreate 抹掉',
        h.real.getOrCreateTask.call(h.self, 'a.cpp').state.completedTests === 7);
    check('不同 key 得到不同任务对象',
        h.real.getOrCreateTask.call(h.self, 'b.cpp') !== fresh && h.self.tasks.size === 2);
    check('空 key 返回 null 且不入库',
        h.real.getOrCreateTask.call(h.self, '') === null && h.self.tasks.size === 2);

    const r = comparerHarness(['renderTask', 'getCompletedCount', 'updateProgress']);
    const panelTask = (state) => ({ config: {}, state: { completedTests: 7, totalTests: 50, ...state } });
    r.real.renderTask.call(r.self, panelTask({ mode: 'stopped' }));
    check('mode=stopped 走完成面板，且面板收到的是执行数 7 而不是计划数 50',
        JSON.stringify(argsOf(r.calls, 'showComplete')) === '[[7,null]]',
        JSON.stringify(argsOf(r.calls, 'showComplete')));
    check('stopped 态不该被当成运行态（不 showStatus）',
        !called(r.calls, 'showStatus'), JSON.stringify(r.calls.map((c) => c.name)));
    const warnRun = comparerHarness(['renderTask', 'getCompletedCount', 'updateProgress']);
    warnRun.real.renderTask.call(warnRun.self, panelTask({ mode: 'complete', warningMessage: 'W' }));
    check('mode=complete 同样喂执行数，并把 warningMessage 一并传给面板',
        JSON.stringify(argsOf(warnRun.calls, 'showComplete')) === '[[7,"W"]]',
        JSON.stringify(argsOf(warnRun.calls, 'showComplete')));
    const noCount = comparerHarness(['renderTask', 'getCompletedCount', 'updateProgress']);
    noCount.real.renderTask.call(noCount.self, { config: {}, state: { mode: 'complete', totalTests: 50 } });
    check('执行数缺失时才退回计划数（getCompletedCount 的口径贯穿到面板）',
        JSON.stringify(argsOf(noCount.calls, 'showComplete')) === '[[50,null]]',
        JSON.stringify(argsOf(noCount.calls, 'showComplete')));
    const stopRun = comparerHarness(['renderTask', 'getCompletedCount', 'updateProgress']);
    stopRun.real.renderTask.call(stopRun.self, panelTask({ mode: 'stopping', statusText: 'S' }));
    check('mode=stopping 仍按可见运行态渲染（showStatus + 状态文案）',
        called(stopRun.calls, 'showStatus')
        && JSON.stringify(argsOf(stopRun.calls, 'updateStatusText')) === '[["S"]]',
        JSON.stringify(stopRun.calls.map((c) => c.name)));
    check('stopping 不落到完成面板也不清空它',
        !called(stopRun.calls, 'showComplete') && !called(stopRun.calls, 'hideComplete'),
        JSON.stringify(stopRun.calls.map((c) => c.name)));
    const errRun = comparerHarness(['renderTask', 'getCompletedCount', 'updateProgress']);
    errRun.real.renderTask.call(errRun.self, { config: {}, state: { mode: 'error', errorResult: { testNumber: 3 } } });
    check('mode=error 把 state.errorResult 原样交给错误区',
        JSON.stringify(argsOf(errRun.calls, 'showError')) === '[[{"testNumber":3}]]',
        JSON.stringify(argsOf(errRun.calls, 'showError')));
    const idleRun = comparerHarness(['renderTask', 'getCompletedCount', 'updateProgress']);
    idleRun.real.renderTask.call(idleRun.self, panelTask({ mode: 'idle' }));
    check('mode=idle 三个区域全部收起',
        ['hideStatus', 'hideError', 'hideComplete'].every((n) => called(idleRun.calls, n)),
        JSON.stringify(idleRun.calls.map((c) => c.name)));
    const nullRun = comparerHarness(['renderTask', 'getCompletedCount', 'updateProgress']);
    nullRun.real.renderTask.call(nullRun.self, null);
    check('task 为 null 时什么都不做，不抛异常',
        nullRun.calls.length === 0, JSON.stringify(nullRun.calls.map((c) => c.name)));

    const s = comparerHarness(['showComplete', 'hideStatus', 'hideError']);
    s.real.showComplete.call(s.self, 7, null, true);
    check('showComplete 把执行数写进「已完成」元素，并展开完成区',
        String(s.named('completed-tests').textContent) === '7'
        && s.named('compare-complete').style.display === 'flex',
        JSON.stringify({ text: s.named('completed-tests').textContent, disp: s.named('compare-complete').style.display }));
    check('stopped=true 的提示用 stoppedText 且带上同一个计数',
        s.named('compare-complete').children['.complete-info span'].innerHTML.startsWith('compare.stoppedText|{"count":7}'),
        s.named('compare-complete').children['.complete-info span'].innerHTML);
    const s2 = comparerHarness(['showComplete', 'hideStatus', 'hideError']);
    s2.real.showComplete.call(s2.self, 5, 'WARN');
    check('带 warningMessage 时改用 completedWithWarning，count 与 warning 都传下去',
        s2.seen.t.some(([k, p]) => k === 'compare.completedWithWarning' && p.count === 5 && p.warning === 'WARN'),
        JSON.stringify(s2.seen.t));
    const s3 = comparerHarness(['showComplete']);
    s3.real.showComplete.call(s3.self, 3);
    check('无告警、未停止时用 completedText，并收起状态区与错误区',
        s3.seen.t.some(([k]) => k === 'compare.completedText')
        && called(s3.calls, 'hideStatus') && called(s3.calls, 'hideError'),
        JSON.stringify(s3.calls.map((c) => c.name)));
}
{
    // getCompletedCount 的口径：真实执行数优先，且 0 也是合法执行数（不能退回计划数）
    const count = (task) => cmp.getCompletedCount.call(null, task);
    check('已执行 7 组时返回 7', count({ state: { completedTests: 7, totalTests: 50 } }) === 7);
    check('执行数为 0 时返回 0，而不是回退到计划数',
        count({ state: { completedTests: 0, totalTests: 50 } }) === 0,
        String(count({ state: { completedTests: 0, totalTests: 50 } })));
    check('completedTests 缺失才退回 totalTests', count({ state: { totalTests: 50 } }) === 50);
    check('两者都缺失返回 0', count({ state: {} }) === 0);
    check('task 为 null 返回 0 而不抛异常', count(null) === 0);
    check('NaN 不算有效执行数，退回计划数',
        count({ state: { completedTests: NaN, totalTests: 9 } }) === 9);
    check('Infinity 不算有效执行数',
        count({ state: { completedTests: Infinity, totalTests: 9 } }) === 9);
    check('字符串不做隐式转换',
        count({ state: { completedTests: '12', totalTests: 9 } }) === 9);
}
// 旧引擎的执行计数与成功数口径都改成真跑（见文件尾 handlerBehaviour）：
// 原守卫是 /const markExecuted = \(\) => \{[\s\S]*?executed\+\+;…completedTests = executed;/
// 和 /successfulTests = task\.state\.totalTests - failedGenerations/ 的否定式 ——
// 把 completedTests 写成 totalTests、或者只累加内部计数不回写任务，那行字照样匹配。

// 引擎事件载荷（complete / stopped / incomplete_run）改成真跑：
// fixtures/fake-compare-engine.js 用 vm 注入假 Worker，跑 compare-engine-v2.js 的本体，
// 按 worker 真实上报的 progress/error 消息收事件。原先锁的是
// `/emit\('complete', \{ total: this\._total, completed: this\._completed/` 这类字面量 ——
// 载荷少一个字段、或者把英文告警串拼回 message 里，正则都照样绿；
// 而计数算错、停止时发成 complete，同样是绿。见文件尾 engineBehaviour()。

// ---- 手动停止后仍要能看到完成数 ----
{
    // stopComparison / resetComparison 真调，断言的是 task.state 的最终值和 electronAPI 的调用次数。
    // 原守卫锁 /task\.state\.mode = 'stopping';/ 这行字 —— 把它改回 'idle'（就是这个 bug 本体）
    // 只要字面上还剩 'stopping' 三个字，正则照样绿。
    const mk = (mode) => {
        const task = { state: { mode, isRunning: mode === 'running', shouldStop: false, completedTests: 4, totalTests: 9 } };
        const h = comparerHarness(['stopComparison'], { getActiveTask: () => task });
        h.real.stopComparison.call(h.self);
        return { task, h };
    };
    const running = mk('running');
    check('停止运行中的任务落成 stopping，不是 idle（否则完成事件的计数全丢）',
        running.task.state.mode === 'stopping', running.task.state.mode);
    check('停止时 isRunning 归 false、shouldStop 置 true',
        running.task.state.isRunning === false && running.task.state.shouldStop === true);
    check('停止要通知主进程一次，并立刻重画',
        running.h.api.stopCompareCalls === 1 && called(running.h.calls, 'renderTask'),
        JSON.stringify(running.h.calls.map((c) => c.name)));
    check('停止不许顺手抹掉已完成计数',
        running.task.state.completedTests === 4);
    for (const mode of ['complete', 'stopped', 'error', 'idle']) {
        const kept = mk(mode);
        check(`非运行态（${mode}）停止不改 mode，避免把完成/错误面板刷掉`,
            kept.task.state.mode === mode, kept.task.state.mode);
    }
    const noTask = comparerHarness(['stopComparison'], { getActiveTask: () => null });
    noTask.real.stopComparison.call(noTask.self);
    check('没有活动任务时直接返回，不打主进程也不重画',
        noTask.api.stopCompareCalls === 0 && noTask.calls.length === 0,
        JSON.stringify(noTask.calls.map((c) => c.name)));

    const resetTask = {
        state: {
            isRunning: true, currentTest: 3, totalTests: 9, completedTests: 7, failedTests: 2,
            statusText: 'X', errorResult: { a: 1 }, warningMessage: 'W', mode: 'error'
        }
    };
    const r = comparerHarness(['resetComparison'], { getActiveTask: () => resetTask });
    r.real.resetComparison.call(r.self);
    check('重置把进度条宽度写回 0%',
        r.named('progress-fill').style.width === '0%',
        JSON.stringify(r.named('progress-fill').style));
    check('重置清空全部计数与状态（completedTests/currentTest/failedTests 归零，面板数据置空）',
        resetTask.state.completedTests === 0 && resetTask.state.currentTest === 0
        && resetTask.state.failedTests === 0 && resetTask.state.totalTests === 0
        && resetTask.state.errorResult === null && resetTask.state.warningMessage === null
        && resetTask.state.mode === 'idle' && resetTask.state.isRunning === false
        && resetTask.state.stopped === false, JSON.stringify(resetTask.state));
    check('重置后的状态文案取 compare.ready',
        r.seen.t.some(([k]) => k === 'compare.ready'), JSON.stringify(r.seen.t.map(([k]) => k)));
    check('重置也走一次 renderTask', called(r.calls, 'renderTask'),
        JSON.stringify(r.calls.map((c) => c.name)));
    const rIdle = comparerHarness(['resetComparison'], { getActiveTask: () => null });
    rIdle.real.resetComparison.call(rIdle.self);
    check('没有活动任务时 reset 不碰进度条',
        rIdle.named('progress-fill') === undefined && rIdle.calls.length === 0,
        JSON.stringify(rIdle.seen.lookups));
}
// 停止收尾（result.stopped → mode='stopped' + compare.compareStopped）改成真跑：
// 见文件尾 handlerBehaviour 的完成回调段。原守卫是
// /if \(result\.stopped\) \{[\s\S]*?task\.state\.mode = 'stopped';/ 和 /compare\.compareStopped/ ——
// 把完成数取错字段、或者停止态误用完成文案，那两行字都还在。

// ---- 进度标签与状态文案语义分离 ----

check('进度标签的译文带齐 current 与 total 两个占位',
    zh.compare.progressGroup.includes('{current}')
    && zh.compare.progressGroup.includes('{total}'));
{
    // 进度条宽度：真调 updateProgress，看写进 style.width 的实际百分比
    const realDocument = global.document;
    const realWindow = global.window;
    const seen = { width: [], label: null };
    global.document = {
        getElementById: (id) => {
            if (id === 'progress-fill') return { style: { set width(v) { seen.width.push(v); } } };
            if (id === 'current-test') return { set textContent(v) { seen.label = v; } };
            return null;
        }
    };
    global.window = { i18n: { t: (key, params) => { seen.labelKey = key; seen.labelParams = params; return `${key}:${params.current}/${params.total}`; } } };
    const paint = (done, total) => { seen.width = []; cmp.updateProgress.call(null, done, total); return seen.width[seen.width.length - 1]; };
    try {
        check('进度 5/10 是 50%', paint(5, 10) === '50%');
        check('进度 0/10 是 0%', paint(0, 10) === '0%');
        check('超计划完成（12/10）也夹在 100%，不出现 120% 宽度', paint(12, 10) === '100%');
        check('计数为负也夹在 0%', paint(-3, 10) === '0%');
        check('总数为 0 时不写宽度（避免 0/0 变成 NaN%）',
            (() => { seen.width = []; cmp.updateProgress.call(null, 0, 0); return seen.width.length === 0; })(),
            `writes=${seen.width.length}`);
        // 标签断言必须用两个不等的数：0/0 这种对称实参查不出「已完成 / 总数」被对调
        paint(3, 7);
        check('标签用 current=已完成、total=总数渲染 progressGroup',
            seen.labelKey === 'compare.progressGroup' && seen.labelParams.current === 3 && seen.labelParams.total === 7,
            JSON.stringify(seen.labelParams));
        check('标签文本是 3/7 而不是 7/3', seen.label === 'compare.progressGroup:3/7', seen.label);
        global.document = { getElementById: () => null };
        let threw = null;
        try { cmp.updateProgress.call(null, 1, 2); }
        catch (error) { threw = error; }
        check('两个元素都不存在时只是不画，不抛异常', threw === null, String(threw && threw.message));
    }
    finally {
        global.document = realDocument;
        global.window = realWindow;
    }
}
// 原守卫是 `!/<span id="current-test">Test 0<\/span>/.test(htmlSource)`：
// 只认「Test 0」这一种写法 —— 改成 "Test 1"、"0 / 100"，或者把英文字塞进 title 属性，
// 它全都照样绿；反过来译文换个说法又能把它假红。改成把那个标签真解析出来看内容。
const tagById = (html, id) => {
    const m = new RegExp('<([a-z0-9]+)\\b[^>]*\\bid="' + id + '"[^>]*>').exec(html);
    if (!m) return null;
    const close = html.indexOf('</' + m[1] + '>', m.index);
    return close < 0 ? null : { tag: m[0], text: html.slice(m.index + m[0].length, close) };
};
const ctEl = tagById(htmlSource, 'current-test');
check('index.html 里解析得到 #current-test 标签', ctEl !== null, ctEl && ctEl.tag);
check('进度标签初值不写死任何文案（值一律由 updateProgress 落）',
    ctEl !== null && ctEl.text.trim() === '', JSON.stringify(ctEl && ctEl.text));
check('进度标签不挂 data-i18n（挂了切语言就会把实时进度盖成译文）',
    ctEl !== null && !/data-i18n/.test(ctEl.tag), ctEl && ctEl.tag);
check('进度标签也不靠 title/aria 带英文默认值',
    ctEl !== null && !/(title|aria-label)\s*=\s*"[^"]*[A-Za-z]{4}/.test(ctEl.tag), ctEl && ctEl.tag);

// ---- 错误区渲染：把 showError 真调，读它落到 DOM 桩上的最终值 ----
//
// 下面这些断言的对象全挤在 showError 那 190 行里。原先锁的是四处字面量：
// errorGroup 的三元、`:\s*''` 的空串分支、output_limit 的标题分支、
// diffPosition 的 truncated 短路。正则只能看见「那行字还在」，看不见
// errType 走错分支、上一轮的「第 4 组」没被清掉、截断了照样算行列。
// showError 的分支判断依赖六个成员的真返回值，所以一起抽进 vm；
// updateErrorOutputExpandButton / renderExpandedOutput 不在断言范围内，留给 Proxy 记录。
const hasLangKey = (key) => {
    const [ns, ...rest] = key.split('.');
    const leaf = rest.join('.');
    return [zh, en].every((pack) => pack[ns] !== undefined && pack[ns][leaf] !== undefined);
};
const ERROR_METHODS = ['showError', 'hideError', 'isEngineErrorType', 'getEngineErrorLabel',
    'getEngineErrorMessage', 'buildEngineErrorText', 'getDifferenceInfo', 'normalizeForCompare',
    'limitOutputLines', 'formatCompareOutput', 'addLineNumbers', 'highlightCharacterDifferences',
    'getTruncationText', 'escapeHtml'];
const eh = comparerHarness(ERROR_METHODS);
const draw = (result) => eh.self.showError(result);
// 各错误区元素「当前显示的那一份」（textContent / innerHTML  whichever 最后被写）
const shown = (id) => eh.el(id).shown;

{
    draw({
        errorType: 'wrong_answer', testNumber: 4, usedSpj: false,
        input: 'IN', stdOutput: 'a\nb', testOutput: 'a\nc', stdOutputTruncated: true
    });
    check('输出被截断时只说「行列不可靠」，不给具体行列',
        shown('std-output-diff-label').includes('compare.diffPositionUnreliable')
        && !shown('std-output-diff-label').includes('compare.diffPosition|'),
        shown('std-output-diff-label'));
    check('test 侧标签同样说不可靠（两侧各自渲染，不是只补了 std）',
        shown('test-output-diff-label').includes('compare.diffPositionUnreliable')
        && !shown('test-output-diff-label').includes('compare.diffPosition|'),
        shown('test-output-diff-label'));
    check('有真实组号时组号那格写 errorGroup 并带上组号',
        shown('error-test-num') === 'compare.errorGroup|{"number":4}', shown('error-test-num'));
    check('渲染错误结果会把错误区显出来',
        eh.el('compare-result').style.display === 'block',
        JSON.stringify(eh.el('compare-result').style));
    check('顺手收起状态区与完成面板（错误结果不能和上一轮的面板并存）',
        called(eh.calls, 'hideStatus') && called(eh.calls, 'hideComplete'),
        JSON.stringify(eh.calls.map((c) => c.name)));

    draw({ errorType: 'wrong_answer', testNumber: 4, usedSpj: false, input: 'IN', stdOutput: 'a\nb', testOutput: 'a\nc' });
    check('同一份输出没收截断时，按真实差异给出行列（第 2 行第 1 列）',
        shown('std-output-diff-label').includes('compare.diffPosition|{"line":2,"char":1}'),
        shown('std-output-diff-label'));

    draw({
        errorType: 'wrong_answer', testNumber: 4, usedSpj: false, input: 'IN',
        stdOutput: 'a\nb', testOutput: 'a\nc', testOutputTruncated: true
    });
    check('test 侧被截断也让 std 侧一并放弃行列（两个标记是「或」关系）',
        shown('std-output-diff-label').includes('compare.diffPositionUnreliable'),
        shown('std-output-diff-label'));

    draw({
        errorType: 'std_re', testNumber: 6, errorMessage: 'compare.stdRe',
        rawErrorMessage: '  terminate called  ', stdOutput: 'S', testOutput: 'T'
    });
    check('引擎错误走 buildEngineErrorText：本地化在前、原始细节折叠在后',
        shown('std-output-diff') === 'compare.stdRe\n[terminate called]'
        && shown('test-output-diff') === 'compare.stdRe\n[terminate called]',
        JSON.stringify(shown('std-output-diff')));
    check('引擎错误的两侧标签各按 std / test 取，不共用一句',
        shown('std-output-diff-label') === 'compare.errorStandardOutput'
        && shown('test-output-diff-label') === 'compare.errorStdTestOutput',
        `${shown('std-output-diff-label')} / ${shown('test-output-diff-label')}`);
    check('组号 6 照样显示（引擎错误不是没有组号）',
        shown('error-test-num') === 'compare.errorGroup|{"number":6}', shown('error-test-num'));

    draw({ errorType: 'output_limit', testNumber: 0, stdOutput: '', testOutput: '' });
    check('output_limit 用自己的译文当标题，不落「找到差异」兜底',
        shown('error-title') === 'compare.errorOutputLimit', shown('error-title'));
    check('没有真实组号时把上一轮残留的组号清空',
        shown('error-test-num') === '', JSON.stringify(shown('error-test-num')));
    draw({ errorType: 'worker_crash', testNumber: 1, stdOutput: '', testOutput: '' });
    check('worker_crash 归到引擎错误标题', shown('error-title') === 'compare.engineError', shown('error-title'));
    draw({ errorType: 'compile_error', compileType: 'test', testNumber: 0, errorMessage: 'boom', testOutput: '' });
    check('编译失败按 compileType 取标题，正文走编译输出那一分支',
        shown('error-title') === 'compare.testCompileFail'
        && shown('std-output-diff') === 'boom',
        `${shown('error-title')} / ${JSON.stringify(shown('std-output-diff'))}`);
    draw({ errorType: 'mismatch', testNumber: 2, usedSpj: true, stdOutput: 'S', testOutput: 'T' });
    check('SPJ 模式不给行列提示，标签就是标准输出那一句',
        shown('std-output-diff-label') === 'compare.errorStandardOutput'
        && !shown('std-output-diff-label').includes('diffPosition'),
        shown('std-output-diff-label'));

    draw({ errorType: 'mismatch', testNumber: 1, usedSpj: false, input: 'I', stdOutput: '<script>bad()</script>', testOutput: 'ok' });
    check('差异正文按 HTML 转义后写进 innerHTML，不把用户输出当标签注入',
        shown('std-output-diff').includes('&lt;script&gt;') && !shown('std-output-diff').includes('<script>'),
        shown('std-output-diff').slice(0, 120));

    // errorResult 为空是渲染层的常态（hideError 之后重开），不能抛
    let threw = null;
    try { draw(null); } catch (error) { threw = error; }
    check('errorResult 为 null 时什么都不画，也不抛', threw === null, String(threw && threw.message));
    eh.self.hideError();
    check('hideError 把错误区收回 none', eh.el('compare-result').style.display === 'none',
        JSON.stringify(eh.el('compare-result').style));
}

// 输出被截断时 diffPosition 那一格：input 侧的截断标注同样要真落到文本里
{
    draw({
        errorType: 'mismatch', testNumber: 1, usedSpj: false, input: 'IN',
        inputTruncated: true, stdOutput: 'a', testOutput: 'b'
    });
    check('input 被截断时正文后面附截断提示，不静默砍',
        shown('input-diff') === 'IN\ncompare.outputTruncated', JSON.stringify(shown('input-diff')));
    draw({ errorType: 'mismatch', testNumber: 1, usedSpj: false, input: 'IN', stdOutput: 'a', testOutput: 'b' });
    check('没截断时 input 就是正文本身（截断提示不许常驻）',
        shown('input-diff') === 'IN', JSON.stringify(shown('input-diff')));
}

// ---- 引擎错误面板标题：std / test 两侧共用一套码表 ----
{
    const label = (code, panel) => eh.real.getEngineErrorLabel.call(eh.self, code, panel);
    const pairs = [
        ['generator', 'std', 'compare.errorGeneratorOutput'],
        ['output_limit', 'std', 'compare.errorOutputLimit'],
        ['output_limit', 'test', 'compare.errorOutputLimit'],
        ['std_tle', 'std', 'compare.errorStandardOutput'],
        ['std_re', 'std', 'compare.errorStandardOutput'],
        ['std_tle', 'test', 'compare.errorStdTestOutput'],
        ['test_tle', 'test', 'compare.errorTestOutput'],
        ['test_re', 'std', 'compare.errorStdTestOutput'],
        ['worker_crash', 'std', 'compare.engineError'],
        ['weird_code', 'std', 'compare.engineError']
    ];
    const wrong = pairs.filter(([c, p, want]) => label(c, p) !== want)
        .map(([c, p, want]) => `${c}/${p}→${label(c, p)}≠${want}`);
    check('每个错误码在 std / test 两侧都拿到自己的面板标题', wrong.length === 0, wrong.join(', '));
    const keys = [...new Set(pairs.map(([, , want]) => want))];
    const missing = keys.filter((k) => !hasLangKey(k));
    check('标题用到的键在两语言包都存在', missing.length === 0, missing.join(','));
}

// ---- 引擎码 → 译文：跑真映射，顺带把键存在性交叉锁到语言包 ----
{
    const msg = (error) => eh.real.getEngineErrorMessage.call(eh.self, error);
    const keyOf = (out) => String(out).split('|')[0];
    const MAP = {
        gen_timeout: 'compare.genTle',
        gen_error: 'compare.generatorRunFailed',
        gen_exit: 'compare.genExit',
        std_timeout: 'compare.stdTle',
        std_exit: 'compare.stdExit',
        std_error: 'compare.stdRe',
        test_timeout: 'compare.testTle',
        test_exit: 'compare.testExit',
        test_error: 'compare.testRe',
        output_limit: 'compare.errorOutputLimitDetail',
        mismatch: 'compare.foundDiff',
        exception: 'compare.engineError',
        engine_start: 'compare.engineError',
        worker_crash: 'compare.engineError',
        fastspawn_fallback: 'compare.fastspawnFallback',
        incomplete_run: 'compare.incompleteRun'
    };
    const mismapped = Object.entries(MAP)
        .filter(([code, want]) => keyOf(msg({ code, exitCode: null, message: 'd' })) !== want)
        .map(([code, want]) => `${code}→${keyOf(msg({ code, exitCode: null, message: 'd' }))}≠${want}`);
    check('每个引擎码都落到码表里那条译文（掉出码表会被 engineError 悄悄吞掉）',
        mismapped.length === 0, mismapped.join(', '));
    const absent = Object.values(MAP).filter((k) => !hasLangKey(k));
    check('码表引用的键在 zh / en 两语言包都存在', absent.length === 0, absent.join(','));
    check('码表里没有的码走引擎错误兜底，不返回 undefined',
        msg({ code: 'no_such_code' }) === 'compare.engineError'
        && msg({}) === 'compare.engineError' && msg(null) === 'compare.engineError',
        String(msg({ code: 'no_such_code' })));
    check('退出类错误带 exitCode 时把组号与技术细节一起传给译文',
        msg({ code: 'gen_exit', exitCode: 3, message: 'boom' })
        === 'compare.genExit|{"code":3,"error":"boom"}',
        msg({ code: 'gen_exit', exitCode: 3, message: 'boom' }));
    check('exitCode 为 null 时不带 code 参数（否则模板里的 {code} 会原样显示）',
        msg({ code: 'std_exit', exitCode: null, message: 'boom' }) === 'compare.stdExit',
        msg({ code: 'std_exit', exitCode: null, message: 'boom' }));
    check('message 缺失时退出类错误把 error 参数收成空串',
        msg({ code: 'test_exit', exitCode: 1 }) === 'compare.testExit|{"code":1,"error":""}',
        msg({ code: 'test_exit', exitCode: 1 }));
    check('运行错误类（*_error）无条件带 code 与 error 两个参数',
        msg({ code: 'std_error', message: 're' }) === 'compare.stdRe|{"error":"re","code":""}',
        msg({ code: 'std_error', message: 're' }));
}

// ---- 本地化文案在前、技术细节附后，两份一样时不重复 ----
{
    const build = (r) => eh.real.buildEngineErrorText.call(eh.self, r);
    check('有原始细节时拼在本地化文案后面并用方括号标出',
        build({ errorMessage: '引擎错误', rawErrorMessage: '  worker exit 1  ' })
        === '引擎错误\n[worker exit 1]',
        JSON.stringify(build({ errorMessage: '引擎错误', rawErrorMessage: ' worker exit 1 ' })));
    check('原始细节两侧空白被去掉，不靠 trim 之外的加工',
        build({ errorMessage: 'A', rawErrorMessage: '\t\nB\n' }) === 'A\n[B]',
        JSON.stringify(build({ errorMessage: 'A', rawErrorMessage: '\t\nB\n' })));
    check('两份内容相同只出一份（不许自己跟自己重复一遍）',
        build({ errorMessage: 'same', rawErrorMessage: 'same' }) === 'same');
    check('没有原始细节时只有本地化文案，不留方括号',
        build({ errorMessage: 'only', rawErrorMessage: '' }) === 'only'
        && build({ errorMessage: 'only' }) === 'only');
    check('本地化文案缺失时至少给出原始细节，不返回空串',
        build({ rawErrorMessage: 'raw only' }) === '[raw only]',
        JSON.stringify(build({ rawErrorMessage: 'raw only' })));
    check('两者都缺时返回空串而不是 "undefined"（拼进 DOM 就是字面量）',
        build({}) === '' && build({ errorMessage: '', rawErrorMessage: '' }) === '',
        JSON.stringify(build({})));
}

// ---- 截断提示：i18n 没就绪时不许抛 ----
{
    const gt = comparerHarness(['getTruncationText']);
    const call = () => {
        try { return gt.real.getTruncationText.call(gt.self); }
        catch (error) { return `THREW:${error.message}`; }
    };
    check('i18n 就绪时取 compare.outputTruncated', call() === 'compare.outputTruncated', String(call()));
    gt.ctx.window = {};
    check('window 上没有 i18n 时回落占位串（可选链不能省）', call() === '[truncated]', String(call()));
    gt.ctx.window = { i18n: {} };
    check('i18n 在但 t 不是函数时同样回落', call() === '[truncated]', String(call()));
    gt.ctx.window = { i18n: { t: () => undefined } };
    check('译文查不到（返回 undefined）时用占位串顶上空 DOM', call() === '[truncated]', String(call()));
}

// ---- 完成面板不被当成任意提示位 ----
{
    // 原守卫锁 /showSuccessMessage\(message\) \{\s*logInfo\(String\(message \|\| ''\)\);/
    // —— 把 logInfo 换成往完成面板写一句、或不再 String()，只要那行字没动就照样绿。
    const sh = comparerHarness(['showSuccessMessage']);
    sh.real.showSuccessMessage.call(sh.self, '导出完成');
    check('成功提示只写日志，一个 DOM 元素都不碰',
        sh.seen.logs.length === 1 && sh.seen.logs[0][0] === '导出完成' && sh.seen.lookups.length === 0,
        JSON.stringify({ logs: sh.seen.logs, lookups: sh.seen.lookups }));
    sh.real.showSuccessMessage.call(sh.self, undefined);
    check('提示内容缺失时写空串，不把 "undefined" 记进日志',
        sh.seen.logs.length === 2 && sh.seen.logs[1][0] === '',
        JSON.stringify(sh.seen.logs));
    sh.real.showSuccessMessage.call(sh.self, 0);
    check('数字 0 也按 falsy 收成空串（这是 String(message || \'\') 的实际口径）',
        sh.seen.logs[2][0] === '', JSON.stringify(sh.seen.logs[2]));
}

// ---- 导出/差异数据不得被静默截断 ----
//
// 截断链路 worker → engine → renderer 的前两环改成真跑（见文件尾 workerBehaviour /
// engineBehaviour）：worker 侧抽 fail 闭包 + captureText 真调，看实际回传的
// 正文长度与三个 truncated 标记；引擎侧注入带标记的 worker 消息，看渲染层收到的载荷。
// 原来锁的是 /MAX_CAPTURED_INPUT_BYTES = 1024 \* 1024/ 和 /inputTruncated: input\.truncated/
// 这类字面量 —— 上限改回 200 字节、或者把标记错配到别的字段上，只要那行字还在就照样绿。

// 渲染层这一环（截断标记落进 errorResult）改成真跑：见文件尾 handlerBehaviour 的错误回调段，
// 原守卫是 /inputTruncated: !!error\.inputTruncated/ 三行字 —— 标记错配到别的字段、
// 或者不收布尔（undefined 直接进面板），字面量都照样匹配。
{
    // 行列提示是直接给用户看的，0-based/1-based、短侧补齐规则都必须按返回值验，
    // 光锁「truncated 时不给 diffPosition」那行字改不动它的算法。
    const pos = (a, b) => {
        try { return JSON.stringify(cmp.getDifferenceInfo.call(cmp, a, b)); }
        catch (error) { return `THREW:${error.message}`; }
    };
    check('完全相同不报行列', pos('a\nb', 'a\nb') === 'null');
    check('行尾空格差异不报行列（与归一化同口径）', pos('a \nb', 'a\nb') === 'null');
    check('CRLF / LF 差异不报行列', pos('a\r\nb', 'a\nb') === 'null');
    check('BOM 差异不报行列', pos(String.fromCharCode(0xFEFF) + 'a', 'a') === 'null');
    check('末尾多余换行不报行列', pos('a\n', 'a') === 'null');
    check('行号是 1-based：第二行首字符不同报 line 2 char 1',
        pos('a\nb', 'a\nc') === '{"line":2,"char":1}', pos('a\nb', 'a\nc'));
    check('列号是 1-based：第二个字符不同报 char 2',
        pos('ab1\nxyc', 'ab1\nxzc') === '{"line":2,"char":2}', pos('ab1\nxyc', 'ab1\nxzc'));
    check('一侧是另一侧的前缀时，报缺位那一列而不是漏报',
        pos('ab', 'abc') === '{"line":1,"char":3}', pos('ab', 'abc'));
    check('实际更短同样定位到缺位列', pos('a\nbc', 'a\nb') === '{"line":2,"char":2}', pos('a\nbc', 'a\nb'));
    check('空输出 vs 有输出报 line 1 char 1', pos('', 'a') === '{"line":1,"char":1}');
    check('null 输入不抛异常，按空串处理', pos(null, null) === 'null' && pos(null, 'a') === '{"line":1,"char":1}');
}
// 截断时不报行列改成真跑（见上面 showError 段）：原守卫是
// `/const truncated = !!\(errorResult\.stdOutputTruncated \|\| .*\)[\s\S]{0,40}?const diffPosition = truncated \? null/`
// —— 只覆盖 std 一侧，且把 `||` 写成 `&&`、或者让 test 侧漏掉这道短路，都照样绿。

// ---- output_limit 不得被当成 WA 渲染 ----

{
    const engineCodes = ['generator', 'std_tle', 'std_re', 'test_tle', 'test_re', 'output_limit',
        'worker_crash', 'engine', 'exception', 'fastspawn_fallback', 'incomplete_run'];
    const wrong = engineCodes.filter((code) => cmp.isEngineErrorType.call(null, code) !== true);
    check('每个引擎错误码都被认成引擎错误', wrong.length === 0, wrong.join(','));
    const judged = ['wrong_answer', 'accepted', 'presentation_error', 'time_limit', '', undefined, null, 0];
    const misjudged = judged.filter((code) => cmp.isEngineErrorType.call(null, code) !== false);
    check('判定结果不是答案错误，不被当成引擎错误', misjudged.length === 0, misjudged.join(','));
}

// ---- 0 = 不限时的语义在两条引擎路径上一致 ----
//
// 归一化改成真跑：引擎侧看它**实际下发给 worker 的 postMessage 载荷**（engineBehaviour），
// worker 侧把 `const genTimeout = ...` 那条语句抽出来求值（workerBehaviour）。
// 原来锁的是 `/Number\.isFinite\(config\.timeLimit\) && ... : 0/` 整串三元表达式 ——
// 把 `> 0` 写成 `>= 0`、或者退回 `|| 5000` 兜底，只要字面量还在就照样绿。
// 渲染层这一环（config 里到底带不带 generatorTimeout）见文件尾 handlerBehaviour()。

// ---- 输入框 clamp 必须回写 ----

{
    // syncInstanceConfigToTask 真调：夹完的组数既要落进 task.config，也要写回输入框，
    // 否则界面显示 200000、实际跑 100000，用户看到的和跑的不是一回事。
    // 上限不写死数字，从 `const MAX_COMPARE_COUNT = ...` 那条声明求值后交叉锁。
    const maxSrc = scalarConst(comparerSource, 'MAX_COMPARE_COUNT');
    check('组数上限常量抽取成功', maxSrc.startsWith('const MAX_COMPARE_COUNT'), maxSrc);
    const CAP = new Function(`${maxSrc} return MAX_COMPARE_COUNT;`)();
    const clampHarness = (value) => {
        const h = comparerHarness(['syncInstanceConfigToTask']);
        // MAX_COMPARE_COUNT 是文件级 const（浏览器里同一份脚本内可见，但不在 window 上）。
        // vm 里只编译了这一个方法，所以把抽出来的常量值绑到全局：换个标识符引用就会
        // ReferenceError 当场红，值本身仍来自源码，不是我编的桩。
        h.ctx.MAX_COMPARE_COUNT = CAP;
        const task = { config: { compareCount: 7, timeLimit: 900 } };
        h.el('compare-count').value = String(value);
        h.el('time-limit').value = '1500';
        h.el('compare-threads').value = '4';
        h.real.syncInstanceConfigToTask.call(h.self, task);
        return { h, task, inputValue: () => h.el('compare-count').value };
    };
    const over = clampHarness(CAP + 500);
    check('超上限的组数被夹到上限，并回写输入框',
        over.task.config.compareCount === CAP && over.inputValue() === String(CAP),
        JSON.stringify({ inTask: over.task.config.compareCount, inBox: over.inputValue() }));
    const under = clampHarness(0);
    check('0 组夹成 1 组（同样回写，输入框不许还停在 0）',
        under.task.config.compareCount === 1 && under.inputValue() === '1',
        JSON.stringify({ inTask: under.task.config.compareCount, inBox: under.inputValue() }));
    const legal = clampHarness(30);
    check('合法值不被 clamp 动过，也不多余地重写输入框',
        legal.task.config.compareCount === 30 && legal.inputValue() === '30',
        JSON.stringify({ inTask: legal.task.config.compareCount, inBox: legal.inputValue() }));
    check('时限与线程数一并同步进任务配置',
        legal.task.config.timeLimit === 1500, String(legal.task.config.timeLimit));
    const empty = clampHarness('abc');
    check('输入框不是数字时保留任务里原有的组数，不写 NaN 也不清空输入框',
        empty.task.config.compareCount === 7 && empty.inputValue() === 'abc',
        JSON.stringify({ inTask: empty.task.config.compareCount, inBox: empty.inputValue() }));
    check('两个 null 都不抛（任务缺 config、输入框缺元素）',
        (() => {
            const h = comparerHarness(['syncInstanceConfigToTask']);
            try { h.real.syncInstanceConfigToTask.call(h.self, null); return true; }
            catch (_) { return false; }
        })());
}
// 起跑路径上还有第二处同样的 clamp（runTask 里，夹完写回 #compare-count）。
// 原来留的是两条字面量：匹配 `compareCountEl && Number(compareCountEl.value) !== compareCount`
// 这行长相，外加数 MAX_COMPARE_COUNT 出现几次。前者一改排版就碎，后者把「两处共用同一个上限」
// 说成了一个计数 —— 真加第三处、或两处各自写死不同的数字，它都拦不住。
// 现在把两段代码都抽出来在假输入框上跑：回没回写、回写成几，是结果；
// 「两处共用同一个上限」则是把两段喂同一组输入比对输出，不再数出现次数。
{
    const capDecl = scalarConst(comparerSource, 'MAX_COMPARE_COUNT');
    check('上限常量的声明抽出来成功', /^\s*(?:const|let)\s+MAX_COMPARE_COUNT\s*=/.test(capDecl), capDecl);

    // 区间定位只用「行首形态 + 块内必须出现的语句」，不拿整条条件的字面长相当锚点：
    // 条件里换个变量名、tsc printer 把单行 if 拆成两行，都不该让抽取失败；
    // 反过来「回写那段被删掉」时区间仍然合法可跑，红点落在行为断言上，不是红在切片的语法错上。
    const cmpLines = comparerSource.split(/\r?\n/);
    const nl = (s) => (s.match(/\n/g) || []).length;
    const firstIfBlock = (from, want, span = 8) => {
        for (let i = from; i < cmpLines.length && i <= from + span; i++) {
            if (!/^[ \t]*if \(/.test(cmpLines[i])) continue;
            const block = ifStatement(cmpLines.slice(i).join('\n'), /^([ \t]*)if \(/m, { allowBraceless: true });
            if (block && want.test(block)) return { block, end: i + nl(block) };
        }
        return null;
    };
    const lineOf = (re, from = 0) => cmpLines.findIndex((l, i) => i >= from && re.test(l));

    let bStart = lineOf(/^\s*let compareCount = parseInt\(compareCountEl\?\.value\)/);
    if (bStart > 0 && /const compareCountEl = ccInput\('compare-count'\);/.test(cmpLines[bStart - 1])) bStart -= 1;
    let clampLine = lineOf(/^\s*compareCount = Math\.\w+\(/, bStart);
    const bWrite = clampLine >= 0 ? firstIfBlock(clampLine + 1, /compareCountEl\s*\.\s*value\s*=/) : null;
    const clampRun = (bStart >= 0 && clampLine >= 0)
        ? cmpLines.slice(bStart, (bWrite ? bWrite.end : clampLine) + 1).join('\n') : '';
    check('runTask 那处 clamp 整段抽取成功（切片非空，且能独立跑起来）', clampRun.length > 80,
        JSON.stringify(clampRun.slice(0, 60)));

    // A 段是「整个判断写在一个 if 里」的形态：从 compareCount 那行往后找第一个
    // 真往 task.config.compareCount 赋值的 if 块。
    const declA = lineOf(/^\s*const compareCount = parseInt\(compareCountEl\?\.value\);/);
    const aBlock = declA >= 0 ? firstIfBlock(declA + 1, /task\.config\.compareCount\s*=/) : null;
    const clampIf = aBlock ? aBlock.block : '';
    check('配置同步那处 clamp 整段抽取成功', clampIf.length > 80, JSON.stringify(clampIf.slice(0, 40)));

    // B 段：自带 compareCountEl / compareCount 声明，只依赖 ccInput 与 task。
    // 输入框用 Proxy 包一层：回写这件事本身要能被数出来，不然「重写一遍同样的值」
    // 和「没动」在断言里长得一样。
    const runB = (rawValue, configDefault = 77) => {
        const writes = [];
        const ctx = vm.createContext({ Math, Number, String, parseInt, Object,
            task: { config: { compareCount: configDefault } } });
        ctx.__box = rawValue === null ? null
            : new Proxy({ value: rawValue }, {
                set(t, k, v) { writes.push([String(k), String(v)]); t[k] = v; return true; }
            });
        ctx.ccInput = () => ctx.__box;
        vm.runInContext(`${capDecl}\nthis.__run = () => {\n${clampRun}\nreturn { compareCount, value: __box && __box.value };\n};`, ctx);
        try { return { res: ctx.__run(), cap: vm.runInContext('MAX_COMPARE_COUNT', ctx), writes }; }
        catch (e) { return { threw: String((e && e.message) || e), writes }; }
    };
    // A 段：区间从 `if (Number.isFinite(compareCount))` 起，外层的
    // `const compareCount = parseInt(compareCountEl?.value);` 不在区间里，所以这里替它算一次，
    // 好让两段吃到**同一个输入框内容**。回写同样用 Proxy 计数，A 处的口径才不只是「夹出同一个数」。
    const runA = (rawValue) => {
        const writes = [];
        const ctx = vm.createContext({ Math, Number, String, parseInt, Object,
            task: { config: { compareCount: 100 } }, compareCount: parseInt(rawValue) });
        ctx.compareCountEl = new Proxy({ value: rawValue }, {
            set(t, k, v) { writes.push([String(k), String(v)]); t[k] = v; return true; }
        });
        vm.runInContext(`${capDecl}\nthis.__run = () => {\n${clampIf}\nreturn { capped: task.config.compareCount, boxValue: compareCountEl.value };\n};`, ctx);
        try { return { res: ctx.__run(), cap: vm.runInContext('MAX_COMPARE_COUNT', ctx), writes }; }
        catch (e) { return { threw: String((e && e.message) || e), writes }; }
    };

    const over = runB('999999999');
    check('输入框填超限值：夹到上限并且把夹后的值回写进输入框（原守卫说的就是这件事）',
        over.res && over.res.compareCount === over.cap
            && over.writes.length === 1 && over.writes[0][0] === 'value' && over.writes[0][1] === String(over.cap),
        JSON.stringify(over.res && { compareCount: over.res.compareCount, writes: over.writes, cap: over.cap }));
    const ok = runB('500');
    check('合法值不动、也一次都不回写（免得把用户刚敲的数字格式化掉）',
        ok.res && ok.res.compareCount === 500 && ok.writes.length === 0, JSON.stringify(ok.writes));
    const missing = runB(null);
    check('输入框整个不存在时按配置默认走，不炸（那两处 ?. 与 && 是真起作用的）',
        missing.res && missing.res.compareCount === 77 && missing.writes.length === 0, JSON.stringify(missing));
    const junk = runB('abc');
    check('输入框里是非数字：退回配置默认值，而不是 NaN 传进引擎',
        junk.res && junk.res.compareCount === 77 && Number.isFinite(junk.res.compareCount), JSON.stringify(junk.res));

    const shared = ['500', '999999999', '1'].map((v) => ({ v, b: runB(v), a: runA(v) }));
    check('两段 clamp 对同一组输入夹出同一个上限（共用命名常量是比对结果，不是数出现几次）',
        shared.every((x) => x.a.threw === undefined && x.b.threw === undefined
            && x.a.res.capped === x.b.res.compareCount) && shared.length === 3,
        JSON.stringify(shared.map((x) => x.a.threw || x.b.threw || `${x.v}:${x.a.res.capped}/${x.b.res.compareCount}`)));
    // 回写口径也一起比：两处都只在「夹后跟框里不一样」时写一次。少了一边，
    // 用户就会看到「配置同步时输入框跟着改、起跑时不改」这种两套行为。
    check('两段 clamp 的回写次数与写回的值逐个相同（A 处不是只夹不写）',
        shared.every((x) => JSON.stringify(x.a.writes) === JSON.stringify(x.b.writes)
            && x.a.writes.every((w) => w[1] === String(x.b.res.compareCount)))
            && shared.some((x) => x.a.writes.length === 1) && shared.some((x) => x.a.writes.length === 0),
        JSON.stringify(shared.map((x) => `${x.v}:A=${JSON.stringify(x.a.writes)}B=${JSON.stringify(x.b.writes)}`)));
}

// ---- 截断标记不得靠译文反推 ----

{
    const render = (out, ...rest) => cmp.addLineNumbers.call(cmp, out, ...rest);
    const rows = (html) => (html.match(/class="diff-line"/g) || []).length;
    const marks = (html) => (html.match(/class="diff-truncated"/g) || []).length;
    check('三行输出渲染三行，行号补零到 4 位',
        rows(render('a\nb\nc')) === 3 && render('a\nb\nc').includes('>   1 <'),
        `rows=${rows(render('a\nb\nc'))}`);
    check('truncated=false 时不加截断标记', marks(render('a\nb')) === 0);
    check('truncated=true 时只加一条截断标记，内容是截断文案',
        marks(render('a\nb', true)) === 1 && render('a\nb', true).includes('⟪输出已截断⟫'));
    check('省略第三参等价于 false（默认值仍在）', marks(render('a\nb', undefined)) === 0);
    // 这一条才是原 bug 的正解：截断标记行本身长得和译文一样，也不该被当成标记吞掉
    check('输出里出现与截断译文完全相同的行时，仍按普通行渲染',
        rows(render('⟪输出已截断⟫', false)) === 1 && marks(render('⟪输出已截断⟫', false)) === 0,
        render('⟪输出已截断⟫', false));
    check('每行内容经过 HTML 转义', render('<script>alert(1)</script>').includes('&lt;script&gt;')
        && !render('<script>x</script>').includes('<script>'));
    check('空串渲染出一行空行（split 的真实行为）', rows(render('')) === 1);
}
{
    // formatCompareOutput 的截断口径：either 行数超限，either 上游显式标记。
    // 只锁形参名/默认值的写法挡不住「标记传进来了但没参与判断」。
    const marks = (html) => (html.match(/class="diff-truncated"/g) || []).length;
    const rows = (html) => (html.match(/class="diff-line"/g) || []).length;
    const many = Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n');
    const few = 'a\nb\nc';
    check('两份完全一致且未超行数上限时不显示截断标记',
        marks(cmp.formatCompareOutput.call(cmp, few, few, 'test')) === 0);
    check('完全一致但超过 100 行时按行数上限标截断',
        marks(cmp.formatCompareOutput.call(cmp, many, many, 'test')) === 1 &&
        rows(cmp.formatCompareOutput.call(cmp, many, many, 'test')) === 100,
        `rows=${rows(cmp.formatCompareOutput.call(cmp, many, many, 'test'))}`);
    check('上游显式 truncated=true 时，即使内容不足 100 行也要提示',
        marks(cmp.formatCompareOutput.call(cmp, few, few, 'test', true)) === 1);
    check('显式标记只影响提示，不改变渲染行数',
        rows(cmp.formatCompareOutput.call(cmp, few, few, 'test', true)) === 3);
    check('差异行在 test 侧走字符级高亮',
        cmp.formatCompareOutput.call(cmp, 'a1\nb', 'a2\nb', 'test').includes('diff-highlight'));
    check('差异行在 std 侧不做字符级高亮',
        !cmp.formatCompareOutput.call(cmp, 'a1\nb', 'a2\nb', 'standard').includes('diff-highlight'));
    check('差异之后的尾部内容被省略时也提示截断',
        marks(cmp.formatCompareOutput.call(cmp, many, many.replace('line 3', 'x'))) === 1);
    // 上面那条同时踩中了「行数上限」和「尾部省略」两个分支，这里各拆一条：
    // 只有尾部省略分支能在 100 行以内、且完全不传上游标记时被验证。
    const tailOnly = Array.from({ length: 15 }, (_, i) => `l${i}`).join('\n');
    const tailHtml = cmp.formatCompareOutput.call(cmp, tailOnly, tailOnly.replace('l0', 'X'), 'std');
    check('差异后仍有 4 行未显示时提示截断（未到行数上限、未传上游标记）',
        marks(tailHtml) === 1 && rows(tailHtml) === 11, `rows=${rows(tailHtml)}`);
    check('差异之后的内容全部显示时不添加截断提示',
        marks(cmp.formatCompareOutput.call(cmp, few, few.replace('c', 'X'), 'std')) === 0);
    // 行数不等时缺位按空串比较：写成 otherLines[i] 就会在短侧越界处抛 TypeError
    const safe = (a, b) => {
        try { return cmp.formatCompareOutput.call(cmp, a, b, 'std'); }
        catch (error) { return `THREW:${error.message}`; }
    };
    check('期望侧更长时不越界，尾部按空行判差异',
        !safe('a\nb', 'a\nb\nc').startsWith('THREW') && rows(safe('a\nb', 'a\nb\nc')) === 2,
        safe('a\nb', 'a\nb\nc'));
    check('实际侧更长时不越界',
        !safe('a\nb\nc', 'a\nb').startsWith('THREW') && rows(safe('a\nb\nc', 'a\nb')) === 3,
        safe('a\nb\nc', 'a\nb'));
    check('长度不等且前缀相同不判成差异（不产生高亮行）',
        !safe('a\nb', 'a\nb').includes('diff-highlight'));
    check('limitOutputLines 超限时追加的正是截断文案行（与译文解耦靠显式标记）',
        cmp.limitOutputLines.call(cmp, many, 100).split('\n').length === 101 &&
        cmp.limitOutputLines.call(cmp, many, 100).endsWith('⟪输出已截断⟫'));
    check('limitOutputLines 未超限时原样返回',
        cmp.limitOutputLines.call(cmp, few, 100) === few);
    check('limitOutputLines 对 null 返回空串', cmp.limitOutputLines.call(cmp, null, 100) === '');
}
// 截断文案的 i18n 守卫改成真跑：见上面「截断提示：i18n 没就绪时不许抛」一段，
// 原守卫锁 /window\.i18n\?\.t\?\.\('compare\.outputTruncated'\)/ —— 少写一个 `?.` 就是运行期炸，
// 但那行字照样在。

// ---- 字符级差异高亮 ----

{
    // 只锁「格式化工具里出现 diff-highlight」挡不住高亮算错了位置、漏报尾部差异、
    // 或者拿原始文本比较把行尾空格当差异。这里逐档验实际返回值。
    const realWindow = global.window;
    const hl = (a, b) => cmp.highlightCharacterDifferences.call(cmp, a, b);
    try {
        global.window = {};
        check('两侧都空返回空串（不产生空的 diff-line）', hl('', '') === '');
        check('实际为空、期望有内容时，整段期望被高亮',
            hl('', 'ab') === '<span class="diff-highlight">ab</span>', hl('', 'ab'));
        check('期望为空时实际内容原样返回，不高亮', hl('ab', '') === 'ab');
        check('中间差异只高亮首个不同字符，前后各留一份',
            hl('abc', 'axc') === 'a<span class="diff-highlight">b</span>c', hl('abc', 'axc'));
        check('差异落在末尾时高亮最后一个字符',
            hl('ab', 'a') === 'a<span class="diff-highlight">b</span>', hl('ab', 'a'));
        check('高亮前先按归一化口径比较：行尾空格不算字符级差异',
            hl('a ', 'a') === 'a' && !hl('a ', 'a').includes('diff-highlight'), hl('a ', 'a'));
        check('实际是期望的前缀且更短时补一个高亮占位，不能悄悄判成相同',
            hl('a', 'ab') === 'a<span class="diff-highlight"></span>', hl('a', 'ab'));
        global.window = { uiIcons: { svg: (name) => `svg:${name}` } };
        check('占位图标走 uiIcons.emptyBox，命名空间写错就不显示',
            hl('a', 'ab') === 'a<span class="diff-highlight">svg:emptyBox</span>', hl('a', 'ab'));
        global.window = {};
        check('高亮过的文本仍经过 HTML 转义，首字符差异被单独包出',
            hl('<b>', 'x') === '<span class="diff-highlight">&lt;</span>b&gt;', hl('<b>', 'x'));
    }
    finally {
        global.window = realWindow;
    }
}

// ---- 归一化口径统一 ----

{
    const n = (v) => cmp.normalizeForCompare.call(null, v);
    check('行尾空格不算差异', n('a  \nb') === n('a\nb'));
    check('行尾制表符不算差异', n('a\t\t\nb') === n('a\nb'));
    check('CRLF 与 LF 同口径', n('a\r\nb') === n('a\nb') && n('a\r\nb') === 'a\nb');
    check('裸 CR 也换成 LF', n('a\rb') === 'a\nb');
    check('尾部空行被去掉，中间空行保留', n('a\n\nb\n\n\n') === 'a\n\nb');
    // BOM 一律用码点构造：裸 U+FEFF 在源码里不可见，写错也看不出来
    const bom = String.fromCharCode(0xFEFF);
    check('起始 BOM 被去掉', n(bom + 'abc') === 'abc');
    check('正文里的 BOM 也被清掉', n('a' + bom + 'b') === 'ab');
    check('结尾 BOM 靠全局替换清掉，和起始替换是两条规则', n('ab' + bom) === 'ab');
    check('null / undefined 归一化成空串', n(null) === '' && n(undefined) === '');
    // 判定口径是 text == null，写成 !text 就会把 0 / '' 当成缺失
    check('数字 0 归一化成 "0" 而不是空串', n(0) === '0', JSON.stringify(n(0)));
    check('仅行尾空白不同等价，实际差异仍能报出', n('a  ') === n('a') && n('a ') !== n('b'));
}

// ---- 展开确认框单位自适应 ----

{
    // 单位自适应必须按「字节」而不是「字符数」，且小输出不能再显示成 0.00 MB。
    const bytes = (v) => cmp.getOutputSizeBytes.call(cmp, v);
    const size = (v) => cmp.getOutputSizeText.call(cmp, v);
    check('字节数按 UTF-8 计，不是字符串长度', bytes('啊') === 3 && bytes('abc') === 3);
    check('null / undefined 记作 0 字节而不是抛异常',
        bytes(null) === 0 && bytes(undefined) === 0 && bytes('') === 0);
    check('0 字节显示 0 B', size('') === '0 B', size(''));
    check('1023 字节仍在 B 档', size('a'.repeat(1023)) === '1023 B');
    check('1024 字节进 KB 档并保留一位小数', size('a'.repeat(1024)) === '1.0 KB', size('a'.repeat(1024)));
    check('1500 字节是 1.5 KB', size('a'.repeat(1500)) === '1.5 KB');
    check('差 1 字节到 1 MiB 时仍在 KB 档（阈值是 < 而不是 <=）',
        size('a'.repeat(1024 * 1024 - 1)) === '1024.0 KB', size('a'.repeat(1024 * 1024 - 1)));
    check('整 1 MiB 起才切到 MB 档并保留两位小数', size('a'.repeat(1024 * 1024)) === '1.00 MB');
    check('跨档看字节：1024 个全角字是 3.0 KB 而不是 1.0 KB', size('啊'.repeat(1024)) === '3.0 KB');
    check('KB 以下不再出现 KB/MB 字样（原「0.00 MB」缺陷的形态）',
        !size('').includes('MB') && !size('').includes('KB') && !size('short').includes('MB'));
}
check('expand dialog no longer hardcodes MB in the language pack',
    !zh.compare.expandConfirmMsg.includes('{size} MB')
    && !en.compare.expandConfirmMsg.includes('{size} MB')
    && !zh.compare.expandConfirmMsgText.includes('{size} MB')
    && !en.compare.expandConfirmMsgText.includes('{size} MB'));
// 原守卫 `!/getOutputSizeMbText/.test(comparerSource)` 是全文件字面量缺席：
// 注释里、字符串里提一句旧名就红，而把旧函数真加回来但换个调用写法反而更容易漏。
// 改成先把这个文件里「实际声明了哪些函数/方法」抽成名字表 —— 缺席断言作用在名字表上，
// 说明文字随便写，加回来的函数一定在表里。
const declaredNames = new Set([
    ...[...comparerSource.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]),
    ...[...comparerSource.matchAll(/^\s{4}(?:async\s+|static\s+|get\s+|set\s+)*([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1])
]);
check('codeComparer 的函数/方法名表抽取成功（抽不到下面几条就是真空通过）',
    declaredNames.has('getOutputSizeText') && declaredNames.has('getOutputSizeBytes')
        && declaredNames.size > 20, `共 ${declaredNames.size} 个`);
check('只出 MB 的旧尺寸助手确实不在这张表里', !declaredNames.has('getOutputSizeMbText'),
    [...declaredNames].filter((n) => /size/i.test(n)).join(','));

// 进度条残留 / 完成面板被当成提示位：两条都改成真跑了 ——
// resetComparison 看它实际写进 #progress-fill 的 style.width，
// showSuccessMessage 看它落进日志的内容和「一个 DOM 都不碰」。见上面两段。

// ---- 新增告警通道：两侧都真跑 ----
// 原来是两条正则：主进程那条 `engine\.on\('warning'[\s\S]*?compare-warning` 只要
// 两个词之间出现过的东西不超一段就绿（把 send 换成 sendOnce、或通道写错成
// compare-warning-1 但下文又提到一次正名，都能骗过去）；preload 那条只查「这两个词在文件里」。
{
    const warnCb = callbackBody(mainSource, /engine\.on\('warning',\s*/);
    check('主进程 warning 回调体抽取成功', warnCb.length > 10, JSON.stringify(warnCb.slice(0, 48)));
    const wCtx = vm.createContext({ mainWindow: undefined, String, Object });
    vm.runInContext(`this.__f = (data) => ${warnCb};`, wCtx);
    const fires = [];
    const emit = (win, data) => {
        fires.length = 0;
        wCtx.mainWindow = win;
        let threw;
        try { wCtx.__f.call({ }, data); } catch (e) { threw = String((e && e.message) || e); }
        return { fires: fires.slice(), threw };
    };
    const recWin = (onSend) => ({ webContents: { send: (ch, payload) => { if (onSend) onSend(ch, payload); fires.push([ch, payload]); } } });
    const fwd = emit(recWin(), { code: 'disk-nearly-full', taskId: 't1' });
    check('引擎非致命告警按 compare-warning 通道原样转给渲染层',
        fwd.threw === undefined && fwd.fires.length === 1 && fwd.fires[0][0] === 'compare-warning'
            && fwd.fires[0][1].code === 'disk-nearly-full' && fwd.fires[0][1].taskId === 't1',
        JSON.stringify(fwd));
    const brokenWin = { webContents: { send: () => { throw new Error('Object has been destroyed'); } } };
    const dead = emit(brokenWin, { code: 'x' });
    check('窗口已经没了也不把告警冒成未捕获异常（那层 try 是真的）',
        dead.threw === undefined && dead.fires.length === 0, JSON.stringify(dead));
    check('没有 mainWindow 时静默跳过，不炸',
        (() => { const r = emit(undefined, { code: 'x' }); return r.threw === undefined && r.fires.length === 0; })());

    const warnProp = arrowProp(preloadSource, 'onCompareWarning');
    check('preload 的 onCompareWarning 抽取成功', warnProp !== null && warnProp.body.length > 10,
        warnProp && warnProp.signature);
    const pCtx = vm.createContext({ subscribeIpc: () => { }, ipcRenderer: { removeListener: () => { } }, Function });
    vm.runInContext(`this.__on = ${warnProp.params} => ${warnProp.body};`, pCtx);
    const subs = [];
    const rms = [];
    pCtx.subscribeIpc = (ch, l) => { subs.push([ch, l]); };
    pCtx.ipcRenderer = { removeListener: (ch, l) => { rms.push([ch, l]); } };
    const got = [];
    const unsub = pCtx.__on((d) => got.push(d));
    check('订阅走的就是 compare-warning 这一个通道',
        subs.length === 1 && subs[0][0] === 'compare-warning' && typeof subs[0][1] === 'function',
        JSON.stringify(subs.map((s) => s[0])));
    // 把 (event, data) 摊成 (data) 是给渲染层的接口形状，改回原样传就是让每个调用方多写一个 _.
    subs[0][1]({}, { code: 'near-full' });
    check('事件参数被摊平：回调直接收到 payload 本身',
        got.length === 1 && got[0].code === 'near-full', JSON.stringify(got));
    check('返回的取消函数按同一通道、同一句柄摘干净',
        typeof unsub === 'function' && (unsub(), rms.length === 1
            && rms[0][0] === 'compare-warning' && rms[0][1] === subs[0][1]),
        JSON.stringify({ channels: rms.map((r) => r[0]), sameHandle: rms.length === 1 && rms[0][1] === subs[0][1] }));
}
// 渲染层把告警当非致命改成真跑（见文件尾 handlerBehaviour）：原守卫是
// /onCompareWarning\(\(data\) => \{\s*logWarn/ —— 只要那两行字在，把告警改成 showError
// 或者照样 stopCompare 都查不出来。

// ---- 引擎事件载荷：跑真引擎 + 假 Worker ----
//
// 断言对象是 CompareEngineV2 处理 worker 消息后**实际发出的事件**，
// 不是 compare-engine-v2.js 里的字面量。放在末尾异步段里跑。

const engineBehaviour = async () => {
    const run = await runEngine({
        config: { totalTests: 3 },
        messages: [
            { type: 'progress', testIndex: 1 },
            { type: 'error', testIndex: 1, kind: 'std_re', code: 'std_exit', message: 'boom' },
            { type: 'progress', testIndex: 2 },
            { type: 'error', testIndex: 2, kind: 'output_limit', code: 'output_limit', message: 'too much' },
            { type: 'progress', testIndex: 3 }
        ]
    });
    const complete = pick(run.events, 'complete');
    check('一轮跑完只发一次 complete，不发 stopped',
        complete.length === 1 && pick(run.events, 'stopped').length === 0,
        JSON.stringify(run.events.map((e) => e.type)));
    const done = complete[0] || {};
    check('complete 载荷是真实的 total/completed/failed 计数（3 组跑完、其中 2 组出错）',
        done.total === 3 && done.completed === 3 && done.failed === 2, JSON.stringify(done));
    // 原 bug 的形态就是在这条载荷里拼一句 "N tests failed"：文案必须由渲染层按 code 组装
    check('complete 载荷只有三个数字，没夹任何英文文案',
        Object.keys(done).length === 3 && Object.values(done).every((v) => typeof v === 'number'),
        JSON.stringify(done));

    // 半途停止：状态机走 stopping，收尾必须发 stopped 而不是 complete
    const stoppedRun = await runEngine({
        config: { totalTests: 5 },
        messages: [
            { type: 'progress', testIndex: 1 },
            { type: 'error', testIndex: 2, kind: 'test_re', code: 'test_exit' }
        ],
        stop: true
    });
    const stopped = pick(stoppedRun.events, 'stopped');
    check('手动停止时发的是 stopped，不再补发 complete',
        stopped.length === 1 && pick(stoppedRun.events, 'complete').length === 0,
        JSON.stringify(stoppedRun.events.map((e) => e.type)));
    check('stopped 载荷同样带三个计数，UI 停止后还能看到完成数',
        stopped[0]?.total === 5 && stopped[0]?.completed === 1 && stopped[0]?.failed === 1,
        JSON.stringify(stopped[0]));

    // worker 提前收工：完成数少于计划数，必须以告警形式暴露缺口
    const gap = await runEngine({ config: { totalTests: 4 }, messages: [{ type: 'progress', testIndex: 1 }] });
    const incomplete = pick(gap.events, 'warning').find((w) => w.type === 'incomplete_run');
    check('跑不满计划数时发 incomplete_run 告警，而不是谎称全跑完',
        incomplete !== undefined, JSON.stringify(pick(gap.events, 'warning')));
    check('缺口告警给的是 completed/total/missing 三个计数，message 留空串',
        incomplete?.completed === 1 && incomplete?.total === 4 && incomplete?.missing === 3
        && incomplete?.message === '', JSON.stringify(incomplete));
    // 缺口那一轮的 complete 才是最容易充数的地方：拿计划数当完成数，UI 就显示 4/4 + 100%
    const gapDone = pick(gap.events, 'complete')[0] || {};
    check('缺口那轮的 completed 是真实执行数 1，不是计划数 4',
        gapDone.completed === 1 && gapDone.total === 4, JSON.stringify(gapDone));

    const full = await runEngine({
        config: { totalTests: 2 },
        messages: [{ type: 'progress', testIndex: 1 }, { type: 'progress', testIndex: 2 }]
    });
    check('全部跑完时不该有 incomplete_run 告警',
        pick(full.events, 'warning').every((w) => w.type !== 'incomplete_run'),
        JSON.stringify(pick(full.events, 'warning')));

    // 截断标记的引擎一环：worker 消息里的标记必须逐字段落到渲染层收到的载荷上
    const forwarded = await runEngine({
        config: { totalTests: 2 },
        messages: [{
            type: 'error', testIndex: 1, kind: 'std_re', code: 'std_exit', message: 'x',
            input: 'IN', inputTruncated: true, stdOutputTruncated: 0
        }, {
            // 一条什么都没带的错误：兜底路径必须落成空串，不能漏 undefined 给渲染层拼
            type: 'error', testIndex: 2, kind: 'engine', code: 'engine'
        }]
    });
    const err = pick(forwarded.events, 'error').find((e) => e.testNumber === 1);
    const bare = pick(forwarded.events, 'error').find((e) => e.testNumber === 2);
    check('worker 的三个截断标记逐一透传，且按布尔收窄（0 → false，缺省 → false）',
        err?.inputTruncated === true && err?.stdOutputTruncated === false
        && err?.testOutputTruncated === false, JSON.stringify(err));
    check('引擎把 worker 的 kind 落成 type、code 原样带上（渲染层靠 code 映射译文）',
        err?.type === 'std_re' && err?.code === 'std_exit', JSON.stringify(err));
    check('缺失的输出字段兜空串，不留 undefined（拼字符串不会写出 "undefined"）',
        err?.input === 'IN' && err?.stdOutput === '' && err?.testOutput === '', JSON.stringify(err));
    check('一条都不带的错误消息，三个输出字段全是空串',
        bare?.input === '' && bare?.stdOutput === '' && bare?.testOutput === '',
        JSON.stringify(bare));

    // 超时归一化：看引擎真正下发给 worker 的那条 run-tests 消息
    const postFor = async (config) => (await runEngine({ config })).posts[0];
    const unlimited = await postFor({ totalTests: 3, timeLimit: 0, generatorTimeout: 0 });
    check('0 = 不限时：下发给 worker 的 timeout/generatorTimeout 原样是 0，不是 5000',
        unlimited?.timeout === 0 && unlimited?.generatorTimeout === 0, JSON.stringify(unlimited));
    const junk = await postFor({ totalTests: 3, timeLimit: -1, generatorTimeout: NaN });
    check('负数 / NaN 的时限归一成 0，不带着非法值下发给 worker',
        junk?.timeout === 0 && junk?.generatorTimeout === 0, JSON.stringify(junk));
    const finite = await postFor({ totalTests: 3, timeLimit: 2000, generatorTimeout: 300 });
    check('正数时限原样下发（归一化不许把好值也吃掉）',
        finite?.timeout === 2000 && finite?.generatorTimeout === 300, JSON.stringify(finite));
    check('下发载荷里 executable 路径与本批范围都在（配置校验之外不擅自加工）',
        finite?.stdPath === 'a.exe' && finite?.testPath === 'b.exe'
        && finite?.startIdx === 1 && finite?.count === 3, JSON.stringify(finite));
};

// ---- worker 的诊断载荷：抽 fail 闭包真跑 ----
//
// fail 是 worker 里把「原始输入/输出 + 是否超限」打包成 error 消息的唯一出口。
// 它依赖 captureText 和两个上限常量，三样都从源码抽出来进同一个沙箱，
// 于是「上限是多少字节」「标记跟没跟着字段」都变成返回值，而不是源码字面量。

const workerBehaviour = async () => {
    const failSrc = arrowExpr(workerSource, /const fail\s*=\s*/);
    const captureSrc = funcDecl(workerSource, 'captureText');
    const capInSrc = scalarConst(workerSource, 'MAX_CAPTURED_INPUT_BYTES');
    const capOutSrc = scalarConst(workerSource, 'MAX_CAPTURED_OUTPUT_BYTES');
    check('worker 侧片段抽取成功（fail 闭包 / captureText / 两条上限常量）',
        failSrc.startsWith('(') && captureSrc.startsWith('function')
        && capInSrc.startsWith('const MAX_CAPTURED_INPUT_BYTES')
        && capOutSrc.startsWith('const MAX_CAPTURED_OUTPUT_BYTES'),
        JSON.stringify({ fail: failSrc.slice(0, 12), capture: captureSrc.slice(0, 12), capIn: capInSrc, capOut: capOutSrc }));

    const ctx = vm.createContext({ posts: [], Buffer, String, Number, Math, Array, Object, JSON });
    vm.runInContext([
        capInSrc, capOutSrc, captureSrc,
        'let lastGenMs = 11, lastStdMs = 22, lastTestMs = 33;',
        'const worker_threads_1 = { parentPort: { postMessage: (m) => posts.push(m) } };',
        'const fail = ' + failSrc,
        'this.__fail = fail;',
        'this.__caps = { input: MAX_CAPTURED_INPUT_BYTES, output: MAX_CAPTURED_OUTPUT_BYTES };'
    ].join('\n'), ctx, { filename: 'compare-worker-v6.js' });
    const caps = ctx.__caps;
    const fail = (...args) => { ctx.posts.length = 0; ctx.__fail(...args); return ctx.posts[0] || {}; };

    check('上限按字节计，且回传给渲染层的诊断数据不许退回 200/2000 那一档',
        caps.input >= 1024 * 1024 && caps.output >= 64 * 1024, JSON.stringify(caps));
    check('输入正好等于上限时不算截断（判定是 > 而不是 >=）',
        fail(1, 'std_re', 'std_exit', 'd', { rawInput: 'x'.repeat(caps.input) }).inputTruncated === false,
        JSON.stringify(caps));
    check('输入超上限 1 字节才截断，正文切到上限长度且标记为 true',
        (() => {
            const m = fail(1, 'std_re', 'std_exit', 'd', { rawInput: 'x'.repeat(caps.input + 1) });
            return m.inputTruncated === true && m.input.length === caps.input;
        })());
    check('2000 字节的输出原样保留、不截断（旧缺陷形态）',
        (() => {
            const m = fail(1, 'std_re', 'std_exit', 'd', { rawStd: 'z'.repeat(2000) });
            return m.stdOutput.length === 2000 && m.stdOutputTruncated === false;
        })());
    check('200000 字节的输出被截断，但必须带标记（宁可截断也不静默砍）',
        (() => {
            const m = fail(1, 'std_re', 'std_exit', 'd', { rawStd: 'z'.repeat(200000) });
            return m.stdOutput.length === caps.output && m.stdOutputTruncated === true;
        })());
    check('输出走自己那条上限：刚好 64 KiB 级别不截断',
        (() => {
            const m = fail(1, 'std_re', 'std_exit', 'd', { rawStd: 'y'.repeat(caps.output) });
            return m.stdOutputTruncated === false && m.stdOutput.length === caps.output;
        })());
    check('超上限的输出同样被截断并置标记（标记不是只有 input 那一侧会动）',
        (() => {
            const m = fail(1, 'std_re', 'std_exit', 'd',
                { rawStd: 'y'.repeat(caps.output + 1), rawTest: 't'.repeat(caps.output + 1) });
            return m.stdOutputTruncated === true && m.testOutputTruncated === true
                && m.stdOutput.length === caps.output && m.testOutput.length === caps.output;
        })());
    check('Buffer 输入同样按字节判定（不是拿 length 属性猜字符数）',
        fail(1, 'std_re', 'std_exit', 'd', { rawInput: Buffer.alloc(caps.input + 1, 0x61) }).inputTruncated === true);

    const gen = fail(7, 'generator', 'gen_exit', 'gen boom', { rawInput: 'IN', exitCode: 3 });
    check('kind/code/testIndex/exitCode 一起回传，message 只当技术细节',
        gen.kind === 'generator' && gen.code === 'gen_exit' && gen.testIndex === 7
        && gen.exitCode === 3 && gen.message === 'gen boom', JSON.stringify(gen));
    check('只给 rawInput 时 std/test 两侧都是 undefined（缺失 ≠ 空串，也 ≠ 未截断）',
        gen.stdOutput === undefined && gen.stdOutputTruncated === undefined
        && gen.testOutput === undefined && gen.testOutputTruncated === undefined,
        JSON.stringify(gen));
    check('三个截断标记各跟各的字段：三端都给就三端都是未截断的正文',
        (() => {
            const m = fail(1, 'test_re', 'test_exit', 'd', { rawInput: 'a', rawStd: 'b', rawTest: 'c' });
            return m.input === 'a' && m.stdOutput === 'b' && m.testOutput === 'c'
                && m.inputTruncated === false && m.stdOutputTruncated === false && m.testOutputTruncated === false;
        })(), JSON.stringify(fail(1, 'test_re', 'test_exit', 'd', { rawInput: 'a', rawStd: 'b', rawTest: 'c' })));
    check('detail 为 null 时 message 落成空串，不是字面量 "null"',
        fail(1, 'engine', 'engine', null).message === '');
    check('耗时字段按 includeStdMs/includeTestMs 才带，缺省是 undefined 而不是 0',
        (() => {
            const bare = fail(1, 'std_tle', 'std_timeout', 'd', {});
            const withMs = fail(1, 'std_tle', 'std_timeout', 'd', { includeStdMs: true, includeTestMs: true });
            return bare.stdMs === undefined && bare.testMs === undefined && bare.genMs === 11
                && withMs.stdMs === 22 && withMs.testMs === 33;
        })());

    // 生成器超时的归一化语句：唯一自由标识符是内建 Number，两侧语义一致，直接求值即可。
    // 抽取断言只确认锚点找到了那条 const —— 万一它抽到的是别的语句，
    // 下面 new Function('generatorTimeout', …) 会因 ReferenceError 当场红。
    const genTimeoutSrc = scalarConst(workerSource, 'genTimeout');
    check('worker 的生成器超时归一化语句抽取成功',
        genTimeoutSrc.startsWith('const genTimeout'), genTimeoutSrc);
    const normalizeGenTimeout = new Function('generatorTimeout', genTimeoutSrc + ' return genTimeout;');
    check('worker 侧 0 / 负数 / NaN 的生成器超时都归一成不限时（不再被 || 5000 兜底）',
        normalizeGenTimeout(0) === 0 && normalizeGenTimeout(-1) === 0
        && normalizeGenTimeout(NaN) === 0 && normalizeGenTimeout('x') === 0,
        [0, -1, NaN, 'x'].map(normalizeGenTimeout).join(','));
    check('worker 侧正数生成器超时原样生效', normalizeGenTimeout(1500) === 1500);
};

// ---- runTask 注册的四个引擎事件回调 + 下发配置 + 旧引擎的执行计数 ----
//
// 这四个回调是渲染层唯一接收引擎数据的地方。原先锁的是七处字面量：
// /inputTruncated: !!error\.inputTruncated/、/generatorTimeout: 0,/、
// /onCompareWarning\(\(data\) => \{\s*logWarn/、/if \(result\.stopped\) \{…mode = 'stopped'/、
// /compare\.compareStopped/、/compare\.progressGroup/、!/updateProgress\(completed, totalTests\)/。
// 它们都在闭包里，旁边改一行就整段失效而字面量毫发无伤：completed 取错字段、
// 告警被当错误打断对拍、message 没兜底写进 "undefined"、进度条拿计划数画 —— 全是静默的。
//
// 处理器是 runTask 作用域里的箭头函数，自由标识符 task / window / logWarn /
// cleanupAllListeners / this 都由沙箱提供。注意 this：箭头函数继承定义处的 this，
// 而 vm 顶层脚本的 this 就是沙箱对象本身，所以记录器必须挂在 ctx 上；
// 挂到 Proxy self 上的话处理器里的 this.updateProgress 一个都拦不到。
const HANDLER_SITES = [
    ['warning', /window\.electronAPI\.onCompareWarning\(/, false],
    ['progress', /window\.electronAPI\.onCompareProgress\(/, false],
    ['error', /window\.electronAPI\.onCompareError\(async\s/, true],
    ['complete', /window\.electronAPI\.onCompareComplete\(/, false]
];
const RECORD_METHODS = ['updateProgress', 'updateTaskStatus', 'updateTaskProgress',
    'renderIfActive', 'finishCompareTask', 'cleanupAllListeners', 'showError', 'showComplete'];

const handlerHarness = (realMethods) => {
    const h = comparerHarness(realMethods);
    // 回调里的 this.xxx 解析到 vm 全局，不是 Proxy self：真身挂全局，其余挂记录器。
    for (const name of realMethods) h.ctx[name] = h.real[name];
    for (const name of RECORD_METHODS) {
        if (realMethods.includes(name)) continue;
        h.ctx[name] = (...args) => h.calls.push({ name, args });
    }
    const handlers = {};
    for (const [name, pattern, isAsync] of HANDLER_SITES) {
        const src = arrowExpr(comparerSource, pattern);
        check(`引擎事件回调抽取成功: ${name}`, src.startsWith('('), src.slice(0, 24));
        vm.runInContext(`this.${name}Handler = ${isAsync ? 'async ' : ''}${src};`, h.ctx);
        handlers[name] = h.ctx[`${name}Handler`];
        check(`回调可调用: ${name}`, typeof handlers[name] === 'function');
    }
    return { ...h, handlers, task: (state) => { h.ctx.task = { state }; return h.ctx.task; } };
};

const handlerBehaviour = async () => {
    const h = handlerHarness(['getEngineErrorMessage']);

    // ---- 进度回调 ----
    const p = h.task({ totalTests: 50, completedTests: 0, currentTest: 0 });
    h.calls.length = 0;
    h.handlers.progress({ current: '3', total: 9, testIndex: 4 });
    check('进度回调把引擎报的组号归一成数字后写进任务状态',
        p.state.completedTests === 3 && p.state.currentTest === 3,
        JSON.stringify({ c: p.state.completedTests, n: p.state.currentTest }));
    check('进度条按引擎给的 total 画，不拿计划数 50 顶',
        JSON.stringify(argsOf(h.calls, 'updateProgress')) === '[[3,9]]',
        JSON.stringify(argsOf(h.calls, 'updateProgress')));
    check('状态文案走 compare.testGroup 并带上 testIndex',
        h.seen.t.some(([k, prm]) => k === 'compare.testGroup' && prm.i === 4),
        JSON.stringify(h.seen.t.map(([k]) => k)));
    h.seen.t.length = 0;
    h.handlers.progress({ current: 'abc', total: 9 });
    check('current 不是数字时收成 0，不把 NaN 写进状态（NaN 会一路带到百分比里）',
        p.state.completedTests === 0 && !Number.isNaN(p.state.completedTests),
        String(p.state.completedTests));
    check('进度回调不碰错误区与完成面板', !called(h.calls, 'showError') && !called(h.calls, 'showComplete'),
        JSON.stringify(h.calls.map((c) => c.name)));

    // ---- 错误回调 ----
    const e = h.task({ mode: 'running' });
    h.calls.length = 0;
    h.api.stopCompareCalls = 0;
    await h.handlers.error({
        testNumber: 7, input: 'IN', stdOutput: 'S', testOutput: 'T',
        inputTruncated: 1, stdOutputTruncated: 0, type: 'std_re', code: 'std_exit',
        exitCode: 2, message: 'boom'
    });
    const er = e.state.errorResult || {};
    check('三个截断标记各按布尔收窄（1→true、0→false、缺省→false，不许留 undefined）',
        er.inputTruncated === true && er.stdOutputTruncated === false && er.testOutputTruncated === false,
        JSON.stringify({ i: er.inputTruncated, s: er.stdOutputTruncated, t: er.testOutputTruncated }));
    check('引擎的 type 落成 errorType、code 落成 errorCode，正文译文由 getEngineErrorMessage 现算',
        er.errorType === 'std_re' && er.errorCode === 'std_exit'
        && er.errorMessage === 'compare.stdExit|{"code":2,"error":"boom"}',
        JSON.stringify({ t: er.errorType, c: er.errorCode, m: er.errorMessage }));
    check('原始技术细节单独留一份，不参与本地化', er.rawErrorMessage === 'boom', String(er.rawErrorMessage));
    check('错误回调把任务落成 error 态并重绘',
        e.state.mode === 'error' && called(h.calls, 'renderIfActive'),
        JSON.stringify(h.calls.map((c) => c.name)));
    check('出错即停：摘监听、调一次 stopCompare、收尾',
        called(h.calls, 'cleanupAllListeners') && h.api.stopCompareCalls === 1
        && called(h.calls, 'finishCompareTask'),
        JSON.stringify({ calls: h.calls.map((c) => c.name), stop: h.api.stopCompareCalls }));
    h.calls.length = 0;
    await h.handlers.error({ testNumber: 1 });
    const thin = h.ctx.task.state.errorResult;
    check('只有组号的错误：输出三段收成空串，code/message 也是空串',
        thin.input === '' && thin.stdOutput === '' && thin.testOutput === ''
        && thin.errorCode === '' && thin.rawErrorMessage === '',
        JSON.stringify(thin));
    check('缺 exitCode 时译文走无参分支（面板不会出现裸 {code}）',
        thin.errorMessage === 'compare.engineError', String(thin.errorMessage));

    // ---- 完成 / 停止回调 ----
    const c1 = h.task({ mode: 'stopping', completedTests: 1, failedTests: 0, totalTests: 5 });
    h.calls.length = 0;
    h.seen.t.length = 0;
    h.handlers.complete({ stopped: true, completed: 4, failed: 2 });
    check('停止收尾把 mode 落成 stopped，完成数取引擎给的 4',
        c1.state.mode === 'stopped' && c1.state.completedTests === 4,
        JSON.stringify({ m: c1.state.mode, c: c1.state.completedTests }));
    check('停止也置 stopped 标记（面板靠它区分「停止」与「跑完」）', c1.state.stopped === true);
    check('停止态的状态文案用 compare.compareStopped 并带上 completed/failed',
        h.seen.t.some(([k, prm]) => k === 'compare.compareStopped' && prm.completed === 4 && prm.failed === 2),
        JSON.stringify(h.seen.t.map(([k]) => k)));
    check('有生成失败时把失败组数一并告警',
        c1.state.warningMessage === 'compare.genFailedWarning|{"count":2}',
        String(c1.state.warningMessage));
    check('收尾同样摘监听 + 重绘 + finish',
        called(h.calls, 'cleanupAllListeners') && called(h.calls, 'renderIfActive')
        && called(h.calls, 'finishCompareTask'), JSON.stringify(h.calls.map((c) => c.name)));

    const c2 = h.task({ mode: 'running', completedTests: 3, totalTests: 9 });
    h.handlers.complete({ completed: NaN, failed: undefined });
    check('completed 不是数字时保留已累计的 3，不写 NaN',
        c2.state.completedTests === 3, String(c2.state.completedTests));
    check('failed 缺失按 0 计，此时不该有告警文案',
        c2.state.failedTests === 0 && c2.state.warningMessage === null,
        JSON.stringify({ f: c2.state.failedTests, w: c2.state.warningMessage }));
    check('正常跑完落 complete 态', c2.state.mode === 'complete', c2.state.mode);

    const c3 = h.task({ mode: 'error', completedTests: 2 });
    h.handlers.complete({ completed: 2, failed: 0 });
    check('已经落到 error 就不改写成 complete（差异面板不能被完成态覆盖）',
        c3.state.mode === 'error', c3.state.mode);

    // ---- 告警回调 ----
    const w = h.task({ mode: 'running' });
    h.calls.length = 0;
    h.seen.warns.length = 0;
    h.api.stopCompareCalls = 0;
    h.handlers.warning({ code: 'fastspawn_fallback', message: 'falling back' });
    check('引擎告警只记一条日志，带 code 与 message',
        h.seen.warns.length === 1 && h.seen.warns[0][1] === 'fastspawn_fallback'
        && h.seen.warns[0][2] === 'falling back', JSON.stringify(h.seen.warns));
    check('告警是非致命的：不改状态、不弹错误面板、不停引擎',
        w.state.mode === 'running' && !called(h.calls, 'showError') && h.api.stopCompareCalls === 0,
        JSON.stringify(h.calls.map((c) => c.name)));
    h.handlers.warning({});
    check('缺 code/message 的告警用占位串，不把 undefined 写进日志',
        h.seen.warns[1][1] === 'warning' && h.seen.warns[1][2] === '',
        JSON.stringify(h.seen.warns[1]));

    // ---- 下发给引擎的 config ----
    const configSrc = objectConst(comparerSource, 'config');
    check('下发配置的整条 const 抽取成功', configSrc.startsWith('const config = {'), configSrc.slice(0, 30));
    const buildConfig = new Function('compiledPrograms', 'task', 'effectiveTimeLimit', 'workerCount',
        `${configSrc}; return config;`);
    const taskForConfig = (state, config = {}) => ({ state, config });
    const cfg = buildConfig({ stdExe: 'a.exe', testExe: 'b.exe', generatorExe: 'g.exe', spjExe: null },
        taskForConfig({ totalTests: 9 }), 2000, 4);
    check('config 显式给 generatorTimeout = 0（时限由 worker 侧按 0=不限时处理）',
        cfg.generatorTimeout === 0, String(cfg.generatorTimeout));
    check('时限用折算后的 effectiveTimeLimit，组数与线程数各归各处',
        cfg.timeLimit === 2000 && cfg.totalTests === 9 && cfg.threadCount === 4,
        JSON.stringify({ t: cfg.timeLimit, n: cfg.totalTests, w: cfg.threadCount }));
    // 0 是「不限时」的合法取值，写成 `effectiveTimeLimit || 5000` 会把它悄悄换成 5 秒。
    check('时限为 0（不限时）时原样下发，不落到 5000 兜底',
        buildConfig({}, taskForConfig({ totalTests: 1 }), 0, 1).timeLimit === 0,
        String(buildConfig({}, taskForConfig({ totalTests: 1 }), 0, 1).timeLimit));
    check('生成器优先用 runTarget（Windows 需要 .cmd 包装）',
        buildConfig({ generatorRunTarget: 'g.cmd', generatorExe: 'g.exe' }, taskForConfig({ totalTests: 1 }), 0, 1).generator
        === 'g.cmd');
    check('freopen 两个路径缺省落成 null，不是 undefined',
        cfg.freopen.inputFile === null && cfg.freopen.outputFile === null,
        JSON.stringify(cfg.freopen));
    check('SPJ / freopen 的配置原样透传给引擎（回退判定在调用方，这里不许吞）',
        buildConfig({}, taskForConfig({ totalTests: 1 },
            { useTestlib: true, freopenInputFile: 'in.txt', freopenOutputFile: 'out.txt' }), 0, 1).useTestlib === true
        && buildConfig({}, taskForConfig({ totalTests: 1 }, { freopenInputFile: 'in.txt' }), 0, 1).freopen.inputFile
        === 'in.txt');

    // ---- 旧引擎的执行计数 ----
    const mh = comparerHarness([]);
    const markSrc = arrowExpr(comparerSource, /const markExecuted = /);
    check('旧引擎 markExecuted 抽取成功', markSrc.startsWith('() =>'), markSrc.slice(0, 20));
    vm.runInContext(`let executed = 0; this.markExecuted = ${markSrc}; this.executedOf = () => executed;`, mh.ctx);
    mh.ctx.task = { state: { completedTests: 0, currentTest: 0 } };
    const mt = mh.ctx.task;
    mh.ctx.markExecuted();
    mh.ctx.markExecuted();
    mh.ctx.markExecuted();
    check('每执行一组 +1，并同步写回任务的 completedTests / currentTest',
        mt.state.completedTests === 3 && mt.state.currentTest === 3 && mh.ctx.executedOf() === 3,
        JSON.stringify({ inTask: mt.state.completedTests, inner: mh.ctx.executedOf() }));
    mh.ctx.markExecuted();
    check('计数继续累加，不会在某一轮后被计划数接管',
        mt.state.completedTests === 4 && mh.ctx.executedOf() === 4, String(mt.state.completedTests));

    // 旧引擎收尾：所有 worker 退出后再把真实执行数写一遍并刷进度。
    // 这段和 markExecuted 是同一份不变量的重复写入，写成计划数就会「停止后进度条满格」。
    // 三行按 currentTest → completedTests → updateTaskProgress 的顺序整体匹配（markExecuted
    // 里前两句顺序相反），只锁顺序不锁空白与缩进。
    const tailSrc = /task\.state\.currentTest = executed;\s*task\.state\.completedTests = executed;\s*this\.updateTaskProgress\(task\);/
        .exec(comparerSource)?.[0] || '';
    check('旧引擎收尾的三行写入抽取成功', tailSrc.includes('completedTests = executed'), JSON.stringify(tailSrc.slice(0, 40)));
    const th = comparerHarness([]);
    th.ctx.updateTaskProgress = (...args) => th.calls.push({ name: 'updateTaskProgress', args });
    th.ctx.task = { state: { totalTests: 50, completedTests: 0, currentTest: 0 } };
    vm.runInContext(`const executed = 7; this.finishTail = () => { ${tailSrc} };`, th.ctx);
    th.ctx.finishTail();
    check('收尾写入的是真实执行数，不是计划数',
        th.ctx.task.state.completedTests === 7 && th.ctx.task.state.currentTest === 7,
        JSON.stringify({ done: th.ctx.task.state.completedTests, cur: th.ctx.task.state.currentTest }));
    check('收尾顺手刷一次进度面板', called(th.calls, 'updateTaskProgress'),
        JSON.stringify(th.calls.map((c) => c.name)));

    // 成功组数：只绑 executed / failedGenerations 两个自由标识符，
    // 一旦改回「计划数 - 失败数」，new Function 里找不到 task 会当场 ReferenceError。
    const succSrc = scalarConst(comparerSource, 'successfulTests');
    check('成功组数的计算语句抽取成功', succSrc.startsWith('const successfulTests'), succSrc);
    const successfulOf = new Function('executed', 'failedGenerations', `${succSrc} return successfulTests;`);
    check('成功数按真实执行数减生成失败数，不拿计划数起算',
        successfulOf(9, 2) === 7 && successfulOf(9, 0) === 9 && successfulOf(4, 4) === 0,
        [successfulOf(9, 2), successfulOf(9, 0), successfulOf(4, 4)].join(','));
};

// ---- 导出真跑一遍：截断标记必须逐字段跟着数据走 ----
//
// exportResults 是 async，放在文件末尾的异步段里跑（前面的同步断言已经把 failures 累加好了）。
// 原先只有一条「withNotice(errorResult.xxx, errorResult.xxxTruncated) 这行字还在」的文本断言：
// 把两个 flag 对调、或者让 null 输出写成 'null'、取消选择时照样落盘，全都照样绿。

(async () => {
    await engineBehaviour();
    await workerBehaviour();
    await handlerBehaviour();
    const NOTICE = '⟪导出数据不完整⟫';
    const realWindow = global.window;
    const realLogError = global.logError;
    const realLogInfo = global.logInfo;
    const t = (key, params) => {
        if (key === 'compare.exportTruncatedNotice') return NOTICE;
        return params ? `${key}=${JSON.stringify(params)}` : key;
    };
    const scenario = async (errorResult, opts = {}) => {
        const writes = [];
        const calls = { ensured: [], dialog: 0 };
        const errors = [];
        const successes = [];
        global.logError = () => {};
        global.logInfo = () => {};
        global.window = {
            i18n: { t },
            electronAPI: {
                showOpenDialog: async () => {
                    calls.dialog++;
                    if (opts.dialogThrows) throw new Error('dialog boom');
                    // 取消时也带上 filePaths：这样「是否落盘」只由 canceled 决定，
                    // 而不是被空数组顺带掩盖掉漏判 canceled 的写法
                    return opts.canceled
                        ? { canceled: true, filePaths: ['/tmp/exports'] }
                        : { canceled: false, filePaths: ['/tmp/exports'] };
                },
                ensureDir: async (dir) => { calls.ensured.push(dir); },
                pathJoin: async (dir, name) => `${dir}/${name}`,
                createFile: async (path, content) => {
                    if (opts.writeThrows) throw new Error('disk full');
                    writes.push({ path, content });
                }
            }
        };
        const self = {
            getActiveTask: () => ({ state: { errorResult } }),
            showTaskCompileError: (task, kind, message) => { errors.push({ kind, message }); },
            showSuccessMessage: (message) => { successes.push(message); }
        };
        await cmp.exportResults.call(self);
        // 找不到文件时返回占位而不是 undefined：断言应干净地红，不该把整段异步检查炸掉
        const byName = (name) => writes.find((w) => w.path.endsWith(name))
            || { path: `<未写出:${name}>`, content: `<未写出:${name}>` };
        return { writes, calls, errors, successes, byName };
    };
    try {
        const full = { input: 'IN', stdOutput: 'STD', testOutput: 'OUT' };
        const allTruncated = await scenario({
            ...full, inputTruncated: true, stdOutputTruncated: true, testOutputTruncated: true
        });
        check('三个文件都导出且文件名不变', allTruncated.writes.map((w) => w.path).join(',') ===
            '/tmp/exports/input.in,/tmp/exports/std_or_force_output.out,/tmp/exports/code_output.out',
            allTruncated.writes.map((w) => w.path).join(','));
        check('三份都被标注了截断，且标注在后面而不是替换掉正文',
            allTruncated.writes.length === 3 && allTruncated.writes.every((w) => w.content.endsWith(NOTICE)),
            JSON.stringify(allTruncated.writes.map((w) => w.content)));
        check('标注不吞内容：正文原样在标注之前',
            allTruncated.writes.map((w) => w.content.slice(0, w.content.length - NOTICE.length)).join('|') === 'IN|STD|OUT');
        check('全部导出成功时提示一次导出目录',
            allTruncated.successes.length === 1 && allTruncated.successes[0].includes('/tmp/exports'),
            JSON.stringify(allTruncated.successes));

        const mixed = await scenario({
            ...full, stdOutputTruncated: true
        });
        check('只有被截断的那个字段带标注（flag 与字段一一对应）',
            mixed.byName('std_or_force_output.out').content === 'STD' + NOTICE
            && mixed.byName('input.in').content === 'IN'
            && mixed.byName('code_output.out').content === 'OUT',
            JSON.stringify(mixed.writes.map((w) => w.content)));

        const clean = await scenario({ ...full });
        check('没有任何截断时导出内容与原文逐字相同',
            clean.writes.every((w) => !w.content.includes(NOTICE)) &&
            clean.writes.map((w) => w.content).join('|') === 'IN|STD|OUT');

        const missing = await scenario({ input: null, stdOutput: undefined, testOutput: 'OUT' });
        check('缺失的输出导出空串，而不是字面量 null / undefined',
            missing.byName('input.in').content === ''
            && missing.byName('std_or_force_output.out').content === ''
            && missing.byName('code_output.out').content === 'OUT',
            JSON.stringify(missing.writes.map((w) => w.content)));
        check('输出缺失本身不算截断，不能顺手加上截断标注',
            !missing.byName('input.in').content.includes(NOTICE));

        const cancelled = await scenario({ ...full, inputTruncated: true }, { canceled: true });
        check('用户取消选择目录时不落任何文件、也不报成功',
            cancelled.writes.length === 0 && cancelled.calls.ensured.length === 0
            && cancelled.successes.length === 0 && cancelled.errors.length === 0,
            JSON.stringify({ w: cancelled.writes.length, s: cancelled.successes.length, e: cancelled.errors.length }));

        const none = await scenario(undefined);
        check('没有可导出的结果时不打开目录选择框',
            none.calls.dialog === 0 && none.writes.length === 0);
        check('没有可导出的结果时给出可见提示',
            none.errors.length === 1 && none.errors[0].message.startsWith('compare.noExportResults'),
            JSON.stringify(none.errors));

        const writeFailed = await scenario({ ...full }, { writeThrows: true });
        check('写盘失败时报错而不是谎报导出成功',
            writeFailed.errors.length === 1 && writeFailed.errors[0].message.includes('disk full')
            && writeFailed.successes.length === 0,
            JSON.stringify({ e: writeFailed.errors, s: writeFailed.successes }));

        const dialogFailed = await scenario({ ...full }, { dialogThrows: true });
        check('选择目录本身失败也不冒成功提示',
            dialogFailed.successes.length === 0 && dialogFailed.writes.length === 0
            && dialogFailed.errors.length === 1);
    }
    finally {
        global.window = realWindow;
        global.logError = realLogError;
        global.logInfo = realLogInfo;
    }
    process.exit(failures > 0 ? 1 : 0);
})().catch((error) => {
    console.error('[ERROR] 导出行为段异常:', error);
    process.exit(1);
});