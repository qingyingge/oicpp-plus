'use strict';
// 用桩替换 electron 模块，加载真实 preload.js，验证 IPC 白名单与事件解包
const fs = require('fs');
const path = require('path');
const Module = require('module');

// 挂死不等于通过：某个 await 永不 settle 时 Node 会以 0 退出码排空 event loop，
// 后半截断言一条不发也「全绿」。留一个不 unref 的定时器把「跑不完」顶成失败。
setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：某个 await 永不 settle（异步守卫没被驱动完）');
    process.exit(1);
}, 60000);

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(ROOT, 'src', 'preload.js');

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const exposed = {};
const sent = [];
const invoked = [];
const listeners = new Map();
const removedChannels = [];
let removeAllCalls = 0;
const warns = [];

const electronStub = {
    contextBridge: {
        exposeInMainWorld: (name, api) => { exposed[name] = api; }
    },
    ipcRenderer: {
        send: (ch, ...args) => { sent.push({ ch, args }); },
        invoke: (ch, ...args) => { invoked.push({ ch, args }); return Promise.resolve({ ok: true }); },
        on: (ch, l) => {
            if (!listeners.has(ch)) listeners.set(ch, []);
            listeners.get(ch).push(l);
            return electronStub.ipcRenderer;
        },
        once: () => { },
        removeListener: (ch) => { removedChannels.push(ch); },
        removeAllListeners: () => { removeAllCalls++; }
    },
    shell: { openExternal: async () => { }, showItemInFolder: () => { }, openPath: async () => '' },
    clipboard: { writeText: () => { }, readText: () => '' }
};

const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'electron') return electronStub;
    return origLoad.apply(this, arguments);
};

console.warn = (...a) => { warns.push(a.join(' ')); };

global.window = { addEventListener: () => { }, location: { href: 'http://localhost/' } };
global.document = {
    readyState: 'complete',
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute() { }, appendChild() { } }),
    addEventListener: () => { },
    body: { appendChild: () => { } }
};

require(PRELOAD);

check('preload exposes electronIPC', !!exposed.electronIPC);
check('preload exposes electronAPI', !!exposed.electronAPI);
check('preload exposes markdownAPI', !!exposed.markdownAPI);

// 渲染层能摸到哪些全局，就等于这张表 —— 它是真跑一遍 src/preload.js 之后
// contextBridge.exposeInMainWorld 实际递交上来的名字，不是对源码正则扫
// `exposeInMainWorld\(['"]` 的结果。后者有两个盲区：名字拼出来的
// （exposeInMainWorld(name, …)，name 来自变量/字符串拼接）看不见，
// 换成别的挂载写法（window.Buffer = Buffer、Object.assign(window, …)）也看不见。
// 这条是按安全边界登记的清单：往里加一个名字，就是给渲染层多开一个入口，
// 必须在这里同步改一次 —— 加 Buffer 尤其不行，Node 的 Buffer 一进来，
// 池化 ArrayBuffer（alloc unsafe 的复用行为）和它背后的 binding 就跟着进了沙箱。
const EXPOSED_GLOBALS = [
    '__electronRequireAvailable', 'electron', 'electronAPI', 'electronIPC',
    'getElectronModule', 'logError', 'logInfo', 'logWarn', 'logerror', 'logwarn',
    'markdownAPI', 'process', 'turndownAPI'
];
check('挂进 window 的名字就是这份清单（多一个就是多开一个渲染层入口）',
    Object.keys(exposed).sort().join(',') === EXPOSED_GLOBALS.join(','),
    Object.keys(exposed).sort().join(','));
check('清单里没有 Buffer（渲染层的二进制转换只能走自研的逐字节 base64）',
    !Object.keys(exposed).some((name) => /buffer/i.test(name)),
    Object.keys(exposed).join(','));
check('window 上没有直接被 preload 写进去的额外全局（require/process.binding 之类）',
    global.window.Buffer === undefined && global.window.require === undefined &&
    global.window.process === undefined,
    JSON.stringify(Object.keys(global.window)));

// 把 'markdown-it' 这条 require 换成「模块缺失」或「render 抛错」，再重跑一遍 preload。
// 为什么要重跑：兜底分支在 render 里面，而首份 preload 用的是真 markdown-it，
// 那个分支永远进不去 —— 只测得到主路径。每次重跑的模块级 md 缓存是新的，
// ensureMarkdown 就会按当前桩重新失败一次。
// body 必须在打桩窗口内跑完：ensureMarkdown 是惰性的，第一次 render 才去 require，
// 出了窗口再调就换成真模块了（实测过这个坑，兜底分支根本没被走到）。
// electron 桩必须整套独立：共享 ipcRenderer 的话，重复实例的日志批量定时器会往
// 同一个 sent 数组里塞东西，把后面 P1 那几条「即时发送数」的计数搅脏。
function withMarkdownStub(mode, body) {
    const bag = {};
    const isolatedStub = {
        contextBridge: { exposeInMainWorld: (name, api) => { bag[name] = api; } },
        ipcRenderer: {
            send: () => { },
            invoke: () => Promise.resolve({ ok: true }),
            on: () => isolatedStub.ipcRenderer,
            once: () => { },
            removeListener: () => { },
            removeAllListeners: () => { }
        },
        shell: electronStub.shell,
        clipboard: { writeText: () => { }, readText: () => '' }
    };
    const prevLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') return isolatedStub;
        if (request === 'markdown-it') {
            if (mode === 'missing') throw new Error("Cannot find module 'markdown-it'");
            const FakeMarkdownIt = function () {
                this.renderer = { rules: {} };
                this.utils = { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') };
            };
            FakeMarkdownIt.prototype.use = function () { return this; };
            FakeMarkdownIt.prototype.render = function () { throw new Error('katex boom'); };
            return FakeMarkdownIt;
        }
        return prevLoad.apply(this, arguments);
    };
    delete require.cache[PRELOAD];
    try {
        require(PRELOAD);
        return body(bag);
    } finally {
        Module._load = prevLoad;
        delete require.cache[PRELOAD];
    }
}

// 扫描 renderer 实际使用的所有 send/invoke 通道
const scanFiles = [];
(function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|html)$/.test(e.name)) scanFiles.push(p);
    }
})(path.join(ROOT, 'src', 'renderer'));

const sendChannels = new Set();
const invokeChannels = new Set();
for (const f of scanFiles) {
    const c = fs.readFileSync(f, 'utf8');
    for (const m of c.matchAll(/(?:electronIPC|ipcRenderer)\.send\(\s*['"`]([^'"`]+)['"`]/g)) sendChannels.add(m[1]);
    for (const m of c.matchAll(/(?:electronIPC|ipcRenderer)\.invoke\(\s*['"`]([^'"`]+)['"`]/g)) invokeChannels.add(m[1]);
}
console.log(`扫描到 renderer send 通道 ${sendChannels.size} 个, invoke 通道 ${invokeChannels.size} 个`);

warns.length = 0;
const blockedSends = [];
for (const ch of sendChannels) {
    const before = sent.length;
    exposed.electronIPC.send(ch, 'x');
    if (sent.length === before) blockedSends.push(ch);
}
check('renderer 所有 send 通道通过白名单', blockedSends.length === 0, blockedSends.join(','));
check('无 IPC send blocked 警告', !warns.some(w => w.includes('IPC send blocked')), warns.join(' | '));

// preload 自身封装的通道同样必须命中白名单：renderer 侧扫描不到字面量，
// 一旦漏收录（如 save-all-complete）功能会静默失效，关闭流程只能等超时兜底
const preloadSource = fs.readFileSync(PRELOAD, 'utf8');
const internalSends = new Set();
const internalInvokes = new Set();
for (const m of preloadSource.matchAll(/safeIpcRenderer\.send\(\s*['"]([^'"]+)['"]/g)) internalSends.add(m[1]);
for (const m of preloadSource.matchAll(/safeIpcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)) internalInvokes.add(m[1]);

const blockedInternalSends = [];
for (const ch of internalSends) {
    const before = sent.length;
    exposed.electronIPC.send(ch, 'x');
    if (sent.length === before) blockedInternalSends.push(ch);
}
check('preload 内部 send 通道全部通过白名单', blockedInternalSends.length === 0, blockedInternalSends.join(','));

const blockedInternalInvokes = [];
for (const ch of internalInvokes) {
    const before = invoked.length;
    const ret = exposed.electronIPC.invoke(ch, 'x');
    if (ret && typeof ret.catch === 'function') ret.catch(() => { });
    if (invoked.length === before) blockedInternalInvokes.push(ch);
}
check('preload 内部 invoke 通道全部通过白名单', blockedInternalInvokes.length === 0, blockedInternalInvokes.join(','));

(async () => {
    invoked.length = 0;
    await exposed.electronAPI.formatCppCode({ content: 'int main(){}', style: { IndentWidth: 4 } });
    check('electronAPI exposes standalone clang-format bridge',
        invoked.length === 1 && invoked[0].ch === 'format-cpp-code' && invoked[0].args[0].content === 'int main(){}');

    const blockedInvokes = [];
    for (const ch of invokeChannels) {
        try {
            await exposed.electronIPC.invoke(ch);
        } catch (e) {
            if (String(e && e.message).includes('blocked')) blockedInvokes.push(ch);
        }
    }
    check('renderer 所有 invoke 通道通过白名单', blockedInvokes.length === 0, blockedInvokes.join(','));

    // 事件解包：三个修复通道拿到 payload，未修通道保持原签名
    // preload 自身也会订阅部分通道（如 P2 设置缓存失效），故取最后注册的监听器
    const apiListener = (ch) => {
        const arr = listeners.get(ch) || [];
        return arr[arr.length - 1];
    };
    let got = null;
    exposed.electronAPI.onSettingsReset(v => { got = v; });
    apiListener('settings-reset')?.({ sender: 'fake' }, { theme: 'dark' });
    check('settings-reset 解包出 payload', got && got.theme === 'dark', JSON.stringify(got));

    got = null;
    exposed.electronAPI.onSettingsImported(v => { got = v; });
    apiListener('settings-imported')?.({ sender: 'fake' }, { editor: { fontSize: 14 } });
    check('settings-imported 解包出 payload', got && got.editor.fontSize === 14);

    got = null;
    exposed.electronAPI.onThemeChanged(v => { got = v; });
    (listeners.get('theme-changed') || [])[0]?.({ sender: 'fake' }, 'solarized');
    check('theme-changed 解包出 payload', got === 'solarized', String(got));

    let args = null;
    exposed.electronAPI.onSettingsChanged((...a) => { args = a; });
    const ev = { sender: 'fake' };
    apiListener('settings-changed')?.(ev, 'editor', { x: 1 });
    check('settings-changed 保持 (event,type,settings) 签名', args && args[0] === ev && args[1] === 'editor' && args[2].x === 1);

    // LSP 事件桥接：先验证 payload 解包；listener cleanup 作为审计项单独报告。
    let lspNotification = null;
    const lspNotificationCleanup = exposed.electronAPI.onLspNotification(payload => { lspNotification = payload; });
    (listeners.get('lsp-notification') || [])[0]?.({ sender: 'fake' }, { method: 'textDocument/publishDiagnostics' });
    check('lsp-notification 解包出 payload', lspNotification?.method === 'textDocument/publishDiagnostics');
    console.log(`[AUDIT] onLspNotification cleanup: ${typeof lspNotificationCleanup === 'function' ? 'present' : 'missing'}`);

    let lspApplyEdit = null;
    const lspApplyEditCleanup = exposed.electronAPI.onLspApplyEdit(payload => { lspApplyEdit = payload; });
    (listeners.get('lsp-apply-edit') || [])[0]?.({ sender: 'fake' }, { requestId: 'audit-1', edit: {} });
    check('lsp-apply-edit 解包出 payload', lspApplyEdit?.requestId === 'audit-1');
    console.log(`[AUDIT] onLspApplyEdit cleanup: ${typeof lspApplyEditCleanup === 'function' ? 'present' : 'missing'}`);

    // compare 监听器清理只移除自己的通道
    const off = exposed.electronAPI.onCompareProgress(() => { });
    off();
    check('onCompareProgress 用 removeListener 而非 removeAllListeners',
        removedChannels.includes('compare-progress') && removeAllCalls === 0,
        `removed=[${removedChannels}] removeAll=${removeAllCalls}`);

    // markdown 本地图片 + 多次渲染输出一致
    // 夹具用平台原生绝对路径，断言按 file:// URL 归一化后在所有系统上都成立
    const docDir = path.join(path.parse(process.cwd()).root, 'docs');
    const docPath = path.join(docDir, 'readme.md');
    const normPath = (p) => p.replace(/\\/g, '/');
    const fileUrlToPath = (url) => normPath(decodeURIComponent(url.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1')));
    const out1 = exposed.markdownAPI.render('![img](img.png)', docPath);
    const out2 = exposed.markdownAPI.render('![img](img.png)', docPath);
    const renderedSrc = (/<img src="([^"]+)"/.exec(out1) || [])[1] || '';
    check('相对图片路径解析为 file://',
        renderedSrc.startsWith('file://') && fileUrlToPath(renderedSrc) === normPath(path.join(docDir, 'img.png')),
        renderedSrc || out1.slice(0, 300));
    check('重复渲染输出一致（规则未叠加）', out1 === out2);
    const out3 = exposed.markdownAPI.render('![img](img.png)');
    check('无 filePath 时保持原相对路径', out3.includes('img.png') && !out3.includes('file://'));
    const traversal = exposed.markdownAPI.render('![x](../../etc/passwd)', docPath);
    check('Markdown 图片路径禁止越过文档目录', !traversal.includes('file://') && !traversal.includes('passwd'));

    // H8: 事件通道白名单——renderer 字面量通道全部可注册，非法通道被拦截
    const eventChannels = new Set();
    for (const f of scanFiles) {
        const c = fs.readFileSync(f, 'utf8');
        for (const m of c.matchAll(/(?:electronIPC|ipcRenderer)\.on\(\s*['"`]([^'"`]+)['"`]/g)) eventChannels.add(m[1]);
    }
    // 注：compile-result / compile-error / run-result / run-error 曾在此手工补录，
    // 它们对应的 compile-manager.js 监听已随死代码移除（无任何发送方），故不再补录。
    warns.length = 0;
    const blockedEvents = [];
    for (const ch of eventChannels) {
        const before = (listeners.get(ch) || []).length;
        exposed.electronIPC.on(ch, () => { });
        if ((listeners.get(ch) || []).length <= before) blockedEvents.push(ch);
    }
    check('renderer 所有事件通道通过白名单', blockedEvents.length === 0, blockedEvents.join(','));
    check('事件通道注册无 IPC event blocked 警告', !warns.some(w => w.includes('IPC event blocked')), warns.join(' | '));

    warns.length = 0;
    exposed.electronIPC.on('not-a-real-channel', () => { });
    check('electronIPC 拦截非白名单事件通道',
        (listeners.get('not-a-real-channel') || []).length === 0 &&
        warns.some(w => w.includes('IPC event blocked')), warns.join(' | '));

    warns.length = 0;
    exposed.electron.ipcRenderer.on('not-a-real-channel', () => { });
    check('safeIpcRenderer 拦截非白名单事件通道',
        (listeners.get('not-a-real-channel') || []).length === 0 &&
        warns.some(w => w.includes('IPC event blocked')), warns.join(' | '));

    // H9: Markdown 转义内联 HTML
    check('markdown 转义内联 HTML', !exposed.markdownAPI.render('a <b>b</b>').includes('<b>'));

    // (ff) 兜底路径的转义。消费方是 tabs.ts 的 updateMarkdownPreview，它把返回值
    // 直接交给 innerHTML；主路径的转义全靠 MarkdownIt 的 html:false，所以渲染器一缺失/
    // 一抛错，兜底返回源文本就等于把用户写的 <img src=x onerror=...> 从文本升级成真元素。
    {
        const EVIL = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
        const errs = [];
        const prevError = console.error;
        let outMissing = '', outBroken = '', amp = '', empty = '';
        let missingApi = null, brokenApi = null;
        try {
            console.error = (...a) => { errs.push(a.map((x) => String((x && x.message) || x)).join(' ')); };
            const missingRun = withMarkdownStub('missing', (api) => {
                missingApi = api.markdownAPI;
                return {
                    evil: api.markdownAPI.render(EVIL, '/tmp/doc.md'),
                    amp: api.markdownAPI.render('a & b < c'),
                    empty: api.markdownAPI.render(undefined)
                };
            });
            outMissing = missingRun.evil;
            amp = missingRun.amp;
            empty = missingRun.empty;
            outBroken = withMarkdownStub('broken', (api) => {
                brokenApi = api.markdownAPI;
                return api.markdownAPI.render(EVIL, '/tmp/doc.md');
            });
        } finally {
            console.error = prevError;
        }
        check('markdown-it 缺失时不再原样返回源文本',
            outMissing !== EVIL && !outMissing.includes('<img') && !outMissing.includes('<script'),
            JSON.stringify(outMissing).slice(0, 100));
        check('markdown-it 缺失：< 与 " 被转义成实体',
            outMissing.includes('&lt;img') && outMissing.includes('&quot;alert(1)&quot;'),
            JSON.stringify(outMissing).slice(0, 100));
        check('渲染器抛错走同一条转义兜底',
            outBroken.includes('&lt;img') && !outBroken.includes('<img'),
            JSON.stringify(outBroken).slice(0, 100));
        check('兜底保留正文，用户至少看得见自己写了什么',
            outMissing.includes('src=x') && outBroken.includes('src=x'), '');
        check('& 先转义：产出的一次实体不会被二次转义',
            amp.includes('&amp;') && amp.includes('&lt;') &&
            !amp.includes('&amp;lt;') && !amp.includes('&amp;amp;'), amp);
        check('undefined 输入不炸，兜底成空段落',
            empty === '<pre class="markdown-plain"></pre>', JSON.stringify(empty));
        check('兜底不是静默降级：失败原因仍写进 console',
            errs.some((e) => e.includes('markdown-it')) &&
            errs.some((e) => e.includes('Markdown render error')),
            JSON.stringify(errs.map((e) => e.slice(0, 30))));
        check('重跑 preload 没吃掉主路径：渲染器可用时仍输出真 HTML',
            exposed.markdownAPI.render('# 标题', '/tmp/x.md').includes('<h1'), '');
        check('独立袋子加载不动首份 exposed',
            missingApi && brokenApi && missingApi !== exposed.markdownAPI &&
            Object.keys(exposed).sort().join(',') === EXPOSED_GLOBALS.join(','),
            Object.keys(exposed).sort().join(','));
    }

    // P1: 渲染进程日志合并成批发送，不再每条一次 IPC
    const logSendsBefore = sent.length;
    for (let i = 0; i < 5; i++) exposed.logInfo(`[P1] 第 ${i} 条日志`);
    exposed.logWarn('[P1] 告警', new Error('boom'));
    check('P1 日志调用不再立即逐条跨进程',
        sent.length === logSendsBefore, `${sent.length - logSendsBefore} immediate send(s)`);
    await new Promise(r => setTimeout(r, 400));
    const logSends = sent.slice(logSendsBefore).filter(s => s.ch === 'logger-log-batch');
    check('P1 日志合并为单次 logger-log-batch',
        logSends.length === 1 && Array.isArray(logSends[0].args[0]) && logSends[0].args[0].length === 6,
        `batches=${logSends.length} entries=${(logSends[0] && logSends[0].args[0] || []).length}`);
    check('P1 warn 日志保留 meta 且不再抓取 preload 内部 stack',
        !!logSends[0] && Array.isArray(logSends[0].args[0]) &&
        logSends[0].args[0].filter(e => e.level === 'warn').every(e => e.meta && e.meta.source === 'renderer' && !e.meta.stack));

    // P2: get-all-settings 短 TTL 缓存 + 在途去重
    invoked.length = 0;
    const s1 = await exposed.electronAPI.getAllSettings();
    const s2 = await exposed.electronAPI.getAllSettings();
    check('P2 连续 getAllSettings 只跨进程一次',
        invoked.filter(i => i.ch === 'get-all-settings').length === 1,
        `${invoked.filter(i => i.ch === 'get-all-settings').length} invoke(s)`);
    check('P2 缓存返回的是独立副本', s1 !== s2 && JSON.stringify(s1) === JSON.stringify(s2));
    s1.ok = 'mutated';
    const s3 = await exposed.electronAPI.getAllSettings();
    check('P2 缓存副本互不污染', s3.ok !== 'mutated', String(s3.ok));
    invoked.length = 0;
    await exposed.electronAPI.updateSettings({ editor: { fontSize: 15 } });
    await exposed.electronAPI.getAllSettings();
    check('P2 写设置后缓存失效',
        invoked.filter(i => i.ch === 'get-all-settings').length === 1,
        `${invoked.filter(i => i.ch === 'get-all-settings').length} invoke(s)`);
    invoked.length = 0;
    (listeners.get('settings-changed') || []).forEach(l => l({ sender: 'fake' }, 'editor', {}));
    await exposed.electronAPI.getAllSettings();
    check('P2 收到 settings-changed 广播后缓存失效',
        invoked.filter(i => i.ch === 'get-all-settings').length === 1,
        `${invoked.filter(i => i.ch === 'get-all-settings').length} invoke(s)`);

    // P4: 纯路径函数在 preload 本地计算，不再走 IPC
    invoked.length = 0;
    const joined = await exposed.electronAPI.pathJoin('a', 'b', 'c.cpp');
    const dirnamed = await exposed.electronAPI.pathDirname('a/b/c.cpp');
    const pathInfo = await exposed.electronAPI.getPathInfo('a/b/c.cpp');
    const homeDir = await exposed.electronAPI.getHomeDir();
    const nodePath = require('path');
    check('P4 pathJoin/pathDirname 本地计算且不跨进程',
        invoked.length === 0 && joined === nodePath.join('a', 'b', 'c.cpp') && dirnamed === nodePath.dirname('a/b/c.cpp'),
        `invokes=${invoked.length} joined=${joined} dirnamed=${dirnamed}`);
    check('P4 getPathInfo 本地计算且字段一致',
        pathInfo.dirname === nodePath.dirname('a/b/c.cpp') &&
        pathInfo.basename === 'c.cpp' &&
        pathInfo.extname === '.cpp' &&
        pathInfo.basenameWithoutExt === 'c',
        JSON.stringify(pathInfo));
    check('P4 getHomeDir 返回用户主目录', typeof homeDir === 'string' && homeDir.length > 0, homeDir);
    let pathJoinRejected = false;
    try {
        await exposed.electronAPI.pathJoin(42);
    } catch (_) {
        pathJoinRejected = true;
    }
    check('P4 非法参数仍以 rejection 表达', pathJoinRejected);

    console.log(failures === 0 ? '\nPRELOAD TESTS: ALL PASSED' : `\nPRELOAD TESTS: ${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
