'use strict';

// 文件管理器目录读取契约回归：P6
// - read-directory 只保留 invoke 一条路径（事件回传那套无调用方）
// - refresh() 合并同一批文件操作触发的连续目录重读

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { callStatement, classMethod } = require('./fixtures/source-extract');

// 挂死不等于通过：某个 await 永不 settle 时 Node 会以 0 退出码排空 event loop，
// 后半截断言一条不发也「全绿」。留一个不 unref 的定时器把「跑不完」顶成失败。
setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：某个 await 永不 settle（异步守卫没被驱动完）');
    process.exit(1);
}, 60000);

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
// 把 main 里所有 ipcMain 注册扫成「通道 → 注册方式」表，再按表比对：
// 窗口正则会跟着排版漂，表里的一个通道只有一条注册方式这种事实不会。
const scan = (src, re) => {
    const table = new Map();
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
        const modes = table.get(m[2]) || [];
        modes.push(m[1]);
        table.set(m[2], modes);
    }
    return table;
};
const mainRegs = scan(mainSource, /ipcMain\s*\.\s*(on|once|handle)\s*\(\s*['"`]([^'"`]+)['"`]/g);
const rendererRegs = scan(explorerSource, /\w+\s*\.\s*(on|once|removeListener)\s*\(\s*['"`]([^'"`]+)['"`]/g);
const mainSends = scan(mainSource, /(\.send)\s*\(\s*['"`]([^'"`]+)['"`]/g);
check(`通道注册表扫出来了（空表就是抽取失败，别真空通过）: main=${mainRegs.size}`, mainRegs.size > 0);
check('P6 main keeps only the invoke read-directory handler',
    JSON.stringify(mainRegs.get('read-directory') || null) === '["handle"]',
    JSON.stringify(mainRegs.get('read-directory')));
check('P6 directory-read reply channels are gone',
    !mainRegs.has('directory-read') && !mainRegs.has('directory-read-error') &&
    !mainSends.has('directory-read') && !mainSends.has('directory-read-error') &&
    !rendererRegs.has('directory-read') && !rendererRegs.has('directory-read-error'),
    [...mainRegs.keys(), ...mainSends.keys()].filter((c) => c.includes('directory-read')).join(','));

// 真把那条注册语句执行一遍：handler 拿到的第二个实参才是路径，异常要照原样抛回渲染层
const readDirStmt = callStatement(mainSource, /^\s*ipcMain\.handle\(\s*'read-directory'/m);
check('注册语句抽取成功: read-directory', readDirStmt.length > 0, readDirStmt.slice(0, 60));
const dirHandlers = [];
const dirStub = {
    handle: (ch, fn) => { dirHandlers.push({ mode: 'handle', ch, fn }); },
    on: (ch, fn) => { dirHandlers.push({ mode: 'on', ch, fn }); }
};
const readDirLogs = [];
const ENTRIES = [{ name: 'a.cpp' }];
const boom = new Error('EIO: read failed');
const readDirArgs = [];
new Function('ipcMain', 'readDirectory', 'logError', readDirStmt)(
    dirStub,
    (p) => {
        readDirArgs.push(p);
        return p === '/bad' ? Promise.reject(boom) : Promise.resolve(ENTRIES);
    },
    (...a) => { readDirLogs.push(a); });
const readDirHandler = dirHandlers.length === 1 ? dirHandlers[0].fn : null;
check('P6 抽出的语句确实只注册了一个 read-directory handler',
    dirHandlers.length === 1 && dirHandlers[0].mode === 'handle' &&
    dirHandlers[0].ch === 'read-directory',
    JSON.stringify(dirHandlers.map((r) => `${r.mode}:${r.ch}`)));
const readDirOk = readDirHandler ? readDirHandler({}, '/ws') : Promise.resolve('NO HANDLER');
const readDirBad = readDirHandler ? readDirHandler({}, '/bad') : Promise.resolve('NO HANDLER');
const whitelistBody = (name) => {
    const m = new RegExp(`${name}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(preloadSource);
    return m ? m[1] : '';
};
// 三个名单都得真的抽到，否则下面的否定断言会在空串上真空通过
for (const name of ['ALLOWED_SEND_CHANNELS', 'ALLOWED_EVENT_CHANNELS', 'ALLOWED_INVOKE_CHANNELS']) {
    check(`白名单抽取成功: ${name}`, whitelistBody(name).length > 0);
}
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
    // read-directory handler 的行为：路径取第二个实参、结果原样返回、异常记日志后原样抛回
    check('P6 read-directory handler 按 invoke 语义返回目录条目，且路径传给 readDirectory',
        (await readDirOk) === ENTRIES && JSON.stringify(readDirArgs) === '["/ws","/bad"]',
        JSON.stringify({ got: await readDirOk === ENTRIES, readDirArgs }));
    let dirThrown = null;
    try { await readDirBad; } catch (e) { dirThrown = e; }
    check('P6 read-directory handler 不吞异常（渲染层要能看见失败），失败要记日志',
        dirThrown !== null && String(dirThrown.message) === 'EIO: read failed' &&
        readDirLogs.length === 1,
        JSON.stringify({ err: String(dirThrown && dirThrown.message), logs: readDirLogs.length }));

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
    const readBlock = classMethod(explorerSource, '_readDirectory');
    check('方法体抽取成功: _readDirectory', readBlock.length > 0);
    // 只锁语义：走 electronAPI.readDirectory（点号或中括号访问都算），且不再碰 electronIPC。
    // 锁死 `electronAPI.readDirectory` 字面量会在 tsc emit 把点号改写成中括号时误报。
    check('P6 _readDirectory has a single invoke-based path',
        !readBlock.includes('electronIPC') && /electronAPI\s*(?:\?\.|\.|\[\s*['"])readDirectory/.test(readBlock),
        readBlock.replace(/\s+/g, ' ').slice(0, 80));

    console.log(`file-explorer regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
    process.exit(failures ? 1 : 0);
})().catch((error) => {
    console.log(`[FAIL] file-explorer unexpected error | ${error?.stack || error?.message || error}`);
    process.exit(1);
});
