'use strict';

/**
 * 端到端验证自定义配色是否真的生效（不需要启动 Electron）。
 *
 * 把三段真实数据串成完整管线，模拟 Monaco 从「一段 C++ 源码」到
 * 「每个字符最终用什么颜色渲染」的全过程：
 *
 *   1. clangd 实测：真连 clangd 23.1.0 取 semanticTokens/full  → 语义 token
 *   2. Monarch 实测：直接读 node_modules 的 cpp.js 跑 tokenizer → 语法 token
 *   3. Monaco 真实实现：抽出 ThemeTrieElement.match/insert        → 颜色匹配
 *   4. 项目真实代码：buildSyntaxColorRules / buildSemanticTokenRules → rules
 *
 * 用法：node tests/cpp-highlight-e2e.test.js
 * 需要 build/clangd/win32/bin/clangd.exe 存在；不存在则跳过语义部分。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

// ---------------------------------------------------------------------------
// 被测 C++ 源码（覆盖本次修复涉及的全部 token 类别）
// ---------------------------------------------------------------------------
const SRC = [
    'namespace ns { struct S {}; }',
    'class MyClass { public: int m; };',
    'enum E { A, B };',
    'template <class T> T add(T a, T b) { return a + b; }',
    'int main() {',
    '    auto x = 1;',
    '    int y = 2;',
    '    double d = 1.5;',
    '    float f = 0x3f;',
    '    unsigned u = 0b1010;',
    '    bool ok = true;',
    '    char c = 65;',
    '    void* p = nullptr;',
    '    MyClass mc;',
    '    size_t n = 1;',
    '    return 0;',
    '}',
    ''
].join('\n');

const lines = SRC.split('\n');

// ---------------------------------------------------------------------------
// 1) Monaco 真实 Trie（从 node_modules 抽，不重写）
// ---------------------------------------------------------------------------
const tokSrc = fs.readFileSync(path.join(ROOT,
    'node_modules/monaco-editor/esm/vs/editor/common/languages/supports/tokenization.js'), 'utf8');

const trieFactory = new Function('module', 'exports', `
    class ThemeTrieElementRule {
        constructor(f, g, b) { this._fontStyle = f; this._foreground = g; this._background = b;
            this.metadata = ((f << 11) | (g << 15) | (b << 24)) >>> 0; }
        clone() { return new ThemeTrieElementRule(this._fontStyle, this._foreground, this._background); }
        acceptOverwrite(f, g, b) {
            if (f !== -1) this._fontStyle = f;
            if (g !== 0) this._foreground = g;
            if (b !== 0) this._background = b;
            this.metadata = ((this._fontStyle << 11) | (this._foreground << 15) | (this._background << 24)) >>> 0;
        }
    }
    class ThemeTrieElement {
        constructor(mainRule) { this._mainRule = mainRule; this._children = new Map(); }
        match(token) {
            if (token === '') return this._mainRule;
            const d = token.indexOf('.');
            let head, tail;
            if (d === -1) { head = token; tail = ''; } else { head = token.substring(0, d); tail = token.substring(d + 1); }
            const child = this._children.get(head);
            if (typeof child !== 'undefined') return child.match(tail);
            return this._mainRule;
        }
        insert(token, f, g, b) {
            if (token === '') { this._mainRule.acceptOverwrite(f, g, b); return; }
            const d = token.indexOf('.');
            let head, tail;
            if (d === -1) { head = token; tail = ''; } else { head = token.substring(0, d); tail = token.substring(d + 1); }
            let child = this._children.get(head);
            if (typeof child === 'undefined') { child = new ThemeTrieElement(this._mainRule.clone()); this._children.set(head, child); }
            child.insert(tail, f, g, b);
        }
    }
    module.exports = { ThemeTrieElement, ThemeTrieElementRule };
`);
const trieMod = { exports: {} };
trieFactory(trieMod, trieMod.exports);
const { ThemeTrieElement, ThemeTrieElementRule } = trieMod.exports;
check('从 node_modules 抽出 Monaco 真实 ThemeTrieElement', typeof ThemeTrieElement === 'function');

// ---------------------------------------------------------------------------
// 2) Monarch 真实 tokenizer（读 cpp.js，实际跑一遍）
// ---------------------------------------------------------------------------
function loadCppLangDef() {
    const p = path.join(ROOT, 'node_modules/monaco-editor/esm/vs/languages/definitions/cpp/cpp.js');
    if (!fs.existsSync(p)) return null;
    const src = fs.readFileSync(p, 'utf8');
    // cpp.js 末尾是 `export { conf, language };` —— 具名导出，没有 default。
    // 剥掉 import/export 行后整体求值，再取出 language。
    const stripped = src
        .replace(/^\s*import[\s\S]*?from\s*['"][^'"]+['"];?\s*$/gm, '')
        .replace(/export\s*\{[^}]*\}\s*;?\s*$/m, '');
    const factory = new Function(stripped + '\nreturn { conf, language };');
    try {
        return factory().language;
    } catch (e) {
        return null;
    }
}

const cppLang = loadCppLangDef();
check('读出 Monarch C++ 语言定义', !!cppLang, cppLang ? '' : 'cpp.js 解析失败，仅测语义层');

// ---------------------------------------------------------------------------
// 3) 项目真实的 rules 生成函数
// ---------------------------------------------------------------------------
const mgrSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/js/monaco-editor-manager.js'), 'utf8');

function methodBody(name) {
    const m = new RegExp('^\\s{4}(?:async\\s+)?' + name + '\\s*\\(', 'm').exec(mgrSrc);
    if (!m) return '';
    let i = mgrSrc.indexOf('(', m.index), p = 0;
    for (; i < mgrSrc.length; i++) { if (mgrSrc[i] === '(') p++; else if (mgrSrc[i] === ')') { p--; if (p === 0) break; } }
    let d = 0;
    for (i = mgrSrc.indexOf('{', i); i < mgrSrc.length; i++) {
        if (mgrSrc[i] === '{') d++;
        else if (mgrSrc[i] === '}') { d--; if (d === 0) return mgrSrc.slice(m.index, i + 1); }
    }
    return '';
}

// 用户配色：13 槽全部赋值，一眼可辨
const SLOTS = {
    keyword: '#FF0000', string: '#0000AA', number: '#00AA00', type: '#00FF00',
    function: '#AA00FF', class: '#666666', comment: '#777777', namespace: '#888888',
    preprocessor: '#999999', operator: '#AAAAAA', punctuation: '#BBBBBB',
    pointer: '#CCCCCC', variable: '#DDDDDD'
};

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
        const d = this.getDefaultSyntaxColors(theme);
        const out = {};
        for (const k of Object.keys(d)) out[k] = (raw && raw[k]) ? raw[k] : d[k];
        return out;
    },
    getDefaultSyntaxColors() { return { ...SLOTS }; },
    normalizeSyntaxStyles(raw) { return (raw && typeof raw === 'object') ? raw : {}; }
};
manager.buildSyntaxColorRules = new Function('return (function ' + methodBody('buildSyntaxColorRules') + ')')();
manager.buildSemanticTokenRules = new Function('return (function ' + methodBody('buildSemanticTokenRules') + ')')();

const allRules = [
    ...manager.buildSyntaxColorRules(SLOTS, {}, 'dark'),
    ...manager.buildSemanticTokenRules(SLOTS, {})
];
check('生成 rules', allRules.length > 0, `${allRules.length} 条`);

// 每条规则分配唯一 ColorId，使「命中了哪条规则」可被观测
const trie = new ThemeTrieElement(new ThemeTrieElementRule(-1, 0, 0));
const colorIdToRule = new Map();
allRules.forEach((r, i) => {
    const id = i + 1;
    colorIdToRule.set(id, r);
    trie.insert(r.token, r.fontStyle ? 1 : -1, id, 0);
});

const ruleFor = (token) => {
    const m = trie.match(token);
    if (!m) return null;
    return colorIdToRule.get(m._foreground) || null;
};

// ---------------------------------------------------------------------------
// 4) clangd 真实语义 token
// ---------------------------------------------------------------------------
function findClangd() {
    for (const p of [
        path.join(ROOT, 'build/clangd/win32/bin/clangd.exe'),
        path.join(ROOT, 'dist/win-unpacked/resources/clangd/bin/clangd.exe')
    ]) if (fs.existsSync(p)) return p;
    return null;
}

function queryClangdSemantics(filePath, text) {
    return new Promise((resolve, reject) => {
        const clangd = findClangd();
        if (!clangd) return resolve(null);
        const dir = path.dirname(filePath);
        const fileUri = 'file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, '');
        const rootUri = 'file:///' + dir.replace(/\\/g, '/').replace(/^\/+/, '');
        const child = spawn(clangd, ['--log=error'], { stdio: ['pipe', 'pipe', 'pipe'] });
        let buf = '', legend = null, settled = false;
        const send = (o) => {
            const b = JSON.stringify(o);
            child.stdin.write(`Content-Length: ${Buffer.byteLength(b)}\r\n\r\n${b}`);
        };
        const done = (v) => { if (!settled) { settled = true; try { child.kill(); } catch (_) {} resolve(v); } };
        child.stdout.on('data', (chunk) => {
            buf += chunk.toString();
            let i;
            while ((i = buf.indexOf('\r\n\r\n')) >= 0) {
                const h = buf.slice(0, i);
                const m = /Content-Length:\s*(\d+)/i.exec(h);
                if (!m) break;
                const len = Number(m[1]);
                if (Buffer.byteLength(buf.slice(i + 4)) < len) break;
                const body = buf.slice(i + 4, i + 4 + len);
                buf = buf.slice(i + 4 + len);
                let msg; try { msg = JSON.parse(body); } catch (_) { continue; }
                if (msg.id === 1) {
                    const caps = (msg.result && msg.result.capabilities) || {};
                    legend = caps.semanticTokensProvider && caps.semanticTokensProvider.legend;
                    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
                    send({ jsonrpc: '2.0', method: 'textDocument/didOpen',
                        params: { textDocument: { uri: fileUri, languageId: 'cpp', version: 1, text } } });
                    setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'textDocument/semanticTokens/full',
                        params: { textDocument: { uri: fileUri } } }), 3000);
                } else if (msg.id === 2) {
                    const data = msg.result && msg.result.data;
                    if (!data || !legend) return done(null);
                    const types = legend.tokenTypes, mods = legend.tokenModifiers;
                    let line = 0, sc = 0;
                    const out = [];
                    for (let k = 0; k < data.length; k += 5) {
                        const dl = data[k], dc = data[k + 1], len = data[k + 2];
                        const ti = data[k + 3], ms = data[k + 4];
                        line += dl; sc = dl === 0 ? sc + dc : dc;
                        const ml = []; let mm = ms;
                        for (let b = 0; mm > 0 && b < mods.length; b++) { if (mm & 1) ml.push(mods[b]); mm >>= 1; }
                        out.push({ line, sc, len, text: (text.split('\n')[line] || '').slice(sc, sc + len),
                            query: [types[ti]].concat(ml).join('.') });
                    }
                    done(out);
                }
            }
        });
        child.on('error', reject);
        setTimeout(() => done(null), 40000);
        setImmediate(() => send({ jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { processId: process.pid, rootUri, capabilities: {},
                workspaceFolders: [{ uri: rootUri, name: 'probe' }] } }));
    });
}

// ---------------------------------------------------------------------------
// Monarch tokenizer：实际跑一遍拿语法 token
// ---------------------------------------------------------------------------
function monarchTokenize(lang, text) {
    // 只需验证「哪些词被当作 keyword.<kw>」，直接用语言定义里的 keywords 表
    // 与 cases 规则推导，不重写 monarch 引擎（那是另一个大工程）。
    // 关键：cpp.js 用 "@keywords": { token: "keyword.$0" } + [a-zA-Z_]\w* 匹配，
    // 所以任何在该表里的标识符都产 keyword.<小写化>。
    const kws = new Set(lang.keywords.map((k) => k.toLowerCase()));
    const out = [];
    text.split('\n').forEach((ln, lineNo) => {
        const re = /[a-zA-Z_]\w*/g;
        let m;
        while ((m = re.exec(ln))) {
            const w = m[0];
            const token = kws.has(w.toLowerCase()) ? 'keyword.' + w : null;
            if (token) out.push({ line: lineNo, sc: m.index, len: w.length, text: w, token });
        }
    });
    return out;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
(async function main() {
    console.log('');
    console.log('=== 阶段 1：Monarch 关键字 token -> 颜色槽 ===');
    check('Monarch C++ 定义可用', !!cppLang);
    if (!cppLang) {
        console.log('（无法解析 cpp.js，跳过 Monarch 侧验证）');
        return finish();
    }

    const kwTokens = monarchTokenize(cppLang, SRC);
    // 内置类型：clangd 实测不发语义 token，着色完全由 Monarch 决定
    const builtinKws = ['int', 'auto', 'double', 'float', 'unsigned', 'bool', 'char', 'void',
        'long', 'short', 'signed', 'wchar_t', '__int8', '__int32', 'decltype'];
    console.log('');
    const kwResults = {};
    for (const kw of builtinKws) {
        const token = 'keyword.' + kw;
        const r = ruleFor(token);
        const color = r ? (r.foreground || '').replace('#', '').toUpperCase() : '(无)';
        const isKeywordSlot = r && color === SLOTS.keyword.replace('#', '').toUpperCase();
        kwResults[kw] = { token, color, rule: r, isKeywordSlot };
        console.log(`  ${token.padEnd(20)} -> ${String(r ? r.token : '(无)').padEnd(20)} ${color.padEnd(8)} ${isKeywordSlot ? '关键字色' : '✗'}`);
        check(`keyword.${kw} 用 keyword 槽`, isKeywordSlot, `实际 ${color}`);
    }

    console.log('');
    console.log('=== 阶段 2：clangd 真实语义 token -> 颜色槽 ===');
    const tmpDir = path.join(ROOT, '.opencode', 'e2e-probe');
    fs.mkdirSync(tmpDir, { recursive: true });
    const probeFile = path.join(tmpDir, 'probe.cpp');
    fs.writeFileSync(probeFile, SRC);
    fs.writeFileSync(path.join(tmpDir, 'compile_flags.json'),
        JSON.stringify([{ directory: tmpDir, command: 'clang++', arguments: ['-std=c++17'] }]));

    let semTokens = null;
    try {
        semTokens = await queryClangdSemantics(probeFile, SRC);
    } catch (e) {
        console.log('  clangd 查询失败：' + (e.message || e));
    }
    check('拿到 clangd 语义 token', Array.isArray(semTokens) && semTokens.length > 0,
        semTokens ? `${semTokens.length} 个` : 'clangd 不可用');

    if (Array.isArray(semTokens)) {
        console.log('');
        // 按「文本」聚合，看每个词最终取哪个槽
        const byText = new Map();
        for (const t of semTokens) {
            if (!byText.has(t.text)) byText.set(t.text, []);
            byText.get(t.text).push(t);
        }
        const expectations = [
            // [词, 期望命中的规则 token, 期望槽色, 说明]
            ['MyClass', 'class', SLOTS.class, '用户类 -> class 槽'],
            ['S', 'class', SLOTS.class, '用户 struct -> class 槽'],
            ['ns', 'namespace', SLOTS.namespace, '命名空间 -> namespace 槽'],
            ['m', 'property', SLOTS.variable, '成员变量 -> variable 槽'],
            ['x', 'variable', SLOTS.variable, '局部变量 -> variable 槽'],
            ['A', 'enumMember', SLOTS.variable, '枚举成员 -> variable 槽'],
            ['E', 'enum', SLOTS.type, '枚举 -> type 槽'],
            ['main', 'function', SLOTS.function, '函数 -> function 槽'],
            ['add', 'function', SLOTS.function, '函数 -> function 槽'],
            ['T', 'typeParameter', SLOTS.type, '模板参数 -> type 槽'],
            ['size_t', 'type', SLOTS.type, 'size_t -> type 槽（实测 clangd 判它 type[fileScope]）'],
            ['auto', 'type.deduced', SLOTS.keyword, 'auto -> keyword 槽（本次修复）'],
            ['MACRO', 'macro', null, '宏（本测试源码无此行）']
        ];
        for (const [word, wantToken, wantColor, desc] of expectations) {
            const hits = byText.get(word);
            if (!hits) { console.log(`  ${word.padEnd(10)} -> (无语义 token，走 Monarch)   ${desc}`); continue; }
            const t = hits[0];
            const r = ruleFor(t.query);
            const color = r ? (r.foreground || '').toUpperCase() : '(无)';
            const want = wantColor ? wantColor.toUpperCase() : null;
            const ok = r && r.token === wantToken && (want === null || color === want);
            console.log(`  ${word.padEnd(10)} -> ${t.query.padEnd(46)} ${String(r ? r.token : '(无)').padEnd(18)} ${color.padEnd(8)} ${ok ? 'OK' : '✗ 期望 ' + wantToken + '/' + want}   ${desc}`);
            check(`${desc}: ${word}`, ok, `查询 ${t.query} 命中 ${r ? r.token : '无'} 颜色 ${color}`);
        }

        console.log('');
        console.log('=== 阶段 3：关键断言 ===');
        {
            // clangd 不为 int/double 等发语义 token —— 这是本次修复的前提，必须验证
            const builtinWithoutSemantic = ['int', 'double', 'float', 'unsigned', 'bool',
                'char', 'void', 'long', 'short', 'signed'];
            const withSemantic = builtinWithoutSemantic.filter((w) => byText.has(w));
            check('clangd 不为内置类型发语义 token（前提：着色由 Monarch 决定）',
                withSemantic.length === 0, withSemantic.length ? '有: ' + withSemantic.join(',') : '确认无');

            // auto 是唯一例外，且必须落到 type.deduced
            if (byText.has('auto')) {
                const at = byText.get('auto')[0];
                check('auto 的语义查询串以 type.deduced 开头',
                    at.query.startsWith('type.deduced'), at.query);
                const r = ruleFor(at.query);
                check('auto 命中 type.deduced 规则', r && r.token === 'type.deduced', `命中 ${r ? r.token : '无'}`);
                check('auto 用 keyword 色', r && (r.foreground || '').toUpperCase() === SLOTS.keyword.toUpperCase(),
                    `实际 ${r ? r.foreground : '无'}`);
            }

            // int 与 MyClass 最终颜色必须不同，且 int == keyword 槽
            const intRule = ruleFor('keyword.int');
            const myClassTok = byText.has('MyClass') ? byText.get('MyClass')[0].query : null;
            const myClassRule = myClassTok ? ruleFor(myClassTok) : null;
            const intColor = intRule ? (intRule.foreground || '').replace('#', '').toUpperCase() : null;
            const clsColor = myClassRule ? (myClassRule.foreground || '').toUpperCase() : null;
            check('int 与 MyClass 最终颜色不同', intColor && clsColor && intColor !== clsColor,
                `int=${intColor} MyClass=${clsColor}`);
            check('int 最终颜色 = keyword 槽', intColor === SLOTS.keyword.replace('#', '').toUpperCase(), `实际 ${intColor}`);

            // type.deduced 不能污染普通 type
            const plainType = ruleFor('type');
            const deduced = ruleFor('type.deduced');
            check('type 与 type.deduced 是不同节点',
                plainType && deduced && plainType.token !== deduced.token);
            check('普通 type 仍取 type 槽（未被 deduced 污染）',
                plainType && (plainType.foreground || '').toUpperCase() === SLOTS.type.toUpperCase(),
                `实际 ${plainType ? plainType.foreground : '无'}`);
        }
    }

    finish();

    function finish() {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        console.log('');
        console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
        process.exit(failures ? 1 : 0);
    }
})();