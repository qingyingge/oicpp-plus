'use strict';

// 对拍器「显示的完成数 / 进度 / 停止 / 导出数据」必须反映真实执行情况，
// 不能拿计划数充数，也不能静默导出被截断的数据。

const fs = require('fs');
const path = require('path');
const { classMethod, toFn } = require('./fixtures/source-extract');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const comparerSource = read('src', 'renderer', 'js', 'sidebar', 'codeComparer.js');
const engineSource = read('src', 'main-process', 'compare-engine-v2.js');
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

// ---- 完成数必须是真实执行数，不是计划数 ----

check('task state tracks a real completedTests counter', /completedTests:\s*0/.test(comparerSource));
check('completion panel is fed the executed count, not totalTests',
    /showComplete\(this\.getCompletedCount\(task\)/.test(comparerSource)
    && !/showComplete\(task\.state\.totalTests/.test(comparerSource));
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
check('legacy engine records executed groups including generation failures',
    /const markExecuted = \(\) => \{[\s\S]*?executed\+\+;[\s\S]*?task\.state\.completedTests = executed;/.test(comparerSource));
check('legacy engine completion summary uses executed count',
    /const successfulTests = executed - failedGenerations;/.test(comparerSource)
    && !/successfulTests = task\.state\.totalTests - failedGenerations/.test(comparerSource));
check('engine complete event no longer carries an English warning string',
    !/tests failed/.test(engineSource));
check('engine complete event reports completed and failed counts',
    /emit\('complete', \{\s*total: this\._total, completed: this\._completed, failed: this\._errors/.test(engineSource));
check('engine stopped event also reports total/completed/failed',
    /emit\('stopped', \{ total: this\._total, completed: this\._completed, failed: this\._errors \}\)/.test(engineSource));

// ---- 手动停止后仍要能看到完成数 ----

check('stopComparison keeps a stopping mode instead of dropping to idle',
    /task\.state\.mode = 'stopping';/.test(comparerSource)
    && !/if \(task\.state\.mode === 'running'\) \{\s*task\.state\.mode = 'idle';\s*\}/.test(comparerSource));
check('renderTask handles the stopping mode as a visible running state',
    /mode === 'running' \|\| task\.state\.mode === 'stopping'/.test(comparerSource));
check('renderTask renders the stopped mode through the completion panel',
    /mode === 'complete' \|\| task\.state\.mode === 'stopped'/.test(comparerSource));
check('stopped completion event is consumed and persisted',
    /if \(result\.stopped\) \{[\s\S]*?task\.state\.mode = 'stopped';/.test(comparerSource));
check('the previously orphaned compareStopped key is now referenced',
    /compare\.compareStopped/.test(comparerSource));

// ---- 进度标签与状态文案语义分离 ----

check('progress label reports completed/total instead of a current group number',
    /compare\.progressGroup/.test(comparerSource)
    && zh.compare.progressGroup.includes('{current}')
    && zh.compare.progressGroup.includes('{total}'));
check('progress label is not fed the current running group index',
    !/updateProgress\(completed, totalTests\)/.test(comparerSource));
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
check('progress label element carries no hardcoded English literal',
    !/<span id="current-test">Test 0<\/span>/.test(htmlSource));

// ---- 编译/引擎级错误不显示「第 0 组」 ----

check('error group label is hidden when there is no real test index',
    /Number\(errorResult\.testNumber\) > 0\s*\?\s*window\.i18n\.t\('compare\.errorGroup'/.test(comparerSource)
    && /:\s*'';\s*\}/.test(comparerSource));

// ---- 导出/差异数据不得被静默截断 ----

check('worker captures input well beyond the old 2000 byte cap',
    /MAX_CAPTURED_INPUT_BYTES = 1024 \* 1024/.test(workerSource));
check('worker captures program output well beyond the old 200 byte cap',
    /MAX_CAPTURED_OUTPUT_BYTES = 64 \* 1024/.test(workerSource));
check('worker reports explicit truncation flags instead of silent clipping',
    /inputTruncated: input\.truncated/.test(workerSource)
    && /stdOutputTruncated: std \? std\.truncated/.test(workerSource)
    && /testOutputTruncated: test \? test\.truncated/.test(workerSource));
check('no residual 200/2000 byte toString clipping in the worker',
    !/toString\('utf8', 0, 200\)/.test(workerSource) && !/toString\('utf8', 0, 2000\)/.test(workerSource));
check('engine forwards truncation flags to the renderer',
    /inputTruncated: !!msg\.inputTruncated/.test(engineSource)
    && /stdOutputTruncated: !!msg\.stdOutputTruncated/.test(engineSource)
    && /testOutputTruncated: !!msg\.testOutputTruncated/.test(engineSource));
check('renderer persists truncation flags on the error result',
    /inputTruncated: !!error\.inputTruncated/.test(comparerSource)
    && /stdOutputTruncated: !!error\.stdOutputTruncated/.test(comparerSource));
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
check('difference position is not reported for truncated output',
    (comparerSource.match(/compare\.diffPositionUnreliable/g) || []).length >= 2
    && /const truncated = !!\(errorResult\.stdOutputTruncated \|\| errorResult\.testOutputTruncated\)[\s\S]{0,40}?const diffPosition = truncated \? null/.test(comparerSource));

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
check('output_limit gets its own localized title',
    /errType === 'output_limit'\)[\s\S]{0,120}?compare\.errorOutputLimit/.test(comparerSource));

// ---- 0 = 不限时的语义在两条引擎路径上一致 ----

check('engine no longer coerces a zero time limit into 5000ms',
    !/config\.timeLimit \|\| 5000/.test(engineSource) && !/config\.generatorTimeout \|\| 5000/.test(engineSource));
check('engine normalizes non-positive limits to 0 (unlimited)',
    /Number\.isFinite\(config\.timeLimit\) && config\.timeLimit > 0\) \? config\.timeLimit : 0/.test(engineSource)
    && /Number\.isFinite\(config\.generatorTimeout\) && config\.generatorTimeout > 0\) \? config\.generatorTimeout : 0/.test(engineSource));
check('worker honors a zero generator timeout as unlimited',
    /Number\.isFinite\(generatorTimeout\) && generatorTimeout > 0\) \? generatorTimeout : 0/.test(workerSource)
    && !/generatorTimeout \|\| 5000/.test(workerSource));
check('renderer explicitly sends generatorTimeout for the new engine',
    /generatorTimeout: 0,/.test(comparerSource));

// ---- 英文错误信息不得直接进 UI ----

check('worker emits a stable code alongside the human message',
    /code,/.test(workerSource) && /kind,/.test(workerSource));
check('renderer maps engine codes to localized strings',
    /getEngineErrorMessage\(error\)/.test(comparerSource) && /compare\.fastspawnFallback/.test(comparerSource));
check('raw technical detail is appended after the localized message, not instead of it',
    /buildEngineErrorText\(errorResult\)/.test(comparerSource));
check('every engine code maps to an existing key in both locales',
    ['compare.genTle', 'compare.genExit', 'compare.stdTle', 'compare.stdExit', 'compare.stdRe',
        'compare.testTle', 'compare.testExit', 'compare.testRe', 'compare.errorOutputLimitDetail',
        'compare.foundDiff', 'compare.engineError', 'compare.fastspawnFallback']
        .every((k) => {
            const [ns, key] = k.split('.');
            return zh[ns]?.[key] !== undefined && en[ns]?.[key] !== undefined;
        }));

// ---- 输入框 clamp 必须回写 ----

check('compare count clamp is written back to the input',
    /cappedCount !== compareCount\)\s*compareCountEl\.value = String\(cappedCount\)/.test(comparerSource));
check('start-time compare count clamp is also written back',
    /compareCountEl && Number\(compareCountEl\.value\) !== compareCount/.test(comparerSource));
check('compare count cap is a named constant shared by both clamps',
    (comparerSource.match(/MAX_COMPARE_COUNT/g) || []).length >= 3);

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
check('truncation text access is i18n-ready guarded',
    /window\.i18n\?\.t\?\.\('compare\.outputTruncated'\)/.test(comparerSource));

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
check('no leftover MB-only size helper', !/getOutputSizeMbText/.test(comparerSource));

// ---- 进度条残留 ----

check('resetComparison clears the progress bar width',
    /progressFill\.style\.width = '0%'/.test(comparerSource));

// ---- 完成面板不得被当成任意提示位 ----

check('export success no longer overwrites the completion panel with a message',
    /showSuccessMessage\(message\) \{\s*logInfo\(String\(message \|\| ''\)\);/.test(comparerSource));

// ---- 新增告警通道 ----

check('main process forwards non-fatal engine warnings',
    /engine\.on\('warning'[\s\S]*?compare-warning/.test(mainSource));
check('preload exposes the warning channel',
    /onCompareWarning/.test(preloadSource) && /compare-warning/.test(preloadSource));
check('renderer treats engine warnings as non-fatal',
    /onCompareWarning\(\(data\) => \{\s*logWarn/.test(comparerSource));

// ---- 导出真跑一遍：截断标记必须逐字段跟着数据走 ----
//
// exportResults 是 async，放在文件末尾的异步段里跑（前面的同步断言已经把 failures 累加好了）。
// 原先只有一条「withNotice(errorResult.xxx, errorResult.xxxTruncated) 这行字还在」的文本断言：
// 把两个 flag 对调、或者让 null 输出写成 'null'、取消选择时照样落盘，全都照样绿。

(async () => {
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