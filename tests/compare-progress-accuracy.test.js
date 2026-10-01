'use strict';

// 对拍器「显示的完成数 / 进度 / 停止 / 导出数据」必须反映真实执行情况，
// 不能拿计划数充数，也不能静默导出被截断的数据。

const fs = require('fs');
const path = require('path');

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

// ---- 完成数必须是真实执行数，不是计划数 ----

check('task state tracks a real completedTests counter', /completedTests:\s*0/.test(comparerSource));
check('completion panel is fed the executed count, not totalTests',
    /showComplete\(this\.getCompletedCount\(task\)/.test(comparerSource)
    && !/showComplete\(task\.state\.totalTests/.test(comparerSource));
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
check('progress bar width is clamped to 0..100',
    /Math\.max\(0, Math\.min\(100, \(completedTests \/ totalTests\) \* 100\)\)/.test(comparerSource));
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
check('exported files are annotated when the data was truncated',
    /compare\.exportTruncatedNotice/.test(comparerSource)
    && /withNotice\(errorResult\.input, errorResult\.inputTruncated\)/.test(comparerSource)
    && /withNotice\(errorResult\.stdOutput, errorResult\.stdOutputTruncated\)/.test(comparerSource)
    && /withNotice\(errorResult\.testOutput, errorResult\.testOutputTruncated\)/.test(comparerSource));
check('difference position is not reported for truncated output',
    (comparerSource.match(/compare\.diffPositionUnreliable/g) || []).length >= 2
    && /const truncated = !!\(errorResult\.stdOutputTruncated \|\| errorResult\.testOutputTruncated\);\s*\n\s*const diffPosition = truncated \? null/.test(comparerSource));

// ---- output_limit 不得被当成 WA 渲染 ----

check('output_limit is treated as an engine error, not a diff',
    /isEngineErrorType\(errType\) \{[\s\S]*?'output_limit'/.test(comparerSource));
check('output_limit gets its own localized title',
    /errType === 'output_limit'\) \{\s*errorTitle\.textContent = window\.i18n\.t\('compare\.errorOutputLimit'\)/.test(comparerSource));

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
    /cappedCount !== compareCount\) compareCountEl\.value = String\(cappedCount\)/.test(comparerSource));
check('start-time compare count clamp is also written back',
    /compareCountEl && Number\(compareCountEl\.value\) !== compareCount/.test(comparerSource));
check('compare count cap is a named constant shared by both clamps',
    (comparerSource.match(/MAX_COMPARE_COUNT/g) || []).length >= 3);

// ---- 截断标记不得靠译文反推 ----

check('addLineNumbers no longer compares lines against a translated string',
    !/line === window\.i18n\.t\('compare\.outputTruncated'\)/.test(comparerSource));
check('addLineNumbers takes an explicit truncated flag',
    /addLineNumbers\(output, truncated = false\)/.test(comparerSource));
check('formatCompareOutput accepts and propagates an upstream truncated flag',
    /formatCompareOutput\(currentOutput, otherOutput, outputType, upstreamTruncated = false\)/.test(comparerSource));
check('truncation text access is i18n-ready guarded',
    /window\.i18n\?\.t\?\.\('compare\.outputTruncated'\)/.test(comparerSource));

// ---- 归一化口径统一 ----

check('normalizeForCompare trims line endings like compareOutputs does',
    /normalizeForCompare\(text\)[\s\S]*?\.replace\(\/\[ \\t\]\+\$\/, ''\)/.test(comparerSource));

// ---- 展开确认框单位自适应 ----

check('output size text adapts to B/KB/MB',
    /getOutputSizeText\(output\) \{[\s\S]*?`\$\{bytes\} B`[\s\S]*?KB`[\s\S]*?MB`/.test(comparerSource));
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

process.exit(failures > 0 ? 1 : 0);
