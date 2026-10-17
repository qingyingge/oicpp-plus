'use strict';

// 这个文件守的是 C++ 语法配色的规则形状。
//
// 上一版全部是「读 monaco-editor-manager.js 的文本再正则匹配」，52 条断言、0 条行为断言。
// 那样守不住东西：.js 现在由 tsc 从 .ts 就地产出，类型擦除会把 settings.theme 写成
// settings['theme']、给表达式补一层括号、把单行 if 拆成两行 —— 行为没变，文本变了，
// 文本断言就假失败。反过来文本断言还有两处**白过**：
//   1. methodBody() 抽取失败时返回 ''，于是 /xxx/.test('') 为假、!includes(x) 为真，
//      「死规则已清除」这 15 条与「不再传 semanticTokenColors」会空真通过；
//   2. keyword.<kw> 在 trie 里会回落到通用的 keyword 主规则，两者同色，
//      所以「关键字表漏一项」在行为上完全测不出来。
// 现在改成：从产物里抽出真实方法体并用 new Function 绑起来跑，断言落在返回的 rules 上；
// 抽取本身改成 fail-closed（一条方法绑不上就是 FAIL）。
//
// 实测依据（clangd 23.1.0 真实 LSP 交互）：
//   int/double/float/unsigned/bool/char/void/long/short/signed/if/return/const/static
//     -> clangd 不发语义 token，完全由 monarch 决定，token 名是 keyword.<kw>
//   auto -> type [deduced+defaultLibrary+globalScope]   ← 唯一例外，语义上它是关键字
//   size_t -> type [fileScope]；MyClass -> class [declaration+definition+globalScope]

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
check('monarch 语言定义 cpp.js 可读（关键字表交叉验证的前提）', cppLang.length > 0,
    cppLang ? `${cppLang.length} 字节` : `路径不存在：${cppLangPath}`);

// 用「方法定义形态」定位：行首四空格缩进 + 名字 + 参数列表 + 紧跟的 {
// （不能用裸 indexOf，名字也会出现在调用处）
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

// 用完整方法体（含签名）构造函数对象。不能剥掉签名 —— 只剩方法体时
// new Function 会把首行当形参列表。
function bindMethod(obj, name) {
    const body = methodBody(name);
    if (!body) return;
    obj[name] = new Function('return (function ' + body + ')')();
}

// 这些方法的传递闭包：两个规则生成器 + 主题装配路径，全部来自真实产物，
// 不做任何有损简化。它们只碰 this 上的彼此与全局 monaco/logWarn，不碰 DOM。
const MANAGER_METHODS = [
    'buildSyntaxColorRules', 'buildSemanticTokenRules', 'resolveMonacoTheme',
    'getThemeSyntaxOverride', 'getThemePreset', 'getBaseMonacoThemeName',
    'normalizeThemeKey', 'normalizeSyntaxColors', 'normalizeSyntaxStyles',
    'normalizeSyntaxColorsByTheme', 'getDefaultSyntaxColors', 'getDefaultSyntaxStyles',
    'getSyntaxTokenKeys', 'resolveSyntaxTokenValue', 'toMonacoColorHex', 'toMonacoFontStyle'
];

const manager = {};
MANAGER_METHODS.forEach((name) => bindMethod(manager, name));
// fail-closed：抽不出来就是 16 条 FAIL，而不是让后面一整批断言空真。
for (const name of MANAGER_METHODS) {
    check(`方法体抽取成功: ${name}`, typeof manager[name] === 'function');
}

// 规则生成与主题装配都只用到这两个全局；new Function 的产物在作用域链末端取全局。
global.logWarn = () => {};

// --- 构造可区分的槽色 ---
//
// 13 个槽必须两两不同色，否则「取错槽」这件事在行为上不可观测：
// 真实预设里 keyword 与 preprocessor 同色、type 与 class 同色。
// 两个生成器的入参位置不同，色值形状也就不同，比对时必须分开：
//   buildSyntaxColorRules 内部会过真实的 normalizeSyntaxColors 与 toMonacoColorHex
//     -> 剥 # 转大写，'AA0000'
//   buildSemanticTokenRules 的 colors 是调用方给的已归一化值，withStyle 不再加工
//     -> 原样返回，'#AA0000'
const SLOTS = {
    keyword: '#AA0000', string: '#00AA00', number: '#0000AA', type: '#AAAA00',
    function: '#AA00AA', class: '#00AAAA', comment: '#555555', namespace: '#7733EE',
    preprocessor: '#EE7733', operator: '#112233', punctuation: '#332211',
    pointer: '#445566', variable: '#665544'
};
const hex = (slot) => SLOTS[slot].slice(1).toUpperCase();
// buildSemanticTokenRules 收的是已归一化的 colors；这里直接把 SLOTS 传进去，
// 所以语义路径的 foreground 就是该槽的原值（withStyle 不再加工色值）。
const raw = (slot) => SLOTS[slot];
for (const [a, b] of [['keyword', 'preprocessor'], ['type', 'class'], ['type', 'number']]) {
    check(`测试输入自洽：${a} 与 ${b} 必须不同色`, SLOTS[a] !== SLOTS[b], `${SLOTS[a]} vs ${SLOTS[b]}`);
}

const syntaxRules = manager.buildSyntaxColorRules(SLOTS, {}, 'dark');
const semanticRules = manager.buildSemanticTokenRules(SLOTS, {});
const tokenSet = new Set([...syntaxRules, ...semanticRules].map((r) => r.token));
const ruleOf = (token) => [...syntaxRules, ...semanticRules].reverse().find((r) => r.token === token);

check('词法规则产出非空 rules 数组', Array.isArray(syntaxRules) && syntaxRules.length > 0,
    `${syntaxRules.length} 条`);
check('语义规则产出非空 rules 数组', Array.isArray(semanticRules) && semanticRules.length > 0,
    `${semanticRules.length} 条`);
check('每条规则都有 token 与 foreground',
    [...syntaxRules, ...semanticRules].every((r) => typeof r.token === 'string' && r.token &&
        typeof r.foreground === 'string'));

// --- P0-1: 语义 token 必须走 rules，Monaco 不读 semanticTokenColors 字段 ---
//
// StandaloneTheme 只认 base/inherit/rules/colors/encodedTokensColors；defineTheme
// 不校验多余键，写 semanticTokenColors 会石沉大海且无报错。所以这里灌一个
// 捕获用的 monaco.editor.defineTheme，直接断言送出去的载荷形状。
{
    let captured = null;
    let capturedName = null;
    global.monaco = {
        editor: {
            defineTheme(name, theme) { capturedName = name; captured = theme; }
        }
    };
    const returned = manager.resolveMonacoTheme('dark', {
        syntaxColors: SLOTS,
        syntaxFontStyles: { keyword: { italic: true } }
    });
    check('resolveMonacoTheme 走的是自定义主题分支（defineTheme 没抛）',
        typeof returned === 'string' && returned === `${capturedName}`,
        `返回 ${returned}，defineTheme 收到 ${capturedName}`);
    check('defineTheme 载荷只含 Monaco 认识的字段',
        !!captured && Object.keys(captured).sort().join(',') === 'base,colors,inherit,rules',
        captured ? Object.keys(captured).sort().join(',') : '没捕获到载荷');
    check('defineTheme 不再传 semanticTokenColors 字段',
        !!captured && !('semanticTokenColors' in captured));
    check('语义规则已并入 rules 数组',
        !!captured && Array.isArray(captured.rules) &&
        captured.rules.some((r) => r.token === 'type.deduced') &&
        captured.rules.some((r) => r.token === 'method'));
    check('词法与语义规则在同一条 rules 数组里',
        !!captured && Array.isArray(captured.rules) &&
        captured.rules.some((r) => r.token === 'keyword') &&
        captured.rules.some((r) => r.token === 'keyword.int'));
    check('旧的 buildSemanticTokenColors 已不存在（返回值是 rules 不是字段）',
        manager.buildSemanticTokenColors === undefined &&
        !src.includes('buildSemanticTokenColors'));
}

// --- P1-4: 内置类型关键字表与 monarch 对齐 ---
//
// 逐个断言 keyword.<kw> 这条规则**存在**，trie 回落会掩盖缺失，所以不能只比颜色。
const BUILTIN_KEYWORDS = ['bool', 'char', 'double', 'float', 'int', 'long', 'short',
    'signed', 'unsigned', 'void', 'wchar_t', 'auto', 'decltype',
    '__int8', '__int16', '__int32', '__int64'];
for (const kw of BUILTIN_KEYWORDS) {
    check(`内置类型关键字规则存在: keyword.${kw}`, tokenSet.has(`keyword.${kw}`));
}
// size_t / char16_t 这类不是 C++ 关键字，monarch 产出的是 identifier，
// 由 clangd 的 type / type.defaultLibrary 语义 token 上色，列进表里只会得到永不命中的空转规则。
for (const removed of ['size_t', 'ssize_t', 'ptrdiff_t', 'char8_t', 'char16_t', 'char32_t']) {
    check(`monarch 不产出的 ${removed} 不在关键字表里`, !tokenSet.has(`keyword.${removed}`));
}
if (cppLang) {
    const notInMonarch = BUILTIN_KEYWORDS.filter((k) => !cppLang.includes(k));
    check('关键字表每一项都能在 monarch 语言定义里找到', notInMonarch.length === 0,
        notInMonarch.join(','));
}

// --- P1-5: 数字配色的具体 token 必须逐个覆盖 ---
//
// TokenTheme 按最长前缀匹配、与书写顺序无关（tokenization.js 的 _match）。
// 不逐个覆盖的话，用户配的数字色对 0x3f / 0b1010 / 0o17 一律无效。
for (const token of ['number.hex', 'number.float', 'number.octal', 'number.binary']) {
    const rule = ruleOf(token);
    check(`词法规则覆盖 ${token} 且取 number 槽`, !!rule && rule.foreground === hex('number'),
        rule ? rule.foreground : '未找到规则');
}

// --- monarch 真实产出的 token 有对应规则，且取对槽 ---
for (const [token, slot] of [['keyword.directive.include', 'preprocessor'],
    ['annotation', 'preprocessor'], ['string.escape', 'string'], ['comment.doc', 'comment'],
    ['number.hex', 'number']]) {
    if (cppLang) {
        check(`${token} 确实是 monarch 产出的 token`, cppLang.includes(`"${token}"`));
    }
    const rule = ruleOf(token);
    check(`${token} 取 ${slot} 槽`, !!rule && rule.foreground === hex(slot),
        rule ? rule.foreground : '未找到规则');
}

// --- P2-1: 内置类型关键字必须走 keyword 槽，不能走 type 槽 ---
//
// 上一批把它们映射到 colors.type，用户改「关键字」配色时这些词纹丝不动。
// 行为层已有 color-slots 逐个比色（13 条）与 e2e（15 条）覆盖；这里补的是
// 那两处都不看的 fontStyle —— 那两个文件传进去的 styles 恒为空对象。
for (const kw of ['int', 'auto', '__int64']) {
    const rule = ruleOf(`keyword.${kw}`);
    check(`keyword.${kw} 取 keyword 槽而非 type 槽`,
        !!rule && rule.foreground === hex('keyword') && rule.foreground !== hex('type'),
        rule ? rule.foreground : '未找到规则');
}
{
    const styled = manager.buildSyntaxColorRules(SLOTS, { keyword: { italic: true } }, 'dark');
    const kwRules = styled.filter((r) => r.token === 'keyword' || r.token.startsWith('keyword.') &&
        !['keyword.directive', 'keyword.directive.include'].includes(r.token));
    check('italic 样式下每条 keyword.* 规则都带上 fontStyle',
        kwRules.length > 0 && kwRules.every((r) => r.fontStyle === 'italic'),
        `${kwRules.length} 条，缺样式的：` +
        kwRules.filter((r) => r.fontStyle !== 'italic').map((r) => r.token).join(','));
    const typeRule = styled.find((r) => r.token === 'type');
    check('italic 只跟着 keyword 槽，不牵连 type 规则',
        !!typeRule && typeRule.fontStyle === undefined,
        typeRule ? String(typeRule.fontStyle) : '未找到 type 规则');
}

// --- P2-2: auto 由 clangd 发 type[deduced]，必须单独接住 ---
//
// Monaco 匹配的是 [type].concat(modifiers).join('.')，auto 实际查询串是
// type.deduced.defaultLibrary.globalScope；trie 最长前缀优先，故一条 type.deduced 足够。
{
    const deduced = ruleOf('type.deduced');
    check('语义规则含 type.deduced（clangd 对 auto 的实际分类）', !!deduced);
    check('type.deduced 取 keyword 槽', !!deduced && deduced.foreground === raw('keyword'),
        deduced ? deduced.foreground : '未找到规则');
    const plainType = semanticRules.find((r) => r.token === 'type');
    check('普通 type 规则仍指向 type 槽（不被 deduced 牵连）',
        !!plainType && plainType.foreground === raw('type'),
        plainType ? plainType.foreground : '未找到规则');
    const modifier = ruleOf('modifier');
    check('modifier 取 keyword 槽', !!modifier && modifier.foreground === raw('keyword'),
        modifier ? modifier.foreground : '未找到规则');
}

// --- P0-2: clangd legend 里原先无色、且映射本已写对的 token ---
for (const [token, slot] of [['method', 'function'], ['parameter', 'variable'],
    ['property', 'variable'], ['macro', 'preprocessor'], ['enum', 'type'],
    ['enumMember', 'variable'], ['typeParameter', 'type'], ['concept', 'type']]) {
    const rule = ruleOf(token);
    check(`语义规则覆盖 ${token} 且取 ${slot} 槽`,
        !!rule && rule.foreground === raw(slot), rule ? rule.foreground : '未找到规则');
}

// --- P1-3: TextMate 残留与键名漂移的死规则已清除 ---
//
// 直接查产出的 token 集合，比在源码文本里找字符串可靠：注释里复述这些名字
// 不会影响结果，而抽取失败也不再是空真（上面已有 16 条 fail-closed）。
for (const deadPrefix of ['entity.name.', 'support.']) {
    const hits = [...syntaxRules].map((r) => r.token).filter((t) => t.startsWith(deadPrefix));
    check(`死规则已清除: ${deadPrefix}*`, hits.length === 0, hits.join(','));
}
for (const dead of ['type.identifier', 'constant.numeric', 'meta.preprocessor', 'pointer',
    'operator.pointer', 'localVar', 'globalVar', 'variable.local', 'variable.global',
    'keyword.control', 'keyword.operator']) {
    check(`死规则已清除: ${dead}`, !tokenSet.has(dead));
}
// 语义层的 operator 是 clangd legend 里的合法 token，别把上面那条清除做成误伤。
check('语义 operator 规则仍在（清除死规则没误伤合法 token）',
    semanticRules.some((r) => r.token === 'operator'));

// --- P1-6: 已知限制，monarch 语言定义缺口，渲染层无法覆盖 ---
if (cppLang) {
    const ops = (cppLang.match(/operators: \[([\s\S]*?)\]/) || ['', ''])[1];
    const missingOps = ['::', '->', '.*'].filter((op) => !ops.includes(`"${op}"`));
    check('P1-6 记录在案: :: -> .* 不在 monarch operators 表内，token 为空无法上色',
        missingOps.length > 0, missingOps.join(' '));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);
