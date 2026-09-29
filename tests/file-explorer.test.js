'use strict';

// 文件管理器目录读取契约回归：P6
// - read-directory 只保留 invoke 一条路径（事件回传那套无调用方）
// - refresh() 合并同一批文件操作触发的连续目录重读

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.join(__dirname, '..');
const explorerSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'sidebar', 'fileExplorer.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');

// --- 静态契约：双份 handler 与遗留事件通道必须消失 -----------------------
check('P6 main keeps only the invoke read-directory handler',
    !/ipcMain\.on\(\s*'read-directory'/.test(mainSource) &&
    /ipcMain\.handle\(\s*'read-directory'/.test(mainSource));
check('P6 directory-read reply channels are gone',
    !mainSource.includes("'directory-read'") && !mainSource.includes("'directory-read-error'") &&
    !explorerSource.includes("'directory-read'") && !explorerSource.includes("'directory-read-error'"));
const whitelistBody = (name) => {
    const m = new RegExp(`${name}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(preloadSource);
    return m ? m[1] : '';
};
check('P6 preload no longer whitelists the removed read-directory send/event channels',
    !whitelistBody('ALLOWED_SEND_CHANNELS').includes('read-directory') &&
    !whitelistBody('ALLOWED_EVENT_CHANNELS').includes('directory-read') &&
    whitelistBody('ALLOWED_INVOKE_CHANNELS').includes('read-directory'));

const classStart = explorerSource.indexOf('const FILE_EXPLORER_REFRESH_DEBOUNCE_MS');
const classEnd = explorerSource.indexOf('\nif (typeof window', classStart);
if (classStart < 0 || classEnd < 0) {
    console.log('[FAIL] fileExplorer.js class not found');
    process.exit(1);
}

let readDirectoryCalls = 0;
let loadFilesCalls = 0;
const timers = [];
const context = {
    window: {
        electronAPI: {
            platform: '',
            readDirectory: () => {
                readDirectoryCalls++;
                return Promise.resolve([{ name: 'a.cpp', path: '/ws/a.cpp', isDirectory: false }]);
            }
        },
        i18n: { t: (key) => key }
    },
    document: { getElementById: () => null, querySelector: () => null, addEventListener: () => { } },
    navigator: { userAgent: 'test' },
    logInfo: () => { },
    logWarn: () => { },
    logError: () => { },
    setTimeout: (fn, ms) => {
        const timer = { fn, ms, cleared: false };
        timers.push(timer);
        return timer;
    },
    clearTimeout: (timer) => { if (timer) timer.cleared = true; }
};
vm.runInNewContext(`${explorerSource.slice(classStart, classEnd)}\nthis.__FileExplorer = FileExplorer;`, context);

(async () => {
    const explorer = Object.create(context.__FileExplorer.prototype);
    explorer._directoryReadRequests = new Map();
    explorer._refreshTimer = null;
    explorer.currentPath = '/ws';
    explorer.expandedFolders = new Set();
    explorer._treeItemsByPath = new Map();
    explorer.files = [];
    explorer.loadFiles = () => { loadFilesCalls++; };

    // 同一 tick 内连续 5 次 refresh 只应产生一次 loadFiles
    explorer.refresh();
    explorer.refresh();
    explorer.refresh();
    explorer.refresh();
    explorer.refresh();
    check('P6 refresh is debounced instead of reloading per call', loadFilesCalls === 0 && timers.length === 5);
    const pending = timers.filter((t) => !t.cleared);
    check('P6 only the last refresh timer survives', pending.length === 1, `pending=${pending.length}`);
    pending[0].fn();
    check('P6 the merged refresh runs exactly one reload', loadFilesCalls === 1, `loadFiles=${loadFilesCalls}`);

    // 合并窗口之外再次 refresh 仍会正常触发
    explorer.refresh();
    const next = timers.filter((t) => !t.cleared);
    next[next.length - 1].fn();
    check('P6 later refresh still reloads', loadFilesCalls === 2, `loadFiles=${loadFilesCalls}`);

    // 目录读取仍然可用且并发同路径只发一次
    const [first, second] = await Promise.all([
        explorer._readDirectory('/ws'),
        explorer._readDirectory('/ws')
    ]);
    check('P6 readDirectory still resolves through electronAPI',
        readDirectoryCalls === 1 && first.length === 1 && first[0].name === 'a.cpp' && second === first,
        `calls=${readDirectoryCalls}`);

    // 渲染层不得再退回 send + 事件回传那套路径
    const readBlock = /_readDirectory\(dirPath\) \{[\s\S]*?\n    \}/.exec(explorerSource);
    check('P6 _readDirectory has a single invoke-based path',
        !!readBlock && !readBlock[0].includes('electronIPC') && readBlock[0].includes('electronAPI.readDirectory'));

    console.log(`file-explorer regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
    process.exit(failures ? 1 : 0);
})().catch((error) => {
    console.log(`[FAIL] file-explorer unexpected error | ${error?.stack || error?.message || error}`);
    process.exit(1);
});
