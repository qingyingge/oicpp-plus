'use strict';

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'js', 'monaco-editor-manager.js'), 'utf8');

// --- 补全提供器在注释内不触发的回归测试 ---
// 验证两个补全提供器的 provideCompletionItems 开头都有 isInComment 检查

// 1. 本地补全提供器 (_registerLocalCompletionProvider)
const localProviderBody = (() => {
    const re = /_registerLocalCompletionProvider\s*\(\s*\)\s*\{([\s\S]*?)\n\s{4}\}/;
    const m = re.exec(src);
    return m ? m[1] : '';
})();

check('本地补全提供器存在 isInComment 检查',
    /if\s*\(\s*this\.isInComment\s*\(\s*model\s*,\s*position\s*\)\s*\)\s*return\s*\{\s*suggestions\s*:\s*\[\s*\]\s*\}\s*;/.test(localProviderBody));

// 2. LSP 补全提供器 (_registerLspCompletionProvider -> lspComplete)
const lspProviderBody = (() => {
    const re = /_registerLspCompletionProvider\s*\(\s*\)\s*\{([\s\S]*?)\n\s{4}\}/;
    const m = re.exec(src);
    return m ? m[1] : '';
})();

// 在 lspComplete 内部查找 isInComment 检查
const lspCompleteBody = (() => {
    const startIdx = lspProviderBody.indexOf('const lspComplete = async (model, position, context, token) => {');
    if (startIdx === -1) return '';
    let depth = 0;
    let inString = false;
    let stringChar = '';
    for (let i = startIdx; i < lspProviderBody.length; i++) {
        const ch = lspProviderBody[i];
        if (!inString && (ch === '"' || ch === "'" || ch === '`')) {
            inString = true;
            stringChar = ch;
        } else if (inString && ch === stringChar && lspProviderBody[i-1] !== '\\') {
            inString = false;
        } else if (!inString) {
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    return lspProviderBody.substring(startIdx, i + 1);
                }
            }
        }
    }
    return '';
})();

check('LSP 补全提供器存在 isInComment 检查',
    /if\s*\(\s*this\.isInComment\s*\(/.test(lspCompleteBody) && /return\s*\{\s*suggestions\s*:\s*\[\s*\]\s*\}/.test(lspCompleteBody));

// 3. 验证 isInComment 函数实现完整（处理单行 // 和多行 /* */）
const isInCommentBody = (() => {
    const re = /isInComment\s*\(\s*model\s*,\s*position\s*\)\s*\{([\s\S]*?)\n\s{4}\}/;
    const m = re.exec(src);
    return m ? m[1] : '';
})();

check('isInComment 检测单行注释 //',
    /indexOf\('\/\/'\)/.test(isInCommentBody) || /indexOf\("\/\/"\)/.test(isInCommentBody));

check('isInComment 检测多行注释 /* */',
    /substring\(i, i \+ 2\) === '\/\*'/.test(isInCommentBody) || /substring\(i, i \+ 2\) === "\/\*"/.test(isInCommentBody));

console.log(`\n[SUMMARY] ${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures ? 1 : 0);