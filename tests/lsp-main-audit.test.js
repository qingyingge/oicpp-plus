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

function loadManagerClass() {
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
        path: require('path'),
        fs: require('fs'),
        logInfo: () => {},
        logWarn: () => {},
        logError: () => {},
        // These are only needed if a future test exercises start(); keeping the
        // harness small makes it safe to use the class without booting Electron.
        ensureClangdUserBundle: () => ({ ok: true, root: '/fake/clangd' }),
        resolveClangdExecutable: () => '/fake/clangd/bin/clangd',
        getUserClangdRoot: () => '/fake/clangd',
        getCompilerRuntimeBinPaths: () => [],
        queryCompilerInfo: async () => ({}),
        queryCompilerHeaderIncludeDir: async () => null,
        collectStdCxxIncludeDirs: () => [],
        searchCompilerTreeForStdCxxIncludeDir: () => [],
        addSystemIncludeDir: () => {},
        addStdCxxIncludeBundle: () => {}
    };
    vm.runInNewContext(`${classSource}\nthis.__ClangdLspManager = ClangdLspManager;`, context);
    return context.__ClangdLspManager;
}

class FakeProc extends EventEmitter {
    constructor() {
        super();
        this.writes = [];
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

    const cancelPromise = manager.request('textDocument/completion', {}, 'request-2');
    const cancelResult = manager.cancel('request-2');
    check('audit: main manager sends cancel request', cancelResult?.ok === true && proc.writes.some((line) => line.includes('$/cancelRequest')));
    manager._dispatchMessage({ id: 'request-2', result: { isIncomplete: false } });
    await cancelPromise;

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

    console.log(`[INFO] lsp-main-audit completed: ${failures ? failures + ' failure(s)' : 'all executable contracts passed'}`);
    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.log(`[FAIL] lsp-main-audit unexpected error | ${error?.stack || error?.message || error}`);
    process.exitCode = 1;
});
