'use strict';

// 切片工具自身的回归测试。它现在被多个读源码的测试依赖，
// 一旦它自己切错，那些文件会一起静默失真，所以先验证工具本身。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { arrowExpr, arrowProp, blockByIndent, bracedBlock, callbackBody, callStatement, classMethod, compileMethod, forStatement, funcDecl, ifStatement, objectConst, scalarConst, setMembers, toFn, toProviderFn } = require('./fixtures/source-extract');

// 挂死不等于通过：某个 await 永不 settle 时 Node 会以 0 退出码排空 event loop，
// 后半截断言一条不发也「全绿」。留一个不 unref 的定时器把「跑不完」顶成失败。
setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：某个 await 永不 settle（异步守卫没被驱动完）');
    process.exit(1);
}, 60000);

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

    // forStatement：整条 for（含 for 头），把「循环注册了什么」变成真跑一遍
    const FOR_SRC = [
        'const invalidate = () => { };',
        'for (const ch of [\'a\', \'b\', \'c\']) {',
        '    bus.on(ch, invalidate);',
        '}',
        'bus.on(\'tail\', invalidate);'
    ].join('\n');
    const forSrc = forStatement(FOR_SRC, /^\s*for \(const ch of \[/m);
    check('forStatement 取到整条循环（for 头 + 配平语句体，不含后面的语句）',
        forSrc.startsWith('for (') && forSrc.endsWith('}') && !forSrc.includes('tail'),
        JSON.stringify(forSrc));
    const seen = [];
    const bus = { on: (ch, fn) => seen.push([ch, typeof fn]) };
    new Function('bus', 'invalidate', forSrc)(bus, () => { });
    check('forStatement 的产物可直接执行，注册到的通道就是数组里的三个',
        JSON.stringify(seen) === '[["a","function"],["b","function"],["c","function"]]', JSON.stringify(seen));
    const FOR_IN = '    for (const k of [1, 2]) {\n        out.push(k);\n    }\n';
    check('forStatement 容忍整条循环的缩进',
        forStatement(FOR_IN, /^\s*for \(const k of \[/m).startsWith('    for ('),
        JSON.stringify(forStatement(FOR_IN, /^\s*for \(const k of \[/m)));
    check('forStatement 锚点查不到时返回空串', forStatement(FOR_SRC, /^\s*for \(const nope/) === '');

    // objectConst：`const NAME = { ... }` 整条声明，嵌套花括号不吃终点
    const OBJ_SRC = [
        'const other = 1;',
        'const wrapper = {',
        '    on: (ch) => {',
        '        if (ALLOWED.has(ch)) { return real.on(ch); }',
        '        return null;',
        '    },',
        '    once: (ch) => real.on(ch)',
        '};',
        'const tail = 2;'
    ].join('\n');
    const objSrc = objectConst(OBJ_SRC, 'wrapper');
    check('objectConst 取到整条声明且终点落在配平的 } 上',
        objSrc.startsWith('const wrapper = {') && objSrc.endsWith('}') &&
        !objSrc.includes('tail'), JSON.stringify(objSrc.slice(-40)));
    const forwarded = [];
    const made = new Function('ALLOWED', 'real', `${objSrc}; return wrapper;`)(new Set(['x']), { on: (ch) => { forwarded.push(ch); return 'ok'; } });
    check('objectConst 的产物是可用对象，方法里的守卫真跑得起来',
        typeof made.on === 'function' && made.on('x') === 'ok' && forwarded.length === 1 &&
        made.on('nope') === null && forwarded.length === 1, JSON.stringify(forwarded));
    check('objectConst 查不到名字时返回空串', objectConst(OBJ_SRC, 'nope') === '');
    const INDENTED_OBJ = [
        '    function go() {',
        '        const cfg = {',
        '            a: 1,',
        '            nested: { b: 2 }',
        '        };',
        '        return cfg;',
        '    }'
    ].join('\n');
    const indented = objectConst(INDENTED_OBJ, 'cfg');
    check('objectConst 剥掉行首缩进，产物能直接拼进 new Function 正文',
        indented.startsWith('const cfg = {') && indented.endsWith('}')
        && new Function(`${indented}; return cfg;`)().nested.b === 2, JSON.stringify(indented.slice(0, 24)));

    // scalarConst：整条标量声明。终点收在深度 0 的第一个 ; 上，
    // 括号里的 > 0 / ? : 都不算终点；返回值去掉行首缩进（缩进不带信息，留着只会让断言锁空格）。
    const SCALAR_SRC = [
        '    const genTimeout = (Number.isFinite(generatorTimeout) && generatorTimeout > 0) ? generatorTimeout : 0;',
        'const MAX_BYTES = 1024 * 1024;',
        'const tail = 2;'
    ].join('\n');
    const genDecl = scalarConst(SCALAR_SRC, 'genTimeout');
    check('scalarConst 剥掉缩进、取到整条三元声明，不越界到下一条',
        genDecl.startsWith('const genTimeout') && genDecl.endsWith(';') && !genDecl.includes('MAX_BYTES'),
        JSON.stringify(genDecl));
    const normalizeGen = new Function('generatorTimeout', `${genDecl} return genTimeout;`);
    check('scalarConst 的产物可直接求值：0 / 负数 / NaN 归零，正数原样',
        normalizeGen(0) === 0 && normalizeGen(-1) === 0 && normalizeGen(NaN) === 0 && normalizeGen(1500) === 1500,
        [0, -1, NaN, 1500].map(normalizeGen).join(','));
    check('scalarConst 收在行尾分号，不吞掉后一条声明',
        scalarConst(SCALAR_SRC, 'MAX_BYTES') === 'const MAX_BYTES = 1024 * 1024;');
    check('scalarConst 不把前缀同名的另一条声明当成目标',
        scalarConst('const genTimeoutMs = 5;\nconst genTimeout = 6;', 'genTimeout') === 'const genTimeout = 6;');
    check('scalarConst 查不到名字时返回空串', scalarConst(SCALAR_SRC, 'nope') === '');

    // ifStatement：整条 if（条件 + 配平的语句块）。安全拦截常写成一个 if + throw，
    // 正则比这种长相一改版就碎，抽出来真跑才看得见「命中条件」和「命中后做了什么」。
    const IF_SRC = [
        'function guard(p) {',
        '    if (/^\\s*(?:cmd\\s+\\/c|pwsh)/i.test(p)) {',
        '        throw new Error(\'shell disabled\');',
        '    }',
        '    return run(p);',
        '}'
    ].join('\n');
    const ifSrc = ifStatement(IF_SRC, /^\s*if \(\/\^\\s\*\(\?:cmd/m);
    check('ifStatement 取到整条 if：条件里的正则括号不骗过配平，语句块后不越界',
        ifSrc.startsWith('if (') && ifSrc.endsWith('}') && !ifSrc.includes('return run'), JSON.stringify(ifSrc));
    const runGuard = new Function('p', `${ifSrc} return 'ok';`);
    const threw = (p) => { try { runGuard(p); return false; } catch (_) { return true; } };
    check('ifStatement 的产物真跑得起来：命中条件抛出，没命中原样走完',
        threw('cmd /c dir') && threw('CMD /C dir') && !threw('./main.exe'),
        JSON.stringify([threw('cmd /c dir'), threw('CMD /C dir'), threw('./main.exe')]));
    check('ifStatement 锚点查不到时返回空串', ifStatement(IF_SRC, /^\s*if \(\/nope/) === '');
    check('ifStatement 不认无花括号的单语句 if（宁可不抽，也不猜区间）',
        ifStatement('if (x) return 1;\nfunction y() { }', /^\s*if \(x\)/m) === '');
    // allowBraceless：tsc 的 printer 会把单行 if 拆成两行不带花括号的形式
    // （`if (x)\n    return;`），抽取跟不上这种等价重写，行为守卫就会假红。
    const BRACELESS = [
        'method() {',
        '    if (a && b !== c)',
        '        box.value = String(c);',
        '    const next = 1;',
        '}'
    ].join('\n');
    const bl = ifStatement(BRACELESS, /^\s*if \(a && b/m, { allowBraceless: true });
    check('allowBraceless：两行式无括号 if 抽到语句体为止，不吃下一条',
        bl.startsWith('if (a && b !== c)') && bl.trimEnd().endsWith('String(c);') && !bl.includes('const next'),
        JSON.stringify(bl));
    check('allowBraceless：单行式只到本行行尾',
        ifStatement('if (x) return 1;\nfunction y() { }', /^\s*if \(x\)/m, { allowBraceless: true })
            .trimEnd().endsWith('return 1;'));
    check('allowBraceless：体尾不带分号不抽（ASI 的区间说不清）',
        ifStatement('if (x)\n    return\nfoo();', /^\s*if \(x\)/m, { allowBraceless: true }) === '');
    check('allowBraceless：体里带花括号不抽（那是块，该走配平）',
        ifStatement('if (x)\n    o = { a: 1 };', /^\s*if \(x\)/m, { allowBraceless: true }) === '');
    check('allowBraceless：下一条缩进不比 if 那行深就不抽',
        ifStatement('if (x)\nbar();', /^if \(x\)/m, { allowBraceless: true }) === '');

    // bracedBlock：整段裸块语句。CI 的每个检查项都是这种形态，锚点行里通常还带
    // `${R}` 这类模板插值 —— 直接 indexOf('{') 会从半个插值开始配平，所以块首必须独立成行。
    const BLOCK_SRC = [
        'console.log(`${Y}[I8] some ratchet${R}`);',
        '{',
        '  let hits = 0;',
        '  for (const line of lines) {',
        '    if (/[\\u4e00-\\u9fff]/.test(line)) { hits++; }',
        '  }',
        '  report(hits);',
        '}',
        'report(-1);'
    ].join('\n');
    const blockSrc = bracedBlock(BLOCK_SRC, /I8\] some ratchet/);
    check('bracedBlock 跳过锚点行里的 ${R}，取到独立成行的块首与配平的块尾',
        blockSrc.startsWith('{') && blockSrc.endsWith('}') && !blockSrc.includes('report(-1)'),
        JSON.stringify(blockSrc.slice(0, 24)));
    const blockRuns = () => {
        const seen = [];
        vm.runInNewContext(`${blockSrc}`, { lines: ['中文', 'ascii', '中文'], report: (n) => seen.push(n) });
        return seen;
    };
    check('bracedBlock 的产物整块跑得起来：块内 const 不外泄，统计口径是真跑出来的',
        JSON.stringify(blockRuns()) === '[2]', JSON.stringify(blockRuns()));
    check('bracedBlock 锚点查不到时返回空串', bracedBlock(BLOCK_SRC, /nope ratchet/) === '');
    check('bracedBlock 不认 `if (…) {` 这类不独立成行的块（宁可不抽，也不猜区间）',
        bracedBlock('mark();\nif (x) { y(); }', /mark\(\)/) === '');

    // blockByIndent：同样抽裸块，但按缩进收尾。CI 检查项块里带 `[,{]` 这种字符类时，
    // 数花括号会被字符类里的半个 `{` 骗过去，配平永远回不到 0 —— bracedBlock 就抽不出来。
    const IND_BLOCK = [
        'console.log(`${Y}[I5] some check${R}`);',
        '{',
        '  const res = [/[,{]\\s*x/g, /y\\{2\\}/];',
        '  for (const re of res) {',
        '    scan(re);',
        '  }',
        '  if (bad) {',
        "    fail('k');",
        '  }',
        '}',
        'report(-1);'
    ].join('\n');
    const indSrc = blockByIndent(IND_BLOCK, /\[I5\] some check/);
    check('blockByIndent 数不动的字符类花括号不影响收尾：取到标题行后第一块，到同缩进的 } 为止',
        indSrc.startsWith('{') && indSrc.endsWith('}') && !indSrc.includes('report(-1)'),
        JSON.stringify(indSrc.slice(0, 40)));
    check('blockByIndent 同条件下 bracedBlock 确实抽不出来（这才是另开一个工具的理由）',
        bracedBlock(IND_BLOCK, /\[I5\] some check/) === '');
    const indSeen = [];
    try {
        vm.runInNewContext(indSrc, {
            scan: (re) => indSeen.push(String(re.source)), fail: () => indSeen.push('fail'),
            bad: true, report: () => indSeen.push('report')
        });
    } catch (e) { indSeen.push('THREW:' + e.message); }
    check('blockByIndent 的产物整块跑得起来：嵌套块不提前收尾，块外 report 不在区间内',
        indSeen.length === 3 && indSeen[indSeen.length - 1] === 'fail', JSON.stringify(indSeen));
    check('blockByIndent 锚点下一条非空行不是独立成行的 { 时返回空串（不顺着下文捞别的块）',
        blockByIndent('log([I9] x);\nfoo();\n{\n}', /\[I9\] x/) === '');
    check('blockByIndent 收尾的 } 缩进对不上时返回空串（不会一路吃到文件尾，也不认错位的 }）',
        blockByIndent('log(t);\n{\n  a();\n    }\nb();\n', /log\(t\)/) === '');

    // setMembers：整条 `const NAME = new Set([...])` 的成员表，白名单的保护力全在成员上。
    const SET_SRC = [
        "const ALLOWED_A = new Set([",
        "    'x-y', 'q]', '带中文',",
        "    'last',",
        "]);",
        "const ALLOWED_B = new Set(['oops', process.env.EVIL]);"
    ].join('\n');
    check('setMembers 求值出全部成员，字符串里的 ] 不截断',
        JSON.stringify(setMembers(SET_SRC, 'ALLOWED_A')) === '["x-y","q]","带中文","last"]',
        JSON.stringify(setMembers(SET_SRC, 'ALLOWED_A')));
    check('setMembers 遇到非字符串成员返回 null（静默漏成员比抽取失败危险）',
        setMembers(SET_SRC, 'ALLOWED_B') === null, String(setMembers(SET_SRC, 'ALLOWED_B')));
    check('setMembers 查不到名字时返回 null', setMembers(SET_SRC, 'ALLOWED_NOPE') === null);
    check('setMembers 认得 new Set( [ ... ] ) 之间的空白',
        JSON.stringify(setMembers('const S = new Set( [ \'a\'] );', 'S')) === '["a"]',
        String(setMembers('const S = new Set( [ \'a\'] );', 'S')));

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
    process.exit(failures ? 1 : 0);
})().catch((e) => {
    console.log(`[FAIL] source-extract unexpected error | ${e?.stack || e?.message}`);
    process.exit(1);
});
