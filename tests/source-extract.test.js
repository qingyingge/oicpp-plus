'use strict';

// 切片工具自身的回归测试。它现在被多个读源码的测试依赖，
// 一旦它自己切错，那些文件会一起静默失真，所以先验证工具本身。

const { arrowProp, callbackBody, classMethod, funcDecl, toFn, toProviderFn } = require('./fixtures/source-extract');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

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

    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
    process.exit(failures ? 1 : 0);
})().catch((e) => {
    console.log(`[FAIL] source-extract unexpected error | ${e?.stack || e?.message}`);
    process.exit(1);
});
