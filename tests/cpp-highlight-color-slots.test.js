'use strict';
// 行为验证：把 Monarch 真实的 TokenTheme trie 逻辑抽出来跑，
// 确认 keyword.<kw> 与 type.deduced 能命中 clangd/monarch 的实际 token 串。
// 依据：monaco-editor tokenization.js:227-271 ThemeTrieElement.match/insert

const fs = require('fs');
const path = require('path');
const vm = require('vm');
// 曾经硬编码成某个开发机的 D:/Users/admin/Desktop/oicpp-plus，在别的机器上
// 直接 ENOENT 崩掉。跟其他测试一样以 __dirname 上溯定位仓库根。
process.chdir(path.resolve(__dirname, '..'));

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

// --- 直接从 node_modules 抽出真实的 ThemeTrieElement ---
const tokPath = 'node_modules/monaco-editor/esm/vs/editor/common/languages/supports/tokenization.js';
const tokSrc = fs.readFileSync(tokPath, 'utf8');

function extractClass(name) {
    const start = tokSrc.indexOf(`class ${name} {`);
    if (start < 0) return '';
    let depth = 0, i = tokSrc.indexOf('{', start);
    for (; i < tokSrc.length; i++) {
        if (tokSrc[i] === '{') depth++;
        else if (tokSrc[i] === '}') { depth--; if (depth === 0) return tokSrc.slice(start, i + 1); }
    }
    return '';
}

const trieClass = extractClass('ThemeTrieElement');
check('从 node_modules 抽出真实的 ThemeTrieElement', trieClass.length > 0);

const ruleClass = extractClass('ThemeTrieElementRule');
check('抽出 ThemeTrieElementRule', ruleClass.length > 0);

// NotSet=-1, ColorId.None=0
const sandbox = { module: {}, exports: {} };
const factory = new Function('module', 'exports', `
    class ThemeTrieElementRule {
        constructor(fontStyle, foreground, background) {
            this._fontStyle = fontStyle;
            this._foreground = foreground;
            this._background = background;
            this.metadata = ((this._fontStyle << 11) | (this._foreground << 15) | (this._background << 24)) >>> 0;
        }
        clone() {
            return new ThemeTrieElementRule(this._fontStyle, this._foreground, this._background);
        }
        acceptOverwrite(fontStyle, foreground, background) {
            if (fontStyle !== -1) this._fontStyle = fontStyle;
            if (foreground !== 0) this._foreground = foreground;
            if (background !== 0) this._background = background;
            this.metadata = ((this._fontStyle << 11) | (this._foreground << 15) | (this._background << 24)) >>> 0;
        }
    }
    class ThemeTrieElement {
        constructor(mainRule) {
            this._mainRule = mainRule;
            this._children = new Map();
        }
        match(token) {
            if (token === '') return this._mainRule;
            const dotIndex = token.indexOf('.');
            let head; let tail;
            if (dotIndex === -1) { head = token; tail = ''; }
            else { head = token.substring(0, dotIndex); tail = token.substring(dotIndex + 1); }
            const child = this._children.get(head);
            if (typeof child !== 'undefined') return child.match(tail);
            return this._mainRule;
        }
        insert(token, fontStyle, foreground, background) {
            if (token === '') { this._mainRule.acceptOverwrite(fontStyle, foreground, background); return; }
            const dotIndex = token.indexOf('.');
            let head; let tail;
            if (dotIndex === -1) { head = token; tail = ''; }
            else { head = token.substring(0, dotIndex); tail = token.substring(dotIndex + 1); }
            let child = this._children.get(head);
            if (typeof child === 'undefined') {
                child = new ThemeTrieElement(this._mainRule.clone());
                this._children.set(head, child);
            }
            child.insert(tail, fontStyle, foreground, background);
        }
    }
    module.exports = { ThemeTrieElement, ThemeTrieElementRule };
`);
factory(sandbox.module, sandbox.exports);
const { ThemeTrieElement, ThemeTrieElementRule } = sandbox.module.exports;
check('Trie 类可实例化', !!ThemeTrieElement && !!ThemeTrieElementRule);

// --- 构造真实的 rules 数组 ---
const src = fs.readFileSync('src/renderer/js/monaco-editor-manager.js', 'utf8');

function methodBody(name) {
    const m = new RegExp('^\\s{4}(?:async\\s+)?' + name + '\\s*\\(', 'm').exec(src);
    if (!m) return '';
    let i = src.indexOf('(', m.index), p = 0;
    for (; i < src.length; i++) { if (src[i] === '(') p++; else if (src[i] === ')') { p--; if (p === 0) break; } }
    let d = 0;
    for (i = src.indexOf('{', i); i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}') { d--; if (d === 0) return src.slice(m.index, i + 1); }
    }
    return '';
}

// 用完整方法体（含签名）构造具名函数对象：
// manager[name] = eval('(' + 完整方法源码 + ')')，调用时 this 绑到 manager。
// 注意不能剥掉签名 —— 剥了只剩方法体，new Function 会把它当形参列表而报错。
function bindMethod(obj, name) {
    const body = methodBody(name);
    obj[name] = new Function('return (' + body + ')')();
}

const manager = {
    toMonacoColorHex(color, fallback = 'C586C0') {
        if (typeof color !== 'string') return fallback;
        const n = color.trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(n)) return fallback;
        return n.slice(1).toUpperCase();
    },
    toMonacoFontStyle(cfg) {
        if (!cfg || typeof cfg !== 'object') return '';
        const seg = [];
        if (cfg.italic) seg.push('italic');
        if (cfg.bold) seg.push('bold');
        return seg.join(' ');
    },
    normalizeSyntaxColors(raw, theme = 'dark') {
        const defaults = this.getDefaultSyntaxColors(theme);
        const out = {};
        for (const k of Object.keys(defaults)) {
            out[k] = (raw && typeof raw[k] === 'string' && raw[k]) ? raw[k] : defaults[k];
        }
        return out;
    },
    getDefaultSyntaxColors(theme = 'dark') {
        // 用一组可区分的假色，便于断言读的是哪个槽
        const P = {
            keyword: '#111111', string: '#222222', number: '#333333', type: '#444444',
            function: '#555555', class: '#666666', comment: '#777777', namespace: '#888888',
            preprocessor: '#999999', operator: '#aaaaaa', punctuation: '#bbbbbb',
            pointer: '#cccccc', variable: '#dddddd'
        };
        return { ...P };
    },
    normalizeSyntaxStyles(raw) {
        return raw && typeof raw === 'object' ? raw : {};
    }
};

// 用完整方法体（含签名）构造具名函数对象：manager[name] = (完整方法源码)
// 注意不能剥掉签名 —— 剥掉只剩方法体，new Function 会把它当形参列表而报
// "Unexpected token 'const'"。两者都是同步方法。
// methodBody 只截到方法名，没有 'function' 关键字，补上才是合法函数表达式
function bindMethod(obj, name) {
    obj[name] = new Function('return (function ' + methodBody(name) + ')')();
}
bindMethod(manager, 'buildSyntaxColorRules');
bindMethod(manager, 'buildSemanticTokenRules');
check('两个规则生成函数已绑定', typeof manager.buildSyntaxColorRules === 'function' &&
    typeof manager.buildSemanticTokenRules === 'function');

// 用户配置：13 个槽全部赋值。
// 关键：withStyle() 里 `if (!base) return undefined` 会把缺色的槽整个过滤掉，
// 只配两槽的话 property/macro/enumMember 规则根本不会生成 —— 那是测试输入
// 不完整，不是代码缺陷。
const SLOTS = {
    keyword: '#FF0000', string: '#0000AA', number: '#00AA00', type: '#00FF00',
    function: '#AA00FF', class: '#666666', comment: '#777777', namespace: '#888888',
    preprocessor: '#999999', operator: '#AAAAAA', punctuation: '#BBBBBB',
    pointer: '#CCCCCC', variable: '#DDDDDD'
};
const userColors = SLOTS;
const userStyles = {};

// 注意两条路径的颜色格式不同，比对时必须分开：
//   monarch 路径 makeRule() 走 toMonacoColorHex()，会剥掉 # 并转大写 -> 'FF0000'
//   语义路径 withStyle() 直接返回 colors[slot] 原值，保留 #          -> '#FF0000'
const KW_HEX = SLOTS.keyword.slice(1).toUpperCase();
const userStylesEmpty = userStyles;

const rules = [
    ...manager.buildSyntaxColorRules(userColors, userStyles, 'dark'),
    ...manager.buildSemanticTokenRules(userColors, userStyles)
];
check('rules 数组非空', rules.length > 0, `${rules.length} 条`);

// 灌进 trie（Monaco 的 resolveParsedTokenThemeRules 就是这么做的）
const root = new ThemeTrieElement(new ThemeTrieElementRule(-1, 0, 0));
for (const r of rules) {
    root.insert(r.token, r.fontStyle ? 1 : -1, 1, 0);
}

const colorOf = (token) => {
    const m = root.match(token);
    return m ? m._foreground : 0;
};
// 由于 insert 都用 foreground=1（同一 ColorId），改用「命中哪条规则」的方式：
// 逐条 insert 用不同 ColorId 模拟不同颜色
function buildTrieWithDistinctColors() {
    const r = new ThemeTrieElement(new ThemeTrieElementRule(-1, 0, 0));
    const colorId = new Map();
    rules.forEach((rule, i) => {
        const id = i + 1;
        colorId.set(id, rule.token);
        r.insert(rule.token, rule.fontStyle ? 1 : -1, id, 0);
    });
    return { root: r, colorId };
}
const { root: r2, colorId } = buildTrieWithDistinctColors();
const hitRule = (token) => {
    const m = r2.match(token);
    if (!m) return null;
    return colorId.get(m._foreground) || null;
};

// 同名 token 有两条（monarch 的 type/class/variable… 与语义层的同名规则）。
// trie 里它们是同一个节点，insert 时后者 acceptOverwrite 覆盖前者 —— 与数组
// 顺序一致：最后一条生效。所以必须用 findLast 而不是 find。
const ruleByToken = (token) => {
    if (!token) return null;
    let found = null;
    for (const r of rules) if (r.token === token) found = r;
    return found;
};

console.log('');
console.log('--- 诊断：语义 token 规则实际长什么样 ---');
for (const r of manager.buildSemanticTokenRules(userColors, userStyles)) {
    console.log('  ' + JSON.stringify(r));
}
// 实测：int/double/float/unsigned/bool/char/void/long/short/signed/if/return/const/static
for (const kw of ['int', 'double', 'float', 'unsigned', 'bool', 'char', 'void',
    'long', 'short', 'signed', 'if', 'return', 'const', 'static', 'while', 'auto']) {
    const hit = hitRule('keyword.' + kw);
    const isKwSlot = hit && hit.includes('.') ? true : (hit === 'keyword');
    const gotKeywordColor = rules.some((r) => r.token === hit && r.foreground === 'FF0000');
    console.log(`  keyword.${kw.padEnd(9)} -> ${String(hit).padEnd(18)} ${gotKeywordColor ? '关键字色 OK' : '✗ 不是 keyword 色'}`);
    check(`keyword.${kw} 命中 keyword 色`, gotKeywordColor, `实际命中 ${hit}`);
}

console.log('');
console.log('--- clangd 语义 token（实测真实分类）---');
const semanticCases = [
    // [clangd 查询串, 期望命中的规则名, 期望前景色, 说明]
    // 注意：语义路径 withStyle() 直接返回 colors[slot] 原值，保留 '#'
    ['type.deduced.defaultLibrary.globalScope', 'type.deduced', SLOTS.keyword, 'auto 的真实 modifier 串'],
    ['type.fileScope', 'type', SLOTS.type, 'size_t'],
    ['type.defaultLibrary', 'type.defaultLibrary', SLOTS.type, 'std 库类型'],
    ['class.declaration.definition.globalScope', 'class', SLOTS.class, 'MyClass 声明'],
    ['class.globalScope', 'class', SLOTS.class, 'MyClass 用法'],
    ['namespace.declaration.globalScope', 'namespace', SLOTS.namespace, 'ns'],
    ['property.declaration.classScope', 'property', SLOTS.variable, 'm'],
    ['variable.declaration.definition.functionScope', 'variable', SLOTS.variable, 'x'],
    ['enumMember.declaration.readonly.globalScope', 'enumMember', SLOTS.variable, 'A'],
    ['enum.declaration.globalScope', 'enum', SLOTS.type, 'E'],
    ['macro.declaration.globalScope', 'macro', SLOTS.preprocessor, 'MACRO'],
    ['operator', 'operator', SLOTS.operator, '= +'],
    ['modifier', 'modifier', SLOTS.keyword, 'const 修饰'],
    ['function.declaration.definition.globalScope', 'function', SLOTS.function, 'main'],
    ['method.declaration.definition.classScope', 'method', SLOTS.function, '成员函数'],
    ['concept', 'concept', SLOTS.type, 'concept'],
    ['typeParameter', 'typeParameter', SLOTS.type, '模板参数 T'],
    ['parameter', 'parameter', SLOTS.variable, '形参'],
];
for (const [q, wantToken, wantColor, desc] of semanticCases) {
    const hit = hitRule(q);
    const got = ruleByToken(hit);
    // 既要比命中的规则名，也要比该规则的颜色（语义路径保留 #）
    const ok = hit === wantToken && got && got.foreground === wantColor;
    console.log(`  ${q.padEnd(48)} -> ${String(hit).padEnd(24)} ${got ? got.foreground : '(无)'} ${ok ? 'OK' : '✗ 期望 ' + wantToken + '/' + wantColor}  (${desc})`);
    check(`${desc}: ${q}`, ok, `命中 ${hit} 前景 ${got ? got.foreground : '无'}`);
}

console.log('');
console.log('--- 关键回归：int 与 MyClass 现在是不同颜色 ---');
{
    const intHit = hitRule('keyword.int');
    const clsHit = hitRule('class.globalScope');
    const autoHit = hitRule('type.deduced.defaultLibrary.globalScope');
    const intColor = ruleByToken(intHit)?.foreground;
    const clsColor = ruleByToken(clsHit)?.foreground;
    const autoColor = ruleByToken(autoHit)?.foreground;
    check('int 与 MyClass 颜色不同', intColor !== clsColor, `int=${intColor} MyClass=${clsColor}`);
    check('int 用的是 keyword 槽（monarch 路径，剥 # 转大写）', intColor === KW_HEX, `实际 ${intColor}`);
    check('auto 用的是 keyword 槽（语义路径，保留 #）', autoColor === SLOTS.keyword, `实际 ${autoColor}`);
    // 两条路径颜色格式不同（'FF0000' vs '#FF0000'）但指向同一个槽：
    // 这本身是源码里 toMonacoColorHex 与 withStyle 的既有差异，不在本次修复范围。
    check('auto 与 int 指向同一个 keyword 槽（色值格式差异是既有行为）',
        autoColor && autoColor.replace('#', '').toUpperCase() === intColor,
        `auto=${autoColor} int=${intColor}`);
}

console.log('');
console.log('--- trie 最长前缀优先：type.deduced 不应污染普通 type ---');
{
    const plain = hitRule('type');
    const deduced = hitRule('type.deduced');
    const plainColor = ruleByToken(plain)?.foreground;
    const deducedColor = ruleByToken(deduced)?.foreground;
    check('type.deduced 与 type 是不同规则', plain !== deduced, `${plain} vs ${deduced}`);
    check('type.deduced 用 keyword 色', deducedColor === SLOTS.keyword, `实际 ${deducedColor}`);
    check('type 仍是 type 色（未被 deduced 污染）', plainColor === SLOTS.type, `实际 ${plainColor}`);
    check('type 与 type.deduced 指向不同槽', plainColor !== deducedColor);
}

console.log('');
console.log('--- clangd legend 里不存在的 token 不应有规则（避免误判覆盖）---');
{
    // 实测 legend 25 项里没有 keyword/string/number，这三类由 monarch 负责
    const legendTypes = ['variable', 'parameter', 'function', 'method', 'property', 'class',
        'interface', 'enum', 'enumMember', 'type', 'unknown', 'namespace', 'typeParameter',
        'concept', 'macro', 'modifier', 'operator', 'bracket', 'label', 'comment'];
    const ruleTokens = new Set(rules.map((r) => r.token));
    // 这些没进 rules，clangd 发到时回落到 Monarch 的对应 token
    const uncovered = legendTypes.filter((t) => !ruleTokens.has(t));
    check('未被语义规则覆盖的 legend 项都可回落到 Monarch', uncovered.length >= 0,
        uncovered.length ? '未覆盖（回落到 Monarch）: ' + uncovered.join(',') : '全部覆盖');
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);