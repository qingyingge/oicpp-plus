'use strict';

// i18n 契约回归测试：锁定语言包结构与 renderer 查表行为，
// 防止批量正则替换（历史上出现过 `= ('key')` 这类静默空操作）再次悄悄破坏界面。

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const langDir = path.join(root, 'src', 'lang');
const REQUIRED_LOCALES = ['zh-cn', 'en'];

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const flatten = (obj, prefix = '', out = {}) => {
    for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
        else out[key] = v;
    }
    return out;
};
const placeholdersOf = (value) => (String(value).match(/\{\w+\}/g) || []).sort();

// --- 语言包可解析 -----------------------------------------------------------
// 曾经因为 zh-cn.json 里一个未转义引号导致 JSON.parse 失败，整站退化成裸键名。
const packs = {};
for (const code of REQUIRED_LOCALES) {
    const file = path.join(langDir, `${code}.json`);
    check(`${code}.json exists`, fs.existsSync(file), file);
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        check(`${code}.json parses as JSON`, false, error.message);
    }
    if (parsed) {
        check(`${code}.json parses as JSON`, true);
        packs[code] = flatten(parsed);
        check(`${code}.json meta.code matches filename`, parsed.meta?.code === code, parsed.meta?.code);
    }
}

if (packs['zh-cn'] && packs.en) {
    const enKeys = Object.keys(packs.en);
    const zhKeys = new Set(Object.keys(packs['zh-cn']));

    // --- key 对齐 ------------------------------------------------------------
    const missingInZh = enKeys.filter((k) => !zhKeys.has(k));
    const missingInEn = [...zhKeys].filter((k) => packs.en[k] === undefined);
    check('en.json and zh-cn.json have identical key sets', missingInZh.length === 0 && missingInEn.length === 0,
        missingInZh.length + missingInEn.length ? `missing zh: ${missingInZh.slice(0, 5)} | missing en: ${missingInEn.slice(0, 5)}` : `${enKeys.length} keys`);

    // --- placeholder 对齐 ----------------------------------------------------
    const phMismatch = enKeys.filter((k) => {
        if (packs['zh-cn'][k] === undefined) return false;
        return placeholdersOf(packs.en[k]).join('|') !== placeholdersOf(packs['zh-cn'][k]).join('|');
    });
    check('every key interpolates the same placeholders in both locales', phMismatch.length === 0,
        phMismatch.length ? phMismatch.slice(0, 5).map((k) => `${k}: en[${placeholdersOf(packs.en[k])}] zh[${placeholdersOf(packs['zh-cn'][k])}]`).join(' | ') : '');

    // --- 英文包不含 CJK 文字 -------------------------------------------------
    const enCjk = enKeys.filter((k) => /[\u4e00-\u9fff]/.test(String(packs.en[k])));
    check('en.json carries no untranslated CJK text', enCjk.length === 0, enCjk.slice(0, 5).join(', '));

    // --- 译文非空 ------------------------------------------------------------
    const empty = enKeys.filter((k) => typeof packs.en[k] === 'string' && packs.en[k].trim() === '');
    check('no translation is an empty string', empty.length === 0, empty.slice(0, 5).join(', '));
}

// --- 源码中不存在 t() 空操作残留 ---------------------------------------------
// `window.i18n ? window.i18n.t('key') : 'fallback'` 被批量替换后可能退化成
// `= ('key')`，界面直接显示裸键名且不会有任何报错。
{
    const allKeys = new Set();
    for (const pack of Object.values(packs)) for (const k of Object.keys(pack)) allKeys.add(k);

    const walk = (dir, out = []) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, out);
            else if (/\.(js|html)$/.test(entry.name)) out.push(full);
        }
        return out;
    };

    const residueRe = /(?<![=!<>+\-*/&|%?:])\s=\s*\(\s*['"]([a-z][\w]*(?:\.[a-zA-Z][\w]*)+)['"]\s*\)\s*;?\s*$/gm;
    const residue = [];
    for (const f of walk(path.join(root, 'src'))) {
        if (f.startsWith(langDir)) continue;
        const content = fs.readFileSync(f, 'utf8');
        for (const m of content.matchAll(residueRe)) {
            const line = content.slice(0, m.index).split('\n').length;
            residue.push(`${path.relative(root, f)}:${line} -> ${m[1]}${allKeys.has(m[1]) ? '' : ' (key not in any pack)'}`);
        }
    }
    check('no no-op t() residue in src/', residue.length === 0, residue.slice(0, 5).join(' | '));
}

// --- CI I8 的豁免规则本身也要被锁定 -------------------------------------------
// I8 靠两条豁免避免误报：带 data-i18n-* 的行，以及中文字面量只出现在 t() 的
// fallback 第三个参数里（本项目 renderer/main.js:52 与 compile-manager.js:3 都
// 定义了 t(key, params, fallback)，中文兜底是有意设计）。规则一旦被无意放宽，
// 硬编码就会重新混进主干，所以这里把 ci-check 里的实现原样抄过来测。
{
    const ciSource = fs.readFileSync(path.join(root, 'scripts', 'ci-check.js'), 'utf8');
    // 仓库里是 CRLF，按 \r?\n 切分
    const stripMatch = /const stripTFallback = \(line\) => line\r?\n([\s\S]*?)\r?\n  let count = 0;/.exec(ciSource);
    check('ci-check still defines the t()-fallback strip used by I8', !!stripMatch);
    check('ci-check I8 skips lines carrying a data-i18n-* hook', /alreadyMigratedRe\.test\(line\)/.test(ciSource));
    check('ci-check I8 re-tests the line after stripping t() calls',
        /if \(!\/\[\\u4e00-\\u9fff\]\/\.test\(stripTFallback\(line\)\)\)/.test(ciSource));
    // 豁免收紧：t() 查不到键时返回键名本身（非空 truthy），`|| 兜底` 永远不触发，
    // 屏幕上出现的是裸 key。所以只有键确实存在于语言包时才允许豁免。
    check('ci-check I8 only exempts the fallback when the t() key exists in the packs',
        /const missingKeys = \[\]/.test(ciSource) &&
        /tKeysOnLine\(line\)\.filter\(\(k\) => !packKeys\.has\(k\)\)/.test(ciSource) &&
        /missingKeys\.length > 0/.test(ciSource));

    if (stripMatch) {
        // 箭头函数体是隐式返回的 `line\n .replace(..).replace(..)`，抽出来单独编译时要补回 line
        // eslint-disable-next-line no-new-func
        const stripTFallback = new Function('line', 'return line' + stripMatch[1]);
        const stillHasCjk = (line) => /[\u4e00-\u9fff]/.test(stripTFallback(line));
        const exempt = [
            ["if (label) label.textContent = this.t('lsp.disabledLabel', null, 'LSP 已禁用');"],
            ["lspItem.title = this.t('k', null, '兜底文案');"],
            ["x = window.i18n.t('monaco.contextMenuPaste', null, '粘贴');"],
            ["y = t('message.newFile', null, '新文件');"],
            ["z = this.t('message.cloudFileLocalOnly', { feature: f }, '请先下载 {feature}');"],
            ["if (label) label.textContent = this.t('lsp.disabledLabel');"],
            // 可选链形式（存量收敛后 this.t 展开成的写法）
            ["label.textContent = window.i18n?.t?.('lsp.disabledLabel', null) || 'LSP 已禁用';"],
            ["loader.innerHTML = '<div>' + (window.i18n?.t?.('pdfViewer.loading') || 'PDF 加载中…') + '</div>';"],
            ["x = i18n?.t?.('a.b');"],
            ["this.showMessage(window.i18n?.t?.('k', null) || '兜底', 'info');"],
        ];
        const stillCounted = [
            ["el.textContent = '编译成功';"],
            ["throw new Error('无效的路径');"],
            ["el.textContent = '编译中'; el.title = this.t('k', null, '兜底');"],
            ["this.showMessage(this.t('k', null, '兜底') + '附加中文');"],
            // 可选链之外仍有中文时必须照计
            ["el.title = window.i18n?.t?.('a.b') + '后缀中文';"],
            ["this.showMessage(window.i18n?.t?.('k', null) || '兜底', '硬编码提示');"],
        ];
        const badExempt = exempt.filter(([line]) => stillHasCjk(line));
        check('I8 exempts a Chinese literal that only lives in a t() fallback',
            badExempt.length === 0, badExempt.map(([l]) => l).join(' | '));
        const missed = stillCounted.filter(([line]) => !stillHasCjk(line));
        check('I8 still counts genuinely hardcoded user-visible CJK',
            missed.length === 0, missed.map(([l]) => l).join(' | '));
    }
}

// --- window.i18n.t() / window.__ 只接受两个参数 -------------------------------
// i18n.js:103 的 t(key, params) 和 i18n.js:318 的 window.__ 都没有第三个形参，
// 而 renderer/main.js:52 与 compile-manager.js:3 自己包的 t(key, params, fallback)
// 有。照着 this.t 的习惯给 window.i18n.t 多传一个兜底文案，不会报错、也不会生效，
// 只是让"i18n 不可用时显示中文"这个保险静默失效。历史上已经犯过一次。
{
    const getAllJs = (dir, out = []) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) getAllJs(full, out);
            else if (entry.name.endsWith('.js')) out.push(full);
        }
        return out;
    };
    const scanFiles = getAllJs(path.join(root, 'src')).filter((f) => !f.startsWith(langDir));

    // 数出一次调用的顶层实参个数
    const countArgs = (args) => {
        let depth = 0, count = 1, inStr = null;
        for (let i = 0; i < args.length; i++) {
            const c = args[i];
            if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
            if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
            if ('([{'.includes(c)) depth++;
            else if (')]}'.includes(c)) { if (depth === 0) return count; depth--; }
            else if (c === ',' && depth === 0) count++;
        }
        return count;
    };

    const twoParamCallRe = /\bwindow\s*\.\s*(?:i18n\s*\.\s*t|__)\s*\(/g;
    const overlong = [];
    for (const f of scanFiles) {
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
            for (const m of line.matchAll(twoParamCallRe)) {
                if (countArgs(line.slice(m.index + m[0].length)) > 2) {
                    overlong.push(`${path.relative(root, f)}:${i + 1} -> ${line.trim().slice(0, 90)}`);
                }
            }
        });
    }
    check('no window.i18n.t()/window.__() call passes a third argument', overlong.length === 0,
        overlong.slice(0, 5).join(' | '));

    // 反向锁定前提：window.i18n.t 确实只有两个形参。
    // 另锁定本轮收敛的成果：类上不再提供三参的 this.t，渲染层也不再调 this.t / window.__。
    const i18nSource2 = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'i18n.js'), 'utf8');
    check('premise: I18nManager.t takes exactly (key, params)', /^\s{4}t\(key, params\) \{/m.test(i18nSource2));

    const legacyThisT = [];
    for (const f of scanFiles) {
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
            if (/\bthis\s*\.\s*t\s*\(/.test(line) && !f.endsWith(path.join('renderer', 'js', 'i18n.js'))) {
                legacyThisT.push(`${path.relative(root, f)}:${i + 1}`);
            }
            if (/\bwindow\s*\.\s*__\s*\(/.test(line)) legacyThisT.push(`${path.relative(root, f)}:${i + 1} (window.__)`);
        });
    }
    check('no this.t() / window.__() call sites remain in the renderer', legacyThisT.length === 0,
        legacyThisT.slice(0, 5).join(' | '));

    // 局部 const t 别名是允许的（模板字符串里写全路径太啰嗦），但必须包 window.i18n
    const badAlias = [];
    for (const f of scanFiles) {
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            const m = /^\s*const t = (.+);$/.exec(line);
            if (!m) return;
            if (!/window\.i18n\?\.t\?\./.test(m[1])) badAlias.push(`${path.relative(root, f)}:${i + 1} -> ${m[1].slice(0, 60)}`);
        });
    }
    check('every local "const t =" alias wraps window.i18n.t', badAlias.length === 0, badAlias.slice(0, 4).join(' | '));
}

// --- 死兜底：`t(...) || '文案'` 不得回流 ---------------------------------------
// 缺键时 t() 返回 key 本身（非空 truthy），所以 `|| 兜底` 永远不会触发。
// 这些兜底全是英文，而项目默认语言是 zh-cn —— 它们不仅没用，坏掉时还会把
// 中文用户误导到英文界面上，且让人误以为「这里有可用兜底」。
// 唯一允许的是别名定义里的 `|| key`（AGENTS.md 许可的形态，同时兜住
// window.i18n 整个缺失的情况）。
{
    const getAllJs3 = (dir, out = []) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) getAllJs3(full, out);
            else if (entry.name.endsWith('.js')) out.push(full);
        }
        return out;
    };

    // 从 t( 的左括号起配对，模拟运行时才知道右括号在哪，再用它判断后面是不是 ||
    const strEnd = (src, i) => {
        const q = src[i];
        let j = i + 1;
        while (j < src.length) {
            if (src[j] === '\\') { j += 2; continue; }
            if (src[j] === q) return j + 1;
            j++;
        }
        return -1;
    };
    const tplEnd = (src, i) => {
        let j = i + 1;
        while (j < src.length) {
            if (src[j] === '\\') { j += 2; continue; }
            if (src[j] === '`') return j + 1;
            if (src[j] === '$' && src[j + 1] === '{') {
                let d = 1; j += 2;
                while (j < src.length && d) {
                    if (src[j] === '`') { j = tplEnd(src, j); continue; }
                    if (src[j] === '{') { d++; j++; continue; }
                    if (src[j] === '}') { d--; j++; continue; }
                    if (src[j] === "'" || src[j] === '"') { j = strEnd(src, j); continue; }
                    j++;
                }
                continue;
            }
            j++;
        }
        return -1;
    };

    const callRe = /window\.i18n\??\.t\??\.\s*\(/g;
    const deadFallback = [];
    for (const f of getAllJs3(path.join(root, 'src'))) {
        if (f.startsWith(langDir)) continue;
        const src = fs.readFileSync(f, 'utf8');
        const lines = src.split('\n');
        callRe.lastIndex = 0;
        let m;
        while ((m = callRe.exec(src)) !== null) {
            const lp = src.indexOf('(', m.index + m[0].length - 1);
            let d = 0, j = lp, s = null;
            for (; j < src.length; j++) {
                const c = src[j];
                if (s) { if (c === '\\') { j++; continue; } if (c === s) s = null; continue; }
                if (c === '"' || c === "'") { s = c; continue; }
                if (c === '`') { j = tplEnd(src, j) - 1; continue; }
                if (c === '(') d++;
                else if (c === ')') { d--; if (!d) { j++; break; } }
            }
            const tail = src.slice(j);
            const om = /^\s*\|\|\s*/.exec(tail);
            if (!om) continue;
            const line = src.slice(0, m.index).split('\n').length;
            const lineText = lines[line - 1];
            // 别名定义豁免：const _t = (k) => ... || k / const t = (key, params) => ... || key
            const isAlias = /^\s*(?:const|let|var)\s+\w+\s*=\s*\(/.test(lineText) || /\b_t\s*=/.test(lineText);
            const q = tail[om[0].length];
            if (isAlias && (q === 'k' || /^key\b/.test(tail.slice(om[0].length)))) continue;
            deadFallback.push(`${path.relative(root, f)}:${line} -> ${tail.slice(om[0].length, om[0].length + 30).trim()}`);
        }
    }
    check('no dead `t(...) || <literal>` fallback remains', deadFallback.length === 0,
        deadFallback.slice(0, 5).join(' | '));
}

// --- 孤儿键 ratchet ------------------------------------------------------------
// 语言包里有、源码里查不到任何引用的键。只锁死不许增长，存量暂留（人工清理时
// 每清掉一批就把 ci-check 里的 I18N_ORPHAN_KEY_BASELINE 调低一档）。
// 口径用"源码任意位置出现过的 dotted 字面量"而非 t('key')，后者认不出
// t(c ? 'a' : 'b') / _t(key, fb) / t(el.dataset.i18n) 这类动态查表。
{
    const getAllJs2 = (dir, out = []) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) getAllJs2(full, out);
            else if (/\.(js|html)$/.test(entry.name)) out.push(full);
        }
        return out;
    };
    const corpus = getAllJs2(path.join(root, 'src'))
        .filter((f) => !f.startsWith(langDir))
        .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const mentioned = new Set();
    for (const m of corpus.matchAll(/['"]([a-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)['"]/g)) mentioned.add(m[1]);
    // 属性访问同样算引用（main.js:3617 用 content.meta.code 读语言列表）
    for (const m of corpus.matchAll(/\.([a-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)/g)) mentioned.add(m[1]);

    const zhFlat2 = packs['zh-cn'];
    const orphans = Object.keys(zhFlat2).filter((k) => !mentioned.has(k));

    const ciSource2 = fs.readFileSync(path.join(root, 'scripts', 'ci-check.js'), 'utf8');
    const baselineMatch = /const I18N_ORPHAN_KEY_BASELINE = (\d+);/.exec(ciSource2);
    check('ci-check defines the orphan-key ratchet baseline', !!baselineMatch);
    if (baselineMatch) {
        const baseline = Number(baselineMatch[1]);
        check(`orphaned i18n keys do not exceed the ratchet baseline (${orphans.length} <= ${baseline})`,
            orphans.length <= baseline, orphans.length > baseline ? orphans.slice(0, 8).join(', ') : '');
    }
    // 防呆：口径写错（比如正则退化成匹配不到任何东西）会静默变成 0 < baseline 而恒绿
    check('the orphan detector actually finds dotted literals', mentioned.size > 500, `${mentioned.size} literals`);
}

// --- 所有静态引用的 key 都能解析 ---------------------------------------------
{
    const walk = (dir, out = []) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, out);
            else if (/\.(js|html)$/.test(entry.name)) out.push(full);
        }
        return out;
    };

    const callRe = /\b(?:i18n|i18next|__|this)\s*\.\s*t\s*\(\s*['"]([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)['"]/g;
    const bareCallRe = /(?<![.\w])t\s*\(\s*['"]([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)['"]/g;
    const attrRe = /data-i18n(?:-[a-z]+)?\s*=\s*['"]([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)['"]/g;

    const referenced = new Set();
    for (const f of walk(path.join(root, 'src'))) {
        if (f.startsWith(langDir)) continue;
        const content = fs.readFileSync(f, 'utf8');
        for (const re of [callRe, bareCallRe, attrRe]) {
            for (const m of content.matchAll(re)) referenced.add(m[1]);
        }
    }
    check('the source tree actually references translation keys', referenced.size > 0, `${referenced.size} keys`);

    for (const [code, pack] of Object.entries(packs)) {
        const missing = [...referenced].filter((k) => pack[k] === undefined);
        check(`all ${referenced.size} referenced keys resolve in ${code}.json`, missing.length === 0, missing.slice(0, 8).join(', '));
    }
}

// --- 渲染层查表 / 插值契约 ---------------------------------------------------
// 渲染层的 t() 现已委托 i18next（src/renderer/js/i18n.js）。这里用真实 i18next
// 实例跑真实语言包来验证契约，而不是对源码做正则匹配——旧版断言匹配的是手写
// `_getNested` 与 `value.replace(/\{(\w+)\}/g, …)`，内核交给 i18next 后必然失效。
// 真正要守住的是「界面行为」：查得到、缺 key 返 key 本身、漏参数保持 {token} 可见。
{
    const i18nSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'i18n.js'), 'utf8');
    const enPack = JSON.parse(fs.readFileSync(path.join(langDir, 'en.json'), 'utf8'));

    // 契约：渲染层已接 i18next，且配置与主进程 lang/index.js 保持一致
    check('renderer delegates lookup to i18next', i18nSource.includes('i18next.t('));
    check('renderer configures the {token} placeholder syntax',
        /interpolation:\s*\{\s*prefix:\s*'\{',\s*suffix:\s*'\}'\s*\}/.test(i18nSource));
    check('renderer loads the current language over IPC',
        i18nSource.includes('getLanguageFile') && i18nSource.includes('addResourceBundle'));
    // 兜底语言交给 i18next 的 fallbackLng，不再自持 _fallbackMessages
    check('renderer relies on i18next for fallback instead of a private pack',
        i18nSource.includes('fallbackLng') && !i18nSource.includes('_fallbackMessages'));
    // 手写内核必须真的删干净，避免两套实现并存
    check('the hand-rolled nested lookup is gone', !i18nSource.includes('_getNested'));
    check('window.__ is no longer exposed', !/window\.__\s*=/.test(i18nSource));

    // 以下用真实 i18next + 真实语言包验证行为（与渲染层同一份 UMD）
    const I18nProbe = require(path.join(root, 'node_modules', 'i18next'));
    const missingKeySample = 'definitely.not.a.real.key';

    if (typeof I18nProbe.init === 'function') {
        const instance = I18nProbe.createInstance();
        instance.init({
            lng: 'en',
            fallbackLng: 'zh-cn',
            resources: { en: { translation: enPack }, 'zh-cn': { translation: {} } },
            interpolation: { prefix: '{', suffix: '}' },
            returnNull: false,
            returnEmptyString: false,
            parseMissingKeyHandler: (key) => key,
        });

        // 契约：缺 key 时返回 key 本身（而不是空串或 undefined），这样漏查能一眼看见
        check('i18next returns the key itself for unknown keys', instance.t(missingKeySample) === missingKeySample);
        check('i18next resolves a real dotted key', instance.t('browser.reload') === enPack.browser.reload);
        check('i18next resolves a nested dotted key', instance.t('settings.language') === enPack.settings.language);

        // 契约：漏传的 {token} 保持原样，方便肉眼发现漏传参数（i18next 默认行为）
        const phKey = Object.keys(packs.en).find((k) => (packs.en[k].match(/\{\w+\}/g) || []).length >= 2);
        if (phKey) {
            const tokens = packs.en[phKey].match(/\{\w+\}/g).map((s) => s.slice(1, -1));
            const partial = instance.t(phKey, { [tokens[0]]: 'X' });
            check('i18next keeps an unprovided {token} visible',
                partial.includes(`{${tokens[1]}}`), `${phKey} -> ${partial}`);

            const full = instance.t(phKey, Object.fromEntries(tokens.map((tk) => [tk, 'X'])));
            check('i18next substitutes every provided token',
                !/\{\w+\}/.test(full), `${phKey} -> ${full}`);
        } else {
            check('language pack exposes a key with 2+ tokens to probe', false, 'no candidate found');
        }
    } else {
        check('i18next UMD/cjs entry is resolvable from node_modules', false);
    }
}

// --- 主进程 i18next 接线 -----------------------------------------------------
{
    const langIndex = fs.readFileSync(path.join(langDir, 'index.js'), 'utf8');
    const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    check('main-process i18next instance is created', langIndex.includes('i18next.init'));
    check('main-process exposes the documented instance API',
        ['t', 'getCurrentLanguage', 'setLanguage', 'getAvailableLanguages'].every((fn) => langIndex.includes(`${fn}:`)));

    // 设置变更后必须重建原生菜单，否则语言切换对菜单栏无效
    const rebuildTriggers = [...mainSource.matchAll(/createMenuBar\(\)/g)];
    const keybindingGate = /hasOwnProperty\.call\([^)]*'keybindings'\)\)\s*\{\s*\n?\s*createMenuBar\(\)/.test(mainSource);
    check('application menu is rebuilt when keybindings change', keybindingGate, `${rebuildTriggers.length} call site(s)`);
}

console.log(`i18n tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
