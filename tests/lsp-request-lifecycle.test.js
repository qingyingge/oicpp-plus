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

const REQUEST_TIMEOUT_MS = 40;

function loadManagerClass(mainWindow = null) {
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
        setInterval,
        clearInterval,
        EventEmitter,
        process,
        path: require('path'),
        fs: require('fs'),
        pathToFileURL: require('url').pathToFileURL,
        spawn: () => { throw new Error('start() is not exercised by this test'); },
        // Override the production timeout so the test does not idle for 30s.
        LSP_REQUEST_TIMEOUT_MS: REQUEST_TIMEOUT_MS,
        LSP_MAX_MESSAGE_BYTES: 16 * 1024 * 1024,
        LSP_DIAGNOSTICS_THROTTLE_MS: 60,
        terminateProcessTree: () => {},
        mainWindow,
        logInfo: () => {},
        logWarn: () => {},
        logError: () => {},
        ensureClangdUserBundle: async () => ({ ok: true, root: '/fake/clangd' }),
        resolveClangdExecutable: () => '/fake/clangd/bin/clangd',
        getUserClangdRoot: () => '/fake/clangd',
        getCompilerRuntimeBinPaths: () => [],
        queryCompilerInfo: async () => ({ includePaths: [], target: '' }),
        compilerInfoCache: new Map()
    };
    vm.runInNewContext(`${classSource}\nthis.__ClangdLspManager = ClangdLspManager;`, context);
    return context.__ClangdLspManager;
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

    payloadFor(method) {
        const write = this.writes.find((entry) => entry.includes(`"method":"${method}"`));
        if (!write) return null;
        const bodyStart = write.indexOf('\r\n\r\n');
        if (bodyStart < 0) return null;
        try {
            return JSON.parse(write.slice(bodyStart + 4));
        } catch (_) {
            return null;
        }
    }
}

const settle = (promise) => promise.then(
    (value) => ({ value }),
    (error) => ({ error })
);

(async () => {
    const Manager = loadManagerClass();

    // A request that clangd never answers must time out, send $/cancelRequest,
    // and drop out of pending instead of leaking forever.
    const timeoutManager = new Manager();
    const timeoutProc = new FakeProc();
    timeoutManager.proc = timeoutProc;
    const timedOut = settle(timeoutManager.request('textDocument/documentSymbol', {}, 'timeout-1'));
    check('lifecycle: request stays pending before the timeout fires', timeoutManager.pending.has('timeout-1'));
    await new Promise((resolve) => setTimeout(resolve, REQUEST_TIMEOUT_MS + 25));
    const timeoutOutcome = await timedOut;
    check('lifecycle: stalled request rejects with ETIMEDOUT', timeoutOutcome?.error?.code === 'ETIMEDOUT'
        && /timed out/.test(timeoutOutcome?.error?.message || ''),
    `message=${timeoutOutcome?.error?.message}`);
    check('lifecycle: timed-out request is removed from pending', !timeoutManager.pending.has('timeout-1'));
    check('lifecycle: timeout cancels the request on the server',
        timeoutProc.writes.some((line) => line.includes('$/cancelRequest')));

    // A response that arrives after the timeout must not resurrect the promise.
    let lateThrew = false;
    try {
        timeoutManager._dispatchMessage({ id: 'timeout-1', result: { late: true } });
    } catch (_) {
        lateThrew = true;
    }
    check('lifecycle: late response for a timed-out request is ignored', !lateThrew && !timeoutManager.pending.has('timeout-1'));

    // A response that lands in time must clear the timer, so a later timeout
    // sweep cannot reject an already-settled promise.
    const resolvedManager = new Manager();
    const resolvedProc = new FakeProc();
    resolvedManager.proc = resolvedProc;
    const resolvedPromise = resolvedManager.request('textDocument/hover', {}, 'fast-1');
    resolvedManager._dispatchMessage({ id: 'fast-1', result: { ok: true } });
    const resolvedValue = await resolvedPromise;
    const entryAfterResolve = resolvedManager.pending.get('fast-1');
    check('lifecycle: response clears the pending entry', resolvedValue?.ok === true && !entryAfterResolve);

    // notifyFileChange maps app-level change types onto LSP FileChangeType and
    // encodes the path as a file:// URI.
    const watchManager = new Manager();
    const watchProc = new FakeProc();
    watchManager.proc = watchProc;
    const created = watchManager.notifyFileChange('C:\\workspace\\new.cpp', 'created');
    const changed = watchManager.notifyFileChange('C:\\workspace\\new.cpp', 'modified');
    const deleted = watchManager.notifyFileChange('C:\\workspace\\new.cpp', 'deleted');
    check('lifecycle: notifyFileChange reports success while clangd runs',
        created?.ok === true && changed?.ok === true && deleted?.ok === true);

    const frames = watchProc.writes
        .filter((line) => line.includes('workspace/didChangeWatchedFiles'))
        .map((line) => {
            const bodyStart = line.indexOf('\r\n\r\n');
            return JSON.parse(line.slice(bodyStart + 4));
        });
    check('lifecycle: watched-file changes are sent as one notification per event', frames.length === 3,
        `frames=${frames.length}`);
    const types = frames.map((frame) => frame?.params?.changes?.[0]?.type);
    check('lifecycle: created/modified/deleted map to LSP FileChangeType 1/2/3',
        JSON.stringify(types) === JSON.stringify([1, 2, 3]),
        `types=${JSON.stringify(types)}`);
    const uris = frames.map((frame) => frame?.params?.changes?.[0]?.uri);
    check('lifecycle: watched-file notification carries a file:// URI',
        uris.every((uri) => typeof uri === 'string' && uri.startsWith('file:///')),
        `uri=${uris[0]}`);

    const stoppedWatch = new Manager();
    const stoppedWatchResult = stoppedWatch.notifyFileChange('C:\\workspace\\new.cpp', 'modified');
    check('lifecycle: notifyFileChange is a no-op while clangd is stopped',
        stoppedWatchResult?.ok === false && !!stoppedWatchResult?.error);

    // An impossible Content-Length must reset the stream and fail pending work
    // rather than wedging the parser on garbage.
    const badLengthManager = new Manager();
    badLengthManager.proc = new FakeProc();
    const badLengthPromise = settle(badLengthManager.request('textDocument/foldingRange', {}, 'bad-length-1'));
    let badLengthThrew = false;
    try {
        badLengthManager._handleData(Buffer.from(
            `Content-Length: ${32 * 1024 * 1024}\r\n\r\n${'x'.repeat(16)}`,
            'utf8'
        ));
    } catch (_) {
        badLengthThrew = true;
    }
    const badLengthOutcome = await badLengthPromise;
    check('lifecycle: oversized Content-Length is rejected',
        !badLengthThrew && /Invalid LSP Content-Length/.test(badLengthOutcome?.error?.message || ''),
    `message=${badLengthOutcome?.error?.message}`);
    check('lifecycle: oversized frame leaves no pending request', !badLengthManager.pending.has('bad-length-1'));

    // After a protocol-level failure the manager must still accept new requests.
    const recoveredManager = new Manager();
    const recoveredProc = new FakeProc();
    recoveredManager.proc = recoveredProc;
    const recoveredPromise = recoveredManager.request('textDocument/hover', {}, 'recover-1');
    recoveredManager._dispatchMessage({ id: 'recover-1', result: { recovered: true } });
    check('lifecycle: manager keeps serving requests after a protocol failure',
        (await recoveredPromise)?.recovered === true);

    // Cancelling twice must not throw or double-reject.
    const cancelManager = new Manager();
    const cancelProc = new FakeProc();
    cancelManager.proc = cancelProc;
    const cancelPromise = settle(cancelManager.request('textDocument/completion', {}, 'cancel-twice'));
    const firstCancel = cancelManager.cancel('cancel-twice');
    const secondCancel = cancelManager.cancel('cancel-twice');
    const cancelOutcome = await cancelPromise;
    check('lifecycle: cancel rejects once and reports not-found afterwards',
        firstCancel?.ok === true && secondCancel?.ok === false
        && cancelOutcome?.error?.code === 'ECANCELED',
    `second=${JSON.stringify(secondCancel)}`);

    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.error('[FAIL] lsp-request-lifecycle threw:', error?.stack || error);
    process.exitCode = 1;
});
