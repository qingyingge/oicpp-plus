'use strict';

// 覆盖 1ba6870（四个必然触发的 P0）与 6ddac59（tabs 身份错位）。
// 下载器部分用真实 HTTP 服务器 + 可控故障注入，验证 retryCount 真的生效，
// 而不是只检查源码里有没有那行 await。
// cloudSync / tabs / 调试变量渲染三段原先全是「源码里有没有这行」的文本锁：
// tsc printer 一拆行就误报，语义真错了却照样绿。现在改成把方法体抽出来重建、
// 喂桩 this 真调用，断言的是请求序列、缓存搬迁和转义后的 HTML 正文。

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { classMethod, funcDecl, toFn } = require('./fixtures/source-extract');

global.logInfo = () => { };
global.logWarn = () => { };
global.logError = () => { };

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, '..');
const Downloader = require(path.join(ROOT, 'src', 'utils', 'multi-thread-downloader.js'));
const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const compileMgrSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'compile-manager.js'), 'utf8');
const cloudSyncSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'sidebar', 'cloudSync.js'), 'utf8');
const tabsSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'tabs.js'), 'utf8');
const rendererMainSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'main.js'), 'utf8');

// 这个文件有一半守卫是「源码里不该再出现 X」的负向正则，而 `!/x/.test('')` 恒真 ——
// 一旦某个文件读出来是空的（改名、被 .ts 取代、构建产物缺失），全部负向守卫会集体真空通过。
// 先把「读到了东西」这件事本身钉死，后面的 !/…/ 才有意义。
check('main.js 读到了内容', mainSource.length > 20000, `len=${mainSource.length}`);
check('preload.js 读到了内容', preloadSource.length > 2000, `len=${preloadSource.length}`);
check('compile-manager.js 读到了内容', compileMgrSource.length > 5000, `len=${compileMgrSource.length}`);
check('cloudSync.js 读到了内容', cloudSyncSource.length > 5000, `len=${cloudSyncSource.length}`);
check('tabs.js 读到了内容', tabsSource.length > 20000, `len=${tabsSource.length}`);
check('renderer main.js 读到了内容', rendererMainSource.length > 20000, `len=${rendererMainSource.length}`);

// await 一个永不 settle 的 promise 时，事件循环抽干后 Node 静默以 0 退出，
// 后面的断言一条不发也「全绿」。这里既有真 HTTP 服务器又有真 promise 链，
// 所以留一个不 unref 的看门狗：只有主流程半途挂死才会等到它。
setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：某个 await 永不 settle（下载/读取的假件没被驱动）');
    process.exit(1);
}, 60000);

// ===========================================================================
// P0-3：分片重试真的生效（return await）+ 取消错误不被洗成普通失败
// ===========================================================================

const CHUNK = 1024 * 1024;
const SIZE = 4 * 1024 * 1024;
const payload = crypto.randomBytes(SIZE);
const payloadMd5 = crypto.createHash('md5').update(payload).digest('hex');

// 故障注入开关
let flakyRange = null;   // Set<"start-end">：这些分片第一次请求时中途断流
let flakySeen = null;    // Set：记录已被打断过的分片，用于验证重试真的发生了
let rangeSupport = true;
let injections = 0;      // 实际断流次数，用来证明故障真的注入过（否则重试断言是空的）

const server = http.createServer((req, res) => {
    const rh = req.headers.range;
    const m = rh ? /bytes=(\d+)-(\d+)/.exec(rh) : null;

    if (rangeSupport && m) {
        const start = +m[1];
        const end = Math.min(+m[2], SIZE - 1);
        const slice = payload.subarray(start, end + 1);
        const key = `${start}-${end}`;

        if (flakyRange && flakyRange.has(key) && !flakySeen.has(key)) {
            // 发一半就断开：制造流式错误（HTTP 仍是 206，内容不完整）
            flakySeen.add(key);
            injections++;
            res.writeHead(206, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(slice.length),
                'Content-Range': `bytes ${start}-${end}/${SIZE}`,
                'Accept-Ranges': 'bytes'
            });
            res.write(slice.subarray(0, Math.floor(slice.length / 2)));
            // 必须延后再掐：同一 tick 里 destroy 会让客户端连响应回调都没跑到，
            // 错误从 makeRequest 冒出而不是从 body 流冒出，于是「缺 await」这种
            // 只影响 body 路径的变异根本测不出来（实测 D1 变异照样全绿）
            setTimeout(() => res.destroy(), 50);
            return;
        }

        res.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(slice.length),
            'Content-Range': `bytes ${start}-${end}/${SIZE}`,
            'Accept-Ranges': 'bytes'
        });
        res.end(slice);
        return;
    }

    const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(SIZE),
        'Accept-Ranges': rangeSupport ? 'bytes' : 'none'
    };
    if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
    res.writeHead(200, headers);
    res.end(payload);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-p0-'));
const md5Of = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // ---- P0-3 行为验证：流式错误触发重试并最终成功 ----
    // 旧代码 `return new Promise` 缺 await 时，内层 reject 冒泡不出 catch，
    // retryCount 完全不生效，这类中断会直接让整次下载失败。
    flakyRange = new Set(['0-1048575', '2097152-3145727']);
    flakySeen = new Set();
    injections = 0;

    const out1 = path.join(tmp, 'retry.bin');
    let retryErr = null;
    try {
        await new Downloader({ chunkSize: CHUNK, retryCount: 3, timeout: 5000 })
            .download(`${base}/file.bin`, out1);
    } catch (e) { retryErr = e; }
    check('P0-3 故障确实注入过（两个分片各断一次，否则下面两条是空的）',
        injections === 2, `injections=${injections}`);
    check('P0-3 流式错误后重试成功（缺 await 时此处必失败）', !retryErr, retryErr && retryErr.message);
    check('P0-3 重试后的文件内容完整', fs.existsSync(out1) && md5Of(out1) === payloadMd5);

    // 真正的重试计数验证：让首分片每次都中途断流，观察请求次数
    let attempts = 0;
    flakyRange = null;
    const countingServer = http.createServer((req, res) => {
        const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
        if (req.method === 'HEAD') {
            res.writeHead(200, {
                'Content-Length': String(SIZE),
                'Accept-Ranges': 'bytes'
            });
            res.end();
            return;
        }
        if (!m) { res.writeHead(200, { 'Content-Length': String(SIZE) }); res.end(); return; }
        const start = +m[1];
        const end = Math.min(start + CHUNK - 1, SIZE - 1);
        // 范围探测请求必须正常返回 206，否则 checkRangeSupport 判为不支持
        // 范围而走单线程路径，分片重试根本不会被触发
        if (start === 0) {
            attempts++;
            res.writeHead(206, {
                'Content-Length': String(end - start + 1),
                'Content-Range': `bytes ${start}-${end}/${SIZE}`,
                'Accept-Ranges': 'bytes'
            });
            res.write(payload.subarray(0, 10));
            setTimeout(() => res.destroy(), 50); // 同上：让错误走 body 流而不是请求本身
            return;
        }
        res.writeHead(206, {
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${SIZE}`,
            'Accept-Ranges': 'bytes'
        });
        res.end(payload.subarray(start, end + 1));
    });
    await new Promise((r) => countingServer.listen(0, '127.0.0.1', r));
    const countingBase = `http://127.0.0.1:${countingServer.address().port}`;
    let exhausted = null;
    try {
        await new Downloader({ chunkSize: CHUNK, retryCount: 3, timeout: 3000 })
            .download(`${countingBase}/x.bin`, path.join(tmp, 'exhausted.bin'));
    } catch (e) { exhausted = e; }
    check('P0-3 重试次数用尽后抛出失败', !!exhausted);
    check('P0-3 retryCount 真的生效（首分片请求次数 > 1）', attempts > 1, `attempts=${attempts}`);
    countingServer.close();

    flakyRange = null;

    // ---- P0-3 连带：重试耗尽时补的是 message，原 error 的 code 不能被洗掉 ----
    // 换成 `throw new Error(error.message)` 看着等价，实际把 ECONNRESET 抹成 undefined，
    // 上层按 code 判可重试/判取消的逻辑全部失效，所以这里断言的是抛出来的那个对象本身。
    check('耗尽后抛出的仍是原 error：code 保住、message 换成 chunkFailed 上下文',
        exhausted !== null && exhausted.code === 'ECONNRESET'
        && String(exhausted.message).includes('chunkFailed'),
        exhausted && `code=${exhausted.code} message=${exhausted.message}`);
    check('不是新造的裸 Error（裸 Error 没有 code）',
        exhausted instanceof Error && typeof exhausted.code === 'string' && exhausted.code.length > 0,
        JSON.stringify(exhausted && Object.keys(exhausted)));

    // P0-1 / P0-2 这两段刻意留在文本层：它们锁的是「某段代码不该存在」（死处理器、
    // 文案匹配、白名单残留），删除类断言没有可调用的对象，换不成行为。
    // 真空风险由上面的「读到了内容」兜住，负向正则只在文件确实非空时才有意义。
    // ---- P0-1：取消判定不再依赖 message 文案 ----
    check('P0-1 catch 内用 isDownloadCancelled 而非文案匹配',
        (mainSource.match(/isDownloadCancelled\(error\)/g) || []).length >= 2 &&
        !/error\.message\.includes\('用户取消'\)/.test(mainSource));
    check('P0-1 不存在裸名 isCancelledError（导入时已改名为 isDownloadCancelled）',
        !/(?<![A-Za-z0-9_])isCancelledError\s*\?/.test(mainSource));
    check('P0-1 close 延时用的是作用域内的 isCancelled',
        (mainSource.match(/\}, isCancelled \? 1000 : 3000\);/g) || []).length === 2);

    // ---- P0-2：compile-code 死处理器已移除，监听随之清理 ----
    check('P0-2 compile-code handler 已删除', !/ipcMain\.on\('compile-code'/.test(mainSource));
    check('P0-2 compileCode 调用点已消失', !/[^.\w]compileCode\(/.test(mainSource));
    check('P0-2 compile-manager 不再监听无发送方的四个通道',
        !/'compile-result':/.test(compileMgrSource) &&
        !/'run-result':/.test(compileMgrSource) &&
        !/'run-error':/.test(compileMgrSource) &&
        !/'compile-error': \(/.test(compileMgrSource));
    check('P0-2 preload 事件白名单同步移除这四个通道',
        !/'compile-result'/.test(preloadSource) &&
        !/'run-result'/.test(preloadSource) &&
        !preloadSource.includes("'run-error'"));
    check('P0-2 handleCompileResult/handleRunResult 方法本身仍被其它路径使用',
        /this\.handleCompileResult\(result\)/.test(compileMgrSource) &&
        /this\.handleRunResult\(result\)/.test(compileMgrSource));

    // ---- P0-4 / S-3：moveItem 与 copyFolderRecursive 真跑 ----
    // 原守卫是 `!/ok === false/.test(src)` 这种「旧写法不再出现」的文本锁：
    // 把 !ok 改成 ok !== true 它就照样绿，而真行为（点取消还删不删源文件）才是重点。
    {
        const helperNames = ['csErrMessage', 'csRecord', 'csStr'];
        const helpers = helperNames.map((n) => funcDecl(cloudSyncSource, n));
        check('cloudSync 辅助函数抽取成功', helpers.every((h) => h.length > 0),
            helperNames.map((n, i) => `${n}=${helpers[i].length}`).join(' '));
        global.csErrMessage = toFn(helpers[0]);
        global.csRecord = toFn(helpers[1]);
        global.csStr = toFn(helpers[2]);
        const moveItemSrc = classMethod(cloudSyncSource, 'moveItem');
        const copySrc = classMethod(cloudSyncSource, 'copyFolderRecursive');
        check('方法体抽取成功: moveItem / copyFolderRecursive',
            moveItemSrc.length > 0 && copySrc.length > 0,
            `${moveItemSrc.length}/${copySrc.length}`);
        const moveItem = toFn(moveItemSrc);
        const copyFolderRecursive = toFn(copySrc);
        check('重建成功: moveItem / copyFolderRecursive',
            typeof moveItem === 'function' && typeof copyFolderRecursive === 'function');

        const scenario = async (payload, opts = {}) => {
            const calls = [];
            const messages = [];
            let dialog = 0;
            global.window = {
                i18n: { t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) },
                dialogManager: {
                    showConfirmDialog: async () => {
                        dialog++;
                        return opts.confirm;
                    }
                }
            };
            const reply = (method, url) => {
                const tag = `${method} ${url}`;
                if (tag === 'GET /cloudSync/download') {
                    return typeof opts.download === 'undefined' ? { content: 'X' } : opts.download;
                }
                if (tag === 'GET /cloudSync/list') return { items: opts.list || [] };
                return {};
            };
            const self = {
                normalizePath: (p) => String(p).replace(/\/+$/, ''),
                joinPath: (a, b) => `${a}/${b}`,
                getBaseName: (p) => p.split('/').pop(),
                isDescendantPath: (child, parent) => child.startsWith(`${parent}/`),
                getParentPath: (p) => (p.lastIndexOf('/') > 0 ? p.slice(0, p.lastIndexOf('/')) : '/'),
                request: async (method, url, body) => {
                    calls.push(`${method} ${url}`);
                    return reply(method, url);
                },
                loadDirectory: async () => { },
                renderTree: () => { },
                showMessage: (text, kind) => messages.push({ text, kind }),
                itemsCache: opts.cache || new Map(),
                expandedFolders: opts.expanded || new Set(),
                copyFolderRecursive: (s, t) => copyFolderRecursive.call(self, s, t)
            };
            await moveItem.call(self, payload, opts.target || '/cloud/dir');
            return { calls, messages, dialog, self };
        };
        const file = { path: '/cloud/a.cpp', name: 'a.cpp', type: 'file' };

        for (const cancelled of [false, null, undefined, '', 0]) {
            const r = await scenario(file, { confirm: cancelled });
            check(`取消返回值 ${JSON.stringify(cancelled)} 一律视为不移动（旧写法只认 false）`,
                r.dialog === 1 && r.calls.length === 0 && r.messages.length === 0,
                JSON.stringify(r.calls));
        }
        const accepted = await scenario(file, { confirm: true });
        check('确认后按 download → upload → delete 的顺序走（先拿到内容才敢删源）',
            JSON.stringify(accepted.calls) ===
            '["GET /cloudSync/download","POST /cloudSync/upload","POST /cloudSync/delete"]',
            JSON.stringify(accepted.calls));
        const noContent = await scenario(file, { confirm: true, download: {} });
        check('下载响应没有 content 字段时抛错而不是兜底空串（源文件必须留下）',
            noContent.calls.length === 1 && noContent.calls[0] === 'GET /cloudSync/download'
            && noContent.messages.some((m) => m.kind === 'error'),
            JSON.stringify(noContent));
        const emptyContent = await scenario(file, { confirm: true, download: { content: '' } });
        check('真空文件（content 为空串）仍按合法内容移动，判据是类型不是真假',
            emptyContent.calls.length === 3, JSON.stringify(emptyContent.calls));
        const samePath = await scenario({ path: '/cloud/dir/a.cpp', name: 'a.cpp', type: 'file' },
            { confirm: true, target: '/cloud/dir' });
        check('原地移动直接返回，连确认框都不弹',
            samePath.dialog === 0 && samePath.calls.length === 0, JSON.stringify(samePath));
        const selfNested = await scenario({ path: '/cloud/p', name: 'p', type: 'folder' },
            { confirm: true, target: '/cloud/p/inner' });
        check('把文件夹移进自己的子目录被拦下并给 warning',
            selfNested.calls.length === 0 && selfNested.dialog === 0
            && selfNested.messages.some((m) => m.kind === 'warning'),
            JSON.stringify(selfNested.messages));

        const folderRun = await scenario({ path: '/cloud/p', name: 'p', type: 'folder' }, {
            confirm: true,
            list: [{ name: 'c.cpp', type: 'file', path: '/cloud/p/c.cpp' }]
        });
        check('文件夹移动展开为 createFolder → list → 子项 upload → 子项 delete → 源 delete',
            JSON.stringify(folderRun.calls) === JSON.stringify([
                'POST /cloudSync/createFolder', 'GET /cloudSync/list', 'GET /cloudSync/download',
                'POST /cloudSync/upload', 'POST /cloudSync/delete', 'POST /cloudSync/delete'
            ]), JSON.stringify(folderRun.calls));
        check('源目录整体成功后才删（中途任何一步失败都不会走到 delete /cloud/p）',
            folderRun.calls[folderRun.calls.length - 1] === 'POST /cloudSync/delete',
            JSON.stringify(folderRun.calls.slice(-1)));

        // 子项内容取不到时，copyFolderRecursive 必须抛，且不能把源目录删掉
        const brokenChild = await scenario({ path: '/cloud/p', name: 'p', type: 'folder' }, {
            confirm: true,
            list: [{ name: 'c.cpp', type: 'file', path: '/cloud/p/c.cpp' }],
            download: { size: 10 }
        });
        check('子项 download 无 content 时整个移动中止，源目录不被删除',
            brokenChild.calls.length === 3 && brokenChild.calls[2] === 'GET /cloudSync/download'
            && brokenChild.messages.some((m) => m.kind === 'error'),
            JSON.stringify(brokenChild));
        const directCopy = (() => {
            const calls = [];
            const self = {
                normalizePath: (p) => String(p).replace(/\/+$/, ''),
                joinPath: (a, b) => `${a}/${b}`,
                request: async (method, url) => {
                    calls.push(`${method} ${url}`);
                    if (url === '/cloudSync/download') return { items: [] };
                    if (url === '/cloudSync/list') {
                        return { items: [{ name: 'x.cpp', type: 'file', path: '/cloud/p/x.cpp' }] };
                    }
                    return {};
                }
            };
            return copyFolderRecursive.call(self, '/cloud/p', '/cloud/q')
                .then(() => ({ threw: false, calls }))
                .catch((error) => ({ threw: true, message: error.message, calls }));
        })();
        const copyResult = await directCopy;
        check('copyFolderRecursive 单独调用时同样抛出（不是只挪到一半静默返回）',
            copyResult.threw === true && copyResult.calls.indexOf('POST /cloudSync/delete') === -1,
            JSON.stringify(copyResult));
    }

    // ---- P0-5：closeAllTabs / closeOtherTabs 传的是 Map key 而不是 fileName ----
    {
        const closeAllTabs = toFn(classMethod(tabsSource, 'closeAllTabs'));
        const closeOtherTabs = toFn(classMethod(tabsSource, 'closeOtherTabs'));
        check('方法体重建成功: closeAllTabs / closeOtherTabs',
            typeof closeAllTabs === 'function' && typeof closeOtherTabs === 'function');
        const realWindow = global.window;
        const realConfirm = global.confirm;
        global.window = { i18n: { t: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) } };
        let confirms = 0;
        const board = (entries, activeKey, activeTab, confirmResult) => {
            const closed = [];
            confirms = 0;
            global.confirm = () => { confirms++; return confirmResult; };
            const self = {
                tabs: new Map(entries),
                activeTabKey: activeKey,
                activeTab: activeTab,
                getModifiedTabs: () => [...self.tabs.values()].filter((t) => t && t.modified),
                closeTab: (name, options) => {
                    closed.push(`${name}=>${options && options.uniqueKeyOverride}`);
                    return true;
                }
            };
            return { self, closed };
        };
        const TWO = [['/abs/a.cpp', { fileName: 'a.cpp' }], ['/abs/b.cpp', { fileName: 'b.cpp' }]];

        const all = board(TWO, '/abs/a.cpp', 'a.cpp', false);
        closeAllTabs.call(all.self);
        check('closeAllTabs 逐个把 Map key 作为 uniqueKeyOverride 传给 closeTab',
            JSON.stringify(all.closed) === JSON.stringify([
                'a.cpp=>/abs/a.cpp', 'b.cpp=>/abs/b.cpp'
            ]), JSON.stringify(all.closed));
        check('无修改 tab 时 closeAllTabs 不弹确认框',
            confirms === 0, `confirms=${confirms}`);

        const allDirty = board([['/abs/a.cpp', { fileName: 'a.cpp', modified: true }]], '/abs/a.cpp', 'a.cpp', false);
        closeAllTabs.call(allDirty.self);
        check('有未保存修改时先确认，取消就一个都不关',
            confirms === 1 && allDirty.closed.length === 0,
            `confirms=${confirms} closed=${JSON.stringify(allDirty.closed)}`);

        const others = board(TWO, '/abs/a.cpp', 'a.cpp', true);
        closeOtherTabs.call(others.self);
        check('closeOtherTabs 只关非当前的那一页，当前页不被误关',
            JSON.stringify(others.closed) === JSON.stringify(['b.cpp=>/abs/b.cpp']),
            JSON.stringify(others.closed));

        const staleKey = board(TWO, '/abs/gone.cpp', 'a.cpp', true);
        closeOtherTabs.call(staleKey.self);
        check('activeTabKey 失效时按 fileName 反查回当前 key，仍然不关当前页',
            JSON.stringify(staleKey.closed) === JSON.stringify(['b.cpp=>/abs/b.cpp']),
            JSON.stringify(staleKey.closed));

        const noActive = board(TWO, undefined, null, true);
        closeOtherTabs.call(noActive.self);
        check('没有当前 tab 时 closeOtherTabs 直接返回（不会把所有页当“其它”关掉）',
            noActive.closed.length === 0 && confirms === 0,
            `closed=${JSON.stringify(noActive.closed)} confirms=${confirms}`);

        global.confirm = () => false;
        const othersDirty = board([['/abs/a.cpp', { fileName: 'a.cpp' }],
            ['/abs/b.cpp', { fileName: 'b.cpp', modified: true }]], '/abs/a.cpp', 'a.cpp');
        closeOtherTabs.call(othersDirty.self);
        check('关闭其它页遇到未保存修改且取消时不关任何页',
            confirms === 1 && othersDirty.closed.length === 0,
            `confirms=${confirms} closed=${JSON.stringify(othersDirty.closed)}`);
        global.window = realWindow;
        global.confirm = realConfirm;
    }

    // ---- 6ddac59：await 回来后必须同时锚定 tab 身份与目标编辑器 ----
    {
        const loadSrc = classMethod(tabsSource, 'loadFileContentToEditor');
        check('方法体抽取成功: loadFileContentToEditor', loadSrc.length > 0);
        const loadFileContentToEditor = toFn(loadSrc);
        check('重建成功: loadFileContentToEditor', typeof loadFileContentToEditor === 'function');
        const settle = () => new Promise((resolve) => setImmediate(resolve));
        const realWindow = global.window;

        const runLoad = async (opts = {}) => {
            const writes = [];
            // editorA/editorB 是两个可区分的编辑器实例，用于验证「await 期间切走了就不能写」；
            // 曾经还挂过 updateFileName 桩，但全仓没有任何地方定义过 editor.updateFileName，
            // 那两处调用一直是死代码，随 ts 迁移删除，这里不再断言「文件名补挂」
            const editorA = { tag: 'A' };
            const editorB = { tag: 'B' };
            const tab = {
                uniqueKey: opts.noKey ? undefined : '/abs/a.cpp',
                filePath: '/abs/a.cpp', fileName: 'a.cpp',
                content: opts.preset, modified: opts.presetModified === true,
                isLoading: opts.loading === true
            };
            const self = {
                tabs: new Map([['/abs/a.cpp', tab]]),
                monacoEditorManager: { currentEditor: editorA },
                setEditorContent: (content, markSaved) => writes.push(`${content}|${markSaved}`),
                getDefaultContentForFile: () => 'DEFAULT'
            };
            let resolveRead = null;
            let rejectRead = null;
            let readCalls = 0;
            const gate = new Promise((resolve, reject) => { resolveRead = resolve; rejectRead = reject; });
            global.window = {
                i18n: { t: (key) => key },
                electronAPI: { readFileContent: () => { readCalls++; return gate; } }
            };
            loadFileContentToEditor.call(self, 'a.cpp', tab);
            return {
                tab, self, writes, editorA, editorB,
                get readCalls() { return readCalls; },
                finish: async (content) => { resolveRead(content); await settle(); },
                fail: async (error) => { rejectRead(error); await settle(); }
            };
        };

        const ok = await runLoad();
        await ok.finish('DATA');
        check('正常回写：内容进编辑器并标记已保存',
            JSON.stringify(ok.writes) === '["DATA|true"]', JSON.stringify(ok.writes));
        check('正常回写：tab 缓存同步、modified 复位',
            ok.tab.content === 'DATA' && ok.tab.modified === false,
            JSON.stringify({ content: ok.tab.content, modified: ok.tab.modified }));
        check('读完后清除 isLoading，避免下次切回被永久跳过',
            ok.tab.isLoading === false, String(ok.tab.isLoading));

        const switched = await runLoad({ preset: 'OLD' });
        switched.self.tabs.delete('/abs/a.cpp');
        await switched.finish('DATA');
        check('读取期间 tab 被关掉：结果整个丢弃，既不写编辑器也不回填缓存',
            switched.writes.length === 0 && switched.tab.content === 'OLD',
            JSON.stringify({ writes: switched.writes, content: switched.tab.content }));

        const dirty = await runLoad({ presetModified: true });
        await dirty.finish('DATA');
        check('tab 原本未保存：磁盘重读成功后必须复位 modified（否则改动被吞）',
            dirty.tab.modified === false && JSON.stringify(dirty.writes) === '["DATA|true"]',
            JSON.stringify({ writes: dirty.writes, modified: dirty.tab.modified }));

        const moved = await runLoad({ preset: 'OLD', presetModified: true });
        moved.self.monacoEditorManager.currentEditor = moved.editorB;
        await moved.finish('DATA');
        check('tab 还在但目标编辑器已切走：只回填缓存，不动编辑器',
            moved.writes.length === 0 && moved.tab.content === 'DATA',
            JSON.stringify({ writes: moved.writes, content: moved.tab.content }));
        check('只回填缓存时不能顺手把 modified 置 false（那份未保存改动还不生效）',
            moved.tab.modified === true, String(moved.tab.modified));

        const errCached = await runLoad({ preset: 'CACHED' });
        await errCached.fail(new Error('EIO'));
        check('读取失败且已有缓存时把缓存塞回编辑器（不带已保存标记）',
            JSON.stringify(errCached.writes) === '["CACHED|undefined"]', JSON.stringify(errCached.writes));

        const errBare = await runLoad();
        await errBare.fail(new Error('EIO'));
        check('读取失败且无缓存时不往编辑器里写 undefined',
            errBare.writes.length === 0, JSON.stringify(errBare.writes));

        const busy = await runLoad({ loading: true });
        await busy.finish('DATA');
        check('正在加载时直接跳过，连读文件都不发起（防重复触发）',
            busy.readCalls === 0, `readCalls=${busy.readCalls}`);
        check('跳过时既不写编辑器，也不把 isLoading 误清掉',
            busy.writes.length === 0 && busy.tab.isLoading === true,
            JSON.stringify({ writes: busy.writes, isLoading: busy.tab.isLoading }));

        // 没有 uniqueKey 的 tab 走 filePath 兜底认身份：兜底分支必须「能拒也能放」，
        // 只测拒会放过「把整个 isSameTab 换成 true」这种变异
        const noKeyMoved = await runLoad({ noKey: true });
        noKeyMoved.tab.filePath = '/abs/renamed.cpp';
        await noKeyMoved.finish('DATA');
        check('无 uniqueKey 时按 filePath 认身份：路径变了就丢弃结果',
            noKeyMoved.writes.length === 0 && noKeyMoved.tab.content === undefined,
            JSON.stringify({ writes: noKeyMoved.writes, content: noKeyMoved.tab.content }));

        const noKeySame = await runLoad({ noKey: true });
        await noKeySame.finish('DATA');
        check('无 uniqueKey 且路径没变：照常回写（兜底不是永远拒）',
            JSON.stringify(noKeySame.writes) === '["DATA|true"]', JSON.stringify(noKeySame.writes));
        global.window = realWindow;
    }
    // ---- 重命名后 key 迁移：直接跑 updateTabPathBySource，不再正则数那几行 ----
    {
        const updSrc = classMethod(tabsSource, 'updateTabPathBySource');
        const updateTabPathBySource = toFn(updSrc);
        check('方法体重建成功: updateTabPathBySource', typeof updateTabPathBySource === 'function', `len=${updSrc.length}`);

        const OLD = '/old/a.cpp';
        const NEW = '/new/a.cpp';
        const realWindow = global.window;
        const realDocument = global.document;
        global.window = { i18n: { t: (key) => key } };

        const run = (opts = {}) => {
            const tab = opts.tab || { filePath: OLD, fileName: 'a.cpp', uniqueKey: OLD };
            const group = opts.group === undefined
                ? { tabs: new Map([[tab.uniqueKey, tab]]), activeTabKey: tab.uniqueKey }
                : opts.group;
            const rebind = [];
            const cleaned = [];
            const removed = [];
            const editorCalls = [];
            const self = {
                tabs: new Map(opts.map === undefined ? [[OLD, tab]] : opts.map),
                groups: new Map([['g1', group], ...(opts.extraGroups || [])]),
                tabOrder: (opts.order || ['a.cpp', 'b.cpp']).slice(),
                activeTabKey: 'activeKey' in opts ? opts.activeKey : OLD,
                activeTab: 'activeTab' in opts ? opts.activeTab : tab,
                monacoEditorManager: opts.editorManager === false ? undefined : {
                    cleanupEditor: (id) => cleaned.push(id),
                    updateTabFilePath: (id, p) => editorCalls.push(`${id}->${p}`)
                },
                refreshTabLabels: () => { },
                handleTabFileWatchRebind: (from, to) => rebind.push(`${from}->${to}`)
            };
            const realError = global.logError;
            const realWarn = global.logWarn;
            let errors = 0;
            let warns = 0;
            global.logError = () => { errors++; };
            global.logWarn = () => { warns++; };
            updateTabPathBySource.call(self, opts.oldPath ?? OLD, opts.newPath ?? NEW, opts.newFileName);
            global.logError = realError;
            global.logWarn = realWarn;
            return { self, tab, group, rebind, cleaned, removed, editorCalls, errors, warns };
        };

        const base = run();
        check('重命名后 Map 里只剩新 key，且存的还是同一个 tab 对象',
            base.self.tabs.has(NEW) && !base.self.tabs.has(OLD) && base.self.tabs.get(NEW) === base.tab,
            JSON.stringify([...base.self.tabs.keys()]));
        check('tab 自身的 uniqueKey / filePath 跟着改成新路径',
            base.tab.uniqueKey === NEW && base.tab.filePath === NEW,
            JSON.stringify({ uniqueKey: base.tab.uniqueKey, filePath: base.tab.filePath }));
        check('activeTabKey 跟着迁移（悬空指向旧 key 会让自动保存/编译静默 return）',
            base.self.activeTabKey === NEW && base.self.activeTab === base.tab,
            String(base.self.activeTabKey));
        check('分组内的 tabs 与 activeTabKey 同步迁移',
            base.group.tabs.has(NEW) && !base.group.tabs.has(OLD) && base.group.activeTabKey === NEW,
            JSON.stringify({ tabs: [...base.group.tabs.keys()], active: base.group.activeTabKey }));
        check('文件监听按「旧路径 → 新路径」重绑一次',
            JSON.stringify(base.rebind) === JSON.stringify([`${OLD}->${NEW}`]), JSON.stringify(base.rebind));
        check('不传 newFileName 时 fileName 与 tabOrder 都不动',
            base.tab.fileName === 'a.cpp' && JSON.stringify(base.self.tabOrder) === JSON.stringify(['a.cpp', 'b.cpp']),
            JSON.stringify(base.self.tabOrder));

        const renamed = run({ newFileName: 'z.cpp' });
        check('传了 newFileName：tab.fileName 与 tabOrder 里的旧名一起换掉',
            renamed.tab.fileName === 'z.cpp'
            && JSON.stringify(renamed.self.tabOrder) === JSON.stringify(['z.cpp', 'b.cpp']),
            JSON.stringify(renamed.self.tabOrder));
        const absentOrder = run({ newFileName: 'z.cpp', order: ['别的.cpp'] });
        check('tabOrder 里找不到旧名时不强插（indexOf === -1 分支）',
            JSON.stringify(absentOrder.self.tabOrder) === JSON.stringify(['别的.cpp']),
            JSON.stringify(absentOrder.self.tabOrder));

        // 反查分支：Map key 与 oldPath 不同（保存过 / 路径规范化过）时，
        // 必须按 filePath 找回真实 key，否则旧 key 那条永远删不掉
        {
            const WEIRD = '/weird/key';
            const tab = { filePath: OLD, fileName: 'a.cpp', uniqueKey: WEIRD };
            const group = { tabs: new Map([[WEIRD, tab]]), activeTabKey: WEIRD };
            const found = run({ tab, map: [[WEIRD, tab]], group, activeKey: WEIRD });
            check('key 与 oldPath 不一致时按 filePath 反查真实 key，旧 key 被清掉',
                [...found.self.tabs.keys()].join() === NEW && !found.self.tabs.has(WEIRD)
                && found.group.activeTabKey === NEW && found.self.activeTabKey === NEW,
                JSON.stringify({ tabs: [...found.self.tabs.keys()], active: found.self.activeTabKey }));
        }

        const sameKey = run({ activeKey: NEW, activeTab: { fileName: '别的.cpp' } });
        check('activeTabKey 已是新 key 时也重新指回本 tab（不留下错位的 activeTab）',
            sameKey.self.activeTabKey === NEW && sameKey.self.activeTab === sameKey.tab,
            JSON.stringify(sameKey.self.activeTab && sameKey.self.activeTab.fileName));

        const moving = { filePath: OLD, fileName: 'a.cpp', uniqueKey: OLD, tabId: 5 };
        const removedSink = [];
        const occupying = {
            filePath: NEW, fileName: 'a.cpp', uniqueKey: NEW, modified: true, tabId: 9,
            element: { parentNode: { removeChild: (el) => removedSink.push(el) } }
        };
        const dup = run({ tab: moving, map: [[OLD, moving], [NEW, occupying]] });
        check('目标 key 已被占用：先摘掉占位的，再让改名后的 tab 落位',
            dup.self.tabs.size === 1 && dup.self.tabs.get(NEW) === moving && !dup.self.tabs.has(OLD),
            JSON.stringify({ size: dup.self.tabs.size, keys: [...dup.self.tabs.keys()] }));
        check('摘掉占位 tab 时同步清掉它的 Monaco editor 与 DOM 节点（不能只从 Map 里消失）',
            JSON.stringify(dup.cleaned) === JSON.stringify([9])
            && dup.removed.length === 0 && removedSink.length === 1 && removedSink[0] === occupying.element,
            JSON.stringify({ cleaned: dup.cleaned, sink: removedSink.length }));
        check('改名后的 tab 把自己的 tabId 与新路径回灌给编辑器管理器',
            JSON.stringify(dup.editorCalls) === JSON.stringify(['5->/new/a.cpp']),
            JSON.stringify(dup.editorCalls));

        {
            const m1 = { filePath: OLD, fileName: 'a.cpp', uniqueKey: OLD };
            const m2 = { filePath: OLD, fileName: 'a.cpp', uniqueKey: OLD };
            const clean = run({ tab: m1, map: [[OLD, m1], [NEW, { filePath: NEW, fileName: 'a.cpp', uniqueKey: NEW }]] });
            const dirty = run({ tab: m2, map: [[OLD, m2], [NEW, { filePath: NEW, fileName: 'a.cpp', uniqueKey: NEW, modified: true }]] });
            check('覆盖未保存的占位 tab 时必须留下告警痕迹，覆盖干净的不告警',
                clean.warns === 0 && clean.errors === 0 && dirty.warns >= 1,
                JSON.stringify({ clean: clean.warns, dirty: dirty.warns }));
        }

        const otherGroup = run({ group: { tabs: new Map([['/g/other.cpp', {}]]), activeTabKey: '/g/other.cpp' } });
        check('别的分组里没有这个 key 就不动它（不会凭空造一条）',
            !otherGroup.group.tabs.has(NEW) && otherGroup.group.activeTabKey === '/g/other.cpp'
            && otherGroup.self.tabs.has(NEW),
            JSON.stringify([...otherGroup.group.tabs.keys()]));

        const notAMap = run({ group: { tabs: [], activeTabKey: OLD } });
        check('group.tabs 不是 Map 时跳过分组同步，主流程照常完成',
            notAMap.self.tabs.has(NEW) && !notAMap.self.tabs.has(OLD),
            JSON.stringify([...notAMap.self.tabs.keys()]));

        const emptyArgs = run({ newPath: '' });
        check('oldPath / newPath 缺一个就整个不动',
            [...emptyArgs.self.tabs.keys()].join() === OLD && emptyArgs.rebind.length === 0
            && emptyArgs.errors === 0,
            JSON.stringify({ tabs: [...emptyArgs.self.tabs.keys()], rebind: emptyArgs.rebind, errors: emptyArgs.errors }));
        const missing = run({ oldPath: '/nope/x.cpp' });
        check('找不到对应 tab 时正常返回：不改 key、不重绑监听，也不是靠外层 catch 吞异常',
            [...missing.self.tabs.keys()].join() === OLD && missing.rebind.length === 0
            && missing.errors === 0 && missing.warns >= 1,
            JSON.stringify({ tabs: [...missing.self.tabs.keys()], rebind: missing.rebind, errors: missing.errors }));
        const badName = run({ newFileName: 123 });
        check('newFileName 不是字符串时一律忽略（不污染 fileName / tabOrder / DOM）',
            badName.tab.fileName === 'a.cpp'
            && JSON.stringify(badName.self.tabOrder) === JSON.stringify(['a.cpp', 'b.cpp'])
            && badName.tab.filePath === NEW,
            JSON.stringify({ fileName: badName.tab.fileName, order: badName.self.tabOrder }));

        {
            const tab = { filePath: OLD, fileName: 'a.cpp', uniqueKey: OLD, tabId: 7 };
            const el = { dataset: {} };
            global.document = { querySelector: () => el };
            const dom = run({ tab, map: [[OLD, tab]] });
            check('tab 元素上的 data-uniqueKey 一起改（点 tab 时不能拿旧 key 去找）',
                el.dataset['uniqueKey'] === NEW && dom.tab.element === el,
                JSON.stringify(el.dataset));
            global.document = realDocument;
        }
        global.window = realWindow;
    }

    // 下面这条留在文本层：closeTab 依赖 DOM 渲染 / Monaco 生命周期 / 确认对话框，
    // 重建成本远高于守卫价值；这条只锁「同一处赋值成对出现」，空白容忍已放开。
    check('关闭 tab 时一并清空 activeTabKey',
        /this\.activeTab = null;\s*\n\s*this\.activeTabKey = null;/.test(tabsSource));

    // ---- 7032ecf：调试变量转义 —— 直接重建 createVariableElement 跑一遍看产物 ----
    {
        const escRef = (v) => String(v ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        const LABELS = { 'debug.removeWatch': '移除"监视<x>', 'debug.typeArray': '数组', 'debug.typeContainer': '容器' };
        const realDocument = global.document;
        const realWindow = global.window;
        global.window = { i18n: { t: (key) => LABELS[key] } };

        const createSrc = classMethod(rendererMainSource, 'createVariableElement');
        const formatSrc = classMethod(rendererMainSource, 'formatVariableValue');
        const createVariableElement = toFn(createSrc);
        const formatVariableValue = toFn(formatSrc);
        check('方法体重建成功: createVariableElement / formatVariableValue',
            typeof createVariableElement === 'function' && typeof formatVariableValue === 'function',
            `${createSrc.length}/${formatSrc.length}`);

        global.document = { createElement: () => ({ className: '', innerHTML: '' }) };
        const self = { formatVariableValue };
        const render = (name, data, scope) => {
            const el = createVariableElement.call(self, name, data, scope);
            return el.innerHTML;
        };
        // 属性值里能不能整段取出来，正是「有没有被裸引号截断」的判据
        const titleOf = (html, cls) => {
            const m = new RegExp(`class="${cls}"\\s+title="([^"]*)"`).exec(html);
            return m ? m[1] : null;
        };
        const textOf = (html, cls) => {
            const m = new RegExp(`class="${cls}"[^>]*>([\\s\\S]*?)</span>`).exec(html);
            return m ? m[1] : null;
        };

        const PAYLOAD = `p"q'r&s<t>`;
        const html = render(PAYLOAD, { type: `t"&<`, value: PAYLOAD }, 'local');
        check('gdb 的 name / type / value 一律转义后才进 innerHTML（含 & 必须最先替换）',
            titleOf(html, 'variable-name') === escRef(`t"&<`)
            && titleOf(html, 'variable-value') === escRef(PAYLOAD)
            && textOf(html, 'variable-name') === escRef(PAYLOAD)
            && textOf(html, 'variable-value') === escRef(PAYLOAD),
            JSON.stringify({ name: titleOf(html, 'variable-name'), value: titleOf(html, 'variable-value') }));
        check('渲染结果里不残留任何未转义的注入片段',
            !html.includes(PAYLOAD) && !html.includes('<img') && !html.includes('<script'), html);
        check('五个特殊字符各自换成实体（& 先替换，不出现 &amp;lt; 二次转义）',
            html.includes('&quot;') && html.includes('&#39;') && html.includes('&amp;')
            && html.includes('&lt;') && html.includes('&gt;') && !html.includes('&amp;lt;'), html);

        const XSS = '<img src=x onerror=alert(1)>';
        const htmlXss = render('v', { type: 'int', value: XSS }, 'local');
        check('<img onerror=…> 这类片段被转成实体，不成为标签',
            !htmlXss.includes('<img') && htmlXss.includes('&lt;img src=x onerror=alert(1)&gt;'), htmlXss);

        check('type 缺失回退 unknown（回退值本身也走转义）',
            titleOf(render('v', { value: 'x' }, 'local'), 'variable-name') === 'unknown',
            String(titleOf(render('v', { value: 'x' }, 'local'), 'variable-name')));
        check('type 为空串同样回退 unknown',
            titleOf(render('v', { type: '', value: 'x' }, 'local'), 'variable-name') === 'unknown',
            String(titleOf(render('v', { type: '', value: 'x' }, 'local'), 'variable-name')));
        check('value 缺失时 title 是空串而不是 "undefined"',
            titleOf(render('v', { type: 'int' }, 'local'), 'variable-value') === ''
            && textOf(render('v', { type: 'int' }, 'local'), 'variable-value') === '',
            String(titleOf(render('v', { type: 'int' }, 'local'), 'variable-value')));

        const watchHtml = render(PAYLOAD, { type: `t"&<`, value: PAYLOAD }, 'watch');
        const btnTitle = /class="remove-watch-btn"\s+title="([^"]*)"/.exec(watchHtml);
        check('watch 作用域才渲染删除按钮，按钮 title 也转义（i18n 文案同样不可信）',
            btnTitle !== null && btnTitle[1] === escRef(LABELS['debug.removeWatch']),
            btnTitle ? btnTitle[1] : 'no button');
        check('非 watch 作用域不渲染删除按钮',
            !render('v', { type: 'int', value: 'x' }, 'local').includes('remove-watch-btn')
            && !render('v', { type: 'int', value: 'x' }, 'globals').includes('remove-watch-btn'));

        check('有子节点才给展开箭头，空 children 用占位（判据是 length > 0）',
            render('v', { type: 'int', value: 'x', children: ['a'] }, 'local').includes('expand-toggle')
            && !render('v', { type: 'int', value: 'x', children: [] }, 'local').includes('expand-toggle')
            && render('v', { type: 'int', value: 'x', children: [] }, 'local').includes('expand-spacer'));
        // ---- formatVariableValue 自身的形状（仍在本段的 window 桩下）----
        const fv = (data) => formatVariableValue.call({ formatVariableValue }, data);
        check('无 value 时返回空串（不是 "undefined"）',
            fv({}) === '' && fv({ value: '' }) === '' && fv({ value: null }) === '',
            JSON.stringify([fv({}), fv({ value: '' }), fv({ value: null })]));
        check('非字符串 value 走 toString', fv({ value: 123 }) === '123', fv({ value: 123 }));
        check('数组用 i18n 的数组名 + [元素数] 前缀',
            fv({ value: '{1,2}', isArray: true, elementCount: 2 }) === `数组[2] {1,2}`,
            fv({ value: '{1,2}', isArray: true, elementCount: 2 }));
        check('容器用 i18n 的容器名，elementCount 为 null 才显示 ?',
            fv({ value: 'c', isContainer: true, elementCount: 3 }) === '容器[3] c'
            && fv({ value: 'c', isContainer: true, elementCount: null }) === '容器[?] c',
            JSON.stringify([fv({ value: 'c', isContainer: true, elementCount: 3 }),
                fv({ value: 'c', isContainer: true, elementCount: null })]));
        check('恰好 50 字符不截断，51 字符截成 47 + ...',
            fv({ value: 'x'.repeat(50) }) === 'x'.repeat(50)
            && fv({ value: 'x'.repeat(51) }) === 'x'.repeat(47) + '...',
            JSON.stringify([fv({ value: 'x'.repeat(51) }).length]));
        check('截断发生在拼前缀之后（长数组的总长也被压到 50）',
            fv({ value: 'y'.repeat(60), isArray: true, elementCount: 1 })
            === (`数组[1] ${'y'.repeat(60)}`).slice(0, 47) + '...',
            fv({ value: 'y'.repeat(60), isArray: true, elementCount: 1 }));

        global.document = realDocument;
        global.window = realWindow;
    }

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
    process.exit(failures ? 1 : 0);
})();