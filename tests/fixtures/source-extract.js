'use strict';

const vm = require('vm');

// 源码切片工具，供「读源码做断言」的回归测试定位方法体。
//
// 为什么不用 `\n    \}` 这类正则收尾：tsc printer 会重排源码（单行 if 拆行、
// 空行删除、`} catch (e) {` 变成 `}\ncatch (e) {`），任何锁缩进或锁收尾括号位置的
// 终点都会在一次纯排版改动后切错区间。更糟的是切空时 `!/xxx/.test('')` 恒真 ——
// 否定断言全部真空通过，守卫看着还在，实际是空的。
//
// 这里一律靠括号配平取区间，取不到返回 ''（arrowProp 返回 null），
// 由调用方自己断言「抽取成功」，让失败在抽取这一步就暴露，而不是漂到后面的正则上。

// 类方法：行首缩进 + 可选 async + 名字 + '('，先配平参数列表（默认值里可能有 {}），
// 再从方法体的 '{' 开始配平。连签名一起返回，便于重建成函数。
function classMethod(src, name) {
    const m = new RegExp('^\\s{4}(?:async\\s+)?' + name + '\\s*\\(', 'm').exec(src);
    if (!m) return '';
    return fromName(src, m.index);
}

// 顶层函数声明：`function name(...) { ... }`，含 `async function name(...) { ... }`
// （async 关键字必须在行首锚点里吃掉：m.index 指向匹配起点，漏了 async
//   抽出来的正文就少了关键字，await 直接在非 async 函数里编译失败）
function funcDecl(src, name) {
    const m = new RegExp('^\\s*(?:async\\s+)?function\\s+' + name + '\\s*\\(', 'm').exec(src);
    if (!m) return '';
    return fromName(src, m.index);
}

// 对象字面量里的箭头属性：`name: (args) => { ... }`（可带 async）
// 返回 { signature, params, body, isAsync }，取不到返回 null。
function arrowProp(src, name) {
    const m = new RegExp(name + '\\s*:\\s*(async\\s*)?\\(', 'm').exec(src);
    if (!m) return null;
    const close = matchParen(src, src.indexOf('(', m.index));
    if (close < 0) return null;
    const arrow = src.indexOf('=>', close);
    if (arrow < 0) return null;
    const open = src.indexOf('{', arrow);
    const end = matchBrace(src, open);
    if (end < 0) return null;
    return {
        signature: src.slice(m.index, close + 1),
        params: src.slice(src.indexOf('(', m.index), close + 1),
        body: src.slice(open, end + 1),
        isAsync: !!m[1]
    };
}

// 匿名箭头回调体：形如 ipcMain.handle('x', async (event, arg) => { ... })。
// 它既不是类方法也不是对象属性，只能按锚点定位后配平函数体。
// 锚点用正则传进来，返回那对花括号之间的内容（不含签名），取不到返回 ''。
function callbackBody(src, pattern) {
    const m = pattern.exec(src);
    if (!m) return '';
    const open = src.indexOf('{', m.index + m[0].length);
    const end = matchBrace(src, open);
    return end < 0 ? '' : src.slice(open, end + 1);
}

// 一整条调用语句，含被调方和实参表：`ipcMain.handle('x', async (…) => { … })`。
// 锚点的**起始位置必须落在被调方那一段上**（如 /^\s*ipcMain\.handle\(\s*'x'/m，
// 行首缩进无所谓），因为 '(', m.index) 找到的第一个左括号就是这条调用的括号 ——
// 若锚点从通道名开始，第一个括号会变成回调自己的参数表，配平出来的是半条语句。
// 抽出来交给 vm 执行，「注册方式是 handle 还是 on」就从正则断言变成可观测行为。
function callStatement(src, pattern) {
    const m = pattern.exec(src);
    if (!m) return '';
    const open = src.indexOf('(', m.index);
    const close = matchParen(src, open);
    return close < 0 ? '' : src.slice(m.index, close + 1);
}

// 整个箭头函数表达式 `(params) => { ... }`：锚点只给到 `=>` 之前的位置，
// 参数表由配平得到，不锁形参名 —— 用于把 `const f = (v) => { ... }` 直接 runInNewContext。
function arrowExpr(src, pattern) {
    const m = pattern.exec(src);
    if (!m) return '';
    const open = src.indexOf('(', m.index + m[0].length);
    const close = matchParen(src, open);
    if (close < 0) return '';
    const arrow = src.indexOf('=>', close);
    if (arrow < 0) return '';
    const bodyOpen = src.indexOf('{', arrow);
    const end = matchBrace(src, bodyOpen);
    return end < 0 ? '' : src.slice(open, end + 1);
}

// 把抽出的方法正文在 vm 里编译成可调用函数。
// 为什么不用 toFn/new Function：方法体里的 document、window、clearInterval、
// setTimeout 全是自由标识符，new Function 编译出来的函数会解析到 **Node 全局**，
// 测试塞的桩一个都拦不住，断言就成了真空通过。在 vm context 里编译，
// 自由标识符才会落到 context 的桩上。
// async 前缀沿用 classMethod/toFn 的老办法自己认：调用方漏了也不会静默错。
function compileMethod(ctx, methodSrc) {
    if (!methodSrc) return null;
    const src = methodSrc.trim();
    const isAsync = /^async\s/.test(src);
    const bare = isAsync ? src.replace(/^async\s+/, '') : src;
    vm.runInContext(`this.__compiled = ${isAsync ? 'async ' : ''}function ${bare};`, ctx);
    return ctx.__compiled;
}

// 整条标量 const/let 声明：`const NAME = <expr>;`
// 用途是把 `const genTimeout = (Number.isFinite(x) && x > 0) ? x : 0;` 这类
// **写在语句里的归一化逻辑**抽出来真跑一遍，而不是正则比字面量。
// 终点取深度 0 上的第一个 ';'（没有分号就收到行尾）：只适用于单行初值，
// 对象/函数体的 '{' 会把深度带起来，所以不会被半路截断 —— 那种形态请用 objectConst/arrowExpr。
function scalarConst(src, name) {
    const m = new RegExp('^\\s*(?:const|let)\\s+' + name + '\\s*=\\s*', 'm').exec(src);
    if (!m) return '';
    let d = 0;
    for (let i = m.index + m[0].length; i < src.length; i++) {
        const c = src[i];
        if (c === '(' || c === '[' || c === '{') d++;
        else if (c === ')' || c === ']' || c === '}') d--;
        else if ((c === ';' || c === '\n') && d === 0) return src.slice(m.index, i + 1).trim();
    }
    return '';
}

// 整条 for 语句（for 头 + 配平的语句体）。
// 用在「循环注册了哪些通道」这类断言上：把循环真跑一遍，比正则读数组字面量强 ——
// 数组里加了条件判断、去重、拼前缀，正则看不出来，跑一遍立刻显形。
// 锚点给到 `for (` 之前（如 /^\s*for \(const ch of \[/m）。
function forStatement(src, pattern) {
    const m = pattern.exec(src);
    if (!m) return '';
    const close = matchParen(src, src.indexOf('(', m.index));
    if (close < 0) return '';
    const end = matchBrace(src, src.indexOf('{', close));
    return end < 0 ? '' : src.slice(m.index, end + 1);
}

// 整条对象字面量声明：`const NAME = { ... }`（含 const 关键字和配平的右括号）。
// 守卫挂在对象方法里（如 preload 的 IPC 白名单包装器）时，只有拿到真对象才能测，
// 再靠 includes 比长相就只能验证「这行字还在」。
// 行首缩进会被剥掉（和 scalarConst 一致）：抽出来的声明大多要塞进 new Function 的正文里，
// 留着八个空格会让 startsWith('const ') 这类「抽取成功」断言在缩进代码上假红。
function objectConst(src, name) {
    const m = new RegExp('^\\s*(?:const|let)\\s+' + name + '\\s*=\\s*\\{', 'm').exec(src);
    if (!m) return '';
    const open = src.indexOf('{', m.index + m[0].length - 1);
    const end = matchBrace(src, open);
    if (end < 0) return '';
    const start = m.index + (m[0].length - m[0].trimStart().length);
    return src.slice(start, end + 1);
}

// 从「方法名/关键字起始位置」配平出整个方法（含签名）
function fromName(src, start) {
    const close = matchParen(src, src.indexOf('(', start));
    if (close < 0) return '';
    const end = matchBrace(src, src.indexOf('{', close));
    return end < 0 ? '' : src.slice(start, end + 1);
}

// 从 open 这个 '(' 配平到成对的 ')'，返回其下标；不配对返回 -1
function matchParen(src, open) {
    if (open < 0) return -1;
    let p = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '(') p++;
        else if (src[i] === ')') { p--; if (p === 0) return i; }
    }
    return -1;
}

// 从 open 这个 '{' 配平到成对的 '}'，返回其下标；不配对返回 -1
function matchBrace(src, open) {
    if (open < 0) return -1;
    let d = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') d++;
        else if (src[i] === '}') { d--; if (d === 0) return i; }
    }
    return -1;
}

// 把抽出的源码还原成可调用函数。
// funcDecl 抽出来已经带 `function` 关键字，直接包成函数表达式即可；
// classMethod 连行首缩进和 async 关键字一起截、但不带 function，
// 所以要剥掉空白再补 `function` —— 拼出 `function async name() {}` 会当场语法错。
// 箭头函数不能直接用于 .call(self) —— 它的 this 是词法绑定的，
// 需要重建为 function 表达式才能改 this。
function toFn(methodSrc) {
    if (!methodSrc) return undefined;
    const s = methodSrc.replace(/^\s+/, '');
    if (/^(?:async\s+)?function\s/.test(s)) {
        return new Function('return (' + s + ')')();
    }
    const isAsync = /^async\s+/.test(s);
    return new Function('return (' + (isAsync ? 'async function ' : 'function ') +
        s.replace(/^async\s+/, '') + ')')();
}

// 把 arrowProp 的结果还原成 this 动态绑定的 async 函数
function toProviderFn(prop) {
    if (!prop) return undefined;
    return new Function('return (async function ' + prop.params + ' ' + prop.body + ')')();
}

module.exports = { arrowExpr, classMethod, compileMethod, forStatement, funcDecl, objectConst, scalarConst, arrowProp, callbackBody, callStatement, toFn, toProviderFn };
