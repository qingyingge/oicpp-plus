'use strict';

// 切片工具自身的回归测试。它现在被多个读源码的测试依赖，
// 一旦它自己切错，那些文件会一起静默失真，所以先验证工具本身。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { arrowExpr, arrowProp, callbackBody, callStatement, classMethod, compileMethod, funcDecl, toFn, toProviderFn } = require('./fixtures/source-extract');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};
const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');

const SRC = [
    'class A {',
    '    simple(a) {',
    '        return a;',
    '    }',
    '    async loaded(b = { x: 1 }) {',
    '        try {',
    '            if (b) {',
    '                return { deep: { nested: [1, 2] } };',
    '            }',
    '        }',
    '        catch (_) { }',
    '        return this.tag + b;',
    '    }',
    '    notMatched() { }',
    '}'
].join('\n');

check('classMethod 取到同步方法',
    classMethod(SRC, 'simple') === '    simple(a) {\n        return a;\n    }',
    JSON.stringify(classMethod(SRC, 'simple')));

const loaded = classMethod(SRC, 'loaded');
check('classMethod 取到 async 方法且含签名',
    loaded.startsWith('    async loaded(b = { x: 1 }) {') && loaded.endsWith('}'),
    JSON.stringify(loaded.slice(0, 40)));
check('默认值里的花括号不会提前收尾',
    loaded.includes('return this.tag + b;'), loaded.replace(/\s+/g, ' ').slice(-40));
check('方法体里的 } catch (_) { } 不会提前收尾',
    loaded.includes('catch (_) { }') && loaded.split('\n    }').length === 2,
    String(loaded.split('\n    }').length));
check('方法名查不到时返回空串（调用方据此红）', classMethod(SRC, 'nope') === '');
check('classMethod 不会匹配到调用处', classMethod(SRC, 'notMatched').includes('notMatched() { }'));

// 行中调用形态（带 this.前缀）不应被当成方法定义
const CALLER = 'class B {\n    run() {\n        this.simple(1);\n    }\n}';
check('调用处不会被误认成方法定义', classMethod(CALLER, 'simple') === '',
    JSON.stringify(classMethod(CALLER, 'simple')));

const TOP = 'function outer(x) {\n    if (x) {\n        return { a: 1 };\n    }\n}\nfunction other() { }';
check('funcDecl 取到顶层函数', funcDecl(TOP, 'outer') === TOP.slice(0, TOP.indexOf('\n}\n') + 2),
    JSON.stringify(funcDecl(TOP, 'outer').slice(-12)));
check('funcDecl 查不到时返回空串', funcDecl(TOP, 'missing') === '');
// funcDecl 的产物自带 function 关键字，toFn 不能再补一次前缀
const TOP2 = 'function addTag(x) {\n    return this.tag + x;\n}\n';
check('toFn 对 funcDecl 产物不重复补 function 前缀',
    toFn(TOP2).call({ tag: 'T:' }, 3) === 'T:3');

const OBJ = [
    'const o = {',
    '    plain: (a, b) => {',
    '        return a + b;',
    '    },',
    '    provideThing: async (model, range, _options, token) => {',
    '        if (!model) {',
    '            return [];',
    '        }',
    '        return this.helper(model, range);',
    '    }',
    '};'
].join('\n');
const prop = arrowProp(OBJ, 'provideThing');
check('arrowProp 取到参数表', !!prop && prop.params === '(model, range, _options, token)',
    prop ? prop.params : 'null');
check('arrowProp 标记 async', !!prop && prop.isAsync === true);
check('arrowProp 的 body 是完整配平的函数体',
    !!prop && prop.body.startsWith('{') && prop.body.endsWith('}') &&
    prop.body.includes('return this.helper(model, range);'));
check('arrowProp 查不到时返回 null', arrowProp(OBJ, 'nothingHere') === null);

// callbackBody：既不是类方法也不是对象属性的匿名箭头回调
const IPC = [
    "ipcMain.handle('check-file-exists', async (event, filePath) => {",
    "    if (!filePath) {",
    "        return false;",
    "    }",
    "    try {",
    "        await fs.promises.access(filePath);",
    "        return true;",
    "    }",
    "    catch (error) {",
    "        return error?.code !== 'ENOENT';",
    "    }",
    "});",
    "ipcMain.handle('other', (event) => { return 1; });"
].join('\n');
const handler = callbackBody(IPC, /ipcMain\.handle\('check-file-exists'/);
check('callbackBody 取到整个回调体',
    handler.startsWith('{') && handler.endsWith('}') &&
    handler.includes("error?.code !== 'ENOENT'"), JSON.stringify(handler.slice(0, 40)));
check('callbackBody 不会越过自己的收尾括号吃到下一个回调',
    !handler.includes("'other'") && !handler.includes('return 1;'));
check('callbackBody 锚点查不到时返回空串', callbackBody(IPC, /ipcMain\.handle\("nope"/) === '');
check('callbackBody 对单行回调也成立',
    callbackBody(IPC, /ipcMain\.handle\('other'/) === '{ return 1; }');

// callStatement：整条注册语句，配一个假 ipcMain 真执行一遍
const stmt = callStatement(IPC, /^ipcMain\.handle\(\s*'check-file-exists'/m);
check('callStatement 取到完整调用语句',
    stmt.startsWith("ipcMain.handle('check-file-exists'") && stmt.endsWith('})'),
    JSON.stringify(stmt.slice(-24)));
check('callStatement 不含尾随分号', !stmt.endsWith(';'));
check('callStatement 不吃到下一条注册',
    !stmt.includes("'other'") && !stmt.includes('return 1;'));
check('callStatement 锚点查不到时返回空串',
    callStatement(IPC, /^ipcMain\.handle\(\s*'nope'/m) === '');
const regs = [];
new Function('ipcMain', 'fs', stmt)(
    { handle: (ch, fn) => regs.push({ mode: 'handle', ch, fn }) },
    { promises: { access: async () => { } } });
check('callStatement 的产物可执行，注册方式与通道名成了可观测数据',
    regs.length === 1 && regs[0].mode === 'handle' && regs[0].ch === 'check-file-exists',
    JSON.stringify(regs.map((r) => `${r.mode}:${r.ch}`)));
check('callStatement 抽出的 handler 是可直接调用的 async 函数',
    typeof regs[0].fn === 'function' && regs[0].fn.constructor.name === 'AsyncFunction');
check('callStatement 对单行注册也成立',
    callStatement(IPC, /^ipcMain\.handle\(\s*'other'/m) === "ipcMain.handle('other', (event) => { return 1; })");
// 锚点若从通道名开始，第一个左括号是回调自己的参数表，抽出来只有半条语句
check('锚点必须落在被调方上：落在通道名上抽出的不是 ipcMain.… 调用',
    callStatement(IPC, /'check-file-exists'/).startsWith('ipcMain') === false,
    JSON.stringify(callStatement(IPC, /'check-file-exists'/).slice(0, 30)));
// 注册语句常缩在某个函数里：^\s* 吃缩进后，第一个左括号仍是这条调用的括号
const INDENTED = "function bind() {\n    ipcMain.handle('p', () => 1);\n}";
const indentedStmt = callStatement(INDENTED, /^\s*ipcMain\.handle\(\s*'p'/m);
check('callStatement 容忍整条注册的缩进',
    indentedStmt.trim() === "ipcMain.handle('p', () => 1)", JSON.stringify(indentedStmt));

// compileMethod：类方法里的 document/window/setTimeout 是自由标识符，
// 用 new Function 编译会绑到 Node 全局，桩拦不住；只有 vm context 才吃得到桩。
const CLS = [
    'class Panel {',
    '    tick() {',
    '        logInfo("hi");',
    '        setTimeout(() => {}, 10);',
    '        return this.name;',
    '    }',
    '    async load() {',
    '        return await this.helper(2);',
    '    }',
    '}'
].join('\n');
const hit = [];
const panelCtx = vm.createContext({
    logInfo: (m) => { hit.push(['log', m]); },
    setTimeout: (fn, ms) => { hit.push(['timer', ms]); },
    JSON, Math, String, Boolean, Array, Object, Error, RegExp, Promise
});
const tick = compileMethod(panelCtx, classMethod(CLS, 'tick'));
check('compileMethod 抽不到时返回 null（调用方据此红）',
    compileMethod(panelCtx, '') === null && compileMethod(panelCtx, classMethod(CLS, 'nope')) === null);
check('compileMethod 的方法体自由标识符落到 context 的桩上',
    tick.call({ name: 'P' }) === 'P' && JSON.stringify(hit) === '[["log","hi"],["timer",10]]',
    JSON.stringify(hit));
const loadFn = compileMethod(panelCtx, classMethod(CLS, 'load'));
check('compileMethod 自己认出 async 前缀（漏了当场语法错）',
    loadFn.constructor.name === 'AsyncFunction');
const REAL_ASYNC = read('src/renderer/js/sidebar/sampleTester.js');
const realLoad = compileMethod(panelCtx, classMethod(REAL_ASYNC, 'activate'));
check('compileMethod 对真实 emit 产物里的 async 方法也成立',
    realLoad !== null && realLoad.constructor.name === 'AsyncFunction',
    JSON.stringify(classMethod(REAL_ASYNC, 'activate').slice(0, 24)));
check('compileMethod 抽不到的真实方法名返回 null',
    compileMethod(panelCtx, classMethod(REAL_ASYNC, 'noSuchMethod')) === null);

// arrowExpr：连参数表一起配平，形参名不锁，产物可直接当表达式求值
const NESTED = '    const normalize = (value) => {\n' +
    '        if (!value) { return ""; }\n' +
    '        return String(value).toLowerCase();\n' +
    '    };\n';
const arrowSrc = arrowExpr(NESTED, /const normalize\s*=/);
check('arrowExpr 取到完整箭头表达式',
    arrowSrc.startsWith('(value) =>') && arrowSrc.endsWith('}'),
    JSON.stringify(arrowSrc.slice(0, 30)));
check('arrowExpr 含嵌套 if 块时终点不提前',
    (arrowSrc.match(/\{/g) || []).length === 2 && arrowSrc.includes('toLowerCase()'));
check('arrowExpr 可被当作表达式求值',
    new Function(`return (${arrowSrc})`)()('AB') === 'ab');
check('arrowExpr 锚点查不到时返回空串', arrowExpr(NESTED, /const nope\s*=/) === '');
// toFn：还原成可调用函数，this 动态绑定
const fn = toFn(classMethod(SRC, 'loaded'));
check('toFn 能处理 async 方法', typeof fn === 'function');
(async () => {
    // b 走假值分支，才会落到 `return this.tag + b`，同时验到 this 绑定与实参传递
    const out = await fn.call({ tag: 'T:' }, 0);
    check('toFn 的结果可用 .call 绑 this 且实参照传', out === 'T:0', String(out));

    const deep = await fn.call({ tag: 'T:' }, { x: 2 });
    check('toFn 的结果能走方法体内部分支并返回嵌套对象',
        deep && Array.isArray(deep.deep.nested) && deep.deep.nested[1] === 2,
        JSON.stringify(deep));

    const syncFn = toFn(classMethod(SRC, 'simple'));
    check('toFn 处理同步方法不加 async 前缀', syncFn.call({}, 7) === 7);

    // 箭头函数 .call 改不了 this，重建为 function 才改得动
    const asArrow = new Function('return (async () => this.marker)')();
    const arrowThis = await asArrow.call({ marker: 'bound' });
    check('箭头函数的 this 是词法绑定的（所以必须重建成 function）',
        arrowThis !== 'bound', String(arrowThis));

    const provider = toProviderFn(prop);
    const provided = await provider.call({ helper: (m, r) => [m, r] }, 'M', 'R', {}, {});
    check('toProviderFn 的 this 动态绑定成功',
        Array.isArray(provided) && provided[0] === 'M' && provided[1] === 'R',
        JSON.stringify(provided));
    check('toProviderFn 查不到时返回 undefined', toProviderFn(null) === undefined);

    // 走 callbackBody 里那条 `if (!filePath) return false` 分支：实参真的传进去了
    const handled = await regs[0].fn({}, '');
    check('callStatement 抽出的 handler 实参照传、返回值拿得到', handled === false, String(handled));

    // 同一份代码只改排版（tsc printer 会做的事），切片不该变
    const REFLOW = [
        'class A {',
        '    simple(a) {',
        '        if (a)',
        '            return a;',
        '    }',
        '    async loaded(b = { x: 1 }) {',
        '        try {',
        '            if (b) {',
        '',
        '                return { deep: { nested: [1, 2] } };',
        '            }',
        '        }',
        '        catch (_) { }',
        '',
        '        return this.tag + b;',
        '    }',
        '}'
    ].join('\n');
    const fold = (s) => s.replace(/\s+/g, ' ').trim();
    check('重排后 classMethod 仍切到同一区间（同步方法）',
        fold(classMethod(REFLOW, 'simple')).includes('return a;') &&
        !classMethod(REFLOW, 'simple').includes('catch'),
        fold(classMethod(REFLOW, 'simple')));
    check('重排后 async 方法的终点不漂移（切出的区间折叠空白后一致）',
        fold(classMethod(REFLOW, 'loaded')) === fold(loaded),
        fold(classMethod(REFLOW, 'loaded')).slice(-30));

    // async 关键字必须一起吃进锚点：漏了它就抽出少了 async 的正文，
    // 里面的 await 在编译期直接报错，抽出来的函数根本跑不起来。
    const TOP_ASYNC = 'function plain() { }\nasync function load(x) {\n    return x + 1;\n}';
    const asyncRaw = funcDecl(TOP_ASYNC, 'load');
    check('funcDecl 连 async 关键字一起抽走',
        asyncRaw === 'async function load(x) {\n    return x + 1;\n}', JSON.stringify(asyncRaw));
    check('funcDecl 抽出的 async 函数能直接编译执行',
        await toFn(asyncRaw)(1) === 2, String(await toFn(asyncRaw)(1)));
    check('funcDecl 不会把 async 前的普通函数整段吞掉',
        funcDecl(TOP_ASYNC, 'plain') === 'function plain() { }', JSON.stringify(funcDecl(TOP_ASYNC, 'plain')));

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
    process.exit(failures ? 1 : 0);
})().catch((e) => {
    console.log(`[FAIL] source-extract unexpected error | ${e?.stack || e?.message}`);
    process.exit(1);
});
