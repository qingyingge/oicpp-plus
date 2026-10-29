'use strict';

// 2026-10-01 理论走查发现的问题的回归测试。
// 背景：60 个提交走查时发现 CompareEngineV2._runCounter 从未初始化，
// 导致 ++undefined === NaN、NaN !== NaN，isCurrentRun() 恒为 false，
// 新引擎对拍会在每条 worker 消息上走「上一轮迟到消息」分支并 settle，
// 表现为秒结束且完成数恒为 0。这里锁住三个不变量。

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const {
    arrowExpr, blockByIndent, callbackBody, callStatement, classMethod, compileMethod, forStatement, funcDecl, objectConst, scalarConst
} = require('./fixtures/source-extract');
const { loadLocales, runCiBlock } = require('./fixtures/ci-block-runner');

const root = path.resolve(__dirname, '..');
let failures = 0;
let total = 0;

// 段落里排好的异步守卫，统一在文件尾的 async IIFE 里跑（check 本身是同步计数，
// 汇总和 exit 都在最后一批 add 完之后再算）。
const deferredChecks = [];

// 异步段里任何一条 promise 永不结算，event loop 就排空、进程以 0 退出：
// runner 数到前半截的 [PASS] 判过，尾巴上整段断言静默蒸发（实测「在途去重失效」
// 这种变异就是这么活下来的）。用一条不 unref 的定时器把「跑不完」顶成失败。
const watchdog = setTimeout(() => {
    console.log('[FAIL] 测试主体 20s 没跑到收尾（中途有 promise 永不结算，后面的断言一条都没跑）');
    process.exit(1);
}, 20000);

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

// 喂给 CI 检查项的假文件：键是「绝对路径」，块里 path.relative(root, f) 出来就是可读定位串。
const virtualFile = (name, content) => ({ [`/proj/src/${name}`]: content });

// ---------------------------------------------------------------------------
// 1. _runCounter 必须初始化，且轮次严格递增
// ---------------------------------------------------------------------------

// 用 VM 沙箱注入假 Worker，跑引擎的真实代码（假件见 fixtures/fake-compare-engine.js）。
// 归属校验的 bug 恰好落在「本轮消息是否被计入」这一行上，
// 注入假 Worker 就能验证，不需要真实编译器 + testlib。
const { makeEngineWithFakeWorker } = require('./fixtures/fake-compare-engine');

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

    check('start() 分配的 runId 是有效整数，且新一轮必定换号（NaN !== NaN 已排除）', () => {
        // isCurrentRun() = () => this._runId === runId，runId 是 start() 开头捕获的
        // 局部（`const runId = this._runId`）。_runCounter 若未初始化，++undefined 得
        // NaN，闭包比较恒 false，本轮每条 worker 消息都被当迟到丢弃。这里直接验证
        // 这段语义：start() 分到的 runId 必须是有效整数，且换一轮后必须变号。
        engine._state = 'idle';
        engine.start({ totalTests: 0 }).catch(() => { });
        const first = engine._runId;
        assert.ok(Number.isInteger(first), `start() 分配的 runId 应为整数，实际 ${first}`);
        assert.ok(!Number.isNaN(first), 'runId 不应是 NaN');
        engine._state = 'idle';
        engine.start({ totalTests: 0 }).catch(() => { });
        const second = engine._runId;
        assert.notStrictEqual(second, first, `新一轮必须拿到不同 runId（实际仍是 ${first}）`);
        assert.ok(Number.isInteger(second), `新一轮 runId 也应为整数，实际 ${second}`);
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

    // 原先是六条字面量：一条匹配 `function assertDeletableInWorkspace(targetPath)` 的长相，
    // 五条在通道名后面划一个 `[\s\S]{0,1200}?assertDeletableInWorkspace\(` 的窗口。
    // 窗口长度是拍脑袋定的：handler 变长就静默截断（越界删盘的通道照样“通过”），
    // 而且「先校验再删」和「先删再校验」在它眼里长得一样。
    // 现在把真 handler 连同真守卫一起塞进 vm 跑：假 fs 记账，越界路径下破坏性调用必须一次都不发。
    const WS = '/proj/ws';
    const OUT = '/home/user/.ssh/id_rsa';
    const guardSrc = funcDecl(mainSrc, 'assertDeletableInWorkspace');

    // 每跑一次重建一个上下文：桩里的 calls 是「这条通道到底对磁盘做了什么」的唯一账本。
    // assertSafeIoPath 故意放行 —— 本段只测工作区边界，两个校验混在一起就分不清谁拦的。
    const boot = (src, opt = {}) => {
        const calls = [];
        const destructive = () => calls.filter((c) => ['rm', 'unlink', 'rename', 'p.unlink'].includes(c[0]));
        const ctx = vm.createContext({
            Object, Array, String, Number, Boolean, Error, JSON, RegExp, Math, Promise, Set, Symbol, path, console,
            t: (key) => key,
            logError: () => { },
            logWarn: () => { calls.push(['logWarn']); },
            logInfo: () => { },
            assertSafeIoPath: () => { },
            isPathInsideTempRoots: (p) => String(p).includes('CODE_TEMP'),
            // 桩必须与生产同口径：src/main.ts 的 isPathInsideDir 先 path.resolve 再把反斜杠折成
            // '/'、去尾斜杠、小写。handler 传进来的多是 resolve 过的路径，win32 上形如 D:\proj\ws\a.txt，
            // 只认 '/' 的朴素 startsWith 会把「工作区内」判成越界 —— 四条对照组就是这么红的。
            isPathInsideDir: (p, d) => {
                if (!p || !d) return false;
                const fold = (entry) => path.resolve(entry).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                const target = fold(p);
                const base = fold(d);
                return target === base || target.startsWith(`${base}/`);
            },
            currentExternalWorkspacePath: opt.workspace === null ? null : WS,
            markLocalDeletion: () => { calls.push(['mark']); return []; },
            restoreFileWatchStates: () => { },
            validateFileName: () => ({ valid: true }),
            getUniquePath: (d, n) => path.join(d, n + '.1'),
            mainWindow: { isDestroyed: () => false, webContents: { send: (...a) => calls.push(['send', a[0], a[2]]) } },
            fs: {
                statSync: () => ({ isDirectory: () => opt.isDir === true }),
                existsSync: () => opt.exists === true,
                readdirSync: () => ['e1', 'e2'],
                rmSync: (p) => { calls.push(['rm', p]); },
                unlinkSync: (p) => { calls.push(['unlink', p]); },
                renameSync: (a, b) => { calls.push(['rename', a, b]); },
                promises: { unlink: async (p) => { calls.push(['p.unlink', p]); } }
            },
            ipcMain: {
                on: (ch, fn) => { ctx.__reg = ['on', ch]; ctx.__h = fn; },
                handle: (ch, fn) => { ctx.__reg = ['handle', ch]; ctx.__h = fn; }
            }
        });
        vm.runInContext(`${guardSrc}\n${src};`, ctx);
        return { ctx, calls, destructive, h: ctx.__h, reg: ctx.__reg };
    };
    const event = () => {
        const replies = [];
        return { replies, stub: { reply: (...a) => replies.push(a) } };
    };

    check('守卫本体抽出来了（后面所有通道都跑的是它，不是桩）', () => {
        assert.ok(/^function assertDeletableInWorkspace\(/.test(guardSrc.trim()), guardSrc.slice(0, 40));
    });

    const callGuard = (p, opt) => {
        const b = boot('globalThis.__g = (target) => assertDeletableInWorkspace(target);', opt);
        try { b.ctx.__g(p); return { threw: null }; }
        catch (error) { return { threw: error.message }; }
    };
    check('没打开工作区时，删除一律拒绝（不是“没校验”而是明确报错）', () => {
        const r = callGuard(OUT, { workspace: null });
        assert.strictEqual(r.threw, 'error.noWorkspaceForDelete', JSON.stringify(r));
    });
    check('工作区外的路径抛 outsideWorkspace 并留下一条告警日志', () => {
        const b = boot('globalThis.__g = (p) => assertDeletableInWorkspace(p);');
        let msg = null;
        try { b.ctx.__g(OUT); } catch (error) { msg = error.message; }
        assert.strictEqual(msg, 'error.outsideWorkspace');
        assert.deepStrictEqual(b.calls, [['logWarn']], JSON.stringify(b.calls));
    });
    check('工作区内的路径放行（对照组：守卫不是一律抛，否则上面的“拦住了”毫无意义）', () => {
        for (const p of [`${WS}/a.txt`, WS]) {
            assert.strictEqual(callGuard(p).threw, null, p);
        }
    });
    check('运行时临时目录走豁免分支：它本来就在工作区外，由 delete-temp-file 专门治理', () => {
        assert.strictEqual(callGuard('/proj/CODE_TEMP/x').threw, null);
    });

    // 上一轮只挂了 2 个 handler，文件管理器主路径（ipcMain.on）与
    // delete-file-invoke 都没接，assertSafeIoPath 只拦系统目录，用户目录照删不误
    const deletionChannels = [
        { name: "ipcMain.on('delete-file')", re: /^\s*ipcMain\.on\(\s*'delete-file'/m, kind: 'on', channel: 'delete-file', out: [OUT], inside: [`${WS}/a.txt`], wantInside: 1 },
        { name: "ipcMain.handle('delete-file')", re: /^\s*ipcMain\.handle\(\s*'delete-file'/m, kind: 'handle', channel: 'delete-file', out: [OUT], inside: [`${WS}/a.txt`], wantInside: 1 },
        { name: "ipcMain.handle('delete-file-invoke')", re: /^\s*ipcMain\.handle\(\s*'delete-file-invoke'/m, kind: 'handle', channel: 'delete-file-invoke', out: [OUT], inside: [`${WS}/a.txt`], wantInside: 1 },
        // 清空目录是对每个 entry 各 rmSync 一次，桩里给两个条目
        { name: "ipcMain.handle('clear-directory-contents')", re: /^\s*ipcMain\.handle\(\s*'clear-directory-contents'/m, kind: 'handle', channel: 'clear-directory-contents', out: [OUT], inside: [`${WS}/sub`], wantInside: 2, isDir: true },
        // 重命名的覆盖分支是 rmSync(recursive)，等价于删除
        { name: "rename 的 overwrite 分支", re: /^\s*ipcMain\.handle\(\s*'rename-file-invoke'/m, kind: 'handle', channel: 'rename-file-invoke', out: [`${WS}/a.txt`, OUT], inside: [`${WS}/a.txt`, `${WS}/b.txt`], wantInside: 2, exists: true, options: { overwrite: true } }
    ];
    for (const ch of deletionChannels) {
        ch.src = callStatement(mainSrc, ch.re);
        check(`${ch.name} 抽到了整条注册语句`, () => {
            assert.ok(ch.src.length > 200, `只抽到 ${ch.src.length} 个字符：${JSON.stringify(ch.src.slice(0, 40))}`);
        });
        if (!ch.src) continue;

        check(`${ch.name} 的注册方式是 ${ch.kind}、通道名就是 '${ch.channel}'（on/handle 用错渲染进程收不到结果）`, () => {
            assert.deepStrictEqual(boot(ch.src).reg, [ch.kind, ch.channel]);
        });
    }

    // handler 全是 async，检查点攒进延迟批次（文件尾统一 await 后再汇总）。
    // 每个通道两组：越界必须一次破坏性调用都不发、且把原因回给调用方；
    // 工作区内照常执行 —— 没有这组对照，桩“谁都不许删”也能让上一组通过。
    deferredChecks.push(async () => {
        for (const ch of deletionChannels.filter((c) => c.src)) {
            const invoke = async (paths) => {
                const b = boot(ch.src, { isDir: ch.isDir, exists: ch.exists });
                const e = event();
                const args = [e.stub, ...paths];
                if (ch.options) args.push(ch.options);
                const res = await b.h(...args);
                // on 通道不回返回值，错误只出现在 event.reply 的第三个参数上
                const surfaced = ch.kind === 'on'
                    ? (e.replies.length ? e.replies[e.replies.length - 1][2] : '<没有 reply>')
                    : (res && res.error) || (res && res.success ? null : JSON.stringify(res));
                return { destructive: b.destructive(), surfaced, res, replies: e.replies };
            };

            const out = await invoke(ch.out);
            check(`${ch.name} 越界路径下破坏性调用一次都不发，并把原因回给调用方`, () => {
                assert.deepStrictEqual(out.destructive, [], JSON.stringify(out.destructive));
                assert.strictEqual(out.surfaced, 'error.outsideWorkspace', JSON.stringify(out));
            });

            const inside = await invoke(ch.inside);
            check(`${ch.name} 工作区内照常执行（对照组：拦住的必须是越界，不是所有删除）`, () => {
                assert.strictEqual(inside.destructive.length, ch.wantInside,
                    JSON.stringify({ calls: inside.destructive, res: inside.res }));
                assert.strictEqual(inside.surfaced, null, JSON.stringify(inside.surfaced));
            });
        }
    });

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
    const I5 = blockByIndent(ciSrc, /\[I5\] No-op t\(\) residue/);

    // 原来三条都是文本守卫：一条比 I5 第二条正则的字面量、一条比注释里那句「两种形态都要拦」，
    // 还有一条在测试里**重抄了一遍**属性形态的正则去扫真文件。
    // 前者一改排版就碎，后者更糟：ci-check 里的判据哪天收紧或放宽，这条都不知道自己在测什么。
    // 现在整块真跑：报没报、报了几处、报的是哪个键，都是跑出来的。
    check('I5 检查项整块抽出来（真跑的必须是它，不是测试里的副本）', () => {
        assert.ok(I5.startsWith('{') && I5.length > 400, JSON.stringify(I5.slice(0, 40)));
    });

    check('I5 真跑：`= (\'k\')` 赋值与 `key: (\'k\')` 属性两种形态各报一次', () => {
        const { fails } = runCiBlock(I5, virtualFile('a.js',
            "const o = {\n    title: ('dialog.save'),\n};\nlet z = 1;\nz = ('dialog.save');\n"));
        assert.strictEqual(fails.length, 2, JSON.stringify(fails));
        assert.ok(fails.every((m) => m.includes('dialog.save')), JSON.stringify(fails));
    });

    check('I5 真跑：正常 t() 调用一处都不报（对照组：不是“看见括号里的引号就报”）', () => {
        const { fails, oks } = runCiBlock(I5, virtualFile('a.js',
            "const o = { title: window.i18n.t('dialog.save') };\nlet z = window.i18n.t('dialog.save');\n"));
        assert.deepStrictEqual(fails, [], JSON.stringify(fails));
        assert.deepStrictEqual(oks, ['no no-op t() residue'], JSON.stringify(oks));
    });

    // 回归：曾经真实存在的 3 处裸 key（原生对话框标题 x2、编译输出诊断位置 x1）
    for (const rel of ['src/renderer/js/sidebar/cloudSync.js', 'src/renderer/js/compile-manager.js']) {
        check(`${rel} 过 I5：没有裸 key 字面量`, () => {
            const abs = path.join(root, rel);
            const { fails } = runCiBlock(I5, { [abs]: fs.readFileSync(abs, 'utf8') });
            assert.deepStrictEqual(fails, [], JSON.stringify(fails));
        });
    }
}

// ---------------------------------------------------------------------------
// 6. I8 豁免收紧：键必须真实存在
// ---------------------------------------------------------------------------
{
    const ciSrc = fs.readFileSync(path.join(root, 'scripts/ci-check.js'), 'utf8');
    const I8 = blockByIndent(ciSrc, /\[I8\] Hardcoded CJK ratchet/);
    // 兜底豁免的判据是「这行的 t() 键在不在语言包里」，所以必须喂真包；
    // 键名也不写死 —— 写死的那个哪天被删，这条就会假红。取包里第一个键当「确实存在」的样本。
    const knownKey = Object.keys(loadLocales()['zh-cn'])[0];

    check('I8 检查项整块抽出来', () => {
        assert.ok(I8.startsWith('{') && I8.length > 1000, JSON.stringify(I8.slice(0, 40)));
    });

    check('I8 真跑：兜底串挂在真实存在的键上时豁免生效，一处都不报', () => {
        const { fails } = runCiBlock(I8, virtualFile('a.js',
            `const m = window.i18n.t('${knownKey}') || '已保存';\n`));
        assert.deepStrictEqual(fails, [], JSON.stringify(fails));
    });

    check('I8 真跑：键写错时兜底永远不生效（屏幕上就是裸键名），必须 fail 而不是记日志', () => {
        const { fails, infos } = runCiBlock(I8, virtualFile('a.js',
            `const m = window.i18n.t('${knownKey}Typo') || '已保存';\n`));
        assert.strictEqual(fails.length, 1, JSON.stringify({ fails, infos }));
        assert.ok(/not in any language pack/.test(fails[0]) && fails[0].includes(`${knownKey}Typo`),
            JSON.stringify(fails[0]));
        assert.deepStrictEqual(infos, [], '只 info 不 fail 等于放行');
    });

    check('I8 真跑：真硬编码中文走 ratchet 分支（和“键不存在”是两种报法，别混成一条）', () => {
        const { fails } = runCiBlock(I8, virtualFile('a.js', "showError('出错了');\n"));
        assert.strictEqual(fails.length, 1, JSON.stringify(fails));
        assert.ok(/baseline/.test(fails[0]) && !/language pack/.test(fails[0]), JSON.stringify(fails[0]));
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
            // TTL 是配置值，但抽取按括号配平取整条声明：`const|let`、缩进、`=` 两边空格、
            // 初值里的括号都不锁长相；值再从沙箱里读回来，用假时钟把「过期」跑出来。
            ttl: scalarConst(preloadSrc, 'SETTINGS_CACHE_TTL_MS'),
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
        // 假时钟：TTL 这条配置只有能推动时间才测得出「过期」，用真实 Date 就得睡 1 秒。
        const clock = { now: 0 };
        // 一次性结算全部在途请求：手写 shift()() 只结第一个，去重一旦失效，
        // 后面的 promise 永不结算，整个 async 段就地挂死（挂死不是失败，是静默放行）。
        const flush = () => { for (const settle of resolvers.splice(0, resolvers.length)) settle(); };
        const ctx = vm.createContext({
            Date: { now: () => clock.now },
            // 变异测试用的旁路：源码里正常没人读它。有它才能测出「源码混用真假时钟」——
            // 真 Date.now() 在沙箱里永远比假时钟走得快，缓存看起来会「一直在过期」。
            __src_Date_now: () => Date.now(),
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
            // 不要再在后面补一份 `Date` 简写：同名键后写覆盖前写，真 Date 一来
            // 上面那个假时钟就废了，TTL 那两条会静默退化成「永远命中缓存」。
            JSON, Math, Number, String, Boolean, Array, Object, Error, RegExp, Promise, Set, Map
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
        vm.runInContext('this.__api = { safeIpcRenderer, getAllSettings, invalidateSettingsCache, ALLOWED_EVENT_CHANNELS, ttl: SETTINGS_CACHE_TTL_MS };', ctx);
        const api = ctx.__api;
        // TTL 的值不写死在测试里：从沙箱读回来，再用它推时钟，测的是「这条配置真在承重」
        const TTL = Number(api.ttl);
        check('缓存 TTL 配置被真跑读成一个正数', () => {
            assert.ok(Number.isFinite(TTL) && TTL > 0, `TTL 读回来是 ${api.ttl}，假时钟推不动`);
        });

        check('广播失效循环真注册了 5 个通道，回调就是 invalidateSettingsCache 本体', () => {
            assert.deepStrictEqual(listeners.map((l) => l[0]),
                ['settings-changed', 'settings-reset', 'settings-imported', 'settings-applied', 'apply-settings-preview'],
                JSON.stringify(listeners.map((l) => l[0])));
            assert.ok(listeners.every((l) => l[1] === api.invalidateSettingsCache),
                '注册的回调不是失效函数本体，改完设置缓存不会掉');
        });

        const a = api.getAllSettings();
        const b = api.getAllSettings();
        flush();
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
        flush();
        await d;

        // TTL 用假时钟推：把阈值缩到 0（永远过期）或放到 Infinity（永不过期）都会在这里红，
        // 而原来的正则只锁得住「这行字面上还写着 1000」。
        const cachedBeforeTtl = invokeCalls;
        clock.now += TTL - 1;
        api.getAllSettings();
        check('差 1ms 到 TTL：这次读必须命中缓存，不再 invoke', () => {
            assert.strictEqual(invokeCalls, cachedBeforeTtl,
                `多拉了 ${invokeCalls - cachedBeforeTtl} 次，TTL 内不该回源`);
        });
        clock.now += 1;
        const afterTtl = api.getAllSettings();
        check('时间走到 TTL 整点：缓存必须判过期重新拉（边界是 < 不是 <=）', () => {
            assert.strictEqual(invokeCalls, cachedBeforeTtl + 1,
                `invoke 停在 ${invokeCalls} 次，TTL 到了还在吃缓存`);
        });
        flush();
        await afterTtl;
        // 上面这次重新拉把时间戳刷新在 TTL 处；再往前推 TTL-1 必须还在 TTL 内。
        // 少了这条，「时间戳钉死在第一次写入」这种缓存永不失效的写法能一路混过去。
        clock.now += TTL - 1;
        api.getAllSettings();
        check('重新拉取后 TTL 从头计时（时间戳跟着每次写入刷新）', () => {
            assert.strictEqual(invokeCalls, cachedBeforeTtl + 1,
                `多拉了 ${invokeCalls - cachedBeforeTtl - 1} 次，刚写入的缓存没被当成新的`);
        });

        // 核心场景：读取在途 + 期间发生写入 → 这个响应是写入**前**的快照，不许回填
        api.invalidateSettingsCache();              // 清掉上面的结果，保证下一条真的在途
        const inflight = api.getAllSettings();      // invoke
        api.invalidateSettingsCache();              // 期间用户改了设置
        flush();
        await inflight;
        api.getAllSettings();                       // 必须再拉一次
        check('在途请求不把写入前的旧快照回填进缓存（代数比对生效）', () => {
            assert.strictEqual(invokeCalls, cachedBeforeTtl + 3,
                `invoke 停在 ${invokeCalls} 次：旧快照被重新缓存，改完设置读到更旧的值`);
        });
        flush();

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

    clearTimeout(watchdog);
    console.log(`\n${total - failures}/${total} assertions passed`);
    process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
    console.log(`[FAIL] 异步守卫自身跑通 | ${String((error && error.stack) || error)}`);
    clearTimeout(watchdog);
    process.exit(1);
});
