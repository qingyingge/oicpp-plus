'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

function loadManagerClass(spawnImpl = undefined, mainWindow = null) {
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
        resolveClangdExecutable: () => '/fake/clangd/bin/clangd',
        getUserClangdRoot: () => '/fake/clangd',
        getCompilerRuntimeBinPaths: () => [],
        queryCompilerInfo: async () => ({ includePaths: [], target: '' }),
        compilerInfoCache: new Map(),
        clangdCompileFlags: require(path.join(__dirname, '..', 'src', 'utils', 'clangd-compile-flags.js'))
    };
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
    const bundleFn = /function ensureClangdUserBundle\(\)[\s\S]*?\n\}/.exec(mainSource);
    check('M55: ensureClangdUserBundle copies the bundle asynchronously',
        !!bundleFn && bundleFn[0].includes('fs.promises.cp') && !bundleFn[0].includes('cpSync'));
    check('M55: ensureClangdUserBundle de-duplicates concurrent calls',
        !!bundleFn && bundleFn[0].includes('clangdBundlePromise'));

    // M52: fallbackFlags 死链路已删除，编译参数改由 compile_flags.txt 承载
    check('M52: fallbackFlags no longer leaves the main process',
        !/return \{ ok: true, clangdPath, args, fallbackFlags \}/.test(mainSource) &&
        !mainSource.includes('addStdCxxIncludeBundle') &&
        !mainSource.includes('collectStdCxxIncludeDirs'));
    check('M52: compile flags are written into the private LSP dir',
        mainSource.includes('clangdCompileFlags.writeCompileFlagsFile') &&
        mainSource.includes('--compile-commands-dir=${compileCommandsDir}'));

    // P3: 渲染进程侧 lsp-start 失败冷却，避免每个特性请求重复发起启动 IPC
    const managerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'monaco-editor-manager.js'), 'utf8');
    const ensureLspReadyBlock = /async ensureLspReady\(\) \{[\s\S]*?\n    \}/.exec(managerSource);
    check('P3: ensureLspReady reuses the last start failure during cooldown',
        !!ensureLspReadyBlock &&
        ensureLspReadyBlock[0].includes('_lspStartFailure') &&
        ensureLspReadyBlock[0].includes('LSP_START_RETRY_COOLDOWN_MS'));

    // L35: 每轮 didChange 只算一次文档安全性，且不再保留必然失配的单槽缓存
    const safetyResult = 'safe-result';
    check('L35: didChange flush passes its safety result down',
        managerSource.includes('this.sendLspDidChange(model, safety)') &&
        managerSource.includes('sendLspDidChange(model, safetyResult = null)') &&
        managerSource.includes('_sendLspDidChange(model, safetyResult)'));
    check('L35: the never-matching single-slot safety cache is gone',
        !managerSource.includes('_lspSafetyCache'));

    // M56: 范围格式化只回写差异行，不再以整模型范围替换
    const rangeProvider = /provideDocumentRangeFormattingEdits[\s\S]*?\n {20}\}/.exec(managerSource);
    check('M56: range formatting emits minimal edits',
        !!rangeProvider && rangeProvider[0].includes('buildMinimalFormatEdits') &&
        !rangeProvider[0].includes('getFullModelRange'));
    check('M56: minimal edit builder compares common prefix/suffix lines',
        managerSource.includes('buildMinimalFormatEdits') &&
        managerSource.includes('let prefix = 0;') &&
        managerSource.includes('let suffix = 0;'));

    // L36: clang-format 可执行路径只解析一次，同参数请求合并/命中缓存
    const formatPathFn = /function resolveClangFormatExecutablePath\(\) \{[\s\S]*?\n\}/.exec(mainSource);
    check('L36: clang-format executable path resolution is cached',
        !!formatPathFn &&
        formatPathFn[0].includes('clangFormatExecutablePathResolved') &&
        formatPathFn[0].includes('findClangFormatExecutableOnPath()') &&
        !formatPathFn[0].includes('const exeName'),
        formatPathFn ? formatPathFn[0].split('\n').length + ' lines' : 'not found');
    check('L36: identical format requests are merged and cached',
        mainSource.includes('clangFormatInFlight') && mainSource.includes('clangFormatResultCache') &&
        mainSource.includes('cacheClangFormatResult'));

    console.log(`[INFO] lsp-main-audit completed: ${failures ? failures + ' failure(s)' : 'all executable contracts passed'}`);    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.log(`[FAIL] lsp-main-audit unexpected error | ${error?.stack || error?.message || error}`);
    process.exitCode = 1;
});
