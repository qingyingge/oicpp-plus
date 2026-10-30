'use strict';

// 主进程原生对话框文案的 i18n 契约守卫。
//
// 为什么需要它：I8 判「用户可见」靠同行出现 userVisibleRe 的关键字，里面有
// title: / message: / detail: / label:，**却没有 buttons:，也没有过滤器用的 name:**。
// 于是主进程里出现一种半迁移状态 —— 同一个 showMessageBox 字面量里 title/message/detail
// 都已经 t() 了，只有按钮数组留着硬编码中文；文件对话框同理，title 翻译了，
// filters[].name 没有。原生对话框是用户 100% 会看到的文字，CI 却一条都看不见。
//
// 实测规模：main.ts 里 6 处 buttons: 共 9 个标签、14 处过滤器 name: 全部是硬编码。
//
// 判据必须是 `name:` 后面紧跟 `extensions:` —— 只有 Electron 对话框过滤器是这个形状。
// 编译器预设（main.ts 的 { name: 'utf8', sourceMode: 'utf8', args: [...] }）也用 name:，
// 但那是内部标识符、永不上屏，按 sourceMode 区分开。用裸 `name:` 会把它们误伤，
// 所以这里连自证用例一起锁死这两种形状。

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
const tsSource = fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8');
const jsSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const zh = fs.readFileSync(path.join(root, 'src', 'lang', 'zh-cn.json'), 'utf8');
const en = fs.readFileSync(path.join(root, 'src', 'lang', 'en.json'), 'utf8');

const flatten = (obj, prefix = '', out = {}) => {
    for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
        else out[key] = v;
    }
    return out;
};
const zhFlat = flatten(JSON.parse(zh));
const enFlat = flatten(JSON.parse(en));

/** 从 openIdx（指向 '['）开始配平取回数组字面量正文，取不到返回 null */
function matchBracket(src, openIdx) {
    let depth = 0;
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        if (c === '[') depth++;
        else if (c === ']') { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
    }
    return null;
}

/** 把数组正文按顶层逗号切开（忽略嵌套括号与引号里的逗号） */
function splitTopLevel(body) {
    const parts = [];
    let cur = '', depth = 0, q = null;
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (q) { cur += c; if (c === q && body[i - 1] !== '\\') q = null; continue; }
        if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        if (c === ')' || c === ']' || c === '}') depth--;
        if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) parts.push(cur);
    return parts;
}

/**
 * 找出所有「该上屏却硬编码」的对话框文案。
 * 返回 [{kind, line, text}] —— kind 为 button / filter；
 * rawString 且不是 t('key') 的即算违规。
 */
function auditDialogText(source) {
    const issues = [];
    const keys = [];
    const lineAt = (idx) => source.slice(0, idx).split('\n').length;

    for (const m of source.matchAll(/buttons\s*:\s*\[/g)) {
        const openIdx = m.index + m[0].length - 1;
        const body = matchBracket(source, openIdx);
        if (body === null) continue;
        for (const item of splitTopLevel(body)) {
            const t = item.trim();
            if (!t) continue;
            const tk = /^t\(\s*['"]([^'"]+)['"]\s*\)$/.exec(t);
            if (tk) { keys.push({ key: tk[1], line: lineAt(m.index) }); continue; }
            // 按钮标题一定是给人看的：任何裸字符串字面量都算违规
            if (/^(['"`])(?:\\.|(?!\1)[\s\S])*?\1$/.test(t)) {
                issues.push({ kind: 'button', line: lineAt(m.index), text: t });
            }
        }
    }

    for (const m of source.matchAll(/name\s*:\s*(t\(\s*['"][^'"]+['"]\s*\)|'(?:\\.|[^'\\])*')\s*,\s*extensions\s*:/g)) {
        const val = m[1];
        const tk = /^t\(\s*['"]([^'"]+)['"]\s*\)$/.exec(val);
        if (tk) { keys.push({ key: tk[1], line: lineAt(m.index) }); continue; }
        issues.push({ kind: 'filter', line: lineAt(m.index), text: val });
    }

    return { issues, keys };
}

for (const [label, src] of [['.ts 源', tsSource], ['.js 产物', jsSource]]) {
    const { issues, keys } = auditDialogText(src);
    check(`${label}: 没有硬编码的原生对话框按钮`, issues.filter((x) => x.kind === 'button').length === 0,
        issues.filter((x) => x.kind === 'button').map((x) => `L${x.line}:${x.text}`).join(' | '));
    check(`${label}: 没有硬编码的文件对话框过滤器名`, issues.filter((x) => x.kind === 'filter').length === 0,
        issues.filter((x) => x.kind === 'filter').map((x) => `L${x.line}:${x.text}`).join(' | '));
    const missing = keys.filter((k) => zhFlat[k.key] === undefined || enFlat[k.key] === undefined);
    check(`${label}: 对话框用到的键在两包都存在（缺键会让原生对话框直接显示裸键名）`,
        missing.length === 0, missing.map((k) => `L${k.line}:${k.key}`).join(' | '));
    // 规模自检：本轮接线后至少该有这么多 t() 引用，防止正则整体退化成空匹配
    check(`${label}: 确实扫到了对话框 t() 引用（防止匹配退化造成恒真）`, keys.length >= 12,
        `keys=${keys.length}`);
}

// .ts 与 .js 的引用集合必须一致，否则说明改了 .ts 忘了编译
const tsKeys = auditDialogText(tsSource).keys.map((k) => k.key).sort().join(',');
const jsKeys = auditDialogText(jsSource).keys.map((k) => k.key).sort().join(',');
check('.ts 与 emit 出的 .js 引用同一批对话框键（漏跑 tsc 时这条会红）', tsKeys === jsKeys,
    tsKeys === jsKeys ? '' : '产物漂移');

// --- 自证：检测器必须咬得住，且不得误伤编译器预设 --------------------------
const probe = [
    "buttons: ['继续退出并安装', '取消'],",
    "buttons: [t('dialog.ok')],",
    "filters: [",
    "  { name: 'JSON文件', extensions: ['json'] },",
    "  { name: t('dialog.allFilter'), extensions: ['*'] }",
    "]",
    // 编译器预设：有 name 但后面跟的是 sourceMode，永远不该上屏
    "presets = [{ name: 'utf8-static', sourceMode: 'utf8', args: ['-static'] }];",
].join('\n');
const probed = auditDialogText(probe);
check('检测器能抓到硬编码按钮', probed.issues.some((x) => x.kind === 'button'), JSON.stringify(probed.issues));
check('检测器能抓到硬编码过滤器名', probed.issues.some((x) => x.kind === 'filter'), JSON.stringify(probed.issues));
check('检测器不把编译器预设的 name 当成界面文案（判据是 name 后紧跟 extensions）',
    !probed.issues.some((x) => /utf8/.test(x.text)), JSON.stringify(probed.issues));
check('检测器认得已接线的 t() 并计入键', probed.keys.length === 2, JSON.stringify(probed.keys));

clearTimeout(watchdog);
console.log(`main-dialog-i18n tests completed: ${failures} failure(s)`);
process.exitCode = failures > 0 ? 1 : 0;
