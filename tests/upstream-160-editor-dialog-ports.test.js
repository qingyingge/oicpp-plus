'use strict';

// upstream 1.6.0-beta1 编辑器/对话框/i18n 批（be24056 + 7787937）移植后的守卫。
//
// 这一批里两条最容易被「看起来修好了」骗过：对话框转义（漏一处就是渲染进程 XSS）
// 与保存状态标记（标早了就是静默丢改动）。所以能真跑的全是抽出来真调的。

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const dialogSource = read('src/renderer/js/dialog.js');
const tabsSource = read('src/renderer/js/tabs.js');
const monacoSource = read('src/renderer/js/monaco-editor-manager.js');
const mainSource = read('src/main.js');
const explorerSource = read('src/renderer/js/sidebar/fileExplorer.js');
const quickOpenSource = read('src/renderer/js/quick-open.js');
const i18nSource = read('src/renderer/js/i18n.js');

const methodOf = (src, name) => {
    const m = new RegExp(`\\n    (?:async )?${name}\\((?:[^)]*)\\) \\{[\\s\\S]*?\\n    \\}(?=\\n\\s*(?:/\\*|async |[A-Za-z_$]|\\}))`).exec(src);
    return m ? m[0] : '';
};

// ------------------------------------------------------------- 对话框转义
{
    const escapeHtml = methodOf(dialogSource, 'escapeHtml');
    const escapeAttr = methodOf(dialogSource, 'escapeAttribute');
    const formatMsg = methodOf(dialogSource, 'formatMessage');
    check('dialog 里有 escapeHtml / escapeAttribute / formatMessage',
        escapeHtml.length > 0 && escapeAttr.length > 0 && formatMsg.length > 0);

    let doc;
    const obj = new Function(`
        const document = arguments[0];
        return { ${[escapeHtml, escapeAttr, formatMsg].join(',\n')} };
    `);
    doc = { createElement: () => { const d = { _t: '', set textContent(v) { this._t = String(v); }, get innerHTML() { return this._t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }; return d; } };
    const dlg = obj(doc);

    const evil = '<img src=x onerror=alert(1)>';
    const esc = dlg.escapeHtml(evil);
    check('escapeHtml 把标签彻底转义', !esc.includes('<img') && esc.includes('&lt;img'), esc);
    const attr = dlg.escapeAttribute(`a" onfocus="alert(1)`);
    check('escapeAttribute 连引号一起封掉（placeholder 就是这么被撕开标签的）',
        !attr.includes('"') || attr.includes('&quot;'), attr);

    const fmt = dlg.formatMessage(`第一行\n第二行 <script>alert(2)</script>`);
    check('formatMessage 把 \\n 变成 <br>', /第一行<br>第二行/.test(fmt), fmt);
    check('formatMessage 不许放过 <script>', !fmt.includes('<script>'), fmt);
    const brKeep = dlg.formatMessage('检测到 2 个未保存文件：<br>- a.cpp');
    check('语言包里的 <br> 仍然放行（否则关闭确认会挤成一行）',
        brKeep.includes('<br>') && brKeep.includes('a.cpp'), brKeep);
    const doubleEsc = dlg.formatMessage('- a&amp;b.cpp<br>');
    check('已经转义过的内容会被二次转义 —— 所以调用侧不该再自己转',
        doubleEsc.includes('&amp;amp;'), doubleEsc);

    check('showConfirmDialog / showActionDialog 的 title 与 message 都走转义',
        (dialogSource.match(/<h3>\$\{this\.escapeHtml\(String\(title/g) || []).length >= 2
        && (dialogSource.match(/<p>\$\{this\.formatMessage\(message\)/g) || []).length >= 2);
    check('showInputDialog 的 defaultValue 不再拼进 value 属性',
        /value=""[^>]*\/>/.test(dialogSource) && /input\.value = String\(defaultValue \?\? ''\)/.test(dialogSource));

    // 调用侧不许再自己转义（双转义会把 a&b 显示成 a&amp;b）
    check('titlebar 不再预转义交给对话框的文件名', !/_escapeHtml\(name\)/.test(read('src/renderer/js/titlebar.js')));
    check('tabs 关闭确认不再预转义', !/const safeName = escapeHtml\(tabData\.fileName/.test(tabsSource));
}

// -------------------------------------- 目录级操作后标签路径必须整批跟上
{
    const m = methodOf(tabsSource, 'updateTabPathsUnderDirectory');
    check('抽取到 updateTabPathsUnderDirectory', m.length > 0);
    if (m) {
        const obj = new Function(`return { ${m.replace(/^\n    /, '')} };`)();
        const calls = [];
        const self = {
            tabs: new Map([
                ['/ws/a/x.cpp', { filePath: '/ws/a/x.cpp' }],
                ['/ws/a/sub/y.cpp', { filePath: '/ws/a/sub/y.cpp' }],
                ['/ws/b/z.cpp', { filePath: '/ws/b/z.cpp' }],
                ['/ws/a2/w.cpp', { filePath: '/ws/a2/w.cpp' }]
            ]),
            updateTabPathBySource: (oldPath, newPath, newName) => calls.push([oldPath, newPath, newName])
        };
        obj.updateTabPathsUnderDirectory.call(self, '/ws/a', '/ws/a-renamed');
        check('目录下的每个标签都换到新路径',
            calls.length === 2 && calls.some((c) => c[1] === '/ws/a-renamed/x.cpp')
            && calls.some((c) => c[1] === '/ws/a-renamed/sub/y.cpp'),
            JSON.stringify(calls));
        check('兄弟目录 /ws/a2 不被误伤（缺分隔符的前缀匹配）',
            !calls.some((c) => String(c[0]).startsWith('/ws/a2')), JSON.stringify(calls));
        check('带上新的文件名', calls.every((c) => typeof c[2] === 'string' && c[2].length > 0), JSON.stringify(calls));
    }

    check('剪切目录走整批更新，重命名目录同样',
        /updateTabPathsUnderDirectory\(sourcePath, destPath\)/.test(explorerSource)
        && /updateTabPathsUnderDirectory\(oldPath, newPath\)/.test(explorerSource));
    check('删除目录时关掉其下所有标签', /this\._closeTabsUnderPath\(file\.path\)/.test(explorerSource));
    check('粘贴目录到自身/子目录被拒', /pasteIntoSelfForbidden/.test(explorerSource));
    check('主进程 copyDirectorySync 也挡住自我递归（渲染层被绕过时兜底）',
        /function copyDirectorySync\(src, dest\) \{[\s\S]{0,400}copyFolderIntoSelf/.test(mainSource));
}

// ------------------------------------------- 保存状态：成功才许标记已保存
{
    const saveFile = methodOf(tabsSource, 'saveFile');
    check('tabs.saveFile 是 async', /^\n    async saveFile\(/.test(saveFile), String(saveFile.slice(0, 60)));
    check('标记时机在 await 之后（原先第一件事就是 modified=false）',
        saveFile.indexOf('await this.monacoEditorManager') < saveFile.indexOf('markTabAsSaved')
        && !/tab\.modified = false;\s*\n\s*this\.refreshTabLabels\(\);\s*\n\s*\n?\s*if \(this\.monacoEditorManager\)/.test(saveFile));
    check('monaco 报 success:false 时不标记，返回 false',
        /result && result\.success === false/.test(saveFile) && /return false;/.test(saveFile));

    const msf = methodOf(monacoSource, 'saveFile');
    check('monaco.saveFile 用 invoke 拿真实结果（不再 send 完就撒手）',
        /electronAPI\.saveFile\(filePath, content\)/.test(msf) && !/electronIPC\.send\('save-file'/.test(msf));

    const saveCur = methodOf(tabsSource, 'saveCurrentEditorContent');
    check('外部改过的文件跳过切标签前的自动保存（否则覆盖外部改动）',
        /externalModified/.test(saveCur) && /跳过切标签前的自动保存/.test(saveCur));

    const diff = methodOf(monacoSource, 'createDiffEditor');
    check('diff 模型不再占用真实文件 URI（会和已打开的编辑器撞 URI）',
        !/monaco\.Uri\.file\(originalPath\)/.test(diff)
        && /inmemory:\/\/diff\/\$\{tabId\}\/original/.test(diff));
    check('diff 创建失败回滚容器与三份资源',
        /catch \(error\) \{[\s\S]*diffEditor\.dispose\(\)[\s\S]*originalModel\.dispose\(\)[\s\S]*modifiedModel\.dispose\(\)[\s\S]*removeChild\(container\)/.test(diff));

    const tpl = methodOf(tabsSource, 'createFileFromTemplate');
    check('模板创建后真的打开文件（原先算完 tabId 就结束）',
        /this\.openFile\(fileName, content, true\)/.test(tpl) && !/兜底旧逻辑/.test(tpl));
}

// ------------------------------------------------------- quick-open 列表一致性
{
    check('截断发生在 lastList 上（render 与键盘导航同一份）',
        /lastList = ranked\.slice\(0, 200\)/.test(quickOpenSource)
        && !/list\.slice\(0, 200\)\.forEach/.test(quickOpenSource));
    check('空查询也走同一份截断列表', /lastList = allFiles\.slice\(0, 100\)/.test(quickOpenSource));
    check('导航不再回落到未渲染的 allFiles',
        !/lastList\.length \? lastList : allFiles/.test(quickOpenSource));
}

// -------------------------------- 主窗口标题：页面 <title> 不许覆盖，且跟着语言走
{
    check('设置子窗口压住 page-title-updated 并在加载完成后按当前语言 setTitle',
        /function lockSettingsWindowTitle\([\s\S]*?page-title-updated[\s\S]*?did-finish-load/.test(mainSource));
    const locked = (mainSource.match(/lockSettingsWindowTitle\((compilerSettingsWindow|editorSettingsWindow|codeTemplatesWindow|backupSettingsWindow)/g) || []).length;
    check('四个设置窗口都上了锁', locked === 4, String(locked));
    check('切换语言时重发子窗口标题（preventDefault 之后页面那条链路就断了）',
        /applyLanguageChange[\s\S]*?settingsWindowTitleKeys\.get[\s\S]*?setTitle/.test(mainSource));
}

// ------------------------------------------------ i18n 应用到 DOM 时保留子元素
{
    check('_applyToDOM 对含子元素的节点只改文本节点',
        /el\.children\.length === 0/.test(i18nSource)
        && /nodeType === 3/.test(i18nSource)
        && /target\.nodeValue = text/.test(i18nSource));
    check('保留 data-i18n-args 的插值解析', /data-i18n-args/.test(i18nSource));
}

console.log(`\nupstream 1.6.0-beta1 编辑器/对话框移植 tests completed: ${failures === 0 ? 'all checks passed' : failures + ' FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
