'use strict';

// 样例测试器按钮的 i18n 契约回归。
//
// 起因：renderSamples 末尾的 applyDynamicTranslations() 用
// `el.textContent = t('tester.export')` 给「导出」按钮刷文案，而那个按钮里除了文字
// 还有一个 <svg> 图标 —— textContent 赋值会连子元素一起清掉，图标在每次渲染后消失。
// 同一段还把 .expand-output-btn 无条件刷成 tester.expand，把模板按 outputIsExpanded
// 算出来的「收起」覆盖掉（展开状态下按钮却写着「展开」）。
//
// 正解是声明式：按钮挂 data-i18n，交给 i18n.js 的 _applyToDOM()。它专门区分了
// 「有子元素」的容器，只替换其中的文本节点，图标得以保留（该行为由
// tests/i18n-renderer-runtime.test.js 断言）。所以这里锁两件事：
//   1. 两个按钮确实挂了 data-i18n；
//   2. applyDynamicTranslations 不再对这两个选择器动 textContent。

const fs = require('fs');
const path = require('path');
const { classMethod } = require('./fixtures/source-extract');

// 挂死不等于通过：某个 await 永不 settle 时 Node 以 0 退出码排空 event loop，
// 后半截断言一条不发也「全绿」。留一个不 unref 的定时器把「跑不完」顶成失败。
const watchdog = setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：某个 await 永不 settle（异步守卫没被驱动完）');
    process.exit(1);
}, 60000);

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.join(__dirname, '..');
// .ts 是唯一手写源，.js 由 tsc 就地 emit；守卫跑在产物上，所以顺带锁定「两边没漂」。
const tsSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'sidebar', 'sampleTester.ts'), 'utf8');
const jsSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'sidebar', 'sampleTester.js'), 'utf8');
const zhPack = JSON.parse(fs.readFileSync(path.join(root, 'src', 'lang', 'zh-cn.json'), 'utf8'));
const enPack = JSON.parse(fs.readFileSync(path.join(root, 'src', 'lang', 'en.json'), 'utf8'));

const flatten = (obj, prefix = '', out = {}) => {
    for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
        else out[key] = v;
    }
    return out;
};
const zh = flatten(zhPack);
const en = flatten(enPack);

// --- 从模板里切出某个 class 的 <button> 元素（无嵌套 button，取到第一个 </button> 即可）
function sliceButton(source, classValue) {
    const at = source.indexOf(`class="${classValue}"`);
    if (at < 0) return '';
    const openStart = source.lastIndexOf('<button', at);
    const close = source.indexOf('</button>', at);
    if (openStart < 0 || close < 0) return '';
    return source.slice(openStart, close);
}

function attrOf(tagMarkup, name) {
    // (?<![-\w]) 不能省：\btitle 会命中 data-i18n-title="…" 里的那个 title=，
    // 于是把键名当成了默认文案，断言看着在跑、实际比的是两个不同量。
    const m = new RegExp(`(?<![-\\w])${name}="([^"]*)"`).exec(tagMarkup);
    return m ? m[1] : null;
}

// 元素的内文 = 剥掉所有子标签后剩下的文本（导出按钮的 <svg> 因此不影响取词）
function innerText(elementMarkup) {
    const gt = elementMarkup.indexOf('>');
    if (gt < 0) return '';
    return elementMarkup.slice(gt + 1).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// 展开按钮的 class 是 "export-output-btn expand-output-btn"，所以精确带闭引号的
// 'class="export-output-btn"' 只会命中纯导出那一个，不需要额外的锚点。
const BUTTONS = [
    { label: '运行按钮', classValue: 'sample-run-btn' },
    { label: '导出按钮', classValue: 'export-output-btn' },
];

for (const { label, classValue } of BUTTONS) {
    // 源码切片取不到就必须当场失败：空串上 !/x/.test('') 恒真，否定断言会真空通过
    const markupTs = sliceButton(tsSource, classValue);
    check(`${label}: 模板里能定位到`, markupTs !== '');
    if (markupTs === '') continue;

    const openTag = markupTs.slice(0, markupTs.indexOf('>') + 1);
    const textKey = attrOf(openTag, 'data-i18n');
    const titleKey = attrOf(openTag, 'data-i18n-title');

    check(`${label}: 挂了 data-i18n（交给 _applyToDOM 的文本节点路径，不清子元素）`,
        textKey !== null, `data-i18n=${String(textKey)}`);

    if (textKey !== null) {
        check(`${label}: data-i18n 的键在两个语言包里都存在（缺键会显示裸键名而不是兜底）`,
            zh[textKey] !== undefined && en[textKey] !== undefined,
            `zh=${String(zh[textKey])} en=${String(en[textKey])}`);
        // 行内中文只是 JS 加载前的默认值，必须与所挂键的 zh-cn 值一致，
        // 否则首屏与翻译落地后是同屏两句不同的话。
        check(`${label}: 内文默认值 == 所挂键的 zh-cn 值`,
            zh[textKey] !== undefined && innerText(markupTs) === String(zh[textKey]),
            `内文="${innerText(markupTs)}" 键值="${String(zh[textKey])}"`);
    }

    if (titleKey !== null) {
        check(`${label}: tooltip 默认值 == data-i18n-title 键的 zh-cn 值`,
            zh[titleKey] !== undefined && attrOf(openTag, 'title') === String(zh[titleKey]),
            `title="${String(attrOf(openTag, 'title'))}" 键值="${String(zh[titleKey])}"`);
    }
}

// --- 破坏性覆写必须已经消失（这是本次修复的正向锁） ----------------------
const dynamicBody = classMethod(jsSource, 'applyDynamicTranslations');
check('applyDynamicTranslations 方法体可抽取', dynamicBody !== '');
check('不再对 .sample-run-btn 做 textContent 覆写',
    !/querySelectorAll\(\s*['"`]\.sample-run-btn/.test(dynamicBody));
check('不再对 .export-output-btn 做 textContent 覆写（曾连带清掉 <svg> 图标）',
    !/querySelectorAll\(\s*['"`]\.export-output-btn/.test(dynamicBody));

// .export-output-btn 同时命中展开按钮，模板已按 outputIsExpanded 出词，
// 任何无条件覆写都会把「收起」刷回「展开」。
const expandMarkup = sliceButton(tsSource, 'export-output-btn expand-output-btn');
check('展开/收起按钮：内文由模板按展开状态取键，不挂 data-i18n',
    expandMarkup !== '' && !/\bdata-i18n\s*=/.test(expandMarkup)
        && /tester\.collapse[\s\S]*tester\.expand|tester\.expand[\s\S]*tester\.collapse/.test(expandMarkup),
    expandMarkup.slice(0, 60));

// --- 产物漂移：漏跑 tsc 时 .js 还是旧代码，上面读 .js 的断言却看不见 ---
const jsMarkup = sliceButton(jsSource, 'sample-run-btn');
check('emit 出的 .js 里同样挂着 data-i18n（改了 .ts 忘了跑 tsc -p tsconfig.build.json 时这条会红）',
    jsMarkup !== '' && attrOf(jsMarkup.slice(0, jsMarkup.indexOf('>') + 1), 'data-i18n') === 'tester.run');

clearTimeout(watchdog);
console.log(`sampleTester i18n tests completed: ${failures} failure(s)`);
process.exitCode = failures > 0 ? 1 : 0;
