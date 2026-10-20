'use strict';

// 覆盖安全收紧批次：路径包含判定、工作区删除边界、语言代码白名单、外部协议白名单。
// 这些都是「收紧」类改动，风险不在于会不会报错，而在于有没有把正常功能一起挡掉，
// 所以断言必须同时覆盖「该拒的拒了」和「该放的放了」两侧。
//
// 本版把剩下那批「拿正则比源码」的守卫换成「把真实函数 / IPC handler 抽出来跑」：
// 源码字面量还在，只证明没人删那一行，证明不了校验真的接在删除路径上、
// 两道校验的顺序没写反、也证明不了它没把正常路径一起挡掉。
//
// 抽取一律走 tests/fixtures/source-extract.js，取不到就是空串；所以每条断言之前
// 先断言「抽取成功」，让失败停在抽取这一步，而不是漂到后面的 `!/xxx/.test('')` 上真空通过。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const { callbackBody, funcDecl, scalarConst } = require('./fixtures/source-extract');

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

// 主流程要是挂在某个不 settle 的 await 上，node 会静默退出 0，看着像全绿
const watchdog = setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾（疑似卡在某个 await 上）');
    process.exit(1);
}, 60000);

const ROOT = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');

// 行为测试里实际用到的 i18n 键，最后拿去跟语言包对账
const observedKeys = [];

// ---------------------------------------------------------------------------
// 编译工具：把 main.js 里的函数 / ipcMain handler 抽出来，在独立 vm 里跑
// ---------------------------------------------------------------------------

// 每个场景一个新 context：currentExternalWorkspacePath、debugSessionRootDir 这类
// 模块级可变绑定要按场景注入，共用 context 会串味。
function makeScope(extraGlobals) {
    const calls = { logWarn: [], logInfo: [], logError: [], t: [] };
    const ctx = vm.createContext({
        path, os, fs, URL, Map, Set, JSON, Math, Date, RegExp, Error,
        String, Number, Boolean, Array, Object, Promise,
        logWarn: (...a) => { calls.logWarn.push(a.map(String)); },
        logInfo: (...a) => { calls.logInfo.push(a.map(String)); },
        logError: (...a) => { calls.logError.push(a.map(String)); },
        // 主进程的 t 是 i18n 入口；这里回显 key —— 既能断言「用的是哪个键」，
        // 又不会把安全守卫锁死在译文上（改译文不该弄红它）
        t: (key) => { calls.t.push(key); observedKeys.push(key); return key; },
        ...extraGlobals
    });
    return { ctx, calls };
}

// 顶层函数声明：抽出整段 body，连同它自己编译，返回 { body, fn }
function compileFn(name, scope) {
    const body = funcDecl(mainSource, name);
    if (!body) return { body, fn: undefined };
    vm.runInContext(`${body}\nthis.__fn = ${name};`, scope.ctx);
    return { body, fn: scope.ctx.__fn };
}

// ipcMain.handle('x', async (a, b) => { ... }) 的回调。
// 形参名由调用方给，不锁源码里的名字 —— 形参改名属于纯重构，锁死就会误报。
function compileHandler(anchor, params, scope) {
    const body = callbackBody(mainSource, anchor);
    if (!body) return { body, fn: undefined };
    vm.runInContext(`this.__fn = async (${params.join(', ')}) => ${body};`, scope.ctx);
    return { body, fn: scope.ctx.__fn };
}

// 把 scope 里的 fs 换成记录代理：仍然打到真实磁盘，这样
// 「一次磁盘访问都没发生」这种断言才是可证的。
function countingFs(scope, record) {
    const wrap = (target) => new Proxy(target, {
        get(t, k) {
            const value = t[k];
            if (k === 'promises') return wrap(value);
            if (typeof value === 'function') {
                return (...args) => { record.push(String(k)); return value.apply(t, args); };
            }
            return value;
        }
    });
    scope.ctx.fs = wrap(fs);
    return record;
}

// 让模块级可变绑定跟着场景走（函数体里按自由变量读，取到的是当前值）
function liveBinding(scope, name, box) {
    Object.defineProperty(scope.ctx, name, { get: () => box[name], configurable: true });
}

// ---------------------------------------------------------------------------
// preload 沙箱：假 electron + 假 DOM，只为把真正暴露给渲染层的那个函数跑起来
// ---------------------------------------------------------------------------

class FakeElement {
    constructor(attrs = {}, tagName = 'DIV') {
        this.attrs = attrs;
        this.tagName = tagName;
        this.className = '';
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    closest(selector) {
        if (selector === 'a[href]' && this.tagName === 'A') return this;
        if (selector === '.copy-code-btn' && this.className === 'copy-code-btn') return this;
        return null;
    }
}
class FakeAnchor extends FakeElement {
    constructor(href) { super({ href }, 'A'); }
}

function bootPreload(workdir) {
    const exposed = {};
    const rawShellCalls = [];
    const listeners = [];
    const electronStub = {
        contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
        ipcRenderer: {
            on: () => () => { }, once: () => { }, off: () => { },
            send: () => { }, sendSync: () => undefined, postMessage: () => { },
            invoke: () => Promise.resolve(undefined),
            removeListener: () => { }, removeAllListeners: () => { }
        },
        shell: {
            openExternal: (...a) => { rawShellCalls.push(a); return Promise.resolve(); },
            showItemInFolder: () => { }, openPath: () => Promise.resolve('')
        },
        clipboard: { writeText: () => { }, readText: () => '' }
    };
    const modules = { electron: electronStub, path, os, fs };
    const windowStub = {
        addEventListener: (type, fn, capture) => { listeners.push({ type, fn, capture }); },
        removeEventListener: () => { },
        document: { addEventListener: () => { }, body: null },
        location: { href: 'http://127.0.0.1:8080/index.html' },
        i18n: { t: (k) => k }
    };
    const ctx = vm.createContext({
        require: (id) => {
            if (!(id in modules)) throw new Error('preload 需要未预期的模块: ' + id);
            return modules[id];
        },
        console: { log: () => { }, warn: () => { }, error: () => { }, info: () => { }, debug: () => { } },
        process: { platform: process.platform, env: {}, versions: { node: process.versions.node }, cwd: () => workdir },
        URL, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, queueMicrotask,
        TextEncoder, TextDecoder, AbortController,
        HTMLElement: FakeElement, HTMLAnchorElement: FakeAnchor, Element: FakeElement,
        document: undefined,
        window: windowStub,
        __dirname: path.join(ROOT, 'src'), __filename: path.join(ROOT, 'src', 'preload.js'),
        module: { exports: {} }, exports: {}
    });
    let error = null;
    try {
        vm.runInContext(preloadSource, ctx, { filename: 'src/preload.js' });
    } catch (e) { error = e; }
    let declaredWhitelist = null;
    try {
        // 顶层 const 落在该 context 的词法环境里，后续 runInContext 读得到
        declaredWhitelist = vm.runInContext('[...ALLOWED_EXTERNAL_PROTOCOLS]', ctx);
    } catch (_) { /* 声明形态变了，交给下面的抽取断言报红 */ }
    return { exposed, rawShellCalls, electronStub, listeners, declaredWhitelist, error, ctx };
}

// 白名单是「配置」不是「行为」，按数据读出来，别拿正则锁字面量的排版
function readDeclaredWhitelist(src) {
    const m = /const ALLOWED_EXTERNAL_PROTOCOLS\s*=\s*new\s+Set\(\[([^\]]*)\]\)/.exec(src);
    if (!m) return null;
    return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

// 用户数据目录名也从源码里读，测试不复制第二份配置
const USER_DATA_DIR_NAME = (mainSource.match(/const USER_DATA_DIR_NAME\s*=\s*'([^']+)'/) || [])[1];

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
    check('USER_DATA_DIR_NAME 读到了',
        typeof USER_DATA_DIR_NAME === 'string' && USER_DATA_DIR_NAME.length > 0, String(USER_DATA_DIR_NAME));
    check('main.js 读到了内容', mainSource.length > 100000, `${mainSource.length} 字符`);
    check('preload.js 读到了内容', preloadSource.length > 20000, `${preloadSource.length} 字符`);

    // 真实落盘的临时目录：才能证明「拒了」等于「文件没被删 / 没被写」
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-boundary-'));
    const mk = (prefix) => fs.mkdtempSync(path.join(sandboxRoot, prefix + '-'));
    const mkFile = (dir, name, content = 'DATA') => {
        const full = path.join(dir, name);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
        return full;
    };

    // ============ 0. 协议白名单：取源码里真实声明的那一份 ============
    // 原先 main 的白名单是手抄一份注进测试的，生产把 'file:' 加回去时
    // 行为测试照样全绿 —— 自证式守卫，等于没 guard。
    const mainWhitelist = readDeclaredWhitelist(mainSource);
    check('main 的协议白名单声明抽到了', Array.isArray(mainWhitelist) && mainWhitelist.length > 0,
        JSON.stringify(mainWhitelist));
    check('main 白名单恰好是 http/https/mailto（与顺序无关）',
        Array.isArray(mainWhitelist) && [...mainWhitelist].sort().join(',') === 'http:,https:,mailto:');
    check('main 白名单不含 file:', !!mainWhitelist && !mainWhitelist.includes('file:'));

    // ============ A1: isPathInsideDir —— 抽真实的函数来跑 ============
    const dirScope = makeScope({});
    const { body: insideDirBody, fn: isPathInsideDir } = compileFn('isPathInsideDir', dirScope);
    check('函数抽取成功: isPathInsideDir',
        insideDirBody.length > 0 && typeof isPathInsideDir === 'function', `${insideDirBody.length} 字符`);

    {
        const base = path.join(os.tmpdir(), 'oicpp-test-base');
        check('目录自身判定为在内', isPathInsideDir(base, base) === true);
        check('子目录判定为在内', isPathInsideDir(path.join(base, 'a', 'b'), base) === true);
        // 报告 A1 的核心：缺末尾分隔符时兄弟目录会通过 startsWith 校验
        check('兄弟目录 codeTempEvil 被拒（原 startsWith 漏洞）',
            isPathInsideDir(path.join(os.tmpdir(), 'oicpp-test-baseEvil', 'x'), base) === false);
        check('完全无关的路径被拒', isPathInsideDir(path.join(os.tmpdir(), 'elsewhere', 'x'), base) === false);
        check('前缀相同但不同分段的路径被拒', isPathInsideDir(base + '_other', base) === false);
        check('尾部多一个分隔符仍视为在内',
            isPathInsideDir(path.join(base, 'x') + path.sep, base) === true);
        // 反方向：基准目录自带尾部分隔符时，不能因为多出分隔符把合法路径判死
        check('基准目录带尾部分隔符时仍判得出在内',
            isPathInsideDir(path.join(base, 'x'), base + path.sep) === true &&
            isPathInsideDir(base, base + path.sep) === true);
        check('基准目录带尾部分隔符时兄弟目录照样被拒',
            isPathInsideDir(path.join(os.tmpdir(), 'oicpp-test-baseEvil', 'x'), base + path.sep) === false);
        // path.resolve 会把普通路径的尾部分隔符归一掉，唯独根目录 '/' 会保留那一个
        // —— 不显式剥尾分隔符时，「/ 下的一切都在 / 内」这条会判成 false
        check('以文件系统根目录为基准时仍判得出在内',
            isPathInsideDir('/etc/passwd', '/') === true && isPathInsideDir('/', '/') === true);
        check('大小写不同（Windows 不敏感）仍视为在内',
            isPathInsideDir(base.toUpperCase() + path.sep + 'y', base) === true);
        check('null / 空输入返回 false 而不抛异常',
            isPathInsideDir(null, base) === false && isPathInsideDir(base, null) === false);
        check('非字符串输入也不抛',
            isPathInsideDir(123, base) === false && isPathInsideDir({}, {}) === false);
    }

    // ============ A4: normalizeExternalOpenUrl（注入真实声明的白名单） ============
    const normalizeScope = makeScope({ ALLOWED_EXTERNAL_PROTOCOLS: new Set(mainWhitelist || []) });
    const { body: normalizeBody, fn: normalizeExternalOpenUrl } = compileFn('normalizeExternalOpenUrl', normalizeScope);
    check('函数抽取成功: normalizeExternalOpenUrl',
        normalizeBody.length > 0 && typeof normalizeExternalOpenUrl === 'function', `${normalizeBody.length} 字符`);

    {
        check('http 放行', normalizeExternalOpenUrl('http://example.com') === 'http://example.com/');
        check('https 放行', normalizeExternalOpenUrl('https://example.com/a') === 'https://example.com/a');
        check('mailto 放行', normalizeExternalOpenUrl('mailto:a@b.com') === 'mailto:a@b.com');
        check('file: 被拒', normalizeExternalOpenUrl('file:///C:/Windows/System32/calc.exe') === '');
        check('ms-settings: 被拒', normalizeExternalOpenUrl('ms-settings:display') === '');
        check('smb: 被拒', normalizeExternalOpenUrl('smb://host/share') === '');
        check('javascript: 被拒', normalizeExternalOpenUrl('javascript:alert(1)') === '');
        check('data: 被拒', normalizeExternalOpenUrl('data:text/html,<script>') === '');
        check('大写协议按解析后的小写判定（HTTPS 仍放行）',
            normalizeExternalOpenUrl('HTTPS://example.com/x') === 'https://example.com/x');
        check('非 URL 字符串被拒而非原样透传', normalizeExternalOpenUrl('not a url at all') === '');
        check('空串 / null / undefined 返回空而不抛',
            normalizeExternalOpenUrl('') === '' && normalizeExternalOpenUrl(null) === '' &&
            normalizeExternalOpenUrl(undefined) === '');
        check('白名单外的协议一律返回空串',
            ['file:', 'ftp:', 'chrome:', 'view-source:'].every((p) => normalizeExternalOpenUrl(`${p}//host/x`) === ''));
        check('被拒的协议会留日志（用户点了没反应时查得到）',
            normalizeScope.calls.logWarn.some((row) => row.join(' ').includes('拒绝非白名单协议')),
            JSON.stringify(normalizeScope.calls.logWarn[0]));
    }

    // ============ A4: preload —— 整个文件在沙箱里跑起来 ============
    const boot = bootPreload(sandboxRoot);
    check('preload 在沙箱里加载成功', boot.error === null, boot.error ? boot.error.message : '');
    const bridge = boot.exposed.electron && boot.exposed.electron.shell;
    check('preload 暴露了 electron 桥', !!bridge && typeof bridge.openExternal === 'function');

    {
        const moduleBridge = typeof boot.exposed.getElectronModule === 'function'
            ? boot.exposed.getElectronModule().shell : null;
        check('preload 的协议白名单声明抽到了',
            Array.isArray(boot.declaredWhitelist) && boot.declaredWhitelist.length > 0,
            JSON.stringify(boot.declaredWhitelist));
        check('preload 白名单恰好是 http/https/mailto（与顺序无关）',
            Array.isArray(boot.declaredWhitelist) &&
            [...boot.declaredWhitelist].sort().join(',') === 'http:,https:,mailto:');
        check('preload 白名单不含 file:（markdown 预览原先含 file:）',
            !!boot.declaredWhitelist && !boot.declaredWhitelist.includes('file:'));
        check('暴露给渲染层的 openExternal 不是 electron shell 的原样透传',
            !!bridge && bridge.openExternal !== boot.electronStub.shell.openExternal);
        check('getElectronModule() 拿到的也是同一个包了白名单的函数',
            !!moduleBridge && !!bridge && moduleBridge.openExternal === bridge.openExternal);

        const open = bridge && bridge.openExternal;
        const settle = async (url) => {
            const before = boot.rawShellCalls.length;
            let ok = false;
            let message = '';
            try { await open(url); ok = true; } catch (e) { message = String((e && e.message) || e); }
            return { ok, message, hit: boot.rawShellCalls.slice(before) };
        };
        if (open) {
            const https = await settle('https://example.com/a');
            check('preload: https 放行并转发规范化后的 href',
                https.ok && https.hit.length === 1 && https.hit[0][0] === 'https://example.com/a', JSON.stringify(https));
            const mailto = await settle('mailto:a@b.com');
            check('preload: mailto 放行', mailto.ok && mailto.hit.length === 1);
            const file = await settle('file:///etc/passwd');
            check('preload: file: 被拒且没有落到系统 shell',
                !file.ok && file.hit.length === 0 && /protocol not allowed/.test(file.message), file.message);
            const js = await settle('javascript:alert(1)');
            check('preload: javascript: 被拒且不落系统 shell', !js.ok && js.hit.length === 0);
            const smb = await settle('smb://host/share');
            check('preload: smb: 被拒', !smb.ok && smb.hit.length === 0);
            const junk = await settle('not a url');
            check('preload: 非法 URL 以 rejection 表达（不透传、不抛同步异常）',
                !junk.ok && /invalid external url/.test(junk.message) && junk.hit.length === 0, junk.message);
            const nul = await settle(null);
            const undef = await settle(undefined);
            check('preload: null / undefined 被拒而不是打开空 URL',
                !nul.ok && !undef.ok && nul.hit.length === 0 && undef.hit.length === 0);
            const padded = await settle('   https://a.com/x   ');
            check('preload: 先剥前后空白再解析',
                padded.ok && padded.hit.length === 1 && padded.hit[0][0] === 'https://a.com/x', JSON.stringify(padded.hit));
            check('preload: 所有落到系统 shell 的调用都是白名单协议',
                boot.rawShellCalls.every((a) => /^(https?|mailto):/.test(String(a[0]))),
                JSON.stringify(boot.rawShellCalls.map((a) => a[0])));

            // markdown 预览里 ctrl+点击链接的全局监听：file: 链接就是从这儿被挡掉的
            const click = boot.listeners.find((l) => l.type === 'click');
            check('preload 注册了链接点击监听（capture 阶段）', !!click && click.capture === true,
                `${boot.listeners.length} 个监听`);
            if (click) {
                const fire = async (href, modifiers) => {
                    const calls = [];
                    const ev = {
                        target: new FakeAnchor(href),
                        ctrlKey: true,
                        metaKey: false,
                        ...modifiers,
                        preventDefault: () => calls.push('preventDefault'),
                        stopPropagation: () => calls.push('stopPropagation')
                    };
                    const before = boot.rawShellCalls.length;
                    await click.fn(ev);
                    return { calls, hit: boot.rawShellCalls.slice(before) };
                };
                const blocked = await fire('file:///C:/Windows/System32/calc.exe');
                check('markdown 里的 file: 链接被挡：不落系统 shell、也不吞默认行为',
                    blocked.hit.length === 0 && blocked.calls.length === 0, JSON.stringify(blocked));
                const allowed = await fire('https://example.com/doc');
                check('markdown 里的 https 链接照常打开（收紧没把用户功能挡掉）',
                    allowed.hit.length === 1 && allowed.hit[0][0] === 'https://example.com/doc' &&
                    allowed.calls.includes('preventDefault'), JSON.stringify(allowed));
                const anchorOnly = await fire('#toc');
                check('页内锚点不触发外部打开', anchorOnly.hit.length === 0);
                const noModifier = await fire('https://example.com/z', { ctrlKey: false, metaKey: false });
                check('未按 ctrl/cmd 时不劫持点击', noModifier.hit.length === 0);
            }
        }
    }

    // ============ A2: assertDeletableInWorkspace ============
    // 连同真实的 isPathInsideDir / isPathInsideTempRoots 一起组合出来跑
    const HOME = mk('home');
    const CODE_TEMP = path.join(HOME, USER_DATA_DIR_NAME, 'codeTemp');
    const COMPARE_TEMP = path.join(HOME, USER_DATA_DIR_NAME, 'compare');
    fs.mkdirSync(CODE_TEMP, { recursive: true });
    fs.mkdirSync(COMPARE_TEMP, { recursive: true });
    const WORKSPACE = mk('workspace');
    const OUTSIDE = mk('outside');

    // 临时根清单看着是「配置」，但配置也该由运行那条声明得到，而不是用正则切数组字面量：
    // 写成一行、换成 .filter、给 path.join 多加一段 —— 切片要么失配，要么静默少一项。
    const rootsDeclSrc = scalarConst(mainSource, 'TEMP_DELETE_ROOTS');
    check('临时根声明语句按括号配平抽到了', rootsDeclSrc.length > 0,
        rootsDeclSrc.replace(/\s+/g, ' ').slice(0, 70));
    const rootsScope = makeScope({ USER_DATA_DIR_NAME });
    vm.runInContext(`${rootsDeclSrc}\nthis.__roots = TEMP_DELETE_ROOTS;`, rootsScope.ctx);
    const declaredRoots = rootsScope.ctx.__roots;
    const realRootsByLeaf = {};
    for (const dir of Array.isArray(declaredRoots) ? declaredRoots : []) realRootsByLeaf[path.basename(dir)] = dir;
    const HOME_DATA_DIR = path.join(os.homedir(), USER_DATA_DIR_NAME);
    check('真跑出来的临时根恰好是 codeTemp 与 compare 两个（改名、增减都在这里红）',
        Object.keys(realRootsByLeaf).length === 2
        && Object.keys(realRootsByLeaf).sort().join(',') === 'codeTemp,compare',
        JSON.stringify(declaredRoots));
    check('真跑出来的每一项都在用户数据目录里、是绝对路径、且不等于用户数据目录本身',
        Array.isArray(declaredRoots) && declaredRoots.length === 2
        && declaredRoots.every((dir) => path.isAbsolute(dir)
            && dir !== HOME_DATA_DIR && isPathInsideDir(dir, HOME_DATA_DIR) === true),
        JSON.stringify(declaredRoots));
    // 清单与判定之间也要有数据流：只看注入 [codeTemp, compare] 的那批断言，
    // 证明不了源码真声明的那两个目录被 isPathInsideTempRoots 认。
    const realRootsFn = compileFn('isPathInsideTempRoots',
        makeScope({ TEMP_DELETE_ROOTS: declaredRoots })).fn;
    check('真清单接上真判定：两个根各自的产物算临时目录，根自身、同前缀兄弟目录、用户目录里别的文件都不算',
        typeof realRootsFn === 'function' && !!realRootsByLeaf.codeTemp && !!realRootsByLeaf.compare
        && realRootsFn(path.join(realRootsByLeaf.codeTemp, 'std_1.exe')) === true
        && realRootsFn(path.join(realRootsByLeaf.compare, 'a', 'test_1.txt')) === true
        && realRootsFn(realRootsByLeaf.codeTemp) === false
        && realRootsFn(path.join(realRootsByLeaf.codeTemp + 'Evil', 'x')) === false
        && realRootsFn(path.join(HOME_DATA_DIR, 'Documents', 'x.cpp')) === false,
        JSON.stringify(declaredRoots));

    const tempRootsScope = makeScope({ TEMP_DELETE_ROOTS: [CODE_TEMP, COMPARE_TEMP] });
    const { body: tempRootsBody, fn: isPathInsideTempRoots } = compileFn('isPathInsideTempRoots', tempRootsScope);
    check('函数抽取成功: isPathInsideTempRoots',
        tempRootsBody.length > 0 && typeof isPathInsideTempRoots === 'function', `${tempRootsBody.length} 字符`);
    check('isPathInsideTempRoots: codeTemp 下算临时目录',
        isPathInsideTempRoots(path.join(CODE_TEMP, 'std_1.txt')) === true);
    check('isPathInsideTempRoots: compare 下算临时目录',
        isPathInsideTempRoots(path.join(COMPARE_TEMP, 'a', 'b')) === true);
    check('isPathInsideTempRoots: 临时根自身不算（否则能把应用目录整个删掉）',
        isPathInsideTempRoots(CODE_TEMP) === false);
    check('isPathInsideTempRoots: 同前缀兄弟目录 codeTempEvil 不算临时目录',
        isPathInsideTempRoots(path.join(HOME, USER_DATA_DIR_NAME, 'codeTempEvil', 'x')) === false);

    const deletableScope = makeScope({ isPathInsideTempRoots, isPathInsideDir });
    const env = { currentExternalWorkspacePath: undefined };
    liveBinding(deletableScope, 'currentExternalWorkspacePath', env);
    const { body: deletableBody, fn: assertDeletableInWorkspace } = compileFn('assertDeletableInWorkspace', deletableScope);
    check('函数抽取成功: assertDeletableInWorkspace',
        deletableBody.length > 0 && typeof assertDeletableInWorkspace === 'function', `${deletableBody.length} 字符`);

    const tryDeletable = (target) => {
        const warnsBefore = deletableScope.calls.logWarn.length;
        const tBefore = deletableScope.calls.t.length;
        let threw = null;
        try { assertDeletableInWorkspace(target); } catch (e) { threw = e; }
        return {
            threw,
            message: threw ? String(threw.message) : '',
            warned: deletableScope.calls.logWarn.length > warnsBefore,
            keys: deletableScope.calls.t.slice(tBefore)
        };
    };

    env.currentExternalWorkspacePath = WORKSPACE;
    check('工作区内的文件放行', tryDeletable(mkFile(WORKSPACE, 'a.cpp')).threw === null);
    check('工作区自身放行（边界含目录本身）', tryDeletable(WORKSPACE).threw === null);
    const outsideDenied = tryDeletable(mkFile(OUTSIDE, 'x.cpp'));
    check('工作区外的文件被拒',
        outsideDenied.threw !== null && outsideDenied.message === 'error.outsideWorkspace', outsideDenied.message);
    check('工作区外的拒绝记了日志', outsideDenied.warned === true);
    check('拒绝时带回的是 i18n 键而不是硬编码文案',
        outsideDenied.keys.join(',') === 'error.outsideWorkspace', JSON.stringify(outsideDenied.keys));
    const siblingDenied = tryDeletable(path.join(WORKSPACE + 'Evil', 'x.cpp'));
    check('同前缀兄弟目录 workspaceEvil 被拒（startsWith 的原漏洞）',
        siblingDenied.message === 'error.outsideWorkspace');
    check('路径大小写不同仍视为在工作区内（Windows 不敏感）',
        tryDeletable(path.join(WORKSPACE.toUpperCase(), 'A.CPP')).threw === null);

    env.currentExternalWorkspacePath = undefined;
    const noWs = tryDeletable(path.join(os.tmpdir(), 'whatever.cpp'));
    check('未打开工作区时任何普通路径都被拒',
        noWs.threw !== null && noWs.message === 'error.noWorkspaceForDelete', noWs.message);
    check('临时目录不受工作区约束 —— 否则对拍产物删不掉',
        tryDeletable(path.join(CODE_TEMP, 'std_1.txt')).threw === null);
    check('compare 根同样放行', tryDeletable(path.join(COMPARE_TEMP, 'test_1.txt')).threw === null);
    check('临时根的同前缀兄弟目录不放行',
        tryDeletable(path.join(HOME, USER_DATA_DIR_NAME, 'codeTempEvil', 'x.txt')).message === 'error.noWorkspaceForDelete');
    env.currentExternalWorkspacePath = WORKSPACE;

    // ============ A2: 校验确实接在真正的删除路径上 ============
    // 原守卫锁的是 `assertSafeIoPath(filePath);\n assertDeletableInWorkspace(filePath);`
    // 这种两行排版；这里改成跑 handler —— 被拒时磁盘上的文件一个都没少。
    const deletableCalls = [];
    const deletableSpy = (target) => { deletableCalls.push(target); return assertDeletableInWorkspace(target); };

    {
        const fsCalls = [];
        const restores = [];
        const sensitive = new Set([path.join(WORKSPACE, 'secret.key')]);
        const safeScope = makeScope({ isSensitiveIoPath: (p) => sensitive.has(p) });
        const { body: safeBody, fn: assertSafeIoPath } = compileFn('assertSafeIoPath', safeScope);
        check('函数抽取成功: assertSafeIoPath',
            safeBody.length > 0 && typeof assertSafeIoPath === 'function', `${safeBody.length} 字符`);
        const scope = makeScope({
            assertSafeIoPath,
            assertDeletableInWorkspace: deletableSpy,
            markLocalDeletion: () => [{ snapshot: 1 }],
            restoreFileWatchStates: (snapshots) => { restores.push(snapshots); }
        });
        countingFs(scope, fsCalls);
        const { body, fn: handler } = compileHandler(/ipcMain\.handle\('delete-file'/, ['event', 'filePath'], scope);
        check('handler 抽取并编译成功: delete-file', body.length > 0 && typeof handler === 'function',
            `${body.length} 字符`);

        const okTarget = mkFile(WORKSPACE, 'ok/boom.cpp', 'int main(){}');
        const okResult = await handler({}, okTarget);
        check('工作区内：返回 success 且文件真的被删除',
            okResult && okResult.success === true && fs.existsSync(okTarget) === false, JSON.stringify(okResult));
        check('工作区内：调用的是 unlink，成功路径不触发回滚',
            fsCalls.includes('unlink') && restores.length === 0, JSON.stringify(fsCalls));

        const outsideTarget = mkFile(OUTSIDE, 'keep.cpp', 'KEEP');
        const callsBefore = fsCalls.length;
        const spyBefore = deletableCalls.length;
        const outsideResult = await handler({}, outsideTarget);
        check('工作区外：返回失败并把原因带回去',
            outsideResult && outsideResult.success === false && outsideResult.error === 'error.outsideWorkspace',
            JSON.stringify(outsideResult));
        check('工作区外：文件还在、unlink 没被调用',
            fs.existsSync(outsideTarget) === true && !fsCalls.slice(callsBefore).includes('unlink'));
        check('工作区外：校验确实被跑了一遍（不是提前 return 跳过）',
            deletableCalls.length === spyBefore + 1);
        check('失败路径补回了文件监听状态', restores.length === 1);

        const secret = mkFile(WORKSPACE, 'secret.key', 'S');
        const spyBeforeSecret = deletableCalls.length;
        const secretResult = await handler({}, secret);
        check('敏感文件：被 assertSafeIoPath 拦下、文件还在',
            secretResult && secretResult.success === false &&
            secretResult.error === 'error.sensitiveDirBlocked' && fs.existsSync(secret) === true,
            JSON.stringify(secretResult));
        check('敏感校验排在工作区校验之前（顺序反了会先弹「不在工作区」）',
            deletableCalls.length === spyBeforeSecret);

        env.currentExternalWorkspacePath = undefined;
        const noWsTarget = mkFile(WORKSPACE, 'no-ws.cpp', 'N');
        const noWsResult = await handler({}, noWsTarget);
        check('未打开工作区：删除被拒、文件还在',
            noWsResult && noWsResult.success === false && noWsResult.error === 'error.noWorkspaceForDelete' &&
            fs.existsSync(noWsTarget) === true, JSON.stringify(noWsResult));
        const emptyResult = await handler({}, '');
        check('空路径：返回失败而不是删个寂寞', emptyResult.success === false, JSON.stringify(emptyResult));
        env.currentExternalWorkspacePath = WORKSPACE;
    }

    {
        const fsCalls = [];
        const scope = makeScope({
            assertSafeIoPath: (p) => p,
            assertDeletableInWorkspace: deletableSpy,
            markLocalDeletion: () => [],
            restoreFileWatchStates: () => { }
        });
        countingFs(scope, fsCalls);
        const { body, fn: handler } = compileHandler(
            /ipcMain\.handle\('clear-directory-contents'/, ['event', 'dirPath'], scope);
        check('handler 抽取并编译成功: clear-directory-contents',
            body.length > 0 && typeof handler === 'function', `${body.length} 字符`);

        const inWs = path.join(WORKSPACE, 'clear-me');
        fs.mkdirSync(inWs, { recursive: true });
        mkFile(inWs, 'one.txt');
        mkFile(inWs, 'two.txt');
        const spyBefore = deletableCalls.length;
        const rmBefore = fsCalls.filter((c) => c === 'rmSync').length;
        const okResult = await handler({}, inWs);
        check('工作区内目录：清空成功并回报数量',
            okResult && okResult.success === true && okResult.removed === 2, JSON.stringify(okResult));
        check('工作区内目录：目录本身还在、子项没了',
            fs.existsSync(inWs) === true && fs.readdirSync(inWs).length === 0);
        check('清空前确实走了工作区边界校验', deletableCalls.length === spyBefore + 1);
        check('合法清空确实落到磁盘', fsCalls.filter((c) => c === 'rmSync').length === rmBefore + 2,
            JSON.stringify(fsCalls.slice(rmBefore)));

        const keepFile = mkFile(OUTSIDE, 'keepdir/inner.txt');
        const keepResult = await handler({}, path.dirname(keepFile));
        check('工作区外目录：什么都没清、原因带回去',
            keepResult && keepResult.success === false && keepResult.error === 'error.outsideWorkspace' &&
            fs.existsSync(keepFile) === true, JSON.stringify(keepResult));

        const rootResult = await handler({}, path.parse(WORKSPACE).root);
        check('文件系统根目录被拒（原有保护没被工作区校验顶掉）',
            rootResult && rootResult.success === false && typeof rootResult.error === 'string' &&
            rootResult.error.length > 0, JSON.stringify(rootResult));
        check('不存在的目录：返回失败而不是抛异常',
            (await handler({}, path.join(sandboxRoot, 'ghost'))).success === false);
        const fileAsDir = mkFile(WORKSPACE, 'plain.txt');
        check('把文件当目录传：返回失败', (await handler({}, fileAsDir)).success === false);
        check('空白路径：返回失败', (await handler({}, '   ')).success === false);

        // 中途读盘失败（权限 / IO）也要回滚文件监听状态，否则侧栏会一直停在「外部已删除」
        const boomRestores = [];
        const boomScope = makeScope({
            assertSafeIoPath: (p) => p,
            assertDeletableInWorkspace: () => { },
            markLocalDeletion: () => [{ snapshot: 'boom' }],
            restoreFileWatchStates: (snapshots) => { boomRestores.push(snapshots); },
            fs: {
                statSync: () => ({ isDirectory: () => true }),
                readdirSync: () => { throw new Error('EIO'); },
                rmSync: () => { throw new Error('不该走到这里'); }
            }
        });
        const { fn: boomHandler } = compileHandler(
            /ipcMain\.handle\('clear-directory-contents'/, ['event', 'dirPath'], boomScope);
        const boomResult = await boomHandler({}, WORKSPACE);
        check('清空到一半失败：错误带回去且不抛给渲染层',
            boomResult && boomResult.success === false && boomResult.error === 'EIO', JSON.stringify(boomResult));
        check('清空到一半失败：补回滚了文件监听状态',
            boomRestores.length === 1 && boomRestores[0][0].snapshot === 'boom', JSON.stringify(boomRestores));
    }

    // ============ A1: 临时文件通道 save-temp-file / load-temp-file ============
    // 原守卫只数 `isPathInsideDir(tempPath, codeTempDir)` 出现两次 —— 锁死形参名，
    // 改名即误报；这里直接跑两个 handler，拒 / 放两侧都验。
    const compileTempHandler = (anchor, params) => {
        const scope = makeScope({
            os: { homedir: () => HOME, platform: process.platform },
            isPathInsideDir,
            USER_DATA_DIR_NAME
        });
        const fsCalls = [];
        countingFs(scope, fsCalls);
        return { scope, fsCalls, ...compileHandler(anchor, params, scope) };
    };

    {
        const load = compileTempHandler(/ipcMain\.handle\('load-temp-file'/, ['event', 'filePath']);
        check('handler 抽取并编译成功: load-temp-file', typeof load.fn === 'function');
        const real = mkFile(CODE_TEMP, 'run/std_1.txt', 'STDOUT');
        check('codeTemp 内的相对路径正常读取（不误伤）', (await load.fn({}, 'run/std_1.txt')) === 'STDOUT');
        check('codeTemp 内的绝对路径同样正常', (await load.fn({}, real)) === 'STDOUT');
        check('不存在的临时文件返回 null 而不是抛', (await load.fn({}, 'nope.txt')) === null);

        const before = load.fsCalls.length;
        let err = null;
        try { await load.fn({}, '../escape.txt'); } catch (e) { err = e; }
        check('穿越路径 ../escape.txt 被拒', !!err && err.message === 'error.pathTraversalBlocked', err && err.message);
        check('穿越被拒时一次磁盘访问都没发生', load.fsCalls.slice(before).length === 0,
            JSON.stringify(load.fsCalls.slice(before)));

        err = null;
        try { await load.fn({}, '../codeTempEvil/x.txt'); } catch (e) { err = e; }
        check('同前缀兄弟目录 codeTempEvil 也被拒', !!err && err.message === 'error.pathTraversalBlocked',
            err && err.message);

        err = null;
        try { await load.fn({}, mkFile(OUTSIDE, 'peek.txt', 'P')); } catch (e) { err = e; }
        check('绝对路径指向 codeTemp 之外同样被拒', !!err && err.message === 'error.pathTraversalBlocked',
            err && err.message);

        err = null;
        try { await load.fn({}, null); } catch (e) { err = e; }
        check('null / 非字符串以 invalidFilePath 拒绝', !!err && err.message === 'error.invalidFilePath',
            err && err.message);
    }

    {
        const save = compileTempHandler(/ipcMain\.handle\('save-temp-file'/, ['event', 'filePath', 'content']);
        check('handler 抽取并编译成功: save-temp-file', typeof save.fn === 'function');
        const written = await save.fn({}, 'out/a.txt', 'HEARTBEAT');
        check('合法相对路径写入 codeTemp 内并返回绝对路径',
            typeof written === 'string' && isPathInsideDir(written, CODE_TEMP) === true &&
            fs.readFileSync(written, 'utf8') === 'HEARTBEAT', String(written));
        const before = save.fsCalls.length;
        let err = null;
        try { await save.fn({}, '../escaped.txt', 'BAD'); } catch (e) { err = e; }
        check('穿越写入被拒', !!err && err.message === 'error.pathTraversalBlocked', err && err.message);
        check('被拒时没有任何落盘写入', save.fsCalls.slice(before).every((c) => c !== 'writeFileSync'),
            JSON.stringify(save.fsCalls.slice(before)));
        check('被拒的路径确实没创建出文件', fs.existsSync(path.join(HOME, 'escaped.txt')) === false);
        err = null;
        try { await save.fn({}, '', 'X'); } catch (e) { err = e; }
        check('空文件名被拒', !!err && err.message === 'error.invalidFilePath', err && err.message);
    }

    // ============ A1: 调用栈越界帧判定 ============
    // 原守卫锁的是字面量 isPathInsideDir(resolved, debugSessionRootDir)
    {
        const frameEnv = { debugSessionRootDir: WORKSPACE };
        const scope = makeScope({ isPathInsideDir });
        liveBinding(scope, 'debugSessionRootDir', frameEnv);
        const { body, fn: isFrameOutsideUserCode } = compileFn('isFrameOutsideUserCode', scope);
        check('函数抽取成功: isFrameOutsideUserCode',
            body.length > 0 && typeof isFrameOutsideUserCode === 'function', `${body.length} 字符`);

        check('工作区内的绝对帧路径：不算越界帧',
            isFrameOutsideUserCode(path.join(WORKSPACE, 'main.cpp')) === false);
        check('工作区内的相对帧路径：照常保留', isFrameOutsideUserCode('sub/a.cpp') === false);
        check('../other.cpp：判为越界帧', isFrameOutsideUserCode('../other.cpp') === true);
        check('工作区外的绝对路径：判为越界帧', isFrameOutsideUserCode(path.join(OUTSIDE, 'x.cpp')) === true);
        check('同前缀兄弟目录 workspaceEvil：判为越界帧',
            isFrameOutsideUserCode(path.join(WORKSPACE + 'Evil', 'x.cpp')) === true);
        check('无源码位置的特殊帧（?? / <eval> / [C++] / 空）都算越界',
            ['??', '<eval>', '[C++]', ''].every((v) => isFrameOutsideUserCode(v) === true));
        frameEnv.debugSessionRootDir = undefined;
        check('没有调试会话根目录时保守放行（不把调用栈清空）',
            isFrameOutsideUserCode('/etc/passwd') === false);
        frameEnv.debugSessionRootDir = WORKSPACE;
    }

    // ============ A3: 语言代码白名单 —— 跑真实的 loadLanguageFile ============
    {
        const LANG_ROOT = mk('langapp');
        fs.mkdirSync(path.join(LANG_ROOT, 'lang'), { recursive: true });
        fs.writeFileSync(path.join(LANG_ROOT, 'lang', 'en.json'), '{"hello":"world"}', 'utf8');
        const reads = [];
        const stubFs = {
            existsSync: (p) => fs.existsSync(p),
            readFileSync: (p, enc) => { reads.push(String(p)); return fs.readFileSync(p, enc); }
        };
        const scope = makeScope({ isPathInsideDir, __dirname: LANG_ROOT, LANG_FILE_CACHE: new Map(), fs: stubFs });
        const { body, fn: loadLanguageFile } = compileFn('loadLanguageFile', scope);
        check('函数抽取成功: loadLanguageFile',
            body.length > 0 && typeof loadLanguageFile === 'function', `${body.length} 字符`);

        const en = loadLanguageFile('en');
        check('合法语言代码读到真实内容', !!en && en.hello === 'world', JSON.stringify(en));
        const cached = loadLanguageFile('en');
        check('第二次调用命中缓存、不再读盘', reads.length === 1 && cached === en, `${reads.length} 次读`);
        // 原来这条是 `!/path\.join\(__dirname,\s*'lang',\s*`\$\{langCode/.test(mainSource)`：
        // 只证明源码里没那行旧写法，证明不了读到的真是应用自带语言目录里的那个文件。
        // 换成钉住读目标 —— 改读工作区/用户目录、少拼 .json、大小写变形都会在这里红。
        check('读的就是应用自带 lang 目录下的 <code>.json',
            reads.length === 1 && reads[0] === path.join(LANG_ROOT, 'lang', 'en.json'),
            JSON.stringify(reads));
        check('合法但不存在的语言代码返回 null（不抛）', loadLanguageFile('fr') === null);

        reads.length = 0;
        const badCodes = ['en/../evil', '../etc/passwd', 'zh\\..\\x', 'a b', 'en.json', '@'];
        for (const code of badCodes) {
            const r = loadLanguageFile(code);
            if (r !== null || reads.length > 0) {
                check(`非法语言代码被拒且没读盘: ${JSON.stringify(code)}`, false, JSON.stringify(r));
            }
        }
        check(`字符集白名单把 ${badCodes.length} 种穿越/畸形代码全挡住且没读盘`, reads.length === 0, JSON.stringify(reads));
        check('非法代码被拒时记了日志',
            scope.calls.logWarn.some((row) => row.join(' ').includes('非法语言代码')));
        check('null/数字/对象输入返回 null 而不是抛异常',
            [null, undefined, '', 0, 123, {}, []].every((v) => loadLanguageFile(v) === null));
        // 纵深防御：字符集校验已经把穿越挡住了，第二道 isPathInsideDir 是不是摆设？
        // 造一个「把字符集校验拆掉」的变体来跑 —— 只有它真能拦下，才算两道都在承重。
        // 这里的 replace 是测试夹具（构造变异体），不是断言；剥不动就当场报红。
        const strippedBody = body.replace('/^[a-z0-9-]+$/i', '/[\\s\\S]/');
        check('变体构造成功（源码里确实有那道字符集校验可拆）', strippedBody !== body);
        const stripScope = makeScope({ isPathInsideDir, __dirname: LANG_ROOT, LANG_FILE_CACHE: new Map(), fs: stubFs });
        vm.runInContext(`${strippedBody}\nthis.__fn = loadLanguageFile;`, stripScope.ctx);
        const stripped = stripScope.ctx.__fn;
        reads.length = 0;
        check('拆掉字符集校验后，路径越界校验仍把 ../ 穿越判死',
            stripped('en/../../../etc/passwd') === null && reads.length === 0, JSON.stringify(reads));
        check('越界拒绝走的是「语言文件路径越界」这条日志',
            stripScope.calls.logWarn.some((row) => row.join(' ').includes('路径越界')));
        check('变体本身没被改废（合法代码照样读得到）', !!(stripped('en') && stripped('en').hello === 'world'));
        // 上面那条「越界仍判死」用的是 /etc/passwd.json —— 沙箱里那文件本就不存在，
        // 把 isPathInsideDir 整道拆掉也读不出东西，等于真空通过。给它一个真存在的逃逸目标。
        const LEAK_DIR = mk('leak');
        fs.writeFileSync(path.join(LEAK_DIR, 'secret.json'), '{"leaked":"yes"}', 'utf8');
        const escapeToRealFile = path.relative(path.join(LANG_ROOT, 'lang'), path.join(LEAK_DIR, 'secret'));
        check('逃逸目标本身真的可读（否则下面那条是真空通过）',
            JSON.parse(fs.readFileSync(path.join(LEAK_DIR, 'secret.json'), 'utf8')).leaked === 'yes');
        reads.length = 0;
        const leaked = stripped(escapeToRealFile);
        check('拆掉字符集校验后，越界校验拦住的是「文件确实存在」的那条逃逸',
            leaked === null && reads.length === 0,
            JSON.stringify({ escapeToRealFile, leaked, reads }));
        check('越界拒绝走的是「语言文件路径越界」这条日志（第二道，不是白名单那条）',
            stripScope.calls.logWarn.some((row) => row.join(' ').includes('路径越界'))
            && !stripScope.calls.logWarn.slice(-1).join(' ').includes('非法语言代码'));
    }

    // 原先这里挂着三条「源码里不该出现某串字面量」的守卫，现在都换成了可跑的：
    //   · 裸 startsWith(codeTempDir) —— isPathInsideDir / isPathInsideTempRoots /
    //     load-temp-file、save、delete-temp-file 各自都有 codeTempEvil 同前缀兄弟目录的行为行，
    //     containment 一旦退化回前缀匹配，红的是那几条真跑。
    //   · path.join(__dirname,'lang',`${langCode}`) —— 改成钉住真读到的那个文件路径，
    //     再给越界校验一个「文件确实存在」的逃逸目标（旧目标 /etc/passwd.json 本就不存在，
    //     把第二道校验整个拆掉也不会读到东西）。
    //   · TEMP_DELETE_ROOTS 的数组切片 —— 挪到上面 A2 里，跑真声明拿到清单再接真判定。

    // ============ (bb) updateSettings：渲染进程整参不传时不许半途而废 ============
    // 两个入口（update-top-level-settings / updateSettings）的 newSettings 是 unknown，
    // null / undefined 都能传进来。旧实现在 null 时会「已经 normalize 并落盘之后、
    // 还没广播 settings-changed 之前」抛 TypeError，再被自己的 catch 折成 {success:false}：
    // 磁盘上是新的一份，渲染进程手里还是旧的一份，而且没人知道。
    // 所以这里锁的不是某行字，而是这条路径上的可观测序列：归一化→落盘→广播→返回成功，
    // 少任何一环都是回归。
    {
        const makeSettingsScope = (extra = {}) => {
            const trace = [];
            const settingsObj = { theme: 'dark', font: 'Consolas' };
            const win = (name) => ({
                isDestroyed: () => false,
                setBackgroundColor: (c) => { trace.push(`${name}.bg=${c}`); },
                webContents: { send: (channel) => { trace.push(`${name}.${channel}`); } }
            });
            const scope = makeScope({
                settings: settingsObj,
                // main.js 顶层解构的白名单数组：抽出的函数体引用它，沙箱必须给真模块
                SETTINGS_WRITABLE_KEYS: require('../src/utils/settings-schema').SETTINGS_WRITABLE_KEYS,
                mainWindow: win('main'),
                compilerSettingsWindow: win('compiler'),
                editorSettingsWindow: win('editor'),
                codeTemplatesWindow: win('templates'),
                backupSettingsWindow: win('backup'),
                normalizeSettingsRuntimeShape: (s) => { trace.push('normalize'); s.normalized = true; },
                saveSettings: () => { trace.push('save'); },
                scheduleAutoSettingsBackup: (reason) => { trace.push(`backup:${reason}`); },
                createMenuBar: () => { trace.push('menuBar'); },
                setLanguage: (lang) => { trace.push(`setLanguage:${lang}`); },
                normalizeRunModeForPlatform: (m) => `runMode(${m})`,
                normalizeCompilerArgsForPlatform: (a) => `args(${a})`,
                getThemeBackgroundColor: (name) => `bg(${name})`,
                ...extra
            });
            return { scope, trace, settingsObj };
        };
        const runUpdate = async (patch, extra) => {
            const env = makeSettingsScope(extra);
            const compiled = compileFn('updateSettings', env.scope);
            // 语言切换广播在 main 里收敛进了独立顶层函数 applyLanguageChange，
            // 同样抽出来接进沙箱，让 setLanguage→menuBar 的顺序断言继续跑真实现。
            const ac = compileFn('applyLanguageChange', env.scope);
            if (typeof ac.fn === 'function') env.scope.ctx.applyLanguageChange = ac.fn;
            // 抽取失败时 fn 是 undefined，直接调用会把整份测试带 stack trace 崩掉，
            // 后半段断言就没了 —— 让它在这里停住，由「抽取成功」那条报出来。
            const result = typeof compiled.fn === 'function' ? await compiled.fn(null, patch) : undefined;
            return { ...env, ...compiled, result };
        };
        // 只要求这些步骤都出现、且先后顺序不颠倒；中间多插别的步骤不算失败
        const follows = (trace, steps) => {
            let at = -1;
            return steps.every((step) => {
                const i = trace.indexOf(step);
                if (i < 0 || i <= at) return false;
                at = i;
                return true;
            });
        };

        const nulled = await runUpdate(null);
        check('函数抽取成功: updateSettings',
            nulled.body.length > 0 && typeof nulled.fn === 'function', `${nulled.body.length} 字符`);
        check('补丁是 null 时返回成功，而不是被自己的 catch 折成 {success:false}',
            nulled.result && nulled.result.success === true && nulled.result.error === undefined,
            JSON.stringify(nulled.result));
        check('补丁是 null 时归一化→落盘→广播三步都发生且顺序没颠倒（旧写法在这条上抛，广播缺失）',
            follows(nulled.trace, ['normalize', 'save', 'main.settings-changed']),
            nulled.trace.join(' → '));

        for (const junk of [null, undefined]) {
            const env = await runUpdate(junk);
            check(`整参传 ${String(junk)} 时既不抛也不写坏 settings`,
                env.result && env.result.success === true
                && Object.keys(env.settingsObj).filter((k) => k !== 'normalized').sort().join(',') === 'font,theme',
                JSON.stringify(env.result));
        }
        const junkShape = await runUpdate('font=Consolas');
        check('传进来的是字符串这种非对象形状时当空补丁处理（for...in 会把每个下标当成一个无效键）',
            junkShape.result.success === true && junkShape.settingsObj.font === 'Consolas'
            && junkShape.trace.includes('main.settings-changed'),
            JSON.stringify({ settings: junkShape.settingsObj, result: junkShape.result }));

        const applied = await runUpdate({ font: 'Courier New', runMode: 'external', compilerArgs: '-O2', evil: 'x' });
        check('白名单内的键写进 settings，runMode / compilerArgs 过平台归一化而不是原样落库',
            applied.settingsObj.font === 'Courier New'
            && applied.settingsObj.runMode === 'runMode(external)'
            && applied.settingsObj.compilerArgs === 'args(-O2)',
            JSON.stringify(applied.settingsObj));
        check('白名单外的键进不了 settings（渲染进程不能自己加键，比如 account）',
            applied.settingsObj.evil === undefined && !('evil' in applied.settingsObj),
            JSON.stringify(Object.keys(applied.settingsObj)));

        const rebound = await runUpdate({ keybindings: { 'Ctrl+S': 'save' } });
        check('改动里带 keybindings 就重画一次原生菜单',
            rebound.trace.filter((s) => s === 'menuBar').length === 1, rebound.trace.join(' → '));
        const speak = await runUpdate({ language: 'en' });
        check('改语言先 setLanguage 再重画菜单（否则切换只对界面正文生效，菜单栏还是旧语言）',
            speak.trace.includes('setLanguage:en')
            && speak.trace.filter((s) => s === 'menuBar').length === 1
            && speak.settingsObj.language === 'en', speak.trace.join(' → '));
        const painted = await runUpdate({ theme: 'light' });
        check('换主题把窗口底色改掉，并通知四个设置子窗口（子窗口不跟着换就是半屏旧色）',
            painted.trace.includes('main.bg=bg(light)')
            && ['compiler', 'editor', 'templates', 'backup'].every((w) => painted.trace.includes(`${w}.theme-changed`)),
            painted.trace.join(' → '));

        // 反向对照：catch 不能因为上面那道兜底变成「怎么都成功」。落盘真炸的时候必须报失败，
        // 而且广播不许发出去 —— 磁盘没写成却告诉渲染进程改好了，比抛错更糟。
        const diskFull = await runUpdate({ font: 'Courier New' }, { saveSettings: () => { throw new Error('disk full'); } });
        check('落盘失败仍然如实返回 {success:false} + 错误正文（兜底没把 catch 变成万能成功）',
            diskFull.result && diskFull.result.success === false && diskFull.result.error === 'disk full',
            JSON.stringify(diskFull.result));
        check('落盘失败时不广播 settings-changed（没写成就不能告诉渲染进程改好了）',
            !diskFull.trace.includes('main.settings-changed'), diskFull.trace.join(' → '));

        // 通道侧：载荷必须原样到 updateSettings，返回值必须原样回给渲染进程。
        // handler 是同步的，compileHandler 会强行包成 async 改掉返回类型，这里另配一个同步版。
        const compileSyncHandler = (anchor, params, scope) => {
            const body = callbackBody(mainSource, anchor);
            if (!body) return { body, fn: undefined };
            vm.runInContext(`this.__fn = (${params.join(', ')}) => ${body};`, scope.ctx);
            return { body, fn: scope.ctx.__fn };
        };
        for (const channel of ['update-top-level-settings', 'updateSettings']) {
            const seen = [];
            const scope = makeScope({
                updateSettings: (type, patch) => { seen.push([type, patch]); return { success: true, via: channel }; }
            });
            const { body, fn } = compileSyncHandler(
                new RegExp(`ipcMain\\.handle\\('${channel}'`), ['event', 'newSettings'], scope);
            check(`handler 抽取成功: ${channel}`, body.startsWith('{') && typeof fn === 'function', `${body.length} 字符`);
            const out = fn(null, { font: 'Courier New' });
            check(`${channel}：载荷原样交给 updateSettings，且第一参传 null（按键打补丁，不是整包替换）`,
                seen.length === 1 && seen[0][0] === null && seen[0][1] && seen[0][1].font === 'Courier New',
                JSON.stringify(seen));
            check(`${channel}：updateSettings 的返回值原样回给渲染进程（失败了调用方得看得见）`,
                out && out.success === true && out.via === channel, JSON.stringify(out));
        }
    }

    // -----------------------------------------------------------------------
    // 行为测试里回显用到的 i18n 键，必须真的存在于两语言包（防止拒了但界面空白）
    // -----------------------------------------------------------------------
    {
        const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lang', 'zh-cn.json'), 'utf8'));
        const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lang', 'en.json'), 'utf8'));
        const usedKeys = [...new Set(observedKeys.filter((k) => k.startsWith('error.')))];
        check('行为测试确实跑出了这些拒绝键', usedKeys.length >= 4, JSON.stringify(usedKeys));
        for (const key of usedKeys) {
            const short = key.slice('error.'.length);
            check(`zh-cn 存在 ${key}`, typeof zh.error?.[short] === 'string');
            check(`en 存在 ${key}`, typeof en.error?.[short] === 'string');
        }
        check('两语言的 error.* 键集一致',
            JSON.stringify(Object.keys(zh.error).sort()) === JSON.stringify(Object.keys(en.error).sort()));
    }

    fs.rmSync(sandboxRoot, { recursive: true, force: true });
}

main()
    .catch((e) => {
        check('主流程没有抛出未捕获异常', false, String((e && e.stack) || e));
    })
    .then(() => {
        clearTimeout(watchdog);
        console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
        process.exit(failures ? 1 : 0);
    });
