'use strict';

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const monacoSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'js', 'monaco-editor-manager.js'), 'utf8');
const tabsSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'js', 'tabs.js'), 'utf8');

// ---------------------------------------------------------------------------
// _normalizeLspUri: 统一解码，而不是只认 %3A
// ---------------------------------------------------------------------------

const normStart = monacoSrc.indexOf('    _normalizeLspUri(uri) {');
const normEnd = monacoSrc.indexOf('\n    }', normStart);
if (normStart < 0 || normEnd < 0) throw new Error('_normalizeLspUri not found');
const normalizeSrc = monacoSrc.slice(normStart, normEnd);

const norm = new Function('uri', normalizeSrc.slice(normalizeSrc.indexOf('{') + 1));

check('%2B 被解码（clangd 按 RFC 编码 + 号）',
    norm('file:///D:/MX/U1904%2B%2B.cpp') === 'file:///D:/MX/U1904++.cpp',
    norm('file:///D:/MX/U1904%2B%2B.cpp'));
check('%3A 盘符冒号解码后补回 URI 形态',
    norm('file:///D%3A/Users/a.cpp') === 'file:///D:/Users/a.cpp',
    norm('file:///D%3A/Users/a.cpp'));
check('%20 空格解码',
    norm('file:///D:/my%20dir/a.cpp') === 'file:///D:/my dir/a.cpp');
check('无百分号时原样返回',
    norm('file:///D:/plain/a.cpp') === 'file:///D:/plain/a.cpp');
check('非法百分号序列不抛异常',
    norm('file:///D:/100%/a.cpp') === 'file:///D:/100%/a.cpp',
    norm('file:///D:/100%/a.cpp'));
check('非字符串输入不抛异常', norm(null) === null);

// ---------------------------------------------------------------------------
// 诊断匹配失败不再直接丢弃：走延迟重试
//
// 这一段原先是 4 条正则读 monaco-editor-manager.js 的源码，断言「代码长什么样」：
// 形参名与默认值（attempt = 1）、数组字面量（[200, 500]）、
// 以及 `{\s*\n\s*this.applyLspDiagnostics(` 这种换行位置。
// .ts 迁移后 tsc printer 会重排源码（单行 if 拆行、空行删除），
// 这类正则既会误报也会因形态变化而漏报。改成把两个方法抽出来真跑：
// 挂一个假时钟观察实际排的延迟，model 出现后再放行回调，看诊断到底落没落。
// ---------------------------------------------------------------------------

// 抽方法体：行首四空格 + 方法名 + 参数列表，再括号/花括号配平。
// 必须连签名一起截，剥了只剩方法体会被 new Function 当形参列表。
function methodBody(name) {
    const m = new RegExp(`^\\s{4}${name}\\s*\\(`, 'm').exec(monacoSrc);
    if (!m) return '';
    let i = monacoSrc.indexOf('(', m.index), p = 0;
    for (; i < monacoSrc.length; i++) {
        if (monacoSrc[i] === '(') p++;
        else if (monacoSrc[i] === ')') { p--; if (p === 0) break; }
    }
    let d = 0;
    for (i = monacoSrc.indexOf('{', i); i < monacoSrc.length; i++) {
        if (monacoSrc[i] === '{') d++;
        else if (monacoSrc[i] === '}') { d--; if (d === 0) return monacoSrc.slice(m.index, i + 1); }
    }
    return '';
}

const RETRY_METHODS = ['applyLspDiagnostics', '_scheduleLspDiagnosticsRetry'];
for (const name of RETRY_METHODS) {
    // 抽取失败必须当场红：空方法体会让后面所有断言变成真空通过
    check(`方法体抽取成功: ${name}`, methodBody(name).length > 0);
}

global.monaco = {
    editor: { setModelMarkers: () => {} },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 }
};
global.logInfo = () => {};
global.logWarn = () => {};

const URI_A = 'file:///D:/a.cpp';
const URI_B = 'file:///D:/b.cpp';
const diag = (message) => ({ severity: 8, message });

// 假时钟：new Function 的作用链终止于全局，所以方法里的 setTimeout
// 解析到的就是这里替换掉的全局实现。
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;

function makeHarness() {
    const h = {
        models: new Map(),
        scheduled: [],   // { id, delay, fn, cleared }
        writes: [],
        warns: [],
        nextId: 1
    };
    const manager = {
        _syntaxCheckEnabled: true,
        lspMarkerOwner: 'oicpp-lsp',
        _lspDiagnosticsByModel: new Map(),
        _lspDiagnosticRetryTimers: undefined,
        lspDiagnosticToMonacoMarker: (d) => ({ severity: d.severity, message: d.message }),
        lspDiagnosticMarkerKey: (d) => d.message,
        findModelByLspUri: (uri) => h.models.get(uri) || null
    };
    for (const name of RETRY_METHODS) {
        manager[name] = new Function('return (function ' + methodBody(name) + ')')();
    }
    global.monaco.editor.setModelMarkers = (model, owner, markers) => h.writes.push({ model, owner, markers });
    global.logWarn = (...args) => h.warns.push(args.join(' '));
    global.setTimeout = (fn, delay) => {
        const item = { id: h.nextId++, delay, fn, cleared: false };
        h.scheduled.push(item);
        return item.id;
    };
    global.clearTimeout = (id) => {
        const item = h.scheduled.find((s) => s.id === id);
        if (item) item.cleared = true;
    };
    h.manager = manager;
    // 跑掉当前所有未执行的回调（模拟时间推进一轮）
    h.tick = () => {
        const due = h.scheduled.filter((s) => !s.cleared && !s.fired);
        due.forEach((s) => { s.fired = true; s.fn(); });
        return due.length;
    };
    h.liveChains = () => (manager._lspDiagnosticRetryTimers
        ? [...manager._lspDiagnosticRetryTimers.keys()]
        : []);
    return h;
}

{
    // 回归本体：model 未就绪时不能把这次诊断直接丢掉
    const h = makeHarness();
    h.manager.applyLspDiagnostics(URI_A, [diag('boom')]);
    check('未命中模型时挂起重试而非直接丢弃', h.scheduled.length === 1,
        `实际排了 ${h.scheduled.length} 个 timer`);
    check('首次重试延迟 200ms', h.scheduled[0]?.delay === 200,
        `实际 ${h.scheduled[0]?.delay}`);
}

{
    // 分级延迟与耗尽：[200, 500] 之后必须停，不能无限挂链
    const h = makeHarness();
    h.manager.applyLspDiagnostics(URI_A, [diag('boom')]);
    h.tick();
    check('第二轮重试延迟 500ms', h.scheduled[1]?.delay === 500,
        `实际 ${h.scheduled[1]?.delay}`);
    h.tick();
    check('重试耗尽后不再排新 timer', h.scheduled.length === 2,
        `实际 ${h.scheduled.length} 个`);
    check('重试耗尽后留一条可诊断的日志',
        /无法找到诊断对应的模型/.test(h.warns.join(' ')), h.warns.join(' | '));
    check('重试耗尽后从 map 摘掉，不留残链', !h.liveChains().includes(URI_A),
        `残留 ${h.liveChains().join(',')}`);
}

{
    // 只探测不应用是上一版的失败形态：命中后必须真写一次 marker
    const h = makeHarness();
    h.manager.applyLspDiagnostics(URI_A, [diag('boom')]);
    h.models.set(URI_A, { id: 'model-after-rebuild' });
    h.tick();
    check('重试命中后真正落一次诊断', h.writes.length === 1,
        `写入 ${h.writes.length} 次`);
    check('落下的 marker 内容与原诊断一致',
        h.writes[0]?.markers.length === 1 && h.writes[0]?.markers[0]?.message === 'boom',
        JSON.stringify(h.writes[0]?.markers));
    check('命中后不再继续排重试', h.scheduled.length === 1,
        `实际 ${h.scheduled.length} 个`);
}

{
    // 连续保存不能叠出多条重试链，且后到的诊断要覆盖先到的
    const h = makeHarness();
    h.manager.applyLspDiagnostics(URI_A, [diag('first')]);
    const firstId = h.scheduled[0].id;
    h.manager.applyLspDiagnostics(URI_A, [diag('second')]);
    check('同 uri 第二次调度会清掉前一条 timer', h.scheduled[0].cleared === true,
        `first id=${firstId}`);
    check('同一 uri 只保留一条重试链', h.liveChains().length === 1,
        `实际 ${h.liveChains().length} 条`);
    h.models.set(URI_A, {});
    h.tick();
    check('重试用的是最新到达的诊断', h.writes.length === 1 &&
        h.writes[0].markers.length === 1 && h.writes[0].markers[0].message === 'second',
        JSON.stringify(h.writes.map((w) => w.markers)));
}

{
    // 去重只能按 uri 分：不同文件必须各走各的链
    const h = makeHarness();
    h.manager.applyLspDiagnostics(URI_A, [diag('a')]);
    h.manager.applyLspDiagnostics(URI_B, [diag('b')]);
    check('不同 uri 各自保留一条重试链', h.liveChains().length === 2,
        h.liveChains().join(','));
    h.models.set(URI_B, { id: 'only-b' });
    h.tick();
    check('只有到齐的 uri 落诊断，另一个继续等', h.writes.length === 1 &&
        h.writes[0].model.id === 'only-b', JSON.stringify(h.writes.map((w) => w.model)));
    check('未命中 uri 的链没被牵连', h.scheduled.length === 3,
        `实际 ${h.scheduled.length} 个 timer`);
}

{
    // 边界：不该排重试的输入不能排，否则重试表会无限膨胀
    const off = makeHarness();
    off.manager._syntaxCheckEnabled = false;
    off.manager.applyLspDiagnostics(URI_A, [diag('boom')]);
    check('语法检查关闭时不排重试', off.scheduled.length === 0, `${off.scheduled.length} 个`);

    const bad = makeHarness();
    bad.manager.applyLspDiagnostics(null, [diag('boom')]);
    bad.manager.applyLspDiagnostics('', [diag('boom')]);
    bad.manager.applyLspDiagnostics(123, [diag('boom')]);
    check('uri 非法时不排重试', bad.scheduled.length === 0, `${bad.scheduled.length} 个`);

    // 记录实际契约（不是设想）：入口只校验 uri，payload 为 null 时
    // 默认参数 diagnostics = [] 不会生效（默认值只对 undefined 生效），
    // 于是仍会为该 uri 挂起重试链，命中后落成空 marker 集。
    // 这与「不丢弃」策略一致，只是多跑一轮 timer；要改得动源码，不在本次范围。
    const nullish = makeHarness();
    nullish.manager.applyLspDiagnostics(URI_A, null);
    check('payload 为 null 时仍按 uri 挂起重试（实际契约，仅校验 uri）',
        nullish.scheduled.length === 1, `${nullish.scheduled.length} 个`);
    nullish.models.set(URI_A, {});
    nullish.tick();
    check('null payload 命中后落成空 marker 集，不会抛',
        nullish.writes.length === 1 && nullish.writes[0].markers.length === 0,
        JSON.stringify(nullish.writes.map((w) => w.markers)));
}

global.setTimeout = realSetTimeout;
global.clearTimeout = realClearTimeout;

// ---------------------------------------------------------------------------
// saveAllFiles: 按 filePath 去重，且标记覆盖同文件的所有 uniqueKey
// ---------------------------------------------------------------------------

const saveAllStart = tabsSrc.indexOf('    async saveAllFiles() {');
const saveAllEnd = tabsSrc.indexOf('\n    openFileDialog()', saveAllStart);
if (saveAllStart < 0 || saveAllEnd < 0) throw new Error('saveAllFiles not found');
const saveAllSrc = tabsSrc.slice(saveAllStart, saveAllEnd);

check('saveAllFiles 按 filePath 归并，不再按 uniqueKey 逐个直接保存',
    /byFilePath = new Map\(\)/.test(saveAllSrc) &&
    /for \(const \[filePath, \{ content, uniqueKeys \}\] of byFilePath\.entries\(\)\)/.test(saveAllSrc) &&
    // 旧的 bug 形态：tasks.push 在遍历 tabs 的循环体内按 filePath 逐个发起
    !/for \(const \[uniqueKey, tab\] of this\.tabs\.entries\(\)\)[\s\S]{0,900}?tasks\.push\(/.test(saveAllSrc));

check('每个 filePath 只发起一次 saveFile',
    (saveAllSrc.match(/window\.electronAPI\.saveFile\(/g) || []).length === 1);

check('去重时保留同文件的全部 uniqueKey',
    /uniqueKeys\.push\(uniqueKey\)/.test(saveAllSrc));

check('保存成功后标记覆盖全部关联 uniqueKey',
    /uniqueKeys\.forEach\(\(key\) => this\.markTabAsSavedByUniqueKey\(key\)\)/.test(saveAllSrc));

check('无 electronAPI.saveFile 时也标记全部 uniqueKey',
    (saveAllSrc.match(/uniqueKeys\.forEach\(\(key\) => this\.markTabAsSavedByUniqueKey\(key\)\)/g) || []).length === 2);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);