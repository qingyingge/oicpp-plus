'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const utils = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'lsp-utils.js'));

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

class FakeRange {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
        this.startLineNumber = startLineNumber;
        this.startColumn = startColumn;
        this.endLineNumber = endLineNumber;
        this.endColumn = endColumn;
    }
}

const monaco = {
    Range: FakeRange,
    Uri: {
        parse: (value) => ({ value })
    }
};

function createBridge(overrides = {}) {
    const calls = {
        requests: [],
        cancels: [],
        applyResults: []
    };
    let applyHandler = null;
    let notificationHandler = null;
    const electronAPI = {
        lspRequest: (...args) => {
            calls.requests.push(args);
            return overrides.lspRequest ? overrides.lspRequest(...args) : Promise.resolve({ ok: true });
        },
        lspCancel: (requestId) => {
            calls.cancels.push(requestId);
            return Promise.resolve({ ok: true });
        },
        lspApplyEditResult: (requestId, result) => {
            calls.applyResults.push({ requestId, result });
            return Promise.resolve({ ok: true });
        },
        onLspApplyEdit: (handler) => {
            applyHandler = handler;
        },
        onLspNotification: (handler) => {
            notificationHandler = handler;
        }
    };
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'lsp-client.js'), 'utf8');
    const context = {
        window: {
            electronAPI,
            i18n: { t: (key) => key }
        },
        logInfo: () => {},
        logWarn: () => {},
        logError: () => {}
    };
    vm.runInNewContext(`${source}\nthis.__LspClientBridge = LspClientBridge;`, context);
    return {
        bridge: new context.__LspClientBridge(),
        calls,
        getApplyHandler: () => applyHandler,
        getNotificationHandler: () => notificationHandler
    };
}

(async () => {
    // Pure conversion contracts: these are safe to lock down while provider work continues.
    const location = utils.toMonacoLocation({
        targetUri: 'file:///workspace/header.hpp',
        targetRange: {
            start: { line: 4, character: 2 },
            end: { line: 4, character: 20 }
        },
        targetSelectionRange: {
            start: { line: 4, character: 8 },
            end: { line: 4, character: 14 }
        }
    }, monaco);
    check('audit: LocationLink prefers targetSelectionRange', location?.range?.startColumn === 9 && location?.range?.endColumn === 15);

    const workspaceEdit = utils.toMonacoWorkspaceEdit({
        documentChanges: [
            {
                textDocument: { uri: 'file:///workspace/a.cpp', version: 3 },
                edits: [{
                    range: {
                        start: { line: 0, character: 0 },
                        end: { line: 0, character: 1 }
                    },
                    newText: 'x'
                }]
            },
            {
                textDocument: { uri: 'file:///workspace/missing.cpp', version: 1 },
                edits: []
            }
        ]
    }, monaco);
    check('audit: WorkspaceEdit preserves document version', workspaceEdit?.edits?.[0]?.versionId === 3);
    check('audit: WorkspaceEdit ignores malformed document changes', workspaceEdit?.edits?.length === 1);

    const semanticDelta = utils.applySemanticTokenEdits(
        new Uint32Array([1, 2, 3, 4, 5]),
        [
            { start: 1, deleteCount: 1, data: [8] },
            { start: 3, deleteCount: 1, data: [9] }
        ]
    );
    check('audit: semantic delta applies edits from the end', Array.from(semanticDelta).join(',') === '1,8,3,9,5');

    // Renderer bridge contracts.
    let resolveRequest;
    const deferredRequest = new Promise((resolve) => { resolveRequest = resolve; });
    const harness = createBridge({
        lspRequest: () => deferredRequest
    });
    const bridge = harness.bridge;
    check('audit: capability lookup follows nested paths', bridge.supportsCapability?.('textDocument.hoverProvider', false) === false);

    let cancellationListener = null;
    const token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener) => {
            cancellationListener = listener;
            return { dispose: () => { cancellationListener = null; } };
        }
    };
    const pending = bridge.request('textDocument/hover', {}, token);
    check('audit: renderer assigns a request id', harness.calls.requests[0]?.[2] === 'oicpp-renderer-1');
    cancellationListener?.();
    try {
        await pending;
        check('audit: cancelled renderer request rejects', false);
    } catch (error) {
        check('audit: cancelled renderer request rejects', /cancelled/i.test(error?.message || ''));
    }
    check('audit: renderer forwards cancellation id', harness.calls.cancels[0] === 'oicpp-renderer-1');
    resolveRequest({ ok: true });

    const eventHarness = createBridge();
    let diagnosticEvent = null;
    const removeDiagnosticListener = eventHarness.bridge.onDiagnostics((uri, diagnostics) => {
        diagnosticEvent = { uri, diagnostics };
    });
    eventHarness.getNotificationHandler()?.({
        method: 'textDocument/publishDiagnostics',
        params: { uri: 'file:///workspace/a.cpp', diagnostics: [{ severity: 1 }] }
    });
    check('audit: diagnostics notification is delivered', diagnosticEvent?.uri === 'file:///workspace/a.cpp' && diagnosticEvent?.diagnostics?.length === 1);
    removeDiagnosticListener();
    eventHarness.getNotificationHandler()?.({
        method: 'textDocument/publishDiagnostics',
        params: { uri: 'file:///workspace/b.cpp', diagnostics: [] }
    });
    check('audit: diagnostics listener can be removed', diagnosticEvent?.uri === 'file:///workspace/a.cpp');

    let applyListenerCalled = false;
    eventHarness.bridge.onApplyEdit(async () => {
        applyListenerCalled = true;
        return { applied: true };
    });
    await eventHarness.getApplyHandler()?.({ requestId: 'apply-1', edit: { changes: {} } });
    check('audit: applyEdit result is returned to main process', applyListenerCalled && eventHarness.calls.applyResults[0]?.requestId === 'apply-1');

    const preCancelled = createBridge();
    const alreadyCancelled = {
        isCancellationRequested: true,
        onCancellationRequested: () => ({ dispose: () => {} })
    };
    try {
        await preCancelled.bridge.request('textDocument/hover', {}, alreadyCancelled);
        check('audit: pre-cancelled request is rejected', false);
    } catch (error) {
        check('audit: pre-cancelled request is rejected', /cancelled/i.test(error?.message || ''));
    }
    check('audit: pre-cancelled request does not cross IPC', preCancelled.calls.requests.length === 0);

    console.log(`[INFO] lsp-audit completed: ${failures ? failures + ' failure(s)' : 'all executable contracts passed'}`);
    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.log(`[FAIL] lsp-audit unexpected error | ${error?.stack || error?.message || error}`);
    process.exitCode = 1;
});
