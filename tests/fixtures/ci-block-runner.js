'use strict';

// 把 scripts/ci-check.js 里的**检查项裸块**抽出来，在 vm 里带着桩真跑一遍。
// 每条检查的本体都是 `{ … for (const f of files) … fail(…) }` 这种既不是函数也不是方法的结构，
// 想验证「这行代码到底会不会报」只有两个办法：在测试里重抄一份它的判据（会跟着源码漂移，
// 源码改了测试还绿着），或者整块真跑。这里走后者。
//
// 桩只给到「块真正用到的那几个外层名字」，少一个就当场 ReferenceError ——
// 宁可红在「桩不齐」上，也不要静默跳过一段检查。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');

// 语言包是嵌套 JSON，ci-check 里按 `前缀.键` 摊平后使用，这里保持同一口径。
const flatten = (obj, prefix = '', out = {}) => {
    for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
        else out[key] = v;
    }
    return out;
};

// 真语言包：豁免类检查的保护力全在「这个键是否真的存在」上，喂假包就等于自证。
const loadLocales = (codes = ['zh-cn', 'en']) => {
    const locales = {};
    for (const code of codes) {
        locales[code] = flatten(JSON.parse(fs.readFileSync(
            path.join(ROOT, 'src', 'lang', `${code}.json`), 'utf8')));
    }
    return locales;
};

// files: { 虚拟绝对路径: 文件内容 }。块里 `path.relative(root, f)` 出来的就是可读的定位串。
// opts.locales 缺省用真包；opts.baseline 缺省 0（想复现真实档位就把它传成 ci-check 里的常量）。
const runCiBlock = (blockSrc, files, opts = {}) => {
    const fails = [];
    const oks = [];
    const infos = [];
    const ctx = vm.createContext({
        Object, Array, String, Number, Boolean, Error, JSON, RegExp, Math, Set, Map, Symbol,
        isNaN, parseInt, parseFloat, Infinity, NaN, console, path,
        root: opts.root || '/proj',
        jsFiles: Object.keys(files),
        htmlFiles: opts.htmlFiles || [],
        readFile: (f) => (Object.prototype.hasOwnProperty.call(files, f) ? files[f] : null),
        locales: opts.locales === undefined ? loadLocales() : opts.locales,
        I18N_HARDCODED_CJK_BASELINE: opts.baseline === undefined ? 0 : opts.baseline,
        verbose: false,
        fail: (m) => { fails.push(String(m)); },
        ok: (m) => { oks.push(String(m)); },
        info: (m) => { infos.push(String(m)); }
    });
    vm.runInContext(blockSrc, ctx);
    return { fails, oks, infos };
};

module.exports = { flatten, loadLocales, runCiBlock, ROOT };
