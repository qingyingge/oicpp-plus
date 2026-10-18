'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const utils = require(path.join(__dirname, '..', 'src', 'renderer', 'js', 'lsp-utils.js'));

// 挂死不等于通过：await 一个永不 settle 的 promise 时，Node 带着 0 退出码排空
// event loop，runner 只看 status 和 [FAIL] 行数 —— 后半截断言一条不发也算过。
// 这些文件收尾写 process.exitCode 而不是 process.exit，所以定时器必须具名，
// 并在每个收尾点显式 clearTimeout，否则正常跑完会被它多留 60s 再判红。
const watchdog = setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：某个 await 永不 settle（异步守卫没被驱动完）');
    process.exit(1);
}, 60000);

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

const location = utils.toMonacoLocation({
    targetUri: 'file:///workspace/header.hpp',
    targetRange: {
        start: { line: 4, character: 2 },
        end: { line: 4, character: 20 }
    },
    targetSelectionRange: {
        start: { line: 4, character: 8 },
        end: { line: 4, character: 14 }
    },
    originSelectionRange: {
        start: { line: 1, character: 3 },
        end: { line: 1, character: 9 }
    }
}, monaco);

check('LocationLink uses targetSelectionRange', location?.range?.startLineNumber === 5 && location?.range?.startColumn === 9 && location?.range?.endColumn === 15);
check('LocationLink keeps target URI', location?.uri?.value === 'file:///workspace/header.hpp');
check('LocationLink keeps origin range', location?.originSelectionRange?.startLineNumber === 2);

const plainLocation = utils.toMonacoLocation({
    uri: 'file:///workspace/main.cpp',
    range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 5 }
    }
}, monaco);
check('Location format remains supported', plainLocation?.uri?.value === 'file:///workspace/main.cpp' && plainLocation?.range?.endColumn === 6);

const workspaceEdit = utils.toMonacoWorkspaceEdit({
    changes: {
        'file:///workspace/main.cpp': [{
            range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 }
            },
            newText: 'x'
        }]
    },
    documentChanges: [{
        textDocument: {
            uri: 'file:///workspace/other.cpp',
            version: 7
        },
        edits: [{
            range: {
                start: { line: 2, character: 1 },
                end: { line: 2, character: 4 }
            },
            newText: 'value'
        }]
    }]
}, monaco);

check('WorkspaceEdit converts changes', workspaceEdit?.edits?.some((edit) => edit.resource.value.endsWith('main.cpp') && edit.textEdit.text === 'x'));
check('WorkspaceEdit converts documentChanges', workspaceEdit?.edits?.some((edit) => edit.resource.value.endsWith('other.cpp') && edit.versionId === 7));
check('WorkspaceEdit uses Monaco textEdit shape', workspaceEdit?.edits?.every((edit) => edit.textEdit && edit.textEdit.range instanceof FakeRange));

const semanticDelta = utils.applySemanticTokenEdits(
    new Uint32Array([1, 2, 3, 4]),
    [{ start: 1, deleteCount: 2, data: [8, 9] }]
);
check('semantic token delta replaces encoded values', semanticDelta instanceof Uint32Array && Array.from(semanticDelta).join(',') === '1,8,9,4');
check('semantic token delta accepts insertion-only edits', Array.from(utils.applySemanticTokenEdits([1], [{ start: 1, deleteCount: 0, data: [2, 3] }])).join(',') === '1,2,3');
check('semantic token delta applies multiple edits from the end', Array.from(utils.applySemanticTokenEdits([1, 2, 3, 4], [
    { start: 1, deleteCount: 1, data: [8, 9] },
    { start: 3, deleteCount: 1, data: [7] }
])).join(',') === '1,8,9,3,7');

(async () => {
    let resolveRequest;
    const requestPromise = new Promise((resolve) => {
        resolveRequest = resolve;
    });
    let cancelledRequestId = null;
    const electronAPI = {
        lspRequest: () => requestPromise,
        lspCancel: (requestId) => {
            cancelledRequestId = requestId;
            return Promise.resolve({ ok: true });
        },
        onLspNotification: () => { }
    };
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'lsp-client.js'), 'utf8');
    const context = {
        window: { electronAPI },
        logInfo: () => { },
        logWarn: () => { },
        logError: () => { }
    };
    vm.runInNewContext(`${source}\nthis.__LspClientBridge = LspClientBridge;`, context);
    const bridge = new context.__LspClientBridge();
    bridge._serverCapabilities = {
        textDocument: {
            hoverProvider: true,
            completionProvider: false
        }
    };
    check('server capability lookup follows nested paths', bridge.supportsCapability('textDocument.hoverProvider') === true && bridge.supportsCapability('textDocument.completionProvider') === false);

    let cancelListener = null;
    const token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener) => {
            cancelListener = listener;
            return { dispose: () => { } };
        }
    };
    const request = bridge.request('textDocument/hover', {}, token);
    check('bridge assigns renderer request ids', typeof cancelListener === 'function');
    cancelListener();
    try {
        await request;
        check('cancelled bridge request rejects', false);
    } catch (error) {
        check('cancelled bridge request rejects', /cancelled/i.test(error.message));
    }
    check('bridge sends cancellation for request id', cancelledRequestId === 'oicpp-renderer-1');
    resolveRequest({});
    clearTimeout(watchdog);
    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.log(`[FAIL] LSP bridge async test | ${error?.message || error}`);
    clearTimeout(watchdog);
    process.exitCode = 1;
});
