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
