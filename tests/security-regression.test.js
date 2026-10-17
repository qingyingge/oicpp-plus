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
check('uninstaller preserves foreign cpp associations', installerSource.includes('ReadRegStr $0 HKCR ".cpp" ""') && installerSource.includes('${If} $0 == "OICPPIDE.cpp"') && !installerSource.includes('DeleteRegKey HKCR ".cpp"'));
check('sharp is build-only', !Object.hasOwn(packageJson.dependencies, 'sharp') && Object.hasOwn(packageJson.devDependencies, 'sharp'));
check('CI icon boundary matching is exact', ciSource.includes('/oicpp\\.ico(?=$|[^-])/'));
check('CI secret detections fail the build', ciSource.includes("fail(`potential secret in ${rel}`)"));

// 同步断言先跑完，再补上假 DOM 那批（它们是 promise，微任务里才落地）。
// 汇总必须等这一批落地后才能数 failures，否则 exitCode 会停在 0。
Promise.all([deferredRows, remoteRows, miRows, workerRows])
    .then((batches) => { for (const rows of batches) for (const row of rows) check(row.name, row.cond, row.extra); })
    .then(() => {
        console.log(`security regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
        process.exitCode = failures ? 1 : 0;
    });
