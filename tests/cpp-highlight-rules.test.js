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
const cppLangPath = path.join(__dirname, '..', 'node_modules', 'monaco-editor', 'esm',
    'vs', 'languages', 'definitions', 'cpp', 'cpp.js');
const cppLang = fs.existsSync(cppLangPath) ? fs.readFileSync(cppLangPath, 'utf8') : '';

// 用「方法定义形态」定位：行首缩进 + 名字 + 参数列表 + 紧跟的 {
// （不能用裸 indexOf，名字也会出现在调用处；源文件是 CRLF，故允许 \r）
function methodBody(name) {
    const re = new RegExp(`^\\s{4}${name}\\s*\\(`, 'm');
    const m = re.exec(src);
    if (!m) return '';
    // 先跳过参数列表（默认参数里可能有 {}），再从方法体的 { 开始配平
    let i = src.indexOf('(', m.index);
    let paren = 0;
    for (; i < src.length; i++) {
        if (src[i] === '(') paren++;
        else if (src[i] === ')') { paren--; if (paren === 0) break; }
    }
    let depth = 0;
    for (i = src.indexOf('{', i); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) return src.slice(m.index, i + 1);
        }
    }
    return '';
}

// 断言的是「有哪些规则」，注释里复述死规则名会造成假阳性，先剥掉注释。
// 只认行首（允许缩进）之后第一个 // 为注释起点：本文件的规则项里不含 //，
// 而 URL 之类也不会出现在这些方法体内。
function stripComments(text) {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((l) => {
            const i = l.indexOf('//');
            return i >= 0 && l.slice(0, i).trim() === '' ? '' : l;
        })
        .join('\n');
}

const syntaxRules = stripComments(methodBody('buildSyntaxColorRules'));
const semanticRules = stripComments(methodBody('buildSemanticTokenRules'));
const resolveTheme = stripComments(methodBody('resolveMonacoTheme'));

// --- P0-1: 语义 token 必须走 rules，Monaco 不读 semanticTokenColors 字段 ---
check('buildSemanticTokenColors 已改名为 buildSemanticTokenRules（返回值是 rules 不是字段）',
    !/buildSemanticTokenColors/.test(src) && /buildSemanticTokenRules\(colors, styles\)/.test(src));

check('defineTheme 不再传 semanticTokenColors 字段',
    !/semanticTokenColors:/.test(resolveTheme));

check('语义规则并入 rules 数组',
    /\.\.\.this\.buildSemanticTokenRules\(normalized\.colors, normalized\.styles\)/.test(resolveTheme));

check('defineTheme 仍只含 Monaco 认识的字段',
    /base:/.test(resolveTheme) && /inherit:/.test(resolveTheme) &&
    /rules:/.test(resolveTheme) && /colors:/.test(resolveTheme));

// --- P0-2: clangd legend 里原先无色、且映射本已写对的 token ---
for (const token of ['method', 'parameter', 'property', 'macro', 'enum', 'enumMember', 'typeParameter', 'concept']) {
    check(`语义规则覆盖 ${token}`, new RegExp(`(^|[\\s{,])${token}:`).test(semanticRules));
}

// --- P1-5: 数字配色的具体 token 必须逐个覆盖（trie 按最长前缀优先）---
for (const token of ['number.hex', 'number.float', 'number.octal', 'number.binary']) {
    check(`词法规则覆盖 ${token}`, new RegExp(`makeRule\\('${token.replace('.', "\\.")}'`).test(syntaxRules));
}

// --- P1-4: 内置类型关键字表与 monarch 对齐 ---
// 关键字表要在剥注释之后解析：表内注释行里含 auto，会污染 kwList
const kwMatch = syntaxRules.match(/cppBuiltinTypeKeywords = \[([\s\S]*?)\]/);
check('关键字表存在', !!kwMatch);
const kwList = kwMatch
    ? kwMatch[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter((s) => s && /^[a-z_][\w]*$/.test(s))
    : [];
for (const missing of ['auto', 'decltype', '__int64']) {
    check(`关键字表含 ${missing}`, kwList.includes(missing));
}
for (const removed of ['size_t', 'ssize_t', 'ptrdiff_t', 'char8_t', 'char16_t', 'char32_t']) {
    check(`关键字表已移除 monarch 不产出的 ${removed}`, !kwList.includes(removed));
}
if (cppLang) {
    const notInMonarch = kwList.filter((k) => !cppLang.includes(k));
    check('关键字表每一项都能在 monarch 里找到', notInMonarch.length === 0, notInMonarch.join(','));
}

// --- P2-1: 内置类型关键字必须走 keyword 槽，不能走 type 槽 ---
//
// 实测 clangd 23.1.0（.opencode/tmp-probe，真实 LSP 交互）：
//   int/double/float/unsigned/bool/char/void/long/short/signed -> clangd 不发语义 token
//   if/return/const/static                                     -> clangd 不发语义 token
//   auto -> type [deduced+defaultLibrary+globalScope]   ← 唯一例外
//   MyClass -> class [declaration+definition+globalScope]
//   size_t  -> type [fileScope]
//
// 结论：int 等完全由 monarch 决定，monarch token 是 keyword.<kw>。
// 上一批把它们映射到 colors.type，用户改「关键字」配色时它们纹丝不动 ——
// 实际读的是「类型」槽。规则命中了，但取错了颜色槽。
{
    // 结尾是 `}))` —— .map((kw) => ({ ... })) 后跟分号，两个右括号
    const kwRuleBlock = syntaxRules.match(/const cppTypeKeywordRules = [\s\S]{0,600}?\}\)\)\;/);
    check('内置类型关键字规则块可解析', !!kwRuleBlock);
    if (kwRuleBlock) {
        const block = kwRuleBlock[0];
        check('内置类型关键字取 colors.keyword 而非 colors.type',
            /foreground:\s*this\.toMonacoColorHex\(colors\.keyword\)/.test(block) &&
            !/colors\.type/.test(block),
            block.replace(/\s+/g, ' ').slice(0, 200));
        check('内置类型关键字的 fontStyle 也取 keyword 槽',
            !/toMonacoFontStyle\(styles\.type\)/.test(block));
    }
}

// --- P2-2: auto 由 clangd 发 type[deduced]，必须单独接住 ---
//
// Monaco 的语义匹配是 [type].concat(modifiers).join('.')，
// auto 实际查询串是 type.deduced.defaultLibrary.globalScope。
// trie 按最长前缀优先，所以只需一条 type.deduced 规则即可命中。
{
    check('语义规则含 type.deduced（clangd 对 auto 的实际分类）',
        /(^|[\s{,])'type\.deduced':/.test(semanticRules) || /(^|[\s{,])type\.deduced:/.test(semanticRules),
        'auto 会落到 type 的 mainRule，与普通 typedef 同色');

    const deduced = semanticRules.match(/'?type\.deduced'?:\s*withStyle\('(\w+)',\s*'(\w+)'\)/);
    check('type.deduced 映射到 keyword 槽', !!deduced && deduced[1] === 'keyword' && deduced[2] === 'keyword',
        deduced ? `colorKey=${deduced[1]} styleKey=${deduced[2]}` : '未找到 withStyle 映射');

    // 普通 type（typedef / size_t）仍应是 type 槽，不能被 deduced 规则牵连
    check('普通 type 规则仍指向 type 槽',
        /(^|[\s{,])type:\s*withStyle\('type',\s*'type'\)/.test(semanticRules));
}

// --- P1-3: TextMate 残留与键名漂移的死规则已清除 ---
for (const dead of ['entity.name.', 'support.class', 'support.type', 'support.function',
    'type.identifier', 'constant.numeric', 'meta.preprocessor', "makeRule('pointer'",
    'operator.pointer', "makeRule('localVar'", "makeRule('globalVar'",
    'variable.local', 'variable.global', 'keyword.control', 'keyword.operator']) {
    check(`死规则已清除: ${dead}`, !syntaxRules.includes(dead));
}

// --- monarch 真实产出的 token 有对应规则 ---
if (cppLang) {
    for (const token of ['keyword.directive.include', 'annotation', 'string.escape',
        'number.hex', 'comment.doc']) {
        const produced = cppLang.includes(`"${token}"`);
        if (!produced) continue;
        const covered = syntaxRules.includes(`makeRule('${token}'`) || token === 'number.hex';
        check(`monarch 产出的 ${token} 有规则`, covered);
    }
}

// --- P1-6: 已知限制，monarch 语言定义缺口，渲染层无法覆盖 ---
if (cppLang) {
    const ops = (cppLang.match(/operators: \[([\s\S]*?)\]/) || ['', ''])[1];
    const missingOps = ['::', '->', '.*'].filter((op) => !ops.includes(`"${op}"`));
    check('P1-6 记录在案: :: -> .* 不在 monarch operators 表内，token 为空无法上色',
        missingOps.length > 0, missingOps.join(' '));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);