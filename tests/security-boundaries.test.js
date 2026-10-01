'use strict';

// 覆盖安全收紧批次：路径包含判定、工作区删除边界、语言代码白名单、外部协议白名单。
// 这些都是「收紧」类改动，风险不在于会不会报错，而在于有没有把正常功能一起挡掉，
// 所以断言必须同时覆盖「该拒的拒了」和「该放的放了」两侧。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');

// ---------------------------------------------------------------------------
// 抽出真实的 isPathInsideDir / normalizeExternalOpenUrl 来跑，而不是比对源码字符串
// ---------------------------------------------------------------------------

function extractFunction(src, name, globals) {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found`);
    let i = src.indexOf('(', start);
    let paren = 0;
    for (; i < src.length; i++) {
        if (src[i] === '(') paren++;
        else if (src[i] === ')') { paren--; if (paren === 0) break; }
    }
    let depth = 0;
    let end = -1;
    for (i = src.indexOf('{', i); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) throw new Error(`${name} body not closed`);
    const body = src.slice(start, end);
    const ctx = vm.createContext({
        path, os,
        URL,                       // vm 沙箱不自带 URL，normalizeExternalOpenUrl 要用
        Set, Map, JSON,
        logWarn: () => { },
        ...globals
    });
    vm.runInContext(`${body}\nthis.__fn = ${name};`, ctx);
    return ctx.__fn;
}

// --- A1: isPathInsideDir ---
const isPathInsideDir = extractFunction(mainSource, 'isPathInsideDir', {});

{
    const base = path.join(os.tmpdir(), 'oicpp-test-base');
    check('目录自身判定为在内', isPathInsideDir(base, base) === true);
    check('子目录判定为在内', isPathInsideDir(path.join(base, 'a', 'b'), base) === true);
    // 报告 A1 的核心：缺末尾分隔符时兄弟目录会通过 startsWith 校验
    check('兄弟目录 codeTempEvil 被拒（原 startsWrite 漏洞）',
        isPathInsideDir(path.join(os.tmpdir(), 'oicpp-test-baseEvil', 'x'), base) === false);
    check('完全无关的路径被拒',
        isPathInsideDir(path.join(os.tmpdir(), 'elsewhere', 'x'), base) === false);
    check('前缀相同但不同分段的路径被拒',
        isPathInsideDir(base + '_other', base) === false);
    check('尾部多一个分隔符仍视为在内',
        isPathInsideDir(path.join(base, 'x') + path.sep, base) === true);
    check('大小写不同（Windows 不敏感）仍视为在内',
        isPathInsideDir(base.toUpperCase() + path.sep + 'y', base) === true);
    check('null / 空输入返回 false 而不抛异常',
        isPathInsideDir(null, base) === false && isPathInsideDir(base, null) === false);
}

// --- A4: normalizeExternalOpenUrl 协议白名单 ---
// 协议白名单是模块级 const，抽函数时要一并注入，否则 vm 里查不到
const normalizeExternalOpenUrl = extractFunction(mainSource, 'normalizeExternalOpenUrl', {
    ALLOWED_EXTERNAL_PROTOCOLS: new Set(['http:', 'https:', 'mailto:'])
});

{
    check('http 放行', normalizeExternalOpenUrl('https://example.com/a') === 'https://example.com/a');
    check('https 放行', normalizeExternalOpenUrl('http://example.com') === 'http://example.com/');
    check('mailto 放行', normalizeExternalOpenUrl('mailto:a@b.com') === 'mailto:a@b.com');
    check('file: 被拒', normalizeExternalOpenUrl('file:///C:/Windows/System32/calc.exe') === '');
    check('ms-settings: 被拒', normalizeExternalOpenUrl('ms-settings:display') === '');
    check('smb: 被拒', normalizeExternalOpenUrl('smb://host/share') === '');
    check('javascript: 被拒', normalizeExternalOpenUrl('javascript:alert(1)') === '');
    check('data: 被拒', normalizeExternalOpenUrl('data:text/html,<script>') === '');
    check('非 URL 字符串被拒而非原样透传',
        normalizeExternalOpenUrl('not a url at all') === '');
    check('空串返回空', normalizeExternalOpenUrl('') === '' && normalizeExternalOpenUrl(null) === '');
    check('协议白名单在源码中声明为 http/https/mailto',
        /ALLOWED_EXTERNAL_PROTOCOLS = new Set\(\['http:', 'https:', 'mailto:'\]\)/.test(mainSource));
}

// --- A4: preload 侧同样收口 ---
{
    check('preload 声明协议白名单',
        /ALLOWED_EXTERNAL_PROTOCOLS = new Set\(\['http:', 'https:', 'mailto:'\]\)/.test(preloadSource));
    check('preload 不再把 shell.openExternal 原样透传',
        !/openExternal: \(url\) => shell\.openExternal\(url\)/.test(preloadSource));
    check('preload 的 openExternal 走 safeOpenExternal',
        (preloadSource.match(/openExternal: safeOpenExternal/g) || []).length === 2,
        `${(preloadSource.match(/openExternal: safeOpenExternal/g) || []).length} 处`);
    // markdown 预览的链接白名单原先含 file:
    check('markdown 预览链接白名单已移除 file:',
        !/\['http:', 'https:', 'mailto:', 'file:'\]/.test(preloadSource));
    check('markdown 预览改用共享白名单',
        /ALLOWED_EXTERNAL_PROTOCOLS\.has\(resolvedUrl\.protocol\)/.test(preloadSource));
}

// --- A1: main.js 中所有临时目录校验都已替换 ---
{
    check('main.js 不再有裸 startsWith(codeTempDir)',
        !/startsWith\(codeTempDir\)/.test(mainSource));
    check('两处临时文件校验改用 isPathInsideDir',
        (mainSource.match(/isPathInsideDir\(tempPath, codeTempDir\)/g) || []).length === 2);
    check('调试帧路径校验改用 isPathInsideDir',
        /isPathInsideDir\(resolved, debugSessionRootDir\)/.test(mainSource));
}

// --- A2: 删除操作限定工作区 ---
{
    check('存在 assertDeletableInWorkspace', /function assertDeletableInWorkspace\(/.test(mainSource));
    check('delete-file 调用工作区校验',
        /assertSafeIoPath\(filePath\);\s*\n\s*assertDeletableInWorkspace\(filePath\);/.test(mainSource));
    check('clear-directory-contents 调用工作区校验',
        /clear-directory-contents[\s\S]{0,2000}?assertDeletableInWorkspace\(resolved\)/.test(mainSource));
    check('工作区未打开时拒绝删除',
        /if \(!currentExternalWorkspacePath\) \{\s*\n\s*throw new Error\(t\('error\.noWorkspaceForDelete'\)\)/.test(mainSource));
    check('运行时目录（codeTemp/compare）不受工作区约束 —— 否则对拍/样例的临时文件删不掉',
        /if \(isPathInsideTempRoots\(targetPath\)\) \{\s*\n\s*return;\s*\n\s*\}/.test(mainSource));
}

// --- A3: 语言代码白名单 ---
{
    const handler = mainSource.slice(
        mainSource.indexOf("ipcMain.handle('get-language-file'"),
        mainSource.indexOf("ipcMain.handle('get-available-languages'"));
    check('get-language-file 校验语言代码字符集',
        /if \(!\/\^\[a-z0-9-\]\+\$\/i\.test\(code\)\)/.test(handler), '');
    check('get-language-file 校验路径未越界',
        /if \(!isPathInsideDir\(langPath, langDir\)\)/.test(handler));
    check('get-language-file 不再直接 path.join 未经校验的 code',
        !/path\.join\(__dirname, 'lang', `\$\{langCode/.test(handler));
}

// --- 新增 i18n 键真实存在且两语言一致 ---
{
    const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lang', 'zh-cn.json'), 'utf8'));
    const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lang', 'en.json'), 'utf8'));
    for (const key of ['noWorkspaceForDelete', 'outsideWorkspace']) {
        check(`zh-cn 存在 error.${key}`, typeof zh.error?.[key] === 'string');
        check(`en 存在 error.${key}`, typeof en.error?.[key] === 'string');
    }
    check('两语言的 error.* 键集一致',
        JSON.stringify(Object.keys(zh.error).sort()) === JSON.stringify(Object.keys(en.error).sort()));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);