'use strict';

/**
 * Single source of truth for settings keys / whitelists.
 *
 * Previously the whitelist was duplicated in 4 places in src/main.js:
 *   - loadSettings  (main.js, was line ~7903)
 *   - mergeSettings (main.js, was line ~8006)
 *   - updateSettings (main.js, was line ~8047)
 *   - SETTINGS_WRITABLE_KEYS (main.js, was line ~10455)
 *
 * SETTINGS_KEYS        = every persisted setting key (read + write), used by
 *                        loadSettings / mergeSettings to filter what is loaded
 *                        from disk / merged.
 * SETTINGS_WRITABLE_KEYS = keys the renderer is allowed to write, used by
 *                        updateSettings / save-setting to guard writes.
 *
 * Pure module (CommonJS). Main process only.
 */

const SETTINGS_KEYS = [
    'compilerPath', 'pythonInterpreterPath', 'compilerArgs', 'runMode', 'testlibPath',
    'font', 'fontSize', 'terminalFontSize', 'terminalStartupCommand', 'syntaxCheckEnabled',
    'lineHeight', 'theme', 'syntaxColorsByTheme', 'syntaxFontStyles', 'unifiedPreprocessorColor',
    'syntaxColors', 'tabSize', 'formatterIndentStyle', 'clangFormatStyle', 'clangFormatRaw',
    'fontLigaturesEnabled', 'enableAutoCompletion', 'foldingEnabled', 'stickyScrollEnabled',
    'autoSave', 'autoSaveInterval', 'language', 'autoBackupSettings', 'receiveBetaUpdates',
    'markdownMode', 'cppTemplate', 'codeSnippets', 'lastOpen', 'recentFiles', 'fileHistory',
    'lastOpenTabs', 'lastUpdateCheck', 'pendingUpdate', 'postInstallNotice', 'windowOpacity',
    'glassEffectEnabled', 'backgroundImage', 'keybindings', 'autoOpenLastWorkspace', 'runAllSamples'
];

const SETTINGS_WRITABLE_KEYS = [
    'compilerPath', 'pythonInterpreterPath', 'compilerArgs', 'runMode', 'testlibPath',
    'font', 'fontSize', 'terminalFontSize', 'terminalStartupCommand', 'syntaxCheckEnabled',
    'lineHeight', 'theme', 'syntaxColorsByTheme', 'syntaxFontStyles', 'unifiedPreprocessorColor',
    'syntaxColors', 'enableAutoCompletion', 'foldingEnabled', 'stickyScrollEnabled',
    'fontLigaturesEnabled', 'cppTemplate', 'tabSize', 'formatterIndentStyle',
    'clangFormatStyle', 'clangFormatRaw', 'autoSave', 'autoSaveInterval',
    'codeSnippets', 'windowOpacity', 'glassEffectEnabled', 'backgroundImage', 'markdownMode',
    'keybindings', 'fileHistory', 'lastOpenTabs', 'autoOpenLastWorkspace', 'language',
    'autoBackupSettings', 'receiveBetaUpdates', 'runAllSamples'
];

const SETTINGS_MERGE_KEYS = SETTINGS_WRITABLE_KEYS.filter((key) => key !== 'fileHistory' && key !== 'lastOpenTabs');

module.exports = {
    SETTINGS_KEYS,
    SETTINGS_WRITABLE_KEYS,
    SETTINGS_MERGE_KEYS,
    SETTINGS_WRITABLE_KEYS_SET: new Set(SETTINGS_WRITABLE_KEYS),
    SETTINGS_KEYS_SET: new Set(SETTINGS_KEYS)
};