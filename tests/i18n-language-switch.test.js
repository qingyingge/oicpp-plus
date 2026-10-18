'use strict';

// 覆盖「语言切换写了盘但界面不生效」这条链路。
//
// 根因不是翻译缺失，而是**通知链断了**：所有设置页保存都走
// ipcMain.handle('update-settings')，它只落盘 + 发 settings-applied，
// 没有 setLanguage、没有 createMenuBar、没有 language-changed。
// 真正带语言广播的那段逻辑原本只存在于 updateSettings() 里，而它唯一的
// 入口是设置页里 `if (!result && ...)` 的兜底分支 —— electronAPI 已成功
// 返回时永远进不去，即死代码。症状是：日志里能看到「保存成功」，界面却
// 要重开窗口才变语言。
//
// 静态测试抓不到运行时时序，但能钉住「哪些入口必须调 applyLanguageChange」
// 这条契约：新增任何改动 settings.language 的入口而忘了调用它，CI 即红。

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const i18nSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'i18n.js'), 'utf8');

// ---------------------------------------------------------------------------
// 0. helper 本身
// ---------------------------------------------------------------------------

{
    const fnMatch = mainSource.match(/async function applyLanguageChange\s*\(([\s\S]*?)\n\}/);
    check('applyLanguageChange 存在', !!fnMatch);
    const body = fnMatch ? fnMatch[0] : '';
    // 注释里也提到 createMenuBar()/setLanguage，比较执行顺序前先剥掉注释，
    // 否则匹配到的是注释里的那个 createMenuBar
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    check(
        '先 await setLanguage 再 createMenuBar',
        code.indexOf('await setLanguage') !== -1 &&
            code.indexOf('await setLanguage') < code.indexOf('createMenuBar'),
        '未 await 时菜单栏会用旧语言重建'
    );

    // 主窗口也在广播目标里：原死路径只发给 4 个设置窗口，唯独漏掉主窗口，
    // 而主窗口才是用户盯着看的那个。
    for (const win of ['mainWindow', 'editorSettingsWindow', 'compilerSettingsWindow', 'codeTemplatesWindow', 'backupSettingsWindow']) {
        check(`广播目标含 ${win}`, body.includes(win));
    }

    check('广播 language-changed 通道', body.includes("'language-changed'"));
    check('窗口存活判断用 isDestroyed()', body.includes('isDestroyed()'));
    // importSettings 是同步函数，只能 fire-and-forget 调用本 helper
    check('整体 try/catch 兜底（fire-and-forget 不得产生未处理 rejection）', /try\s*\{[\s\S]*await setLanguage[\s\S]*\}\s*catch/.test(body));
}

// ---------------------------------------------------------------------------
// 1. 每个改动 settings.language 的入口都必须调用它
// ---------------------------------------------------------------------------

{
    // 顶层函数声明都在第 0 列。切分时不能用 \s*：它会吃掉换行，
    // 让正则匹配到上一行行尾的 \n，切出来的「函数体」只有两个字符。
    const sliceFn = (name) => {
        const start = mainSource.search(new RegExp(`(^|\\n)(?:async )?function ${name}\\s*\\(`));
        if (start === -1) return null;
        const next = mainSource.slice(start + 1).search(/\n(?:async )?function \w+\s*\(/);
        return next === -1 ? mainSource.slice(start) : mainSource.slice(start, start + 1 + next);
    };

    // 'language' 会随这些入口一起落到 settings 上
    const entries = [
        { fn: 'resetSettings', why: "'language' 在 getResettableSettingsKeys() 里，重置会改回默认语言" },
        { fn: 'importSettings', why: "'language' 在 importSettings 的 validKeys 里" },
        { fn: 'syncSettingsFromCloud', why: '整份 settings 被云端数据覆盖，含 language' }
    ];

    for (const { fn, why } of entries) {
        const body = sliceFn(fn);
        check(`${fn} 找到`, !!body, why);
        if (body) {
            check(`${fn} 调用了 applyLanguageChange`, body.includes('applyLanguageChange'), why);
        }
    }
}

// ---------------------------------------------------------------------------
// 2. update-settings handler：活路径必须广播
// ---------------------------------------------------------------------------

{
    const start = mainSource.indexOf("ipcMain.handle('update-settings'");
    check("ipcMain.handle('update-settings') 存在", start !== -1);
    const body = mainSource.slice(start, mainSource.indexOf('\n});', start));

    check('handler 内调用 applyLanguageChange', body.includes('applyLanguageChange'));

    // 语言必须在合并**之前**取旧值：合并后 settings.language 已是新值，
    // prevLanguage 会等于新值，helper 直接 return，广播被静默吞掉。
    const prevIdx = body.indexOf('prevLanguage');
    const mergeIdx = body.search(/settings\s*=\s*\{\s*\.\.\.settings/);
    check('在合并前捕获 prevLanguage', prevIdx !== -1 && mergeIdx !== -1 && prevIdx < mergeIdx,
        `prevLanguage@${prevIdx} merge@${mergeIdx}`);

    check('handler 已声明为 async（要 await helper）',
        /\n\s*ipcMain\.handle\('update-settings',\s*async\s*\(/.test(mainSource));
}

// ---------------------------------------------------------------------------
// 3. IPC 通道两端对齐：白名单 + 渲染层监听
// ---------------------------------------------------------------------------

{
    // 白名单只在 preload.js（形如 new Set([...])），主进程发送侧不走它
    const preloadChannels = preloadSource.match(/ALLOWED_EVENT_CHANNELS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    check('preload.js 有 ALLOWED_EVENT_CHANNELS', !!preloadChannels);
    check("preload.js 白名单含 'language-changed'",
        !!preloadChannels && preloadChannels[1].includes("'language-changed'"),
        '渲染层收不到语言变更事件 —— 这正是本次故障的第二道断点');

    // 渲染层两个入口都要在：主窗口听 language-changed，设置窗口靠 preload 包装
    check('i18n.js 监听 onLanguageChanged', /onLanguageChanged\s*\(/.test(i18nSource));
    check('preload.js 导出 onLanguageChanged', /onLanguageChanged\s*[:(]/.test(preloadSource));
}

// ---------------------------------------------------------------------------
// 4. 渲染层重渲染钩子：必须避开 _applyToDOM 的覆盖
// ---------------------------------------------------------------------------

{
    // i18n.js 的 languageChanged 回调里是「先 _notifyListeners()，后
    // _applyToDOM()」。同步钩子会被随后同步执行的 _applyToDOM 覆写回
    // data-i18n-title 的静态文案（#maximize-btn、#lsp-status-item、
    // #marker-summary-item 都中招），所以钩子必须延后一拍。
    const notifyIdx = i18nSource.indexOf('this._notifyListeners();');
    const domIdx = i18nSource.indexOf('this._applyToDOM();');
    check('i18n 先 _notifyListeners 后 _applyToDOM', notifyIdx !== -1 && notifyIdx < domIdx);

    const hooks = [
        { file: 'src/renderer/js/titlebar.js', why: '#maximize-btn 的 title 是 JS 写的' },
        { file: 'src/renderer/js/terminal-panel.js', why: '终端标签页与空状态是 JS 写的' },
        { file: 'src/renderer/js/tabs.js', why: '欢迎页整页由 t() 写 innerHTML' },
        { file: 'src/renderer/js/main.js', why: '状态栏 / 账号菜单 / 调试按钮 title 由 JS 写' }
    ];

    for (const { file, why } of hooks) {
        const src = fs.readFileSync(path.join(ROOT, ...file.split('/')), 'utf8');
        const hasEvent = src.includes("'i18n-language-changed'");
        check(`${path.basename(file)} 监听 i18n-language-changed`, hasEvent, why);

        // 取钩子附近一小段，要求有 setTimeout 退避
        const idx = src.indexOf("'i18n-language-changed'");
        const around = src.slice(idx, idx + 400);
        check(`${path.basename(file)} 钩子延后一拍（避开 _applyToDOM）`,
            around.includes('setTimeout'), why);
    }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
