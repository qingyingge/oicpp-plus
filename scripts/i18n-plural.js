'use strict';

// i18next 复数形态的归一规则，唯一实现。
//
// 为什么要有这个文件：i18next 的复数靠键名后缀（key_one / key_other），而每种语言
// 需要的类别由它自己的 Intl.PluralRules 决定 —— zh 只有 other，en 有 one+other。
// 于是「两份语言包键集必须完全一致」（I2）与复数天然不对称直接冲突。
//
// 解法不是放宽 I2，而是把它的作用域从「字面键集」改成「逻辑键集 + 每语言必须恰好
// 携带自己需要的类别」：漂移照样报，只是不再要求 zh 也去写一个永远用不到的 _one。
//
// I2/I3/I6/I7 与 tests/i18n.test.js 都必须从这里取，别各写一份 —— 本仓库已经两次
// 因为「两套口径」给出不同的数而误判（见 AGENTS.md 的静态 HTML 守卫那条）。

const PLURAL_CATEGORIES = Object.freeze(['zero', 'one', 'two', 'few', 'many', 'other']);

const SUFFIX_RE = new RegExp(`_(${PLURAL_CATEGORIES.join('|')})$`);

// 语言码到 Intl  locale 的映射：zh-cn 走 zh（否则 zh-CN 会被当成区域变体，
// 类别集合是一样的，但显式写出来避免以后加 zh-TW 之类时行为不明）。
const INTL_LOCALE = { 'zh-cn': 'zh', en: 'en' };

/** 拆一个扁平键为 {base, category}；不是复数形态时 category 为 null。 */
function splitPlural(key) {
    const lastDot = key.lastIndexOf('.');
    const leaf = key.slice(lastDot + 1);
    const m = SUFFIX_RE.exec(leaf);
    if (!m) return { base: key, category: null };
    return { base: key.slice(0, key.length - m[0].length), category: m[1] };
}

/** 该 locale 的 Intl.PluralRules 需要哪些复数类别（zh -> ['other']，en -> ['one','other']）。 */
function requiredCategories(code) {
    const locale = INTL_LOCALE[code] || code;
    try {
        return new Intl.PluralRules(locale).resolvedOptions().pluralCategories.slice().sort();
    } catch (_) {
        // 未知语言码时退回最保守的集合，宁可少归一也不要静默放宽
        return ['other'];
    }
}

/** 逻辑键名（复数形态折回基名）。 */
function logicalKey(key) {
    return splitPlural(key).base;
}

/**
 * 把一个扁平语言包整理成 { logical, forms }：
 *   logical: 逻辑键 -> Set<该键在此语言里出现的形态后缀>（'' 表示裸基名）
 *   forms:   原始扁平键 -> 值（原样保留，方便其它检查继续按扁平键取值）
 */
function indexPack(flat) {
    const logical = new Map();
    for (const key of Object.keys(flat)) {
        const { base, category } = splitPlural(key);
        if (!logical.has(base)) logical.set(base, new Set());
        logical.get(base).add(category === null ? '' : category);
    }
    return { logical, keys: new Set(Object.keys(flat)) };
}

/** 复数形态是否与该语言的 PluralRules 匹配。返回问题描述数组，空数组即合规。 */
function pluralIssues(code, index) {
    const issues = [];
    const required = requiredCategories(code).slice().sort();
    for (const [base, forms] of index.logical) {
        const isPluralized = [...forms].some((f) => f !== '');
        if (!isPluralized) continue;
        // 裸基名与复数形态并存 = 运行时到底用哪个不明，禁止
        if (forms.has('')) {
            issues.push(`${base}: 复数形态与裸基名并存，运行时取值不明（应只保留 _one/_other）`);
        }
        const got = [...forms].filter((f) => f !== '').sort();
        const missing = required.filter((c) => !got.includes(c));
        const extra = got.filter((c) => !required.includes(c));
        if (missing.length) issues.push(`${base}: ${code} 缺少必需的复数类别 _${missing.join('/_')}`);
        if (extra.length) issues.push(`${base}: ${code} 有多余的复数类别 _${extra.join('/_')}（该语言用不到，属死键）`);
    }
    return issues;
}

/**
 * 源码里引用的基名在此包中能否解析：裸基名存在，或它是已归一的复数键。
 * 给 I6 用 —— 复数化之后源码仍写 t('compare.completedText', {count})，
 * 语言包里却只有 _one/_other，不让 I6 认这个等价就会误报「键不存在」。
 */
function resolvesKey(index, referenced) {
    if (index.keys.has(referenced)) return true;
    const forms = index.logical.get(referenced);
    return !!forms && [...forms].some((f) => f !== '');
}

/** 给 I7 用：复数形态的任意一支被引用，即算这个逻辑键被引用。 */
function mentionedLogical(mentionedRaw) {
    const out = new Set();
    for (const k of mentionedRaw) {
        out.add(k);
        out.add(logicalKey(k));
    }
    return out;
}

module.exports = {
    PLURAL_CATEGORIES,
    splitPlural,
    requiredCategories,
    logicalKey,
    indexPack,
    pluralIssues,
    resolvesKey,
    mentionedLogical,
};
