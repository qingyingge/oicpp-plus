'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { callStatement, classMethod, compileMethod, arrowExpr, funcDecl } = require('./fixtures/source-extract');

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

check('cloud compilation endpoint is no longer allowlisted', !mainSource.includes("'/api/cloudCompilation'") && !mainSource.includes("'/api/getCloudCompilationResult'"));
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
check('run-program rejects shell command strings', !mainSource.includes("executablePath.startsWith('cmd /c ')") && mainSource.includes('Shell command strings are disabled'));
check('run-program is routed through the invoke whitelist', preloadSource.includes("'run-program'") && preloadSource.includes("safeIpcRenderer.invoke('run-program'"));
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
deferredRows
    .then((rows) => { for (const row of rows) check(row.name, row.cond, row.extra); })
    .then(() => {
        console.log(`security regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
        process.exitCode = failures ? 1 : 0;
    });
