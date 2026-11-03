// 无头 Electron 冒烟：在真实 Chromium + 真实 file:// + 真实 CSP 下验证渲染层 i18n。
// 覆盖 vm 测试完全验证不到的路径：<script src="../../node_modules/..."> 能否被 CSP 放行、
// 相对路径能否解析、界面 DOM 实际文案是什么。旧 ci-local.ps1 因泄漏 electron 进程被删，
// 这个脚本自带超时与 app.quit，不依赖外部 kill。
//
// 手动运行（**故意不叫 *.test.js** —— run-tests.js 只发现 *.test.js，
// 而没装 electron 二进制的机器跑不了它，混进回归套件会直接让 CI 变红）：
//   xvfb-run -a node_modules/electron/dist/electron tests/smoke-electron.js --no-sandbox
//   （root 环境必须 --no-sandbox；无显示环境需要 xvfb-run）
//
// 为什么必须有它：i18next UMD 的 AMD 分支击穿只有真实 Chromium 才复现 ——
// 详见 tests/i18n-renderer-runtime.test.js 的 0c 组注释。
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
// 6 个窗口各起一个真实 Chromium，实测约 9s/窗口 → 54s 起步。45s 会在负载稍高时
// 必然超时并误报失败（踩过：连续两次都只跑到第 5 个窗口就被 app.exit(3) 砍掉）。
// 给足余量，宁可慢，不要假红。
const TIMEOUT_MS = 240000;

// 6 个加载 js/i18n.js 的窗口
const WINDOWS = [
    { name: 'index', file: 'index.html' },
    { name: 'pdf-viewer', file: 'pdf-viewer.html' },
    { name: 'settings-backup', file: 'settings/backup.html' },
    { name: 'settings-compiler', file: 'settings/compiler.html' },
    { name: 'settings-editor', file: 'settings/editor.html' },
    { name: 'settings-templates', file: 'settings/templates.html' },
];

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const consoleErrors = [];
const pageErrors = [];

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

function attach(win, label) {
    win.webContents.on('console-message', (e) => {
        // Electron 37+ 传事件对象 {level, message, lineNumber, sourceId}；
        // 老版本传 (level, message, line, sourceId)。两种都要收。
        const level = typeof e === 'object' && e !== null ? e.level : 0;
        const msg = typeof e === 'object' && e !== null ? e.message : String(e);
        if (level >= 1) consoleErrors.push(`[${label}] L${level} ${msg}`);
    });
    win.webContents.on('render-process-gone', (_e, d) => {
        pageErrors.push(`[${label}] render-process-gone: ${JSON.stringify(d)}`);
    });
    win.webContents.on('preload-error', (_e, p, err) => {
        pageErrors.push(`[${label}] preload-error ${p}: ${err && err.message}`);
    });
}

app.whenReady().then(async () => {
    // 统计 CSP 违规与失败资源加载
    const blocked = [];
    session.defaultSession.webRequest.onErrorOccurred((d, _r, res) => {
        blocked.push(`${d} ${res.url}`);
    });

    const win = new BrowserWindow({
        width: 1400, height: 900, show: false,
        webPreferences: {
            preload: path.join(__dirname, 'smoke-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    attach(win, 'index');

    const target = path.join(RENDERER, 'index.html');
    console.log(`加载 ${target}`);
    await win.loadFile(target);
    // 真实渲染里 i18n.init() 是 async，等它落地
    await new Promise((r) => setTimeout(r, 4000));

    // 专门诊断：base URI / 动态加载那个 URL / CSP 是否放行
    const diag = await win.webContents.executeJavaScript(`(async () => {
      const d = {};
      d.href = location.href;
      d.baseURI = document.baseURI;
      d.origin = String(location.origin);
      const url = new URL('../../node_modules/i18next/dist/umd/i18next.min.js', document.baseURI).href;
      d.resolvedUrl = url;
      try {
        const r = await fetch(url);
        d.fetchStatus = r.status;
        d.fetchBytes = (await r.text()).length;
      } catch (e) { d.fetchError = String(e); }
      // 用动态 script 元素加载，看是否被 CSP 拒绝
      d.dynamic = await new Promise((res) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = () => res('onload');
        s.onerror = (e) => res('onerror');
        document.head.appendChild(s);
        setTimeout(() => res('timeout'), 3000);
      });
      d.i18nextAfterDynamic = typeof i18next;
      // 关键：UMD 分支判定依赖这两个全局。若被垫片定义了 module/exports，
      // UMD 会走 CommonJS 分支 module.exports=t()，完全不挂 window。
      d.hasModule = typeof module;
      d.hasExports = typeof exports;
      d.hasDefine = typeof define;
      d.moduleKeys = (typeof module !== 'undefined' && module) ? Object.keys(module).slice(0, 8) : null;
      d.exportsType = typeof exports;
      d.windowI18n = typeof window.i18n;
      d.defineIsFn = typeof define === 'function';
      d.defineAmd = (typeof define === 'function') ? typeof define.amd : 'no-define';
      // 哪个 script 定义的 define
      d.defineSource = (() => {
        try { return String(define).slice(0, 120); } catch (e) { return 'n/a'; }
      })();
      // 相对同目录的脚本做对照
      d.sameDir = await new Promise((res) => {
        const s = document.createElement('script');
        s.src = new URL('js/electron-helper.js', document.baseURI).href;
        s.onload = () => res('onload');
        s.onerror = () => res('onerror');
        document.head.appendChild(s);
        setTimeout(() => res('timeout'), 3000);
      });
      return d;
    })()`, true);

    console.log('--- 诊断 ---');
    console.log(JSON.stringify(diag, null, 2));

    // 先把渲染层已有的 console 错误倒出来，再尝试探测
    console.log('--- 渲染层 console 输出 ---');
    for (const e of consoleErrors.slice(0, 20)) console.log('  ' + e);
    if (!consoleErrors.length) console.log('  (无)');
    console.log('--- 加载失败 ---');
    for (const e of blocked.slice(0, 10)) console.log('  ' + e);
    if (!blocked.length) console.log('  (无)');

    const probe = await win.webContents.executeJavaScript(`(() => {
      try {
        const out = {};
        out.hasI18nextGlobal = typeof i18next !== 'undefined';
        out.hasWindowI18n = !!window.i18n;
        out.i18nextLanguage = typeof i18next !== 'undefined' ? i18next.language : null;
        out.storeKeys = (typeof i18next !== 'undefined' && i18next.store && i18next.store.data)
            ? Object.keys(i18next.store.data) : [];
        if (window.i18n) {
            out.currentLang = window.i18n._currentLang;
            out.loaded = window.i18n._loaded;
            out.tFile = window.i18n.t('menu.file');
            out.tMissing = window.i18n.t('definitely.not.a.real.key');
            out.tNested = window.i18n.t('settings.language');
        }
        out.htmlLang = document.documentElement.lang;
        // 快捷键单一来源（src/utils/keybindings.ts）在真实页面里的接线：
        // 它是 <script> 加载的全局，缺席会让菜单提示静默变空 —— 静态检查看不见，只能在这里核。
        out.hasKeybindingsModule = !!(window.oicppKeybindings
            && typeof window.oicppKeybindings.defaultKeybindings === 'function');
        out.kbDefaultCount = out.hasKeybindingsModule
            ? Object.keys(window.oicppKeybindings.defaultKeybindings()).length : -1;
        const defaults = out.hasKeybindingsModule ? window.oicppKeybindings.defaultKeybindings() : {};
        out.menuShortcuts = Array.prototype.slice.call(document.querySelectorAll('.menu-dropdown-item'))
            .filter((el) => el.querySelector('.menu-shortcut'))
            .map((el) => {
                const node = el.querySelector('.menu-shortcut');
                const shown = (node.textContent || '').trim();
                const kbKey = node.getAttribute('data-keybinding') || '';
                const accelId = node.getAttribute('data-accel') || '';
                const want = kbKey
                    ? String((out.hasKeybindingsModule ? defaults[kbKey] : undefined) || '')
                        : (out.hasKeybindingsModule ? window.oicppKeybindings.menuAccelerator(accelId) : '');
                // DOM 上是**格式化之后**的写法，所以比较也要走同一个格式化函数 ——
                // 直接比原始 combo（CmdOrCtrl+N）会永远不符，这条第一版就踩了。
                const display = out.hasKeybindingsModule ? window.oicppKeybindings.formatShortcutLabel(want) : want;
                return { action: el.getAttribute('data-action') || '', shown, want: display, kbKey, accelId };
            });
        const els = Array.prototype.slice.call(document.querySelectorAll('[data-i18n]')).slice(0, 8);
        out.domSamples = els.map((e) => ({ key: e.getAttribute('data-i18n'), text: (e.textContent || '').trim().slice(0, 24) }));
        out.domTotal = document.querySelectorAll('[data-i18n]').length;
        return out;
      } catch (err) {
        return { __error: String(err && err.stack || err) };
      }
    })()`, true);

    if (probe.__error) {
        check('index.html: 探测脚本可执行', false, probe.__error.slice(0, 300));
        console.log(JSON.stringify(probe, null, 2));
        app.exit(2);
        return;
    }

    console.log('--- 探测结果 ---');
    console.log(JSON.stringify(probe, null, 2));

    // ---- 断言 ----
    check('index.html: i18next UMD 真正加载（未被 CSP 拦截）', probe.hasI18nextGlobal === true);
    check('index.html: window.i18n 存在', probe.hasWindowI18n === true);
    check('index.html: i18next store 有 zh-cn bundle', probe.storeKeys.includes('zh-cn'), JSON.stringify(probe.storeKeys));
    check('index.html: t("menu.file") 返回中文译文', /[\u4e00-\u9fff]/.test(String(probe.tFile)) && probe.tFile !== 'menu.file', String(probe.tFile));
    check('index.html: 缺键返回键本身', probe.tMissing === 'definitely.not.a.real.key', String(probe.tMissing));
    check('index.html: 嵌套键可解析', probe.tNested && probe.tNested !== 'settings.language', String(probe.tNested));
    const bareKey = probe.domSamples.filter((s) => s.text === s.key);
    check('index.html: DOM 元素无裸 key 残留', bareKey.length === 0, bareKey.map((b) => b.key).join(', '));
    check('index.html: <html lang> 已设置', !!probe.htmlLang, String(probe.htmlLang));

    // 单一来源模块的接线（缺席 = 菜单提示静默变空，而 CI 全绿）
    check('index.html: window.oicppKeybindings 已加载（<script> 顺序与 CSP 都对）',
        probe.hasKeybindingsModule === true, String(probe.hasKeybindingsModule));
    check('index.html: 默认键表 22 条（与 keybindings.ts 的 DEFS 同数）',
        probe.kbDefaultCount === 22, String(probe.kbDefaultCount));
    const blankHints = (probe.menuShortcuts || []).filter((s) => !s.shown);
    check('index.html: 每个 .menu-shortcut 都有内容（没有一个被静默清空）',
        (probe.menuShortcuts || []).length >= 13 && blankHints.length === 0,
        `共 ${(probe.menuShortcuts || []).length} 个，空的 ${blankHints.length} 个`);
    const hintMismatch = (probe.menuShortcuts || [])
        .filter((s) => s.want && s.shown !== s.want);
    check('index.html: 13 项菜单提示全部等于自己声明的那个来源（默认表 / accelerator 表）',
        hintMismatch.length === 0 && (probe.menuShortcuts || []).length === 13,
        `共 ${(probe.menuShortcuts || []).length} 项，不符: ${hintMismatch.map((m) => `${m.action}=${m.shown}≠${m.want}`).join(' | ')}`);
    const noSource = (probe.menuShortcuts || []).filter((s) => !s.kbKey && !s.accelId);
    check('index.html: 没有 span 还停留在「没声明来源」的手抄字面量上',
        noSource.length === 0, noSource.map((s) => `${s.action}=${s.shown}`).join(', '));

    // {keys} 插值 + @shortcut 引用在真实页面里的效果：标题栏的「快速打开 (Ctrl+P)」
    // 以前是焊在文案里的，现在由 keybindings.ts 的 BUILTIN_ACCELERATORS 供值。
    // 写成「未被调用的箭头函数源码」，好让下面 macProbe 里能当函数体插进去复用。
    const READ_SINKS_SRC = `() => {
        const t = document.getElementById('titlebar-quickopen');
        const ph = document.querySelector('.qo-placeholder');
        return { title: t ? (t.getAttribute('title') || '') : null,
                 placeholder: ph ? (ph.textContent || '').trim() : null };
    }`;
    const linuxShortcuts = await win.webContents.executeJavaScript(`(${READ_SINKS_SRC})()`, true);
    check('index.html: 标题栏快速打开显示的是来源值而不是 {keys} 占位符',
        linuxShortcuts.title === '快速打开 (Ctrl+P)' && linuxShortcuts.placeholder === '搜索文件 (Ctrl+P)',
        JSON.stringify(linuxShortcuts));

    // mac 分支的端到端证明：这台 CI 是 linux，靠 keybindings.ts 的注入点把平台临时改成 mac，
    // 让 app 重算一遍提示再读 DOM —— 只测纯函数的话，「DOM 真被写成 ⌘N」这件事永远没验过。
    const macProbe = await win.webContents.executeJavaScript(`(() => {
      try {
        if (!window.oicppKeybindings || !window.oicppApp) return { __skip: '缺 oicppKeybindings 或 oicppApp' };
        const read = () => Array.prototype.slice.call(document.querySelectorAll('.menu-dropdown-item .menu-shortcut'))
            .map((n) => (n.textContent || '').trim());
        const readSinks = ${READ_SINKS_SRC};
        window.oicppKeybindings.setPlatformOverride('mac');
        window.oicppApp.updateMenuShortcutHints();
        window.i18n._applyToDOM();
        const shown = read();
        const shortcuts = readSinks();
        window.oicppKeybindings.setPlatformOverride(null);
        window.oicppApp.updateMenuShortcutHints();
        window.i18n._applyToDOM();
        return { shown, restored: read(), shortcuts, restoredShortcuts: readSinks() };
      } catch (err) { return { __error: String(err && err.stack || err) }; }
    })()`, true);
    if (macProbe.__skip || macProbe.__error) {
        check('index.html: mac 注入端到端探针跑起来了', false, String(macProbe.__skip || macProbe.__error));
    } else {
        check('index.html: 注入 mac 后菜单提示真的变成 ⌘ 写法（第一项 ⌘N）',
            macProbe.shown[0] === '⌘N' && macProbe.shown.some((t) => t.includes('⌘')),
            JSON.stringify(macProbe.shown));
        check('index.html: mac 写法里一个 Ctrl 都没有',
            macProbe.shown.filter((t) => /Ctrl/.test(t)).length === 0,
            JSON.stringify(macProbe.shown.filter((t) => /Ctrl/.test(t))));
        check('index.html: 注入 mac 后 {keys} 也跟着变成 ⌘P（标题栏两处）',
            macProbe.shortcuts.title === '快速打开 (⌘P)'
                && macProbe.shortcuts.placeholder === '搜索文件 (⌘P)',
            JSON.stringify(macProbe.shortcuts));
        const baseline = (probe.menuShortcuts || []).map((s) => s.shown);
        check('index.html: 撤掉注入后提示还原（探针不留残余状态）',
            JSON.stringify(macProbe.restored) === JSON.stringify(baseline)
                && JSON.stringify(macProbe.restoredShortcuts) === JSON.stringify(linuxShortcuts),
            JSON.stringify({ restored: macProbe.restoredShortcuts, baseline: linuxShortcuts }));
    }

    check('无 CSP/资源加载阻断', blocked.length === 0, blocked.slice(0, 3).join(' | '));

    // ---- 其余 5 个窗口：只验 i18next 是否加载 + t() 能否出译文 ----
    for (const w of WINDOWS.slice(1)) {
        const before = consoleErrors.length;
        const w2 = new BrowserWindow({
            width: 1000, height: 700, show: false,
            webPreferences: {
                preload: path.join(__dirname, 'smoke-preload.js'),
                contextIsolation: true, nodeIntegration: false, sandbox: false,
            },
        });
        attach(w2, w.name);
        const f = path.join(RENDERER, w.file);
        try {
            await w2.loadFile(f);
            await new Promise((r) => setTimeout(r, 2500));
            const p = await w2.webContents.executeJavaScript(`(() => ({
                hasI18next: typeof i18next !== 'undefined',
                hasI18n: !!window.i18n,
                lang: window.i18n ? window.i18n._currentLang : null,
                keys: (typeof i18next !== 'undefined' && i18next.store && i18next.store.data) ? Object.keys(i18next.store.data) : [],
                t: window.i18n ? window.i18n.t('menu.file') : null,
            }))()`, true);
            check(`${w.file}: i18next UMD 加载`, p.hasI18next === true);
            check(`${w.file}: i18next bundle 已灌入`, p.keys.includes('zh-cn'), JSON.stringify(p.keys));
        } catch (e) {
            check(`${w.file}: loadFile 成功`, false, e && e.message);
        }
        const newErrs = consoleErrors.slice(before);
        check(`${w.file}: 无渲染层 console 错误`, newErrs.length === 0, newErrs.slice(0, 2).join(' | '));
        w2.destroy();
    }

    // ---- 改键设置页：显示跟随平台，存储仍是规范写法 ------------------------------------
    // 往返不变量（format⇄parse 180 次全等）在 tests/keybindings-single-source.test.js 里测，
    // 这一段验的是另一件事：真实渲染路径确实把格式化后的值放进了输入框。
    // 注意 read() 每次都要重新查 DOM —— renderKeybindingsUI() 会清空容器重建行，
    // 缓存下来的节点会变成游离片，读到的还是旧值（那样这条断言就是假绿）。
    {
        const w4 = new BrowserWindow({
            width: 1000, height: 700, show: false,
            webPreferences: {
                preload: path.join(__dirname, 'smoke-preload.js'),
                contextIsolation: true, nodeIntegration: false, sandbox: false,
            },
        });
        attach(w4, 'settings-editor-shortcut');
        try {
            await w4.loadFile(path.join(RENDERER, 'settings', 'editor.html'));
            await new Promise((r) => setTimeout(r, 2500));
            const kbProbe = await w4.webContents.executeJavaScript(`(() => {
                const read = () => Array.prototype.slice.call(document.querySelectorAll('.keybinding-row'))
                    .map((row) => ({
                        key: row.getAttribute('data-keybinding-key') || '',
                        value: (row.querySelector('.keybinding-input') || {}).value || ''
                    }));
                if (!window.editorSettings || !window.oicppKeybindings) {
                    return { __skip: '缺 window.editorSettings 或 window.oicppKeybindings', rows: read() };
                }
                const linux = read();
                window.oicppKeybindings.setPlatformOverride('mac');
                window.editorSettings.renderKeybindingsUI();
                const mac = read();
                window.oicppKeybindings.setPlatformOverride(null);
                window.editorSettings.renderKeybindingsUI();
                return { linux, mac, restored: read() };
            })()`, true);
            if (kbProbe.__skip) {
                check('settings/editor.html: 快捷键显示探针跑起来了', false, kbProbe.__skip);
            } else {
                check('settings/editor.html: 非 mac 下输入框是规范写法（Alt+Shift+S 在场）',
                    kbProbe.linux.some((r) => r.value === 'Alt+Shift+S'),
                    JSON.stringify(kbProbe.linux.slice(0, 2)));
                check('settings/editor.html: 注入 mac 后同一行显示 ⌥⇧S（显示跟随平台）',
                    kbProbe.mac.some((r) => r.value === '⌥⇧S'),
                    JSON.stringify(kbProbe.mac.slice(0, 2)));
                check('settings/editor.html: 撤掉注入后逐行还原，且没有一行变空',
                    JSON.stringify(kbProbe.restored) === JSON.stringify(kbProbe.linux)
                        && kbProbe.restored.every((r) => r.value.length > 0),
                    JSON.stringify(kbProbe.restored.slice(0, 2)));
            }
        } catch (e) {
            check('settings/editor.html: 快捷键显示探针未抛错', false, e && e.message);
        }
        w4.destroy();
    }

    // ---- #9：切一次语言后，JS 按平台覆写的文案还在不在 ------------------------------------
    // tests/i18n-dom-owner-conflict.test.js 能静态扫出「同一元素同一属性被两套机制写不同键」，
    // 但「谁后跑」是运行期时序：i18n 先 _notifyListeners() 再同步跑 _applyToDOM()，补偿方要
    // 延后一拍才盖得回去。vm 里看不见这个顺序，所以这里真起一个窗口、真切一次语言。
    // smoke-preload 的 getPlatform 固定返回 'linux'，因此本段验的是「非 Windows」那条分支；
    // Windows 分支写的就是静态默认值，与 _applyToDOM 同值，本无冲突。
    {
        const before = consoleErrors.length;
        const w3 = new BrowserWindow({
            width: 1000, height: 700, show: false,
            webPreferences: {
                preload: path.join(__dirname, 'smoke-preload.js'),
                contextIsolation: true, nodeIntegration: false, sandbox: false,
            },
        });
        attach(w3, 'settings-compiler-langswitch');
        await w3.loadFile(path.join(RENDERER, 'settings', 'compiler.html'));
        await new Promise((r) => setTimeout(r, 3000));

        const READ_I18N_CLASH = `(function(){
            const sel = document.getElementById('run-mode');
            const hint = sel && sel.parentElement ? sel.parentElement.querySelector('.hint') : null;
            const btn = document.getElementById('install-compiler');
            const popup = sel ? sel.querySelector('option[value="popup"]') : null;
            return {
                lang: window.i18n.getCurrentLanguage(),
                popupDisabled: popup ? popup.disabled : null,
                hint: hint ? hint.textContent : null,
                btnText: btn ? btn.textContent : null,
                btnDisabled: btn ? btn.disabled : null,
                vGeneric: window.i18n.t('compiler.runModeDesc'),
                vPlatformHint: window.i18n.t('compiler.integratedOnlyHint'),
                vBtnDisabled: window.i18n.t('compiler.downloadDisabled'),
                vBtnDefault: window.i18n.t('compiler.installOnline')
            };
        })()`;
        const zh9 = await w3.webContents.executeJavaScript(READ_I18N_CLASH, true);
        check('settings/compiler.html: #9 探针取到的是译文而不是裸键',
            !!zh9.hint && zh9.hint !== 'compiler.runModeDesc' && zh9.vPlatformHint !== 'compiler.integratedOnlyHint',
            JSON.stringify({ hint: zh9.hint, lang: zh9.lang }));
        // 两条候选文案必须真的不同，否则下面的判等在「平台条 == 通用条」的语种里是真空通过
        check('settings/compiler.html: #9 的两条候选文案确实不同（探针不空转）',
            zh9.vGeneric !== zh9.vPlatformHint && zh9.vBtnDisabled !== zh9.vBtnDefault,
            JSON.stringify({ generic: zh9.vGeneric, platform: zh9.vPlatformHint }));

        await w3.webContents.executeJavaScript(`window.electronAPI.__broadcastLanguage('en')`, true);
        await new Promise((r) => setTimeout(r, 1500));
        const en9 = await w3.webContents.executeJavaScript(READ_I18N_CLASH, true);
        check('settings/compiler.html: 语言确实切到了 en',
            en9.lang === 'en' && en9.vPlatformHint !== zh9.vPlatformHint,
            JSON.stringify({ lang: en9.lang, platform: en9.vPlatformHint }));
        check('settings/compiler.html: 切语言后「运行方式提示」仍是平台专属那条（#9 主案）',
            en9.popupDisabled === true
                ? (en9.hint === en9.vPlatformHint && en9.hint !== en9.vGeneric)
                : (en9.hint === en9.vGeneric),
            `hint="${en9.hint}" 平台条="${en9.vPlatformHint}" 通用条="${en9.vGeneric}" popupDisabled=${en9.popupDisabled}`);
        check('settings/compiler.html: 切语言后安装按钮仍是「已禁用」那条（同一个洞的第二处）',
            en9.popupDisabled === true
                ? (en9.btnText === en9.vBtnDisabled && en9.btnText !== en9.vBtnDefault && en9.btnDisabled === true)
                : true,
            `text="${en9.btnText}" 禁用条="${en9.vBtnDisabled}" 默认条="${en9.vBtnDefault}" disabled=${en9.btnDisabled}`);

        await w3.webContents.executeJavaScript(`window.electronAPI.__broadcastLanguage('zh-cn')`, true);
        await new Promise((r) => setTimeout(r, 1500));
        const back9 = await w3.webContents.executeJavaScript(READ_I18N_CLASH, true);
        check('settings/compiler.html: 切回 zh-cn 两条仍成立（双向都验，单向通过说明不了补偿在跑）',
            back9.hint === back9.vPlatformHint && back9.hint !== back9.vGeneric
                && back9.btnText === back9.vBtnDisabled,
            `hint="${back9.hint}" btn="${back9.btnText}"`);
        const newErrs9 = consoleErrors.slice(before);
        check('settings/compiler.html: #9 语言切换过程无渲染层 console 错误',
            newErrs9.length === 0, newErrs9.slice(0, 2).join(' | '));
        w3.destroy();
    }

    if (pageErrors.length) {
        console.log('--- 渲染层致命错误 ---');
        for (const e of pageErrors) console.log('  ' + e);
    }
    const fatal = consoleErrors.filter((e) => /i18next is not defined|Cannot read propert|is not a function|ReferenceError/.test(e));
    check('无 i18n 相关致命错误', fatal.length === 0, fatal.slice(0, 3).join(' | '));

    console.log(`\nsmoke completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
    app.exit(failures ? 1 : 0);
}).catch((e) => {
    console.error('smoke 崩溃:', e && e.stack || e);
    app.exit(2);
});

setTimeout(() => { console.error('smoke 超时'); app.exit(3); }, TIMEOUT_MS);
