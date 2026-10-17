'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { arrowExpr, callStatement, callbackBody, classMethod, compileMethod, funcDecl, ifStatement, setMembers } = require('./fixtures/source-extract');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const mainSource = read('src/main.js');
const preloadSource = read('src/preload.js');
const rendererMainSource = read('src/renderer/js/main.js');
const rendererInitSource = read('src/renderer/js/init.js');
const settingsInitSource = read('src/renderer/js/settings-init.js');
const tabsSource = read('src/renderer/js/tabs.js');
const compilerSettingsSource = read('src/renderer/settings/compiler.js');
const editorSettingsSource = read('src/renderer/settings/editor.js');
const workerSource = read('src/main-process/compare-worker-v6.js');
const downloaderSource = read('src/utils/multi-thread-downloader.js');
const packageJson = JSON.parse(read('package.json'));
const ciSource = read('scripts/ci-check.js');
const gdbSource = `${read('src/gdb-debugger.js')}\n${read('src/gdb-mi-debugger.js')}`;
const installerSource = read('installer.nsi');
const workflows = ['build.yml', 'build-windows-test.yml', 'build-dmg-test.yml']
    .map((name) => read(path.join('.github', 'workflows', name)))
    .join('\n');

// ---- 远程 API 代理 ----
// 原来这条守卫是 `!mainSource.includes("'/api/cloudCompilation'")`：把白名单里的
// 单引号换成反引号、或者以别的形式把那项加回去，都可能看不见。白名单的保护力全在
// 「集合里有哪些成员」和「拦截发生在发请求之前」，所以这里抽真集合 + 抽整个
// fetch-remote-json 回调，在 vm 里真调一遍，顺便数 axios 被调了几次。
const remotePaths = setMembers(mainSource, 'ALLOWED_REMOTE_API_PATHS');
check('远程接口白名单抽取成功', Array.isArray(remotePaths) && remotePaths.length > 0, JSON.stringify(remotePaths));
check('云编译接口不在远程接口白名单里',
    Array.isArray(remotePaths)
    && !remotePaths.includes('/api/cloudCompilation') && !remotePaths.includes('/api/getCloudCompilationResult'),
    JSON.stringify(remotePaths || null));
const remoteRows = (() => {
    const rows = [];
    const push = (name, cond, extra = '') => rows.push({ name, cond, extra });
    const body = callbackBody(mainSource, /ipcMain\.handle\(\s*'fetch-remote-json'/);
    push('远程接口代理回调抽取成功', body.startsWith('{'), body.slice(0, 30));
    if (!body.startsWith('{') || !Array.isArray(remotePaths)) return Promise.resolve(rows);
    const calls = [];
    const ctx = vm.createContext({
        ALLOWED_REMOTE_API_PATHS: new Set(remotePaths),
        REMOTE_API_ORIGIN: 'https://remote.invalid',
        t: (key, params) => params ? `${key}|${JSON.stringify(params)}` : key,
        logError: () => { },
        JSON, String, Number, Object, Array, Error, RegExp, Promise,
        axios: {
            get: (url, opt) => { calls.push(['get', url, opt]); return Promise.resolve({ status: 200, statusText: 'OK', data: { rows: 1 } }); },
            post: (url, data, opt) => { calls.push(['post', url, opt]); return Promise.resolve({ status: 200, statusText: 'OK', data: {} }); }
        }
    });
    const handler = vm.runInContext(`(async (_event, spec) => ${body})`, ctx);
    const settle = async (spec) => {
        try { return { ok: true, value: await handler(null, spec) }; }
        catch (e) { return { ok: false, message: String(e && e.message) }; }
    };
    const allowedPath = remotePaths[0];
    return (async () => {
        calls.length = 0;
        const denied = await settle({ path: '/api/cloudCompilation' });
        push('白名单外的接口直接拒绝，且一次请求都不发（拒绝原因带上被拒路径）',
            !denied.ok && calls.length === 0
            && denied.message === 'error.remoteApiNotAllowed|{"path":"/api/cloudCompilation"}',
            JSON.stringify({ denied, calls: calls.length }));
        calls.length = 0;
        const badSpec = await Promise.all([
            settle(null), settle('/api/x'), settle({}), settle({ path: '' }), settle({ path: 42 })
        ]);
        push('spec 形状不对（null / 字符串 / 缺 path / 空 / 非字符串）一律拒绝且不发请求',
            badSpec.every((r) => !r.ok && r.message === 'error.invalidRequestParams') && calls.length === 0,
            JSON.stringify(badSpec.map((r) => [r.ok, r.message])));
        calls.length = 0;
        const ok = await settle({ path: allowedPath });
        push('白名单内走 GET，URL 拼在代理域下、带 15s 超时',
            ok.ok && calls.length === 1 && calls[0][0] === 'get'
            && calls[0][1] === `https://remote.invalid${allowedPath}` && calls[0][2].timeout === 15000,
            JSON.stringify(calls[0]));
        calls.length = 0;
        const q = await settle({ path: `${allowedPath}?page=2` });
        push('鉴权只看 ? 之前的路径，query 原样带给上游',
            q.ok && calls.length === 1 && calls[0][1] === `https://remote.invalid${allowedPath}?page=2`,
            JSON.stringify(calls[0] && calls[0][1]));
        calls.length = 0;
        const tricks = await Promise.all([
            settle({ path: allowedPath.toUpperCase() }),
            settle({ path: `${allowedPath}/../cloudCompilation` }),
            settle({ path: '//cloudCompilation' }),
            settle({ path: `${allowedPath} ` })
        ]);
        push('大小写 / .. / 前缀 // / 尾空格都不构成放行（严格全等匹配）',
            tricks.every((r) => !r.ok) && calls.length === 0, JSON.stringify(tricks.map((r) => r.ok)));
        calls.length = 0;
        const post = await settle({ path: allowedPath, method: 'post' });
        push('非 GET 方法拒绝，且不发请求', !post.ok && calls.length === 0,
            JSON.stringify({ post, calls: calls.length }));
        calls.length = 0;
        const bodyText = await (async () => {
            ctx.axios.get = (url) => { calls.push(['get', url, {}]); return Promise.resolve({ status: 500, data: 'not json {' }); };
            return settle({ path: allowedPath });
        })();
        push('上游返回非 JSON 时 data 归 null，状态码原样回报，不谎报 ok',
            bodyText.ok && bodyText.value.status === 500 && bodyText.value.data === null
            && bodyText.value.ok === false, JSON.stringify(bodyText.value));
        return rows;
    })().then((r) => r, (e) => [{ name: '远程接口代理守卫自身跑通', cond: false, extra: String((e && e.stack) || e) }]);
})();

// 云编译入口在读取源码前就被禁用。断言只认语义（方法体仅提示禁用），
// 不锁死 t() 的调用语法——调用形式已按 AGENTS.md 规范统一为 window.i18n.t，
// 锁死字面量会在无安全影响的纯重构上误报。
{
    const compileManagerSource = read('src/renderer/js/compile-manager.js');
    const body = classMethod(compileManagerSource, 'cloudCompileCurrentFile');
    check('方法体抽取成功: cloudCompileCurrentFile', body.length > 0);
    check('cloud compiler method is disabled before reading source',
        /cloudCompile\.disabled/.test(body) && !/getActiveFile|readFile|currentContent|electronAPI/.test(body));
}
// ---- run-program：shell 串拦截 + 走不走 invoke 白名单 ----
//
// 原来两条都是比源码字面量。拦截逻辑就一个 `if (/regex/) throw`，
// 抽出来真跑一遍，正则退化（漏了 pwsh、掉了 i 标志、把 \/c 写成 /c）立刻显形，
// 而 `mainSource.includes('Shell command strings are disabled')` 对这些都无感。
{
    const shellIf = ifStatement(mainSource, /^\s*if \(\/\^\\s\*\(\?:cmd/m);
    check('run-program 的 shell 串拦截语句抽取成功', shellIf.startsWith('if ('), JSON.stringify(shellIf.slice(0, 46)));
    const guard = new Function('executablePath', `${shellIf} return 'pass';`);
    const rejects = (p) => { try { guard(p); return false; } catch (_) { return true; } };
    const SHELL_FORMS = ['cmd /c dir', 'CMD.EXE /c dir', '  cmd /c x',
        'powershell -command "x"', 'PowerShell.EXE -Command x', 'pwsh -Command x'];
    check('cmd / powershell / pwsh 包装串一律拒绝（大小写与前置空白都算）',
        SHELL_FORMS.every(rejects), JSON.stringify(SHELL_FORMS.filter((p) => !rejects(p))));
    const PLAIN_EXES = ['./main.exe', 'C:\\MinGW\\bin\\g++.exe', 'commander /c x', '/bin/ls'];
    check('普通可执行文件路径不误伤（拦截只认开头的 shell 包装）',
        PLAIN_EXES.every((p) => !rejects(p)), JSON.stringify(PLAIN_EXES.filter(rejects)));
}
// preload 侧：通道名在不在白名单里问真集合，参数转发顺序抽出来真调一次。
const invokeChannels = setMembers(preloadSource, 'ALLOWED_INVOKE_CHANNELS');
check('invoke 通道白名单抽取成功', Array.isArray(invokeChannels) && invokeChannels.length > 0,
    JSON.stringify(invokeChannels || null).slice(0, 40));
check('run-program 在 invoke 白名单里', (invokeChannels || []).includes('run-program'),
    String((invokeChannels || []).length));
{
    const bridge = (/^\s*runProgram:\s*((?:async\s*)?\([^)]*\)\s*=>.*)$/m.exec(preloadSource)?.[1] || '')
        .replace(/,\s*$/, '');
    check('runProgram 桥接抽取成功', bridge.startsWith('('), JSON.stringify(bridge.slice(0, 40)));
    const sent = [];
    const runProgram = new Function('safeIpcRenderer', `return (${bridge});`)(
        { invoke: (channel, ...args) => { sent.push([channel, ...args]); return 'rv'; } });
    const rv = runProgram('./main.exe', 'stdin', 2000, 256);
    check('runProgram 把四个参数按原顺序转给 run-program 通道，返回值原样透传',
        sent.length === 1 && JSON.stringify(sent[0]) === JSON.stringify(['run-program', './main.exe', 'stdin', 2000, 256])
        && rv === 'rv', JSON.stringify({ sent, rv }));
}

check('GDB breakpoint snapshot API exists', gdbSource.includes('getBreakpoints()'));
check('GDB command timeout is implemented', gdbSource.includes('MI_COMMAND_TIMEOUT_MS'));
check('GDB uses structured MI2 records', gdbSource.includes('--interpreter=mi2') && gdbSource.includes('GdbMiStream'));
check('comparer rejects truncated output', workerSource.includes('output_limit') && workerSource.includes('MAX_WORKER_OUTPUT_BYTES'));
check('comparer uses one output normalization policy', workerSource.includes('function outputsEqual'));
check('workflows do not depend on the Node 22-only system CA flag', !workflows.includes('--use-system-ca'));
check('markdown fallback does not assign untrusted innerHTML', !preloadSource.includes('innerHTML'));
check('Linux hard memory limits use a non-shell prlimit wrapper', read('src/utils/process-supervisor.js').includes('getResourceLimitedSpawn') && read('src/utils/process-supervisor.js').includes('prlimit'));
check('native fastspawn has a reproducible POSIX build script', read('scripts/build-fastspawn.js').includes('node-gyp') && read('binding.gyp').includes('fastspawn.cc'));
check('release downloaders share one hardened implementation', read('scripts/lib/release-downloader.js').includes('maxRedirects') && read('scripts/download-clangd.js').includes('createReleaseDownloader') && read('scripts/download-clang-format.js').includes('createReleaseDownloader'));
check('disabled automatic update checks cannot leave UI busy', !mainSource.includes('function checkDailyUpdate') && !mainSource.includes('setAutoUpdateCheckInProgress(true)'));
check('disabled update checks have no remote fallback', !mainSource.includes('oicpp.mywwzh.top/api/checkUpdate') && !mainSource.includes('oicpp.mywwzh.top/api/getUpdateFilelist') && !mainSource.includes('downloadAndInstallUpdate'));
check('renderer Buffer bridge is removed', !preloadSource.includes("exposeInMainWorld('Buffer'") && !rendererMainSource.includes('window.Buffer') && rendererMainSource.includes('new Uint8Array(arrayBuffer)') && rendererMainSource.includes('btoa(binary)'));
// 渲染层三段生命周期：启动顺序、PDF 监听注销、透明度预览防抖。
// 这三条原来都是「比源码长相」的文本守卫，改成在假 DOM 里真跑一遍。
//
// 引导正文只用 callStatement 截 document.addEventListener(...) 这一条语句，
// 不能拿 lastIndexOf('});') 收尾 —— init.js 后面还有 initializeApp 等大段代码，
// 那样切出来的是半个文件。被调方 setUserIconPath 用 funcDecl 单独抽出来真跑，
// initializeApp 是别的文件里的东西，这里只留桩观测顺序。
const deferredRows = (async () => {
    const rows = [];
    const push = (name, cond, extra = '') => rows.push({ name, cond, extra });

    const bootstrap = callStatement(rendererInitSource, /^\s*document\.addEventListener\(\s*'DOMContentLoaded'/m);
    const setIcon = funcDecl(rendererInitSource, 'setUserIconPath');
    push('首屏引导正文抽取成功', bootstrap.startsWith('document.addEventListener'), String(bootstrap).slice(0, 40));
    push('setUserIconPath 正文抽取成功', setIcon.startsWith('async function setUserIconPath'), String(setIcon).slice(0, 40));

    // seq 记观察到的调用次序；iconEl.src 用 setter 记账，赋值即落一条 seq。
    // i18n.init / initializeApp 都拆成 start + end 两条，end 落在微任务之后 ——
    // 少一个 await 就会让下一步插到 start 和 end 之间，顺序断言才有鉴别力。
    let deferMs = 0;
    const mkHarness = (opts) => {
        const seq = [];
        const step = () => Promise.resolve();
        const imgStub = class HTMLImageElement { };
        // iconEl 必须挂在 imgStub.prototype 上，否则源码里的
        // `appIcon instanceof HTMLImageElement` 判假，src 永远不会被写。
        const iconEl = Object.create(imgStub.prototype);
        Object.defineProperty(iconEl, 'src', { set: (v) => seq.push(`icon:${v}`), get: () => '' });
        let pending = null;
        deferMs = 0;
        const ctx = vm.createContext({
            document: {
                addEventListener: (type, fn) => { seq.push(`listen:${type}`); pending = fn(); },
                getElementById: () => iconEl
            },
            HTMLImageElement: imgStub,
            initializeApp: async () => { seq.push('app:start'); await step(); await step(); seq.push('app:end'); },
            logInfo: () => { }, logWarn: (m) => { seq.push(`warn:${String(m).slice(0, 12)}`); },
            logError: (m) => { seq.push(`error:${String(m).slice(0, 12)}`); },
            setTimeout: (fn, ms) => { deferMs = ms; seq.push('defer'); fn(); },
            Date, JSON, Math, Number, String, Boolean, Array, Object, Error, RegExp, Promise, Map, Set,
            window: {
                i18n: opts.i18n === undefined ? {
                    init: async () => { seq.push('i18n.init'); await step(); seq.push('i18n.done'); },
                    enableAutoTranslate: () => { seq.push('autoTranslate'); }
                } : opts.i18n,
                electronAPI: { getUserIconPath: async () => (opts.iconFails ? null : '/icons/me.png') },
                dialogManager: opts.dialogManager
            }
        });
        vm.runInContext(`${setIcon};`, ctx);
        vm.runInContext(bootstrap, ctx);
        return { seq, ctx, done: () => pending };
    };

    {
        const h = mkHarness({});
        await h.done();
        const order = h.seq.map(String);
        push('R14 首屏顺序：图标 → i18n → 应用主体 → 弹窗定时器，一步都不许抢跑',
            JSON.stringify(order) === JSON.stringify([
                'listen:DOMContentLoaded', 'icon:/icons/me.png', 'i18n.init', 'i18n.done',
                'autoTranslate', 'app:start', 'app:end', 'defer'
            ]) && deferMs > 0, JSON.stringify({ order, deferMs }));
        push('R14 图标真的写进了 <img src>（不是只调了函数）',
            order.includes('icon:/icons/me.png'), JSON.stringify(order));
    }
    {
        // i18n 初始化失败不能把首屏一起拖死
        const h = mkHarness({ i18n: { init: async () => { throw new Error('语言包读不到'); } } });
        let uncaught = null;
        try { await h.done(); } catch (e) { uncaught = e; }
        const order = h.seq.map(String);
        push('R14 i18n 炸了要就地接住：不往外抛、记一条 error、应用主体照旧初始化',
            uncaught === null && order.some((s) => s.startsWith('error:i18n')) &&
            order.indexOf('app:start') > -1 && order.includes('defer'),
            `${uncaught && uncaught.message}|${JSON.stringify(order)}`);
    }
    {
        // 图标读取失败（getUserIconPath 返回空）也不能挡住后面的步骤
        const h = mkHarness({ iconFails: true, i18n: false });
        let uncaught = null;
        try { await h.done(); } catch (e) { uncaught = e; }
        const order = h.seq.map(String);
        push('R14 没有用户图标时不设 src、i18n 缺席时跳过，首屏仍走完',
            uncaught === null && !order.some((s) => s.startsWith('icon:')) &&
            !order.includes('i18n.init') && order.includes('app:start'),
            `${uncaught && uncaught.message}|${JSON.stringify(order)}`);
    }
    {
        // 编译器设置页监听绑定：原来锁 `if (this._eventListenersBound) return` 的排版，
        // 换成「第二次调用不产生任何新监听」的行为断言。
        const setupSrc = classMethod(compilerSettingsSource, 'setupEventListeners');
        push('方法体抽取成功: CompilerSettings.setupEventListeners', setupSrc.length > 0);
        let listeners = [];
        let navCalls = 0;
        const els = {};
        const el = (id) => (els[id] || (els[id] = {
            addEventListener: (t) => { listeners.push(`${id}:${t}`); }
        }));
        const spy = () => { };
        const self = new Proxy({
            _eventListenersBound: false,
            setupSidebarNavigation: () => { navCalls++; },
            getCurrentPlatform: () => Promise.resolve('windows')
        }, { get: (target, key) => (key in target ? target[key] : spy) });
        const ctx = vm.createContext({
            document: { getElementById: el },
            window: { i18n: { t: (k) => k }, electronAPI: {} },
            logInfo: () => { }, logError: () => { }, logWarn: () => { },
            setTimeout, clearTimeout, console,
            JSON, Math, Number, String, Boolean, Array, Object, Error, RegExp, Promise, Map, Set
        });
        const setup = compileMethod(ctx, setupSrc);
        push('setupEventListeners 编译成可调用函数', setup !== null && typeof setup === 'function');
        let firstErr = null;
        try { setup.call(self); await Promise.resolve(); await Promise.resolve(); } catch (e) { firstErr = e; }
        const firstCount = listeners.length;
        listeners = [];
        let secondErr = null;
        try { setup.call(self); } catch (e) { secondErr = e; }
        push('R14 重复绑定被幂等守卫拦住：第二次调用零新增监听、零导航重建',
            firstErr === null && firstCount >= 3 && secondErr === null &&
            listeners.length === 0 && navCalls === 1,
            JSON.stringify({ firstCount, second: listeners, navCalls, firstErr: String(firstErr && firstErr.message), secondErr: String(secondErr && secondErr.message) }));
    }
    {
        // 透明度预览：原来只 includes 一句 sendSettingsPreview 的字面量，
        // 换成「连续拖动只发最后一次、前一个定时器被取消」的行为断言。
        const handlerSrc = arrowExpr(editorSettingsSource, /opacityInput\.addEventListener\(\s*'input',\s*/);
        push('透明度 input 回调抽取成功', handlerSrc.startsWith('('), String(handlerSrc).slice(0, 30));
        let handles = 0;
        const scheduled = [];
        const cancelled = [];
        const sends = [];
        const opacityValue = { textContent: '' };
        const ctx = vm.createContext({
            opacityValue,
            window: { electronAPI: { sendSettingsPreview: (p) => sends.push(p) } },
            Math, JSON, String, Number, Object, Error,
            setTimeout: (fn, ms) => { handles++; scheduled.push({ id: handles, fn, ms }); return handles; },
            // 首次触发时 this.opacityTimeout 还是 undefined，clearTimeout(undefined) 是正常调用，
            // 只统计「确实取消了一个待发预览」的次数
            clearTimeout: (h) => {
                const t = scheduled.find((s) => s.id === h && !s.done);
                if (t) { t.done = true; cancelled.push(h); }
            }
        });
        const handler = vm.runInContext(`(${handlerSrc})`, ctx);
        const self = { opacityTimeout: undefined };
        const fire = (value) => { ctx.opacityInput = { value }; handler.call(self, { target: { value } }); };
        const flush = () => { for (const s of scheduled) if (!s.done) { s.done = true; s.fn(); } };
        const reset = () => { scheduled.length = 0; cancelled.length = 0; sends.length = 0; opacityValue.textContent = ''; };
        let err = null;
        try { fire('30'); fire('80'); flush(); } catch (e) { err = e; }
        push('R14 透明度预览防抖：连拖两次只取消前一个定时器，最终只发最后一次且取末值',
            err === null && cancelled.length === 1 && sends.length === 1 &&
            Math.abs(sends[0].windowOpacity - 0.2) < 1e-9 && opacityValue.textContent === '80%',
            JSON.stringify({ err: String(err && err.message), cancelled, sends, label: opacityValue.textContent }));
        reset();
        fire('40');
        push('R14 预览走的是延时通道：触发瞬间一次都不发，只有一个正延时的定时器挂着',
            sends.length === 0 && scheduled.length === 1 && scheduled[0].ms > 0,
            JSON.stringify({ sends, ms: scheduled.map((s) => s.ms) }));
        flush();
        reset();
        err = null;
        try { fire('100'); flush(); } catch (e) { err = e; }
        push('R14 透明度钳制：超过 0.8 的透明度按 0.8 算（窗口不会被拖成全透明，回显跟着钳）',
            err === null && sends.length === 1 && Math.abs(sends[0].windowOpacity - 0.2) < 1e-9 &&
            opacityValue.textContent === '80%',
            JSON.stringify({ err: String(err && err.message), sends, label: opacityValue.textContent }));
    }
    return rows;
})().catch((error) => [{
    name: 'R14 渲染层异步守卫自身跑通',
    cond: false,
    extra: String((error && error.stack) || error)
}]);

{
    const disposeCtx = vm.createContext({ window: null, typeofCheck: undefined });
    const removed = [];
    const pdfFn = function pdfHandler() { };
    const beforeUnload = function beforeUnloadHandler() { };
    const disposeSelf = { handlePdfViewerMessage: pdfFn, _beforeUnloadHandler: beforeUnload };
    const dispose = compileMethod(disposeCtx, classMethod(tabsSource, 'dispose'));
    check('方法体抽取成功: TabManager.dispose', dispose !== null);
    disposeCtx.window = { removeEventListener: (t, fn, opt) => { removed.push([t, fn === pdfFn ? 'pdf' : (fn === beforeUnload ? 'beforeunload' : 'other'), opt]); } };
    if (dispose) dispose.call(disposeSelf);
    check('R14 关标签管理器时把 message 监听摘干净（窗口级监听不会越积越多）',
        removed.some((r) => r[0] === 'message' && r[1] === 'pdf' && r[2] === false),
        JSON.stringify(removed));
    check('R14 beforeunload 摘掉后句柄置空（重复 dispose 不再摘第二遍）',
        removed.some((r) => r[0] === 'beforeunload' && r[1] === 'beforeunload') &&
        disposeSelf._beforeUnloadHandler === null,
        JSON.stringify({ removed, handler: String(disposeSelf._beforeUnloadHandler) }));
    removed.length = 0;
    if (dispose) dispose.call(disposeSelf);
    // message 那半边源码没置空，再 dispose 一次会再摘一遍（幂等由浏览器兜着）；
    // beforeunload 句柄已经置空，第二次绝不该再摘 —— 这才是「置空」这条语义的可观测点。
    check('R14 同一实例再 dispose 一次不再重摘 beforeunload（置空真的生效）',
        !removed.some((r) => r[0] === 'beforeunload'), JSON.stringify(removed));
    removed.length = 0;
    if (dispose) dispose.call({ handlePdfViewerMessage: null, _beforeUnloadHandler: null });
    check('R14 没绑过的实例 dispose 不该乱摘（removeEventListener 一次都不发）',
        removed.length === 0, JSON.stringify(removed));
}

check('startup font validation stays local', !settingsInitSource.includes('updateSettings({ font: validatedFont })') && settingsInitSource.includes('fontFamily = validatedFont'));
check('downloader releases probe response bodies', (downloaderSource.match(/\.body\.resume\(\)/g) || []).length >= 3);
check('comparer tracks all children and observes stop between awaits', workerSource.includes('const activeProcesses = new Set()') && !workerSource.includes('currentProc') && (workerSource.match(/if \(!running\)\s+break;/g) || []).length >= 3);
check('uninstaller preserves foreign cpp associations', installerSource.includes('ReadRegStr $0 HKCR ".cpp" ""') && installerSource.includes('${If} $0 == "OICPPIDE.cpp"') && !installerSource.includes('DeleteRegKey HKCR ".cpp"'));
check('sharp is build-only', !Object.hasOwn(packageJson.dependencies, 'sharp') && Object.hasOwn(packageJson.devDependencies, 'sharp'));
check('CI icon boundary matching is exact', ciSource.includes('/oicpp\\.ico(?=$|[^-])/'));
check('CI secret detections fail the build', ciSource.includes("fail(`potential secret in ${rel}`)"));

// 同步断言先跑完，再补上假 DOM 那批（它们是 promise，微任务里才落地）。
// 汇总必须等这一批落地后才能数 failures，否则 exitCode 会停在 0。
Promise.all([deferredRows, remoteRows])
    .then((batches) => { for (const rows of batches) for (const row of rows) check(row.name, row.cond, row.extra); })
    .then(() => {
        console.log(`security regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
        process.exitCode = failures ? 1 : 0;
    });
