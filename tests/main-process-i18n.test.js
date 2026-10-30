'use strict';

// 主进程「用户可见文字」的 i18n 契约守卫。
//
// 为什么需要它：I8 判「用户可见」靠同行出现 userVisibleRe 的关键字，里面有
// title: / message: / detail: / label:，但主进程真正往屏幕上写字的那几个出口一个都不在：
//   buttons:            原生对话框按钮
//   name: (紧跟 extensions:)  原生文件对话框的过滤器类型名
//   updateProgress(...)  下载窗里 statusElement.textContent = message 的那行文字
//   htmlContent 模板      写入临时 HTML 文件再 loadFile 的下载窗，<title>/<h3>/<div> 的文字
//   error: / errors.push  IPC 返回值里的错误文本，渲染层塞进已翻译模板后显示
// 于是出现一种半迁移状态：同一个 showMessageBox 里 title/message/detail 都 t() 了，
// 只有按钮数组留硬编码中文；下载窗整个窗口没有一处 i18n。原生对话框与原生窗口是用户
// 必然看到的文字，CI 却一条都看不见。
//
// 判据必须是 `name:` 后面紧跟 `extensions:` —— 只有 Electron 对话框过滤器是这个形状。
// 编译器预设（main.ts 的 { name: 'utf8', sourceMode: 'utf8', args: [...] }）也用 name:，
// 但那是内部标识符、永不上屏，按 sourceMode 区分开。用裸 `name:` 会把它们误伤，
// 所以这里连自证用例一起锁死这两种形状。
//
// 锁法与前一个守卫（tests/static-html-i18n.test.js）一致：已清完的出口零容忍，
// 仍有存量的出口用**只降不升**的 ratchet（见 ERROR_TEXT_BASELINE），并一律如实打印。

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

const CJK_RE = /[\u4e00-\u9fff]/;

/**
 * 取从一个「已知的字面量起点」开始的字符串字面量：先跳过空白，要求确实以引号开头，
 * 再找到配平的收尾引号（同种引号、非转义）。开头不是引号就返回 null ——
 * 这正是把 updateProgress(t('x')) / updateProgress(msg) 这类合法写法放行的判据。
 */
function literalAt(src, pos) {
    const m = /^[\s]*(['"`])/.exec(src.slice(pos));
    if (!m) return null;
    const q = m[1];
    const start = pos + m[0].length - 1;
    for (let i = start + 1; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] === q) return { text: src.slice(start, i + 1), body: src.slice(start + 1, i) };
    }
    return null;
}

/** 下载窗与进度文字：updateProgress 的实参、以及写进临时 HTML 文件的模板 */
function auditWindowText(source) {
    const lineAt = (idx) => source.slice(0, idx).split('\n').length;
    const issues = [];
    const holes = [];

    for (const m of source.matchAll(/updateProgress\s*\(/g)) {
        const lit = literalAt(source, m.index + m[0].length);
        if (lit && CJK_RE.test(lit.body)) {
            issues.push({ kind: 'progress', line: lineAt(m.index), text: lit.body.replace(/\n/g, ' ').slice(0, 44) });
        }
    }

    // 下载窗 HTML：模板里 ${...} 之外的静态文字就是窗口本身显示的字，
    // 逐行判定的 I8 完全看不见（这一句在整个文件里只出现一次，跨几十行）
    for (const m of source.matchAll(/const htmlContent = `([\s\S]*?)`;/g)) {
        const staticText = m[1].replace(/\$\{[^}]*\}/g, '');
        if (CJK_RE.test(staticText)) {
            for (const l of staticText.split('\n')) {
                if (CJK_RE.test(l)) issues.push({ kind: 'html', line: lineAt(m.index), text: l.trim().slice(0, 44) });
            }
        }
        for (const h of m[1].matchAll(/\$\{\s*t\(\s*['"]([^'"]+)['"]/g)) holes.push({ key: h[1], line: lineAt(m.index) });
    }

    return { issues, holes };
}

/**
 * 取 `error:` 后面的**整个值区间**，而不是只看紧跟的第一个字面量。
 * 三元写法 `error: badChars ? 'A' : 'B'` 有两个候选值，跨行时更多；若只认紧跟的
 * 那个字面量，这一类会被静默漏掉 —— ratchet 数字会比真实存量小，等于假绿。
 * 所以按顶层 , / } / ; 收尾取区间，再把区间里所有含 CJK 的字面量都算上。
 */
function valueSpan(src, pos) {
    const m = /^[\s]*/.exec(src.slice(pos));
    let i = pos + m[0].length;
    let depth = 0, q = null;
    const start = i;
    while (i < src.length) {
        const c = src[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = null; i++; continue; }
        if (c === "'" || c === '"' || c === '`') { q = c; i++; continue; }
        if (c === '(' || c === '[' || c === '{') { depth++; i++; continue; }
        if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; i++; continue; }
        if (depth === 0 && (c === ',' || c === ';')) break;
        i++;
    }
    return src.slice(start, i);
}

function literalsWithCjk(text) {
    return (text.match(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g) || []).filter((x) => CJK_RE.test(x));
}

/** IPC 返回值里的错误文本：渲染层会把它塞进已翻译的模板里显示出来 */
function auditErrorText(source) {
    const lineAt = (idx) => source.slice(0, idx).split('\n').length;
    const issues = [];
    for (const m of source.matchAll(/\berror\s*:/g)) {
        for (const lit of literalsWithCjk(valueSpan(source, m.index + m[0].length))) {
            issues.push({ line: lineAt(m.index), text: lit.replace(/\n/g, ' ').slice(0, 40) });
        }
    }
    for (const m of source.matchAll(/\berrors\.push\s*\(/g)) {
        for (const lit of literalsWithCjk(valueSpan(source, m.index + m[0].length))) {
            issues.push({ line: lineAt(m.index), text: lit.replace(/\n/g, ' ').slice(0, 40) });
        }
    }
    return issues;
}

// 2026-10-30 实测 12 处：压缩包导入（L5654/5657/5726）、清空目录（L7124-7138）、
// 编译器下载参数与版本冲突（L7238-7724，5 处）、云同步未登录（L11139）。
// 下载窗、编译诊断、文件名校验三批本轮清完，所以 buttons / 过滤器 name / updateProgress /
// 下载窗 HTML 四个出口零容忍，只有这一个还是 ratchet。每清一批压到实测值，只降不升。
//
// 取值区间用 valueSpan 而不是「紧跟其后的第一个字面量」：真实代码里有
//     return { success: false, error: (error as Error)?.message || '读取压缩包失败' };
// 这种写法，只看紧跟的字面量会整条漏掉（L5726 就是这么被吞的）。24 到 25 的差值其实来自
// 这里，不是上一版注释写的 L1956 那对三元 —— 那句判断是错的，本次一并更正。
//
// 已知盲区（别把这个数当成「主进程界面文案全在此」）：先赋值给变量再传进来的写法
//     const platformMsg = ... ? '中文A' : '中文B';  return { error: platformMsg };
// 检测器只看 error: 后的表达式，看不见变量里的字面量，这类不计入 ratchet。彻底覆盖要
// 做跨赋值的数据流分析，本轮不做；main.ts 的整体界面文案存量请以「非日志、非注释、
// 且不在 t() 里的 CJK 字面量」口径另行核对。
const ERROR_TEXT_BASELINE = 12;

for (const [label, src] of [['.ts 源', tsSource], ['.js 产物', jsSource]]) {
    const { issues, keys } = auditDialogText(src);
    check(`${label}: 没有硬编码的原生对话框按钮`, issues.filter((x) => x.kind === 'button').length === 0,
        issues.filter((x) => x.kind === 'button').map((x) => `L${x.line}:${x.text}`).join(' | '));
    check(`${label}: 没有硬编码的文件对话框过滤器名`, issues.filter((x) => x.kind === 'filter').length === 0,
        issues.filter((x) => x.kind === 'filter').map((x) => `L${x.line}:${x.text}`).join(' | '));
    const win = auditWindowText(src);
    check(`${label}: updateProgress 的实参没有硬编码中文`,
        win.issues.filter((x) => x.kind === 'progress').length === 0,
        win.issues.filter((x) => x.kind === 'progress').map((x) => `L${x.line}:${x.text}`).join(' | '));
    check(`${label}: 下载窗 HTML 模板没有 ${'} 之外的硬编码中文'}`,
        win.issues.filter((x) => x.kind === 'html').length === 0,
        win.issues.filter((x) => x.kind === 'html').map((x) => `L${x.line}:${x.text}`).join(' | '));
    const errs = auditErrorText(src);
    check(`${label}: IPC error 文本存量不超过 ratchet（当前 ${errs.length}，上限 ${ERROR_TEXT_BASELINE}）`,
        errs.length <= ERROR_TEXT_BASELINE,
        errs.length > ERROR_TEXT_BASELINE ? `+${errs.length - ERROR_TEXT_BASELINE}: ` + errs.slice(0, 6).map((x) => `L${x.line}:${x.text}`).join(' | ') : `${errs.length}/${ERROR_TEXT_BASELINE}`);
    const allKeys = keys.concat(win.holes.map((h) => ({ key: h.key, line: h.line })));
    const missing = allKeys.filter((k) => zhFlat[k.key] === undefined || enFlat[k.key] === undefined);
    check(`${label}: 用到的键在两包都存在（缺键会让原生对话框/窗口直接显示裸键名）`,
        missing.length === 0, missing.map((k) => `L${k.line}:${k.key}`).join(' | '));
    // 规模自检：接线后至少该有这么多 t() 引用，防止正则整体退化成空匹配
    check(`${label}: 确实扫到了主进程界面 t() 引用（防止匹配退化造成恒真）`, allKeys.length >= 30,
        `keys=${allKeys.length}`);
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

// --- 自证：进度文字与下载窗 HTML 两个检测器同样必须咬得住，且不误伤合法写法 ----
const winProbe = [
    "updateProgress('开始下载编译器...');",                 // 违规：裸中文实参
    "updateProgress(t('main.startDownloadCompiler'));",      // 合法：已接线
    "updateProgress(msg);",                                  // 合法：变量
    'const htmlContent = `',
    '<title>下载编译器</title>',                             // 违规：模板静态中文
    '<div id="status">${t(\'main.downloadWindowPreparing\')}</div>', // 合法：插孔里 t()
    '`;',
].join('\n');
const winProbed = auditWindowText(winProbe);
check('进度检测器能抓到裸中文实参',
    winProbed.issues.filter((x) => x.kind === 'progress').length === 1,
    JSON.stringify(winProbed.issues));
check('进度检测器不把 t()/变量 当违规（否则合法写法也会假阳性）',
    !/startDownloadCompiler|msg/.test(JSON.stringify(winProbed.issues.filter((x) => x.kind === 'progress'))),
    JSON.stringify(winProbed.issues));
check('HTML 检测器能抓到模板里的裸中文',
    winProbed.issues.filter((x) => x.kind === 'html').length === 1,
    JSON.stringify(winProbed.issues.filter((x) => x.kind === 'html')));
check('HTML 检测器把 ${t(...)} 插孔记为键引用',
    winProbed.holes.length === 1 && winProbed.holes[0].key === 'main.downloadWindowPreparing',
    JSON.stringify(winProbed.holes));

const errProbe = [
    "return { success: false, error: '压缩包不存在' };",
    "result.errors.push('编译超时（120 秒），已终止编译器进程。');",
    "return { success: false, error: t('main.userCancelledDownload') };",
    "return { success: false, error: err.message };",
    // 三元：两个分支都是候选值，只认紧跟 error: 的那个会漏掉后半
    "return { valid: false, error: bad ? '名称不能为空' : '文件名不能包含字符: /' };",
].join('\n');
const errProbed = auditErrorText(errProbe);
check('error 检测器能抓到硬编码 error 字段与 errors.push', errProbed.length === 4,
    JSON.stringify(errProbed));
check('error 检测器能抓到三元两个分支（否则 ratchet 会比真实存量小）',
    errProbed.some((x) => /名称不能为空/.test(x.text)) && errProbed.some((x) => /包含字符/.test(x.text)),
    JSON.stringify(errProbed));
check('error 检测器不把 t() 或变量当违规', errProbed.every((x) => /[一-鿿]/.test(x.text)),
    JSON.stringify(errProbed));

// --- 存量必须如实打印，ratchet 才可能被继续往下压 ---
console.log(`--- 主进程仍待迁移的 IPC error 文本（ratchet ${ERROR_TEXT_BASELINE}）---`);
for (const x of auditErrorText(tsSource)) console.log(`  L${x.line} ${x.text}`);

clearTimeout(watchdog);
console.log(`main-process-i18n tests completed: ${failures} failure(s)`);
process.exitCode = failures > 0 ? 1 : 0;
