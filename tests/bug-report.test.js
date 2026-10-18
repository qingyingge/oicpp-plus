'use strict';

// BUG_REPORT.json 契约回归测试：锁定审计报告结构与“已修复”条目的
// 代码落点，防止修复被回退或报告条目与代码状态脱节。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { classMethod, compileMethod } = require('./fixtures/source-extract');
const { loadLocales } = require('./fixtures/ci-block-runner');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

// 需要在假 DOM 里 await 一遍的断言，统一交给文件末尾的 async 收尾执行
let deferredChecks = Promise.resolve([]);

// --- 报告可解析且结构完整 ------------------------------------------------
const reportPath = path.join(root, 'docs', 'BUG_REPORT.json');
let report = null;
try {
    report = JSON.parse(read('docs/BUG_REPORT.json'));
} catch (error) {
    check('BUG_REPORT.json parses as JSON', false, error.message);
}

if (report) {
    check('BUG_REPORT.json is a non-empty array', Array.isArray(report) && report.length > 0, `${report.length} entries`);

    const ids = new Set();
    let structOk = true;
    let statusCounts = {};
    for (const item of report) {
        if (!item.id || ids.has(item.id)) { structOk = false; }
        if (item.id) ids.add(item.id);
        if (!item.severity || !item.title || !item.status || !item.file) { structOk = false; }
        statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;

        if (item.status === '已修复') {
            if (!item.fix || typeof item.fix.commit !== 'string' || !item.fix.commit || !item.fix.note) { structOk = false; }
        }
    }
    check('every entry has unique id, severity, title, status, file', structOk);
    check('all entries have a recognized status', Object.keys(statusCounts).every((s) => ['已修复', '无效', '待确认', '待修复'].includes(s)));
    check('fixed entries carry a fix.commit and fix.note', statusCounts['已修复'] > 0, `${statusCounts['已修复']} fixed`);
    const placeholders = report.filter((i) => i.status === '已修复' && i.fix && i.fix.commit === 'TBD');
    check('no placeholder commit remains in BUG_REPORT.json', placeholders.length === 0, placeholders.length ? placeholders.map((p) => p.id).join(',') : '');
}

// --- 本次会话修复条目的代码落点 ------------------------------------------
if (report) {
    const editorSource = read('src/renderer/settings/editor.js');
    const sidebarCss = read('src/renderer/css/sidebar.css');
    const templatesHtml = read('src/renderer/settings/templates.html');
    const enJson = read('src/lang/en.json');

    // H14: parseInt 均带 radix
    const h14 = report.find((i) => i.id === 'H14');
    if (h14) {
        const bad = (editorSource.match(/parseInt\(([^)]*\.value|e\.target\.value)\)/g) || []);
        check('H14 editor.js parseInt calls all pass radix 10', bad.length === 0, bad.length ? bad.join('; ') : '');
    }

    // L7: 删除被 min-width: 0 覆盖的死代码 min-width: 200px
    const l7 = report.find((i) => i.id === 'L7');
    if (l7) {
        const panel = /\.sidebar-panel\s*\{[\s\S]*?\}/.exec(sidebarCss);
        const body = panel ? panel[0] : '';
        const hasDeadMinWidth = (body.match(/min-width:\s*200px/g) || []).length > 0;
        const hasMinWidth0 = body.includes('min-width: 0');
        check('L7 .sidebar-panel keeps only min-width: 0', hasMinWidth0 && !hasDeadMinWidth);
    }

    // L8: .message-toast.warning 不再携带 textarea 专属样式
    const l8 = report.find((i) => i.id === 'L8');
    if (l8) {
        const toastBlock = /\.message-toast\.warning\s*\{[\s\S]*?\}/.exec(templatesHtml);
        const body = toastBlock ? toastBlock[0] : '';
        const leaked = /resize:\s*vertical|font-family:\s*'Consolas'|box-sizing:\s*border-box/.test(body);
        check('L8 .message-toast.warning has no textarea styles', !leaked && body.includes('background-color: #ffc107'));
    }

    // L10: en.json analysisEmpty 为英文
    const l10 = report.find((i) => i.id === 'L10');
    if (l10) {
        const enPack = JSON.parse(enJson);
        const value = enPack.compileOutput && enPack.compileOutput.analysisEmpty;
        check('L10 en.json compileOutput.analysisEmpty is English', typeof value === 'string' && !/[\u4e00-\u9fff]/.test(value), value || '');
    }

    // L25: editor.js 回退默认设置均含 fontLigaturesEnabled
    const l25 = report.find((i) => i.id === 'L25');
    if (l25) {
        const blocks = [];
        const needle = 'this.settings = {';
        let idx = 0;
        while ((idx = editorSource.indexOf(needle, idx)) !== -1) {
            const end = editorSource.indexOf('};', idx);
            blocks.push(editorSource.slice(idx, end === -1 ? idx + 600 : end));
            idx += needle.length;
        }
        const allHaveLigatures = blocks.every((blk) => blk.includes('fontLigaturesEnabled'));
        check('L25 every editor.js settings block has fontLigaturesEnabled', blocks.length >= 3 && allHaveLigatures, `${blocks.length} blocks`);
    }

    // --- 本轮安全/资源修复条目代码落点 -----------------------------------
    const tabsSource = read('src/renderer/js/tabs.js');
    const sidebarSource = read('src/renderer/js/sidebar.js');
    const sampleTesterSource = read('src/renderer/js/sidebar/sampleTester.js');
    const mainSource = read('src/main.js');
    const langIndex = read('src/lang/index.js');
    const compilerSource = read('src/renderer/settings/compiler.js');
    const indexHtml = read('src/renderer/index.html');

    // H10: PDF 消息处理校验 event.origin（拒绝跨源伪造）
    const h10 = report.find((i) => i.id === 'H10');
    if (h10) {
        const pdfCtx = vm.createContext({
            window: { location: { origin: 'https://oicpp.local' }, i18n: { t: (k) => k } },
            logError: () => { },
            document: { querySelector: () => null, getElementById: () => null },
            JSON, Math, Number, String, Boolean, Array, Object, Error, RegExp, Promise, Map, Set
        });
        const pdfHandler = compileMethod(pdfCtx, classMethod(tabsSource, 'handlePdfViewerMessage'));
        check('方法体抽取成功: handlePdfViewerMessage', pdfHandler !== null);
        const mkTab = () => new Map([['k1', { viewType: 'pdf', tabId: 't1', uniqueKey: 'k1' }]]);
        const payload = (source) => ({ source, tabId: 't1', type: 'zoom-changed', detail: { scale: 1.5 } });
        deferredChecks = (async () => {
            const rows = [];
            if (!pdfHandler) {
                rows.push({ name: 'H10 PDF 守卫可执行', cond: false, extra: 'handler 没抽出来' });
                return rows;
            }
            const foreign = mkTab();
            await pdfHandler.call({ tabs: foreign }, { origin: 'https://evil.example', data: payload('oicpp-pdf-viewer') });
            rows.push({ name: 'H10 跨源 postMessage 直接丢弃（第三方页面伪造不了 PDF 状态）',
                cond: foreign.get('k1').pdfViewerScale === undefined, extra: String(foreign.get('k1').pdfViewerScale) });

            const same = mkTab();
            await pdfHandler.call({ tabs: same }, { origin: 'https://oicpp.local', data: payload('oicpp-pdf-viewer') });
            rows.push({ name: 'H10 同源且来源标记对得上才应用消息',
                cond: same.get('k1').pdfViewerScale === 1.5, extra: String(same.get('k1').pdfViewerScale) });

            const spoof = mkTab();
            await pdfHandler.call({ tabs: spoof }, { origin: 'https://oicpp.local', data: payload('someone-else') });
            rows.push({ name: 'H10 同源但 source 不是 oicpp-pdf-viewer 也不应用',
                cond: spoof.get('k1').pdfViewerScale === undefined, extra: String(spoof.get('k1').pdfViewerScale) });

            const otherTab = mkTab();
            await pdfHandler.call({ tabs: otherTab }, { origin: 'https://oicpp.local', data: { ...payload('oicpp-pdf-viewer'), tabId: 't9' } });
            rows.push({ name: 'H10 消息里的 tabId 找不到对应 PDF 标签页时不动任何状态',
                cond: otherTab.get('k1').pdfViewerScale === undefined && otherTab.size === 1,
                extra: `${otherTab.size}/${otherTab.get('k1').pdfViewerScale}` });
            return rows;
        })();
    }

    // H11: CSP frame-src 收窄为 self
    const h11 = report.find((i) => i.id === 'H11');
    if (h11) {
        const csp = /Content-Security-Policy" content="([^"]+)/.exec(indexHtml);
        const cspValue = csp ? csp[1] : '';
        check('H11 CSP frame-src narrowed to self', cspValue.includes('frame-src') && !cspValue.includes('frame-src *'));
    }

    // M22: sampleTester 提供 deactivate 清理 interval，且面板切换时调用
    const m22 = report.find((i) => i.id === 'M22');
    if (m22) {
        const cleared = [];
        const testerCtx = vm.createContext({
            clearInterval: (id) => { cleared.push(id); },
            logInfo: () => { },
            JSON, Math, Number, String, Boolean, Array, Object, Error, RegExp
        });
        const deactivate = compileMethod(testerCtx, classMethod(sampleTesterSource, 'deactivate'));
        check('方法体抽取成功: SampleTester.deactivate', deactivate !== null);
        if (deactivate) {
            const live = { editorChangeInterval: 7 };
            deactivate.call(live);
            check('M22 deactivate 清掉自己那个轮询定时器并把句柄置空',
                JSON.stringify(cleared) === '[7]' && live.editorChangeInterval === null,
                JSON.stringify({ cleared, handle: String(live.editorChangeInterval) }));
            cleared.length = 0;
            deactivate.call({ editorChangeInterval: null });
            check('M22 没在跑的 deactivate 不去 clearInterval(null)',
                cleared.length === 0, JSON.stringify(cleared));
        }

        const shown = [];
        class Icon {
            constructor(panel) { this.dataset = { panel }; this.classes = []; }
            get classList() {
                const self = this;
                return {
                    remove: () => { self.classes = []; },
                    add: (c) => { self.classes.push(c); }
                };
            }
        }
        const panelEl = (id) => {
            const el = { id, classes: [] };
            // classList 的方法必须闭包握住 el：写成对象方法里的 this，
            // 调用时 this 是 classList 自己，push 到的是 classList.classes
            el.classList = { remove: () => { el.classes = []; }, add: (c) => { el.classes.push(c); } };
            return el;
        };
        const icons = [];
        const panelEls = [];
        const buildDom = () => {
            icons.length = 0;
            panelEls.length = 0;
            icons.push(new Icon('files'), new Icon('samples'));
            panelEls.push(panelEl('files-panel'), panelEl('samples-panel'));
        };
        const sidebarCtx = vm.createContext({
            document: { querySelectorAll: (sel) => (sel === '.sidebar-icon' ? icons : panelEls) },
            HTMLElement: Icon,
            window: { oicppApp: { showMessage: (m, kind) => { shown.push([m, kind]); } }, i18n: { t: (k) => k } },
            logInfo: () => { }, logWarn: () => { },
            setTimeout: (fn) => { fn(); },
            JSON, Math, Number, String, Boolean, Array, Object, Error, RegExp, Map, Set
        });
        const showPanel = compileMethod(sidebarCtx, classMethod(sidebarSource, 'showPanel'));
        check('方法体抽取成功: SidebarManager.showPanel', showPanel !== null);
        if (showPanel) {
            let order = [];
            const mkSelf = (over = {}) => Object.assign({
                currentPanel: 'files',
                isCollapsed: false,
                panels: {
                    files: { name: 'files', activate: () => { order.push('files.activate'); }, deactivate: () => { order.push('files.deactivate'); } },
                    samples: { name: 'samples', activate: () => { order.push('samples.activate'); }, deactivate: () => { order.push('samples.deactivate'); } }
                },
                updateCloudPanelLocks: () => { },
                isCloudFileActive: () => false,
                expandSidebar: () => { }
            }, over);
            // 每次调用前把假 DOM 与记录器复原，断言才是「这一次调用的结果」
            const reset = () => {
                order = [];
                shown.length = 0;
                buildDom();
            };

            reset();
            showPanel.call(mkSelf(), 'samples');
            check('M22 切面板时先 deactivate 离开的那个，再 activate 进来的那个',
                JSON.stringify(order) === '["files.deactivate","samples.activate"]',
                JSON.stringify(order));

            reset();
            showPanel.call(mkSelf(), 'files');
            check('M22 切到当前面板不动任何副作用（不重复 activate 抖一下）',
                order.length === 0, JSON.stringify(order));

            reset();
            const bare = mkSelf();
            bare.panels.files = { activate: () => { order.push('files.activate'); } };
            let threw = null;
            try { showPanel.call(bare, 'samples'); } catch (e) { threw = e; }
            check('M22 面板没实现 deactivate 也不该炸（typeof 守卫在）',
                threw === null && String(order) === 'samples.activate',
                `${threw && threw.message}|${order}`);

            reset();
            const cloud = mkSelf({ isCloudFileActive: () => true });
            showPanel.call(cloud, 'samples');
            check('M22 云端文件占用时早退：不 deactivate、不 activate，只提示一次',
                order.length === 0 && shown.length === 1 && shown[0][1] === 'warning',
                JSON.stringify({ order, shown }));

            reset();
            showPanel.call(mkSelf(), 'samples');
            check('M22 切换后高亮跟着走（图标与面板 content 都只留目标一个 active）',
                String(order) === 'files.deactivate,samples.activate' &&
                String(icons[1].classes) === 'active' && String(icons[0].classes) === '' &&
                String(panelEls[1].classes) === 'active' && String(panelEls[0].classes) === '',
                JSON.stringify({ i0: icons[0].classes, i1: icons[1].classes, p0: panelEls[0].classes, p1: panelEls[1].classes }));

            // 同一个 self 连切两次：第一次的 currentPanel 得真的落定，
            // 否则第二次还是从最初那个面板 deactivate，切来切去全切在同一个上
            reset();
            const moving = mkSelf();
            showPanel.call(moving, 'samples');
            const firstSwitch = String(order);
            reset();
            showPanel.call(moving, 'files');
            check('M22 currentPanel 跟着切换落定，第二次是从新面板 deactivate',
                firstSwitch === 'files.deactivate,samples.activate' &&
                moving.currentPanel === 'files' &&
                String(order) === 'samples.deactivate,files.activate',
                JSON.stringify({ firstSwitch, currentPanel: moving.currentPanel, order }));

            reset();
            const collapsedSelf = mkSelf({
                isCollapsed: true,
                expandSidebar: () => {
                    order.push('expand');
                    // 展开过程里状态会变，早于本次比较就必须不影响 deactivate 通知
                    collapsedSelf.isCollapsed = false;
                }
            });
            showPanel.call(collapsedSelf, 'samples');
            check('M22 折叠状态下先展开再切面板，展开不改 currentPanel 就不会吞掉 deactivate',
                String(order) === 'expand,files.deactivate,samples.activate', String(order));
        }
    }

    // L1: 移除死代码 debugProcess/debugSession
    const l1 = report.find((i) => i.id === 'L1');
    if (l1) {
        // 这条**故意留在文本层**：死代码没有用户可见行为，把「不存在」换成真跑就是自证。
        // 但口径从只认 `let` 放宽到任意声明关键字 —— 原来写成 `var debugProcess` 就能绕过。
        // `debugSessionRootDir` 这类仍在用的名字靠 `\b` 排除，不是靠锁 `let`。
        check('L1 debugProcess/debugSession 两个死变量没以任何声明形式回来',
            !/(?:let|var|const)\s+debug(?:Process|Session)\b/.test(mainSource));
    }

    // L9: 移除 templates.html 死代码 tab 切换脚本
    const l9 = report.find((i) => i.id === 'L9');
    if (l9) {
        check('L9 templates.html dead tab script removed', !templatesHtml.includes('.settings-tabs .tab-btn'));
    }

    // L15: 移除 lang/index.js 无效 reload()
    const l15 = report.find((i) => i.id === 'L15');
    if (l15) {
        check('L15 lang/index.js dead reload removed', !langIndex.includes('reload:') && !langIndex.includes('reloadResources'));
    }

    // L28: compiler.js testlib-path 元素空值保护
    const l28 = report.find((i) => i.id === 'L28');
    if (l28) {
        // 原来是两条「从方法名一路贪婪捞到那行 if，再在捞出来的片段里比字面量」：
        // 锚点锁 `async testTestlib() {` 的排版和那行 if 的写法，tsc 一重排就断；
        // 更要紧的是它只证明「源码里写过这句」，删掉守卫后界面会不会炸，它一句都没说。
        // 现在把三个方法整段抽出来在假 DOM 里真跑 —— 元素不存在就是不存在，跑出来看。
        const methods = {
            testTestlib: classMethod(compilerSource, 'testTestlib'),
            setTestlibPath: classMethod(compilerSource, 'setTestlibPath'),
            updateUI: classMethod(compilerSource, 'updateUI')
        };
        check('L28 三个方法体整段抽取成功（真跑的必须是源码里那三段）',
            Object.values(methods).every((m) => m.length > 150),
            JSON.stringify(Object.fromEntries(Object.entries(methods).map(([k, m]) => [k, m.length]))));

        const packs = loadLocales();
        const zh = packs['zh-cn'];
        // 每个元素套一层 Proxy：「把同样的值又写了一遍」和「压根没写」必须能在断言里区分开。
        const mkRec = (proto) => {
            const writes = [];
            const target = { ...proto };
            return new Proxy(target, {
                set: (o, k, v) => { writes.push([String(k), String(v)]); o[k] = v; return true; },
                get: (o, k) => (k === '__writes' ? writes : o[k])
            });
        };
        const runCase = async (name, present, args = [], values = {}, lang = 'zh-cn') => {
            const pack = packs[lang];
            const els = {};
            const classes = [];
            const renders = [];
            const saved = [];
            const apiCalls = [];
            const popupOption = mkRec({ disabled: null });
            const hint = mkRec({ textContent: null });
            for (const id of present) {
                if (id === 'run-mode') {
                    els[id] = mkRec({ value: '', querySelector: () => popupOption, parentElement: { querySelector: () => hint } });
                } else if (id === 'testlib-test-result') {
                    els[id] = mkRec({
                        textContent: null,
                        classList: { remove: () => { }, add: (c) => classes.push(c) }
                    });
                } else {
                    els[id] = mkRec({ value: values[id] === undefined ? '' : values[id] });
                }
            }
            const ctx = vm.createContext({
                document: { getElementById: (id) => els[id] || null, querySelector: () => null },
                window: {
                    i18n: { t: (k) => pack[k] },
                    electronAPI: {
                        testTestlib: (p) => { apiCalls.push(['testTestlib', p]); return Promise.resolve({ success: true }); },
                        saveSetting: (k, v) => { saved.push([k, v]); return Promise.resolve(); }
                    }
                },
                Object, Array, String, Number, Boolean, Math, JSON, Error, Promise, RegExp,
                logError: () => { }, logWarn: () => { }, logInfo: () => { }
            });
            try {
                for (const [m, s] of Object.entries(methods)) {
                    const fn = compileMethod(ctx, s);
                    if (!fn) return { missing: m };
                    ctx.__fns = { ...ctx.__fns, [m]: fn };
                }
                const self = {
                    settings: {
                        compilerPath: '/usr/bin/g++', pythonInterpreterPath: '/usr/bin/python3',
                        compilerArgs: '-O2', runMode: 'popup', testlibPath: '/from-settings.txt'
                    },
                    isIntegratedOnlyPlatform: false
                };
                await ctx.__fns[name].apply(self, args);
                return {
                    writes: Object.fromEntries(Object.entries(els).map(([k, v]) => [k, v.__writes])),
                    extra: { popupOption: popupOption.__writes, hint: hint.__writes },
                    classes, saved, apiCalls
                };
            } catch (error) {
                return { threw: String((error && error.message) || error) };
            }
        };
        const TL = 'testlib-path';
        const RESULT = 'testlib-test-result';
        const ALL_INPUTS = ['compiler-path', 'python-interpreter-path', 'compiler-options', 'run-mode', TL];
        deferredChecks = deferredChecks.then(async (rows) => {
            const more = [];
            const add = (name, cond, extra) => more.push({ name, cond, extra: extra === undefined ? '' : JSON.stringify(extra) });

            const gone = await runCase('testTestlib', [RESULT]);
            add('L28 testTestlib：#testlib-path 不存在时不炸，且整条流程都不往下走',
                !gone.threw && !gone.missing && gone.apiCalls.length === 0
                    && gone.classes.length === 0 && gone.writes[RESULT].length === 0, gone);
            const empty = await runCase('testTestlib', [TL, RESULT]);
            add('L28 testTestlib：对照组 —— 元素在但值为空，提示走 i18n 取真译文并打上 is-error',
                !empty.threw && empty.apiCalls.length === 0
                    && JSON.stringify(empty.writes[RESULT]) === JSON.stringify([['textContent', zh['compiler.setTestlibPathFirst']]])
                    && JSON.stringify(empty.classes) === JSON.stringify(['is-error']), empty);
            const filled = await runCase('testTestlib', [TL, RESULT], [], { [TL]: '/my.txt' });
            add('L28 testTestlib：对照组 —— 有值才真去调 electronAPI 并渲染成功态',
                !filled.threw
                    && JSON.stringify(filled.apiCalls) === JSON.stringify([['testTestlib', '/my.txt']])
                    && JSON.stringify(filled.classes) === JSON.stringify(['is-testing', 'is-success'])
                    && JSON.stringify(filled.writes[RESULT]) === JSON.stringify([
                        ['textContent', zh['compiler.testingTestlib']],
                        ['textContent', zh['compiler.testlibSuccess']]]), filled);

            const emptyEn = await runCase('testTestlib', [TL, RESULT], [], {}, 'en');
            const filledEn = await runCase('testTestlib', [TL, RESULT], [], { [TL]: '/my.txt' }, 'en');
            // 只跑 zh-cn 分不出「走 i18n」和「硬编码同一句中文」—— 两者渲染结果逐字相同。
            // 换 en 包再跑一遍才有效：译文跟着语言包变，硬编码的字面量不会。
            add('L28 testTestlib：换 en 包这两句都跟着变译文（证明文案真从语言包取，不是硬编码中文）',
                !emptyEn.threw && !filledEn.threw
                    && JSON.stringify(emptyEn.writes[RESULT]) === JSON.stringify([['textContent', packs.en['compiler.setTestlibPathFirst']]])
                    && JSON.stringify(filledEn.writes[RESULT].slice(-1)) === JSON.stringify([['textContent', packs.en['compiler.testlibSuccess']]]),
                { emptyEn, filledEn });
            add('L28 testTestlib：渲染结果里不许出现键名本身（裸键上屏就是这句提示的失败形态）',
                [emptyEn, filledEn].every((r) => JSON.stringify(r.writes[RESULT]).indexOf('compiler.') < 0),
                { emptyEn, filledEn });

            const setGone = await runCase('setTestlibPath', [], ['/my.txt']);
            add('L28 setTestlibPath：元素不存在时不炸，DOM 一个字节都不写，但设置照样落盘',
                !setGone.threw && !setGone.missing && Object.keys(setGone.writes).length === 0
                    && JSON.stringify(setGone.saved) === JSON.stringify([['testlibPath', '/my.txt']]), setGone);
            const setHere = await runCase('setTestlibPath', [TL], ['/my.txt']);
            add('L28 setTestlibPath：对照组 —— 元素在就写进去，落盘照旧',
                !setHere.threw
                    && JSON.stringify(setHere.writes[TL]) === JSON.stringify([['value', '/my.txt']])
                    && JSON.stringify(setHere.saved) === JSON.stringify([['testlibPath', '/my.txt']]), setHere);

            const uiAll = await runCase('updateUI', ALL_INPUTS);
            add('L28 updateUI：五个元素都在时各归各位（testlib 取的是 settings 里的值）',
                !uiAll.threw && JSON.stringify(uiAll.writes[TL]) === JSON.stringify([['value', '/from-settings.txt']])
                    && Object.keys(uiAll.writes).length === 5, uiAll);
            const uiGone = await runCase('updateUI', ALL_INPUTS.filter((i) => i !== TL));
            add('L28 updateUI：只缺 #testlib-path 时不炸，其余四个写入与全量那次逐字节相同',
                !uiGone.threw && uiGone.writes[TL] === undefined
                    && ['compiler-path', 'python-interpreter-path', 'compiler-options', 'run-mode']
                        .every((k) => JSON.stringify(uiGone.writes[k]) === JSON.stringify(uiAll.writes[k])),
                { uiGone, uiAll });
            return [...rows, ...more];
        });
    }

    // L6: 报告称 monaco-editor.css 首个 :root 是死代码，实测两个 :root 变量集不同。
    // 锁定 invalid_reason 成立，防止后续误删仍在使用的变量。
    const l6 = report.find((i) => i.id === 'L6');
    if (l6) {
        check('L6 monaco-editor.css has two :root blocks', l6.status === '无效');
        const monacoCss = read('src/renderer/css/monaco-editor.css');
        const rootBlocks = [...monacoCss.matchAll(/(^|\})\s*:root\s*\{([^}]*)\}/gm)].map((m) => m[2]);
        const varsOf = (body) => [...new Set((body.match(/--[a-z0-9-]+(?=\s*:)/g) || []))];
        const firstVars = new Set(varsOf(rootBlocks[0] || ''));
        const secondVars = new Set(varsOf(rootBlocks[1] || ''));
        const firstOnly = [...firstVars].filter((v) => !secondVars.has(v));
        check('L6 the two :root blocks do not declare the same variables',
            rootBlocks.length === 2 && firstOnly.length > 0 && firstVars.size !== secondVars.size,
            `first=${firstVars.size} second=${secondVars.size} firstOnly=${firstOnly.length}`);
        const restOfMonacoCss = monacoCss.slice(monacoCss.indexOf(rootBlocks[1] || ''));
        // 变量可能只在其他 CSS、HTML 或渲染脚本里被引用（如 --editor-font-* 由
        // settings-init.js 设置、Monaco 消费），所以扫描整个渲染层源码。
        const corpus = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (/\.(css|html|js)$/.test(entry.name) && full !== path.join(root, 'src', 'renderer', 'css', 'monaco-editor.css')) {
                    corpus.push(fs.readFileSync(full, 'utf8'));
                }
            }
        };
        walk(path.join(root, 'src', 'renderer'));
        const cssCorpus = corpus.join('\n') + '\n' + restOfMonacoCss;
        const unused = firstOnly.filter((v) => !cssCorpus.includes(v));
        check('L6 variables unique to the first :root are still used elsewhere',
            unused.length === 0,
            unused.join(',') || `${firstOnly.length}/${firstOnly.length} in use`);
    }
}

(async () => {
    for (const row of await deferredChecks) check(row.name, row.cond, row.extra);
    console.log(`bug-report regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    check('bug-report 异步守卫自身跑通', false, String((error && error.stack) || error));
    process.exitCode = 1;
});
