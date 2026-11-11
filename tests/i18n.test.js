'use strict';

// i18n 契约回归测试：锁定语言包结构与 renderer 查表行为，
// 防止批量正则替换（历史上出现过 `= ('key')` 这类静默空操作）再次悄悄破坏界面。

const fs = require('fs');
// 复数形态的归一口径必须和 scripts/ci-check.js 用的是同一份实现，
// 否则「测试说一致、CI 说不一致」这类分歧迟早出现（本仓库已经踩过两次）。
const plural = require('../scripts/i18n-plural');
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
    const enLogical = [...plural.indexPack(packs.en).logical.keys()];
    const zhLogical = new Set(plural.indexPack(packs['zh-cn']).logical.keys());
    const missingInZh = enLogical.filter((k) => !zhLogical.has(k));
    const missingInEn = [...zhLogical].filter((k) => !plural.indexPack(packs.en).logical.has(k));
    check('en.json and zh-cn.json have identical logical key sets', missingInZh.length === 0 && missingInEn.length === 0,
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
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue;
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
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue;
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

    // 局部别名 `const t = (key, params) => ...` 后的**裸 t() 调用**同样只有两个形参。
    // 历史教训：把别名的形参从三参缩成两参时漏改了调用处，40 处第三参被静默丢弃
    // —— 不报错、界面正常、CI 全绿，只有读代码才知道那是死代码。
    // 上面的守卫只认 `window.i18n.t(` / `window.__(`，看不见裸 `t(`，故此处单独守。
    // 用括号配对而非正则：`t('k', {a:1}, \`x, ${y}\`)` 里的逗号会骗过正则。
    {
        const splitTopArgs = (s) => {
            const parts = []; let cur = '', d = 0, q = null;
            for (let i = 0; i < s.length; i++) {
                const c = s[i];
                if (q) { cur += c; if (c === '\\') { cur += s[++i] || ''; continue; } if (c === q) q = null; continue; }
                if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
                if ('([{'.includes(c)) d++;
                else if (')]}'.includes(c)) d--;
                if (c === ',' && d === 0) { parts.push(cur); cur = ''; continue; }
                cur += c;
            }
            parts.push(cur);
            return parts;
        };
        const closeParenOf = (line, openIdx) => {
            let d = 0, q = null;
            for (let i = openIdx; i < line.length; i++) {
                const c = line[i];
                if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
                if (c === "'" || c === '"' || c === '`') { q = c; continue; }
                if ('([{'.includes(c)) d++;
                else if (')]}'.includes(c)) { d--; if (d === 0) return i; }
            }
            return -1;
        };
        // 裸 t(：前面不是 . 或标识符字符（排除 window.i18n.t( / obj.t(）
        const bareTRe = /(?<![.\w$])t\s*\(/g;
        const bareOverlong = [];
        for (const f of scanFiles) {
            fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
                if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
                for (const m of line.matchAll(bareTRe)) {
                    const open = m.index + m[0].length - 1;
                    const close = closeParenOf(line, open);
                    if (close === -1) continue;
                    const args = splitTopArgs(line.slice(open + 1, close));
                    if (args.filter((a) => a.trim()).length > 2) {
                        bareOverlong.push(`${path.relative(root, f)}:${i + 1} -> ${line.trim().slice(0, 90)}`);
                    }
                }
            });
        }
        check('no bare t() alias call passes a third argument', bareOverlong.length === 0,
            bareOverlong.slice(0, 5).join(' | '));

        // 反向锁定前提：确实存在两参局部别名调用，否则上面的守卫可能恒绿。
        const bareTCalls = scanFiles.reduce((n, f) => {
            const src = fs.readFileSync(f, 'utf8');
            return n + [...src.matchAll(/(?<![.\w$])t\s*\(\s*['"`][a-zA-Z]/g)].length;
        }, 0);
        check('the bare t() guard has real call sites to inspect', bareTCalls > 50, `${bareTCalls} call sites`);
    }

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
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue;
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
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue;
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
    // 与 I7 同口径：按逻辑键统计，复数形态的一支被引用即算整键被引用
    const mentionedLogical = plural.mentionedLogical(mentioned);
    const orphans = [...plural.indexPack(zhFlat2).logical.keys()].filter((k) => !mentionedLogical.has(k));

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
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'lib') continue;
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
        // 必须用复数感知的解析：源码写 t('compare.completedText', {count})，而 zh 包里
        // 只有 _other —— 拿 pack[k] 直查会把已归一的复数键全报成缺失。
        const index = plural.indexPack(pack);
        const missing = [...referenced].filter((k) => !plural.resolvesKey(index, k));
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
        // 只看 prefix/suffix 这两个键在不在，不管后面还挂了别的配置项。
        // 不能用 /\{[^}]*\}/ 去框整个对象：suffix 的值就是 '}'，非配平正则会在它这里
        // 截断，于是加了 escape 之后这条会假红（实测踩过）。lookahead 限定窗口最稳。
        /interpolation:\s*\{(?=[\s\S]{0,160}prefix:\s*'\{')(?=[\s\S]{0,160}suffix:\s*'\}')/.test(i18nSource));
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

// ---- I4 的「中文标点」判据：弯引号不是中文标点 --------------------------------
// 这条判据原先把 U+201C/201D/2018/2019 也算中文标点，于是 en.json 里那句
// “字体未找到” 的英文文案被冤枉成违规，ratchet 一直挂着 1 这个没人解释的档位。
// 降回 0 的前提是去掉这四个码位之后判别力没丢 —— 下面正反两组用例就是钉这个的。
{
    const ciSrc4 = fs.readFileSync(path.join(root, 'scripts', 'ci-check.js'), 'utf8');
    const punctDecl = /const cnPunctRe = (\/[^;]+\/);/.exec(ciSrc4);
    check('I4 的中文标点判据能抽出来（抽不到下面全是空转）', !!punctDecl, punctDecl && punctDecl[1].slice(0, 70));
    if (punctDecl) {
        const cnPunctRe = new Function('return ' + punctDecl[1])();
        const mustFlag = [
            '端口已被占用，请换一个',     // 全角逗号
            '字体「宋体」不存在',         // 直角引号
            '第（1）项',                 // 全角括号
            '状态：空闲',                 // 全角冒号
            '一、二、三',                 // 顿号
            '保存失败。请重试',           // 全角句号
        ];
        const mustNotFlag = [
            'The font \u201c{font}\u201d was not found and has been replaced with \u201c{fallback}\u201d',
            'It\u2019s already running',
            'Delete \u201ca.cpp\u201d now?',
            'Truncated\u2026 see log',   // 省略号本来就豁免
        ];
        for (const probe of mustFlag) {
            check('I4 中文标点仍能判出 ' + JSON.stringify(probe).slice(0, 24), cnPunctRe.test(probe) === true, probe);
        }
        for (const probe of mustNotFlag) {
            check('I4 不误判英文排版引号/省略号：' + JSON.stringify(probe).slice(0, 26), cnPunctRe.test(probe) === false, probe);
        }
        // 真 en 包必须一处都不剩 —— baseline 0 不是喊出来的
        const enHits = Object.entries(packs.en).filter(([, v]) => cnPunctRe.test(String(v)));
        check('en.json 真包里中文标点为 0（这才允许 baseline 降到 0）',
            enHits.length === 0, enHits.map(([k]) => k).join(','));
        // 汉字本身由另一条 enCjk 兜住，所以去掉弯引号不会放过混中文的条目
        const ideographRe = /[\u4e00-\u9fff]/;
        check('混了汉字的 en 文案仍被「不许有汉字」那条抓住（判据分工没漏）',
            ideographRe.test('字体 “宋体” 未找到') === true, '');
    }
}

// --- I8b（硬编码英文）不得被悄悄放宽 -----------------------------------------
// I8b 与 I8 一样是 ratchet：baseline 0，含义是「现在一处都不许有」。它比 I8 更依赖
// 一串豁免规则（开发者诊断、机器可读载荷、判别字段回看）—— 任何一条被无意删掉或
// 放宽，检查就会从「零容忍」退化成「几乎不查」，而 PASS 看起来完全一样。
// 这里把三条豁免的存在性与 baseline 的 0 锁死。
{
    // 归一化成 LF：本块的正则按 \n 切分（\n}\n、\n {2}\};\n），CRLF 下这些模式
    // 在整个文件里一次都不会出现，断言会因「块不可提取」而空转 —— 失败点离真正的问题很远。
    const ciSrc2 = fs.readFileSync(path.join(root, 'scripts', 'ci-check.js'), 'utf8').replace(/\r\n/g, '\n');

    check('ci-check defines the hardcoded-English baseline', /const I18N_HARDCODED_EN_BASELINE = (\d+);/.test(ciSrc2));
    const enBase = /const I18N_HARDCODED_EN_BASELINE = (\d+);/.exec(ciSrc2);
    check('hardcoded-English baseline stays at 0', !!enBase && enBase[1] === '0', enBase ? enBase[1] : 'missing');

    // I8b 段落存在
    check('ci-check runs an I8b hardcoded-English check', /\[I8b\] Hardcoded English prose ratchet/.test(ciSrc2));

    // 三条豁免各自还在（它们是把误报压到 0 的关键，删一条就会冒出一片假阳性）
    check('I8b keeps the developer-diagnostic exemption',
        /devDiagnosticRe = \/.*throw\\s\+new\?\\s\*Error/.test(ciSrc2));
    check('I8b keeps the machine-readable payload exemption',
        /payloadRe = \/[^\n]*writeJson/.test(ciSrc2) && /payloadRe = \/[^\n]*res\\\.end/.test(ciSrc2));
    check('I8b keeps the discriminator lookback for multi-line payloads',
        /DISCRIMINATOR_LOOKBACK = (\d+);/.test(ciSrc2) && Number(/DISCRIMINATOR_LOOKBACK = (\d+);/.exec(ciSrc2)[1]) >= 3);

    // 散文识别的收窄条件还在 —— 这是把标识符/路径/CSS 类名挡在外面的那几条
    for (const [name, re] of [
        ['rejects single-token identifiers', /if \(words\.length < 2\) return false;/],
        ['rejects paths and URLs', /if \(\/\[\/\\\\\]\/\.test\(s\)\) return false;/],
        ['rejects file names', /\.\(js\|html\|css\|json\|png\|txt\|exe\|zip\)/],
        ['requires >=2 words of >=3 letters', /\[A-Za-z\]\{3,\}/]
    ]) {
        check(`I8b prose detection ${name}`, re.test(ciSrc2));
    }

    // 行为验证：把 I8b 真正的判定函数抠出来实跑，证明启发式既不恒绿也不过宽。
    // 只断言源码形态是不够的 —— 本轮已经吃过「断言 PASS 但检查空转」的亏。
    const enSection = /\[I8b\] Hardcoded English prose ratchet[\s\S]*?\n}\n/.exec(ciSrc2);
    check('I8b block is extractable for behavioural testing', !!enSection);
    if (enSection) {
        // 抠出 looksLikeProse 整个函数体
        const fnSrc = /const looksLikeProse = \(s\) => \{[\s\S]*?\n {2}\};\n/.exec(enSection[0]);
        check('I8b looksLikeProse is extractable', !!fnSrc);
        if (fnSrc) {
            // eslint-disable-next-line no-new-func
            const looksLikeProse = new Function('return (' + fnSrc[0].replace(/^const looksLikeProse = /, '').replace(/;\n$/, '') + ')')();
            // 应命中：真实界面文案（含刚修掉的 tabs.js 那条）
            for (const s of ['Markdown API not available', 'File system is temporarily unavailable',
                'The compiler path is invalid', 'Failed to generate drag image data URL']) {
                check(`I8b flags hardcoded English: ${JSON.stringify(s).slice(0, 40)}`, looksLikeProse(s) === true);
            }
            // 不应命中：标识符、CSS 类名、路径、URL、MIME、枚举、format token
            for (const s of ['success', 'dialog-btn dialog-btn-cancel', 'src/main.js',
                'https://example.com/a', 'text/plain', 'CONTENT_TYPE', '{count} items',
                'compileOutput.alreadyRunning', 'node-pty']) {
                check(`I8b ignores non-prose: ${JSON.stringify(s).slice(0, 40)}`, looksLikeProse(s) === false);
            }
        }
    }
}

// ---- 复数归一口径自身必须能咬（否则 I2 那句 PASS 是空集上的假绿）----------
{
    const issuesOf = (code, flat) => plural.pluralIssues(code, plural.indexPack(flat));
    check('非复数包不产生任何复数问题（对照组）',
        issuesOf('en', { 'a.one': 'x', 'b.two': 'y' }).length === 0,
        JSON.stringify(issuesOf('en', { 'a.one': 'x', 'b.two': 'y' })));
    // en 的 PluralRules 要 one+other；只给 other 就是漏译
    const enMissing = issuesOf('en', { 'x_other': 'x' });
    check('en 缺 _one 被判为漏译', enMissing.some((m) => /缺少必需的复数类别 _one/.test(m)), JSON.stringify(enMissing));
    // zh 只有 other，多写 _one 是永远取不到的死键
    const zhExtra = issuesOf('zh-cn', { 'x_other': 'x', 'x_one': 'x' });
    check('zh 多写 _one 被判为死键', zhExtra.some((m) => /多余的复数类别 _one/.test(m)), JSON.stringify(zhExtra));
    // 裸基名与复数形态并存时运行时取值不明
    const ambiguous = issuesOf('en', { x: 'plain', x_one: 'a', x_other: 'b' });
    check('基名与复数形态并存被判为取值不明', ambiguous.some((m) => /并存/.test(m)), JSON.stringify(ambiguous));
    // 逻辑键归一：en 的 _one/_other 折回同一个 x，才能和 zh 的 _other 对齐
    const enIdx = plural.indexPack({ x_one: '1 file', x_other: '{count} files' });
    const zhIdx = plural.indexPack({ x_other: '{count} 个文件' });
    check('复数形态折回同一逻辑键，两包逻辑键集因此仍然一致',
        JSON.stringify([...enIdx.logical.keys()]) === JSON.stringify([...zhIdx.logical.keys()]),
        JSON.stringify([...enIdx.logical.keys()]) + ' vs ' + JSON.stringify([...zhIdx.logical.keys()]));
    // I6 等价：源码引用基名，包里只有带后缀形态，必须算可解析
    check('I6 口径：引用基名而包里只有 _one/_other 时不算缺键',
        plural.resolvesKey(enIdx, 'x') === true && plural.resolvesKey(enIdx, 'y') === false,
        JSON.stringify([...enIdx.logical.keys()]));
    // 归一口径必须跟 i18next 一致，而不是自创更宽的特例：引擎本来就按叶子的
    // _one/_two/_few/_many/_other/_zero 后缀识别复数形态，所以以一个复数类别词
    // 结尾的键**就是**复数形态。这条不是「别误折」的保护，而是一条命名约束：
    // 不许拿 foo_other 这种名字当普通文案键用（引擎会按复数去找 foo_one）。
    check('叶子以复数类别词结尾即视为复数形态（与 i18next 同口径）',
        plural.splitPlural('a.other_two').category === 'two'
            && plural.splitPlural('a.other_two').base === 'a.other'
            && plural.splitPlural('a.count').category === null,
        JSON.stringify(plural.splitPlural('a.other_two')));
}

// ---- 复数支的 {token} 只能少不能多：这条也必须能咬 -----------------------
// 真 packs 已由 CI 的 I2 覆盖，这里守的是判定函数本身 —— 它一旦写反方向
// （把「少用 token」也判成错），改文案时会一片红而没人知道为什么。
{
    const idx = (o) => plural.indexPack(o);
    const tokensOf = (indexes) => plural.pluralTokenIssues(indexes);
    check('正常复数键（各支 token 一致）不算问题（对照组）',
        tokensOf({
            'zh-cn': idx({ x_other: '有 {count} 个' }),
            en: idx({ x_one: '{count} item', x_other: '{count} items' }),
        }).length === 0,
        JSON.stringify(tokensOf({
            'zh-cn': idx({ x_other: '有 {count} 个' }),
            en: idx({ x_one: '{count} item', x_other: '{count} items' }),
        })));
    // 单数句丢掉 {count} 是合法写法（"Delete this item?"），不许报
    const dropped = tokensOf({
        'zh-cn': idx({ x_other: '确定删除这 {count} 项吗？{preview}' }),
        en: idx({ x_one: 'Delete this item? {preview}', x_other: 'Delete these {count} items? {preview}' }),
    });
    check('复数支少用 token 不判错（只查「多出来」这个方向）',
        dropped.length === 0, JSON.stringify(dropped));
    // 反过来：单数句引入 zh 的 _other 没有的 token，调用点不会传它 → 屏上留 {name}
    const invented = tokensOf({
        'zh-cn': idx({ x_other: '有 {count} 个' }),
        en: idx({ x_one: 'Only {name} left', x_other: '{count} items left' }),
    });
    check('复数支引入默认语言没有的 token 被判错',
        invented.some((m) => m.includes('x_one') && m.includes('{name}')), JSON.stringify(invented));
    // 非复数键的 token 对齐归 I3 逐字面键管，这条不许把它们也扫进来
    check('非复数键不由这条负责（对照组）',
        tokensOf({ 'zh-cn': idx({ 'a.b': '{one}' }), en: idx({ 'a.b': '{two}' }) }).length === 0,
        JSON.stringify(tokensOf({ 'zh-cn': idx({ 'a.b': '{one}' }), en: idx({ 'a.b': '{two}' }) })));
    // 默认语言里没有参照 _other 时只能跳过，不能崩、也不能瞎报
    check('默认语言缺该键时静默让位（缺键由 I2 报，不重复报）',
        tokensOf({ 'zh-cn': idx({ unrelated: 'x' }), en: idx({ x_one: '{name}', x_other: '{count}' }) }).length === 0,
        JSON.stringify(tokensOf({ 'zh-cn': idx({ unrelated: 'x' }), en: idx({ x_one: '{name}', x_other: '{count}' }) })));
    const realIndexes = {};
    for (const [code, flat] of Object.entries(packs)) if (flat) realIndexes[code] = idx(flat);
    const realTokens = tokensOf(realIndexes);
    check(`真语言包通过复数 {token} 方向检查（${Object.keys(realIndexes).length} 份）`,
        realTokens.length === 0, realTokens.join(' | '));
}

// ---- 半转换必须抓得到：只改一份包会让上面两条守卫同时失明 ----------------
{
    const idx = (o) => plural.indexPack(o);
    const consist = (indexes) => plural.pluralConsistencyIssues(indexes);
    const both = {
        'zh-cn': idx({ x_other: '有 {count} 个' }),
        en: idx({ x_one: '{count} item', x_other: '{count} items' }),
    };
    check('两份都正确复数化 → 无半转换（对照组）', consist(both).length === 0, JSON.stringify(consist(both)));
    check('两份都还是裸基名（压根没复数化）→ 不归这条管', consist({
        'zh-cn': idx({ x: '有 {count} 个' }),
        en: idx({ x: '{count} items' }),
    }).length === 0, JSON.stringify(consist({ 'zh-cn': idx({ x: 'x' }), en: idx({ x: 'x' }) })));

    const half = {
        'zh-cn': idx({ x: '有 {count} 个' }),
        en: idx({ x_one: '{count} item', x_other: '{count} items' }),
    };
    const halfIssues = consist(half);
    check('只转换了 en、zh 留裸基名 → 判半转换', halfIssues.some((m) => m.includes('x')), JSON.stringify(halfIssues));
    // 这条是新增守卫存在的全部理由：把「旧守卫看不见」这件事本身钉成断言，
    // 否则下一个人会以为 pluralTokenIssues 已经覆盖了这一形状。
    check('并且证明旧守卫对这个形状确实是瞎的（所以这条必须存在）',
        plural.pluralTokenIssues(half).length === 0
            && plural.pluralIssues('zh-cn', half['zh-cn']).length === 0,
        JSON.stringify({ tokens: plural.pluralTokenIssues(half), zhIssues: plural.pluralIssues('zh-cn', half['zh-cn']) }));
    // token 校验被跳过的实际代价：单数句里塞一个非法 token 也报不出来
    const halfSneaky = {
        'zh-cn': idx({ x: '有 {count} 个' }),
        en: idx({ x_one: 'Only {name} left', x_other: '{count} items' }),
    };
    check('半转换时非法 token 能从 pluralTokenIssues 脚下滑过去（记录盲区，不是新守卫的）',
        plural.pluralTokenIssues(halfSneaky).length === 0
            && consist(halfSneaky).length > 0,
        JSON.stringify({ tokens: plural.pluralTokenIssues(halfSneaky), consist: consist(halfSneaky) }));
    check('反向半转换同样判（zh 拆了、en 留裸基名）', consist({
        'zh-cn': idx({ x_other: '有 {count} 个' }),
        en: idx({ x: '{count} items' }),
    }).length > 0);
    // 整键在一边完全没有 → I2 缺键检查负责，这里不许重复报
    check('整键缺失由 I2 报，这条不重复报', consist({
        'zh-cn': idx({ unrelated: 'x' }),
        en: idx({ x_one: 'a', x_other: 'b' }),
    }).length === 0, JSON.stringify(consist({ 'zh-cn': idx({ unrelated: 'x' }), en: idx({ x_one: 'a', x_other: 'b' }) })));
    const realPacks = {};
    for (const [code, flat] of Object.entries(packs)) if (flat) realPacks[code] = idx(flat);
    const realConsist = consist(realPacks);
    check('真语言包没有半转换的键', realConsist.length === 0, realConsist.join(' | '));
}

// ---- I9 的判定函数：复数键 + 调用点不传 count = 裸键上屏 ------------------
// 扫文件的部分在 ci-check.js（那边已实测能咬：把 t('tabs.closeAllConfirm', {count}) 改成
// {total} 就报出 file:line）。这里守的是判定函数本身与它的两种出口文案。
{
    const idx = (o) => plural.indexPack(o);
    const indexes = {
        'zh-cn': idx({ x_other: '有 {count} 个', plain: '普通文案' }),
        en: idx({ x_one: '{count} item', x_other: '{count} items', plain: 'plain' }),
    };
    const refs = (list) => plural.pluralCountIssues(indexes, list);
    check('复数键传了 count → 不报', refs([
        { key: 'x', kind: 't', hasCount: true, file: 'a.ts', line: 1 },
    ]).length === 0, JSON.stringify(refs([{ key: 'x', kind: 't', hasCount: true, file: 'a.ts', line: 1 }])));
    const missed = refs([{ key: 'x', kind: 't', hasCount: false, file: 'a.ts', line: 7 }]);
    check('复数键没传 count → 报，且带上 file:line 与键名（否则没法定位）',
        missed.length === 1 && missed[0].includes('a.ts:7') && missed[0].includes('x'),
        JSON.stringify(missed));
    check('非复数键不归这条管（对照组）', refs([
        { key: 'plain', kind: 't', hasCount: false, file: 'a.ts', line: 2 },
    ]).length === 0, JSON.stringify(refs([{ key: 'plain', kind: 't', hasCount: false, file: 'a.ts', line: 2 }])));
    const attrIssue = refs([{ key: 'x', kind: 'attr', hasCount: false, file: 'p.html', line: 3 }]);
    check('data-i18n 挂复数键时给的是 DOM 路径的修法（要 data-i18n-args，不是补 count:）',
        attrIssue.length === 1 && attrIssue[0].includes('data-i18n-args') && !attrIssue[0].includes('补 count:'),
        JSON.stringify(attrIssue));
}

console.log(`i18n tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
