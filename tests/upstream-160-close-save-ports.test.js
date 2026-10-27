'use strict';

// upstream 1.6.0-beta1 界面层批（3fda410）移植到 fork 后的守卫。
//
// 这一批里最容易静默失效的是「保存失败还告诉主进程可以关窗」：不抛错、不报裸 key、
// CI 其余部分照常绿，只有真在关闭时丢一次改动才显形。所以能真跑的都用真跑断言，
// 跑不了的（Electron 事件注册、主进程关窗时序）锁调用点上的形状。

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const preloadSource = read('src/preload.js');
const mainSource = read('src/main.js');
const initSource = read('src/renderer/js/init.js');
const tabsSource = read('src/renderer/js/tabs.js');
const titlebarSource = read('src/renderer/js/titlebar.js');
const terminalSource = read('src/renderer/js/terminal-panel.js');
const cloudSource = read('src/renderer/js/sidebar/cloudSync.js');

// ------------------------------------------------------- preload：on/once 返回取消函数
{
    const block = /contextBridge\.exposeInMainWorld\('electronIPC', \{[\s\S]*?\n\}\);/.exec(preloadSource);
    check('抽取到 electronIPC 暴露块', !!block, String(block && block[0].length));
    if (block) {
        const listeners = [];
        const ipcRenderer = {
            on: (ch, fn) => { listeners.push({ ch, fn }); },
            once: (ch, fn) => { listeners.push({ ch, fn }); },
            removeListener: (ch, fn) => {
                const i = listeners.findIndex((l) => l.ch === ch && l.fn === fn);
                if (i >= 0) listeners.splice(i, 1);
            }
        };
        const src = block[0]
            .replace("contextBridge.exposeInMainWorld('electronIPC', ", '')
            .replace(/\}\);$/, '}');
        const build = new Function('ipcRenderer', 'safeIpcRenderer', 'ALLOWED_EVENT_CHANNELS', 'console',
            `return (${src});`);
        const api = build(ipcRenderer, { noop: () => { } }, new Set(['file-saved']), { warn: () => { } });

        const off = api.on('file-saved', () => { });
        check('on() 返回取消函数（返回 EventEmitter 的话调用方移不掉包装）',
            typeof off === 'function', typeof off);
        check('file-saved 走的是包装后的 listener', listeners.length === 1);
        if (typeof off === 'function') off();
        check('取消函数确实把 listener 摘掉了', listeners.length === 0, JSON.stringify(listeners.map((l) => l.ch)));

        const offOnce = api.once('compile-result', () => { });
        if (typeof offOnce === 'function') offOnce();
        check('once() 同样可取消且非白名单通道被拒',
            listeners.length === 0 && api.on('evil-channel', () => { }) === undefined);
    }

    const sendSet = /const ALLOWED_SEND_CHANNELS = new Set\(\[([\s\S]*?)\]\);/.exec(preloadSource);
    check('save-all-failed 在 send 白名单里',
        !!sendSet && /'save-all-failed'/.test(sendSet[1]), String(sendSet && sendSet[1].length));
    check('electronAPI 暴露 notifySaveAllFailed',
        /notifySaveAllFailed:/.test(preloadSource));
}

// ------------------------------------------------ 主进程：超时与失败都不许关窗
{
    const body = /function requestSaveAllAndClose\(context = [^\n]*\{[\s\S]*?\n\}/.exec(mainSource);
    check('抽取到 requestSaveAllAndClose 正文', !!body, String(body && body[0].length));
    if (body) {
        const src = body[0];
        check('注册了 save-all-failed 监听并成对摘除',
            /ipcMain\.once\('save-all-failed', onFailed\)/.test(src)
            && /removeListener\('save-all-failed', onFailed\)/.test(src));
        check('超时分支不再关窗（宁可开着也不丢未保存改动）',
            !/保存超时，强制关闭窗口/.test(src)
            && /等待保存完成超时，窗口保持打开/.test(src)
            && !/closeWindow\(\);\s*\n\s*\}, SAVE_ALL_TIMEOUT\)/.test(src));
        check('失败分支不关窗，只记一条 warn',
            /保存失败，已取消关闭/.test(src)
            && /const onFailed = \(\) => \{[\s\S]*?\n    \};/.test(src));
        check('发送请求失败这类硬错误仍然直接关窗（不能把兜底也去掉）',
            /发送保存请求失败，直接关闭:[\s\S]*closeWindow\(\)/.test(src));
    }
}

// -------------------------------------- 渲染层：失败时 notifySaveAllFailed 而不是 complete
{
    const block = /window\.electronAPI\.onRequestSaveAll\(async \(\) => \{[\s\S]*?\n\s*\}\);/.exec(initSource);
    check('抽取到 onRequestSaveAll 回调', !!block, String(block && block[0].length));
    if (block) {
        const src = block[0];
        check('消费 saveAllFiles 的返回值而不是丢弃', /result = \(await/.test(src));
        check('success === false 时走 notifySaveAllFailed',
            /result\.success === false[\s\S]*notifySaveAllFailed/.test(src));
        check('只有成功才 notifySaveAllComplete（finally 写法失败也会报完成）',
            !/finally \{[\s\S]*notifySaveAllComplete/.test(src)
            && /else \{\s*window\.electronAPI\.notifySaveAllComplete\(\)/.test(src));
        check('失败提示走 i18n 键（不硬编码中文）',
            /_t\('dialog\.saveFailedIntro'/.test(src) && /_t\('dialog\.saveFailedTitle'/.test(src));
    }
}

// ----------------------------------------------- titlebar：占位必须在所有 await 之前
{
    const body = /async _requestCloseInternal\([\s\S]*?\n    \}\s*\n    async _confirmTemporaryFilesBeforeClose/.exec(titlebarSource);
    check('抽取到 _requestCloseInternal 正文', !!body, String(body && body[0].length));
    if (body) {
        const src = body[0];
        const flagSet = src.indexOf('this._closeConfirmInProgress = true;');
        const firstAwait = src.search(/await window\.oicppApp\.saveCurrentOpenTabs|await this\._confirmTemporaryFilesBeforeClose/);
        check('进函数就占位，早于任何 await', flagSet > 0 && firstAwait > flagSet,
            JSON.stringify({ flagSet, firstAwait }));
        check('三条提前 return 都被同一个 finally 覆盖',
            /finally \{\s*this\._closeConfirmInProgress = false;/.test(src)
            && (src.match(/return;/g) || []).length >= 3
            && src.lastIndexOf('finally') > src.lastIndexOf('return;'));
    }
}

// ----------------------------------------- tabs.saveAllFiles：未命名标签与无桥都不许静默
{
    const method = /(\n    async saveAllFiles\(\) \{[\s\S]*?\n    \})\s*\n    openFileDialog\(\) \{/.exec(tabsSource);
    check('抽取到 saveAllFiles 方法体', !!method, String(method && method[0].length));
    const objSrc = method ? method[1] : '';
    const run = async ({ tabs, api }) => {
        const seen = { saved: [], marked: [], saveAsCalls: 0 };
        const manager = {
            tabs: new Map(tabs),
            isDiscardCloseInProgress: () => false,
            getTabContentForSave: () => 'body',
            markTabAsSavedByUniqueKey: (k) => seen.marked.push(k),
            updateTabPathBySource: (oldPath, newPath, newFileName, targetUniqueKey) => { seen.rebound = [oldPath, newPath, newFileName, targetUniqueKey]; },
            electronApiHint: null
        };
        global.window = {
            logWarn: () => { },
            console: console,
            electronAPI: api(seen),
            oicppApp: null
        };
        const fnObj = new Function(`return {${objSrc}}`)();
        const result = await fnObj.saveAllFiles.call(manager);
        return { seen, result, manager };
    };

    (async () => {
        // 未命名标签 + 有 saveAs：应当真的另存、重新绑定路径、标记已保存
        {
            const { seen, result } = await run({
                tabs: [['k1', { filePath: null, fileName: 'untitled.cpp', viewType: 'code' }]],
                api: (s) => ({
                    saveFile: async (p) => { s.saved.push(p); return true; },
                    saveAsFile: async () => { s.saveAsCalls++; return 'D:/p/saved.cpp'; }
                })
            });
            // save-as-file 的主进程 handler 已经落盘，这里再调一次 saveFile 就是把同一个
            // 文件写两遍（并多一次 file-saved 广播），所以另存之后不该再有第二次写。
            check('未命名标签走另存而不是静默跳过',
                seen.saveAsCalls === 1 && seen.saved.length === 0 && seen.marked.includes('D:/p/saved.cpp'),
                JSON.stringify({ saved: seen.saved, marked: seen.marked }));
            check('换绑与标记落在同一个标签上',
                seen.marked.length === 1 && !seen.marked.includes('k1'),
                JSON.stringify(seen.marked));
            check('另存后重新绑定标签路径，并点名是哪一个未命名标签',
                JSON.stringify(seen.rebound) === JSON.stringify([null, 'D:/p/saved.cpp', null, 'k1']),
                JSON.stringify(seen.rebound));
            check('全部成功时返回 success:true', result && result.success === true, JSON.stringify(result));
        }

        // 未命名标签 + 用户在保存框里取消（saveAsFile 返回空）：算失败，不算已保存
        {
            const { seen, result } = await run({
                tabs: [['k1', { filePath: null, fileName: 'untitled.cpp', viewType: 'code' }]],
                api: () => ({ saveFile: async () => true, saveAsFile: async () => '' })
            });
            check('取消另存记为失败且不标记已保存',
                seen.marked.length === 0 && result.success === false && result.failures.length === 1,
                JSON.stringify(result));
        }

        // 没有 saveFile 桥：原先直接标记已保存（磁盘却什么都没写）
        {
            const { seen, result } = await run({
                tabs: [['k1', { filePath: 'D:/p/a.cpp', fileName: 'a.cpp', viewType: 'code' }]],
                api: () => ({})
            });
            check('无 saveFile 桥时如实报失败',
                seen.marked.length === 0 && result.success === false
                && !!result.failures[0].error, JSON.stringify(result));
        }

        // 主进程回 {success:false}（不抛错）也要算失败：只看 Promise reject 会漏掉这条
        {
            const { seen, result } = await run({
                tabs: [['k1', { filePath: 'D:/p/a.cpp', fileName: 'a.cpp', viewType: 'code' }]],
                api: () => ({ saveFile: async () => ({ success: false, error: 'disk full' }) })
            });
            check('saveFile 返回体里的 success:false 也被识别',
                seen.marked.length === 0 && result.success === false
                && String(result.failures[0].error).includes('disk full'), JSON.stringify(result));
        }
    })().catch((e) => check('saveAllFiles 用例整体跑通', false, String(e && e.stack)));
}

// ----------------------------------------- updateTabPathBySource：分组内 tabOrder 一起迁移
{
    const groupLoop = /for \(const group of this\.groups\.values\(\)\) \{[\s\S]*?\n                \}/.exec(tabsSource);
    check('分组同步里带上 tabOrder（漏了它分组内的顺序指向已删除的 key）',
        !!groupLoop && /group\.tabOrder\.indexOf\(actualOldKey\)/.test(groupLoop[0])
        && /group\.tabOrder\[idx\] = newKey/.test(groupLoop[0]), String(groupLoop && groupLoop[0]));
    check('换路径后同步分组标签', /if \(tabData\.groupId\)\s*this\.syncGroupTabs\(tabData\.groupId\)/.test(tabsSource));
}

// -------------------------------------------------- cloudSync：路径前缀与空内容
{
    const method = /getRelativeLocalPath\(filePath, rootPath\) \{[\s\S]*?\n    \}/.exec(cloudSource);
    check('抽取到 getRelativeLocalPath', !!method, String(method && method[0].length));
    if (method) {
        const fn = new Function(`return { ${method[0]} , normalizeLocalPath: (p) => String(p || '').replace(/\\\\/g, '/').replace(/\\/+$/, '') };`)();
        check('兄弟目录不再被当成子目录（proj-evil 不是 proj/）',
            fn.getRelativeLocalPath('/ws/proj-evil/a.cpp', '/ws/proj') === '',
            JSON.stringify(fn.getRelativeLocalPath('/ws/proj-evil/a.cpp', '/ws/proj')));
        check('真子目录仍然正常取相对路径',
            fn.getRelativeLocalPath('/ws/proj/sub/a.cpp', '/ws/proj') === 'sub/a.cpp',
            fn.getRelativeLocalPath('/ws/proj/sub/a.cpp', '/ws/proj'));
        check('rootPath 为空返回空而不是恒真 startsWith',
            fn.getRelativeLocalPath('/ws/a.cpp', '') === '');
    }
    const guards = cloudSource.match(/typeof data\?\.content !== 'string'/g) || [];
    check('云端返回非字符串内容时抛错（openCloudFile 与 downloadFile 两处）', guards.length >= 2,
        String(guards.length));
    check('抛的是 i18n 键而不是硬编码中文', /cloud\.dataFormatError/.test(cloudSource));
}

// ---------------------------------------------------------- 零散但有实害的三处
{
    check('Shift+Tab 发的是 CSI Z，不再多带一个右括号',
        /const seq = shift \? '\\x1b\[Z' : '\\t';/.test(terminalSource)
        && !/\\u001b\[Z\]/.test(terminalSource));

    const editorSource = read('src/renderer/settings/editor.js');
    check('字号写入前有 Number.isFinite 且 > 0 校验',
        (editorSource.match(/Number\.isFinite\(parsed(?:Terminal)?FontSize\) && parsed(?:Terminal)?FontSize > 0/g) || []).length === 2);
    check('编辑器内不再抢 Ctrl+K（Monaco 的按键序列前缀）',
        !/case 'k':\s*\n\s*e\.preventDefault\(\);\s*\n\s*this\.openFolder\(\);/.test(read('src/renderer/js/main.js'))
        || (read('src/renderer/js/main.js').match(/case 'k':/g) || []).length === 1,
        String((read('src/renderer/js/main.js').match(/case 'k':/g) || []).length));

    const monacoSource = read('src/renderer/js/monaco-editor-manager.js');
    // 1.6 移植批把落盘从「send + file-saved 事件对」换成 invoke：调用方能拿到成败，
    // 监听器泄漏从根上没了（原来 removeListener(handleFileSaved) 移不掉那层包装）。
    check('monaco.saveFile 走 invoke 并返回 {success}',
        /await window\.electronAPI\.saveFile\(filePath, content\)/.test(monacoSource)
        && !/electronIPC\.send\('save-file'/.test(monacoSource)
        && /return \{ success: true \};/.test(monacoSource), '');
    check('markFileSaved 优先按路径 uniqueKey 标记（同名不同目录不能互相冒领）',
        /markTabAsSavedByUniqueKey\(key\)/.test(monacoSource));
}

// --------------------------------------------------------------- 语言包双语齐备
{
    const zh = JSON.parse(read('src/lang/zh-cn.json'));
    const en = JSON.parse(read('src/lang/en.json'));
    const keys = ['dialog.saveFailedTitle', 'dialog.saveFailedIntro', 'dialog.saveFailedItem',
        'dialog.saveUnnamedFile', 'dialog.saveUnknownError', 'dialog.saveApiUnavailable',
        'dialog.saveNoLocation', 'dialog.saveWriteFailed', 'dialog.cloudSaveFailed',
        'cloud.dataFormatError'];
    const pick = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    const tokens = (s) => (String(s).match(/\{[a-zA-Z_]+\}/g) || []).sort().join(',');
    for (const key of keys) {
        const a = pick(zh, key), b = pick(en, key);
        check(`${key} 双语齐备且占位符一致`,
            typeof a === 'string' && typeof b === 'string' && tokens(a) === tokens(b),
            JSON.stringify({ zh: a, en: b }));
    }
}

setTimeout(() => {
    console.log(`\nupstream 1.6.0-beta1 界面层移植 tests completed: ${failures === 0 ? 'all checks passed' : failures + ' FAILED'}`);
    process.exitCode = failures === 0 ? 0 : 1;
}, 400);
