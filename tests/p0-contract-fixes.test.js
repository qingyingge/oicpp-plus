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
const vm = require('vm');
const { classMethod, compileMethod, funcDecl, setMembers, toFn } = require('./fixtures/source-extract');

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
    // 期望译文自己按语言包模板拆出来比对，不走 i18next —— 之前这条断的是
    // includes('chunkFailed')，那是主进程 t() 一直返回裸键名时测试跟着锁死 bug 的写法。
    const chunkTmpl = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lang', 'zh-cn.json'), 'utf8'))
        .downloader.chunkFailed);
    const chunkHead = chunkTmpl.slice(0, chunkTmpl.indexOf('{'));
    const chunkMid = chunkTmpl.slice(chunkTmpl.indexOf('}') + 1, chunkTmpl.lastIndexOf('{'));
    const chunkTail = chunkTmpl.slice(chunkTmpl.lastIndexOf('}') + 1);
    const chunkMsg = String(exhausted && exhausted.message);
    check('耗尽后抛出的仍是原 error：code 保住、message 是语言包译文且两个占位都填上了',
        exhausted !== null && exhausted.code === 'ECONNRESET'
        && chunkMsg.startsWith(chunkHead) && chunkMsg.includes(chunkMid)
        && chunkMsg.endsWith(chunkTail) && !chunkMsg.includes('{')
        && chunkMsg.length > chunkHead.length + chunkMid.length + chunkTail.length
        && !chunkMsg.includes('chunkFailed'),
        exhausted && `code=${exhausted.code} message=${chunkMsg} 模板=${chunkTmpl}`);
    check('不是新造的裸 Error（裸 Error 没有 code）',
        exhausted instanceof Error && typeof exhausted.code === 'string' && exhausted.code.length > 0,
        JSON.stringify(exhausted && Object.keys(exhausted)));

    // ---- P0-1 / P0-2：取消判定与死 IPC 通道清理 ----
    // 原先这九条全是「源码里不该再出现 X」的负向正则。删除类断言确实没有可直接调用的对象，
    // 但两侧都有数据可抽：主进程注册了哪些通道、往外发过哪些、preload 放行了哪些、
    // compile-manager 到底注册了几个监听 —— 当成集合做交叉核对，锁的就不再是某行字，
    // 而是「监听了一个没人发送的通道」这个 bug 类本身。
    // 剥掉整行注释再抽：源码里「compile-result 已移除」这类说明文字会把字面量守卫自己点着。
    const decomment = (s) => s.split('\n').map((l) => /^\s*\/\//.test(l) ? '' : l).join('\n');
    const mainCode = decomment(mainSource);
    const cmCode = decomment(compileMgrSource);
    const names = (re, s) => { const out = new Set(); let m; while ((m = re.exec(s))) out.add(m[1]); return out; };
    const mainHandlers = names(/ipcMain\.(?:on|handle)\(\s*['"`]([a-z0-9-]+)['"`]/g, mainCode);
    const mainPushes = names(/\.send\(\s*['"`]([a-z0-9-]+)['"`]/g, mainCode);
    const preloadEvents = setMembers(preloadSource, 'ALLOWED_EVENT_CHANNELS');
    check('IPC 三侧的通道集都抽成了数据（抽不到就退化成真空否定，先钉死）',
        mainHandlers.size > 100 && mainPushes.size > 30 && Array.isArray(preloadEvents) && preloadEvents.length > 40,
        `注册=${mainHandlers.size} 外发=${mainPushes.size} 白名单=${preloadEvents && preloadEvents.length}`);

    // 渲染层「监听了什么」不该靠读它的源码来猜 —— 把 setupEventListeners 真跑一遍，
    // 拿假 ipcRenderer 记下每一次 on()，注册表就是它自己的输出。
    const setupSrc = classMethod(cmCode, 'setupEventListeners');
    check('方法体抽取成功: CompileManager.setupEventListeners', /^\s*setupEventListeners\(/.test(setupSrc), String(setupSrc).slice(0, 40));
    const cmCtx = vm.createContext({ logInfo: () => { }, logWarn: () => { }, Object, window: undefined });
    const setup = compileMethod(cmCtx, setupSrc);
    const remove = compileMethod(cmCtx, classMethod(cmCode, 'removeEventListeners'));
    check('两个方法都编译成可调用函数', typeof setup === 'function' && typeof remove === 'function');
    const mgrSelf = {
        settings: { compilerPath: 'g++', compilerArgs: '-std=c++17', runMode: 'stdin' },
        applied: null,
        updateSettings(patch) { this.applied = { ...this.settings, ...patch }; }
    };
    // 先走没有 electron 桥的那条分支：不能抛，也不能留下半个登记表。
    let bridgeThrew = null;
    cmCtx.window = {};
    try { setup.call(mgrSelf); } catch (e) { bridgeThrew = e.message; }
    check('没有 electron 桥时只记日志、不注册也不炸',
        bridgeThrew === null && mgrSelf._ipcListeners === undefined, String(bridgeThrew));

    const on = [];
    const off = [];
    cmCtx.window = { electron: { ipcRenderer: { on: (c, h) => on.push([c, h]), removeListener: (c, h) => off.push([c, h]) } } };
    setup.call(mgrSelf);
    const cmChannels = on.map(([c]) => c);
    check('compile-manager 实际注册的监听通道就是这一份（四个死通道加回来就在这里显形）',
        JSON.stringify(cmChannels.slice().sort()) === '["settings-changed"]', JSON.stringify(cmChannels));
    check('每个监听通道主进程都真有地方往外发（P0-2 的病根：监听恒不触发的死通道）',
        cmChannels.every((c) => mainPushes.has(c)),
        `缺发送方: ${JSON.stringify(cmChannels.filter((c) => !mainPushes.has(c)))}`);
    check('每个监听通道都在 preload 白名单里（不在就被 safeIpcRenderer 拒掉，等于以为监听成功了）',
        cmChannels.every((c) => preloadEvents.includes(c)),
        JSON.stringify(cmChannels.filter((c) => !preloadEvents.includes(c))));
    const DEAD = ['compile-result', 'run-result', 'run-error', 'compile-error'];
    check('四个死通道在「主进程注册 / 主进程外发 / preload 白名单 / 渲染层监听」四处都已清零',
        DEAD.every((c) => !mainHandlers.has(c) && !mainPushes.has(c)
            && !(preloadEvents || []).includes(c) && !cmChannels.includes(c)),
        DEAD.map((c) => `${c}${[mainHandlers.has(c), mainPushes.has(c), (preloadEvents || []).includes(c), cmChannels.includes(c)].map((v) => (v ? '有' : '无')).join('')}`).join(' '));
    check('compile-code 既没在主进程注册、渲染层也没有调用点（老处理器整条撤掉）',
        !mainHandlers.has('compile-code') && !/[^.\w]compileCode\s*\(/.test(mainCode + cmCode),
        `注册=${mainHandlers.has('compile-code')}`);

    // 注册回来的东西还得能退干净：注销用的通道和句柄与注册一一对应，登记表清空。
    remove.call(mgrSelf);
    check('removeEventListeners 注销的通道与句柄和注册完全对应（漏一个就是切页后同一事件处理两遍）',
        JSON.stringify(off.map(([c]) => c).sort()) === JSON.stringify(cmChannels.slice().sort())
            && off.every(([c, h], idx) => c === on[idx][0] && h === on[idx][1]),
        JSON.stringify({ on: cmChannels, off: off.map(([c]) => c) }));
    const offBefore = off.length;
    remove.call(mgrSelf);
    check('注销后登记表置空，重复调用不再多发 removeListener',
        mgrSelf._ipcListeners === null && off.length === offBefore, `off=${off.length}`);

    // 处理器本身也不是摆设：喂三种 settings-changed 载荷，看它到底更不更新。
    const again = [];
    cmCtx.window = { electron: { ipcRenderer: { on: (c, h) => again.push([c, h]), removeListener: () => { } } } };
    setup.call(mgrSelf);
    const settingsHandler = again.length ? again[0][1] : null;
    check('settings-changed 的处理器注册成了可调用函数', typeof settingsHandler === 'function', String(typeof settingsHandler));
    const fire = (payload) => {
        mgrSelf.applied = null;
        try { settingsHandler({}, 'compiler', payload); } catch (e) { mgrSelf.applied = 'THREW:' + e.message; }
        return mgrSelf.applied;
    };
    const moved = fire({ compilerPath: 'clang++' });
    check('只改 compilerPath 时其余字段保留原值，而不是整体覆盖成 undefined',
        JSON.stringify(moved) === JSON.stringify({ compilerPath: 'clang++', compilerArgs: '-std=c++17', runMode: 'stdin' }),
        JSON.stringify(moved));
    check('三个关键字段一个都没变时不去动设置（否则每次广播都白重编译一遍）',
        fire({ theme: 'dark' }) === null, JSON.stringify(fire({ theme: 'dark' })));
    check('载荷是 null/undefined 时不炸、也不动设置', fire(null) === null && fire(undefined) === null);

    // ---- P0-1：取消判定看 code，不看文案 ----
    // 原来两条 !includes 锁的是「用户取消」这四个字和导入别名；把文案改成「已取消」它就看不见，
    // 而真正要保证的是「只有下载器自己打的取消码才算取消」。谓词就在导出里，直接跑。
    const isCancel = Downloader.isCancelledError;
    check('message 写着「用户取消」的普通 Error 不算取消（文案不参与判定）',
        isCancel(new Error('用户取消')) === false, String(isCancel(new Error('用户取消'))));
    check('算取消的只有下载器那个取消码',
        isCancel(Object.assign(new Error('x'), { code: Downloader.CANCELLED_CODE })) === true
            && Downloader.CANCELLED_CODE === 'DOWNLOAD_CANCELLED', String(Downloader.CANCELLED_CODE));
    // 光测谓词还不够：得确认主进程那两处 catch 真的把「是不是取消」交给这个谓词，
    // 而不是哪天又改回 `error.message.includes('…')`。把两条 catch 里 isCancelled 的
    // 初始化表达式原样抽出来，喂两种 error 真算一遍 —— 换文案、换谓词都会在这里显形。
    const cancelBindings = [...mainCode.matchAll(/(?:const|let)\s+isCancelled\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    check('主进程恰好两处 isCancelled 绑定（两条下载 catch 各一处）',
        cancelBindings.length === 2, JSON.stringify(cancelBindings));
    for (const [idx, expr] of cancelBindings.entries()) {
        const ev = (error) => {
            try {
                return vm.runInNewContext(`(${expr})`,
                    { error, isDownloadCancelled: Downloader.isCancelledError, Boolean, String, Object }, { timeout: 50 });
            }
            catch (e) { return 'UNRESOLVED:' + e.message; }
        };
        check(`第 ${idx + 1} 处取消判定认码不认文案（${expr}）`,
            ev(new Error('用户取消')) === false
                && ev(Object.assign(new Error('x'), { code: Downloader.CANCELLED_CODE })) === true,
            `${ev(new Error('用户取消'))}/${ev(Object.assign(new Error('x'), { code: Downloader.CANCELLED_CODE }))}`);
    }
    // 取消后窗口关得多快，原先是数 `}, isCancelled ? 1000 : 3000);` 出现两次 —— 锁的是空格和字形。
    // 改成把每个 setTimeout 的延时实参抽出来，在 isCancelled 两种取值下真算一遍，
    // 只保留「取值随取消与否变化」的那些：写死成常量、或对调两边的值，都逃不出这两条。
    const delaySites = (src) => {
        const out = [];
        let at = 0;
        while (true) {
            const i = src.indexOf('setTimeout(', at);
            if (i < 0) break;
            const open = i + 'setTimeout'.length;
            let d = 0, q = null, close = -1;
            for (let k = open; k < src.length; k++) {
                const c = src[k];
                if (q) { if (c === '\\') k++; else if (c === q) q = null; continue; }
                if (c === '"' || c === "'" || c === '`') q = c;
                else if (c === '(' || c === '[' || c === '{') d++;
                else if (c === ')' || c === ']' || c === '}') { d--; if (d === 0) { close = k; break; } }
            }
            if (close < 0) { at = i + 1; continue; }
            const args = [];
            let bd = 0, bq = null, cur = '';
            for (let k = open + 1; k < close; k++) {
                const c = src[k];
                if (bq) { cur += c; if (c === '\\') cur += src[++k]; else if (c === bq) bq = null; continue; }
                if (c === '"' || c === "'" || c === '`') bq = c;
                if (c === '(' || c === '[' || c === '{') bd++;
                else if (c === ')' || c === ']' || c === '}') bd--;
                if (c === ',' && bd === 0) { args.push(cur); cur = ''; continue; }
                cur += c;
            }
            args.push(cur);
            const expr = args[args.length - 1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
            const ev = (flag) => {
                try { return vm.runInNewContext(`(${expr})`, { isCancelled: flag, Number, Math, String }, { timeout: 50 }); }
                catch (_) { return 'UNRESOLVED'; }
            };
            const yes = ev(true), no = ev(false);
            if (yes !== 'UNRESOLVED' && no !== 'UNRESOLVED' && yes !== no) out.push({ expr, yes, no });
            at = close;
        }
        return out;
    };
    const delays = delaySites(mainCode);
    check('主进程里「随取消与否变化」的关闭延时恰好两处（两条下载路径各一条）',
        delays.length === 2, JSON.stringify(delays.map((x) => x.expr)));
    for (const x of delays) {
        check(`取消时 1 秒就关、失败时留 3 秒看错误（实测 ${x.yes}/${x.no}）`,
            x.yes === 1000 && x.no === 3000, x.expr);
    }

    // handleCompileResult/handleRunResult 仍要有人调：编译改走 invoke，结果经这两条路分发。
    const cmCallSites = (m) => (cmCode.match(new RegExp('this\\.' + m + '\\s*\\(', 'g')) || []).length;
    check('handleCompileResult/handleRunResult 各自仍有调用点（撤监听时没把方法一起带走）',
        cmCallSites('handleCompileResult') >= 1 && cmCallSites('handleRunResult') >= 1,
        `调用点=${cmCallSites('handleCompileResult')}/${cmCallSites('handleRunResult')}`);

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

    // 原来这条是全文件正则 `this.activeTab = null;\n this.activeTabKey = null;`：
    // 只要文件里任意两处挨在一起就算过，写在别的类里、或别的办法里都拦不住。
    // 改成按方法作用域判定：抽 closeTab 本体，两个赋值都得在它里面。
    const closeTabBody = classMethod(tabsSource, 'closeTab');
    check('方法体抽取成功: TabManager.closeTab', /^\s*closeTab\(/.test(closeTabBody), String(closeTabBody).slice(0, 40));
    check('关闭 tab 时 activeTab 与 activeTabKey 在同一个方法里一并清空',
        /this\.activeTab\s*=\s*null/.test(closeTabBody) && /this\.activeTabKey\s*=\s*null/.test(closeTabBody),
        `activeTab=${/this\.activeTab\s*=\s*null/.test(closeTabBody)} activeTabKey=${/this\.activeTabKey\s*=\s*null/.test(closeTabBody)}`);
    // 只清一个、留下另一个的「不对称站点」曾经恰好一处（closeWelcomePage：删了 Welcome
    // 但 activeTabKey 仍指着它），已修复。钉成空棘轮：再新增一处就红 —— 那正是 6ddac59 那类身份错位。
    const asymmetric = [];
    for (const name of ['closeTab', 'closeWelcomePage', 'closeTabByUniqueKey', 'closeTabByFileName', 'destroy']) {
        const body = classMethod(tabsSource, name);
        if (!body) continue;
        const a = /this\.activeTab\s*=\s*null/.test(body);
        const k = /this\.activeTabKey\s*=\s*null/.test(body);
        if (a !== k) asymmetric.push(name);
    }
    check('没有任何「只清 activeTab 不清 activeTabKey」的方法（新增一处就是身份错位的苗头）',
        asymmetric.length === 0, JSON.stringify(asymmetric));

    // ---- (ii) closeWelcomePage 的行为守卫 ----
    // 上面那条棘轮只锁得住「两个赋值挨在一起」，锁不住它们被无条件执行：
    // 原方法无条件 `this.activeTab = null`，于是在没有欢迎页的调用点（createNewCppFile）
    // 会把当前文件的身份一起抹掉。这里把方法体抽进 vm 真跑，断言的是清理后的字段和
    // DOM 可见性 —— 「该清的清了、不该动的没动」两个方向都得是可观测的。
    {
        const closeWelcomeSrc = classMethod(tabsSource, 'closeWelcomePage');
        check('方法体抽取成功: TabManager.closeWelcomePage',
            /^\s*closeWelcomePage\(/.test(closeWelcomeSrc), String(closeWelcomeSrc).slice(0, 40));

        const runCloseWelcome = (over = {}) => {
            const opts = over || {};
            const sidebarCalls = [];
            const ctx = vm.createContext({
                logInfo: () => { }, logWarn: () => { }, logError: () => { },
                window: {
                    sidebarManager: {
                        showForEditor: () => sidebarCalls.push('showForEditor'),
                        enableResize: () => sidebarCalls.push('enableResize')
                    }
                }
            });
            // instanceof HTMLElement 是同 realm 判定，元素必须在 context 里 new 出来，
            // 宿主这边 new 的同类对象在 context 里 instanceof 恒 false，那条分支就被静默跳过了。
            vm.runInContext(`
                class HTMLElement { constructor(){ this.style = {}; } }
                globalThis.__els = { welcome: new HTMLElement(), editor: new HTMLElement() };
                globalThis.document = {
                    getElementById: (id) => id === 'welcome-container' ? globalThis.__els.welcome : null,
                    querySelector: (sel) => sel === '.editor-area' ? globalThis.__els.editor : null
                };
            `, ctx);

            const FILE = '/home/user/proj/a.cpp';
            const tabs = new Map();
            tabs.set('Welcome', { fileName: 'Welcome', isWelcome: true });
            const self = {
                tabs,
                groups: new Map(),
                activeTab: 'Welcome',
                activeTabKey: 'Welcome',
                activeGroupId: null
            };
            if (opts.withFile) {
                tabs.set(FILE, { fileName: 'a.cpp', filePath: FILE, uniqueKey: FILE, isWelcome: false });
                self.activeTab = tabs.get(FILE);
                self.activeTabKey = FILE;
            }
            // displayWelcomePage → activateTabByUniqueKey：activeTab 是整个 tab 对象、key 是 'Welcome'
            if (opts.welcomeAsObject) self.activeTab = tabs.get('Welcome');
            // showWelcomePage：只把字符串 'Welcome' 赋给 activeTab，activeTabKey 还是启动时的 null
            if (opts.startupWelcome) self.activeTabKey = null;
            if (opts.noWelcomeTab) tabs.delete('Welcome');

            const fn = compileMethod(ctx, closeWelcomeSrc);
            let error = null;
            try { fn.call(self); } catch (e) { error = e; }
            return {
                error, self, sidebarCalls,
                welcomeDisplay: ctx.__els.welcome.style.display,
                editorDisplay: ctx.__els.editor.style.display
            };
        };

        const closedWelcome = runCloseWelcome();
        check('关欢迎页：跑通，不靠异常静默退出', closedWelcome.error === null, String(closedWelcome.error));
        check('关欢迎页：tabs 里的 Welcome 被删', !closedWelcome.self.tabs.has('Welcome'),
            [...closedWelcome.self.tabs.keys()].join());
        check('关欢迎页：activeTab 与 activeTabKey 一并清空（key 不再悬空指向已删除的 Welcome）',
            closedWelcome.self.activeTab === null && closedWelcome.self.activeTabKey === null,
            JSON.stringify({ tab: closedWelcome.self.activeTab, key: closedWelcome.self.activeTabKey }));
        check('关欢迎页：欢迎页容器隐藏、编辑区恢复显示',
            closedWelcome.welcomeDisplay === 'none' && closedWelcome.editorDisplay === 'block',
            JSON.stringify({ welcome: closedWelcome.welcomeDisplay, editor: closedWelcome.editorDisplay }));
        check('关欢迎页：侧边栏走 showForEditor 恢复（不是 enableResize 兜底）',
            JSON.stringify(closedWelcome.sidebarCalls) === '["showForEditor"]',
            JSON.stringify(closedWelcome.sidebarCalls));

        // activeTab 是 TabRecord 对象形态（displayWelcomePage → activateTabByUniqueKey）时，
        // 认出身份靠的是 activeTabKey —— 只比字符串 'Welcome' 的那一支在这种形态下永远不成立。
        const welcomeAsObject = runCloseWelcome({ welcomeAsObject: true });
        check('关欢迎页：activeTab 是 Welcome 的 tab 对象时同样认出身份并清空',
            welcomeAsObject.error === null
            && welcomeAsObject.self.activeTab === null && welcomeAsObject.self.activeTabKey === null,
            JSON.stringify({ tab: welcomeAsObject.self.activeTab, key: welcomeAsObject.self.activeTabKey }));

        // showWelcomePage 只把字符串 'Welcome' 赋给 activeTab，activeTabKey 仍是启动时的 null ——
        // 反过来只比 key 的那一支在这种形态下也不成立，少了它 activeTab 会指着已删除的 Welcome。
        const startupWelcome = runCloseWelcome({ startupWelcome: true });
        check('关欢迎页：只有 activeTab 认得出 Welcome（启动路径 key 为 null）时，两个字段都不留残留',
            startupWelcome.error === null
            && startupWelcome.self.activeTab === null && startupWelcome.self.activeTabKey === null,
            JSON.stringify({ tab: startupWelcome.self.activeTab, key: startupWelcome.self.activeTabKey }));

        const fileActive = runCloseWelcome({ withFile: true });
        check('当前是普通文件、只是顺带删掉残留的 Welcome：文件的 activeTab/activeTabKey 不许被抹掉',
            fileActive.error === null
            && fileActive.self.activeTabKey === '/home/user/proj/a.cpp'
            && fileActive.self.activeTab && fileActive.self.activeTab.filePath === '/home/user/proj/a.cpp',
            JSON.stringify({ tab: typeof fileActive.self.activeTab, key: fileActive.self.activeTabKey }));
        check('同上：Welcome 仍然被删，DOM 恢复也照常做完',
            !fileActive.self.tabs.has('Welcome') && fileActive.self.tabs.size === 1
            && fileActive.welcomeDisplay === 'none' && fileActive.editorDisplay === 'block',
            JSON.stringify({ keys: [...fileActive.self.tabs.keys()], welcome: fileActive.welcomeDisplay, editor: fileActive.editorDisplay }));

        const noWelcome = runCloseWelcome({ noWelcomeTab: true, withFile: true });
        check('createNewCppFile 那条无欢迎页的调用路径：残留文件的身份不受影响',
            noWelcome.error === null && noWelcome.self.tabs.size === 1
            && noWelcome.self.activeTabKey === '/home/user/proj/a.cpp'
            && noWelcome.self.activeTab !== null,
            JSON.stringify({ size: noWelcome.self.tabs.size, key: noWelcome.self.activeTabKey }));
    }

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
        // DAP 的 Variable 常见的是 namedVariables/indexedVariables，elementCount 压根没填；
        // 只判 null 会把 undefined 原样拼进界面变成「容器[undefined] c」。
        check('elementCount 不是有限数就显示 ?（null / 缺省 / NaN / 字符串都不许拼成 [undefined]）',
            fv({ value: 'c', isContainer: true, elementCount: 3 }) === '容器[3] c'
            && fv({ value: 'c', isContainer: true, elementCount: null }) === '容器[?] c'
            && fv({ value: 'c', isContainer: true }) === '容器[?] c'
            && fv({ value: 'c', isContainer: true, elementCount: NaN }) === '容器[?] c'
            && fv({ value: 'c', isContainer: true, elementCount: '3' }) === '容器[?] c',
            JSON.stringify([3, null, undefined, NaN, '3'].map((n) =>
                fv({ value: 'c', isContainer: true, elementCount: n }))));
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