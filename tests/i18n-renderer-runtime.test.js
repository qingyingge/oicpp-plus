'use strict';

// 渲染层 i18n 运行时契约测试。
//
// tests/i18n.test.js 走的是「读源码 + 独立 i18next 实例」的路子，验证的是接线与
// 语言包。本测试另开一条：用 vm 构造一个接近真实的渲染环境（window/document/
// MutationObserver + 真实 i18next UMD + 真实语言包 + 假 IPC），把
// src/renderer/js/i18n.js 原样跑起来，断言的是**界面实际会看到什么**。
//
// 覆盖的是静态检查碰不到的部分：
//   - UMD 全局 i18next 能否在 <script> 形态下被 i18n.js 用上（无 module/exports）
//   - init() 的 await 时序：await 之后 t() 必须已可翻译，不能返回裸 key
//   - onLanguageChanged / settings-changed 两条语言切换链路是否真的重翻 DOM
//   - data-i18n-args 的 JSON 参数注入
//   - 语言切换后 onChange 监听器与 i18n-language-changed 事件是否触发

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const langDir = path.join(root, 'src', 'lang');
const I18N_SOURCE = path.join(root, 'src', 'renderer', 'js', 'i18n.js');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

// --- 最小 DOM 替身：只实现 i18n.js 实际用到的那几个 API ----------------------
function createElement() {
    return {
        _attrs: {},
        textContent: '',
        placeholder: '',
        title: '',
        nodeType: 1,
        getAttribute(name) { return name in this._attrs ? this._attrs[name] : null; },
        setAttribute(name, value) { this._attrs[name] = value; },
        hasAttribute(name) { return name in this._attrs; },
        querySelector() { return null; },
    };
}

// 建环境：lang 包 + 假 electronAPI，按脚本顺序执行 i18next UMD 与 i18n.js
function bootRenderer({ lang = 'zh-cn' } = {}) {
    const packs = {
        'zh-cn': JSON.parse(fs.readFileSync(path.join(langDir, 'zh-cn.json'), 'utf8')),
        en: JSON.parse(fs.readFileSync(path.join(langDir, 'en.json'), 'utf8')),
    };

    const dom = {
        lang: '',
        body: { nodeType: 1 },
        listeners: new Map(),
        querySelectorAll: () => [],
        dispatchEvent(evt) {
            const arr = this.listeners.get(evt.type) || [];
            for (const fn of arr.slice()) fn(evt);
            return true;
        },
        addEventListener(type, fn) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(fn);
        },
        documentElement: createElement(),
    };

    const ipc = {
        getLanguage: async () => lang,
        getLanguageFile: async (code) => packs[code] || null,
        getAvailableLanguages: async () => [
            { code: 'zh-cn', name: '中文（简体）', nameEn: 'Chinese (Simplified)' },
            { code: 'en', name: 'English', nameEn: 'English' },
        ],
        updateSettings: async () => undefined,
    };

    // 记录 IPC 订阅，便于从测试侧触发语言切换
    const ipcSubs = { languageChanged: [], settingsChanged: [] };
    const sandbox = {
        console,
        logInfo: () => {},
        logError: (...a) => { console.error('[renderer logError]', ...a); },
        logWarn: () => {},
        MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} },
        CustomEvent: class { constructor(type, init) { this.type = type; Object.assign(this, init); } },
        JSON,
        Promise,
        Object,
        Array,
        Error,
        String,
        document: dom,
        window: {
            electronAPI: {
                getLanguage: ipc.getLanguage,
                getLanguageFile: ipc.getLanguageFile,
                getAvailableLanguages: ipc.getAvailableLanguages,
                updateSettings: ipc.updateSettings,
                onLanguageChanged: (cb) => ipcSubs.languageChanged.push(cb),
            },
            electronIPC: {
                on: (evt, cb) => {
                    // evt 是 IPC 事件名（'settings-changed'），映射到 mock 的订阅槽
                    const slot = { 'settings-changed': 'settingsChanged' }[evt];
                    if (slot) ipcSubs[slot].push(cb);
                },
            },
        },
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    // 与 index.html 一致的顺序：先 i18next UMD（全局 i18next），后 i18n.js
    const umd = fs.readFileSync(
        path.join(root, 'node_modules', 'i18next', 'dist', 'umd', 'i18next.min.js'), 'utf8');
    vm.runInContext(umd, sandbox, { filename: 'i18next.min.js' });
    check('UMD build exposes a global i18next in a script-only context',
        sandbox.i18next && typeof sandbox.i18next.init === 'function');

    // i18n.js 是纯 script 形态（无 module.exports 守卫），必须能直接跑
    vm.runInContext(fs.readFileSync(I18N_SOURCE, 'utf8'), sandbox, { filename: 'i18n.js' });
    check('i18n.js runs as a plain <script> without module/exports globals',
        sandbox.window.i18n && typeof sandbox.window.i18n.t === 'function');

    return { sandbox, dom, ipcSubs, packs };
}

// --- 1. init() 后立即可翻译（await 时序）--------------------------------------
(async () => {
    // --- 0a. 每个加载 i18n.js 的 HTML 都必须先加载 i18next UMD ---
    // 漏掉时 i18n.js 能加载成功，但 init() 抛 ReferenceError 被 catch 吞掉，
    // t() 更是直接抛 —— 该窗口全程裸 key，且静态检查完全看不见。
    {
        const walk = (dir, out = []) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full, out);
                else if (e.name.endsWith('.html')) out.push(full);
            }
            return out;
        };
        const windows = walk(path.join(root, 'src', 'renderer'))
            .filter((f) => fs.readFileSync(f, 'utf8').includes('js/i18n.js'));
        check('found every HTML entry point that loads i18n.js', windows.length >= 6, `${windows.length} 个窗口`);

        const missingUmd = [];
        for (const f of windows) {
            const lines = fs.readFileSync(f, 'utf8').split('\n');
            const umdAt = lines.findIndex((l) => l.includes('i18next.min.js'));
            const i18nAt = lines.findIndex((l) => l.includes('js/i18n.js'));
            if (umdAt < 0 || umdAt > i18nAt) {
                missingUmd.push(`${path.relative(root, f)}(umd=${umdAt}, i18n=${i18nAt})`);
                continue;
            }
            // 相对路径按 HTML 所在目录解析。settings/*.html 比 index.html 深一层，
            // 用 ../../ 会指到 src/node_modules —— 文件不存在，CI 的引用检查才会报。
            const m = /<script src="([^"]*i18next\.min\.js)"/.exec(lines[umdAt]);
            const resolved = path.resolve(path.dirname(f), m[1]);
            if (!fs.existsSync(resolved)) {
                missingUmd.push(`${path.relative(root, f)} -> unresolvable ${m[1]}`);
            }
        }
        check('every i18n.js consumer loads an existing i18next UMD before it', missingUmd.length === 0,
            missingUmd.join(' | '));
    }

    // --- 0b. 启动语言一致性 ---
    // i18n.js 的 i18next.init 硬编码 lng:'zh-cn'，而真实语言来自 settings。
    // 历史上读出 settings.language='en' 后只灌 bundle、从不 changeLanguage，
    // 结果 i18next 仍按 zh-cn 查表：界面显示中文，但 <html lang> 是 en。
    {
        const enBoot = bootRenderer({ lang: 'en' });
        await enBoot.sandbox.window.i18n.init();
        check('booting with settings.language=en actually serves English',
            enBoot.sandbox.window.i18n.t('menu.file') === 'File',
            enBoot.sandbox.window.i18n.t('menu.file'));
        check('booting with a non-default language keeps i18next in sync',
            enBoot.sandbox.window.i18n.getCurrentLanguage() === enBoot.sandbox.i18next.language,
            `${enBoot.sandbox.window.i18n.getCurrentLanguage()} vs ${enBoot.sandbox.i18next.language}`);
        check('booting with settings.language=en sets <html lang> to en',
            enBoot.dom.documentElement.lang === 'en', enBoot.dom.documentElement.lang);

        const zhBoot = bootRenderer({ lang: 'zh-cn' });
        await zhBoot.sandbox.window.i18n.init();
        check('booting with settings.language=zh-cn serves Chinese',
            zhBoot.sandbox.window.i18n.t('menu.file') === '文件',
            zhBoot.sandbox.window.i18n.t('menu.file'));
    }
    const { sandbox } = bootRenderer();
    const i18n = sandbox.window.i18n;
    // i18next.init 对空 resources 是同步生效的，所以 init() 返回前 t() 就能查到 zh-cn；
    // 未 await init() 时语言包尚未灌入，应当回落到 key 本身。
    // init() 之前 i18next 还没有语言，返回 undefined；必须降级成 key，
    // 否则消费方会把 undefined 直接写进 textContent。
    check('before init() t() degrades to the key instead of undefined',
        i18n.t('menu.file') === 'menu.file', String(i18n.t('menu.file')));

    const run = i18n.init().then(() => {
        check('after await init() a real key is translated',
            i18n.t('menu.file') === '文件', `menu.file -> ${i18n.t('menu.file')}`);

        // --- 2. 插值契约 ---
        const zh = JSON.parse(fs.readFileSync(path.join(langDir, 'zh-cn.json'), 'utf8'));
        // 语言包是嵌套的，要展平后才能按 key 找；挑一个带 2 个及以上 {token} 的条目
        const flatZh = {};
        (function walk(obj, prefix) {
            for (const [k, v] of Object.entries(obj)) {
                const key = prefix ? `${prefix}.${k}` : k;
                if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
                else flatZh[key] = String(v);
            }
        })(zh, '');
        const phKey = Object.keys(flatZh).find((k) => (flatZh[k].match(/\{\w+\}/g) || []).length >= 2);
        check('language pack has a key with 2+ {token} to probe', !!phKey,
            phKey || Object.keys(zh).filter((k) => /\{\w+\}/.test(String(zh[k]))).slice(0, 5).join(','));
        if (phKey) {
            const tokens = flatZh[phKey].match(/\{\w+\}/g).map((s) => s.slice(1, -1));
            const partial = i18n.t(phKey, { [tokens[0]]: 'A' });
            check('a missed {token} stays visible (so the bug is eyeballable)',
                partial.includes(`{${tokens[1]}}`), partial);
            const full = i18n.t(phKey, Object.fromEntries(tokens.map((t) => [t, 'B'])));
            check('no leftover {token} once every param is passed',
                !/\{\w+\}/.test(full), full);
        }

        // --- 3. 缺 key 返回 key 本身（而非 undefined / 空串）---
        check('unknown key falls back to the key itself',
            i18n.t('no.such.key.here') === 'no.such.key.here');

        // --- 4. 非字符串入参不炸 ---
        check('non-string key does not throw', i18n.t(null) === '' && i18n.t(undefined) === '');
        check('a key that resolves to a falsy-looking value is still returned',
            typeof i18n.t('meta.code') === 'string', i18n.t('meta.code'));

        // --- 5. getCurrentLanguage / getAvailableLanguages ---
        check('getCurrentLanguage reflects the settings language', i18n.getCurrentLanguage() === 'zh-cn');
        return i18n.getAvailableLanguages().then((langs) => {
            check('getAvailableLanguages comes back over IPC',
                Array.isArray(langs) && langs.length === 2 && langs[1].code === 'en');

            // --- 6. data-i18n-args / -placeholder / -title / -aria-label：DOM 层契约 ---
            const { sandbox: s2, dom: d2, ipcSubs } = bootRenderer();
            const zhPack = JSON.parse(fs.readFileSync(path.join(langDir, 'zh-cn.json'), 'utf8'));
            const enPack2 = JSON.parse(fs.readFileSync(path.join(langDir, 'en.json'), 'utf8'));
            // 选四个真实存在的键（browser.searchPlaceholder 在语言包里并不存在）
            const KEY_TEXT = 'message.updateDownloading';
            const KEY_PLACEHOLDER = 'menu.searchFiles';
            const KEY_TITLE = 'browser.reload';
            const KEY_ARIA = 'menu.help';
            const flatEn = {};
            (function walk(obj, prefix) {
                for (const [k, v] of Object.entries(obj)) {
                    const key = prefix ? `${prefix}.${k}` : k;
                    if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key);
                    else flatEn[key] = String(v);
                }
            })(enPack2, '');
            // 探针键必须真实存在于两个语言包，否则后面的期望值毫无意义
            for (const k of [KEY_TEXT, KEY_PLACEHOLDER, KEY_TITLE, KEY_ARIA]) {
                check(`probe key exists in both packs: ${k}`, flatZh[k] !== undefined && flatEn[k] !== undefined,
                    `zh=${flatZh[k]} en=${flatEn[k]}`);
            }

            const target = createElement();
            target.setAttribute('data-i18n', KEY_TEXT);
            target.setAttribute('data-i18n-args', JSON.stringify({ version: ' v2.0', progress: 50 }));
            const phTarget = createElement();
            phTarget.setAttribute('data-i18n-placeholder', KEY_PLACEHOLDER);
            const titleTarget = createElement();
            titleTarget.setAttribute('data-i18n-title', KEY_TITLE);
            const ariaTarget = createElement();
            ariaTarget.setAttribute('data-i18n-aria-label', KEY_ARIA);
            d2.querySelectorAll = (sel) => ({
                '[data-i18n]': [target],
                '[data-i18n-placeholder]': [phTarget],
                '[data-i18n-title]': [titleTarget],
                '[data-i18n-aria-label]': [ariaTarget],
            }[sel] || []);

            return s2.window.i18n.init().then(() => {
                s2.window.i18n._applyToDOM();
                check('data-i18n-args params reach the translation',
                    target.textContent === flatZh[KEY_TEXT]
                        .replace('{version}', ' v2.0').replace('{progress}', '50'),
                    `${target.textContent} vs ${flatZh[KEY_TEXT]}`);
                check('data-i18n-placeholder is applied',
                    phTarget.placeholder === flatZh[KEY_PLACEHOLDER],
                    `${phTarget.placeholder} vs ${flatZh[KEY_PLACEHOLDER]}`);
                check('data-i18n-title is applied', titleTarget.title === flatZh[KEY_TITLE]);
                check('data-i18n-aria-label is applied', ariaTarget.getAttribute('aria-label') === flatZh[KEY_ARIA]);
                check('html lang attribute tracks the current language', d2.documentElement.lang === 'zh-cn');

                // --- 7. onLanguageChanged 链路：主进程推语言 → 重翻 ---
                const langs2 = [];
                s2.window.i18n.onChange((l) => langs2.push(l));
                return ipcSubs.languageChanged[0]('en').then(() => {
                    check('onLanguageChanged switch retranslates immediately',
                        s2.window.i18n.t('menu.file') === 'File', s2.window.i18n.t('menu.file'));
                    check('DOM is retranslated after a language switch',
                        titleTarget.title === flatEn[KEY_TITLE], titleTarget.title);
                    check('html lang attribute follows the switch',
                        d2.documentElement.lang === 'en', d2.documentElement.lang);
                    check('onChange listeners fire with the new language',
                        langs2.length === 1 && langs2[0] === 'en', JSON.stringify(langs2));
                    check('getCurrentLanguage follows the switch',
                        s2.window.i18n.getCurrentLanguage() === 'en');

                    // --- 8. i18n-language-changed DOM 事件 ---
                    let evtLang = null;
                    d2.addEventListener('i18n-language-changed', (e) => { evtLang = e.detail.language; });
                    return ipcSubs.languageChanged[0]('zh-cn').then(() => {
                        check('i18n-language-changed event carries the language', evtLang === 'zh-cn', String(evtLang));
                        check('switching back restores Chinese', s2.window.i18n.t('menu.file') === '文件');
                        check('html lang attribute follows the switch back',
                            d2.documentElement.lang === 'zh-cn');

                        // --- 9. settings-changed 链路 ---
                        return ipcSubs.settingsChanged[0](null, 'general', { language: 'en' }).then(() => {
                            check('settings-changed with a new language retranslates',
                                s2.window.i18n.t('menu.file') === 'File', s2.window.i18n.t('menu.file'));
                            return ipcSubs.settingsChanged[0](null, 'editor', { fontSize: 14 });
                        }).then(() => {
                            check('settings-changed without a language is a no-op',
                                s2.window.i18n.t('menu.file') === 'File');

                            // --- 10. init() 幂等：多次 await 不重复订阅 ---
                            const langs3 = [];
                            s2.window.i18n.onChange((l) => langs3.push(l));
                            return Promise.all([s2.window.i18n.init(), s2.window.i18n.init()])
                                .then(() => ipcSubs.languageChanged[0]('zh-cn'))
                                .then(() => {
                                    check('repeated init() does not double-fire listeners',
                                        langs3.length === 1, JSON.stringify(langs3));

                                    // --- 11. enableAutoTranslate 不炸且幂等 ---
                                    s2.window.i18n.enableAutoTranslate();
                                    s2.window.i18n.enableAutoTranslate();
                                    check('enableAutoTranslate is idempotent and observer-safe', true);

                                    // --- 12. onChange 返回 unsubscribe ---
                                    const off = s2.window.i18n.onChange(() => { throw new Error('should be off'); });
                                    check('onChange hands back a callable unsubscribe', typeof off === 'function');
                                    off();
                                    return ipcSubs.languageChanged[0]('en').then(() => {
                                        check('after unsubscribe that listener is not called', true);
                                    });
                                });
                        });
                    });
                });
            });
        });
    });
// --- 13. 独立设置窗口的加载时序 ---
    // settings/compiler.html 内联的 init() 是 async 的，而 compiler.js 的
    // DOMContentLoaded handler 同步 new CompilerSettings()；它里面直接给
    // installBtn.textContent 赋值（不走 data-i18n，_applyToDOM 救不回来）。
    // 漏掉 await init() 会让界面持久显示裸 key —— 这里锁住修复。
    {
        const compilerJs = fs.readFileSync(path.join(root, 'src', 'renderer', 'settings', 'compiler.js'), 'utf8');
        const handler = /window\.addEventListener\('DOMContentLoaded',\s*async[\s\S]{0,400}?await window\.i18n\.init\(\)/.test(compilerJs);
        check('compiler.js awaits i18n.init() before constructing CompilerSettings', handler);
    }

    // --- 14. 局部 t() 别名不得留死掉的第三形参 ---
    // fallback 形参零调用方，且 t() 缺键时返回 key 本身（非空 truthy），
    // 所以 `t() || fallback` 永远不触发 —— 形参存在即误导。
    {
        const aliasRe = /^\s*const (_?t)\s*=\s*\(([^)]*)\)\s*=>/gm;
        const dead = [];
        const walk = (dir, out = []) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) walk(full, out);
                else if (e.name.endsWith('.js')) out.push(full);
            }
            return out;
        };
        for (const f of walk(path.join(root, 'src'))) {
            const lines = fs.readFileSync(f, 'utf8').split('\n');
            lines.forEach((l, i) => {
                const m = aliasRe.exec(l);
                aliasRe.lastIndex = 0;
                if (!m) return;
                if (/,\s*fallback\s*$/.test(m[2])) {
                    dead.push(`${path.relative(root, f)}:${i + 1} -> ${l.trim().slice(0, 80)}`);
                }
            });
        }
        check('no local t() alias keeps an unused fallback parameter', dead.length === 0, dead.slice(0, 5).join(' | '));
    }
})().then(() => {
    console.log(`i18n renderer runtime tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
    process.exitCode = failures ? 1 : 0;
}).catch((err) => {
    console.error('[FAIL] runtime test threw:', err);
    process.exitCode = 1;
});