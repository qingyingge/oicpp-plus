'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { arrowExpr, callStatement, callbackBody, classMethod, compileMethod, forStatement, funcDecl, ifStatement, scalarConst, setMembers } = require('./fixtures/source-extract');

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
        // 「拿到空回包」和「回包是 JSON 的 null」都必须原样回报 null data：
        // 一旦有人给它兜个 {} / {empty:true}，上层 `if (!data)` 的空判就永远不成立。
        const empties = await Promise.all([
            (async () => {
                ctx.axios.get = (url, opt) => { calls.push(['get', url, opt]); return Promise.resolve({ status: 204, data: null }); };
                return settle({ path: allowedPath });
            })(),
            (async () => {
                ctx.axios.get = (url, opt) => { calls.push(['get', url, opt]); return Promise.resolve({ status: 200, data: 'null' }); };
                return settle({ path: allowedPath });
            })()
        ]);
        push('上游回包为空或为 JSON null 时 data 保持 null，不伪造占位对象',
            empties.every((r) => r.ok && r.value.data === null),
            JSON.stringify(empties.map((r) => r.value)));
        // 「不许向更新接口发请求」原先锁三段 URL 字面量的缺席。字面量缺席挡不住改写：
        // 把 URL 拼成 base + '/checkUpdate'、或换成 axios.get(new URL(...))，三门全绿
        // 而请求照发。真正管住这件事的是这道白名单，于是拿更新接口直接来敲门 ——
        // 拒了、且一次请求都没发，才是那句话的语义。
        calls.length = 0;
        const updatePaths = await Promise.all([
            settle({ path: '/api/checkUpdate' }),
            settle({ path: '/api/getUpdateFilelist' }),
            settle({ path: '/api/downloadUpdate' })
        ]);
        push('更新接口从渲染层点名也被代理拒掉，且一次请求都不发',
            updatePaths.every((r) => !r.ok && /^error\.remoteApiNotAllowed/.test(r.message)) && calls.length === 0,
            JSON.stringify(updatePaths.map((r) => r.message)));
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

// ---- GDB / MI ----
//
// 原来三条是 `gdbSource.includes('getBreakpoints()')` 这类「这行字还在吗」：
// 快照不再拷值、超时没接到命令上、MI 流退化成按字节切 —— 全都照样绿。
// 现在 MI 解析直接 require 真模块跑（它是纯函数模块，无副作用），
// _miRequest / getBreakpoints 抽方法体在 vm 里真调，启动参数抽 const 求值。
{
    const gdbMi = require(path.join(root, 'src', 'gdb-mi.js'));
    check('MI 解析模块可加载且导出流式解析器',
        typeof gdbMi.GdbMiStream === 'function' && typeof gdbMi.parseMiRecord === 'function');
    const sink = [];
    const stream = new gdbMi.GdbMiStream((record) => sink.push(record));
    stream.push('1^done,bg-pid=42\n=breakpoint-cre');
    stream.push('ated,bkpt=1\n');
    check('MI 流按行切记录：跨 chunk 的半行等下一块补齐，不拆成两条垃圾',
        sink.length === 2 && sink[0].type === 'result' && sink[0].status === 'done'
        && sink[0].fields['bg-pid'] === '42' && sink[1].type === 'notify' && sink[1].name === 'breakpoint-created',
        JSON.stringify(sink.map((r) => [r.type, r.status || r.name])));
    sink.length = 0;
    stream.push('2*stopped,reason="exited-normally"\r\n\r\n');
    stream.flush();
    check('CRLF 收尾、空行跳过，flush 不重复派发已完成的整行',
        sink.length === 1 && sink[0].type === 'exec' && sink[0].name === 'stopped'
        && sink[0].fields.reason === 'exited-normally', JSON.stringify(sink.map((r) => r.type)));
    sink.length = 0;
    stream.push('没有 MI 标记的一行输出\n');
    check('认不出的行归 unknown 交回上层，不静默丢弃也不抛',
        sink.length === 1 && sink[0].type === 'unknown', JSON.stringify(sink.map((r) => r.type)));
    sink.length = 0;
    stream.maxBufferBytes = 32;
    stream.push(`${'x'.repeat(60)}\n`);
    check('MI 缓冲超上限时丢头部留尾部并回报 warning，而不是无限攒',
        sink.some((r) => r.type === 'warning' && /buffer/i.test(r.message || ''))
        && sink.some((r) => r.type === 'unknown' && r.raw.length === 31),
        JSON.stringify(sink.map((r) => [r.type, r.raw && r.raw.length])));
    const bigSink = [];
    const bigStream = new gdbMi.GdbMiStream((record) => bigSink.push(record));
    check('MI 缓冲默认带正数上限（不设上限就是一直攒到 OOM）',
        Number.isFinite(bigStream.maxBufferBytes) && bigStream.maxBufferBytes > 0, String(bigStream.maxBufferBytes));
    bigStream.push(`~${'a'.repeat(1024 * 1024 + 8)}\n`);
    check('超过单条记录上限的行转成 parse-error 交回上层，不抛出把 stdout 监听打断',
        bigSink.length === 1 && bigSink[0].type === 'parse-error' && /size limit/.test(bigSink[0].message || ''),
        JSON.stringify(bigSink.map((r) => [r.type, r.message])));
}

// _miRequest 的超时与在途登记：这是「GDB 卡住时 UI 不会永远等」的唯一保证，
// 用假 setTimeout 把定时器接出来， firing 之后再看 reject 的原文。
const miRows = (() => {
    const rows = [];
    const push = (name, cond, extra = '') => rows.push({ name, cond, extra });
    const miSource = read('src/gdb-mi-debugger.js');
    const argsSrc = scalarConst(miSource, 'args');
    push('gdb 启动参数声明抽取成功', argsSrc.startsWith('const args'), JSON.stringify(argsSrc.slice(0, 40)));
    const miArgs = argsSrc.startsWith('const args') ? new Function(`${argsSrc}; return args;`)() : [];
    push('gdb 以 mi2 解释器启动，并关掉隐式配置与启动脚本',
        miArgs.includes('--interpreter=mi2') && miArgs.includes('-q') && miArgs.includes('-nx'),
        JSON.stringify(miArgs));
    const timeoutSrc = scalarConst(miSource, 'MI_COMMAND_TIMEOUT_MS');
    const defaultTimeout = timeoutSrc.startsWith('const MI_COMMAND_TIMEOUT_MS')
        ? new Function(`${timeoutSrc}; return MI_COMMAND_TIMEOUT_MS;`)() : NaN;
    push('MI 命令默认超时是正的有限数（写成 0 就是永不超时）',
        typeof defaultTimeout === 'number' && Number.isFinite(defaultTimeout) && defaultTimeout > 0,
        JSON.stringify({ timeoutSrc, defaultTimeout }));

    const timers = [];
    const ctx = vm.createContext({
        MI_COMMAND_TIMEOUT_MS: defaultTimeout,
        Map, Set, Number, String, Object, Error, RegExp, Promise, JSON, Math, Boolean,
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; },
        clearTimeout: () => { }
    });
    const reqSrc = classMethod(miSource, '_miRequest');
    const miRequest = compileMethod(ctx, reqSrc);
    push('方法体抽取成功: _miRequest', typeof miRequest === 'function', String(reqSrc).slice(0, 30));
    if (typeof miRequest !== 'function') return Promise.resolve(rows);

    let self;
    const mkSelf = (opts = {}) => {
        const s = {
            gdbProcess: opts.noProcess ? null : {},
            _nextMiToken: 1,
            _miPending: new Map(),
            _inferiorRunning: !!opts.running,
            _written: [],
            _settled: [],
            _writeMi: (line) => { if (opts.writeThrows) throw new Error('pipe closed'); s._written.push(line); },
            _settleMi: (entry, error, result) => {
                s._settled.push({ token: entry.token, message: error ? error.message : null });
                entry.settled = true;
                if (error) entry.reject(error); else entry.resolve(result);
            }
        };
        self = s;
        return s;
    };
    const ask = (command, options) => miRequest.call(self, command, options || {});
    // 定时器可能因为变异根本没挂上：fire 不做断言，只负责「有就敲一下」，
    // 让缺失定时器落到具体那条断言上失败，而不是整批 TypeError 崩掉。
    const fire = (i) => { if (timers[i]) timers[i].fn(); };
    // 请求挂住不能把整批守卫拖死：给一次微任务之外的落地窗口，超时未结算就当失败暴露，
    // 否则「永不 resolve」在变异测试里会伪装成一条绿色断言。
    const STILL_PENDING = Symbol('still-pending');
    const settle = async (p) => {
        try {
            const value = await Promise.race([p, new Promise((resolve) => setImmediate(() => resolve(STILL_PENDING)))]);
            return value === STILL_PENDING ? { ok: false, message: '<请求仍未结算>' } : { ok: true, value };
        } catch (e) { return { ok: false, message: String(e && e.message) }; }
    };

    return (async () => {
        mkSelf();
        const first = ask('-break-insert main');
        push('命令带自增 token 写出，并登记为在途请求、挂上默认超时的定时器',
            self._written.length === 1 && self._written[0] === '1-break-insert main'
            && self._miPending.size === 1 && timers.length === 1 && timers[0].ms === defaultTimeout,
            JSON.stringify({ written: self._written, pending: self._miPending.size, ms: timers.map((t) => t.ms) }));
        ask('-break-insert other');
        push('token 逐条自增，不会两条命令共用一个回包标记',
            self._written[1] === '2-break-insert other', JSON.stringify(self._written));

        mkSelf({ noProcess: true });
        timers.length = 0;
        const dead = await settle(ask('-break-insert main'));
        push('GDB 进程没起来时直接 reject，不登记在途、不写管道、不挂定时器',
            !dead.ok && dead.message === 'GDB process is not running'
            && self._written.length === 0 && self._miPending.size === 0 && timers.length === 0,
            JSON.stringify({ dead, timers: timers.length }));

        mkSelf();
        timers.length = 0;
        ask('-break-insert main', { timeoutMs: 500 });
        push('显式 timeoutMs 覆盖默认值',
            timers.length === 1 && timers[0].ms === 500, JSON.stringify(timers.map((t) => t.ms)));
        mkSelf();
        timers.length = 0;
        ask('-break-insert main', { timeoutMs: NaN });
        push('NaN 超时退回默认值，不是「没有超时」',
            timers.length === 1 && timers[0].ms === defaultTimeout, JSON.stringify(timers.map((t) => t.ms)));
        mkSelf();
        timers.length = 0;
        ask('-break-insert main', { timeoutMs: '500' });
        push('字符串超时不算显式值，同样退回默认值',
            timers.length === 1 && timers[0].ms === defaultTimeout, JSON.stringify(timers.map((t) => t.ms)));
        mkSelf();
        timers.length = 0;
        ask('-break-insert main', { timeoutMs: 0 });
        push('显式 0 是「这条命令不限时」：不挂定时器，但请求照样登记在途',
            timers.length === 0 && self._miPending.size === 1,
            JSON.stringify({ timers: timers.length, pending: self._miPending.size }));

        mkSelf();
        timers.length = 0;
        const timedOut = ask('-exec-continue');
        self._inferiorRunning = true;
        fire(0);
        const rejected = await settle(timedOut);
        push('exec 命令超时先补发 interrupt 再判超时，挂住的 inferior 不会被丢下',
            self._written.length === 2 && self._written[1] === '0-exec-interrupt --all'
            && self._miPending.size === 0 && !rejected.ok && /timed out/.test(rejected.message),
            JSON.stringify({ written: self._written, pending: self._miPending.size, rejected }));
        fire(0);
        push('同一请求只结算一次：定时器再响也不重复 reject、不重复写 interrupt',
            self._written.length === 2 && self._settled.length === 1,
            JSON.stringify({ written: self._written.length, settled: self._settled.length }));

        mkSelf();
        timers.length = 0;
        const idlePending = ask('-exec-continue');
        fire(0);
        const idleOut = await settle(idlePending);
        push('inferior 本来就没在跑时不补发 interrupt（不会凭空打断一次会话）',
            self._written.length === 1 && self._settled.length === 1 && !idleOut.ok,
            JSON.stringify({ written: self._written, settled: self._settled }));

        mkSelf();
        timers.length = 0;
        const plainPending = ask('-break-insert main');
        self._inferiorRunning = true;
        fire(0);
        const plainTimedOut = await settle(plainPending);
        push('程序正在跑时，非 exec 命令超时也不发 interrupt（断点操作卡住不该把被测程序打断）',
            self._written.length === 1 && self._settled.length === 1
            && /timed out/.test((self._settled[0] || {}).message) && !plainTimedOut.ok,
            JSON.stringify({ written: self._written, settled: self._settled, plainTimedOut }));

        mkSelf({ writeThrows: true });
        const broken = await settle(ask('-break-insert main'));
        push('写管道失败时立刻 reject 并清掉在途（不留永不完成的 promise）',
            !broken.ok && broken.message === 'pipe closed' && self._miPending.size === 0,
            JSON.stringify({ broken, pending: self._miPending.size }));

        const gb = compileMethod(ctx, classMethod(miSource, 'getBreakpoints'));
        push('方法体抽取成功: getBreakpoints', typeof gb === 'function');
        if (typeof gb === 'function') {
            const owner = { _breakpoints: [{ number: 1, file: 'a.cpp' }, { number: 2, file: 'b.cpp' }] };
            const snap = gb.call(owner);
            snap[0].file = 'mutated';
            push('断点快照逐条拷贝：UI 改快照不污染调试器内部状态',
                snap.length === 2 && snap[0] !== owner._breakpoints[0] && owner._breakpoints[0].file === 'a.cpp',
                JSON.stringify({ internal: owner._breakpoints[0].file, snapshot: snap[0].file }));
            owner._breakpoints.push({ number: 3, file: 'c.cpp' });
            push('快照是当时的值而非内部数组引用；无断点时返回空数组',
                snap.length === 2 && gb.call({ _breakpoints: [] }).length === 0, JSON.stringify(snap.length));
        }
        return rows;
    })().catch((e) => [{ name: 'MI 命令守卫自身跑通', cond: false, extra: String((e && e.stack) || e) }]);
})();
// 对拍子进程的输出预算、停止响应与「唯一一套输出归一化」。
// 原来三条守卫全在比字符串（includes('output_limit')、includes('function outputsEqual')、
// 数 `if (!running) break;` 的个数）：把常量改名、把循环拆成两个函数，守卫就空了；
// 真把预算判错、把 break 漏掉，守卫照样绿。
// 现在抽真函数在 vm 里跑：喂数据看截断与杀进程，在 await 里翻 running 看循环停在哪。
const workerRows = (() => {
    const rows = [];
    const push = (name, cond, extra = '') => rows.push({ name, cond, extra });
    const budgetSrc = scalarConst(workerSource, 'MAX_WORKER_OUTPUT_BYTES');
    const activeSrc = scalarConst(workerSource, 'activeProcesses');
    const spawnSrc = funcDecl(workerSource, 'spawnProcess');
    const normSrc = funcDecl(workerSource, 'normalizeOutput');
    const equalSrc = funcDecl(workerSource, 'outputsEqual');
    const loopSrc = forStatement(workerSource, /^\s*for \(let i = startIdx; i < startIdx \+ count && running;/m);
    const stopSrc = ifStatement(workerSource, /^\s*else if \(msg\.type === 'stop'\)/m).replace(/^else\s+/, '');
    const parts = { budgetSrc, activeSrc, spawnSrc, normSrc, equalSrc, loopSrc, stopSrc };
    push('worker 关键片段抽取成功', Object.values(parts).every((s) => s.length > 0),
        JSON.stringify(Object.entries(parts).map(([k, s]) => [k, s.slice(0, 14)])));
    if (!Object.values(parts).every((s) => s.length > 0)) return Promise.resolve(rows);

    class FakeStream {
        constructor() { this.handlers = {}; }
        on(type, fn) { this.handlers[type] = fn; }
        push(data) { if (this.handlers.data) this.handlers.data(data); }
    }
    class FakeProc {
        constructor(tag) { this.tag = tag; this.stdout = new FakeStream(); this.stderr = new FakeStream(); this.handlers = {}; }
        on(type, fn) { this.handlers[type] = fn; }
        fire(type, arg) { if (this.handlers[type]) this.handlers[type](arg); }
    }
    // 抽出的 spawnProcess 里 MAX_WORKER_OUTPUT_BYTES 是 const，测试要按场景压小它，
    // 所以只把这一条声明改成 let（其余正文一字不动），改完仍在同一个脚本里跑。
    const mkProcCtx = () => {
        const seen = { kills: [], spawned: [] };
        const ctx = vm.createContext({
            Buffer, Promise, Number, String, Object, Array, Error, JSON, Math, Symbol, Set,
            process: { platform: 'linux' },
            child_process_1: { spawn: (exe) => { const p = new FakeProc(exe); seen.spawned.push(p); return p; } },
            process_supervisor_1: { terminateProcessTree: (p) => seen.kills.push(p.tag) },
            console
        });
        vm.runInContext([
            budgetSrc.replace(/^const\s/, 'let '),
            activeSrc, normSrc, equalSrc, spawnSrc,
            'this.__setBudget = (n) => { MAX_WORKER_OUTPUT_BYTES = n; };',
            'this.__peek = () => ({ budget: MAX_WORKER_OUTPUT_BYTES, size: activeProcesses.size });'
        ].join('\n'), ctx);
        return { ctx, seen };
    };
    const eqCtx = vm.createContext({ Buffer, String, Number });
    vm.runInContext(`${normSrc}\n${equalSrc};`, eqCtx);
    const eq = (a, b) => vm.runInContext(`outputsEqual(${JSON.stringify(a)}, ${JSON.stringify(b)})`, eqCtx);

    // 把真循环体整条搬进 vm 跑：stop 从哪个 await 后面生效，只看 trace 里各计数器停在哪。
    const runLoop = ({ useFast = false, flipAt = '', stopBefore = false, pairMode = 'ok', jsMode = 'same' } = {}) => {
        const trace = { gen: 0, js: 0, pair: 0, fails: [], posts: [] };
        const lctx = vm.createContext({ Buffer, Number, String, Object, Array, Error, JSON, Math, Promise, trace });
        const jsFlip = flipAt === 'js1' ? 'if (trace.js === 1) running = false;'
            : flipAt === 'js2' ? 'if (trace.js === 2) running = false;' : '';
        const PAIR = {
            ok: "{ code1: 0, code2: 0, ms: 5, out1: Buffer.from('same'), out2: Buffer.from('same'), truncated1: false, truncated2: false }",
            truncated: "{ code1: 0, code2: 0, ms: 5, out1: Buffer.from('same'), out2: Buffer.from('same'), truncated1: true, truncated2: false }",
            mismatch: "{ code1: 0, code2: 0, ms: 5, out1: Buffer.from('a'), out2: Buffer.from('b'), truncated1: false, truncated2: false }",
            stdtle: '{ code1: -3, code2: 0, ms: 5, out1: Buffer.from(\'\'), out2: Buffer.from(\'\'), truncated1: false, truncated2: false }'
        }[pairMode];
        // 非 fastpath 的两个程序各调一次 runJs：按奇偶次返回不同输出，
        // 用来验「差异判定走的是同一套 normalizeOutput」而不是裸比字节。
        const jsReturn = jsMode === 'differ'
            ? "(trace.js % 2 ? okRun : { code: 0, ms: 5, output: Buffer.from('other') })"
            : jsMode === 'trailing'
                ? "(trace.js % 2 ? okRun : { code: 0, ms: 5, output: Buffer.from('same\\r\\n') })"
                : 'okRun';
        vm.runInContext([
            normSrc, equalSrc,
            `let running = ${stopBefore ? 'false' : 'true'};`,
            'let lastGenMs = 0, lastStdMs = 0, lastTestMs = 0;',
            "const startIdx = 0, count = 3, gen = 'gen.exe', genTimeout = 0, stdPath = 'std.exe', testPath = 'test.exe', timeout = 1000;",
            `const useFast = ${useFast};`,
            'const okRun = { code: 0, ms: 5, output: Buffer.from(\'same\') };',
            `const runGenerator = async () => { trace.gen++; ${flipAt === 'gen' ? 'running = false;' : ''} return okRun; };`,
            `const runJs = async () => { trace.js++; ${jsFlip} return ${jsReturn}; };`,
            `const runFastPair = () => { trace.pair++; return ${PAIR}; };`,
            'const fail = (i, kind, code) => { trace.fails.push([i, kind, code]); };',
            "const worker_threads_1 = { parentPort: { postMessage: (m) => trace.posts.push(m.type) } };",
            `this.__done = (async () => { ${loopSrc} })();`
        ].join('\n'), lctx);
        return lctx.__done.then(() => trace, (e) => { trace.error = String((e && e.stack) || e); return trace; });
    };

    return (async () => {
        const real = mkProcCtx();
        push('输出预算是正的有限数（写成 0 就是一口数据都收不下）',
            real.ctx.__peek().budget > 1024 * 1024 && Number.isFinite(real.ctx.__peek().budget),
            String(real.ctx.__peek().budget));

        const procA = await vm.runInContext('spawnProcess("a", [], undefined)', real.ctx);
        const procB = await vm.runInContext('spawnProcess("b", [], undefined)', real.ctx);
        push('每个子进程各自登记进 activeProcesses（退回单一 currentProc 就看不见并发子进程）',
            real.ctx.__peek().size === 2, String(real.ctx.__peek().size));
        procA.fire('close', 0);
        push('close 只摘掉自己那个进程，另一个仍在跟踪',
            real.ctx.__peek().size === 1, String(real.ctx.__peek().size));
        push('close 结算 exitCode、置 done，收集回调跑完即清空',
            procA._done === true && procA._result.exitCode === 0, JSON.stringify(procA._result));
        const procErr = await vm.runInContext('spawnProcess("e", [], undefined)', real.ctx);
        procErr.fire('error', new Error('spawn ENOENT'));
        push('error 也走同一套摘除，并把错误信息带进结果',
            procErr._result.error === 'spawn ENOENT' && procErr._result.exitCode === -1
            && real.ctx.__peek().size === 1, JSON.stringify(procErr._result));

        // 预算是 stdout+stderr **共享**的一条总额度：先各收 2 字节把额度用满，
        // 下一口数据 remaining 已经是 0，此时应当只标记超限并杀进程，一个字节都不再收。
        const full = mkProcCtx();
        full.ctx.__setBudget(4);
        const procC = await vm.runInContext('spawnProcess("c", [], undefined)', full.ctx);
        procC.stdout.push(Buffer.from('ab'));
        procC.stderr.push(Buffer.from('cd'));
        push('预算内的 stdout/stderr 原样收下，一个进程都不杀',
            procC._collect().length === 2 && procC._stderr().length === 2 && full.seen.kills.length === 0,
            JSON.stringify({ out: procC._collect().toString(), err: procC._stderr(), kills: full.seen.kills }));
        procC.stdout.push(Buffer.from('efgh'));
        push('额度用尽后再来的数据一字节都不收，只标记超限并杀掉整棵进程树',
            procC._collect().toString() === 'ab' && procC._outputTruncated() === true
            && full.seen.kills.length === 1 && full.seen.kills[0] === 'c',
            JSON.stringify({ collected: procC._collect().toString(), truncated: procC._outputTruncated(), kills: full.seen.kills }));
        procC.stdout.push(Buffer.from('zzz'));
        procC.stderr.push(Buffer.from('zzz'));
        push('截断之后的数据一律不再收，也不会重复杀第二次',
            procC._collect().length === 2 && procC._stderr().length === 2 && full.seen.kills.length === 1,
            JSON.stringify({ out: procC._collect().length, err: procC._stderr().length, kills: full.seen.kills.length }));

        // 半口越界（remaining>0 且 buffer 更长）时必须补到额度为止，不能整口丢弃：
        // 丢掉这段就等于把「已经拿到的输出」也一起抹了，导出用例时会是空的。
        const part = mkProcCtx();
        part.ctx.__setBudget(4);
        const procP = await vm.runInContext('spawnProcess("p", [], undefined)', part.ctx);
        procP.stdout.push(Buffer.from('ab'));
        procP.stdout.push(Buffer.from('efg'));
        push('最后一口数据只截到预算长度（前 4 字节保留），并标记超限',
            procP._collect().toString() === 'abef' && procP._outputTruncated() === true
            && part.seen.kills.length === 1,
            JSON.stringify({ collected: procP._collect().toString(), truncated: procP._outputTruncated(), kills: part.seen.kills }));
        const exact = mkProcCtx();
        exact.ctx.__setBudget(4);
        const procD = await vm.runInContext('spawnProcess("d", [], undefined)', exact.ctx);
        procD.stdout.push(Buffer.from('abcd'));
        push('正好用满预算不算超限（<= 写成 < 会把正常规模的数据判成溢出）',
            procD._outputTruncated() === false && exact.seen.kills.length === 0,
            JSON.stringify({ truncated: procD._outputTruncated(), kills: exact.seen.kills }));
        // 额度见底那一瞬间就必须判超限，哪怕后续只是流上一口空数据：
        // 只按「这一口装不装得下」判，采集会在满额状态下永远停在「还没超限」，
        // 上层也就不会报 output_limit。
        procD.stdout.push(Buffer.from(''));
        push('额度耗尽后哪怕来一口空数据也算超限（不能只在「这一口溢出」时才翻脸）',
            procD._outputTruncated() === true && exact.seen.kills.length === 1,
            JSON.stringify({ truncated: procD._outputTruncated(), kills: exact.seen.kills }));

        push('归一化只抹平行尾与空白差异：CRLF、行尾空格、尾随空行都算相同',
            eq('1\r\n2', '1\n2') === true && eq('1  \n2', '1\n2') === true
            && eq('1\t\t\n2', '1\n2') === true && eq('1\n\n\n', '1') === true
            && eq('1\n', '1') === true && eq('1  ', '1') === true,
            JSON.stringify([eq('1\r\n2', '1\n2'), eq('1  \n2', '1\n2'), eq('1\n\n\n', '1'), eq('1  ', '1')]));
        push('真不同的内容仍然判不等（归一化不能把差异也抹平）',
            eq('1\n2', '1\n3') === false && eq('1\n2', '1\n2 3') === false && eq('a', 'a b') === false,
            JSON.stringify([eq('1\n2', '1\n3'), eq('1\n2', '1\n2 3'), eq('a', 'a b')]));
        push('normalizeOutput 容忍空输入（null/undefined 不抛）',
            vm.runInContext('[normalizeOutput(null), normalizeOutput(undefined), normalizeOutput(Buffer.from(""))].join("|")', eqCtx) === '||',
            vm.runInContext('String(normalizeOutput(null))', eqCtx));

        const stopped = await runLoop({ stopBefore: true });
        push('running 已置否时一组都不跑（for 条件里的 running 是唯一入口闸门）',
            stopped.gen === 0 && stopped.js === 0 && stopped.posts.length === 0, JSON.stringify(stopped));
        const afterGen = await runLoop({ flipAt: 'gen' });
        push('生成器 await 之后立刻查停：不再跑标准/测试程序，也不报任何错',
            afterGen.gen === 1 && afterGen.js === 0 && afterGen.fails.length === 0 && afterGen.posts.length === 0,
            JSON.stringify({ gen: afterGen.gen, js: afterGen.js, fails: afterGen.fails, posts: afterGen.posts }));
        const afterStd = await runLoop({ flipAt: 'js1' });
        push('标准程序 await 之后查停：不跑测试程序、不发 progress',
            afterStd.gen === 1 && afterStd.js === 1 && afterStd.posts.length === 0 && afterStd.fails.length === 0,
            JSON.stringify({ js: afterStd.js, posts: afterStd.posts, fails: afterStd.fails }));
        const afterTest = await runLoop({ flipAt: 'js2' });
        push('测试程序 await 之后查停：结果一致也不发 progress',
            afterTest.js === 2 && afterTest.posts.length === 0, JSON.stringify({ js: afterTest.js, posts: afterTest.posts }));
        const clean = await runLoop({});
        push('不停止时 3 组各发一条 progress，一条错都不报（对照组）',
            clean.gen === 3 && clean.js === 6 && clean.posts.length === 3 && clean.fails.length === 0,
            JSON.stringify({ gen: clean.gen, js: clean.js, posts: clean.posts.length, fails: clean.fails }));
        const fastClean = await runLoop({ useFast: true });
        push('fastpath 同样按 count 跑满 3 组',
            fastClean.pair === 3 && fastClean.posts.length === 3 && fastClean.fails.length === 0,
            JSON.stringify({ pair: fastClean.pair, posts: fastClean.posts }));
        const fastTrunc = await runLoop({ useFast: true, pairMode: 'truncated' });
        push('fastpath 输出超限逐组报 output_limit，且一条 progress 都不发',
            fastTrunc.fails.length === 3 && fastTrunc.fails.every((f) => f[1] === 'output_limit' && f[2] === 'output_limit')
            && fastTrunc.posts.length === 0, JSON.stringify(fastTrunc.fails));
        const fastTle = await runLoop({ useFast: true, pairMode: 'stdtle' });
        push('fastpath 标准程序超时按 code -3 认，报 std_tle 而不是「退出码非 0」',
            fastTle.fails.length === 3 && fastTle.fails.every((f) => f[1] === 'std_tle' && f[2] === 'std_timeout'),
            JSON.stringify(fastTle.fails[0]));
        const fastDiff = await runLoop({ useFast: true, pairMode: 'mismatch' });
        push('fastpath 输出不同逐组报 mismatch',
            fastDiff.fails.length === 3 && fastDiff.fails.every((f) => f[1] === 'mismatch'),
            JSON.stringify(fastDiff.fails[0]));
        const slowTrailing = await runLoop({ jsMode: 'trailing' });
        push('非 fastpath 的差异判定走同一套 normalizeOutput：只差行尾空白不算差异',
            slowTrailing.fails.length === 0 && slowTrailing.posts.length === 3,
            JSON.stringify(slowTrailing.fails));
        const slowDiff = await runLoop({ jsMode: 'differ' });
        push('非 fastpath 真差异逐组报 mismatch（归一化没把判等口径松开）',
            slowDiff.fails.length === 3 && slowDiff.fails.every((f) => f[1] === 'mismatch')
            && slowDiff.posts.length === 0, JSON.stringify(slowDiff.fails[0]));

        const stopCtx = vm.createContext({ Set, String, JSON });
        vm.runInContext([
            'let running = true;',
            "const activeProcesses = new Set([{ tag: 'a' }, { tag: 'b' }]);",
            'const killed = [];',
            'const killProc = (p) => { killed.push(p.tag); };',
            "const msg = { type: 'stop' };",
            stopSrc,
            'this.__out = { running, killed: killed.join(","), size: activeProcesses.size };'
        ].join('\n'), stopCtx);
        push('stop 消息把每个在点子进程都杀掉并清空登记表（漏 clear 就永远赖着不放）',
            stopCtx.__out.running === false && stopCtx.__out.killed === 'a,b' && stopCtx.__out.size === 0,
            JSON.stringify(stopCtx.__out));
        return rows;
    })().catch((e) => [{ name: 'worker 守卫自身跑通', cond: false, extra: String((e && e.stack) || e) }]);
})();


check('workflows do not depend on the Node 22-only system CA flag', !workflows.includes('--use-system-ca'));
{
    // 原文：check('markdown fallback does not assign untrusted innerHTML', !preloadSource.includes('innerHTML'))
    // —— 扫错了文件。这个汇（sink）根本不在 preload.js 里，而在
    // src/renderer/js/tabs.js:3427 `container.innerHTML = window.markdownAPI.render(...)`。
    // 于是它是一条永远绿着的空守卫：把兜底分支从 textContent 改成
    // `container.innerHTML = content`（把 markdown 原文当 HTML 塞进 DOM），
    // preload.js 一个字符都不会变，守卫照样 PASS。
    // 现在抽 updateMarkdownPreview 本体，挂在一个「记下每个被写的属性」的假容器上真跑，
    // 断言只看实际落进容器的那几次赋值。
    const mdSrc = classMethod(tabsSource, 'updateMarkdownPreview');
    check('方法体抽取成功: TabManager.updateMarkdownPreview', /^\s*updateMarkdownPreview\(/.test(mdSrc), String(mdSrc).slice(0, 48));
    const mdCtx = vm.createContext({ String });
    const md = compileMethod(mdCtx, mdSrc);
    check('updateMarkdownPreview 编译成可调用函数', typeof md === 'function');
    const EVIL = '<img src=x onerror=alert(1)>';
    // get 也记一笔：insertAdjacentHTML 这类「不是属性赋值」的汇，靠它被读取这个动作现形。
    // 取默认值一律用 `in` 判断而不是解构默认值：解构默认值会把显式传入的
    // undefined 也吃掉，而 undefined 正是这里要测的那一档。
    const runMd = (opts = {}) => {
        const hasApi = 'hasApi' in opts ? opts.hasApi : true;
        const rendered = 'rendered' in opts ? opts.rendered : '<p>RENDERED</p>';
        const content = 'content' in opts ? opts.content : '# hi';
        const filePath = 'filePath' in opts ? opts.filePath : '/docs/a.md';
        const writes = [];
        const reads = [];
        const renderCalls = [];
        mdCtx.window = hasApi
            ? { markdownAPI: { render: (c, f) => { renderCalls.push([c, f]); return rendered; } } }
            : {};
        const container = new Proxy({}, {
            set(target, key, value) { writes.push([String(key), String(value)]); target[key] = value; return true; },
            get(target, key) { reads.push(String(key)); return target[key]; }
        });
        let threw;
        try { md.call({}, container, content, filePath); }
        catch (e) { threw = String((e && e.message) || e); }
        return { writes, reads, renderCalls, threw };
    };

    const shown = runMd();
    check('markdownAPI 在位：容器只被写一次 innerHTML，值是渲染结果',
        shown.threw === undefined && JSON.stringify(shown.writes) === JSON.stringify([['innerHTML', '<p>RENDERED</p>']]),
        JSON.stringify(shown));
    check('渲染调用拿到 filePath（图片相对路径靠它定位，丢了图就裂）',
        shown.renderCalls.length === 1 && shown.renderCalls[0][1] === '/docs/a.md',
        JSON.stringify(shown.renderCalls));
    check('正文为 null 时送进渲染器的是空串（直接传 undefined 会让 markdown-it 抛在渲染路径上）',
        runMd({ content: null }).renderCalls[0][0] === '' &&
        runMd({ content: undefined }).renderCalls[0][0] === '',
        JSON.stringify([runMd({ content: null }).renderCalls, runMd({ content: undefined }).renderCalls]));
    // 两条「不含原文」都必须喂真正的恶意原文，否则断言是空的：
    // 默认正文 '# hi' 里本来就没有 onerror，写进去也不会被逮到。
    const evilShown = runMd({ content: EVIL });
    check('在位路径不把未转义原文写进任何属性（原文只进渲染器，落进容器的是桩返回的渲染结果）',
        evilShown.writes.every((w) => !w[1].includes('onerror')) &&
        evilShown.renderCalls.some((c) => c[0] === EVIL),
        JSON.stringify(evilShown));

    const hidden = runMd({ hasApi: false, content: EVIL });
    check('markdownAPI 缺席：兜底只写 textContent，一个 innerHTML 都不碰',
        hidden.threw === undefined && hidden.writes.length === 1 && hidden.writes[0][0] === 'textContent',
        JSON.stringify(hidden.writes));
    check('兜底文案不回显 markdown 原文（回显就等于把 onerror= 原样交给 DOM）',
        hidden.writes.every((w) => !w[1].includes('onerror')), JSON.stringify(hidden.writes));
    const sinks = [...new Set([...shown.writes, ...hidden.writes].map((w) => w[0]))]
        .concat(shown.reads, hidden.reads);
    check('两个分支用到的容器属性只有 innerHTML / textContent（冒出 outerHTML、insertAdjacentHTML 之类新汇就红）',
        sinks.every((k) => k === 'innerHTML' || k === 'textContent'), JSON.stringify(sinks));
    // 政策另半边：渲染器本身要转义内联 HTML —— 那条在 tests/preload.test.js 里真调
    // markdownAPI.render 断言过（'markdown 转义内联 HTML'），这里不重复扫源码。
}
check('Linux hard memory limits use a non-shell prlimit wrapper', read('src/utils/process-supervisor.js').includes('getResourceLimitedSpawn') && read('src/utils/process-supervisor.js').includes('prlimit'));
check('native fastspawn has a reproducible POSIX build script', read('scripts/build-fastspawn.js').includes('node-gyp') && read('binding.gyp').includes('fastspawn.cc'));
check('release downloaders share one hardened implementation', read('scripts/lib/release-downloader.js').includes('maxRedirects') && read('scripts/download-clangd.js').includes('createReleaseDownloader') && read('scripts/download-clang-format.js').includes('createReleaseDownloader'));
const updateRowsRef = [];
{
    // 「自动更新检查已经拆掉」原先是五条 `!mainSource.includes(...)` 的字面量缺席断言：
    //   !includes('function checkDailyUpdate') / !includes('setAutoUpdateCheckInProgress(true)')
    //   !includes('oicpp.mywwzh.top/api/checkUpdate') / !includes('.../api/getUpdateFilelist')
    //   !mainSource.includes('downloadAndInstallUpdate')
    // 缺席断言两个方向都错：往源码里加一句 `// 以前叫 downloadAndInstallUpdate` 的注释
    // 会把它判红（假阳），而把请求改写成 `fetch(base + '/checkUpdate')`、或把忙标志
    // 换个 setter 名字，它就完全看不见（假阴）。三条 URL 其实是一件事：
    // 「主进程不会向更新接口发请求」，而管这件事的门是 fetch-remote-json 的白名单 ——
    // 那半边并到上面远程代理那块去了（搜「更新接口从渲染层点名」）。
    // 这里剩下的两条改成：把 checkForUpdates 本体抽出来真跑，看两条路径各自做了什么。
    const updateRows = (() => {
        const rows = [];
        const push = (name, cond, extra = '') => rows.push({ name, cond, extra });
        const updateFns = [...mainSource.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
        push('主进程函数声明表抽取成功', updateFns.length > 50, `${updateFns.length} 个`);
        for (const gone of ['checkDailyUpdate', 'downloadAndInstallUpdate', 'getUpdateFilelist']) {
            push(`函数声明表里没有 ${gone}（自动检查/静默安装整条链路都不在，注释和字符串里提它不受影响）`,
                !updateFns.includes(gone), JSON.stringify(updateFns.filter((n) => /update|install/i.test(n))));
        }

        const updSrc = funcDecl(mainSource, 'checkForUpdates');
        push('函数体抽取成功: checkForUpdates', /^\s*(?:async\s+)?function\s+checkForUpdates\(/.test(updSrc), String(updSrc).slice(0, 46));
        const dialogs = [];
        const touched = [];
        const errs = [];
        const recording = () => ({ showMessageBox: async (_w, opt) => { dialogs.push(opt); return { response: 0 }; } });
        const updCtx = vm.createContext({
            // 凡是能把「检查更新」接回网络的入口都先摆在这儿盯着：真被调到了就记一笔，
            // 认不出来的新依赖会抛 ReferenceError，由下面每条「不抛错」的断言兜住。
            t: (key) => `T:${key}`,
            logError: (...a) => errs.push(a.map(String).join(' ')),
            logInfo: () => { },
            mainWindow: { id: 1 },
            dialog: recording(),
            axios: { get: (...a) => { touched.push(['axios.get', a[0]]); return Promise.resolve({}); } },
            net: { request: () => { touched.push(['net.request']); } },
            shell: { openExternal: (...a) => { touched.push(['shell.openExternal', a[0]]); return Promise.resolve(); } },
            setAutoUpdateCheckInProgress: (...a) => { touched.push(['setAutoUpdateCheckInProgress', a[0]]); },
            downloadAndInstallUpdate: (...a) => { touched.push(['downloadAndInstallUpdate', a[0]]); },
            checkDailyUpdate: () => { touched.push(['checkDailyUpdate']); },
            Promise, String, Object, Array, JSON
        });
        vm.runInContext(`this.__checkForUpdates = (${updSrc});`, updCtx);
        const checkForUpdates = updCtx.__checkForUpdates;
        push('checkForUpdates 编译成可调用函数', typeof checkForUpdates === 'function');
        const runUpd = async (call, dialog) => {
            dialogs.length = 0; touched.length = 0; errs.length = 0;
            updCtx.dialog = dialog || recording();
            let threw;
            try { await call(); }
            catch (e) { threw = String((e && e.message) || e); }
            return { dialogs: dialogs.slice(), touched: touched.slice(), errs: errs.slice(), threw };
        };
        return (async () => {
            const auto = await runUpd(() => checkForUpdates());
            check('自动路径（不传参）彻底空转：不弹对话框、不碰网络、不置忙标志',
                auto.threw === undefined && auto.dialogs.length === 0 && auto.touched.length === 0 && auto.errs.length === 0,
                JSON.stringify(auto));
            const explicitFalse = await runUpd(() => checkForUpdates(false));
            check('显式传 false 的自动路径同样空转（isManual 判的是值不是「传没传」）',
                explicitFalse.threw === undefined && explicitFalse.dialogs.length === 0 && explicitFalse.touched.length === 0,
                JSON.stringify(explicitFalse));
            const manual = await runUpd(() => checkForUpdates(true));
            check('手动路径只弹一次「不可用」提示，仍然一次网络都不碰',
                manual.threw === undefined && manual.dialogs.length === 1
                && manual.dialogs[0].message === 'T:main.checkUpdateUnavailable'
                && manual.touched.length === 0,
                JSON.stringify(manual));
            check('提示带 title/detail（只给一句 message 用户不知道自己点错了什么）',
                manual.dialogs.length === 1 && manual.dialogs[0].title === 'T:main.checkUpdateTitle'
                && manual.dialogs[0].detail === 'T:main.checkUpdateUnavailableDetail',
                JSON.stringify(manual.dialogs[0] || null));
            // 对话框弹不出来（主窗口已关）时不能把 rejection 冒泡给菜单点击那一路。
            const broken = await runUpd(() => checkForUpdates(true),
                { showMessageBox: () => Promise.reject(new Error('window gone')) });
            check('showMessageBox 拒绝时记一条日志就收场，不把 rejection 抛给菜单点击',
                broken.threw === undefined && broken.errs.length === 1 && broken.touched.length === 0,
                JSON.stringify(broken));
            const syncBoom = await runUpd(() => checkForUpdates(true),
                { showMessageBox: () => { throw new Error('sync boom'); } });
            check('对话框同步抛出时同样被兜住',
                syncBoom.threw === undefined && syncBoom.errs.length === 1, JSON.stringify(syncBoom));
            return rows;
        })().then((r) => r, (e) => [{ name: '更新检查守卫自身跑通', cond: false, extra: String((e && e.stack) || e) }]);
    })();
    updateRowsRef.push(updateRows);
}
{
    // 渲染层那条「不许再挂 window.Buffer 桥」的政策，原先锁四段字面量：
    //   !preloadSource.includes("exposeInMainWorld('Buffer'") && !rendererMainSource.includes('window.Buffer')
    //   && rendererMainSource.includes('new Uint8Array(arrayBuffer)') && rendererMainSource.includes('btoa(binary)')
    // 四段用 && 串起来挡的其实是一件事：Base64 通道必须自己逐字节啃出来。
    // 把它改回 `return Buffer.from(arrayBuffer).toString('base64')` 之后，
    // `new Uint8Array(arrayBuffer)` 与 `btoa(binary)` 在文件别处还在（本轮实测：全仓
    // 各有 1 处其它出处），四段里红两段、整条守卫立刻失守 —— 而 Buffer 一旦回到渲染层，
    // 拿到的就是 Node 的池化 ArrayBuffer（可能被复用）和另一套字节序语义，
    // 正是这轮安全收敛专门拆掉的东西。
    // 现在把真方法抽出来，在一个**没有 Buffer 全局**的沙箱里跑：
    // 跑得出正确 base64，才算这条通道真的不依赖它。
    const b64Src = classMethod(rendererMainSource, 'arrayBufferToBase64');
    check('方法体抽取成功: OICPPApp.arrayBufferToBase64', /^\s*arrayBufferToBase64\(/.test(b64Src), String(b64Src).slice(0, 40));
    const warns = [];
    const b64Ctx = vm.createContext({
        Uint8Array, String, ArrayBuffer, JSON, Math, Number, Array, Error, TypeError,
        btoa, atob, logWarn: (...a) => warns.push(a.map((v) => String(v && v.message ? `${v.constructor.name}: ${v.message}` : v)))
    });
    const b64 = compileMethod(b64Ctx, b64Src);
    check('arrayBufferToBase64 编译成可调用函数', typeof b64 === 'function');
    check('沙箱里确实没有 Buffer 全局（下面每条转出正确才算这条通道不靠它）',
        vm.runInContext('typeof Buffer', b64Ctx) === 'undefined');
    const buf = (arr) => new Uint8Array(arr).buffer;
    const bytesFromB64 = (s) => Array.from(new Uint8Array(atob(String(s)).split('').map((c) => c.charCodeAt(0))));
    const call = (input) => {
        warns.length = 0;
        try { return { out: b64.call({}, input), warns: warns.slice() }; }
        catch (e) { return { out: null, warns: warns.slice(), threw: String((e && e.message) || e) }; }
    };

    const hi = call(buf([72, 105]));
    check('两字节缓冲转出 "SGk="（逐字节 fromCharCode + btoa 这条自研通道真的在跑）',
        hi.threw === undefined && hi.out === 'SGk=' && hi.warns.length === 0, JSON.stringify(hi));
    const abc = call(buf([65, 66, 67]));
    check('三字节正好整除，末尾不补 padding',
        abc.out === 'QUJD', JSON.stringify(abc));
    for (const seed of [[0], [0, 1, 2, 253, 254, 255], [0x00, 0xFF, 0x80], Array.from({ length: 256 }, (_, i) => i)]) {
        const r = call(buf(seed));
        check(`转出结果能用 atob 逐字节还原（${seed.length} 字节，含 >0x7F 的高字节）`,
            r.threw === undefined && r.warns.length === 0
            && JSON.stringify(bytesFromB64(r.out)) === JSON.stringify(seed),
            JSON.stringify({ len: seed.length, out: String(r.out).slice(0, 24), threw: r.threw }));
    }
    const big = call(buf(Array.from({ length: 5000 }, (_, i) => i % 256)));
    check('5000 字节整包转出，不分块截断（加个 1024 上限就静默丢尾部）',
        big.threw === undefined && bytesFromB64(big.out).length === 5000 && big.warns.length === 0,
        JSON.stringify({ b64len: String(big.out).length, decoded: bytesFromB64(big.out).length }));
    for (const empty of [null, undefined, 0, '']) {
        const r = call(empty);
        check(`空输入（${JSON.stringify(empty)}）直接退化成空串：不抛、也不算转换失败`,
            r.threw === undefined && r.out === '' && r.warns.length === 0, JSON.stringify(r));
    }
    // 注：这一档锁的是「输出」，不是那行 `if (!arrayBuffer)` 本身 —— 实测把早退整段删掉
    // 这四条照样绿（null/undefined/0/"" 都 ToNumber 成 0，new Uint8Array 拿到长度 0 的数组，
    // btoa("") 还是空串）。早退现在是纯优化，不再是一道保护：它当年是为 Buffer.from(undefined)
    // 会抛 TypeError 才加的。改成抛错或返回 null 则会被这四条逮到。
    const zeroLen = call(new ArrayBuffer(0));
    check('长度为 0 的 ArrayBuffer 同样退化成空串（空缓冲不是错误）',
        zeroLen.out === '' && zeroLen.warns.length === 0, JSON.stringify(zeroLen));
    // 真正构造不出来的入参：长度是负数 / Infinity，或值本身不可转成数字。
    // （{} 不算：new Uint8Array({}) 是长度 0，跟空缓冲同命，走不到 catch。）
    // 只锁「一次 logWarn、带上 cause 两个实参」，不锁具体文案 —— 文案换了不该红，
    // 但把 logWarn() 写成无参、或者把 error 丢掉，就该红。
    for (const bad of [-1, Infinity, Symbol('bytes')]) {
        const r = call(bad);
        check(`构造不出字节串的入参（${typeof bad === 'symbol' ? 'Symbol' : bad}）走 catch：回空串并留一条带 cause 的 logWarn`,
            r.threw === undefined && r.out === '' && r.warns.length === 1 && r.warns[0].length === 2,
            JSON.stringify(r));
    }
    check('裸对象入参不抛、也不假装失败（new Uint8Array({}) 就是长度 0）',
        call({}).out === '' && call({}).warns.length === 0, JSON.stringify(call({})));
    // 政策另半边：preload 不许把 Buffer 挂进 window。那条归属 preload 的行为测试
    // （那边已经真加载了 preload.js 并收齐 exposeInMainWorld 的名字表），
    // 这里不再用字面量重复一遍。
}
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

{
    // 原文：check('startup font validation stays local',
    //   !settingsInitSource.includes('updateSettings({ font: validatedFont })') && settingsInitSource.includes('fontFamily = validatedFont'))
    // 两段字面量：前一段锁「别写成这句 updateSettings」——换成
    // `updateSettings({ font })` / `saveSetting('font', …)` / 抽个 persistFont() 出来调，
    // 一样是启动即落盘，但它看不见；后一段锁 `fontFamily = validatedFont` 这行字的长相,
    // 改成 `fontFamily = validatedFont || fontFamily`（语义更好）反而被判红。
    // 现在把整个 if (font || fontSizeRaw) 抽出来在假 DOM 里真跑：校验值到底有没有落到
    // 元素和 CSS 变量上、updateSettings 到底被调了几次，都是可观测的。
    const fontBlock = ifStatement(settingsInitSource, /^\s*if \(font \|\| fontSizeRaw\) \{/m);
    check('字体应用整块抽取成功: settings-init 的 if (font || fontSizeRaw)',
        fontBlock.startsWith('if (font || fontSizeRaw)'), `${fontBlock.length} chars`);
    class FontEl {
        constructor() { this.style = new Proxy({}, { set: (t, k, v) => { t[k] = v; return true; } }); }
    }
    const fCtx = vm.createContext({ HTMLElement: FontEl, String, Number, Object, Array, Error, document: {}, window: {} });
    // if 语句不能当表达式用，所以塞进一个无参函数的身体里。
    vm.runInContext(`this.__applyFont = () => { ${fontBlock} };`, fCtx);
    const applyFont = fCtx.__applyFont;
    check('字体块编译成可调用函数', typeof applyFont === 'function');
    const runFont = ({ font, fontSizeRaw, detector, breadcrumbCount = 1 } = {}) => {
        const els = [new FontEl(), new FontEl()];
        const crumbs = Array.from({ length: breadcrumbCount }, () => new FontEl());
        const cssVars = [];
        const updates = [];
        const validated = [];
        fCtx.font = font;
        fCtx.fontSizeRaw = fontSizeRaw;
        fCtx.window = detector === undefined ? {} : { fontDetector: { validateFont: (f) => { validated.push(f); return detector; } } };
        fCtx.updateSettings = (...a) => updates.push(a);
        fCtx.document = {
            querySelectorAll: (sel) => (sel === '.folder-picker-breadcrumb' ? crumbs : els),
            documentElement: { style: { setProperty: (k, v) => cssVars.push([k, String(v)]) } }
        };
        let threw;
        try { applyFont(); }
        catch (e) { threw = String((e && e.message) || e); }
        return { els, crumbs, cssVars, updates, validated, threw };
    };

    const varOf = (r, name) => (r.cssVars.find((v) => v[0] === name) || [])[1];
    const replaced = runFont({ font: 'KaiTi', fontSizeRaw: 16, detector: 'SimSun' });
    check('校验值和设置里的不一样时，页面用的是校验值（元素与 CSS 变量两处都是）',
        replaced.threw === undefined && replaced.els[0].style.fontFamily === 'SimSun' &&
        replaced.crumbs[0].style.fontFamily === 'SimSun' && varOf(replaced, '--editor-font-family') === 'SimSun',
        JSON.stringify({ threw: replaced.threw, el: replaced.els[0].style.fontFamily, css: varOf(replaced, '--editor-font-family') }));
    check('启动阶段一次 updateSettings 都不调（把校验结果写回设置等于每次启动多落一次盘，还跟用户在设置页选的字体打架）',
        replaced.updates.length === 0 && varOf(runFont({ font: 'KaiTi', detector: 'SimSun' }), '--editor-font-family') === 'SimSun',
        JSON.stringify(replaced.updates));
    check('校验只在 font 是字符串时发生，送进去的就是设置里那个字体名',
        replaced.validated.length === 1 && replaced.validated[0] === 'KaiTi',
        JSON.stringify(replaced.validated));

    const same = runFont({ font: 'Consolas', fontSizeRaw: 14, detector: 'Consolas' });
    check('校验结果与设置一致时页面照常用它（不因为「没变化」就漏掉一次赋值）',
        same.threw === undefined && same.els[0].style.fontFamily === 'Consolas' && varOf(same, '--editor-font-family') === 'Consolas',
        JSON.stringify({ threw: same.threw, el: same.els[0].style.fontFamily }));

    const noDetector = runFont({ font: 'KaiTi', fontSizeRaw: 14 });
    check('fontDetector 还没加载时不猜字体：直接用设置值，也不因此崩',
        noDetector.threw === undefined && noDetector.validated.length === 0 &&
        noDetector.els[0].style.fontFamily === 'KaiTi' && varOf(noDetector, '--editor-font-family') === 'KaiTi',
        JSON.stringify({ threw: noDetector.threw, validated: noDetector.validated }));

    // 这一档必须把 detector 也摆上：只带字号时如果连 fontDetector 都没有，
    // 「去掉 font !== undefined 那道门」这种变异就没人调 validateFont，断言成了空的。
    const sizeOnly = runFont({ font: undefined, fontSizeRaw: 15, detector: 'SimSun' });
    check('只带字号的设置不去校验字体（font 是 undefined 时 validateFont 一次都不该调）',
        sizeOnly.threw === undefined && sizeOnly.validated.length === 0,
        JSON.stringify({ threw: sizeOnly.threw, validated: sizeOnly.validated }));
    check('没指定字体时不覆盖编辑器字体，但 CSS 变量落到默认 Consolas（也不能被校验结果顶掉）',
        sizeOnly.els.every((el) => el.style.fontFamily === undefined) &&
        varOf(sizeOnly, '--editor-font-family') === 'Consolas',
        JSON.stringify({ el: sizeOnly.els[0].style.fontFamily, css: varOf(sizeOnly, '--editor-font-family') }));

    const fallbackSize = runFont({ font: 'KaiTi', fontSizeRaw: undefined });
    check('字号缺省时落到 14px（写成 0px 编辑器就没法看了）',
        fallbackSize.threw === undefined && varOf(fallbackSize, '--editor-font-size') === '14px' &&
        fallbackSize.els[0].style.fontSize === undefined,
        JSON.stringify({ threw: fallbackSize.threw, css: varOf(fallbackSize, '--editor-font-size'), el: fallbackSize.els[0].style.fontSize }));
    const sized = runFont({ font: 'KaiTi', fontSizeRaw: 18 });
    check('字号两处都写：元素与 CSS 变量',
        sized.els[0].style.fontSize === '18px' && varOf(sized, '--editor-font-size') === '18px',
        JSON.stringify([sized.els[0].style.fontSize, varOf(sized, '--editor-font-size')]));

    const quiet = runFont({ font: undefined, fontSizeRaw: undefined });
    check('font 和字号都没有时整块空转（不写 CSS、不弹校验、也不落盘）',
        quiet.threw === undefined && quiet.cssVars.length === 0 && quiet.validated.length === 0 && quiet.updates.length === 0,
        JSON.stringify(quiet));
}
const downloaderRowsRef = [];
{
    // 原文：check('downloader releases probe response bodies',
    //   (downloaderSource.match(/\.body\.resume\(\)/g) || []).length >= 3);
    // 「数一下这行字出现了几次」离题太远：把 `headResponse.body.resume()` 从 if 之前挪到
    // if 之后，次数一个字没变，而 accept-ranges: bytes 那条早退路径上的响应体就再也没人排空
    // ——undici 的 connection 会一直挂在池里等 body 被消费，探测几次就少几个连接。
    // 现在抽真方法在假 fetch 上跑：每条返回路径都数一次「发过几个请求、每个 body 被 resume 了几次」。
    downloaderRowsRef.push((async () => {
        const rows = [];
        const push = (name, cond, extra = '') => rows.push({ name, cond, extra });
        const rangeSrc = classMethod(downloaderSource, 'checkRangeSupport');
        const sizeSrc = classMethod(downloaderSource, 'getFileSize');
        push('方法体抽取成功: MultiThreadDownloader.checkRangeSupport',
            /^\s*async checkRangeSupport\(/.test(rangeSrc), String(rangeSrc).slice(0, 40));
        push('方法体抽取成功: MultiThreadDownloader.getFileSize',
            /^\s*async getFileSize\(/.test(sizeSrc), String(sizeSrc).slice(0, 40));
        const dlCtx = vm.createContext({ Promise, String, Number, Object, Array, Error, parseInt });
        vm.runInContext(`this.__range = ${rangeSrc.replace(/^\s*async\s+/, 'async function ')};
            this.__size = ${sizeSrc.replace(/^\s*async\s+/, 'async function ')};`, dlCtx);
        const checkRangeSupport = dlCtx.__range;
        const getFileSize = dlCtx.__size;
        push('两个探测方法编译成可调用函数',
            typeof checkRangeSupport === 'function' && typeof getFileSize === 'function');

        // 假 fetch：按脚本依次回包。bodies 只收「真的交到被测代码手上」的那些响应，
        // 于是「每个交出去的 body 被 resume 恰好一次」是一条能数的政策，不是数正则。
        const bootProbe = (script) => {
            const requests = [];
            const bodies = [];
            const queue = script.map((r) => {
                if (r.error) return { error: r.error };
                const body = { resumes: 0 };
                body.resume = () => {
                    body.resumes++;
                    if (r.resumeThrows) throw new Error('body already detached');
                };
                bodies.push(body);
                return {
                    status: r.status === undefined ? 200 : r.status,
                    headers: { get: (k) => (r.headers || {})[String(k).toLowerCase()] },
                    body
                };
            });
            const warns = [];
            dlCtx.makeRequest = async (url, opt) => {
                const o = opt || {};
                requests.push({ url, method: o.method || 'GET', range: (o.headers || {})['Range'] || '' });
                const next = queue.shift();
                if (!next) throw new Error('假 fetch 脚本用完了（被测代码多发了请求）');
                if (next.error) throw new Error(next.error);
                return next;
            };
            dlCtx.logWarn = (...a) => warns.push(a.map((v) => (v && v.message) || String(v)).join(' '));
            dlCtx.errorInfo = (e) => ({ message: String((e && e.message) || e) });
            return { requests, warns, bodies, drains: () => bodies.map((b) => b.resumes) };
        };
        const onceEach = (p) => p.bodies.length > 0 && p.bodies.every((b) => b.resumes === 1);
        const state = (p) => JSON.stringify({ requests: p.requests, drains: p.drains(), warns: p.warns });

        const bytesH = bootProbe([{ headers: { 'accept-ranges': 'bytes' } }]);
        const fast = await checkRangeSupport.call({}, 'https://example.invalid/a.zip');
        push('accept-ranges: bytes 时直接判定支持，且只发一个 HEAD',
            fast === true && bytesH.requests.length === 1 && bytesH.requests[0].method === 'HEAD', state(bytesH));
        push('早退那条路径也把 HEAD 的响应体排空了（resume 挪到 return 之后就会漏连接）',
            onceEach(bytesH) && bytesH.warns.length === 0, state(bytesH));

        const detached = bootProbe([{ headers: { 'accept-ranges': 'bytes' }, resumeThrows: true }]);
        const stillOk = await checkRangeSupport.call({}, 'https://example.invalid/e.zip');
        push('body 已经 detached、resume() 自己抛错时照样返回判定（那层 try 不是摆设）',
            stillOk === true && detached.bodies[0].resumes === 1 && detached.warns.length === 0, state(detached));

        const twoStep = bootProbe([{ headers: {}, status: 200 }, { status: 206 }]);
        const slow = await checkRangeSupport.call({}, 'https://example.invalid/b.zip');
        push('没有 accept-ranges 时补一发 Range: bytes=0-1，看 206',
            slow === true && twoStep.requests.length === 2
                && twoStep.requests[1].method === 'GET' && twoStep.requests[1].range === 'bytes=0-1', state(twoStep));
        push('两步探测的两个响应体都被排空，一个不多一个不少',
            onceEach(twoStep) && twoStep.bodies.length === 2, state(twoStep));

        // 上面 detached 只让 HEAD 那个 body 抛，range 探测那处 try 一条场景都没碰过
        // （实测「删掉 range 那层 try」能逃逸）；第二个包补一条，两处 resume 各有各的兜底。
        const rangeDetached = bootProbe([{ headers: {}, status: 200 }, { status: 206, resumeThrows: true }]);
        const slowOk = await checkRangeSupport.call({}, 'https://example.invalid/b2.zip');
        push('range 探测的 body 抛错也照常判定，不因此退回 false',
            slowOk === true && rangeDetached.bodies[1].resumes === 1 && rangeDetached.warns.length === 0, state(rangeDetached));

        const rejected = bootProbe([{ headers: {}, status: 200 }, { status: 200 }]);
        const noRange = await checkRangeSupport.call({}, 'https://example.invalid/c.zip');
        push('两发之后仍不是 206 就判不支持，且这条路径不冒日志',
            noRange === false && rejected.requests.length === 2 && rejected.warns.length === 0, state(rejected));
        push('不支持那条分支同样把两个 body 排空（三处 resume 全在两条返回路径上）',
            onceEach(rejected) && rejected.bodies.length === 2, state(rejected));

        const boom = bootProbe([{ error: 'network down' }]);
        const errored = await checkRangeSupport.call({}, 'https://example.invalid/d.zip');
        push('fetch 抛错时吞掉、记一条日志、判不支持（不把 rejection 冒给下载流程）',
            errored === false && boom.bodies.length === 0
                && boom.warns.length === 1 && boom.warns[0].includes('network down'), state(boom));

        const sized = bootProbe([{ headers: { 'content-length': '2097152' } }]);
        const len = await getFileSize.call({}, 'https://example.invalid/f.zip');
        push('getFileSize 按十进制读出长度，且排空 HEAD 的 body 后才返回',
            len === 2097152 && onceEach(sized) && sized.warns.length === 0, state(sized));

        const noLen = bootProbe([{ headers: {} }]);
        const missing = await getFileSize.call({}, 'https://example.invalid/g.zip');
        push('服务器不回 content-length 时返回 null 而不是 NaN/0（0 会被当成空文件直接下完）',
            missing === null && onceEach(noLen) && noLen.warns.length === 0, state(noLen));

        const junkLen = bootProbe([{ headers: { 'content-length': 'unknown' } }]);
        const junk = await getFileSize.call({}, 'https://example.invalid/j.zip');
        push('content-length 是垃圾串时现状返回 NaN —— 记账条，真去修成 null 时这条要一起改',
            Number.isNaN(junk) && onceEach(junkLen), state(junkLen));

        const sizeBoom = bootProbe([{ error: 'network down' }]);
        const sizeErr = await getFileSize.call({}, 'https://example.invalid/h.zip');
        push('getFileSize 的 fetch 抛错时同样吞掉并记日志，返回 null',
            sizeErr === null && sizeBoom.warns.length === 1 && sizeBoom.warns[0].includes('network down'), state(sizeBoom));

        const sizeDetached = bootProbe([{ headers: { 'content-length': '7' }, resumeThrows: true }]);
        const detachedSize = await getFileSize.call({}, 'https://example.invalid/i.zip');
        push('getFileSize 也兜得住 resume 抛错：照样给出长度',
            detachedSize === 7 && sizeDetached.bodies[0].resumes === 1, state(sizeDetached));

        return rows;
    })().then((r) => r, (e) => [{ name: '下载探测守卫自身跑通', cond: false, extra: String((e && e.stack) || e) }]));
}
{
    // 原文：check('uninstaller preserves foreign cpp associations',
    //   installerSource.includes('ReadRegStr $0 HKCR ".cpp" ""') && installerSource.includes('${If} $0 == "OICPPIDE.cpp"')
    //   && !installerSource.includes('DeleteRegKey HKCR ".cpp"'));
    // 三条字面量：形参名从 $0 换成 $1、引号写成转义的双写、${If} 后面多一个空格 ——
    // 任一处排版一动守卫就红；反过来把那句 DeleteRegValue 换成 DeleteRegKey HKCR ".cpp"，
    // 它会连带把别人注册在 .cpp 下的子键一起端走，可第三段只查 `HKCR ".cpp"` 前面那个动词，
    // 写成 ${DeleteRegKey} 或者拆成两行就看不见。
    // makensis 在 linux/arm64 上跑不起来，所以把这段 NSIS 抽出来交给一个只认这四条语句的
    // 小解释器，在假注册表上真执行一遍 —— 「别人家的 .cpp 到底还在不在」成了可观测结果。
    const lines = installerSource.split(/\r?\n/);
    const start = lines.findIndex((l) => /^\s*ReadRegStr\s+\$\w+\s+HKCR\s+"\.cpp"/.test(l));
    const end = lines.findIndex((l) => /^\s*DeleteRegKey\s+HKCR\s+"OICPPIDE\.cpp"/.test(l));
    const uninstallRegion = start >= 0 && end >= start ? lines.slice(start, end + 1).join('\n') : '';
    check('卸载段的 .cpp 关联处理抽出来成功', uninstallRegion.length > 0,
        `start=${start} end=${end}`);

    const STMT = /^\s*(ReadRegStr|DeleteRegValue|DeleteRegKey)\s+(\$\w+\s+)?(HKCR|HKCU|HKLM)\s+"((?:[^"\\]|\\.)*)"\s*(?:"((?:[^"\\]|\\.)*)"\s*)?$/;
    const IF = /^\s*\$\{If\}\s+(\$\w+)\s+==\s+"((?:[^"\\]|\\.)*)"\s*$/;
    const runNsis = (region, regIn) => {
        const reg = { ...regIn };
        const vars = {};
        const unknown = [];
        let skipUntilEndIf = false;
        const key = (hive, path) => `${hive}\\${path}`;
        const unesc = (s) => s.replace(/\\\\/g, '\\');
        for (const line of region.split(/\r?\n/)) {
            if (!line.trim() || /^\s*;/.test(line)) continue;
            if (/^\s*\$\{EndIf\}\s*$/.test(line)) { skipUntilEndIf = false; continue; }
            if (IF.test(line)) {
                if (skipUntilEndIf) unknown.push(`套娃的 ${'$'}{If}（这个小解释器只支持一层）：${line.trim()}`);
                const m = IF.exec(line);
                skipUntilEndIf = String(vars[m[1]]) !== m[2];
                continue;
            }
            const s = STMT.exec(line);
            if (!s) { unknown.push(line.trim()); continue; }
            const [, op, rawVar, hive, path, value] = s;
            const full = key(hive, unesc(path));
            // 门没开时语句直接跳过（这段 NSIS 里没有赋值之外的副作用）。
            if (skipUntilEndIf) continue;
            if (op === 'ReadRegStr') {
                const want = value === undefined ? '' : unesc(value);
                vars[rawVar.trim()] = reg[full] && Object.prototype.hasOwnProperty.call(reg[full], want)
                    ? reg[full][want] : '';
            }
            else if (op === 'DeleteRegValue') {
                if (reg[full]) delete reg[full][unesc(value)];
            }
            else {
                delete reg[full];
                for (const k of Object.keys(reg)) if (k.startsWith(full + '\\')) delete reg[k];
            }
        }
        return { reg, vars, unknown };
    };

    const FOREIGN = 'SomeOtherEditor.cpp';
    const ours = {
        'HKCR\\.cpp': { '': FOREIGN },
        'HKCR\\OICPPIDE.cpp': { '': 'OICPP-Plus IDE C++ 源文件' },
        'HKCR\\OICPPIDE.cpp\\shell\\open\\command': { '': '"$INSTDIR\\OICPP-Plus.exe" "%1"' }
    };
    const foreignOwner = runNsis(uninstallRegion, structuredClone(ours));
    check('解释器认得这段里的每一条语句（有没见过的写法就红，避免静默少执行一条）',
        foreignOwner.unknown.length === 0, JSON.stringify(foreignOwner.unknown));
    check('别家占着 .cpp 时，卸载不动它的默认值（这是那条政策的全部内容）',
        foreignOwner.reg['HKCR\\.cpp'] && foreignOwner.reg['HKCR\\.cpp'][''] === FOREIGN,
        JSON.stringify(foreignOwner.reg['HKCR\\.cpp']));
    check('别家占着 .cpp 时，.cpp 这个键本身也还在（键没了会连坐别人注册的子键）',
        Object.keys(foreignOwner.reg).includes('HKCR\\.cpp'), JSON.stringify(Object.keys(foreignOwner.reg)));
    check('自家的 ProgID 连同它的子键一律删干净（残留会让下次安装认成旧版本）',
        !('HKCR\\OICPPIDE.cpp' in foreignOwner.reg) &&
        !Object.keys(foreignOwner.reg).some((k) => k.startsWith('HKCR\\OICPPIDE.cpp\\')),
        JSON.stringify(Object.keys(foreignOwner.reg)));

    const mine = runNsis(uninstallRegion, structuredClone({
        'HKCR\\.cpp': { '': 'OICPPIDE.cpp' },
        'HKCR\\OICPPIDE.cpp': { '': 'desc' }
    }));
    check('我们占着 .cpp 时，卸载把那条默认值删掉（留着就是指向不存在程序的死链接）',
        mine.reg['HKCR\\.cpp'] && mine.reg['HKCR\\.cpp'][''] === undefined,
        JSON.stringify(mine.reg['HKCR\\.cpp']));
    check('删的是值不是键：.cpp 键仍留在注册表里', Object.keys(mine.reg).includes('HKCR\\.cpp'),
        JSON.stringify(Object.keys(mine.reg)));

    const absent = runNsis(uninstallRegion, structuredClone({ 'HKCR\\OICPPIDE.cpp': { '': 'desc' } }));
    check('.cpp 压根没注册过时也不崩、也不凭空造出一个 .cpp 键',
        absent.unknown.length === 0 && !('HKCR\\.cpp' in absent.reg),
        JSON.stringify(Object.keys(absent.reg)));

    // 反向对照：解释器必须真的看得见「关联被毁」这件事，否则上面几条是空的。
    // ①用「我们占着 .cpp」这一档做对照：DeleteRegKey 只在门开的时候执行，
    // 而门在别家占着时本来就不开 —— 拿别家的场景测它，永远测不出差别。
    // 真危害长这样：别人往 .cpp 下挂了 ShellNew（新建文件模板），
    // 删键会把它连子键一起端走，删值不会。
    const ownedWithSub = () => structuredClone({
        'HKCR\\.cpp': { '': 'OICPPIDE.cpp' },
        'HKCR\\.cpp\\ShellNew': { NullFile: '' },
        'HKCR\\OICPPIDE.cpp': { '': 'desc' }
    });
    const keptSub = runNsis(uninstallRegion, ownedWithSub());
    check('我们的 .cpp 下挂着别人的子键时，卸载只删默认值、子键原样留着',
        keptSub.reg['HKCR\\.cpp\\ShellNew'] !== undefined && keptSub.reg['HKCR\\.cpp'][''] === undefined,
        JSON.stringify(Object.keys(keptSub.reg)));
    const brutal = runNsis(
        uninstallRegion.replace(/DeleteRegValue\s+HKCR\s+"\.cpp"\s+""/, 'DeleteRegKey HKCR ".cpp"'), ownedWithSub());
    check('对照①：把 DeleteRegValue 换成 DeleteRegKey，.cpp 整键连同 ShellNew 一起没了（说明断言不是摆设）',
        !('HKCR\\.cpp' in brutal.reg) && !('HKCR\\.cpp\\ShellNew' in brutal.reg),
        JSON.stringify(Object.keys(brutal.reg)));
    const unguarded = runNsis(
        uninstallRegion.replace(/\$\{If\}\s+\$\w+\s+==\s+"OICPPIDE\.cpp"/, '${If} $0 == "SomeOtherEditor.cpp"'), ours);
    check('对照②：把门里的比较对象换成别家自己（等于没有门），别家的 .cpp 默认值就该被抹掉',
        unguarded.reg['HKCR\\.cpp'] && unguarded.reg['HKCR\\.cpp'][''] === undefined,
        JSON.stringify(unguarded.reg['HKCR\\.cpp']));
    const ungated = runNsis(uninstallRegion.replace(/\$\{If\}[\s\S]*?\$\{EndIf\}[ \t]*\r?\n?/, ''), ours);
    check('对照③：整道 ${If} 门被删掉时同样要红（对照②只换了比较值）',
        ungated.reg['HKCR\\.cpp'] && ungated.reg['HKCR\\.cpp'][''] === undefined,
        JSON.stringify(ungated.reg['HKCR\\.cpp']));
}
check('sharp is build-only', !Object.hasOwn(packageJson.dependencies, 'sharp') && Object.hasOwn(packageJson.devDependencies, 'sharp'));

// --- ci-check 的图标残留与密钥扫描：整段抽出来真跑 ---------------------------
// 原来这两条是
//   ciSource.includes('/oicpp\\.ico(?=$|[^-])/')
//   ciSource.includes("fail(`potential secret in ${rel}`)")
// 比的是「那行字还在不在」。可这两条检查的全部保护力恰好在那行字的**语义**上：
// 把 fail 换成 warn、把 ${rel} 写成 ${f}（报绝对路径）、图标正则放宽成
// oicpp[\w-]*\.ico 顺手把本项目自己的 oicpp-plus.ico 也判成旧品牌、把汇总那条
// `else fail()` 删掉 —— 这些改法字面量守卫全都照样绿，而前两件事之后「密钥硬编码」
// 只打印一行黄字就过关，第三件事之后这条检查天天误报，很快被人整条删掉。
// 现在喂进去的是合成源码，读出来的是 fail()/ok() 的原文。
//
// 顺带一句：正则里那个 (?=$|[^-]) 在本仓库当前是不使力的 —— 全仓只有 oicpp.ico 与
// oicpp-plus.ico 两种写法，而 oicpp.ico 并不是 oicpp-plus.ico 的子串，加不加这个
// 前瞻结果一样。它只对 `oicpp.ico-xxx` 这种不存在的名字有区别，所以这里不为它单独设断言，
// 只锁真正在起作用的两个方向：旧品牌必须抓到、新品牌必须抓不到。
{
    const regionOf = (header, next) => {
        const at = ciSource.indexOf(header);
        const end = at < 0 ? -1 : ciSource.indexOf(next, at);
        return end > at ? ciSource.slice(at, end) : '';
    };
    const b1 = regionOf('[B1] Icon references', '// B2:');
    const e4 = regionOf('[E4] Secrets scan', '// E5:');
    check('B1 整块定位成功（锚点失配就别再往下断言）',
        b1.includes('iconRefFiles') && b1.includes('oicpp'), `${b1.length} chars`);
    check('E4 整块定位成功', e4.includes('secretPatterns') && e4.includes('secretsFound'), `${e4.length} chars`);

    // ---- B1 图标引用 ----
    // 数组字面量按声明名取：直接 /[…]; 会从标题串里的 `[B1]` 开始配平。
    const arrayLit = (src, name) => {
        const m = new RegExp('\\b' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\];').exec(src);
        return m ? m[1] : '';
    };
    const iconLitText = arrayLit(b1, 'iconRefFiles');
    const iconLoop = forStatement(b1, /^for \(const f of iconRefFiles\) \{/m);
    const iconFiles = iconLitText ? new Function('return [' + iconLitText + '];')() : [];
    const hasIcon = (text) => { try { return /oicpp\.ico(?=$|[^-])/.test(text); } catch (_) { return false; } };
    check('iconRefFiles 清单抽出来真求值成数组',
        Array.isArray(iconFiles) && iconFiles.length > 0, JSON.stringify(iconFiles));
    // 清单是这条检查的全部覆盖面：把 installer.nsi 换掉或删掉，字面量守卫看不见，
    // 而那条文件从此不再被检查 —— 用一份显式期望集合锁住「不许缩水」。
    check('清单覆盖当初登记的四处旧图标来源（少一处就是那条文件从此不查）',
        ['src/main.js', 'src/renderer/js/tabs.js', 'scripts/generate-icons.js', 'installer.nsi']
            .every((f) => iconFiles.includes(f)),
        JSON.stringify(iconFiles));
    check('清单里每个文件都真的存在且非空（改名掉出清单就是悄悄放弃检查）',
        iconLoop.startsWith('for (') && iconFiles.every((f) => { try { return read(f).length > 10; } catch (_) { return false; } }),
        JSON.stringify(iconFiles.filter((f) => { try { return read(f).length <= 10; } catch (_) { return true; } })));
    check('阴性对照：这四个文件当前确实都不含旧图标（上面那条不是空跑）',
        iconFiles.every((f) => { try { return !hasIcon(read(f)); } catch (_) { return false; } }),
        JSON.stringify(iconFiles.filter(hasIcon)));

    const runB1 = (contents) => {
        const out = { fails: [], oks: [] };
        try {
            vm.runInNewContext(iconLoop, {
                path, root: '/virtual',
                iconRefFiles: Object.keys(contents),
                readFile: (fp) => contents[String(fp).replace(/^\/virtual\//, '')] || '',
                ok: (m) => out.oks.push(String(m)),
                fail: (m) => out.fails.push(String(m))
            });
        } catch (e) {
            out.fails.push(`EXCEPTION: ${String((e && e.message) || e)}`);
        }
        return out;
    };

    const hitMid = runB1({ 'src/main.js': "app.setIcon('build/oicpp.ico');" });
    check('旧图标 oicpp.ico 被抓到，且报的是相对路径不是拼接出来的绝对路径',
        hitMid.fails.length === 1 && hitMid.fails[0] === 'src/main.js still references oicpp.ico',
        JSON.stringify(hitMid.fails));
    const hitEol = runB1({ 'a.js': 'oicpp.ico' });
    check('oicpp.ico 正好在文末也要抓到（前瞻写成 [^-] 而不是 (?=$|[^-]) 就漏掉这一种）',
        hitEol.fails.length === 1, JSON.stringify(hitEol.fails));
    const hitNewBrand = runB1({ 'installer.nsi': 'File "build\\oicpp-plus.ico"' });
    check('本项目自己的 oicpp-plus.ico 不算旧图标（正则放宽成 oicpp[\\w-]*\\.ico 就天天误报）',
        hitNewBrand.fails.length === 0 && hitNewBrand.oks.length === 1, JSON.stringify(hitNewBrand));
    const clean = runB1({ 'src/main.js': 'nothing to see' });
    check('没引用的文件报 ok（else 分支被删就看不出这条检查还在不在跑）',
        clean.fails.length === 0 && clean.oks.length === 1, JSON.stringify(clean));
    const missing = runB1({ 'gone.js': '' });
    check('读不到的文件既不报 ok 也不报 fail（去掉 if (content) 就把空文件判成检查通过）',
        missing.fails.length === 0 && missing.oks.length === 0, JSON.stringify(missing));

    // ---- E4 硬编码密钥 ----
    const patternsText = arrayLit(e4, 'secretPatterns');
    const secretLoop = forStatement(e4, /^for \(const f of jsFiles\) \{/m);
    // 收尾那句是无花括号的 `if (…) ok(…); else fail(…);`，ifStatement 只认带块的形态，
    // 这里整条就在同一行上，按行取即可。
    const secretTail = /^if \(secretsFound === 0\).*$/m.exec(e4)?.[0] || '';
    const secretPatterns = patternsText ? new Function('return [' + patternsText + '];')() : [];
    check('secretPatterns 抽出来真求值成 4 条正则',
        Array.isArray(secretPatterns) && secretPatterns.length === 4
        && secretPatterns.every((p) => p instanceof RegExp),
        JSON.stringify(secretPatterns.map(String)));
    check('E4 循环与收尾都抽取成功',
        secretLoop.startsWith('for (') && secretTail.startsWith('if ('),
        `${secretLoop.length}+${secretTail.length} chars`);

    const runE4 = (contents) => {
        const out = { fails: [], oks: [], warns: [], exception: null };
        const ctx = {
            path, root: '/virtual',
            jsFiles: Object.keys(contents).map((f) => path.join('/virtual', f)),
            readFile: (fp) => contents[path.relative('/virtual', String(fp))] || '',
            secretPatterns, secretsFound: 0,
            ok: (m) => out.oks.push(String(m)),
            fail: (m) => out.fails.push(String(m)),
            warn: (m) => out.warns.push(String(m))
        };
        vm.createContext(ctx);
        try { vm.runInContext(`${secretLoop}\n${secretTail}`, ctx); }
        catch (e) { out.exception = String((e && e.message) || e); }
        return Object.assign(out, { found: ctx.secretsFound });
    };
    const LONG = 'ABCDEFGHIJKLMNOPQRST';        // 20 字符：正好过 api/token/secret 的量词
    const PWD = '12345678';                    // 8 字符：正好过 password 的量词
    // 命中一处就有两条 FAIL：逐文件的 `potential secret in <rel>` + 汇总的 `<n> potential secrets`。
    // 断言只数逐文件那一条，汇总单独锁 —— 两者是不同病灶（点名 vs 计数）。
    const hits = (r) => r.fails.filter((m) => /^potential secret in /.test(m));

    const e4Clean = runE4({ 'a.js': 'const apiKeyPrefix = process.env.API_KEY;' });
    check('干净源码报 ok（阴性对照：下面每条阳性断言不是恒真）',
        e4Clean.exception === null && e4Clean.fails.length === 0 && e4Clean.oks.join(' ') === 'no hardcoded secrets',
        JSON.stringify(e4Clean));
    for (const [label, line] of [
        ['api_key', `const apiKey = "${LONG}";`],
        ['API_KEY 大写 + 冒号 + 单引号', `const API_KEY: 'abcdefghij0123456789';`],
        ['password', `let password = "${PWD}";`],
        ['token', `headers.token = "${LONG}x";`],
        ['secret', `app.secret = '${LONG}';`]
    ]) {
        const r = runE4({ 'cfg/settings.js': line });
        check(`${label} 形态的硬编码被抓出来，报的是相对路径`,
            r.exception === null && hits(r).length === 1 && hits(r)[0] === 'potential secret in cfg/settings.js',
            JSON.stringify({ fails: r.fails, exception: r.exception }));
        check(`${label}：判定走 fail 而不是 warn（换成 warn 就是只打印不改退出码）`,
            r.warns.length === 0 && r.found === 1, JSON.stringify(r));
    }
    const tooShort = runE4({ 'a.js': `const apiKey = "SHORT"; const password = "1234567";` });
    check('短值不报：{20,} 与 {8,} 两个量词各自到位（放宽成 {4,} 就把变量名当密钥）',
        tooShort.fails.length === 0 && tooShort.found === 0, JSON.stringify(tooShort));
    const justEnough = runE4({ 'a.js': `const password = "${PWD}";` });
    check('password 满 8 位就报（量词写成 {9,} 会漏掉 8 位口令）',
        hits(justEnough).length === 1 && justEnough.fails.includes('1 potential secrets'),
        JSON.stringify(justEnough.fails));
    const twoKinds = runE4({ 'a.js': `const apiKey = "${LONG}"; const password = "${PWD}";` });
    check('一个文件里两类命中就报两次，不会被 break 掉后一条',
        twoKinds.fails.filter((m) => m === 'potential secret in a.js').length === 2,
        JSON.stringify(twoKinds.fails));
    check('命中数汇总成独立一条 FAIL，退出码因此非 0',
        twoKinds.fails.includes('2 potential secrets') && twoKinds.found === 2,
        JSON.stringify(twoKinds.fails));
    const twoFiles = runE4({ 'a.js': `const apiKey = "${LONG}";`, 'b.js': 'clean' });
    check('只有命中的那份文件被点名，另一份不受牵连',
        twoFiles.fails.length === 2 && twoFiles.oks.length === 0
        && twoFiles.fails[0] === 'potential secret in a.js',
        JSON.stringify(twoFiles));
    // 原先这里还有一条「空文件跳过：去掉 if (!content) continue 会拿空串跑一遍正则」，
    // 变异实测杀不掉 —— 四条正则对 '' 和 undefined 都不命中，continue 删不删观测点一样。
    // 留着只会把断言数说得比实际保护力大，删掉。
}

// 同步断言先跑完，再补上假 DOM 那批（它们是 promise，微任务里才落地）。
// 汇总必须等这一批落地后才能数 failures，否则 exitCode 会停在 0。
Promise.all([deferredRows, remoteRows, miRows, workerRows, ...updateRowsRef, ...downloaderRowsRef])
    .then((batches) => { for (const rows of batches) for (const row of rows) check(row.name, row.cond, row.extra); })
    .then(() => {
        console.log(`security regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
        process.exitCode = failures ? 1 : 0;
    });
