'use strict';

// #10：onDebugError 的「良性 / 真错误」分类守卫。
//
// 病灶有两层，第二层才是根因：
//  1. 渲染层用**文本正则**区分「良性调试提示」和「真错误」，正则里有裸的 running / executing
//     分支，于是任何措辞带这两个词的真错误都被静默咽掉。实测连
//     "Error running target: signal SIGSEGV" 都不弹错，状态栏还显示「程序正在运行」。
//  2. 根因在主进程：那十几处 `event.reply('debug-error', (error as Error)?.message)` 把错误
//     对象**拍成字符串**，生产者哪怕设了 code 也过不了 IPC 这道边界。渲染层拿不到码，
//     才只能靠措辞猜 —— 所以只收紧正则是不够的，得先把码送过来。
//
// 本文件跑的是真身：把 src/renderer/js/{main,debugPanel}.js 里的方法抽出来在 vm 里调用。
// 分类结果看 showMessage / updateDebugStatus 各收到什么，不看源码字面量。
// stringifyError 也用真身 —— 自己写一遍就等于测我的桩，载荷形状一变就会像 7b 那样静默失保。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const watchdog = setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：某个 await 永不 settle');
    process.exit(1);
}, 60000);

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.join(__dirname, '..');
const { classMethod, compileMethod, scalarConst } = require('./fixtures/source-extract');
const packs = require('./fixtures/ci-block-runner').loadLocales();

const rendererMain = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'main.js'), 'utf8');
const onDebugErrorSrc = classMethod(rendererMain, 'onDebugError');
const stringifyErrorSrc = classMethod(rendererMain, 'stringifyError');
// 良性码集合必须从源码里取来在 vm 里声明一遍，**不许测试自己抄一份** ——
// onDebugError 依赖这个模块级常量，测试里手写它就等于把契约复制了一遍：
// 生产侧加一个码而测试没跟着改，判定会按测试那份跑，两边都绿而界面照旧错。
const benignDecl = scalarConst(rendererMain, 'BENIGN_DEBUG_CODES');
check('onDebugError / stringifyError / 良性码声明三样都抽到了（抽不到下面全是真空通过）',
    onDebugErrorSrc.length > 200 && stringifyErrorSrc.length > 200
        && /new\s+Set\(\[/.test(benignDecl),
    JSON.stringify({ onDebugError: onDebugErrorSrc.length, stringifyError: stringifyErrorSrc.length, benignDecl }));

/**
 * 真跑一次 onDebugError。返回它最终做了什么：
 *   toasts   —— showMessage 收到的 [type, message]
 *   status   —— updateDebugStatus 收到的文案
 *   unbind / setState —— 会话是否被拆掉
 */
function runOnDebugError(payload, lang = 'zh-cn') {
    const pack = packs[lang] || packs['zh-cn'];
    const calls = { toasts: [], status: [], logInfo: [], logError: [], unbind: 0, setState: [] };
    const ctx = vm.createContext({
        Object, Array, String, Number, Boolean, Error, JSON, RegExp, Math, Set, Map, Promise,
        window: {
            i18n: {
                t: (k, p) => {
                    const raw = pack[k];
                    if (raw === undefined) return k;
                    return String(raw).replace(/\{(\w+)\}/g, (m, t2) =>
                        (p && Object.prototype.hasOwnProperty.call(p, t2)) ? String(p[t2]) : m);
                }
            }
        },
        logInfo: (...a) => { calls.logInfo.push(a.map(String).join(' ')); },
        logWarn: () => { },
        logError: (...a) => { calls.logError.push(a.map(String).join(' ')); },
    });
    vm.runInContext(benignDecl, ctx);
    const stringify = compileMethod(ctx, stringifyErrorSrc);
    const handler = compileMethod(ctx, onDebugErrorSrc);
    if (typeof stringify !== 'function' || typeof handler !== 'function') {
        // 编译不出来就等于什么都没测 —— 直接炸，别让后面几十条断言在 undefined 上假绿
        throw new Error('方法编译失败：onDebugError 或 stringifyError 没被 compileMethod 认出来');
    }
    const self = {
        stringifyError: (e) => stringify.call(self, e),
        showMessage: (m, type) => { calls.toasts.push([type, m]); },
        updateDebugStatus: (m) => { calls.status.push(m); },
        updateDebugControlsState: (v) => { calls.setState.push(v); },
        unbindDebugTerminalBridge: () => { calls.unbind++; },
    };
    handler.call(self, payload);
    return calls;
}

const isBenign = (c) => c.toasts.length === 0 && c.status.length === 1;
const isError = (c) => c.toasts.length === 1 && c.toasts[0][0] === 'error';

// ---- 一、带码的生产者：按码定性 ------------------------------------------
{
    const notRunning = runOnDebugError({ code: 'debuggerNotRunning', message: packs['zh-cn']['error.debuggerNotRunning'] });
    check('带码 debuggerNotRunning → 良性状态，不弹错', isBenign(notRunning), JSON.stringify(notRunning.toasts));
    const already = runOnDebugError({ code: 'programAlreadyRunning', message: packs['zh-cn']['debug.programAlreadyRunning'] });
    check('带码 programAlreadyRunning → 良性状态（这条以前只能靠措辞猜）', isBenign(already), JSON.stringify(already.toasts));
    const realErr = runOnDebugError({ code: 'breakpointSetFailed', message: 'boom' });
    check('带码的真错误必须弹错（有码就按码定性，不再看措辞）', isError(realErr), JSON.stringify(realErr.toasts));
    // 良性分支的副作用边界：只是状态提示，不该把调试会话拆了
    check('良性分支不拆终端桥、不改控件状态', already.unbind === 0 && already.setState.length === 0,
        JSON.stringify({ unbind: already.unbind, setState: already.setState }));
    check('真错误分支照旧拆桥 + 关控件（会话真的失败了）',
        realErr.unbind === 1 && realErr.setState.length === 1 && realErr.setState[0] === false,
        JSON.stringify({ unbind: realErr.unbind, setState: realErr.setState }));
    check('良性状态用的是语言包文案而不是硬编码',
        already.status[0] === packs['zh-cn']['debug.programRunningStatus']
            && runOnDebugError({ code: 'debuggerNotRunning', message: 'x' }, 'en').status[0] === packs['en']['debug.programRunningStatus'],
        JSON.stringify(already.status));
}

// ---- 二、真错误一律要报：issue 里实测被吞掉的三条 -------------------------
{
    const swallowed = [
        'Error running target: signal SIGSEGV',
        'Not running: cannot attach, process vanished',
        'target is executing but faulted at 0x0',
    ];
    for (const msg of swallowed) {
        const c = runOnDebugError(msg);
        check(`无码真错误不再被咽掉：${JSON.stringify(msg).slice(0, 44)}`, isError(c),
            `toasts=${JSON.stringify(c.toasts)} status=${JSON.stringify(c.status)}`);
    }
    // 措辞里带 running / executing 也不能免检 —— 这正是裸分支的危害
    const tricky = runOnDebugError('Cannot evaluate expression: inferior is running and busy');
    check('带 running 的求值失败也要弹错（裸 running 分支必须已经去掉）', isError(tricky), JSON.stringify(tricky.toasts));
    const trickyExec = runOnDebugError('Executing commands is not allowed while target is executing');
    check('带 executing 的措辞同样不能免检', isError(trickyExec), JSON.stringify(trickyExec.toasts));
    // 中文旧措辞同样不再靠匹配（今天它本来就走弹错，不许因为改判定而变良性）
    const zhLegacy = runOnDebugError(packs['zh-cn']['error.debuggerNotRunning']);
    check('没有码的载荷一律按真错误报（兜底正则整体废掉，宁可多报不静默吞）', isError(zhLegacy),
        JSON.stringify(zhLegacy.toasts));
}

// ---- 三、错误原文要送到用户眼前 ------------------------------------------
{
    const c = runOnDebugError({ code: 'miFailed', message: 'Undefined command: "-foo"' });
    const text = c.toasts.length ? c.toasts[0][1] : '';
    check('弹错时把原文带进 toast（分类改了也不能吞掉诊断内容）',
        text.includes('Undefined command') && text.includes('-foo'), text);
    const nested = runOnDebugError({ code: 'miFailed', result: { stderr: 'segfault at 0x7fff' } });
    check('嵌套 result.stderr 仍然取到（stringifyError 用的是真身，不是桩）',
        nested.toasts.length === 1 && nested.toasts[0][1].includes('segfault at 0x7fff'),
        JSON.stringify(nested.toasts));
}

// ---- 四、边界：奇怪载荷不许炸 --------------------------------------------
{
    for (const weird of [null, undefined, '', 0, 'plain text', { }, { message: 123 }, [], { code: 42 }]) {
        let threw = null;
        try { runOnDebugError(weird); } catch (e) { threw = String((e && e.message) || e); }
        check(`异常载荷不炸：${JSON.stringify(weird)}`, threw === null, threw || '');
    }
    const numericCode = runOnDebugError({ code: 42, message: 'boom' });
    check('非字符串的码不能被当良性（脏数据要往安全的一侧倒：按真错误报出去）',
        isError(numericCode), `toasts=${JSON.stringify(numericCode.toasts)} status=${JSON.stringify(numericCode.status)}`);
    const unknownCode = runOnDebugError({ code: 'someNewCode', message: 'boom' });
    check('生产侧新增但没登记进良性集合的码，默认按真错误报（漏登记不会变成静默）',
        isError(unknownCode), JSON.stringify(unknownCode.toasts));
}

// ---- 五、生产者侧：码必须真的能过 IPC（这条盯的是根因） ------------------
{
    const mainSrc = fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8');
    // 取「'debug-error', 之后的载荷」按括号配对截是不行的：载荷里就带括号
    // （(error as Error)?.message），惰性匹配会停在第一个 ')' 上，把要抓的那种写法整段漏掉
    // —— 本条第一版就是这么漏红了，实测把一处改回裸 .message 它照样 0 处。
    // 改成只看载荷的**起始形状**：要么走统一出口 debugErrorPayload(...)，要么是写了 code 的
    // 字面量对象；其它形状都算「把码丢在边界上」。
    const sites = [...mainSrc.matchAll(/\(\s*'debug-error'\s*,\s*/g)]
        // 注释里引用旧写法是有的（debugErrorPayload 的文档注释就写了以前那行长什么样），
        // 按行首形状跳过注释行，否则这条会被自己的文档注释判红
        .filter((m) => {
            const lineStart = mainSrc.lastIndexOf('\n', m.index) + 1;
            const lead = mainSrc.slice(lineStart, m.index).trimStart();
            return !/^[*/]/.test(lead);
        });
    check('确实扫到 debug-error 的发送点（否则这条守卫是空集）', sites.length >= 20, `${sites.length} 处`);
    const bare = sites.map((m) => {
        const after = mainSrc.slice(m.index + m[0].length, m.index + m[0].length + 80).trim();
        const okShape = /^debugErrorPayload\s*\(/.test(after)
            || /^\w*Payload\s*\(/.test(after)
            || /^\{\s*code\s*:/.test(after);
        return okShape ? null : after.replace(/\s+/g, ' ').slice(0, 60);
    }).filter(Boolean);
    check('每一处 debug-error 都把错误对象整个交给统一出口，或显式带 code（码不许丢在 IPC 边界上）',
        bare.length === 0, bare.slice(0, 3).join(' | '));
    check('统一出口 debugErrorPayload 存在且保留 code',
        /function debugErrorPayload/.test(mainSrc) && /code\s*:\s*err\?\.\s*code|typeof err\?\.code/.test(mainSrc), '');

    // 良性码三方对齐：生产者发的、渲染层认的，一个都不能多不能少
    const rendererSrc = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'main.ts'), 'utf8');
    const benignLine = /const BENIGN_DEBUG_CODES = new Set\(\[([^\]]*)\]\)/.exec(rendererSrc);
    check('渲染层有显式的良性码集合（不再散落在判定式里）', !!benignLine, benignLine && benignLine[1]);
    const declared = benignLine ? benignLine[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean) : [];
    const gdbSrc = fs.readFileSync(path.join(root, 'src', 'gdb-mi-debugger.ts'), 'utf8');
    const produced = new Set([
        ...[...mainSrc.matchAll(/codedDebugError\(\s*'([^']+)'/g)].map((m) => m[1]),
        ...[...gdbSrc.matchAll(/codedError\(\s*'([^']+)'/g)].map((m) => m[1]),
        ...[...mainSrc.matchAll(/code:\s*'([^']+)'/g)].map((m) => m[1]),
    ]);
    const undeclared = declared.filter((c) => !produced.has(c));
    check('渲染层认的每个良性码都有生产者真的发（不许有死条目）',
        declared.length > 0 && undeclared.length === 0,
        `declared=${declared.join(',')} 没人发的=${undeclared.join(',')}`);
    for (const mustHave of ['debuggerNotRunning', 'programAlreadyRunning']) {
        check(`生产侧真的在发 ${mustHave}`, produced.has(mustHave), [...produced].join(','));
        check(`良性集合里登记了 ${mustHave}`, declared.includes(mustHave), declared.join(','));
    }
    // 反向：程序已退出/已结束是真失败（今天就弹错），不许被顺手划成良性
    check('programEnded / programHasExited 不在良性集合里（状态结束仍按失败报）',
        !declared.some((c) => /Exited|Ended/i.test(c)), declared.join(','));
}

// ---- 六、sendDebugCommand 内部的吞掉逻辑也必须改看码 --------------------
{
    const mainSrc = fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8');
    const at = mainSrc.indexOf('async function sendDebugCommand');
    const body = at >= 0 ? mainSrc.slice(at, at + 3000) : '';
    check('sendDebugCommand 抽到了', body.length > 500, `${body.length}B`);
    const continueAt = body.indexOf("case 'continue'");
    const continueBody = continueAt >= 0 ? body.slice(continueAt, body.indexOf("case 'step'", continueAt)) : '';
    // 剥掉注释再判：这里禁的是「用措辞决定要不要咽掉错误」这件事，
    // 而解释为什么禁的注释里必然要引用旧正则，不剥就会把自己判红。
    const codeOnly = continueBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/[^\n]*\/\/[^\n]*/g, '');
    check('continue 分支不再用措辞判断是否忽略错误（裸 running 正则会把真失败也咽掉）',
        continueBody.length > 80 && !/\.test\(/.test(codeOnly) && !/\/\w*running/.test(codeOnly)
            && codeOnly.includes('isAlreadyRunning('),
        codeOnly.replace(/\s+/g, ' ').slice(0, 200));
    check('isAlreadyRunning 只认 code',
        /function isAlreadyRunning[\s\S]{0,160}code\s*===\s*'programAlreadyRunning'/.test(mainSrc), '');
}

clearTimeout(watchdog);
console.log(`debug-error-classification tests completed: ${failures} failure(s)`);
process.exitCode = failures > 0 ? 1 : 0;
