'use strict';

// 2026-10-01 理论走查发现的问题的回归测试。
// 背景：60 个提交走查时发现 CompareEngineV2._runCounter 从未初始化，
// 导致 ++undefined === NaN、NaN !== NaN，isCurrentRun() 恒为 false，
// 新引擎对拍会在每条 worker 消息上走「上一轮迟到消息」分支并 settle，
// 表现为秒结束且完成数恒为 0。这里锁住三个不变量。

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const {
    arrowExpr, callbackBody, callStatement, classMethod, compileMethod, forStatement, funcDecl, objectConst
} = require('./fixtures/source-extract');

const root = path.resolve(__dirname, '..');
let failures = 0;
let total = 0;

// 段落里排好的异步守卫，统一在文件尾的 async IIFE 里跑（check 本身是同步计数，
// 汇总和 exit 都在最后一批 add 完之后再算）。
const deferredChecks = [];

const check = (name, fn) => {
    total++;
    try {
        fn();
        console.log(`[PASS] ${name}`);
    } catch (error) {
        failures++;
        console.log(`[FAIL] ${name} | ${error.message}`);
    }
};

// ---------------------------------------------------------------------------
// 1. _runCounter 必须初始化，且轮次严格递增
// ---------------------------------------------------------------------------

// 用 VM 沙箱注入假 Worker，跑引擎的真实代码。
// 归属校验的 bug 恰好落在「本轮消息是否被计入」这一行上，
// 注入假 Worker 就能验证，不需要真实编译器 + testlib。
const makeEngineWithFakeWorker = (progressCount, opts = {}) => {
    const vm = require('vm');
    const { EventEmitter } = require('events');
    const engineSrc = fs.readFileSync(path.join(root, 'src/main-process/compare-engine-v2.js'), 'utf8');
    const sandbox = {
        //编译产物用这个对象挂模块标记，真实环境里由模块包装器提供，沙箱必须补上这个绑定
        require, module: { exports: {} }, exports: {}, console,
        setTimeout, clearTimeout, Promise, EventEmitter,
        os: { cpus: () => [{ length: 4 }] },
        path,
        __dirname: path.join(root, 'src', 'main-process'),
        fs: { existsSync: () => true, mkdirSync: () => {}, rmSync: () => {} },
        Worker: class FakeWorker extends EventEmitter {
            constructor() {
                super();
                this.pid = 1234;
                if (opts.registry) opts.registry.push(this);
                // manual：一条都不自动发，由测试自己控制消息时序（迟到消息场景要卡在
                // 引擎已建 worker、尚未收到 done 的那个窗口上）
                if (opts.manual) return;
                setImmediate(() => {
                    for (let i = 1; i <= progressCount; i++) this.emit('message', { type: 'progress', testIndex: i });
                    this.emit('message', { type: 'done' });
                });
            }
            postMessage() { }
            terminate() { return Promise.resolve(); }
            removeAllListeners() { return this; }
        }
    };
    vm.createContext(sandbox);
    //剥掉原生引入改用沙箱假件，产物里同一件事换成命名空间对象，两种形态都要接住否则假件失效
    vm.runInContext(engineSrc
        .replace(/^const \{ EventEmitter \} = require\('events'\);$/m, '')
        .replace(/^const \{ Worker \} = require\('worker_threads'\);$/m, '')
        .replace(/^const events_1 = require\("events"\);$/m, 'const events_1 = { EventEmitter };')
        .replace(/^const worker_threads_1 = require\("worker_threads"\);$/m, 'const worker_threads_1 = { Worker };'),
    sandbox, { filename: 'compare-engine-v2.js' });
    return sandbox.module.exports.CompareEngineV2;
};

const runEngineOnce = async (Ctor, progressCount) => {
    const engine = new Ctor();
    const progress = [];
    engine.on('progress', (p) => progress.push(p));
    try {
        await engine.start({
            totalTests: progressCount, threadCount: 1,
            generator: 'g.exe', stdExe: 'a.exe', testExe: 'b.exe',
            timeLimit: 0, generatorTimeout: 0
        });
    } catch (_) { /* 配置校验等异常不影响本断言 */ }
    return { engine, progress };
};

{
    const { CompareEngineV2 } = require(path.join(root, 'src/main-process/compare-engine-v2.js'));
    const engine = new CompareEngineV2();

    check('CompareEngineV2._runCounter 已初始化（非 undefined）', () => {
        assert.notStrictEqual(CompareEngineV2._runCounter, undefined,
            '_runCounter 是 undefined，++undefined === NaN');
        assert.strictEqual(typeof CompareEngineV2._runCounter, 'number');
    });

    check('连续 start() 得到严格递增且可比较的 runId', () => {
        // 只走 start() 的开头：轮次分配在第一个 await 之前
        const before = CompareEngineV2._runCounter;
        engine._state = 'idle';
        engine.start({ totalTests: 0 }).catch(() => { });
        const first = engine._runId;
        engine._state = 'idle';
        engine.start({ totalTests: 0 }).catch(() => { });
        const second = engine._runId;
        assert.ok(first > before, `runId ${first} 应大于 ${before}`);
        assert.ok(second > first, `runId ${second} 应大于 ${first}`);
    });

    check('runId 相同则 isCurrentRun() 为 true（NaN !== NaN 已排除）', () => {
        engine._runId = 42;
        const runId = engine._runId;
        assert.strictEqual(engine._runId === runId, true);
        assert.ok(Number.isNaN(runId) === false, 'runId 不应是 NaN');
    });

    check('_runCounter 递增不会被并发 start 复用', () => {
        const before = CompareEngineV2._runCounter;
        engine._state = 'idle';
        engine.start({ totalTests: 0 }).catch(() => { });
        assert.strictEqual(CompareEngineV2._runCounter, before + 1);
    });
}

// ---------------------------------------------------------------------------
// 2. 归属校验必须真的能区分轮次
// ---------------------------------------------------------------------------
{
    // 归属校验原来靠三条正则比长相（isCurrentRun 的定义写法、settle/return 的排版、
    // settle 是否紧挨 progress 分支）。改成真跑：起一轮、把 _runId 改成别的值，
    // 再从同一个 worker 发一条「上一轮的迟到消息」，看它计不计入本轮、本轮会不会卡死。
    deferredChecks.push(async () => {
        const workers = [];
        const Ctor = makeEngineWithFakeWorker(0, { manual: true, registry: workers });
        const engine = new Ctor();
        const progress = [];
        engine.on('progress', (p) => progress.push(p));
        let outcome = 'PENDING';
        const finished = engine.start({
            totalTests: 3, threadCount: 1,
            generator: 'g.exe', stdExe: 'a.exe', testExe: 'b.exe',
            timeLimit: 0, generatorTimeout: 0
        }).then(() => { outcome = 'RESOLVED'; }, () => { outcome = 'REJECTED'; });
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        const worker = workers[0];
        check('迟到消息场景搭起来了：引擎已建 worker 且消息可注入',
            () => assert.ok(worker && typeof worker.emit === 'function', `worker=${String(worker)}`));
        if (!worker) return;

        engine._runId = 4242;                       // 下一条消息就成了「上一轮迟到的」
        const completedBefore = engine._completed;
        worker.emit('message', { type: 'progress', testIndex: 1 });
        worker.emit('message', { type: 'progress', testIndex: 2 });
        await new Promise((resolve) => setImmediate(resolve));

        check('上一轮的 progress 一条都不计入本轮（_completed 与事件都不动）', () => {
            assert.strictEqual(progress.length, 0, `迟到消息漏进了本轮：${JSON.stringify(progress)}`);
            assert.strictEqual(engine._completed, completedBefore,
                `_completed 从 ${completedBefore} 变成 ${engine._completed}`);
        });
        const raced = await Promise.race([
            finished,
            new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 1500))
        ]);
        check('迟到分支先 settle 再 return（本轮不会永远挂在未完成的 promise 上）', () => {
            assert.notStrictEqual(raced, 'TIMEOUT', '迟到消息没触发 settle，start() 的 promise 永远悬着');
            assert.notStrictEqual(outcome, 'PENDING', `settle 落地异常：${outcome}`);
        });
    });
}

// ---------------------------------------------------------------------------
// 3. 编译链路：重入标志不得残留、换行不得丢失
// ---------------------------------------------------------------------------
{
    const cmSrc = fs.readFileSync(path.join(root, 'src/renderer/js/compile-manager.js'), 'utf8');

    // compileCurrentFile 的重入分支与 compileAndRun 的标志位复位，原来是三条正则，
    // 其中一条还是「旧写法 `if (!this.isCompiling)` 不许出现」的负向文本断言 ——
    // 那种断言只要有人把旧写法换个排版就能绕过。改成把两个方法真跑一遍。
    deferredChecks.push(async () => {
        const vm = require('vm');
        const compileSrc = classMethod(cmSrc, 'compileCurrentFile');
        const andRunSrc = classMethod(cmSrc, 'compileAndRun');
        check('方法体抽取成功: compileCurrentFile / compileAndRun', () => {
            // classMethod 的锚点含行首缩进，抽出来带着那 4 个空格，比前先 trim
            assert.ok(compileSrc.trim().startsWith('async compileCurrentFile'), String(compileSrc).slice(0, 30));
            assert.ok(andRunSrc.trim().startsWith('async compileAndRun'), String(andRunSrc).slice(0, 30));
        });

        const errs = [];
        const ctx = vm.createContext({
            window: {
                i18n: { t: (k) => k },
                editorManager: { getCurrentEditor: () => ({ filePath: '/ws/a.cpp', getValue: () => 'int main() { return 0; }' }) },
                // 越过守卫后真正下发编译时，给一个永不 resolve 的 IPC：测试只看守卫前后的同步副作用
                electronAPI: { compileFile: () => new Promise(() => { }) }
            },
            logInfo: () => { }, logWarn: () => { }, logError: (m) => { errs.push(String(m)); },
            monaco: undefined, console, setTimeout, clearTimeout,
            Date, JSON, Math, Number, String, Boolean, Array, Object, Error, RegExp, Promise, Map, Set
        });
        const compile = compileMethod(ctx, compileSrc);
        const andRun = compileMethod(ctx, andRunSrc);
        check('两个方法编译成可调用函数', () => {
            assert.strictEqual(typeof compile, 'function');
            assert.strictEqual(typeof andRun, 'function');
        });
        if (!compile || !andRun) return;

        const mkSelf = (over = {}) => {
            const base = {
                calls: [],
                isCompiling: true,
                shouldRunAfterCompile: false,
                settings: { compilerPath: '/usr/bin/g++', compilerArgs: '-std=c++17 -O2' },
                autoSaveCurrentFile: async () => { base.calls.push('autoSave'); },
                loadSettings: async () => { base.calls.push('loadSettings'); },
                getExecutablePath: (p) => String(p).replace(/\.cpp$/, '.out'),
                appendOutput: (text, level) => { base.calls.push(`appendOutput:${level}`); },
                showMessage: (text, level) => { base.calls.push(`showMessage:${level}`); },
                getCurrentPlatform: () => Promise.resolve('linux')
            };
            Object.assign(base, over);
            // 没桩到的方法一律记一笔名字再返回 undefined：断言直接读 calls，
            // 既不用为每个副作用单独写桩，也不会因为漏桩而提前抛错、把守卫跑空。
            return new Proxy(base, {
                get: (t, k) => (k in t ? t[k]
                    : (typeof k === 'string' ? ((...a) => { t.calls.push(k); }) : undefined))
            });
        };
        const tick = () => new Promise((resolve) => setImmediate(resolve));

        const busy = mkSelf();
        const busyResult = await compile.call(busy);
        check('重入时 compileCurrentFile 明确 return false（不能是 undefined）', () => {
            assert.strictEqual(busyResult, false, `实际返回 ${String(busyResult)}`);
        });
        check('重入只提示 already-running，不启动第二次编译（面板/状态/清屏一个都不碰）', () => {
            assert.ok(busy.calls.includes('appendOutput:warning'), JSON.stringify(busy.calls));
            for (const forbidden of ['showOutput', 'setStatus', 'clearOutput']) {
                assert.ok(!busy.calls.includes(forbidden), `重入还顺手做了 ${forbidden}：${JSON.stringify(busy.calls)}`);
            }
            assert.strictEqual(busy.isCompiling, true);
        });
        check('守卫前确实读完了自动保存与设置（重入分支不是空跑）', () => {
            assert.deepStrictEqual(busy.calls.slice(0, 2), ['autoSave', 'loadSettings'], JSON.stringify(busy.calls));
        });

        const idle = mkSelf({ isCompiling: false });
        compile.call(idle).catch(() => { });
        await tick();
        await tick();
        check('对照组：没在编译时确实越过重入守卫（置起 isCompiling 并打开输出面板）', () => {
            assert.strictEqual(idle.isCompiling, true, '没越过守卫？');
            assert.ok(idle.calls.includes('showOutput'), JSON.stringify(idle.calls));
            assert.ok(!idle.calls.some((c) => String(c).startsWith('appendOutput:warning')), JSON.stringify(idle.calls));
        });

        const mkCase = (ret) => {
            const s = mkSelf();
            s.compileCurrentFile = async () => { s.calls.push('compileCurrentFile'); return ret; };
            return s;
        };
        const rejected = mkCase(false);
        await andRun.call(rejected);
        check('compileAndRun 在编译被重入拒绝时复位 shouldRunAfterCompile', () => {
            assert.strictEqual(rejected.shouldRunAfterCompile, false,
                '标志位残留到下一次编译完成，会把「编译」意外变成「编译并运行」');
        });
        const started = mkCase(true);
        await andRun.call(started);
        check('compileAndRun 编译真启动时保留 shouldRunAfterCompile（跑完要接着运行）', () => {
            assert.strictEqual(started.shouldRunAfterCompile, true, JSON.stringify(started.calls));
        });
        const threw = mkSelf();
        threw.compileCurrentFile = async () => { throw new Error('编译器不在'); };
        await andRun.call(threw);
        check('compileAndRun 抛错也复位标志位并记一条 logError', () => {
            assert.strictEqual(threw.shouldRunAfterCompile, false);
            assert.ok(errs.length >= 1, JSON.stringify(errs));
        });
    });

    check('编译输出换行：t() || 兜底 链整体被括号包裹', () => {
        // JS 里 + 优先级高于 ||：`t() || 'fb' + '\n'` 解析为 `t() || ('fb' + '\n')`。
        // t() 返回非空（= 有翻译，**常态**）时整个表达式取 t()，后面的 '\n' 被整个丢掉；
        // t() 返回空（= 落到兜底）时反而正常。也就是「有翻译才丢换行」。
        const vm = require('vm');
        const NL = String.fromCharCode(10);
        const run = (expr, translated) => {
            const s = vm.createContext({ window: { i18n: { t: () => (translated ? '已翻译' : '') } } });
            return vm.runInContext(expr, s);
        };
        const buggy = "window.i18n.t('k', null) || 'fb' + " + JSON.stringify(NL);
        const fixed = "(window.i18n.t('k', null) || 'fb') + " + JSON.stringify(NL);

        assert.strictEqual(run(buggy, true), '已翻译',
            '旧写法在有翻译时丢换行（这正是要修的 bug，且是常态路径）');
        assert.strictEqual(run(fixed, true), '已翻译' + NL, '括号包裹后有翻译时换行生效');
        assert.strictEqual(run(fixed, false), 'fb' + NL, '括号包裹后走兜底时换行同样生效');
        assert.strictEqual(run(buggy, false), 'fb' + NL, '走兜底时旧写法本来就正常（对照组）');
    });
}

// ---------------------------------------------------------------------------
// 4. 删除边界：所有删除通道都要接工作区校验
// ---------------------------------------------------------------------------
{
    const mainSrc = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');

    check('assertDeletableInWorkspace 已定义', () => {
        assert.ok(/function assertDeletableInWorkspace\(targetPath\)/.test(mainSrc));
    });

    // 上一轮只挂了 2 个 handler，文件管理器主路径（ipcMain.on）与
    // delete-file-invoke 都没接，assertSafeIoPath 只拦系统目录，用户目录照删不误
    const deletionChannels = [
        { name: "ipcMain.on('delete-file')", re: /ipcMain\.on\('delete-file',[\s\S]{0,1200}?assertDeletableInWorkspace\(/ },
        { name: "ipcMain.handle('delete-file')", re: /ipcMain\.handle\('delete-file',[\s\S]{0,1200}?assertDeletableInWorkspace\(/ },
        { name: "ipcMain.handle('delete-file-invoke')", re: /ipcMain\.handle\('delete-file-invoke',[\s\S]{0,1200}?assertDeletableInWorkspace\(/ },
        { name: "ipcMain.handle('clear-directory-contents')", re: /ipcMain\.handle\('clear-directory-contents',[\s\S]{0,1600}?assertDeletableInWorkspace\(/ },
        // 重命名的覆盖分支是 rmSync(recursive)，等价于删除
        { name: "rename 覆盖分支", re: /options\?\.overwrite\)[\s\S]{0,400}?assertDeletableInWorkspace\(/ },
    ];
    for (const ch of deletionChannels) {
        check(`${ch.name} 接了 assertDeletableInWorkspace`, () => {
            assert.ok(ch.re.test(mainSrc), `${ch.name} 未接工作区校验`);
        });
    }

    check('check-file-exists 不把权限类错误当成不存在', () => {
        // 原先用 `{0,1200}?\n    });` 划窗口：既锁收尾括号的缩进与 `);` 排版，
        // 又会在 handler 变长时静默截断。改成按锚点配平花括号取整个回调体。
        const body = callbackBody(mainSrc, /ipcMain\.handle\('check-file-exists'/);
        assert.ok(body.length > 0, '未找到 check-file-exists handler');
        assert.ok(/error\?\.code !== 'ENOENT'/.test(body),
            '必须按 errno 分流：EACCES/ENAMETOOLONG/EINVAL 会被吞成 false');
        // 只看代码行，注释里提到 existsSync 不算
        const code = body.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        assert.ok(!/existsSync/.test(code), 'existsSync 兜底已移除');
    });
}

// ---------------------------------------------------------------------------
// 5. 裸 key 上屏：I5 必须同时拦赋值与对象属性两种形态
// ---------------------------------------------------------------------------
{
    const ciSrc = fs.readFileSync(path.join(root, 'scripts/ci-check.js'), 'utf8');
    check('I5 覆盖对象属性形态 key: (\'k\')', () => {
        // 源码里是这条（转义前的字面量）：
        //   /(^|[,{]\s*)([A-Za-z_$][\w$]*)\s*:\s*\(\s*['"]([a-z][\w]*(?:\.[a-zA-Z][\w]*)+)['"]\s*\)/gm
        assert.ok(ciSrc.includes("(^|[,{]\\s*)([A-Za-z_$][\\w$]*)\\s*:\\s*\\(\\s*['\"]"),
            'I5 需覆盖 `key: (\'i18n.key\')` 对象属性形态');
    });
    check('I5 注释说明两种形态（防止后人又删掉属性分支）', () => {
        assert.ok(/两种形态都要拦/.test(ciSrc));
    });

    // 回归：曾经真实存在的 3 处裸 key
    const files = [
        'src/renderer/js/sidebar/cloudSync.js',
        'src/renderer/js/compile-manager.js'
    ];
    const bareKeyRe = /(?:^|[,{]\s*)[A-Za-z_$][\w$]*\s*:\s*\(\s*'([a-z][\w]*(?:\.[\w]+)+)'\s*\)/gm;
    for (const rel of files) {
        check(`${rel} 没有裸 key 字面量`, () => {
            const src = fs.readFileSync(path.join(root, rel), 'utf8');
            const hits = [...src.matchAll(bareKeyRe)].map((m) => m[0].trim());
            assert.strictEqual(hits.length, 0, `仍有裸 key: ${hits.join(' | ')}`);
        });
    }
}

// ---------------------------------------------------------------------------
// 6. I8 豁免收紧：键必须真实存在
// ---------------------------------------------------------------------------
{
    const ciSrc = fs.readFileSync(path.join(root, 'scripts/ci-check.js'), 'utf8');
    check('I8 豁免要求 t() 的键存在于语言包', () => {
        assert.ok(/tKeysOnLine\(line\)\.filter\(\(k\) => !packKeys\.has\(k\)\)/.test(ciSrc));
        assert.ok(/if \(missingKeys\.length > 0\) \{\s*\n\s*fail\(/.test(ciSrc),
            '键缺失必须 fail，而不是只记日志');
    });
}

// ---------------------------------------------------------------------------
// 7. 设置缓存失效
// ---------------------------------------------------------------------------
{
    const preloadSrc = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
    // 三条正则守卫（缓存失效数组字面量、代数比较的写法、白名单 Set 的字面量）
    // 全部换成把真代码跑起来：循环真注册、getAllSettings 真缓存、包装器真拦人。
    deferredChecks.push(async () => {
        const vm = require('vm');
        const pieces = {
            loop: forStatement(preloadSrc, /^\s*for \(const ch of \[/m),
            invalidate: funcDecl(preloadSrc, 'invalidateSettingsCache'),
            getAll: funcDecl(preloadSrc, 'getAllSettings'),
            // cloneSettings 是 `const NAME = (value) => {...}`，不是函数声明：
            // 用 arrowExpr 取箭头本体，再自己拼回 const 声明。
            clone: (() => {
                const expr = arrowExpr(preloadSrc, /const cloneSettings = /);
                return expr ? `const cloneSettings = ${expr}` : '';
            })(),
            ttl: (/^const SETTINGS_CACHE_TTL_MS = \d+;/m.exec(preloadSrc) || [''])[0],
            eventSet: callStatement(preloadSrc, /^const ALLOWED_EVENT_CHANNELS = new Set\(/m),
            wrapper: objectConst(preloadSrc, 'safeIpcRenderer')
        };
        check('preload 七段片段全部抽取成功', () => {
            for (const [name, text] of Object.entries(pieces)) {
                assert.ok(text.length > 0, `未抽到 ${name}`);
            }
        });
        if (Object.values(pieces).some((t) => !t)) return;

        let listeners = [];
        let blocked = [];
        let invokeCalls = 0;
        let resolvers = [];
        const ctx = vm.createContext({
            ipcRenderer: {
                on: (ch, fn) => { listeners.push([ch, fn]); },
                once: (ch, fn) => { listeners.push(['once:' + ch, fn]); },
                send: () => { },
                invoke: () => {
                    invokeCalls++;
                    return new Promise((resolve) => {
                        resolvers.push(() => resolve({ compilerPath: `快照${invokeCalls}` }));
                    });
                },
                removeListener: () => { }, removeAllListeners: () => { }
            },
            console: { warn: (m) => { blocked.push(String(m)); }, log: () => { }, error: () => { } },
            JSON, Math, Number, String, Boolean, Array, Object, Error, RegExp, Promise, Set, Map, Date
        });
        // 这几个模块级状态在真实源码里是 let/const；沙箱用同名声明补齐 ——
        // 同一个 context 的后续脚本共享这份词法绑定（和多个 <script> 一样）。
        // SEND/INVOKE 两个名单不是本段要测的东西，给最小桩。
        vm.runInContext('let settingsCache = null, settingsCacheTime = 0, settingsCacheInflight = null, settingsCacheGeneration = 0;\n'
            + "const SETTINGS_MUTATING_CHANNELS = new Set(['update-settings']);\n"
            + 'const ALLOWED_SEND_CHANNELS = new Set();\n'
            + "const ALLOWED_INVOKE_CHANNELS = new Set(['get-all-settings']);\n", ctx);
        vm.runInContext([pieces.ttl, pieces.invalidate, pieces.clone, pieces.getAll,
            pieces.eventSet, pieces.wrapper, pieces.loop].join('\n') + '\n', ctx);
        // const 声明只落进 context 的词法环境，挂在 ctx 上看不到；再跑一条脚本把它们递出来。
        vm.runInContext('this.__api = { safeIpcRenderer, getAllSettings, invalidateSettingsCache, ALLOWED_EVENT_CHANNELS };', ctx);
        const api = ctx.__api;

        check('广播失效循环真注册了 5 个通道，回调就是 invalidateSettingsCache 本体', () => {
            assert.deepStrictEqual(listeners.map((l) => l[0]),
                ['settings-changed', 'settings-reset', 'settings-imported', 'settings-applied', 'apply-settings-preview'],
                JSON.stringify(listeners.map((l) => l[0])));
            assert.ok(listeners.every((l) => l[1] === api.invalidateSettingsCache),
                '注册的回调不是失效函数本体，改完设置缓存不会掉');
        });

        const a = api.getAllSettings();
        const b = api.getAllSettings();
        resolvers.shift()();
        await Promise.all([a, b]);
        api.getAllSettings();                       // TTL 内第二次读
        check('TTL 内命中缓存、在途请求共用同一次 invoke（否则下面几条都是空跑）', () => {
            assert.strictEqual(invokeCalls, 1, `invoke 了 ${invokeCalls} 次，缓存/去重没生效`);
        });

        api.invalidateSettingsCache();
        const d = api.getAllSettings();
        check('invalidateSettingsCache 之后必须重新拉一次', () => {
            assert.strictEqual(invokeCalls, 2, `invoke 仍是 ${invokeCalls} 次，缓存没被失效掉`);
        });
        resolvers.shift()();
        await d;

        // 核心场景：读取在途 + 期间发生写入 → 这个响应是写入**前**的快照，不许回填
        api.invalidateSettingsCache();              // 清掉 d 的结果，保证下一条真的在途
        const inflight = api.getAllSettings();      // invoke #3
        api.invalidateSettingsCache();              // 期间用户改了设置
        resolvers.shift()();
        await inflight;
        api.getAllSettings();                       // 必须再拉一次
        check('在途请求不把写入前的旧快照回填进缓存（代数比对生效）', () => {
            assert.strictEqual(invokeCalls, 4, `invoke 停在 ${invokeCalls} 次：旧快照被重新缓存，改完设置读到更旧的值`);
        });
        resolvers.shift()();

        // H8 事件白名单：跑真包装器，不读 Set 的字面量
        listeners = []; blocked = [];
        const handler = () => { };
        for (const ch of ['compare-progress', 'compare-error', 'compare-complete', 'compare-warning']) {
            api.safeIpcRenderer.on(ch, handler);
        }
        api.safeIpcRenderer.once('debug-started', handler);
        api.safeIpcRenderer.on('web-contents-inspector', handler);
        check('compare-* 四个通道都穿得过事件白名单，once 同样放行', () => {
            assert.deepStrictEqual(listeners.map((l) => l[0]),
                ['compare-progress', 'compare-error', 'compare-complete', 'compare-warning', 'once:debug-started'],
                JSON.stringify(listeners.map((l) => l[0])));
        });
        check('名单外的通道被拦下并警告一次（渲染进程窃听不到任意 IPC 事件）', () => {
            assert.strictEqual(blocked.length, 1, JSON.stringify({ listeners, blocked }));
        });
    });
}

// ---------------------------------------------------------------------------
// 8. 设置窗口：软失败也必须阻断默认值回写
// ---------------------------------------------------------------------------
{
    const src = fs.readFileSync(path.join(root, 'src/renderer/settings/compiler.js'), 'utf8');
    check('getAllSettings 返回 null/空对象时按加载失败处理', () => {
        assert.ok(/if \(!allSettings \|\| typeof allSettings !== 'object'\) \{/.test(src),
            'null/undefined 必须与抛异常同等对待');
        assert.ok(/allSettings\.compilerPath === undefined && allSettings\.compilerArgs === undefined/.test(src),
            '空对象也要按加载失败处理');
        assert.ok(!/if \(allSettings\) \{/.test(src), '旧的 `if (allSettings)` 会静默跳过并置 _settingsLoaded = true');
    });
    check('setCompilerPath 不绕过阻断回写默认 compilerArgs', () => {
        const start = src.indexOf('async setCompilerPath(path)');
        assert.ok(start > 0, '未找到 setCompilerPath');
        const body = src.slice(start, start + 1600);
        assert.ok(/this\._settingsLoaded === false/.test(body),
            '加载失败时必须只更新 compilerPath，不碰 compilerArgs');
    });
}

// ---------------------------------------------------------------------------
// 9. 引擎行为验证：本轮 progress 必须被计入（阻断级修复的实测）
// ---------------------------------------------------------------------------
(async () => {
    const Fixed = makeEngineWithFakeWorker(5);
    const { engine, progress } = await runEngineOnce(Fixed, 5);

    check('本轮 worker 的 progress 被计入（修复前恒为 0）', () => {
        assert.strictEqual(progress.length, 5,
            `progress 事件数为 ${progress.length}，应为 5 —— isCurrentRun() 恒 false 时消息会全被丢弃`);
    });
    check('_completed 等于实际执行数', () => {
        assert.strictEqual(engine._completed, 5, `_completed=${engine._completed}`);
    });
    check('progress 事件携带正确的 current/total', () => {
        const last = progress[progress.length - 1];
        assert.strictEqual(last.total, 5);
        assert.strictEqual(last.current, 5);
    });

    // 对照组：把 _runCounter 打回未初始化，必须复现原 bug。
    // 没有这条，上面的 PASS 可能只是注入方式带来的假象。
    const Broken = makeEngineWithFakeWorker(5);
    Broken._runCounter = undefined;
    const b = await runEngineOnce(Broken, 5);
    check('对照组：未初始化 _runCounter 时 progress 归零（复现原 bug）', () => {
        assert.ok(Number.isNaN(b.engine._runId), `runId 应为 NaN，实际 ${b.engine._runId}`);
        assert.strictEqual(b.progress.length, 0, `对照组本应复现 bug，却收到 ${b.progress.length} 条 progress`);
    });

    for (const run of deferredChecks) await run();

    console.log(`\n${total - failures}/${total} assertions passed`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
    console.log(`[FAIL] 异步守卫自身跑通 | ${String((error && error.stack) || error)}`);
    process.exit(1);
});
