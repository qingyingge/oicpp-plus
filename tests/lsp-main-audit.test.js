'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');
const {
    arrowProp: extractArrowProp,
    callbackBody,
    classMethod: extractMethod,
    funcDecl,
    scalarConst,
    toFn,
    toProviderFn: buildProviderFn
} = require('./fixtures/source-extract');
const { editOutOfBounds, replayEdit } = require('./fixtures/monaco-edit-replay');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};
// 本文件全是 async 链路：某一环的 promise 永不结算时，事件循环会直接排空、
// 进程以 0 退出，runner 数到前半截的 [PASS] 就判过 —— 尾巴上整段断言静默蒸发。
// （exit 监听里改不了退出码，所以用一条不 unref 的定时器把「跑不完」顶成失败。）
const watchdog = setTimeout(() => {
    console.log('[FAIL] 测试主体 20s 没跑到收尾（中途有 promise 永不结算，后面的断言一条都没跑）');
    process.exit(1);
}, 20000);

function loadManagerClass(spawnImpl = undefined, mainWindow = null, overrides = {}) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const start = source.indexOf('class ClangdLspManager');
    const end = source.indexOf('\nconst clangdLspManager', start);
    if (start < 0 || end < 0) throw new Error('ClangdLspManager class not found');
    const classSource = source.slice(start, end);
    const context = {
        module: { exports: {} },
        exports: {},
        Buffer,
        console,
        setTimeout,
        clearTimeout,
        EventEmitter,
        process,
        path: require('path'),
        fs: require('fs'),
        spawn: spawnImpl,
        LSP_REQUEST_TIMEOUT_MS: 30000,
        LSP_MAX_MESSAGE_BYTES: 16 * 1024 * 1024,
        LSP_DIAGNOSTICS_THROTTLE_MS: 60,
        terminateProcessTree: (proc) => { try { proc?.kill?.(); } catch (_) {} },
        mainWindow,
        logInfo: () => {},
        logWarn: () => {},
        logError: () => {},
        // These are only needed if a future test exercises start(); keeping the
        // harness small makes it safe to use the class without booting Electron.
        ensureClangdUserBundle: async () => ({ ok: true, root: '/fake/clangd' }),
        resolveClangdRootFromBundle: () => null,
        resolveClangdExecutable: () => '/fake/clangd/bin/clangd',
        findClangdExecutableOnPath: () => null,
        getUserToolsRoot: () => '/fake/clangd',
        getCompilerRuntimeBinPaths: () => [],
        queryCompilerInfo: async () => ({ includePaths: [], target: '' }),
        compilerInfoCache: new Map(),
        clangdCompileFlags: require(path.join(__dirname, '..', 'src', 'utils', 'clangd-compile-flags.js'))
    };
    // 覆盖桩：让 start() 这条链路能按需替换 clangdCompileFlags / queryCompilerInfo / 日志，
    // 断言才能落在「真传了什么参数」上，而不是比源码长相。
    Object.assign(context, overrides);
    vm.runInNewContext(`${classSource}\nthis.__ClangdLspManager = ClangdLspManager;`, context);
    return context.__ClangdLspManager;
}

function protocolFrame(payload) {
    const body = JSON.stringify(payload);
    return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

class FakeProc extends EventEmitter {
    constructor() {
        super();
        this.writes = [];
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.stdin = {
            write: (data) => this.writes.push(String(data))
        };
        this.killed = false;
    }

    kill() {
        this.killed = true;
        setImmediate(() => this.emit('exit', 0, null));
    }
}

(async () => {
    const Manager = loadManagerClass();
    const manager = new Manager();
    const proc = new FakeProc();
    manager.proc = proc;

    const responsePromise = manager.request('textDocument/hover', {}, 'request-1');
    check('audit: main manager tracks pending request', manager.pending.has('request-1'));
    check('audit: main manager writes JSON-RPC request', proc.writes.some((line) => line.includes('"method":"textDocument/hover"')));
    manager._dispatchMessage({ id: 'request-1', result: { ok: true } });
    const response = await responsePromise;
    check('audit: main manager resolves response', response?.ok === true && !manager.pending.has('request-1'));

    let sentApplyEdit = null;
    const bridgeWindow = {
        isDestroyed: () => false,
        webContents: {
            send: (channel, payload) => {
                if (channel === 'lsp-apply-edit') sentApplyEdit = payload;
            }
        }
    };
    const WorkspaceEditManager = loadManagerClass(undefined, bridgeWindow);
    const workspaceEditManager = new WorkspaceEditManager();
    const rendererEditPromise = workspaceEditManager._requestRendererWorkspaceEdit({ changes: {} });
    check('audit: main manager tracks renderer WorkspaceEdit request', workspaceEditManager.pendingApplyEdits.size === 1);
    workspaceEditManager.resolveRendererWorkspaceEdit(sentApplyEdit.requestId, { applied: true });
    const rendererEditResult = await rendererEditPromise;
    check('audit: renderer WorkspaceEdit result resolves main request', rendererEditResult?.applied === true && workspaceEditManager.pendingApplyEdits.size === 0);

    const startupProc = new FakeProc();
    const StartupManager = loadManagerClass(() => startupProc);
    const startupManager = new StartupManager();
    const started = await startupManager.start({});
    const initializePromise = startupManager.request('initialize', {}, 'request-initialize');
    startupProc.stdout.emit('data', Buffer.from(protocolFrame({
        jsonrpc: '2.0',
        id: 'request-initialize',
        result: { capabilities: { textDocument: { hoverProvider: true } } }
    }), 'utf8'));
    const initializeResult = await initializePromise;
    check('audit: main manager starts a fake clangd process', started?.ok === true && startupManager.proc === startupProc);
    check('audit: initialize response is parsed through stdout framing', initializeResult?.capabilities?.textDocument?.hoverProvider === true);
    await startupManager.stop();

    const framedManager = new Manager();
    const framedProc = new FakeProc();
    framedManager.proc = framedProc;
    const framedRequest = framedManager.request('textDocument/formatting', {}, 'request-frame');
    const frame = protocolFrame({ id: 'request-frame', result: { edits: [] } });
    framedManager._handleData(Buffer.from(frame.slice(0, 17), 'utf8'));
    framedManager._handleData(Buffer.from(frame.slice(17), 'utf8'));
    check('audit: main manager buffers partial protocol frames', (await framedRequest)?.edits?.length === 0);

    const multiManager = new Manager();
    multiManager.proc = new FakeProc();
    const firstFrameRequest = multiManager.request('textDocument/hover', {}, 'frame-1');
    const secondFrameRequest = multiManager.request('textDocument/hover', {}, 'frame-2');
    multiManager._handleData(Buffer.from(
        protocolFrame({ id: 'frame-1', result: { first: true } }) +
        protocolFrame({ id: 'frame-2', result: { second: true } }),
        'utf8'
    ));
    const [firstFrame, secondFrame] = await Promise.all([firstFrameRequest, secondFrameRequest]);
    check('audit: main manager parses multiple frames in one chunk', firstFrame?.first === true && secondFrame?.second === true);

    const malformedManager = new Manager();
    malformedManager.proc = new FakeProc();
    const malformedRequest = malformedManager.request('textDocument/hover', {}, 'malformed-1');
    let malformedThrew = false;
    try {
        malformedManager._handleData(Buffer.from(
            `Content-Length: ${Buffer.byteLength('{bad', 'utf8')}\r\n\r\n{bad`,
            'utf8'
        ));
    } catch (_) {
        malformedThrew = true;
    }
    let malformedError = null;
    try {
        await malformedRequest;
    } catch (error) {
        malformedError = error;
    }
    check('audit: malformed JSON is surfaced without crashing the parser', !malformedThrew && /Malformed LSP JSON/.test(malformedError?.message || ''));

    const cancelPromise = manager.request('textDocument/completion', {}, 'request-2');
    const cancelOutcome = cancelPromise.then(
        (value) => ({ value }),
        (error) => ({ error })
    );
    const cancelResult = manager.cancel('request-2');
    check('audit: main manager sends cancel request', cancelResult?.ok === true && proc.writes.some((line) => line.includes('$/cancelRequest')));
    manager._dispatchMessage({ id: 'request-2', result: { isIncomplete: false } });
    const cancelled = await cancelOutcome;
    check('audit: main manager rejects cancelled request', /LSP request cancelled/.test(cancelled?.error?.message || ''));

    const errorPromise = manager.request('textDocument/definition', {}, 'request-3');
    manager._dispatchMessage({ id: 'request-3', error: { message: 'synthetic failure' } });
    try {
        await errorPromise;
        check('audit: main manager rejects server error', false);
    } catch (error) {
        check('audit: main manager rejects server error', /synthetic failure/.test(error?.message || ''));
    }

    const stopManager = new Manager();
    const stopProc = new FakeProc();
    stopManager.proc = stopProc;
    const stopPromise = stopManager.request('shutdown', {}, 'request-5');
    const stopped = stopManager.stop();
    try {
        await stopPromise;
        check('audit: stop rejects outstanding request', false);
    } catch (error) {
        check('audit: stop rejects outstanding request', /clangd stopped/.test(error?.message || ''));
    }
    await stopped;
    check('audit: stop clears process and pending state', stopManager.proc === null && stopManager.pending.size === 0 && stopProc.killed);

    // P3: publishDiagnostics 按 uri 合并节流，空诊断不重复下发
    const diagnosticsSends = [];
    const DiagnosticsManager = loadManagerClass(undefined, {
        isDestroyed: () => false,
        webContents: {
            send: (channel, payload) => {
                if (channel === 'lsp-notification') diagnosticsSends.push(payload);
            }
        }
    });
    const diagnosticsManager = new DiagnosticsManager();
    const uri = 'file:///workspace/main.cpp';
    for (let i = 1; i <= 5; i++) {
        diagnosticsManager._dispatchMessage({
            method: 'textDocument/publishDiagnostics',
            params: { uri, diagnostics: new Array(i).fill({ message: `e${i}` }) }
        });
    }
    check('P3: diagnostics are throttled before the window fires', diagnosticsSends.length === 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    check('P3: burst of diagnostics collapses into one send',
        diagnosticsSends.length === 1 && diagnosticsSends[0].params.diagnostics.length === 5,
        `sends=${diagnosticsSends.length} count=${diagnosticsSends[0]?.params?.diagnostics?.length}`);

    diagnosticsManager._dispatchMessage({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    check('P3: clearing diagnostics is still delivered',
        diagnosticsSends.length === 2 && diagnosticsSends[1].params.diagnostics.length === 0);

    diagnosticsManager._dispatchMessage({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    check('P3: repeated empty diagnostics are dropped', diagnosticsSends.length === 2, `sends=${diagnosticsSends.length}`);

    diagnosticsManager._dispatchMessage({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [{ message: 'again' }] } });
    diagnosticsManager._dispatchMessage({ method: 'window/logMessage', params: { message: 'hi' } });
    await diagnosticsManager.stop();
    check('P3: stop flushes the pending diagnostics and drops the timer',
        diagnosticsSends.length === 4 &&
        diagnosticsSends.filter((s) => s.method === 'textDocument/publishDiagnostics' && s.params.diagnostics.length === 1).length === 1 &&
        diagnosticsSends.filter((s) => s.method === 'window/logMessage').length === 1 &&
        diagnosticsManager.diagnosticTimers.size === 0,
        `sends=${diagnosticsSends.map((s) => s.method).join(',')}`);

    // L34: stdout 缓冲改为 chunk 列表，大消息不再逐 chunk O(n²) 拼接
    const chunkedManager = new Manager();
    chunkedManager.proc = new FakeProc();
    const chunkedRequest = chunkedManager.request('textDocument/hover', {}, 'chunked-1');
    const chunkedFrame = protocolFrame({ id: 'chunked-1', result: { chunked: true } });
    chunkedManager._handleData(Buffer.from(chunkedFrame.slice(0, 5), 'utf8'));
    check('L34: partial header without framing does not concatenate',
        chunkedManager.bufferChunks.length === 1 && chunkedManager.bufferedBytes === 5);
    for (let i = 5; i < chunkedFrame.length; i += 7) {
        chunkedManager._handleData(Buffer.from(chunkedFrame.slice(i, i + 7), 'utf8'));
    }
    check('L34: reassembled frame resolves the request', (await chunkedRequest)?.chunked === true);
    check('L34: buffer is drained after the last frame',
        chunkedManager.bufferedBytes === 0 && chunkedManager.bufferChunks.length === 0);

    // L34: 帧头跨 chunk 边界时仍能正确拼接（\r\n\r\n 被拆到两个 chunk）
    const boundaryManager = new Manager();
    boundaryManager.proc = new FakeProc();
    const boundaryRequest = boundaryManager.request('textDocument/hover', {}, 'boundary-1');
    const boundaryFrame = protocolFrame({ id: 'boundary-1', result: { boundary: true } });
    const splitAt = boundaryFrame.indexOf('\r\n\r\n') + 2;
    boundaryManager._handleData(Buffer.from(boundaryFrame.slice(0, splitAt), 'utf8'));
    boundaryManager._handleData(Buffer.from(boundaryFrame.slice(splitAt), 'utf8'));
    check('L34: header split across chunks is reassembled', (await boundaryRequest)?.boundary === true);

    // M54: start() 主进程侧去重，并发 lsp-start 只 spawn 一个 clangd
    let spawnCount = 0;
    const concurrentProcs = [];
    const ConcurrentManager = loadManagerClass(() => {
        spawnCount++;
        const proc = new FakeProc();
        concurrentProcs.push(proc);
        return proc;
    });
    const concurrentManager = new ConcurrentManager();
    const [firstStart, secondStart] = await Promise.all([
        concurrentManager.start({}),
        concurrentManager.start({})
    ]);
    check('M54: concurrent start calls share one clangd spawn',
        spawnCount === 1 && concurrentProcs.length === 1 && firstStart.ok === true && secondStart.ok === true,
        `spawns=${spawnCount}`);
    check('M54: concurrent start callers observe the same process',
        concurrentManager.proc === concurrentProcs[0]);
    await concurrentManager.stop();

    // M55: clangd 包准备走异步拷贝，不再 cpSync 阻塞主进程
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    const bundleFn = funcDecl(mainSource, 'ensureClangdUserBundle');
    check('函数体抽取成功: ensureClangdUserBundle', bundleFn.length > 0);
    {
        // 文本断言只能证明「源码里出现过 fs.promises.cp」，证不出运行期真走了异步分支。
        // 这里把函数抽出来真调：cpSync 一旦被改回去、或并发合流被拆掉，都会当场红。
        const seen = { cp: [], cpSync: [], mkdir: [] };
        const saved = {
            fs: global.fs, logInfo: global.logInfo, logWarn: global.logWarn,
            getUserToolsRoot: global.getUserToolsRoot,
            resolveClangdExecutable: global.resolveClangdExecutable,
            resolveClangdRootFromBundle: global.resolveClangdRootFromBundle,
            migrateLegacyUserTools: global.migrateLegacyUserTools,
            path: global.path,
            clangdBundlePromise: global.clangdBundlePromise
        };
        global.fs = {
            // 合并后（a7a70a6 扁平 bin）的函数体会查 lib/clang 与根下附属文件：
            // existsSync 恒 false、readdir 空表，让拷贝只剩 bin/ 那一条主路径
            existsSync: () => false,
            promises: {
                mkdir: async (p) => { seen.mkdir.push(p); },
                cp: async (from, to) => { seen.cp.push([from, to]); },
                readdir: async () => []
            },
            cpSync: () => { seen.cpSync.push(1); }
        };
        // 拷贝完成前用户目录里没有 clangd，拷完才有 —— 复刻真实时序，
        // 也顺带验证「已存在就短路」这条路径不会重复拷贝
        global.getUserToolsRoot = () => '/user/clangd';
        global.resolveClangdExecutable = () => (seen.cp.length ? '/user/clangd/bin/clangd' : null);
        global.resolveClangdRootFromBundle = () => '/bundle/clangd';
        // a7a70a6 后 ensureClangdUserBundle 首步先迁旧目录；迁移本身由 user-tools-dir 测试守
        global.migrateLegacyUserTools = async () => { };
        // toFn 用 new Function 重建，只能看见全局；合并后的函数体用到 path.join
        global.path = require('path');
        global.logInfo = () => {};
        global.logWarn = () => {};
        global.clangdBundlePromise = null;
        try {
            const run = toFn(bundleFn);
            check('M55: ensureClangdUserBundle 可重建为可调用函数', typeof run === 'function');
            const firstCall = run();
            // 同步阶段刚停在第一个 await 上，mkdir 都还没落定，比不得 cp 次数；
            // 这里只要求「第二次调用没有再启动任何新的拷贝动作」
            const mkdirAfterFirst = seen.mkdir.length;
            const secondCall = run();
            check('M55: 同步阶段不碰 cpSync（阻塞主进程那条路已断）', seen.cpSync.length === 0);
            check('M55: 在途期间的第二次调用不再发起新的拷贝',
                seen.mkdir.length === mkdirAfterFirst && seen.cp.length === 0,
                `mkdir=${seen.mkdir.length} cp=${seen.cp.length}`);
            const [first, second] = await Promise.all([firstCall, secondCall]);
            check('M55: 两个调用者拿到同一个结果对象', first === second && first.ok === true,
                JSON.stringify(first));
            check('M55: 拷贝走的是 fs.promises.cp',
                seen.cp.length === 1 && JSON.stringify(seen.cp[0]) === JSON.stringify([path.join('/bundle/clangd', 'bin'), '/user/clangd']) &&
                seen.mkdir.length === 1, `cp=${JSON.stringify(seen.cp)}`);
            const third = await run();
            check('M55: 落定后再调用，靠「已存在」短路而不是再拷一次',
                seen.cp.length === 1 && third.ok === true, `cp=${seen.cp.length}`);
            check('M55: 在途句柄会被清空（否则失败后永远卡在旧 promise）',
                global.clangdBundlePromise === null);
        }
        finally {
            Object.assign(global, saved);
        }
    }

    // M52: clangd 启动参数与 compile_flags.txt。
    // 原来两条守卫比的是源码长相：includes('clangdCompileFlags.writeCompileFlagsFile')、
    // 字面量 '--compile-commands-dir=${compileCommandsDir}'、以及「return {…fallbackFlags} 这行不存在」。
    // 参数拼到别处、或给 fallbackFlags 换个键名带回渲染层，守卫都不会红。
    // 现在跑真 start()：只看回过来的 args 里到底有什么、写标志文件那步被喂了什么、spawn 怎么起的。
    {
        const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-m52-'));
        const binDir = path.join(ws, 'bin');
        fs.mkdirSync(binDir, { recursive: true });
        const compiler = path.join(binDir, 'g++.exe');
        fs.writeFileSync(compiler, '');
        const flagsDir = path.join(ws, 'lspPrivate');
        const probed = { includePaths: ['/opt/mingw/include', 'C:\\mingw\\lib\\gcc'], target: 'x86_64-w64-mingw32' };
        const seen = { flagCalls: [], warns: [], spawns: [] };
        const mkManager = (probe = async () => probed, extraOverrides = {}) => {
            const proc = new FakeProc();
            const stubs = {
                logInfo: () => { },
                logWarn: (...a) => { seen.warns.push(a.map(String).join(' ')); },
                logError: () => { },
                queryCompilerInfo: probe,
                clangdCompileFlags: {
                    writeCompileFlagsFile: (spec) => {
                        seen.flagCalls.push(spec);
                        return { ok: true, dir: flagsDir, filePath: path.join(flagsDir, 'compile_flags.txt'), written: true };
                    }
                }
            };
            const Mgr = loadManagerClass(
                (cmd, args, opts) => { seen.spawns.push([cmd, args, opts]); return proc; },
                null,
                Object.assign(stubs, extraOverrides));
            return { m: new Mgr(), proc };
        };
        const reset = () => { seen.flagCalls.length = 0; seen.warns.length = 0; seen.spawns.length = 0; };

        const first = mkManager();
        const started = await first.m.start({ compilerPath: compiler, workspaceRoot: ws, rootUri: `file://${ws}`, clangdArgs: ['--log=verbose', '', null] });
        check('M52: clangd 真起进程并回参数',
            started.ok === true && Array.isArray(started.args) && seen.spawns.length === 1, JSON.stringify(started.args));
        check('M52: 探测到的 include 与 target 原样交给写标志文件那一步',
            seen.flagCalls.length === 1
            && JSON.stringify(seen.flagCalls[0].includePaths) === JSON.stringify(probed.includePaths)
            && seen.flagCalls[0].target === probed.target
            && seen.flagCalls[0].workspaceRoot === ws,
            JSON.stringify(seen.flagCalls[0] || null));
        check('M52: compile-commands-dir 用的是写标志文件返回的私有目录，不是工作区本身',
            started.args.includes(`--compile-commands-dir=${flagsDir}`) && !started.args.includes(`--compile-commands-dir=${ws}`),
            JSON.stringify(started.args));
        check('M52: query-driver 用正斜杠并把驱动名打成通配',
            started.args.includes(`--query-driver=${binDir.replace(/\\/g, '/')}/g++*`),
            JSON.stringify(started.args.filter((a) => a.startsWith('--query-driver'))));
        check('M52: 用户附加参数剔掉空值后按原样带上，排在内置参数之后',
            started.args.includes('--log=verbose') && started.args.every(Boolean)
            && started.args.indexOf('--log=verbose') > started.args.indexOf('--background-index'),
            JSON.stringify(started.args.filter((a) => a.startsWith('--log'))));
        check('M52: 渲染层拿不到 fallbackFlags（返回值没这个键，参数里也没有 fallback 字样）',
            !Object.hasOwn(started, 'fallbackFlags') && started.args.every((a) => !/fallback/i.test(a)),
            JSON.stringify(Object.keys(started)));
        // std-cxx include 拼装链（collectStdCxxIncludeDirs → addStdCxxIncludeBundle → fallbackFlags）
        // 整条删掉了：探测出的 include 目录唯一出路是 compile_flags.txt。
        // 原来只查这两个标识符没被写回源码，改名重引、或改从命令行喂 -I 都不会红；
        // 现在钉住「命令行参数的全部来源」和「include 目录不进命令行」这两个行为。
        const allowedArgs = [
            '--offset-encoding=utf-16',
            '--background-index',
            '--completion-style=detailed',
            '--header-insertion=iwyu',
            '--pch-storage=disk',
            `--query-driver=${binDir.replace(/\\/g, '/')}/g++*`,
            '--log=verbose',
            `--compile-commands-dir=${flagsDir}`
        ];
        check('M52: clangd 命令行只有这八个来源，多一个都红（重新引回 include 拼装链会先在这里暴露）',
            started.args.length === allowedArgs.length
            && JSON.stringify([...started.args].sort()) === JSON.stringify([...allowedArgs].sort()),
            JSON.stringify(started.args));
        check('M52: 探测到的 include 目录一个都不进命令行，只交给写标志文件那一步',
            started.args.every((a) => !/^-I/.test(a) && !a.startsWith('--extra-arg')
                && !probed.includePaths.some((inc) => a.includes(inc)))
            && seen.flagCalls.length === 1
            && JSON.stringify(seen.flagCalls[0].includePaths) === JSON.stringify(probed.includePaths),
            JSON.stringify(started.args));
        check('M52: spawn 的 cwd 落到工作区，detached 只在非 win32',
            seen.spawns[0][2].cwd === ws && seen.spawns[0][2].detached === (process.platform !== 'win32'),
            JSON.stringify(seen.spawns[0][2]));
        check('M52: 工作区带 rootUri 时登记 workspaceFolders',
            JSON.stringify(first.m.workspaceFolders) === JSON.stringify([{ uri: `file://${ws}`, name: path.basename(ws) }]),
            JSON.stringify(first.m.workspaceFolders));
        await first.m.stop();

        reset();
        const noWs = mkManager();
        const noWorkspace = await noWs.m.start({ compilerPath: compiler });
        check('M52: 没有工作区就不发 compile-commands-dir（写标志文件那步拿到空 workspaceRoot）',
            noWorkspace.ok === true && noWorkspace.args.every((a) => !a.startsWith('--compile-commands-dir'))
            && seen.flagCalls[0].workspaceRoot === '',
            JSON.stringify(noWorkspace.args));
        await noWs.m.stop();

        reset();
        const badPath = mkManager();
        const badCompiler = await badPath.m.start({ compilerPath: path.join(ws, 'nope.exe'), workspaceRoot: ws });
        check('M52: 编译器路径不存在时跳过 query-driver 并留下告警',
            badCompiler.ok === true && badCompiler.args.every((a) => !a.startsWith('--query-driver'))
            && seen.warns.some((w) => /query-driver/.test(w)),
            JSON.stringify({ warns: seen.warns }));
        await badPath.m.stop();

        // Windows 风格的编译器路径：--query-driver 必须先做反斜杠归一。
        // 少了这一步，POSIX 的 path.dirname 会把 "C:\devkit\bin\g++.exe" 整串当成文件名，
        // 拼出来的 glob 是 "./C:\devkit\bin\g++*" —— clangd 拿去匹配不到任何驱动，
        // 而且只在装了 mingw 但工作区在别的机器这种组合下才暴露。
        reset();
        const winCompiler = 'C:\\devkit\\bin\\g++.exe';
        const winPath = mkManager(async () => probed, {
            fs: Object.assign(Object.create(fs), { existsSync: (p) => p === winCompiler || fs.existsSync(p) })
        });
        const winStarted = await winPath.m.start({ compilerPath: winCompiler, workspaceRoot: ws });
        const winDrivers = winStarted.args.filter((a) => a.startsWith('--query-driver'));
        check('M52: 反斜杠编译器路径归一成 POSIX 分隔符的 glob',
            winStarted.ok === true && winDrivers.length === 1
            && winDrivers[0] === '--query-driver=C:/devkit/bin/g++*'
            && winDrivers.every((a) => !a.includes('\\')),
            JSON.stringify(winDrivers));
        await winPath.m.stop();

        reset();
        const brokenProbe = mkManager(async () => { throw new Error('compiler probe failed'); });
        const boomed = await brokenProbe.m.start({ compilerPath: compiler, workspaceRoot: ws });
        check('M52: 探测编译器信息失败不拦启动，compile-commands-dir 退回工作区',
            boomed.ok === true && boomed.args.includes(`--compile-commands-dir=${ws}`)
            && seen.warns.some((w) => /查询编译器信息/.test(w)),
            JSON.stringify({ args: boomed.args, warns: seen.warns }));
        await brokenProbe.m.stop();
        fs.rmSync(ws, { recursive: true, force: true });
    }

    // -----------------------------------------------------------------------
    // P3 / L35 / M56
    //
    // 这三块原先靠正则读 monaco-editor-manager.js 的源码长相：
    //   `/async ensureLspReady\(\) \{[\s\S]*?\n {4}\}/`   —— 锁死收尾括号的缩进
    //   `/provideDocumentRangeFormattingEdits[\s\S]*?\n {20}\}/` —— 锁死二十个空格
    //   `includes('sendLspDidChange(model, safetyResult = null)')` —— 锁死形参名与默认值
    // .ts 迁移后 tsc printer 会重排源码（单行 if 拆行、空行删除），这些点全在重排范围内；
    // 更要命的是 `!!block &&` 这种写法：抽不到方法时 block 为 null，整块断言直接真空通过。
    // 下面把方法抽出来真跑，抽取失败当场红。
    // -----------------------------------------------------------------------
    const managerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'monaco-editor-manager.js'), 'utf8');

    // 抽取与重建一律走 tests/fixtures/source-extract.js
    const classMethod = (name) => extractMethod(managerSource, name);
    const arrowProp = (name) => extractArrowProp(managerSource, name) || '';

    const ensureLspReadySrc = classMethod('ensureLspReady');
    const sendLspDidChangeSrc = classMethod('sendLspDidChange');
    const buildMinimalSrc = classMethod('buildMinimalFormatEdits');
    const rangeProvider = arrowProp('provideDocumentRangeFormattingEdits');
    check('方法体抽取成功: ensureLspReady', ensureLspReadySrc.length > 0);
    check('方法体抽取成功: sendLspDidChange', sendLspDidChangeSrc.length > 0);
    check('方法体抽取成功: buildMinimalFormatEdits', buildMinimalSrc.length > 0);
    check('箭头属性抽取成功: provideDocumentRangeFormattingEdits', rangeProvider.isAsync === true);

    check('toFn 能把抽出的方法还原成可调用函数',
        typeof toFn(ensureLspReadySrc) === 'function' && typeof toFn(sendLspDidChangeSrc) === 'function');

    // 抽出来的是箭头函数，箭头函数的 this 是词法绑定的，.call(self) 改不了它，
    // 必须重建成 async function 表达式，this 才变成动态绑定。
    const toProviderFn = () => buildProviderFn(rangeProvider);

    // new Function 的作用链终止于全局，模块级常量在函数里不可见，
    // 只能按值取出来再挂上去。取的是数值本身，与源码排版无关。
    const cooldownMatch = managerSource.match(/LSP_START_RETRY_COOLDOWN_MS\s*=\s*(\d+)/);
    check('P3: 冷却常量可读取', !!cooldownMatch, cooldownMatch ? cooldownMatch[0] : 'not found');
    const COOLDOWN_MS = Number(cooldownMatch ? cooldownMatch[1] : 0);

    const realWindow = global.window;
    const realMonaco = global.monaco;
    const realLog = { info: global.logInfo, warn: global.logWarn, error: global.logError };
    global.logInfo = () => {};
    global.logWarn = () => {};
    global.logError = () => {};
    global.LSP_START_RETRY_COOLDOWN_MS = COOLDOWN_MS;

    // ---- P3: 启动失败冷却，避免每个特性请求重复发 lsp-start ----
    {
        const makeLspReady = () => toFn(ensureLspReadySrc);
        check('P3: ensureLspReady 可构造成可调用函数', typeof makeLspReady() === 'function');

        const make = () => {
            const calls = { restart: 0, settings: 0 };
            const m = {
                lspClient: { restart: async () => { calls.restart++; } },
                _lspReadyPromise: null,
                _lspStartFailure: null,
                _lspCompilerPath: '',
                buildRequestedCompileFlags: () => [],
                getWorkspaceRootPath: () => null,
                getFileNameFromPath: () => 'ws',
                registerCppSemanticHighlightingProviders: () => {},
                registerAllLspProviders: () => {},
                ensureLspReady: makeLspReady()
            };
            global.window = { electronAPI: { getAllSettings: async () => { calls.settings++; return {}; } } };
            return { m, calls };
        };

        const { m, calls } = make();
        m.lspClient = null;
        const noClient = await m.ensureLspReady();
        check('P3: 无 lspClient 时返回 null 且不碰任何 IPC',
            noClient === null && calls.restart === 0 && calls.settings === 0,
            `restart=${calls.restart} settings=${calls.settings}`);

        const { m: m2, calls: c2 } = make();
        const inFlight = Promise.resolve('sentinel');
        m2._lspReadyPromise = inFlight;
        // await 会把 promise 拆一层，比的是拆出来的值；同一性在「不再新起一条」上
        const reused = await m2.ensureLspReady();
        check('P3: 启动中时复用同一条 ready promise，不新起启动',
            reused === 'sentinel' && c2.restart === 0 && c2.settings === 0,
            `reused=${reused} restart=${c2.restart}`);

        const { m: m3, calls: c3 } = make();
        const boom = new Error('clangd 启动失败');
        m3._lspStartFailure = { at: Date.now(), error: boom };
        let caught = null;
        try { await m3.ensureLspReady(); } catch (e) { caught = e; }
        check('P3: 冷却期内复用上次失败，抛出的是同一个 error',
            caught === boom, caught === boom ? '同一对象' : `实际 ${caught && caught.message}`);
        check('P3: 冷却期内不发起 lsp-start（这是本次修复的不变量）',
            c3.restart === 0 && c3.settings === 0,
            `restart=${c3.restart} settings=${c3.settings}`);

        let extra = 0;
        for (let k = 0; k < 5; k++) {
            try { await m3.ensureLspReady(); } catch (_) { extra++; }
        }
        check('P3: 冷却期内重复调用 5 次仍然一次 IPC 都不发',
            extra === 5 && c3.restart === 0, `抛错 ${extra} 次 restart=${c3.restart}`);

        const { m: m4, calls: c4 } = make();
        m4._lspStartFailure = { at: Date.now() - COOLDOWN_MS - 1, error: boom };
        await m4.ensureLspReady();
        check('P3: 冷却期过后重新发起启动', c4.restart === 1, `restart=${c4.restart}`);
        check('P3: 冷却期过后失败记录被清掉', m4._lspStartFailure === null,
            String(m4._lspStartFailure && m4._lspStartFailure.at));

        const { m: m5, calls: c5 } = make();
        m5.lspClient = { restart: async () => { c5.restart++; throw new Error('boom2'); } };
        let fail5 = null;
        try { await m5.ensureLspReady(); } catch (e) { fail5 = e; }
        check('P3: 启动失败会被记录进冷却（error 与时间戳都在）',
            fail5 && fail5.message === 'boom2' &&
            m5._lspStartFailure && m5._lspStartFailure.error === fail5 &&
            typeof m5._lspStartFailure.at === 'number' && m5._lspStartFailure.at > 0,
            JSON.stringify({ msg: fail5 && fail5.message, at: m5._lspStartFailure && m5._lspStartFailure.at }));
        check('P3: 启动失败后清空 ready promise，冷却期后才可能重试',
            m5._lspReadyPromise === null, String(m5._lspReadyPromise));

        let second = null;
        try { await m5.ensureLspReady(); } catch (e) { second = e; }
        check('P3: 紧接着的下一次调用落在冷却里，不再发起启动',
            second === fail5 && c5.restart === 1, `restart=${c5.restart}`);
    }

    // ---- L35: 每轮 didChange 只算一次安全性 ----
    {
        const make = () => {
            const seen = { forwarded: [], sent: [] };
            const m = {
                _lspChangePromises: new Map(),
                _lspChangePending: new Set(),
                _lspDocuments: new Set(),
                assessLspDocumentSafety: () => { seen.recomputed = (seen.recomputed || 0) + 1; return { safe: true }; },
                _sendLspDidChange: async (model, safetyResult) => { seen.sent.push(safetyResult); return true; },
                queueLspDidChange: () => { seen.queued = (seen.queued || 0) + 1; },
                sendLspDidChange: toFn(sendLspDidChangeSrc)
            };
            return { m, seen };
        };
        const model = { isDisposed: () => false };
        const safety = { safe: true, reason: 'computed-once' };

        const { m, seen } = make();
        await m.sendLspDidChange(model, safety);
        check('L35: 传入的 safety 被原样下传（对象同一性，不是重算出来的副本）',
            seen.sent.length === 1 && seen.sent[0] === safety, JSON.stringify(seen.sent));
        check('L35: 下传了 safety 就不再重算安全性',
            seen.recomputed === undefined, `重算 ${seen.recomputed} 次`);

        const { m: m2, seen: s2 } = make();
        await m2.sendLspDidChange(model);
        check('L35: 未传 safety 时以 null 下传，由被调方自行计算',
            s2.sent.length === 1 && s2.sent[0] === null, JSON.stringify(s2.sent));

        const { m: m3, seen: s3 } = make();
        m3._lspDocuments.add(model); // 只有仍在 LSP 里开着的文档才需要重新排队
        const first = m3.sendLspDidChange(model, safety);
        const second = m3.sendLspDidChange(model, safety);
        check('L35: 同一 model 的并发 didChange 只发起一次底层请求',
            s3.sent.length === 1, `实际发起 ${s3.sent.length} 次`);
        check('L35: 合并期间把 model 记为 pending', s3.queued === undefined &&
            m3._lspChangePending.has(model), String(m3._lspChangePending.size));
        const r1 = await first;
        const r2 = await second;
        // 复用发生在底层：sendLspDidChange 每次 .finally 会包一层新对象，
        // 所以不能比返回值对象同一性，只能比「底层只跑了一次」与「两条都解析成同一结果」
        check('L35: 第二次调用复用同一条在途请求，不另发',
            r1 === r2 && s3.sent.length === 1, `${r1}/${r2} sent=${s3.sent.length}`);
        check('L35: promise 结束后从 map 摘掉，不留残链',
            m3._lspChangePromises.size === 0, `残留 ${m3._lspChangePromises.size}`);
        check('L35: pending 的 model 会被重新排队', s3.queued === 1, String(s3.queued));

        // 死缓存已删除。原来的守卫只锁字段名 _lspSafetyCache —— 换个名字重新引回来
        // （_lspSafetyMemo 之类）守卫照样绿，而它锁的其实是一条「字段不许存在」的排版。
        // 旧缓存的键是 长度:首字符码:尾字符码，所以要钉住的行为是：同键的不同文本必须
        // 各算各的，后一条不能吃前一条的结论。下面把真方法抽出来连跑三种文本。
        const assessSrc = classMethod('assessLspDocumentSafety');
        check('方法体抽取成功: assessLspDocumentSafety', assessSrc.length > 500, String(assessSrc.length));
        const assess = toFn(assessSrc);
        const savedWindow = global.window;
        const i18nCalls = [];
        global.window = { i18n: { t: (key, params) => { i18nCalls.push({ key, params }); return `<<${key}>>`; } } };
        try {
            const BIG = 'int a[100000][100000];';
            const SAFE = 'int       a[100][100];';
            const SAFE2 = 'int          b[1][10];';
            const CHAR = 'char a[100000][100000];';

            const big = assess(BIG);
            check('L35: 大数组真能判出不安全（安全性判定不是恒过）',
                big.safe === false && big.line === 1 && big.elementSize === 4
                && big.estimatedBytes > 1024 * 1024 * 1024, JSON.stringify(big));
            check('L35: 三条文本在旧单槽缓存的键上必然碰撞（同长度、同首尾字符）',
                SAFE.length === BIG.length && SAFE[0] === BIG[0] &&
                SAFE[SAFE.length - 1] === BIG[BIG.length - 1] &&
                SAFE2.length === BIG.length && SAFE2[0] === BIG[0] &&
                SAFE2[SAFE2.length - 1] === BIG[BIG.length - 1],
                JSON.stringify({ bigLen: BIG.length, safeLen: SAFE.length, safe2Len: SAFE2.length }));

            const lookupsBeforeSafe = i18nCalls.length;
            const safeAfterBig = assess(SAFE);
            const safe2AfterSafe = assess(SAFE2);
            const bigAgain = assess(BIG);
            check('L35: 同键文本依次判定互不干扰，后一条不吃前一条的结论（缓存一旦被重引这里就红）',
                safeAfterBig.safe === true && safe2AfterSafe.safe === true
                && bigAgain.safe === false,
                JSON.stringify({ safeAfterBig, safe2AfterSafe, bigAgain }));
            check('L35: 判定是纯函数：同一条文本重复调用的结果逐字段相同，不随调用次数漂移',
                JSON.stringify(bigAgain) === JSON.stringify(big),
                JSON.stringify({ first: big, again: bigAgain }));

            const charGiant = assess(CHAR);
            check('L35: 元素大小按声明类型算，不是写死一个数（同维度 char 只有 int 的四分之一）',
                charGiant.safe === false && charGiant.elementSize === 1 && big.elementSize === 4,
                JSON.stringify(charGiant));
            check('L35: 不安全理由走 i18n 查表，dims/bytes 来自本次判定',
                i18nCalls.length === lookupsBeforeSafe + 2 /* bigAgain + CHAR */
                && big.reason === '<<monaco.largeArrayDetail>>'
                && i18nCalls.every((c) => c.key === 'monaco.largeArrayDetail')
                && i18nCalls[0].params.dims === 2 && i18nCalls[0].params.bytes === 4
                && i18nCalls[i18nCalls.length - 1].params.bytes === 1,
                JSON.stringify(i18nCalls));
            check('L35: 判定为安全时不查文案（不会为 {safe:true} 造一条 i18n 记录）',
                lookupsBeforeSafe === 1, String(lookupsBeforeSafe));

            const commented = assess('// int a[100000][100000];\nint x;\n');
            const stringed = assess('char *s = "int a[100000][100000];";\n');
            check('L35: 注释和字符串字面量里的例子不会误判不安全',
                commented.safe === true && stringed.safe === true,
                JSON.stringify({ commented, stringed }));
        } finally {
            global.window = savedWindow;
        }

        const disposed = { isDisposed: () => true };
        const { m: m4, seen: s4 } = make();
        const dropped = await m4.sendLspDidChange(disposed, safety);
        check('L35: 已销毁的 model 直接返回 false，不发起 didChange',
            dropped === false && s4.sent.length === 0, JSON.stringify(s4.sent));
    }

    // ---- M56: 范围格式化只回写差异行 ----
    {
        const buildMinimal = toFn(buildMinimalSrc);
        // 模型桩按原文建行：生产里 original 就是 model.getValue()，
        // 拿 formatted 建行会让 getLineMaxColumn 报出原文没有的列。
        const mkModel = (lines) => ({ getLineMaxColumn: (n) => (lines[n - 1] || '').length + 1 });
        const edit = (original, formatted) => buildMinimal(mkModel(original.split('\n')), original, formatted);

        // 断言回放结果，不断言区间数字：增删整行的正确性全在「换行符归谁管」上，
        // 少带一个 '\n' 时区间三个数照样好看，回放才知道会把两行粘成一行。
        const CASES = [
            ['中间一行变化只回写那一行', 'a\nb\nc\nd\ne', 'a\nB\nc\nd\ne'],
            ['首行变化时 prefix 归零，不会多带一行', 'a\nb\nc', 'A\nb\nc'],
            ['末行变化只回写末行', 'a\nb\nc', 'a\nb\nC'],
            ['纯插入一行', 'a\nb\nc', 'a\nN\nb\nc'],
            ['删掉中间一行不留空行', 'a\nb\nc', 'a\nc'],
            ['删掉末行不留空行', 'a\nb\nc', 'a\nb'],
            ['末尾追加一行', 'a\nb', 'a\nb\nc'],
            ['整篇重排仍只一条编辑', 'a\nb', 'z\ny']
        ];
        const bad = [];
        for (const [name, original, formatted] of CASES) {
            const edits = edit(original, formatted);
            if (edits.length !== 1) { bad.push(`${name}→${edits.length} 条编辑`); continue; }
            const oob = editOutOfBounds(original, edits[0]);
            if (oob) { bad.push(`${name} 区间越界: ${oob}`); continue; }
            const back = replayEdit(original, edits[0]).doc;
            if (back !== formatted) {
                bad.push(`${name} 回放成 ${JSON.stringify(back)} ≠ ${JSON.stringify(formatted)}`);
            }
        }
        check(`${CASES.length} 种增删改形状：区间不越界、只一条、回放后逐字等于格式化结果`,
            bad.length === 0, bad.join(' | '));

        // 行尾 \r 差异必须忽略：否则每行都不等，prefix/suffix 双双归零，
        // 退化成整文档替换 —— 恰好把本次要消除的巨型 undo / 光标跳变 / 全文重排放回来
        const crlf = edit('a\nb\nc', 'a\r\nX\r\nc');
        const crlfCovered = crlf.length === 1 ? replayEdit('a\nb\nc', crlf[0]).covered : null;
        check('M56: 行尾 \\r 差异不会让最小化退化成整篇替换',
            crlf.length === 1 && crlfCovered === 'b\n'
            && replayEdit('a\nb\nc', crlf[0]).doc === 'a\nX\nc',
            JSON.stringify({ edits: crlf, covered: crlfCovered }));

        check('M56: 内容没变时一条 edit 都不发',
            buildMinimal(mkModel([]), 'a\nb', 'a\nb').length === 0);
        check('M56: 非字符串输入返回空而不是抛',
            buildMinimal(mkModel([]), null, 'a').length === 0 &&
            buildMinimal(mkModel([]), 'a', undefined).length === 0);

        // provider 侧：必须走 buildMinimalFormatEdits，且不能退回整模型范围
        const provider = toProviderFn();
        const runProvider = async ({ content, model, token, minimalCalls }) => {
            const seen = { minimal: 0, requested: 0 };
            const self = {
                requestClangFormattedCode: async () => { seen.requested++; return content; },
                buildMinimalFormatEdits: (m2, original, formatted) => {
                    seen.minimal++;
                    minimalCalls && minimalCalls.push({ original, formatted });
                    return [{ range: { startLineNumber: 1, endLineNumber: 1 }, text: 'stub' }];
                }
            };
            return { edits: await provider.call(self, model || { getValue: () => 'x\ny', isDisposed: () => false },
                { startLineNumber: 1, endLineNumber: 2 }, {}, token), seen };
        };

        const okCalls = [];
        const ok = await runProvider({ content: 'X\ny', minimalCalls: okCalls });
        check('M56: provider 把结果交给最小化构建，而不是直接整段替换',
            ok.seen.minimal === 1 && ok.edits.length === 1 && ok.edits[0].text === 'stub',
            `minimal 调用 ${ok.seen.minimal} 次`);
        check('M56: 喂给最小化的是格式化前的整文档与格式化后的全文',
            okCalls.length === 1 && okCalls[0].original === 'x\ny' && okCalls[0].formatted === 'X\ny',
            JSON.stringify(okCalls[0]));

        const cancelled = await runProvider({ content: 'X\ny', token: { isCancellationRequested: true }, minimalCalls: [] });
        check('M56: token 已取消时不发 edit 也不调最小化',
            cancelled.edits.length === 0 && cancelled.seen.minimal === 0,
            `edits=${cancelled.edits.length} minimal=${cancelled.seen.minimal}`);
        // 开头那道守卫的价值不在「结果正确」（中间那道也能兜住），
        // 在于压根不发这次格式化 —— 否则每次取消都白跑一趟 IPC
        check('M56: 进来就已取消时不发 clang-format IPC',
            cancelled.seen.requested === 0, `requested=${cancelled.seen.requested}`);

        // 开头那道守卫拦得住「进来就已取消」，拦不住「格式化跑一半才取消」。
        // 后者才是真实竞态：clang-format 是异步 IPC，用户在等待期间撤了。
        // 只有 await 之后的那次复查能识别，所以那次复查不是冗余。
        {
            const lateToken = { isCancellationRequested: false };
            const late = {
                requestClangFormattedCode: async () => { lateToken.isCancellationRequested = true; return 'X\ny'; },
                buildMinimalFormatEdits: () => { lateHit = true; return []; }
            };
            let lateHit = false;
            const lateEdits = await toProviderFn().call(late,
                { getValue: () => 'x\ny', isDisposed: () => false }, {}, {}, lateToken);
            check('M56: 格式化期间被取消时，await 之后的复查挡得住（不把过期结果写回去）',
                lateEdits.length === 0 && lateHit === false,
                `edits=${lateEdits.length} 最小化被调用=${lateHit}`);
        }
        {
            const model = { getValue: () => 'x\ny', isDisposed: () => model.disposed === true, disposed: false };
            const self = {
                requestClangFormattedCode: async () => { model.disposed = true; return 'X\ny'; },
                buildMinimalFormatEdits: () => { lateHit2 = true; return []; }
            };
            let lateHit2 = false;
            const lateEdits = await toProviderFn().call(self, model, {}, {}, undefined);
            check('M56: 格式化期间文档被销毁时不回写',
                lateEdits.length === 0 && lateHit2 === false,
                `edits=${lateEdits.length} 最小化被调用=${lateHit2}`);
        }

        const nullContent = await runProvider({ content: null, minimalCalls: [] });
        check('M56: clang-format 返回 null 时不发 edit',
            nullContent.edits.length === 0 && nullContent.seen.minimal === 0,
            `edits=${nullContent.edits.length}`);

        const disposedModel = await runProvider({ content: 'X', model: { getValue: () => 'x', isDisposed: () => true }, minimalCalls: [] });
        check('M56: model 已销毁时不发 edit',
            disposedModel.edits.length === 0, `edits=${disposedModel.edits.length}`);

        const throwing = toProviderFn();
        let swallowed = 'not-run';
        try {
            const out = await throwing.call({
                requestClangFormattedCode: async () => { throw new Error('formatter down'); },
                buildMinimalFormatEdits: () => []
            }, { getValue: () => 'x', isDisposed: () => false }, {}, {}, {});
            swallowed = Array.isArray(out) && out.length === 0 ? 'empty' : JSON.stringify(out);
        } catch (e) {
            swallowed = 'threw:' + e.message;
        }
        check('M56: 格式化抛错时吞掉并回空数组，不让 Monaco 弹异常',
            swallowed === 'empty', swallowed);

        // 排版无关的语义守卫：整模型范围替换这个旧形态不能回来
        check('M56: provider 不再使用整模型范围',
            !rangeProvider.body.includes('getFullModelRange'), '');
    }

    global.window = realWindow;
    global.monaco = realMonaco;
    global.logInfo = realLog.info;
    global.logWarn = realLog.warn;
    global.logError = realLog.error;
    delete global.LSP_START_RETRY_COOLDOWN_MS;

    // L36: clang-format 可执行路径只解析一次，同参数请求合并/命中缓存
    const formatPathFn = funcDecl(mainSource, 'resolveClangFormatExecutablePath');
    check('函数体抽取成功: resolveClangFormatExecutablePath', formatPathFn.length > 0);
    {
        // 「只解析一次」是运行期契约，`includes('clangFormatExecutablePathResolved')`
        // 挡不住「读了标志但忘了置位」这种变异 —— 真调两次才看得出来。
        const seen = { resolve: 0, fromBundle: 0, onPath: 0 };
        const saved = {
            clangFormatExecutablePathResolved: global.clangFormatExecutablePathResolved,
            cachedClangFormatExecutablePath: global.cachedClangFormatExecutablePath,
            resolveClangFormatExecutable: global.resolveClangFormatExecutable,
            resolveClangFormatRootFromBundle: global.resolveClangFormatRootFromBundle,
            getUserToolsRoot: global.getUserToolsRoot,
            findClangFormatExecutableOnPath: global.findClangFormatExecutableOnPath
        };
        global.clangFormatExecutablePathResolved = false;
        global.cachedClangFormatExecutablePath = null;
        global.clangFormatPathProbe = { bundleFail: false, userFail: false };
        global.resolveClangFormatRootFromBundle = () => { seen.fromBundle++; return '/bundle'; };
        global.getUserToolsRoot = () => '/user/clangd';
        global.findClangFormatExecutableOnPath = () => { seen.onPath++; return '/usr/bin/clang-format'; };
        global.resolveClangFormatExecutable = (root) => {
            seen.resolve++;
            if (root === '/bundle' && global.clangFormatPathProbe.bundleFail) return null;
            if (root === '/user/clangd' && global.clangFormatPathProbe.userFail) return null;
            return root === '/bundle' ? '/bin/clang-format' : `${root}/bin/clang-format`;
        };
        try {
            const run = toFn(formatPathFn);
            const resetCache = () => {
                global.clangFormatExecutablePathResolved = false;
                global.cachedClangFormatExecutablePath = null;
                seen.resolve = seen.fromBundle = seen.onPath = 0;
            };
            const first = run();
            const second = run();
            const third = run();
            check('L36: 三次调用只解析一次',
                seen.resolve === 1 && seen.fromBundle === 1 && first === second && second === third,
                `resolve=${seen.resolve} fromBundle=${seen.fromBundle}`);
            check('L36: 解析过就置位，命中缓存走的是同一条路径',
                global.clangFormatExecutablePathResolved === true &&
                global.cachedClangFormatExecutablePath === '/bin/clang-format',
                String(global.clangFormatExecutablePathResolved));
            // 顺序契约：打包根 → 用户目录 → PATH，前一档命中就不许再往下探
            resetCache();
            global.clangFormatPathProbe.userFail = true;
            check('L36: 打包根命中时不去翻用户目录和 PATH',
                run() === '/bin/clang-format' && seen.fromBundle === 1 && seen.onPath === 0,
                `fromBundle=${seen.fromBundle} onPath=${seen.onPath}`);
            resetCache();
            global.clangFormatPathProbe.bundleFail = true;
            global.clangFormatPathProbe.userFail = false;
            check('L36: 打包根解析失败才退到用户目录',
                run() === '/user/clangd/bin/clang-format' && seen.onPath === 0,
                `onPath=${seen.onPath}`);
            resetCache();
            global.clangFormatPathProbe.userFail = true;
            check('L36: 两档都失败才落到 PATH 查找',
                run() === '/usr/bin/clang-format' && seen.onPath === 1,
                `onPath=${seen.onPath}`);
            check('L36: 不再用局部 exeName 变量中转（历史形态回归）',
                !formatPathFn.includes('const exeName'),
                formatPathFn.split('\n').length + ' lines');
        }
        finally {
            delete global.clangFormatPathProbe;
            Object.assign(global, saved);
        }
    }
    // L36: 相同格式化请求合并 + 有限缓存。
    // 原来这条只比三个标识符名在不在（clangFormatInFlight / clangFormatResultCache /
    // cacheClangFormatResult）：缓存写成只 set 不读、并发各起各的进程，名字都还全乎。
    // 现在抽真 handler + 真缓存声明 + 真淘汰函数，在 vm 里数「到底起几次 clang-format」。
    {
        const body = callbackBody(mainSource, /ipcMain\.handle\(\s*'format-cpp-code',\s*async\s*\(_event,\s*request\s*=\s*\{\}\)\s*=>/);
        const decls = [
            scalarConst(mainSource, 'clangFormatInFlight'),
            scalarConst(mainSource, 'clangFormatResultCache'),
            scalarConst(mainSource, 'CLANG_FORMAT_RESULT_CACHE_LIMIT'),
            funcDecl(mainSource, 'cacheClangFormatResult')
        ];
        check('format-cpp-code handler 与缓存三件套抽取成功',
            body.startsWith('{') && decls.every((s) => s.length > 0),
            JSON.stringify({ body: body.slice(0, 14), decls: decls.map((s) => s.slice(0, 16)) }));
        const mkFormat = ({ exePath = () => '/fake/bin/clang-format', run = null } = {}) => {
            const calls = [];
            const ctx = vm.createContext({
                JSON, String, Number, Object, Array, Error, Promise, Map, Set, Buffer,
                path: require('path'),
                resolveClangFormatExecutablePath: exePath,
                describeClangFormatSearchPaths: () => '<search paths>',
                getClangFormatExecutableName: () => 'clang-format.exe',
                getUserToolsRoot: () => '/fake/clangd',
                logError: () => { },
                formatCodeWithClangFormat: async (spec) => {
                    calls.push(spec);
                    return run ? run(spec, calls.length) : { content: `F${calls.length}` };
                }
            });
            vm.runInContext(decls.join('\n') + `
this.__handler = async (_event, request = {}) => ${body};
this.__peek = () => ({ cache: clangFormatResultCache.size, pending: clangFormatInFlight.size, limit: CLANG_FORMAT_RESULT_CACHE_LIMIT });
`, ctx);
            return { ctx, calls, handler: ctx.__handler, peek: ctx.__peek };
        };

        const idle = mkFormat();
        check('L36: 正常路径确实把参数交给 clang-format（合并缓存没把第一次调用也吞掉）',
            (await idle.handler(null, { content: 'int main(){}' })).ok === true && idle.calls.length === 1,
            JSON.stringify(idle.calls[0]));
        const noExe = mkFormat({ exePath: () => null });
        const failed = await noExe.handler(null, { content: 'int main(){}' });
        check('L36: 缺可执行文件的错误里带上搜索路径（只回「失败」等于没法定位）',
            failed.ok === false && noExe.calls.length === 0
            && /<search paths>/.test(failed.error || '') && /clang-format\.exe/.test(failed.error || ''),
            JSON.stringify(failed.error));

        const gate = (() => {
            let release;
            const wait = new Promise((resolve) => { release = resolve; });
            return { wait, release };
        })();
        const merged = mkFormat({ run: async () => { await gate.wait; return { content: 'FORMATTED' }; } });
        // 两路请求必须同时在「等 clang-format」这个状态里，才谈得上合并；
        // 所以先把 promise 发出去、让两路都跑到合并点，再放行闸门 ——
        // 先 await Promise.all 再 release 是自己把自己吊死。
        const bothPromise = Promise.all([
            merged.handler(null, { content: 'int main(){}', filePath: '/a.cpp' }),
            merged.handler(null, { content: 'int main(){}', filePath: '/a.cpp' })
        ]);
        await new Promise((resolve) => setImmediate(resolve));
        gate.release();
        const both = await bothPromise;
        check('L36: 并发同请求合并成一次 clang-format，两路都拿到带 ok 的完整信封',
            merged.calls.length === 1 && both.every((r) => r.ok === true && r.content === 'FORMATTED'),
            JSON.stringify({ calls: merged.calls.length, both }));
        check('L36: 合并结束后在途表被清空（不清就永远等在一个已完成的 promise 上）',
            merged.peek().pending === 0, JSON.stringify(merged.peek()));

        const reused = mkFormat();
        const r1 = await reused.handler(null, { content: 'int main(){}', style: 'file' });
        const r2 = await reused.handler(null, { content: 'int main(){}', style: 'file' });
        check('L36: 同样的请求第二次直接吃缓存，不再起进程',
            reused.calls.length === 1 && r1.content === 'F1' && r2.content === 'F1',
            JSON.stringify({ calls: reused.calls.length, r1, r2 }));
        await reused.handler(null, { content: 'int main(){}', style: 'google' });
        check('L36: style 变化算不同请求（缓存键漏掉 style 会把两种风格返回成同一份）',
            reused.calls.length === 2, String(reused.calls.length));
        await reused.handler(null, { content: 'int other(){}', style: 'file' });
        check('L36: 内容变化算不同请求', reused.calls.length === 3, String(reused.calls.length));
        check('L36: 交给 clang-format 的是原样参数（content/style/fallbackStyle 一个都不该丢）',
            reused.calls[0].content === 'int main(){}' && reused.calls[0].filePath === undefined
            && reused.calls[1].style === 'google' && reused.calls[0].style === 'file',
            JSON.stringify(reused.calls.map((c) => [c.content, c.style])));

        const boom = mkFormat({ run: async () => { throw new Error('clang-format crashed'); } });
        const crash1 = await boom.handler(null, { content: 'x' });
        const crash2 = await boom.handler(null, { content: 'x' });
        check('L36: clang-format 抛错回 ok:false 带原因，且失败不进缓存',
            crash1.ok === false && /crashed/.test(crash1.error || '') && boom.calls.length === 2,
            JSON.stringify({ calls: boom.calls.length, crash1, crash2 }));
        check('L36: 失败之后在途表与结果缓存都是空的（留残链就再也格式化不了）',
            boom.peek().pending === 0 && boom.peek().cache === 0, JSON.stringify(boom.peek()));

        const evict = mkFormat();
        const limit = evict.peek().limit;
        for (let i = 0; i < limit + 2; i++) await evict.handler(null, { content: `c${i}` });
        check('L36: 结果缓存有上限并按上限淘汰最旧的（写成无界缓存就是无限吃内存）',
            evict.peek().cache === limit && Number.isFinite(limit) && limit > 0,
            JSON.stringify(evict.peek()));
        const before = evict.calls.length;
        await evict.handler(null, { content: 'c0' });
        check('L36: 被淘汰的最旧条目会重新起进程，而窗口内的最新条目仍命中缓存',
            evict.calls.length === before + 1, JSON.stringify({ before, after: evict.calls.length }));
        const freshIdx = evict.calls.length - 1;
        await evict.handler(null, { content: `c${limit + 1}` });
        check('L36: 仍在窗口内的请求不重复起进程',
            evict.calls.length === freshIdx + 1, JSON.stringify({ size: evict.calls.length }));
    }

    clearTimeout(watchdog);
    console.log(`[INFO] lsp-main-audit completed: ${failures ? failures + ' failure(s)' : 'all executable contracts passed'}`);    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    clearTimeout(watchdog);
    console.log(`[FAIL] lsp-main-audit unexpected error | ${error?.stack || error?.message || error}`);
    process.exitCode = 1;
});
