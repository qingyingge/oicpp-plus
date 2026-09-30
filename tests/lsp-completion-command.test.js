'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

// Minimal harness around MonacoEditorManager: extract the class source and give
// it just enough of a global surface to exercise command registration and the
// completion-item mapping that carries post-insert commands.
function loadManager() {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'renderer', 'js', 'monaco-editor-manager.js'),
        'utf8'
    );
    const start = source.indexOf('class MonacoEditorManager');
    if (start < 0) throw new Error('MonacoEditorManager class not found');
    const classSource = source.slice(start);

    const registeredCommands = new Map();
    const executedCommands = [];

    const fakeMonaco = {
        languages: {
            CompletionItemKind: { Text: 1 },
            CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
            SymbolKind: {},
            InlayHintKind: {}
        },
        editor: {
            registerCommand: (id, handler) => {
                registeredCommands.set(id, handler);
                return { dispose: () => registeredCommands.delete(id) };
            }
        },
        Uri: {
            parse: (value) => ({ value, toString: () => value })
        },
        Range: class {
            constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
                this.startLineNumber = startLineNumber;
                this.startColumn = startColumn;
                this.endLineNumber = endLineNumber;
                this.endColumn = endColumn;
            }
        },
        KeyMod: { CtrlCmd: 1 },
        KeyCode: { KeyG: 2 }
    };

    const context = {
        window: {
            electronAPI: {},
            i18n: { t: (key) => key }
        },
        document: {
            createElement: () => ({ style: {}, classList: { add() {} } }),
            body: {},
            addEventListener: () => {},
            removeEventListener: () => {},
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => []
        },
        monaco: fakeMonaco,
        console,
        setTimeout,
        clearTimeout,
        Map,
        Set,
        WeakMap,
        Promise,
        Object,
        Array,
        Number,
        String,
        Boolean,
        JSON,
        logInfo: () => {},
        logWarn: () => {},
        logError: () => {}
    };
    context.globalThis = context;

    vm.createContext(context);
    vm.runInContext(`${classSource}\nthis.__Manager = MonacoEditorManager;`, context);

    const manager = new context.__Manager();
    // Avoid running the real constructor's side effects against the fake window.
    manager._lspProviders = new Map();
    manager._lspCommandArguments = new Map();
    manager.lspClient = { request: async () => ({}) };

    return { manager, registeredCommands, executedCommands };
}

(async () => {
    const { manager, registeredCommands } = loadManager();

    // A completion item carrying a command (clangd auto-import style) must get
    // that command registered, otherwise accepting the suggestion silently
    // drops the follow-up workspace/executeCommand call.
    const itemWithCommand = {
        label: 'std::vector',
        kind: 6,
        command: {
            command: 'clangd.applyIncludeFix',
            title: 'add #include',
            arguments: ['file:///workspace/a.cpp', 3, 0]
        }
    };
    const mapped = manager._mapLspCompletionItem(itemWithCommand);
    check('completion: item with a command is still mapped', mapped?.label === 'std::vector');
    check('completion: post-insert command is registered in the command table',
        registeredCommands.has('clangd.applyIncludeFix'),
        `registered=${[...registeredCommands.keys()].join(',')}`);
    check('completion: command arguments are cached for execution',
        JSON.stringify(manager._lspCommandArguments.get('clangd.applyIncludeFix'))
            === JSON.stringify(['file:///workspace/a.cpp', 3, 0]));

    // Running the registered handler must round-trip through
    // workspace/executeCommand with the cached arguments.
    const sentRequests = [];
    manager.lspClient = {
        request: async (method, params) => {
            sentRequests.push({ method, params });
            return {};
        }
    };
    await registeredCommands.get('clangd.applyIncludeFix')();
    check('completion: registered command dispatches workspace/executeCommand',
        sentRequests.length === 1
        && sentRequests[0].method === 'workspace/executeCommand'
        && sentRequests[0].params.command === 'clangd.applyIncludeFix',
        `method=${sentRequests[0]?.method}`);
    check('execution: cached arguments are forwarded to the server',
        JSON.stringify(sentRequests[0]?.params?.arguments) === JSON.stringify(['file:///workspace/a.cpp', 3, 0]));

    // Items without a command must not create registrations or throw.
    const beforeCount = registeredCommands.size;
    const plain = manager._mapLspCompletionItem({ label: 'plain_symbol', kind: 1 });
    check('completion: item without a command maps cleanly', plain?.label === 'plain_symbol');
    check('completion: item without a command registers nothing', registeredCommands.size === beforeCount);

    // Empty labels are still dropped.
    check('completion: empty label is rejected', manager._mapLspCompletionItem({ label: '   ' }) === null);

    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.error('[FAIL] lsp-completion-command threw:', error?.stack || error);
    process.exitCode = 1;
});
