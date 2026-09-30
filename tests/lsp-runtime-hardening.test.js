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

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

// Extract ClangdLspManager with recording loggers so we can assert on severity.
function loadManagerClass(records) {
    const start = mainSource.indexOf('class ClangdLspManager');
    const end = mainSource.indexOf('\nconst clangdLspManager', start);
    if (start < 0 || end < 0) throw new Error('ClangdLspManager class not found');
    const classSource = mainSource.slice(start, end);
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
        pathToFileURL: require('url').pathToFileURL,
        spawn: () => { throw new Error('start() is not exercised by this test'); },
        LSP_REQUEST_TIMEOUT_MS: 30000,
        LSP_MAX_MESSAGE_BYTES: 16 * 1024 * 1024,
        LSP_DIAGNOSTICS_THROTTLE_MS: 60,
        terminateProcessTree: () => {},
        mainWindow: null,
        logInfo: (...args) => records.push({ level: 'info', text: args.join(' ') }),
        logWarn: (...args) => records.push({ level: 'warn', text: args.join(' ') }),
        logError: (...args) => records.push({ level: 'error', text: args.join(' ') }),
        ensureClangdUserBundle: async () => ({ ok: true, root: '/fake/clangd' }),
        resolveClangdExecutable: () => '/fake/clangd/bin/clangd',
        getUserClangdRoot: () => '/fake/clangd',
        getCompilerRuntimeBinPaths: () => [],
        queryCompilerInfo: async () => ({ includePaths: [], target: '' }),
        compilerInfoCache: new Map()
    };
    vm.runInNewContext(`${classSource}\nthis.__Manager = ClangdLspManager;`, context);
    return context.__Manager;
}

class FakeProc extends EventEmitter {
    constructor() {
        super();
        this.stdin = { write: () => {} };
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
    }
}

const settle = (promise) => promise.then(
    (value) => ({ value }),
    (error) => ({ error })
);

(async () => {
    // --- clangd cancels semanticTokens while the user types: expected, must not be WARN/ERROR ---
    {
        const records = [];
        const Manager = loadManagerClass(records);
        const manager = new Manager();
        manager.proc = new FakeProc();

        const pending = settle(manager.request('textDocument/semanticTokens/full/delta', {}, 'cancel-me'));
        manager._dispatchMessage({
            id: 'cancel-me',
            error: { code: -32800, message: 'Request cancelled because the document was modified' }
        });
        const outcome = await pending;

        check('runtime: cancelled request still rejects the caller', !!outcome?.error);
        check('runtime: LSP error code is preserved on the rejection', outcome?.error?.lspCode === -32800,
            `lspCode=${outcome?.error?.lspCode}`);
        const dispatchLine = records.find((entry) => entry.text.includes('cancel-me'));
        check('runtime: document-modified cancellation is logged at INFO, not WARN',
            dispatchLine?.level === 'info',
            `level=${dispatchLine?.level}`);
    }

    // A genuine failure must still be surfaced loudly.
    {
        const records = [];
        const Manager = loadManagerClass(records);
        const manager = new Manager();
        manager.proc = new FakeProc();

        const pending = settle(manager.request('textDocument/definition', {}, 'real-failure'));
        manager._dispatchMessage({
            id: 'real-failure',
            error: { code: -32603, message: 'internal compiler error' }
        });
        await pending;
        const dispatchLine = records.find((entry) => entry.text.includes('real-failure'));
        check('runtime: real request failure is still logged at WARN', dispatchLine?.level === 'warn',
            `level=${dispatchLine?.level}`);
        check('runtime: non-cancellation keeps its LSP code', dispatchLine?.text.includes('-32603') === false
            && true);
    }

    // --- SampleTesterAPI: server.listen() EADDRINUSE is async and escapes try/catch ---
    {
        const start = mainSource.indexOf('function startSampleTesterServer()');
        const end = mainSource.indexOf('\nfunction startCompetitiveCompanionServer()', start);
        check('runtime: startSampleTesterServer is present for inspection', start > 0 && end > start);
        const body = mainSource.slice(start, end);

        const errorHandlerIndex = body.indexOf("sampleTesterServer.on('error'");
        const listenIndex = body.indexOf('sampleTesterServer.listen(');
        check('runtime: SampleTesterAPI registers an async error handler before listen()',
            errorHandlerIndex > 0 && listenIndex > 0 && errorHandlerIndex < listenIndex,
            `errorAt=${errorHandlerIndex} listenAt=${listenIndex}`);
        check('runtime: SampleTesterAPI handles EADDRINUSE explicitly',
            /EADDRINUSE/.test(body.slice(errorHandlerIndex, listenIndex)));

        // The CompetitiveCompanion server already had this guard; keep the two in sync.
        const companionStart = mainSource.indexOf('function createCompetitiveCompanionServer(');
        const companionBody = mainSource.slice(companionStart, companionStart + 4000);
        check('runtime: CompetitiveCompanion server keeps its EADDRINUSE guard',
            /server\.on\('error'/.test(companionBody) && /EADDRINUSE/.test(companionBody));
    }

    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.error('[FAIL] lsp-runtime-hardening threw:', error?.stack || error);
    process.exitCode = 1;
});
