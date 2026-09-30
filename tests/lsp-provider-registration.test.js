'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const managerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'js', 'monaco-editor-manager.js'),
    'utf8'
);

function loadManagerClass(records) {
    const start = managerSource.indexOf('class MonacoEditorManager');
    if (start < 0) throw new Error('MonacoEditorManager class not found');
    const classSource = managerSource.slice(start);

    const context = {
        window: { electronAPI: {}, i18n: { t: (key) => key } },
        document: {
            createElement: () => ({ style: {}, classList: { add() {} } }),
            body: {},
            addEventListener: () => {},
            removeEventListener: () => {},
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => []
        },
        monaco: {
            languages: { CompletionItemKind: {}, SymbolKind: {}, InlayHintKind: {} },
            editor: { registerCommand: () => ({ dispose() {} }) },
            Uri: { parse: (v) => ({ value: v, toString: () => v }) },
            Range: class { constructor(a, b, c, d) { Object.assign(this, { a, b, c, d }); } },
            KeyMod: {}, KeyCode: {}
        },
        console,
        setTimeout,
        clearTimeout,
        Map, Set, WeakMap, Promise, Object, Array, Number, String, Boolean, JSON,
        logInfo: (...args) => records.push({ level: 'info', text: args.join(' ') }),
        logWarn: (...args) => records.push({ level: 'warn', text: args.join(' ') }),
        logError: (...args) => records.push({ level: 'error', text: args.join(' ') })
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${classSource}\nthis.__Manager = MonacoEditorManager;`, context);
    return context.__Manager;
}

// Every LSP provider entry point, so the test can observe which ones ran.
const PROVIDER_METHODS = [
    '_registerLspCompletionProvider',
    '_registerLspSignatureHelpProvider',
    '_registerLspHoverProvider',
    '_registerLspDefinitionProvider',
    '_registerLspDocumentSymbolProvider',
    '_registerLspLocationProviders',
    '_registerLspReferencesProvider',
    '_registerLspRenameProvider',
    '_registerLspInlayHintProvider',
    '_registerLspSelectionRangeProvider',
    '_registerLspDocumentLinkProvider',
    '_registerLspCodeActionProvider',
    '_registerLspTypeDefinitionProvider',
    '_registerLspImplementationProvider',
    '_registerLspDocumentHighlightProvider',
    '_registerLspWorkspaceSymbolProvider',
    '_registerLspCodeLensProvider',
    '_registerLspFoldingRangeProvider'
];

function makeManager(Manager, capabilities) {
    const manager = new Manager();
    manager._lspProviders = new Map();
    manager._lspCommandArguments = new Map();
    manager._lspProvidersReady = false;
    manager._registerLocalCompletionProvider = () => {};
    const calls = [];
    for (const name of PROVIDER_METHODS) {
        manager[name] = () => calls.push(name);
    }
    manager.lspClient = {
        getServerCapabilities: () => capabilities,
        supportsCapability: (capabilityPath, fallback = false) => {
            let value = capabilities;
            for (const part of capabilityPath.split('.')) {
                if (value === null || value === undefined) return fallback;
                value = value[part];
            }
            if (value === null || value === undefined) return fallback;
            return !!value;
        }
    };
    return { manager, calls };
}

// Real clangd 23.1.0 ServerCapabilities are FLAT at the top level.
// (Client capabilities are the nested ones; querying "textDocument.hoverProvider"
// against server capabilities always yields undefined and silently disables
// every provider.) Key list captured from a live initialize handshake.
const REAL_CLANGD_CAPABILITY_KEYS = [
    'astProvider', 'callHierarchyProvider', 'clangdInlayHintsProvider', 'codeActionProvider',
    'compilationDatabase', 'completionProvider', 'declarationProvider', 'definitionProvider',
    'documentFormattingProvider', 'documentHighlightProvider', 'documentLinkProvider',
    'documentOnTypeFormattingProvider', 'documentRangeFormattingProvider', 'documentSymbolProvider',
    'executeCommandProvider', 'foldingRangeProvider', 'hoverProvider', 'implementationProvider',
    'inactiveRegionsProvider', 'inlayHintProvider', 'memoryUsageProvider', 'positionEncoding',
    'referencesProvider', 'renameProvider', 'selectionRangeProvider', 'semanticTokensProvider',
    'signatureHelpProvider', 'standardTypeHierarchyProvider', 'textDocumentSync',
    'typeDefinitionProvider', 'typeHierarchyProvider', 'workspaceSymbolProvider'
];

const FULL_CAPS = {
    textDocumentSync: { openClose: true, change: 2 },
    completionProvider: { triggerCharacters: ['.', '<', '>', ':', '"', '/', '*'], resolveProvider: false },
    signatureHelpProvider: {},
    hoverProvider: true,
    definitionProvider: true,
    documentSymbolProvider: true,
    declarationProvider: true,
    referencesProvider: true,
    renameProvider: { prepareProvider: true },
    documentFormattingProvider: true,
    documentRangeFormattingProvider: true,
    inlayHintProvider: {},
    selectionRangeProvider: true,
    documentLinkProvider: {},
    codeActionProvider: { codeActionKinds: ['quickfix', 'refactor', 'info'] },
    typeDefinitionProvider: true,
    implementationProvider: true,
    documentHighlightProvider: true,
    foldingRangeProvider: true,
    semanticTokensProvider: { full: { delta: true } },
    workspaceSymbolProvider: true,
    executeCommandProvider: { commands: ['clangd.applyFix', 'clangd.applyRename', 'clangd.applyTweak'] }
    // NOTE: clangd advertises no codeLensProvider.
};

(async () => {
    // 1) Capabilities not yet received: defer instead of silently registering nothing.
    {
        const records = [];
        const Manager = loadManagerClass(records);
        const { manager, calls } = makeManager(Manager, null);

        manager.registerAllLspProviders();

        check('registration: no provider is registered before capabilities arrive', calls.length === 0,
            `calls=${calls.length}`);
        check('registration: readiness flag stays false so a later call can retry',
            manager._lspProvidersReady === false);
        check('registration: the wait is logged for diagnosis',
            records.some((entry) => entry.level === 'info' && entry.text.includes('等待服务端能力')));
    }

    // 2) Capabilities present: everything the server advertises gets registered.
    //    Real clangd advertises no codeLensProvider, so 17 of 18 is the correct outcome.
    {
        const EXPECTED = PROVIDER_METHODS.length - 1;
        const records = [];
        const Manager = loadManagerClass(records);
        const { manager, calls } = makeManager(Manager, FULL_CAPS);

        manager.registerAllLspProviders();

        check('registration: all advertised providers are registered',
            calls.length === EXPECTED,
            `registered=${calls.length}/${EXPECTED}`);
        check('registration: readiness flag is set once registration completes',
            manager._lspProvidersReady === true);
        check('registration: the log names the providers that were registered',
            records.some((entry) => entry.text.includes('已注册') && entry.text.includes('补全')));
    }

    // 3) A provider that throws must not cancel the rest.
    {
        const EXPECTED = PROVIDER_METHODS.length - 2; // codeLens unsupported + hover throws
        const records = [];
        const Manager = loadManagerClass(records);
        const { manager, calls } = makeManager(Manager, FULL_CAPS);
        manager._registerLspHoverProvider = () => { throw new Error('boom'); };

        manager.registerAllLspProviders();

        check('registration: a throwing provider does not abort the others',
            calls.length === EXPECTED,
            `registered=${calls.length}/${EXPECTED}`);
        check('registration: the failure is reported instead of being swallowed',
            records.some((entry) => entry.level === 'warn' && entry.text.includes('注册提供器失败')));
        check('registration: readiness flag is still set so features are usable',
            manager._lspProvidersReady === true);
    }

    // 4) Server without a capability: that one is skipped and reported, others still work.
    {
        const records = [];
        const Manager = loadManagerClass(records);
        const partial = { ...FULL_CAPS };
        const { manager, calls } = makeManager(Manager, partial);

        manager.registerAllLspProviders();

        // clangd genuinely has no codeLensProvider, so it must be the only skip.
        check('registration: clangd has no codeLensProvider so it is skipped',
            !calls.includes('_registerLspCodeLensProvider'));
        check('registration: every other advertised provider still registers',
            calls.length === PROVIDER_METHODS.length - 1,
            `registered=${calls.length}/${PROVIDER_METHODS.length}`);
        check('registration: the skipped capability is named in the log',
            records.some((entry) => entry.text.includes('未注册') && entry.text.includes('代码透镜')));
    }

    // 6) Guard against reintroducing the client-side "textDocument." nesting.
    //    Every path the code queries must exist as a real top-level server key.
    {
        const usedPaths = [...managerSource.matchAll(/register\('[^']*',\s*'([^']+)'/g)].map((m) => m[1]);
        check('registration: capability paths are flat server keys, not client-side paths',
            usedPaths.length === 18 && usedPaths.every((p) => !p.startsWith('textDocument.') && !p.startsWith('workspace.')),
            `paths=${usedPaths.filter((p) => p.startsWith('textDocument.') || p.startsWith('workspace.')).join(',') || 'none'}`);
        const unknown = usedPaths.filter((p) => !REAL_CLANGD_CAPABILITY_KEYS.includes(p) && p !== 'codeLensProvider');
        check('registration: every queried path is a key real clangd advertises',
            unknown.length === 0, `unknown=${unknown.join(',')}`);
    }

    // 5) Second call after success is a no-op (no duplicate provider registration).
    {
        const records = [];
        const Manager = loadManagerClass(records);
        const { manager, calls } = makeManager(Manager, FULL_CAPS);

        manager.registerAllLspProviders();
        const afterFirst = calls.length;
        manager.registerAllLspProviders();

        check('registration: repeat calls do not re-register providers', calls.length === afterFirst,
            `first=${afterFirst} second=${calls.length}`);
    }

    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.error('[FAIL] lsp-provider-registration threw:', error?.stack || error);
    process.exitCode = 1;
});
