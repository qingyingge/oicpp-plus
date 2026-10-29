'use strict';

// 静态 HTML 的 i18n 契约守卫。
//
// 为什么需要它：CI 的 I8/I8b 是**按行**判定的，靠 userVisibleRe 认 sink
// （innerHTML / label: / title: 之类）。一段写成多行的静态 HTML 里，
// `<div class="unit">0 表示不限制</div>` 这种「纯文本 + 无 sink 关键字」的行
// 一条都不命中 —— 于是全站最直白的一类漏网文案反而查不出来。实测这一条
// 在 settings/editor.html 里捞出 6 处「有语言键、但没挂 data-i18n」的界面文字
// （键全部已在 zh-cn/en 里存在，即 I7 统计的孤儿键），另有 2 处行内默认值与键值
// 不一致（其中 settings.languageDesc 还写着「更改后需要重新打开设置面板生效」，
// 而 46d6ece 早已让语言切换立即生效、键值也同步改了，只剩默认值没人管）。
//
// 两条不变量：
//   A. 不含 data-i18n 祖先链的 CJK 文本节点 = 未接线，数字必须为 0
//   B. 挂了 data-i18n 的元素，其直接内联文本必须逐字等于该键的 zh-cn 值
//      （行内中文只是 JS 落地前的默认值，两者不一致就是同屏换话）
//
// 上锁方式是逐文件收紧：ENFORCED 里列出的文件两条都必须为 0，其余文件只打印
// 存量、不判定 —— 每清完一个文件就把它加进 ENFORCED，不许反向放宽。

const fs = require('fs');
const path = require('path');

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
const rendererDir = path.join(root, 'src', 'renderer');
const zh = JSON.parse(fs.readFileSync(path.join(root, 'src', 'lang', 'zh-cn.json'), 'utf8'));

const flatten = (obj, prefix = '', out = {}) => {
    for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
        else out[key] = v;
    }
    return out;
};
const zhFlat = flatten(zh);

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'area',
    'base', 'col', 'embed', 'param', 'track', 'wbr']);
// 内容不是「界面文字」的容器：script/style 是代码，textarea 的值由程序写入，
// title 是文档标题。把它们的内容当可见文本会造出假阳性。
const OPAQUE = new Set(['script', 'style', 'textarea', 'code', 'pre']);

function walkHtml(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkHtml(p, out);
        else if (e.name.endsWith('.html')) out.push(p);
    }
    return out;
}

/**
 * 极简 HTML 走查：只维护元素栈，够判断「文本节点的上有没有 data-i18n 祖先」
 * 和「带 data-i18n 元素的直接文本子节点」这两件事。不做完整解析，因此
 * 遇到未闭合标签会一路带到文件尾 —— 宁可漏报不误报，且这些文件是手写的。
 */
// 属性级映射。I8 的 userVisibleRe 里有 `title:` 与 `\.title\s*=`，却没有 `title="`；
// `label:` 也匹配不到 `aria-label="`。于是 HTML 属性上的界面文字（tooltip、读屏文本、
// 输入框提示）整类无人管 —— 实测 index.html 因此躺着 11 条。
const ATTR_MAP = {
    'title': 'data-i18n-title',
    'aria-label': 'data-i18n-aria-label',
    'placeholder': 'data-i18n-placeholder',
};
// 语言中性的值不要求接线：缩写、快捷键、单位、纯符号。判据与 ci-check 的 I8b 同源 ——
// 「≥2 个 ≥3 字母的完整词」才算散文，这正是把 SPJ / MB / Ctrl+P 挡在外面的关键。
const HAN_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
function needsTranslation(val) {
    if (HAN_RE.test(val)) return true;
    return (val.match(/\b[A-Za-z]{3,}\b/g) || []).length >= 2;
}

function auditHtml(file) {
    const src = fs.readFileSync(file, 'utf8');
    const tagRe = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>/g;
    const lineAt = (p) => src.slice(0, p).split('\n').length;
    const stack = [];
    const uncoveredText = [];
    const wiredElements = [];
    const attrIssues = [];
    let m;
    let last = 0;
    while ((m = tagRe.exec(src))) {
        const text = src.slice(last, m.index);
        const t = text.trim().replace(/\s+/g, ' ');
        const opaque = stack.some((f) => f.opaque);
        if (t && !opaque) {
            // A 条只认 CJK：纯英文的未接线文字归 ci-check 的 I8b 管，两条别混口径。
            if (CJK.test(t) && !stack.some((f) => f.i18n)) {
                uncoveredText.push({ line: lineAt(m.index), text: t });
            }
            // B 条不分脚本 —— 「默认值写英文、键值是中文」同样是同屏换话，而且正是
            // index.html 里最大批的那种不符（35 条里只有 5 条含 CJK）。早先这里跟着
            // A 条一起套了 CJK 门槛，于是 ENFORCED 的 0 是靠漏报换来的；已改掉。
            if (stack.length) stack[stack.length - 1].texts.push(t);
        }
        last = tagRe.lastIndex;
        const tag = m[0];
        if (tag.startsWith('<!--')) continue;              // 注释不是可见文本
        const name = /^<\/?\s*([a-zA-Z][\w-]*)/.exec(tag)[1].toLowerCase();
        if (tag[1] === '/') {
            for (let k = stack.length - 1; k >= 0; k--) {
                if (stack[k].tag === name) { stack.length = k; break; }
            }
            continue;
        }
        // C 条：属性级漏网 / 挂错键 / 默认值 ≠ 键值。必须在 VOID 与自闭合的
        // continue 之前跑 —— placeholder 恰恰长在 <input> 这种 void 元素上。
        for (const [attr, i18nAttr] of Object.entries(ATTR_MAP)) {
            const av = new RegExp(`(?<=[\\s"'])${attr}\\s*=\\s*"([^"]*)"`).exec(tag);
            if (!av || !av[1].trim()) continue;
            const val = av[1].trim();
            if (!needsTranslation(val)) continue;
            const wired = new RegExp(`\\b${i18nAttr}\\s*=\\s*"([^"]*)"`).exec(tag);
            if (!wired) {
                attrIssues.push({ line: lineAt(m.index), attr, val, why: `未挂 ${i18nAttr}` });
                continue;
            }
            const zhVal = zhFlat[wired[1]];
            if (zhVal === undefined) {
                attrIssues.push({ line: lineAt(m.index), attr, val, why: `键不存在：${wired[1]}` });
                continue;
            }
            if (!/\{\w+\}/.test(String(zhVal)) && String(zhVal).trim() !== val) {
                attrIssues.push({ line: lineAt(m.index), attr, val, why: `${wired[1]} 的 zh 值是「${String(zhVal).slice(0, 32)}」` });
            }
        }
        if (VOID.has(name) || tag.endsWith('/>')) continue;
        if (name === 'html' || name === 'body') { stack.push({ tag: name, i18n: false, opaque: false, texts: [] }); continue; }
        const frame = {
            tag: name,
            i18n: /\bdata-i18n\s*=/.test(tag),
            opaque: OPAQUE.has(name),
            texts: [],
        };
        stack.push(frame);
        if (frame.i18n) {
            const key = /\bdata-i18n\s*=\s*"([^"]*)"/.exec(tag)[1];
            wiredElements.push({ line: lineAt(m.index), key, frame });
        }
    }
    // 带 {token} 的键默认值里必然多写了示例值（"行 1, 列 1" vs "行 {line}, 列 {col}"），
    // 这条不参与逐字比较，否则会把合法写法全判成缺陷。
    const mismatches = wiredElements
        .filter((el) => !/\{\w+\}/.test(String(zhFlat[el.key] ?? '')))
        .map((el) => ({
            line: el.line,
            key: el.key,
            inline: el.frame.texts.join(' ').trim(),
            zhValue: zhFlat[el.key] === undefined ? null : String(zhFlat[el.key]).trim(),
        }))
        .filter((x) => x.inline !== '' && x.inline !== x.zhValue);
    return { uncoveredText, mismatches, attrIssues, wiredCount: wiredElements.length };
}

// 上锁清单，按指标分别锁 —— 一个文件可能 A 干净而 B 还有存量，整体进出会连带把
// 已经干净的那条退回「不检查」。每清完一条就把对应的字母打开，不许反向关。
//   A 祖先链上没有 data-i18n 的 CJK 可见文本
//   B 挂了 data-i18n 的元素，其直接内联文本 == 该键的 zh 值
//   C title / aria-label / placeholder 属性已接线，且默认值 == 该键的 zh 值
// minWired 是「这文件本来有多少个接线元素」的下限，防止解析退化成扫出空结果、
// 让 A/B/C 在空集上真空通过。
const ENFORCED = [
    { file: 'settings/editor.html', metrics: 'AB', minWired: 100 },
    { file: 'index.html', metrics: 'ABC', minWired: 90 },
    { file: 'pdf-viewer.html', metrics: 'ABC', minWired: 5 },
    { file: 'settings/backup.html', metrics: 'AC', minWired: 10 },
    { file: 'settings/templates.html', metrics: 'AC', minWired: 20 },
    { file: 'settings/compiler.html', metrics: 'A', minWired: 25 },
];

const files = walkHtml(rendererDir).map((f) => path.relative(rendererDir, f).split(path.sep).join('/'));
check('递归能找到渲染层 HTML', files.length >= 6, files.join(', '));

const results = new Map();
for (const rel of files) results.set(rel, auditHtml(path.join(rendererDir, rel)));

const METRIC_DESC = {
    A: (r) => [r.uncoveredText.length === 0, r.uncoveredText.slice(0, 6).map((x) => `L${x.line}:${x.text.slice(0, 24)}`).join(' | ')],
    B: (r) => [r.mismatches.length === 0, r.mismatches.slice(0, 6).map((x) => `L${x.line} ${x.key} 默认="${x.inline.slice(0, 26)}" 键值="${String(x.zhValue).slice(0, 26)}"`).join(' | ')],
    C: (r) => [r.attrIssues.length === 0, r.attrIssues.slice(0, 6).map((x) => `L${x.line} ${x.attr}="${x.val.slice(0, 26)}" ${x.why}`).join(' | ')],
};

for (const { file: rel, metrics, minWired } of ENFORCED) {
    const r = results.get(rel);
    check(`${rel}: 审计结果可读`, !!r, '文件不存在于扫描结果里');
    if (!r) continue;
    for (const metric of metrics) {
        const [ok, extra] = METRIC_DESC[metric](r);
        check(`${rel}: ${metric} 条`, ok, extra);
    }
    check(`${rel}: 确实扫到了 data-i18n 元素（防止切片取空造成恒真）`,
        r.wiredCount >= minWired, `wired=${r.wiredCount} 下限=${minWired}`);
}

// 审计器自身必须能抓到缺陷，否则上面的 0 只是「什么都没查到」。
// 造两份内存 HTML 片段喂给同一个函数：一条未接线文本 + 一条默认值与键不符。
const probeDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'oicpp-i18n-probe-'));
const probeBad = path.join(probeDir, 'probe.html');
fs.writeFileSync(probeBad, [
    '<html><body>',
    '<div class="unit">这是一条没接线的中文</div>',
    `<label data-i18n="settings.rawText">故意写错的默认值</label>`,
    // 英文默认值配中文键 —— B 条曾经套着 CJK 门槛，正是漏掉这一类
    `<span data-i18n="menu.browse">Browse</span>`,
    // C 条：tooltip 没挂 data-i18n-title（按钮文字用中性的 OK，免得顺手造出一条 A 类，
    // 让「恰好 1 条未接线」这条自证变成猜测）
    '<button title="一条没接线的提示">OK</button>',
    // C 条：挂了但键不存在（裸键会直接显示进 tooltip）
    '<input type="text" data-i18n-placeholder="definitely.not.a.key" placeholder="提示">',
    '<!-- <span>注释里的中文不算未接线</span> -->',
    '</body></html>',
].join('\n'));
const probe = auditHtml(probeBad);
check('审计器能抓到未接线的 CJK 文本（守卫不空转）',
    probe.uncoveredText.length === 1 && probe.uncoveredText[0].text === '这是一条没接线的中文',
    JSON.stringify(probe.uncoveredText));
check('审计器能抓到默认值与键值不一致',
    probe.mismatches.some((x) => x.key === 'settings.rawText'),
    JSON.stringify(probe.mismatches));
check('英文默认值配中文键也要抓到（B 条不得套 CJK 门槛）',
    probe.mismatches.some((x) => x.key === 'menu.browse' && x.inline === 'Browse'),
    JSON.stringify(probe.mismatches));
check('C 条能抓到没接线的 title 属性',
    probe.attrIssues.some((x) => x.attr === 'title' && /未挂/.test(x.why)),
    JSON.stringify(probe.attrIssues));
check('C 条能抓到属性上指向不存在键的接线',
    probe.attrIssues.some((x) => x.attr === 'placeholder' && /键不存在/.test(x.why)),
    JSON.stringify(probe.attrIssues));
check('审计器不把 HTML 注释算成可见文本',
    !probe.uncoveredText.some((t) => t.text.includes('注释里')), JSON.stringify(probe.uncoveredText));
// 语言中性值不得进 C 条：SPJ / MB / Ctrl+P 这类要求翻译就是假阳性
const probeNeutral = path.join(probeDir, 'neutral.html');
fs.writeFileSync(probeNeutral, [
    '<html><body>',
    '<span title="SPJ">SPJ</span>',
    '<span class="unit">MB</span>',
    '<input type="text" title="Ctrl+P">',
    '</body></html>',
].join('\n'));
check('缩写/快捷键/单位不算未接线（C 条不得造假阳性）',
    auditHtml(probeNeutral).attrIssues.length === 0,
    JSON.stringify(auditHtml(probeNeutral).attrIssues));
fs.rmSync(probeDir, { recursive: true, force: true });

// 每个文件的三条指标一律如实打印（含已上锁的），不静默截断：把存量藏起来就等于
// 假装它不存在，而下一次收紧时没有人知道还剩多少。
console.log('--- 各文件存量（括号内为本轮已上锁的指标）---');
for (const rel of files) {
    const r = results.get(rel);
    const entry = ENFORCED.find((x) => x.file === rel);
    console.log(`  ${rel}: A=${r.uncoveredText.length} B=${r.mismatches.length} C=${r.attrIssues.length} wired=${r.wiredCount}`
        + `  [锁:${entry ? entry.metrics : '无'}]`);
}

clearTimeout(watchdog);
console.log(`static-html-i18n tests completed: ${failures} failure(s)`);
process.exitCode = failures > 0 ? 1 : 0;
