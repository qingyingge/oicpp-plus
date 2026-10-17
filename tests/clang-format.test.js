'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const { classMethod } = require('./fixtures/source-extract');
const {
    buildClangFormatArgs,
    formatCodeWithClangFormat,
    serializeClangFormatStyle
} = require('../src/clang-format-service');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

class FakeChildProcess extends EventEmitter {
    constructor({ stdout = '', stderr = '', code = 0 } = {}) {
        super();
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.stdin = new EventEmitter();
        this.killed = false;
        this.stdin.end = (input) => {
            this.input = input;
            setImmediate(() => {
                if (stdout) this.stdout.emit('data', Buffer.from(stdout));
                if (stderr) this.stderr.emit('data', Buffer.from(stderr));
                this.emit('close', code);
            });
        };
    }

    kill() {
        this.killed = true;
    }
}

// 把 classMethod 抽出来的方法体（`name(params) { ... }`）在指定 vm 上下文里编译成
// `function name(...)`。用 vm 而不是 new Function：new Function 造的函数作用域是
// Node 的全局，注入不了「沙箱里不给 LSP 句柄」这种关键限制；vm 上下文能精确决定
// 这段代码看得见什么，跑通了才证明它真的没依赖语言服务器。
function compileMethod(source, name, ctx) {
    const raw = classMethod(source, name);
    if (!raw) return { raw, fn: undefined };
    const s = raw.replace(/^\s+/, '');
    const decl = /^(?:async\s+)?function\s/.test(s)
        ? s
        : (/^async\s+/.test(s) ? 'async function ' + s.replace(/^async\s+/, '') : 'function ' + s);
    vm.runInContext(`${decl}\nthis.__compiled = ${name};`, ctx);
    return { raw, fn: ctx.__compiled };
}

function makeFormatSandbox() {
    const registrations = [];
    const logCalls = { info: [], warn: [] };
    const disposableOf = (kind, language) => ({
        kind,
        language,
        disposeCount: 0,
        dispose() { this.disposeCount++; }
    });
    const ctx = vm.createContext({
        monaco: {
            languages: {
                registerDocumentFormattingEditProvider: (language, provider) => {
                    registrations.push({ kind: 'full', language, provider });
                    return disposableOf('full', language);
                },
                registerDocumentRangeFormattingEditProvider: (language, provider) => {
                    registrations.push({ kind: 'range', language, provider });
                    return disposableOf('range', language);
                }
            }
        },
        logInfo: (...a) => { logCalls.info.push(a.map(String)); },
        logWarn: (...a) => { logCalls.warn.push(a.map(String)); },
        Math, JSON, Set, Map, Array, Object, String, Number, Boolean, Error, RegExp, Promise
        // 刻意不给 lsp / window / require / monaco.languages.* 之外的任何 LSP 句柄
    });
    return { ctx, registrations, logCalls };
}

function makeModel(lines, state = {}) {
    const arr = Array.isArray(lines) ? lines.slice() : String(lines).split('\n');
    const flags = { disposed: false, ...state };
    return {
        flags,
        lines: arr,
        getValue: () => arr.join('\n'),
        isDisposed: () => flags.disposed,
        getFullModelRange: () => ({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: arr.length,
            endColumn: (arr[arr.length - 1] || '').length + 1
        }),
        getLineMaxColumn: (lineNumber) => (arr[lineNumber - 1] || '').length + 1
    };
}

(async () => {
    const userStyle = {
        BasedOnStyle: 'Google',
        IndentWidth: 2,
        UseTab: 'Never'
    };
    const args = buildClangFormatArgs({
        filePath: 'D:/project/main.cpp',
        style: userStyle,
        fallbackStyle: 'LLVM'
    });
    check('clang-format assumes the edited filename', args[0] === '--assume-filename=D:/project/main.cpp');
    check('user style is passed as the highest-priority style argument', args[1] === `--style=${JSON.stringify(userStyle)}`);
    check('explicit user style does not fall back to a style file', !args.some((arg) => arg.startsWith('--fallback-style=')));

    const fileArgs = buildClangFormatArgs({ filePath: '/tmp/main.cpp' });
    check('missing style uses the project .clang-format', fileArgs.includes('--style=file'));
    check('project style has a deterministic fallback', fileArgs.includes('--fallback-style=LLVM'));
    check('preset style is normalized', serializeClangFormatStyle('google') === 'Google');

    let captured = null;
    const formatted = await formatCodeWithClangFormat({
        executablePath: '/fake/clang-format',
        content: 'int  main( ){return 0;}',
        filePath: '/tmp/main.cpp',
        style: userStyle,
        spawnImpl: (executablePath, spawnArgs, options) => {
            captured = { executablePath, args: spawnArgs, options };
            const child = new FakeChildProcess({ stdout: 'int main() { return 0; }\n' });
            const end = child.stdin.end;
            child.stdin.end = (input) => {
                captured.input = input;
                end(input);
            };
            return child;
        }
    });
    check('standalone clang-format receives source through stdin', captured && Buffer.from(captured.input || '').toString('utf8').includes('int  main'));
    check('standalone clang-format is executed without a shell', captured?.options?.shell === false);
    check('standalone clang-format output is returned unchanged', formatted.content === 'int main() { return 0; }\n');

    let rangeCapture = null;
    await formatCodeWithClangFormat({
        executablePath: '/fake/clang-format',
        content: 'int main() {\n  return 0;\n}\n',
        filePath: 'D:/project/main.cpp',
        style: userStyle,
        styleRaw: 'BasedOnStyle: Google\nIndentWidth: 2\n',
        startLine: 2,
        endLine: 3,
        spawnImpl: (executablePath, args, options) => {
            rangeCapture = { executablePath, args, options };
            return new FakeChildProcess({ stdout: 'int main() {\n  return 0;\n}\n' });
        }
    });
    const rawStyleArg = rangeCapture?.args?.find((arg) => arg.startsWith('--style=file:'));
    const rangeInputPath = rangeCapture?.args?.at(-1);
    check('raw user configuration is passed through an explicit style file', !!rawStyleArg && rawStyleArg !== `--style=file:${rangeInputPath}`);
    check('range formatting uses standalone clang-format line ranges', rangeCapture?.args?.includes('--lines=2:3'));
    check('temporary style and source files are removed after formatting', !fs.existsSync(rawStyleArg?.slice('--style=file:'.length) || '') && !fs.existsSync(rangeInputPath || ''));

    let rejected = null;
    try {
        await formatCodeWithClangFormat({
            executablePath: '/fake/clang-format',
            content: 'invalid',
            style: userStyle,
            spawnImpl: () => new FakeChildProcess({ stderr: 'parse error', code: 1 })
        });
    } catch (error) {
        rejected = error;
    }
    check('clang-format failures preserve diagnostics', /parse error/.test(rejected?.message || ''));

    const root = path.resolve(__dirname, '..');
    const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'monaco-editor-manager.js'), 'utf8');

    // 这两条原来是 includes() 读源码长相：
    //   'window.electronAPI.formatCppCode(request)'  —— 点号↔方括号改写会静默失配
    //   'styleRaw: this.clangFormatRaw'              —— 属性写法一变就失配
    // 改成真调 requestClangFormattedCode，直接看它把什么样的请求交给了桥。
    function toFn(src) {
        if (!src) return undefined;
        const s = src.replace(/^\s+/, '');
        const isAsync = /^async\s+/.test(s);
        return new Function('return (' + (isAsync ? 'async function ' : 'function ') +
            s.replace(/^async\s+/, '') + ')')();
    }
    function classMethod(name) {
        const m = new RegExp('^\\s{4}(?:async\\s+)?' + name + '\\s*\\(', 'm').exec(rendererSource);
        if (!m) return '';
        let i = rendererSource.indexOf('(', m.index), p = 0;
        for (; i < rendererSource.length; i++) {
            if (rendererSource[i] === '(') p++;
            else if (rendererSource[i] === ')') { p--; if (p === 0) break; }
        }
        let d = 0;
        for (i = rendererSource.indexOf('{', i); i < rendererSource.length; i++) {
            if (rendererSource[i] === '{') d++;
            else if (rendererSource[i] === '}') { d--; if (d === 0) return rendererSource.slice(m.index, i + 1); }
        }
        return '';
    }
    const bridgeSrc = classMethod('requestClangFormattedCode');
    check('方法体抽取成功: requestClangFormattedCode', bridgeSrc.length > 0);

    const RAW_STYLE = '{ BasedOnStyle:  LLVM,  IndentWidth: 7 }';  // 双空格+乱序，正是 lossy 解析会吃掉的东西
    function makeBridge({ noBridge = false, reply, onRequest } = {}) {
        const seen = { calls: 0, requests: [] };
        const state = { version: 3, disposed: false };
        const manager = {
            clangFormatStyle: 'Google',
            clangFormatRaw: RAW_STYLE,
            getClangFormatModelPath: () => 'D:/proj/a.cpp',
            normalizeClangFormatStyle: (s) => 'normalized:' + s,
            requestClangFormattedCode: toFn(bridgeSrc)
        };
        const model = {
            getValue: () => 'int  main( )  { }',
            isDisposed: () => state.disposed,
            getVersionId: () => state.version
        };
        global.window = noBridge ? {} : {
            electronAPI: {
                formatCppCode: async (req) => {
                    seen.calls++;
                    seen.requests.push({ ...req });
                    if (onRequest) onRequest(state, req);
                    return reply === undefined ? { ok: true, content: 'FORMATTED' } :
                        (typeof reply === 'function' ? reply(state) : reply);
                }
            }
        };
        return { manager, model, seen, state };
    }

    {
        const { manager, model, seen } = makeBridge();
        const out = await manager.requestClangFormattedCode(model);
        check('格式化走独立桥，且只发一次请求', out === 'FORMATTED' && seen.calls === 1,
            `calls=${seen.calls} out=${out}`);
        const req = seen.requests[0] || {};
        check('styleRaw 原样透传用户写法（不做 lossy 解析）', req.styleRaw === RAW_STYLE,
            JSON.stringify(req.styleRaw));
        check('style 走归一化、content 取整文档、filePath 取自模型路径',
            req.style === 'normalized:Google' && req.content === 'int  main( )  { }' &&
            req.filePath === 'D:/proj/a.cpp', JSON.stringify({ style: req.style, filePath: req.filePath }));
        check('未给 range 时不带行号，请求的是整文档格式化',
            !('startLine' in req) && !('endLine' in req), JSON.stringify(req));
        check('保留兜底风格字段', req.fallbackStyle === 'LLVM', String(req.fallbackStyle));
    }

    {
        const { manager, model, seen } = makeBridge();
        await manager.requestClangFormattedCode(model, { startLineNumber: 2, endLineNumber: 5 });
        check('给 range 时只带首末行，桥自己做局部格式化',
            seen.requests[0].startLine === 2 && seen.requests[0].endLine === 5,
            JSON.stringify(seen.requests[0]));
    }

    {
        // 桥不可用必须抛，不能悄悄退回有损的本地 formatter —— 这是 :120 那条
        // 「不调 window.cppFormatter.format」真正想守的东西，用行为表达更硬
        const { manager, model, seen } = makeBridge({ noBridge: true });
        let err = null;
        try { await manager.requestClangFormattedCode(model); } catch (e) { err = e; }
        check('桥缺失时抛错而不是回退到有损的本地格式化',
            err && /bridge is unavailable/.test(err.message) && seen.calls === 0,
            err ? err.message : '没抛');

        const bad = makeBridge({ reply: { ok: false, error: 'clang-format 未找到：D:/x' } });
        let err2 = null;
        try { await bad.manager.requestClangFormattedCode(bad.model); } catch (e) { err2 = e; }
        check('桥返回失败时把原始原因抛出去，不吞成通用文案',
            err2 && /clang-format 未找到/.test(err2.message), err2 ? err2.message : '没抛');

        const noContent = makeBridge({ reply: { ok: true, content: 42 } });
        let err3 = null;
        try { await noContent.manager.requestClangFormattedCode(noContent.model); } catch (e) { err3 = e; }
        check('桥回来的不是字符串时抛错，不把脏数据写进编辑器',
            !!err3, err3 ? err3.message : '没抛');
    }

    {
        // 过期结果不能吃：await 期间用户又敲了字 / 关了文件
        const changed = makeBridge({ onRequest: (state) => { state.version += 1; } });
        const r1 = await changed.manager.requestClangFormattedCode(changed.model);
        check('await 期间文档版本变了就丢弃结果', r1 === null, String(r1));

        const disposed = makeBridge({ onRequest: (state) => { state.disposed = true; } });
        const r2 = await disposed.manager.requestClangFormattedCode(disposed.model);
        check('await 期间文档销毁了就丢弃结果', r2 === null, String(r2));

        const gone = makeBridge();
        const r3 = await gone.manager.requestClangFormattedCode(null);
        gone.state.disposed = true;
        const r4 = await gone.manager.requestClangFormattedCode(gone.model);
        check('model 缺失或已销毁时根本不发请求',
            gone.seen.calls === 0 && r3 === null && r4 === null,
            `calls=${gone.seen.calls} r3=${r3} r4=${r4}`);
    }

    // -----------------------------------------------------------------------
    // 渲染层的两个格式化提供器：真注册、真调用。
    // 这三条原来是 includes() 读源码长相 —— 注册调用挪个分支、或者整条路径改成
    // 等 clangd，字符串都还在，守卫真空。「不依赖 clangd」看着没有可调用对象，
    // 其实可以这么证：沙箱里只给 monaco.languages 那两个注册函数，lsp / window /
    // require 一个都不给，能算出编辑内容就说明这条路径不经过语言服务器。
    // 「不回退到有损的本地 formatter」也一样：桥缺失时真抛出、provider 真空返回 []。
    // -----------------------------------------------------------------------
    {
        const sandbox = makeFormatSandbox();
        const full = compileMethod(rendererSource, '_registerClangFormatDocumentFormattingProvider', sandbox.ctx);
        const rangeM = compileMethod(rendererSource, '_registerClangFormatDocumentRangeFormattingProvider', sandbox.ctx);
        const minimal = compileMethod(rendererSource, 'buildMinimalFormatEdits', sandbox.ctx);
        check('方法体抽取成功: 两个注册方法 + 最小改动计算',
            !!(full.fn && rangeM.fn && minimal.fn),
            JSON.stringify({ full: !!full.fn, range: !!rangeM.fn, minimal: !!minimal.fn }));

        const bridge = { calls: [], reply: () => 'FORMATTED', onCall: null };
        const manager = {
            _clangFormatProviders: new Map(),
            requestClangFormattedCode: (model, range) => {
                bridge.calls.push({ model, range });
                if (bridge.onCall) bridge.onCall(bridge.calls.length - 1);
                const value = bridge.reply();
                return value instanceof Promise ? value : Promise.resolve(value);
            },
            buildMinimalFormatEdits: (model, original, formatted) => minimal.fn.call(manager, model, original, formatted)
        };
        full.fn.call(manager);
        rangeM.fn.call(manager);

        const fullRegs = sandbox.registrations.filter((row) => row.kind === 'full');
        const rangeRegs = sandbox.registrations.filter((row) => row.kind === 'range');
        check('文档格式化与区域格式化各注册到 cpp 和 c',
            fullRegs.length === 2 && rangeRegs.length === 2 &&
            fullRegs.every((row) => row.language === 'cpp' || row.language === 'c') &&
            rangeRegs.every((row) => row.language === 'cpp' || row.language === 'c'),
            JSON.stringify(sandbox.registrations.map((row) => `${row.kind}:${row.language}`)));
        check('disposable 按 <语言>:clang-format[-range] 记账（切主题重注册要用）',
            [...manager._clangFormatProviders.keys()].sort().join(',') ===
                'c:clang-format,c:clang-format-range,cpp:clang-format,cpp:clang-format-range',
            [...manager._clangFormatProviders.keys()].sort().join(','));
        check('注册时留了日志（排查「格式化不生效」时唯一的抓手）',
            sandbox.logCalls.info.length === 2 &&
            sandbox.logCalls.info.every((row) => row.join(' ').includes('注册文档格式化提供器')),
            JSON.stringify(sandbox.logCalls.info));

        {
            const before = sandbox.registrations.length;
            const infoBefore = sandbox.logCalls.info.length;
            full.fn.call(manager);
            rangeM.fn.call(manager);
            check('重复注册被去重：provider 不会叠上去，也不重复记日志',
                sandbox.registrations.length === before &&
                manager._clangFormatProviders.size === 4 && sandbox.logCalls.info.length === infoBefore,
                `新增注册 ${sandbox.registrations.length - before} 条`);
        }

        const cppFull = fullRegs.find((row) => row.language === 'cpp').provider;
        const cppRange = rangeRegs.find((row) => row.language === 'cpp').provider;
        const provideFull = cppFull && cppFull.provideDocumentFormattingEdits;
        const provideRange = cppRange && cppRange.provideDocumentRangeFormattingEdits;
        check('两个 provider 的接口方法都在',
            typeof provideFull === 'function' && typeof provideRange === 'function',
            `${typeof provideFull}/${typeof provideRange}`);
        check('区域 provider 带 displayName（Monaco 的格式化选择器认这个）',
            cppRange && cppRange.displayName === 'clang-format',
            cppRange ? String(cppRange.displayName) : '没有 provider');

        const LIVE = { isCancellationRequested: false };
        const DEAD = { isCancellationRequested: true };

        {
            const model = makeModel(['int  main( ) { }']);
            const edits = await provideFull(model, {}, LIVE);
            check('整文档格式化产出一条编辑，正文来自桥',
                Array.isArray(edits) && edits.length === 1 && edits[0].text === 'FORMATTED',
                JSON.stringify(edits));
            check('整文档格式化的 range 就是模型的完整范围（沙箱里没有 clangd，能算出来即证明没走 LSP）',
                JSON.stringify(edits[0].range) === JSON.stringify(model.getFullModelRange()),
                JSON.stringify(edits[0].range));
        }

        {
            bridge.calls.length = 0;
            check('model 缺失或已销毁时不发请求、返回空编辑',
                (await provideFull(null, {}, LIVE)).length === 0 &&
                (await provideFull(makeModel(['x'], { disposed: true }), {}, LIVE)).length === 0 &&
                bridge.calls.length === 0,
                `calls=${bridge.calls.length}`);

            const r = await provideFull(makeModel(['x']), {}, DEAD);
            check('token 已取消时直接返回空，不去 spawn clang-format',
                r.length === 0 && bridge.calls.length === 0, JSON.stringify(r));

            const lateCancel = makeModel(['x']);
            bridge.onCall = () => { LIVE.isCancellationRequested = true; };
            const r2 = await provideFull(lateCancel, {}, LIVE);
            bridge.onCall = null;
            LIVE.isCancellationRequested = false;
            check('await 期间被取消：结果丢掉，不把过期正文写回编辑器',
                r2.length === 0, JSON.stringify(r2));

            const lateDispose = makeModel(['x']);
            bridge.onCall = () => { lateDispose.flags.disposed = true; };
            const r3 = await provideFull(lateDispose, {}, LIVE);
            bridge.onCall = null;
            check('await 期间文件被关掉：同样丢掉结果',
                r3.length === 0, JSON.stringify(r3));

            const stale = makeModel(['x']);
            bridge.reply = () => null;
            const r4 = await provideFull(stale, {}, LIVE);
            bridge.reply = () => 'FORMATTED';
            check('桥判定结果过期（返回 null）时不产出编辑',
                r4.length === 0, JSON.stringify(r4));

            bridge.reply = () => { throw new Error('clang-format 未找到：D:/x'); };
            const r5 = await provideFull(makeModel(['x']), {}, LIVE);
            bridge.reply = () => 'FORMATTED';
            const lastWarn = sandbox.logCalls.warn[sandbox.logCalls.warn.length - 1] || [];
            check('桥抛错时 provider 吞成空编辑并把原因记进日志',
                r5.length === 0 && lastWarn.join(' ').includes('clang-format 未找到'),
                JSON.stringify({ edits: r5, warn: lastWarn }));
        }

        {
            bridge.calls.length = 0;
            const model = makeModel(['line1', 'line2', 'line3']);
            const range = { startLineNumber: 2, endLineNumber: 2 };
            const edits = await provideRange(model, range, {}, LIVE);
            check('区域格式化把 Monaco 给的 range 原样转给桥',
                bridge.calls.length === 1 && bridge.calls[0].range === range,
                JSON.stringify(bridge.calls[0] && bridge.calls[0].range));

            bridge.calls.length = 0;
            bridge.onCall = () => { model.lines[2] = 'line3-typed-by-user'; };
            bridge.reply = () => 'line1\nLINE2\nline3';
            const e2 = await provideRange(model, { startLineNumber: 2, endLineNumber: 2 }, {}, LIVE);
            bridge.onCall = null;
            bridge.reply = () => 'FORMATTED';
            check('区域格式化只改写真正变了的那一行：await 期间用户改了第 3 行也不跟着重写',
                e2.length === 1 && e2[0].text === 'LINE2' &&
                e2[0].range.startLineNumber === 2 && e2[0].range.endLineNumber === 2,
                JSON.stringify(e2));

            model.lines[2] = 'line3';
            bridge.calls.length = 0;
            const rNull = await provideRange(model, range, {}, LIVE);
            bridge.reply = () => null;
            const rNull2 = await provideRange(model, range, {}, LIVE);
            bridge.reply = () => 'FORMATTED';
            check('区域格式化同样不吃过期结果', rNull.length === 1 && rNull2.length === 0,
                JSON.stringify({ ok: rNull.length, stale: rNull2.length }));

            const disposed = makeModel(['a', 'b'], { disposed: false });
            bridge.onCall = () => { disposed.flags.disposed = true; };
            const rD = await provideRange(disposed, range, {}, LIVE);
            bridge.onCall = null;
            check('await 期间文档销毁：区域格式化返回空', rD.length === 0, JSON.stringify(rD));

            bridge.calls.length = 0;
            const early = await provideRange(null, range, {}, LIVE);
            const cancelled = await provideRange(makeModel(['a']), range, {}, DEAD);
            check('空文档早退不抛；token 已取消时连请求都不发（不白等一次 clang-format spawn）',
                early.length === 0 && cancelled.length === 0 && bridge.calls.length === 0,
                JSON.stringify({ early, cancelled, calls: bridge.calls.length }));

            bridge.reply = () => { throw new Error('范围格式化炸了'); };
            const rT = await provideRange(makeModel(['a']), range, {}, LIVE);
            bridge.reply = () => 'FORMATTED';
            const warnT = sandbox.logCalls.warn[sandbox.logCalls.warn.length - 1] || [];
            check('区域格式化失败也只返回空编辑并留日志',
                rT.length === 0 && warnT.join(' ').includes('范围格式化炸了'),
                JSON.stringify({ edits: rT, warn: warnT }));
        }

        // -----------------------------------------------------------------------
        // buildMinimalFormatEdits 单独测：它是「只改写受影响行」这条修复的全部实现，
        // 上面那些场景只覆盖了它被调用的那一路。
        // -----------------------------------------------------------------------
        {
            const m = minimal.fn;
            check('buildMinimalFormatEdits 抽取成功', typeof m === 'function');
            check('正文没变就不产出编辑（避免空 undo 记录）',
                m.call(manager, makeModel(['a', 'b']), 'a\nb', 'a\nb').length === 0);
            {
                // 行尾 \r 只让逐行比较相等，overall 字符串仍不等，所以走的是
                // 「prefix 吃满、末尾零宽改写」这条路，而不是早退。锁的语义是
                // 「不重写任何正文」—— 将来若改成直接返回 []，这条照样过。
                const e = m.call(manager, makeModel(['a', 'b']), 'a\r\nb', 'a\nb');
                check('只差行尾 \\r 时不重写任何正文（不剥 \r 就逐行不等，会退化成整篇替换）',
                    e.length <= 1 && e.every((row) => row.text === ''), JSON.stringify(e));
                const e2 = m.call(manager, makeModel(['a', 'b', 'c']), 'a\r\nb\r\nc', 'a\nb\nc');
                check('逐行只差 \\r 时同样不重写正文',
                    e2.every((row) => row.text === ''), JSON.stringify(e2));
            }
            check('非字符串输入直接返回空，不抛进 Monaco',
                m.call(manager, makeModel(['a']), null, 'x').length === 0 &&
                m.call(manager, makeModel(['a']), 'x', undefined).length === 0);
            {
                const e = m.call(manager, makeModel(['a', 'b', 'c']), 'a\nb\nc', 'a\nB\nc');
                check('中间一行变了就只覆盖那一行，列从行首开始',
                    e.length === 1 && e[0].text === 'B' &&
                    e[0].range.startLineNumber === 2 && e[0].range.endLineNumber === 2 &&
                    e[0].range.startColumn === 1, JSON.stringify(e));
            }

            {
                const e = m.call(manager, makeModel(['a', 'b']), 'a\nb', 'a\nX\nb');
                check('纯插入一行：改写区间收成第 2 行行首的零宽范围',
                    e.length === 1 && e[0].range.startLineNumber === 2 &&
                    e[0].range.endLineNumber === 2 && e[0].range.endColumn === 1 &&
                    e[0].text === 'X', JSON.stringify(e));
            }
            {
                const e = m.call(manager, makeModel(['a', 'b', 'c', 'd']), 'a\nb\nc\nd', 'a\nd');
                check('删掉中间一大段：改写区间跟着缩',
                    e.length === 1 && e[0].range.startLineNumber === 2 &&
                    e[0].range.endLineNumber === 3 && e[0].text === '',
                    JSON.stringify(e));
            }
            {
                const e = m.call(manager, makeModel(['a', 'b']), 'a\nb', 'zz\nyy');
                check('整篇重排时退化成全文替换（但至少仍是一条编辑）',
                    e.length === 1 && e[0].range.startLineNumber === 1 &&
                    e[0].range.endLineNumber === 2 && e[0].text === 'zz\nyy',
                    JSON.stringify(e));
            }
            {
                const e = m.call(manager, makeModel(['a', 'b', 'c', 'd']), 'a\nb\nc\nd', 'A\nb\nc\nD');
                check('两处分散的改动合成一条编辑（Monaco 只记一次 undo）',
                    e.length === 1 && e[0].range.startLineNumber === 1 &&
                    e[0].range.endLineNumber === 4 && e[0].text === 'A\nb\nc\nD',
                    JSON.stringify(e));
            }
            {
                const e = m.call(manager, makeModel(['x', '  indented', 'y']),
                    'x\n  indented\ny', 'x\n\tindented\ny');
                check('缩进改动只重写那一行，endColumn 取该行最大列',
                    e.length === 1 && e[0].range.startLineNumber === 2 &&
                    e[0].text === '\tindented' &&
                    e[0].range.endColumn === ('  indented'.length + 1),
                    JSON.stringify(e));
            }
            {
                const noMaxColumn = makeModel(['a', 'b']);
                delete noMaxColumn.getLineMaxColumn;
                const e = m.call(manager, noMaxColumn, 'a\nb', 'a\nB');
                check('模型没有 getLineMaxColumn 时 endColumn 兜到 1，不抛',
                    e.length === 1 && e[0].range.endColumn === 1, JSON.stringify(e));
            }
            {
                const e = m.call(manager, makeModel(['a', 'b', 'c']), 'a\nb\nc', 'a\nb');
                check('删掉末尾一行：改写区间落在被删的那一行上',
                    e.length === 1 && e[0].range.startLineNumber === 3 &&
                    e[0].range.endLineNumber === 3 && e[0].text === '',
                    JSON.stringify(e));
            }
        }
    }

    const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    check('main process exposes the standalone formatter IPC', mainSource.includes("ipcMain.handle('format-cpp-code'"));
    check('packaged app resolves a separately bundled clang-format', mainSource.includes("path.join(process.resourcesPath, 'clang-format')"));
    check('clang-format resolution falls back to the user LSP dir and PATH', mainSource.includes('resolveClangFormatExecutable(getUserClangdRoot())') && mainSource.includes('findClangFormatExecutableOnPath()'));
    check('missing clang-format error reports the searched paths instead of build instructions', mainSource.includes('describeClangFormatSearchPaths()') && !mainSource.includes('Run pnpm run prebuild:clang-format'));

    const installerSource = fs.readFileSync(path.join(root, 'installer.nsi'), 'utf8');
    check('installer ships clang-format into the resources dir the app resolves', installerSource.includes('File /r "dist\\win-unpacked\\resources\\clang-format\\*"') && installerSource.includes('SetOutPath "$INSTDIR\\resources\\clang-format"'));
    check('installer removes clang-format on uninstall', /RMDir \/r "\$INSTDIR\\resources\\clang-format"/.test(installerSource));

    const pauserSource = fs.readFileSync(path.join(root, 'src', 'utils', 'consolepauser-source.js'), 'utf8');
    // H16: shell:false 下 libuv 会把参数内的 " 转义成 \"，cmd.exe 不认这种转义，
    // start 会把字面量 "Program Running 当成程序名。必须直接 spawn consolepauser.exe。
    check('the pauser is spawned directly instead of through cmd start',
        mainSource.includes('command = absoluteConsolePauserPath;') &&
        mainSource.includes('args = [absoluteExePath];') &&
        !mainSource.includes('start "Program Running"') &&
        !mainSource.includes("command = 'cmd';"));
    // IDE 以 detached + stdio:'ignore' 启动 pauser，不附加控制台；此时 _getch() 无 stdin 可读，
    // 立即返回 EOF，控制台窗口在程序退出的瞬间消失。必须由 pauser 自行 AllocConsole 并重绑句柄。
    check('console pauser allocates its own console so the pause prompt survives',
        pauserSource.includes('bool EnsureConsole()') &&
        pauserSource.includes('GetConsoleWindow() == NULL && !AllocConsole()') &&
        pauserSource.includes('freopen("CONIN$", "r", stdin)') &&
        /int main\(int argc, char\*\* argv\)\s*\{\s*EnsureConsole\(\);/.test(pauserSource));
    check('console output is gated on GetConsoleMode again', pauserSource.includes('GetConsoleMode(outputHandle, &mode)') && !pauserSource.includes('if (WriteConsoleW(outputHandle, line'));
    check('console pauser keeps the legacy summary wording', pauserSource.includes('-----------------------------------------------') && pauserSource.includes('\\u6267\\u884c\\u65f6\\u95f4') && pauserSource.includes('\\u5cf0\\u503c\\u5185\\u5b58\\u4f7f\\u7528') && pauserSource.includes('\\u7a0b\\u5e8f\\u8fd4\\u56de\\u503c') && pauserSource.includes('\\u8bf7\\u6309\\u4efb\\u610f\\u952e\\u7ee7\\u7eed...'));
    check('console pauser is built statically first so it needs no MinGW runtime DLLs', mainSource.includes("{ name: 'utf8-static', sourceMode: 'utf8', args: ['-static'] }"));
    check('stale console pauser binaries are rebuilt from a source fingerprint', mainSource.includes('getConsolePauserSourceFingerprint()') && mainSource.includes('getConsolePauserFingerprintPath()'));
    check('detached run failures are logged through the child exit code', mainSource.includes("logInfo('[运行] 子进程已退出:'"));

    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    check('build downloads standalone clang-format', packageJson.scripts['prebuild:clang-format'] === 'node scripts/run-node-compat.js scripts/download-clang-format.js');
    const packagedSources = ['win', 'mac', 'linux'].flatMap(platform => packageJson.build[platform].extraResources || []);
    check('standalone clang-format is packaged for every desktop platform', packagedSources.filter(item => item.to === 'clang-format').length === 3);

    const downloaderSource = fs.readFileSync(path.join(root, 'scripts', 'download-clang-format.js'), 'utf8');
    check('clang-format comes from the official LLVM project', downloaderSource.includes("'llvm/llvm-project'") && downloaderSource.includes("'23.1.2'"));

    console.log(`clang-format tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.error(`[FAIL] clang-format unexpected error | ${error?.stack || error}`);
    process.exitCode = 1;
});
