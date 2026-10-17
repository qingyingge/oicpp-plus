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

    // 类方法：行首缩进 + 名字 + '('，先配平参数列表再配平方法体，连签名一起返回。
    // 不能剥签名 —— new Function 会把剩下的方法体当形参列表。
    function classMethod(name) {
        const m = new RegExp('^\\s{4}(?:async\\s+)?' + name + '\\s*\\(', 'm').exec(managerSource);
        if (!m) return '';
        let i = managerSource.indexOf('(', m.index), p = 0;
        for (; i < managerSource.length; i++) {
            if (managerSource[i] === '(') p++;
            else if (managerSource[i] === ')') { p--; if (p === 0) break; }
        }
        let d = 0;
        for (i = managerSource.indexOf('{', i); i < managerSource.length; i++) {
            if (managerSource[i] === '{') d++;
            else if (managerSource[i] === '}') { d--; if (d === 0) return managerSource.slice(m.index, i + 1); }
        }
        return '';
    }

    // 对象字面量里的箭头属性：`name: async (args) => { ... }`
    function arrowProp(name) {
        const m = new RegExp(name + '\\s*:\\s*(async\\s*)?\\(', 'm').exec(managerSource);
        if (!m) return '';
        const isAsync = !!m[1];
        let i = managerSource.indexOf('(', m.index), p = 0;
        for (; i < managerSource.length; i++) {
            if (managerSource[i] === '(') p++;
            else if (managerSource[i] === ')') { p--; if (p === 0) break; }
        }
        const params = managerSource.slice(m.index + m[0].indexOf('('), i + 1);
        const arrow = managerSource.indexOf('=>', i);
        if (arrow < 0) return '';
        let d = 0;
        for (i = managerSource.indexOf('{', arrow); i < managerSource.length; i++) {
            if (managerSource[i] === '{') d++;
            else if (managerSource[i] === '}') { d--; if (d === 0) return { params, body: managerSource.slice(managerSource.indexOf('{', arrow), i + 1), isAsync }; }
        }
        return '';
    }

    const ensureLspReadySrc = classMethod('ensureLspReady');
    const sendLspDidChangeSrc = classMethod('sendLspDidChange');
    const buildMinimalSrc = classMethod('buildMinimalFormatEdits');
    const rangeProvider = arrowProp('provideDocumentRangeFormattingEdits');
    check('方法体抽取成功: ensureLspReady', ensureLspReadySrc.length > 0);
    check('方法体抽取成功: sendLspDidChange', sendLspDidChangeSrc.length > 0);
    check('方法体抽取成功: buildMinimalFormatEdits', buildMinimalSrc.length > 0);
    check('箭头属性抽取成功: provideDocumentRangeFormattingEdits', !!rangeProvider && rangeProvider.isAsync === true);

    // classMethod 连签名带行首缩进一起截，async 关键字也在里面，
    // 所以前缀必须是 `async function`，否则拼出 async function async name() {}
    function toFn(methodSrc) {
        if (!methodSrc) return undefined;
        const src = methodSrc.replace(/^\s+/, '');
        const isAsync = /^async\s+/.test(src);
        return new Function('return (' + (isAsync ? 'async function ' : 'function ') +
            src.replace(/^async\s+/, '') + ')')();
    }
    check('toFn 能把抽出的方法还原成可调用函数',
        typeof toFn(ensureLspReadySrc) === 'function' && typeof toFn(sendLspDidChangeSrc) === 'function');

    // 抽出来的是箭头函数，箭头函数的 this 是词法绑定的，.call(self) 改不了它。
    // 用同样的参数表和函数体重建成 async function 表达式，this 才变成动态绑定。
    function toProviderFn() {
        return new Function('return (async function ' + rangeProvider.params + ' ' + rangeProvider.body + ')')();
    }

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

        // 死缓存已删除：字段名守卫本身就是文本断言，形态与缩进无关，保留
        check('L35: 必然失配的单槽安全性缓存已移除', !managerSource.includes('_lspSafetyCache'));

        const disposed = { isDisposed: () => true };
        const { m: m4, seen: s4 } = make();
        const dropped = await m4.sendLspDidChange(disposed, safety);
        check('L35: 已销毁的 model 直接返回 false，不发起 didChange',
            dropped === false && s4.sent.length === 0, JSON.stringify(s4.sent));
    }

    // ---- M56: 范围格式化只回写差异行 ----
    {
        const buildMinimal = toFn(buildMinimalSrc);
        const mkModel = (lines) => ({ getLineMaxColumn: (n) => (lines[n - 1] || '').length + 1 });
        const edit = (original, formatted) => buildMinimal(mkModel(formatted.split('\n')), original, formatted);

        const mid = edit('a\nb\nc\nd\ne', 'a\nB\nc\nd\ne');
        check('M56: 中间一行变化只回写那一行',
            mid.length === 1 && mid[0].range.startLineNumber === 2 &&
            mid[0].range.endLineNumber === 2 && mid[0].text === 'B',
            JSON.stringify(mid[0] && mid[0].range));
        const head = edit('a\nb\nc', 'A\nb\nc');
        check('M56: 首行变化时 prefix 归零，不会多带一行',
            head[0].range.startLineNumber === 1 && head[0].range.endLineNumber === 1 &&
            head[0].text === 'A', JSON.stringify(head[0]));
        const tail = edit('a\nb\nc', 'a\nb\nC');
        check('M56: 末行变化只回写末行', tail[0].range.startLineNumber === 3 &&
            tail[0].range.endLineNumber === 3 && tail[0].text === 'C', JSON.stringify(tail[0]));

        // 行尾 \r 差异必须忽略：否则每行都不等，prefix/suffix 双双归零，
        // 退化成整文档替换 —— 恰好把本次要消除的巨型 undo / 光标跳变 / 全文重排放回来
        const crlf = edit('a\nb\nc', 'a\r\nX\r\nc');
        check('M56: 行尾 \\r 差异不会让最小化退化',
            crlf.length === 1 && crlf[0].range.startLineNumber === 2 &&
            crlf[0].range.endLineNumber === 2, JSON.stringify(crlf[0] && crlf[0].range));

        const inserted = edit('a\nb\nc', 'a\nN\nb\nc');
        check('M56: 纯插入也覆盖一个插入点而不是整文档',
            inserted.length === 1 && inserted[0].range.startLineNumber === 2 &&
            inserted[0].range.endLineNumber === 2 && inserted[0].text === 'N',
            JSON.stringify(inserted[0] && inserted[0].range));

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
