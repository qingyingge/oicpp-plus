'use strict';

// upstream 1.6.0-beta1 样例测试 / 对拍批（f28bc6e + 402e042）移植后的守卫。
//
// fork 在这一片本来就比上游修得多（cleanupPartialCompiles、_runningSampleIds、
// mode='stopping' 路由都自有方案），所以这里只锁「这次补上的差量」，并且刻意
// 不复现上游的 isRunning 生命周期 —— 那会推翻 fork 的完成事件路由。

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const comparerSource = read('src/renderer/js/sidebar/codeComparer.js');
const testerSource = read('src/renderer/js/sidebar/sampleTester.js');
const panelSource = read('src/renderer/js/sidebar/debugPanel.js');
const compileSource = read('src/renderer/js/compile-manager.js');
const mainSource = read('src/main.js');
const cssSource = read('src/renderer/css/compare.css');

// 抽出来的方法体里会摸 window（i18n、uiIcons），给一个最小替身；
// 断言看的是返回值，不是这些桩。
global.window = {
    i18n: { t: (key) => key },
    uiIcons: null,
    logWarn: () => { },
    logInfo: () => { }
};

// 取 `    name(args) { ... }` 这一整段（到下一个 4 空格缩进的方法名为止），
// 拼进对象字面量里真调 —— 与仓库既有测试同一套路。
const methodOf = (src, name) => {
    const m = new RegExp(`\\n    (?:async )?${name}\\((?:[^)]*)\\) \\{[\\s\\S]*?\\n    \\}(?=\\n    (?:/\\*|async |[A-Za-z_$]))`).exec(src);
    return m ? m[0] : '';
};

// ------------------------------------------- 对拍入口：守卫必须早于任何 await
{
    const body = methodOf(comparerSource, 'startComparison');
    check('抽取到 startComparison', body.length > 0, String(body.length));
    if (body) {
        const firstAwait = body.search(/await this\./);
        const guardAt = body.indexOf('task.state.starting');
        check('starting 占位早于第一个 await（原先 await autoSave 在守卫之前）',
            guardAt > 0 && firstAwait > guardAt, JSON.stringify({ guardAt, firstAwait }));
        check('守卫看 mode，stopping 期间不许再起一轮',
            /task\.state\.mode === 'running' \|\| task\.state\.mode === 'stopping'/.test(body), body.slice(0, 400));
        check('starting 用 try/finally 复位（早退也要还回去）',
            /finally \{\s*task\.state\.starting = false;/.test(body));

        const obj = new Function(`return {${body.replace(/^\n    /, '')}}`)();
        const calls = [];
        const mkTask = (state) => ({
            config: { standardCodePath: 'a.cpp', testCodePath: 't.cpp', generatorPath: 'g.cpp' },
            state
        });
        const run = async (state) => {
            calls.length = 0;
            const self = {
                testCodePath: 't.cpp',
                getActiveTask: () => null,
                getOrCreateTask: () => mkTask(state),
                showTaskCompileError: (t, kind, msg) => { calls.push(`err:${kind}`); },
                autoSaveCurrentFile: async () => { calls.push('autoSave'); },
                startComparisonBody: async () => { calls.push('body'); }
            };
            Object.setPrototypeOf(self, obj);
            await obj.startComparison.call(self);
            return calls.slice();
        };

        (async () => {
            const base = { isRunning: false, shouldStop: false, mode: 'idle' };
            await run({ ...base });
            check('空闲任务照常进入正文', calls.join(',') === 'body', calls.join(','));
            check('正文跑完把 starting 还回去', obj.startComparison && true);

            await run({ ...base, isRunning: true });
            check('isRunning 时拒起第二轮，且不 autoSave', calls.join(',') === 'err:general', calls.join(','));

            await run({ ...base, mode: 'stopping' });
            check('mode=stopping 同样被拒（fork 靠它路由完成事件）', calls.join(',') === 'err:general', calls.join(','));

            await run({ ...base, starting: true });
            check('starting 占位期间被拒', calls.join(',') === 'err:general', calls.join(','));
        })().catch((e) => check('startComparison 用例整体跑通', false, String(e && e.stack)));
    }

    check('停止按钮在已请求停止后禁用',
        /stopBtn\.disabled = !running \|\| !!task\?\.state\?\.shouldStop/.test(comparerSource));
    check('保留 fork 的 running 定义（isRunning && mode 为 running/stopping）',
        /const running = !!task\?\.state\?\.isRunning && \(task\?\.state\?\.mode === 'running' \|\| task\?\.state\?\.mode === 'stopping'\)/.test(comparerSource));
}

// --------------------------------- 生成器/被测程序输出不许被 trim 掉前导空白
{
    const runProgram = methodOf(comparerSource, 'runProgram') || methodOf(testerSource, 'runProgram');
    check('抽取到 runProgram', runProgram.length > 0);
    check('返回值用未 trim 的 rawOutput，trim 只留给错误正文',
        /const rawOutput = result\.output \|\| '';/.test(runProgram)
        && /output: rawOutput,/.test(runProgram)
        && /errorMessage = trimmedOutput/.test(runProgram), String(runProgram.slice(0, 200)));
}

// ---------------------------------------------- 样例：BOM、差异高亮、跨文件覆盖
{
    const compare = methodOf(testerSource, 'compareOutput');
    check('抽取到 compareOutput', compare.length > 0);
    if (compare) {
        const obj = new Function(`return {${compare.replace(/^\n    /, '')}}`)();
        check('仅差一个 BOM 时判 AC（原先判 WA 且界面上看不出区别）',
            obj.compareOutput('﻿42\n', '42\n') === 'AC');
        check('内容真的不同时仍判 WA', obj.compareOutput('43\n', '42\n') === 'WA');
        check('行尾空白仍然被容忍（既有口径不许回退）', obj.compareOutput('42  \n', '42\n') === 'AC');
    }

    const highlight = methodOf(testerSource, 'createHighlightedOutput');
    check('抽取到 createHighlightedOutput', highlight.length > 0);
    if (highlight) {
        const obj = new Function(`return {
            escapeHtml(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
            ${highlight.replace(/^\n    /, '')}
        }`)();
        const actual = [1, 2, 3].map((n) => `a${n}`).join('\n');
        const expected = [1, 2, 3, 4, 5].map((n) => `b${n}`).join('\n');
        const html = obj.createHighlightedOutput(actual, expected);
        // 高亮面板画的是「实际输出 + 差异标记」，期望更长的行本身不产出文本；
        // displayLines 改成按两边取大之后，多出来的行要以空行 + 差异标记出现。
        const renderedLines = html.split('\n').length;
        check('期望输出更长时，多出来的行也占位并标差异（原先只画 actual 的行数）',
            renderedLines === 5 && (html.match(/diff-highlight/g) || []).length === 5,
            JSON.stringify({ renderedLines, spans: (html.match(/diff-highlight/g) || []).length }));
        check('不再对入参二次 truncate（截断点之后的差异标记会整个消失）',
            !/truncateOutput/.test(highlight));

        const longActual = Array.from({ length: 150 }, (_, i) => `a${i}`).join('\n');
        const longExpected = Array.from({ length: 150 }, (_, i) => `e${i}`).join('\n');
        const capped = obj.createHighlightedOutput(longActual, longExpected);
        check('展示仍封顶 100 行（极端输出不许拖死界面）',
            (capped.match(/<div/g) || []).length <= 100,
            String((capped.match(/<div/g) || []).length));
    }
}

// -------------------------------- 跨文件报错定位 / 路径不一致时拒跑
{
    const click = /line\.addEventListener\('click', async \(\) => \{[\s\S]*?\n                    \}\);/.exec(compileSource);
    check('抽取到编译输出的点击回调', !!click, String(click && click[0].length));
    if (click) {
        const src = click[0];
        check('同文件才直接 reveal', /if \(sameFile\) \{\s*revealIn\(currentEditor\)/.test(src));
        check('跨文件先 readFileContent + openFile 再定位',
            /readFileContent/.test(src) && /window\.tabManager\?\.openFile\?/.test(src));
        check('打开失败退回当前编辑器（不能什么都不做）',
            /catch \(e\)[\s\S]*打开错误文件失败[\s\S]*\}\s*revealIn\(currentEditor\);/.test(src));
    }

    check('样例编译前校验编辑器真实路径与 currentFile 一致',
        /editorPathChecked && !editorPathMatches/.test(testerSource)
        && /i18n\.t\('tester\.fileSwitched'\)/.test(testerSource));
    check('路径不一致判定不拿译文做字符串匹配',
        !/error\.message === window\.i18n\.t\('tester\.fileSwitched'\)/.test(testerSource));
    check('SPJ 临时文件列表过滤掉 null（否则 cleanup 整批中断）',
        /tempFiles\.filter\(Boolean\)\.forEach/.test(testerSource));
    check('runAllSamples 有批次级 catch，并在其中复位 in-flight 标记',
        /catch \(error\) \{[\s\S]*运行所有样例失败[\s\S]*\}\s*finally \{\s*this\._runningAllSamples = false;/.test(testerSource));
    check('运行所有样例按钮接住 rejection',
        /runAllSamples\(\)\.catch\(/.test(testerSource));
    check('保留设备名按主干判定（con.cpp 仍然非法）',
        (testerSource.match(/reserved\.test\((?:cleaned|safe)\.replace\(\/\\\.\[\^\.\]\*\$\/, ''\)\)/g) || []).length === 2,
        String((testerSource.match(/reserved\.test\(/g) || []).length));
    check('readFileContent 去掉 UTF-8 BOM', /toString\('utf8'\)\.replace\(\/\^\\uFEFF\/, ''\)/.test(mainSource));
}

// -------------------------------------------- 调试面板：全局变量区与调用栈容器
{
    check('模板里有 #global-variables 分区', /id="global-variables"/.test(panelSource));
    check('模板里有 #call-stack 容器（_renderStack 找的就是它）', /id="call-stack"/.test(panelSource));
    check('两处变量渲染都带上全局变量组',
        (panelSource.match(/_renderVariableGroup\('#global-variables', this\.variableCache\.global, 'global'\)/g) || []).length === 2);
    check('调用栈文本走转义（函数名/文件名来自被调试进程）',
        /_escapeHtml\(f\.function/.test(panelSource) && /_escapeHtml\(f\.file/.test(panelSource));
}

// ----------------------------------------------------------- 对拍面板窄侧栏 CSS
{
    const blockOf = (sel) => {
        const m = new RegExp(`\\n\\.${sel} \\{[^}]*\\}`).exec(cssSource);
        return m ? m[0] : '';
    };
    check('.config-item 允许换行', /\.config-item \{[^}]*flex-wrap: wrap;/.test(cssSource));
    check('.spj-section 去掉 min-width:200px 硬约束、允许收缩换行',
        /\.spj-section \{[^}]*min-width: 0;/.test(cssSource)
        && !/\.spj-section \{[^}]*min-width: 200px/.test(cssSource)
        && /\.spj-section \{[^}]*flex-wrap: wrap;/.test(cssSource));
    // 上游那三条 flex: 0 0 auto 落在按钮/标签上，不是 .config-btn
    for (const sel of ['file-browse-btn', 'testlib-label', 'spj-label']) {
        check(`.${sel} 不收缩`, /flex: 0 0 auto;/.test(blockOf(sel)), blockOf(sel).slice(0, 60));
    }
    check('.spj-input 允许收缩并带上 min-width:0',
        /\.spj-input \{[^}]*flex: 1 1 120px;[^}]*min-width: 0;/.test(cssSource));
    check('.spj-input 内的 .config-input 不再强制固定宽',
        /\.spj-input \.config-input \{[^}]*width: auto;[^}]*min-width: 0;/.test(cssSource));
}

setTimeout(() => {
    console.log(`\nupstream 1.6.0-beta1 样例/对拍移植 tests completed: ${failures === 0 ? 'all checks passed' : failures + ' FAILED'}`);
    process.exitCode = failures === 0 ? 0 : 1;
}, 300);
