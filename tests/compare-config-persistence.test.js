'use strict';

// 对拍配置的持久化守卫。
//
// 这块逻辑的失败模式全是静默的：读盘在途时用户刚填的路径被过期数据冲掉、
// threadCount 的 NaN（留空=自动）落成 0 变成 1 路并行、configLoaded 还没置上
// 就把默认值写盘盖掉用户那份、没有工作区时往 null 路径写文件。
// 所以这里把真方法抽进 vm，用桩 electronAPI 跑，断言的是「最后写出去/落进内存的内容」，
// 不是源码里有没有那行字。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { classMethod, compileMethod, scalarConst } = require('./fixtures/source-extract');

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const src = read('src', 'renderer', 'js', 'sidebar', 'codeComparer.js');

const METHODS = ['serializeTaskConfig', 'loadTaskConfig', 'scheduleTaskConfigSave', 'writeTaskConfig',
    'computeCompareConfigPath', 'getWorkspaceRoot', 'readCompareViewPrefs', 'writeCompareViewPrefs',
    'setBlockCollapsed', 'applyCompareViewPrefs', 'applyTaskConfigToInstance'];

const real = {};
for (const name of METHODS) {
    const body = classMethod(src, name);
    check(`方法体抽取成功: ${name}`, body.length > 0, body.slice(0, 24));
}

// 生产阈值另有一条文本断言兜着，测试里用的是快进值，不然每条都要等 500ms
const debounceDecl = scalarConst(src, 'COMPARE_CONFIG_SAVE_DEBOUNCE_MS');
const storageDecl = scalarConst(src, 'COMPARE_VIEW_STORAGE_KEY');
check('写盘节流常量抽取成功且不小于 200ms（逐次写盘会把同一个 json 重写十几遍）',
    debounceDecl.startsWith('const COMPARE_CONFIG_SAVE_DEBOUNCE_MS') && /=\s*(\d+)/.test(debounceDecl)
    && Number(RegExp.$1) >= 200, debounceDecl);
check('视图偏好键名固定（改了等于把老用户的开合状态丢掉）',
    storageDecl.includes("'oicpp.compare.viewState'"), storageDecl);

const harness = ({ fileContent, workspace = 'D:/proj', localStorage = {}, readThrows = false } = {}) => {
    const writes = [];
    const reads = [];
    const ensured = [];
    let now = 0;
    const timers = new Map();
    let timerId = 0;
    const ctx = vm.createContext({
        JSON, Math, Number, String, Boolean, Object, Array, Promise, Error, RegExp, isNaN, parseInt, parseFloat,
        Map, Set, Date,
        performance: { now: () => now },
        setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
        clearTimeout: (id) => { timers.delete(id); },
        document: {
            // 必须按 id 缓存：setBlockCollapsed 写 class、断言再读回来，
            // 每次返回新对象的话「状态有没有落进 DOM」这条断言永远测不到东西。
            _byId: {},
            getElementById(id) {
                if (!this._byId[id]) {
                    this._byId[id] = {
                        id,
                        classList: {
                            _set: id === 'cmp-block-io' ? new Set(['collapsed']) : new Set(),
                            toggle(cls, on) { on ? this._set.add(cls) : this._set.delete(cls); },
                            contains(cls) { return this._set.has(cls); }
                        },
                        querySelector: () => ({ setAttribute: () => {} })
                    };
                }
                return this._byId[id];
            }
        },
        logInfo: () => {}, logWarn: (...a) => { (ctx.__warns || (ctx.__warns = [])).push(a.join(' ')); },
        logError: () => {},
        window: {
            localStorage: {
                getItem: (k) => (k in localStorage ? localStorage[k] : null),
                setItem: (k, v) => { localStorage[k] = String(v); }
            },
            i18n: { t: (k) => k },
            electronAPI: {
                pathJoin: async (...parts) => parts.join('/'),
                ensureDirectory: async (p) => { ensured.push(p); return { success: true }; },
                readFileContent: async (p) => {
                    reads.push(p);
                    if (readThrows) throw new Error('ENOENT');
                    return fileContent;
                },
                writeFile: async (p, content) => { writes.push({ path: p, content }); return { success: true }; }
            },
            sidebarManager: { panels: { files: workspace ? { workspacePath: workspace } : null } }
        }
    });
    // 节流阈值在测试里压到 0，同时保留「源码里那个常量确实是 500」这条文本断言
    vm.runInContext('var COMPARE_CONFIG_SAVE_DEBOUNCE_MS = 0;', ctx);
    vm.runInContext(`var COMPARE_VIEW_STORAGE_KEY = ${JSON.stringify('oicpp.compare.viewState')};`, ctx);
    const methods = {};
    for (const name of METHODS) methods[name] = compileMethod(ctx, classMethod(src, name));
    const self = {
        tasks: new Map(),
        viewPrefs: { blocks: {} },
        configSaveTimers: null,
        maxParallelThreads: 8,
        renderIfActive: () => {},
        applyTaskConfigToInstance: methods.applyTaskConfigToInstance,
        normalizeFreopenFileName: (v) => String(v || ''),
        ...methods
    };
    const flushTimers = () => {
        const pending = [...timers.values()];
        timers.clear();
        pending.forEach((t) => t.fn());
    };
    return { ctx, self, methods, writes, reads, ensured, localStorage, flushTimers, warns: () => ctx.__warns || [] };
};

const mkTask = (over = {}) => ({
    key: 'd:/proj/a.cpp',
    config: {
        standardCodePath: '', testCodePath: 'd:/proj/a.cpp', generatorPath: '',
        useTestlib: false, spjPath: '', freopenInputFile: '', freopenOutputFile: '',
        threadCount: NaN, compareCount: 100, timeLimit: 1000
    },
    state: { stats: null, engineWarnings: [] },
    compiledExecutables: null,
    configLoaded: false,
    ...over
});

(async () => {
    // ---- 序列化 ----
    {
        const h = harness();
        const ser = (t) => h.methods.serializeTaskConfig.call(h.self, t);
        const out = ser(mkTask());
        check('threadCount 的 NaN（留空=自动）序列化成 null，不落成 0',
            out.threadCount === null, JSON.stringify(out));
        check('默认值也照样带 v:1（将来换格式要有依据）', out.v === 1, JSON.stringify(out.v));
        const filled = ser(mkTask({
            config: {
                standardCodePath: 'D:/p/std.cpp', testCodePath: 'D:/p/a.cpp', generatorPath: 'D:/p/gen.cpp',
                useTestlib: true, spjPath: 'D:/p/spj.cpp', freopenInputFile: 'a.in', freopenOutputFile: 'a.out',
                threadCount: 6, compareCount: 2000, timeLimit: 500
            }
        }));
        check('填好的配置逐字段进 JSON，数字不再被 null 顶掉',
            filled.standardCodePath === 'D:/p/std.cpp' && filled.threadCount === 6
            && filled.compareCount === 2000 && filled.timeLimit === 500 && filled.useTestlib === true
            && filled.freopenInputFile === 'a.in' && filled.freopenOutputFile === 'a.out'
            && filled.spjPath === 'D:/p/spj.cpp', JSON.stringify(filled));
    }

    // ---- 路径推导 ----
    {
        const h = harness();
        const p = await h.methods.computeCompareConfigPath.call(h.self, 'D:/proj/sub/a.cpp');
        check('配置文件落在 <workspace>/.oicpp-plus/codeComparer/ 下',
            typeof p === 'string' && p.includes('.oicpp-plus') && p.includes('codeComparer')
            && p.endsWith('sub_a.cpp.json'), String(p));
        check('目录写之前先 ensureDirectory（新工作区没有这个目录）',
            h.ensured.length >= 2 && h.ensured.some((d) => d.includes('codeComparer')), JSON.stringify(h.ensured));
        const outside = await h.methods.computeCompareConfigPath.call(h.self, 'E:/other/b.cpp');
        check('工作区外的绝对路径也压成合法文件名，不逃出目录',
            typeof outside === 'string' && !/[<>:"|?*]/.test(outside.split('/').pop()), String(outside));
        const h2 = harness({ workspace: '' });
        const none = await h2.methods.computeCompareConfigPath.call(h2.self, 'D:/proj/a.cpp');
        check('没开工作区时返回 null（不往 undefined 路径写文件）', none === null, String(none));
        const h3 = harness();
        check('空 key 不推导路径', await h3.methods.computeCompareConfigPath.call(h3.self, '') === null);
    }

    // ---- 读盘 ----
    {
        const saved = JSON.stringify({
            v: 1, standardCodePath: 'D:/proj/std.cpp', generatorPath: 'D:/proj/gen.cpp',
            spjPath: '', useTestlib: false, freopenInputFile: '', freopenOutputFile: '',
            compareCount: 5000, timeLimit: 2000, threadCount: null
        });
        const h = harness({ fileContent: saved });
        const t = mkTask();
        await h.methods.loadTaskConfig.call(h.self, t);
        check('读盘后恢复标准代码/生成器/组数/时限',
            t.config.standardCodePath === 'D:/proj/std.cpp' && t.config.generatorPath === 'D:/proj/gen.cpp'
            && t.config.compareCount === 5000 && t.config.timeLimit === 2000, JSON.stringify(t.config));
        check('threadCount 存的是 null，回读还原成 NaN（自动），不是 0',
            Number.isNaN(t.config.threadCount), String(t.config.threadCount));
        check('读成功后置 configLoaded（后续才允许写盘）', t.configLoaded === true, String(t.configLoaded));

        // 读盘在途时用户改了路径
        const h2 = harness({ fileContent: saved });
        const t2 = mkTask();
        const promise = h2.methods.loadTaskConfig.call(h2.self, t2);
        t2.config.standardCodePath = 'D:/proj/我手动选的.cpp';
        await promise;
        check('读盘在途时用户改过的字段不被过期数据冲掉',
            t2.config.standardCodePath === 'D:/proj/我手动选的.cpp', t2.config.standardCodePath);

        const h3 = harness({ fileContent: '{ not json' });
        const t3 = mkTask();
        let threw = null;
        try { await h3.methods.loadTaskConfig.call(h3.self, t3); } catch (e) { threw = String(e); }
        check('坏 JSON 不抛异常，保留默认值并标记已加载',
            threw === null && t3.config.standardCodePath === '' && t3.configLoaded === true, String(threw));
        check('坏 JSON 要留下 warn（静默吞掉的话用户以为配置没生效）',
            h3.warns().some((w) => w.includes('解析失败')), JSON.stringify(h3.warns()));

        const h4 = harness({ readThrows: true });
        const t4 = mkTask();
        await h4.methods.loadTaskConfig.call(h4.self, t4);
        check('文件不存在（首次使用）不抛异常，且不写任何东西',
            t4.config.standardCodePath === '' && h4.writes.length === 0 && t4.configLoaded === true);

        const h5 = harness({ fileContent: saved });
        const t5 = mkTask({ configLoaded: true });
        await h5.methods.loadTaskConfig.call(h5.self, t5);
        check('已加载过的任务不再读盘（切回来时不做无谓 IPC）',
            h5.reads.length === 0, JSON.stringify(h5.reads));

        const h6 = harness({ workspace: '' });
        const t6 = mkTask();
        await h6.methods.loadTaskConfig.call(h6.self, t6);
        check('没工作区时不读盘，但要把 configLoaded 置上（否则永远不许写）',
            h6.reads.length === 0 && t6.configLoaded === true, String(t6.configLoaded));
    }

    // ---- 写盘 ----
    {
        const h = harness();
        const t = mkTask({ configLoaded: false });
        h.methods.scheduleTaskConfigSave.call(h.self, t);
        h.flushTimers();
        await new Promise((r) => setImmediate(r));
        check('configLoaded 之前一律不写盘（启动瞬间不能拿默认值盖用户配置）',
            h.writes.length === 0, JSON.stringify(h.writes));

        const t2 = mkTask({ configLoaded: true });
        h.methods.scheduleTaskConfigSave.call(h.self, t2);
        h.methods.scheduleTaskConfigSave.call(h.self, t2);
        h.methods.scheduleTaskConfigSave.call(h.self, t2);
        h.flushTimers();
        await new Promise((r) => setImmediate(r));
        check('连点三次只写一次（clearTimeout 真的在清前一个定时器）',
            h.writes.length === 1, JSON.stringify(h.writes.map((w) => w.path)));
        check('写出去的是当前配置的序列化结果',
            JSON.parse(h.writes[0].content).compareCount === 100, h.writes[0].content.slice(0, 80));

        const other = mkTask({ key: 'd:/proj/b.cpp', configLoaded: true });
        h.methods.scheduleTaskConfigSave.call(h.self, t2);
        h.methods.scheduleTaskConfigSave.call(h.self, other);
        h.flushTimers();
        await new Promise((r) => setImmediate(r));
        check('不同任务的节流互不干扰（切文件时不会把上一份的写挤掉）',
            h.writes.length === 3 && h.writes.some((w) => /b\.cpp\.json$/.test(w.path)),
            JSON.stringify(h.writes.map((w) => w.path.split('/').pop())));

        const h4 = harness({ workspace: '' });
        const t4 = mkTask({ configLoaded: true });
        await h4.methods.writeTaskConfig.call(h4.self, t4);
        check('没工作区时 writeTaskConfig 直接返回，不发 writeFile',
            h4.writes.length === 0, JSON.stringify(h4.writes));
    }

    // ---- 视图偏好 ----
    {
        const store = {};
        const h = harness({ localStorage: store });
        const blank = h.methods.readCompareViewPrefs.call(h.self);
        check('首次使用（localStorage 空）返回空偏好而不是 undefined.blocks',
            blank && typeof blank.blocks === 'object' && Object.keys(blank.blocks).length === 0,
            JSON.stringify(blank));

        h.methods.setBlockCollapsed.call(h.self, 'cmp-block-io', true, true);
        const persisted = JSON.parse(store['oicpp.compare.viewState'] || '{}');
        check('用户手动折叠被记进 localStorage',
            persisted.blocks && persisted.blocks['cmp-block-io'] === true, store['oicpp.compare.viewState']);

        const before = store['oicpp.compare.viewState'];
        h.methods.setBlockCollapsed.call(h.self, 'cmp-block-io', false, false);
        check('自动展开（persist=false）不污染用户偏好',
            store['oicpp.compare.viewState'] === before, String(store['oicpp.compare.viewState']));

        const h2 = harness({ localStorage: { 'oicpp.compare.viewState': '{{{' } });
        const fallback = h2.methods.readCompareViewPrefs.call(h2.self);
        check('localStorage 里是坏 JSON 时退回空偏好，不抛（隐私模式/被别的扩展写坏）',
            fallback && typeof fallback.blocks === 'object' && Object.keys(fallback.blocks).length === 0,
            JSON.stringify(fallback));

        const h3 = harness({ localStorage: { 'oicpp.compare.viewState': JSON.stringify({ blocks: { 'cmp-block-files': true } }) } });
        h3.self.viewPrefs = h3.methods.readCompareViewPrefs.call(h3.self);
        h3.methods.applyCompareViewPrefs.call(h3.self);
        check('applyCompareViewPrefs 把存起来的开合状态落回 DOM',
            h3.ctx.document.getElementById('cmp-block-files').classList.contains('collapsed') === true);

        const h4 = harness({ localStorage: { 'oicpp.compare.viewState': JSON.stringify({ blocks: { 'cmp-block-files': 'yes' } }) } });
        h4.self.viewPrefs = h4.methods.readCompareViewPrefs.call(h4.self);
        h4.methods.applyCompareViewPrefs.call(h4.self);
        check('非布尔的脏偏好值被忽略，不把字符串当「折叠」状态',
            h4.ctx.document.getElementById('cmp-block-files').classList.contains('collapsed') === false);
    }

    console.log(`\ncompare-config-persistence: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
    process.exit(failures > 0 ? 1 : 0);
})().catch((e) => {
    console.error('[FAIL] 守卫自身异常:', e && e.stack || e);
    process.exit(1);
});
