'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let failures = 0;
// 需要在假 fs 里 await 一遍的断言攒到这里，文件末尾统一执行
let deferredChecks = Promise.resolve([]);
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.join(__dirname, '..');
const { callStatement, classMethod, compileMethod } = require('./fixtures/source-extract');
const { loadLocales } = require('./fixtures/ci-block-runner');
const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const comparerSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'sidebar', 'codeComparer.js'), 'utf8');

// ---- Bug A: delete-temp-file 白名单 ----

// 把 main.js 里真实的包含关系判定逻辑抽出来跑，验证白名单与 path.relative 实现
const helperStart = mainSource.indexOf('const TEMP_DELETE_ROOTS = [');
const helperEnd = mainSource.indexOf("ipcMain.handle('delete-temp-file'");
check('main process declares a delete whitelist for temp roots', helperStart !== -1 && helperEnd > helperStart);

let isPathInsideTempRoots = null;
let tempRoots = null;
try {
    const snippet = mainSource.slice(helperStart, helperEnd);
    const context = vm.createContext({ os, path, USER_DATA_DIR_NAME: '.oicpp-plus' });
    vm.runInContext(`${snippet}\nthis.check = isPathInsideTempRoots; this.roots = TEMP_DELETE_ROOTS;`, context);
    isPathInsideTempRoots = context.check;
    tempRoots = context.roots;
} catch (error) {
    check('whitelist helper can be evaluated standalone', false, error.message);
}

// 两个临时根写死在测试里，不从 TEMP_DELETE_ROOTS 反推：
// 否则把数组里两项一交换，所有「期望路径」会跟着一起换，断言就成了同源循环。
const codeTemp = path.join(os.homedir(), '.oicpp-plus', 'codeTemp');
const compare = path.join(os.homedir(), '.oicpp-plus', 'compare');

if (isPathInsideTempRoots) {
    check('accepts a comparer artifact under the compare dir', isPathInsideTempRoots(path.join(compare, 'std_1700000000000.exe')));
    check('accepts a nested freopen run file under the compare dir', isPathInsideTempRoots(path.join(compare, 'freopen_runs', 'task', 'in.txt')));
    check('accepts a file under codeTemp', isPathInsideTempRoots(path.join(codeTemp, 'tmp.cpp')));
    // 大小写：win32 的 path.relative 不敏感，同一目录换个大小写仍算目录内；
    // POSIX 上 .OICPP-PLUS/COMPARE 就是另一个目录，必须判为目录外。
    const caseShifted = path.join(compare.toUpperCase(), 'std_1.exe');
    if (process.platform === 'win32') {
        check('accepts a case-shifted path inside compare', isPathInsideTempRoots(caseShifted));
    } else {
        check('rejects a case-shifted path on case-sensitive FS', !isPathInsideTempRoots(caseShifted));
    }
    check('rejects a sibling dir sharing the codeTemp prefix', !isPathInsideTempRoots(path.join(os.homedir(), '.oicpp-plus', 'codeTempEvil', 'x.exe')));
    check('rejects a sibling dir sharing the compare prefix', !isPathInsideTempRoots(path.join(os.homedir(), '.oicpp-plus', 'compareOld', 'x.exe')));
    check('rejects unrelated paths', !isPathInsideTempRoots(path.join(os.homedir(), 'Documents', 'x.exe')));
    check('rejects the whitelist dir itself', !isPathInsideTempRoots(compare) && !isPathInsideTempRoots(codeTemp));
    // 白名单内容与顺序：相对路径解析用的就是第一项（codeTemp），所以顺序本身是契约。
    check('真跑出来的白名单就是 codeTemp 打头、compare 兜后',
        Array.isArray(tempRoots) && tempRoots.length === 2
            && tempRoots[0] === codeTemp && tempRoots[1] === compare, tempRoots);
}

// 原来这里是「切两个 indexOf 之间的字符串，再在里面比字面量」：
// 三条断言分别锁 `.startsWith(` 不许出现、logInfo 的中文原文、logError 的中文原文。
// 把日志降成 logWarn、把白名单判定换成另一照样漏的写法、或者干脆整个分支不再执行到 fs，
// 这三条都不会红 —— 它们查的是「源码里写过这句」，不是「删得成/删不成时各会怎样」。
// 现在把整条 handle('delete-temp-file') 注册语句抽出来真跑，包含关系判定用从同一文件抽出来的真 helper。
const deleteStmt = callStatement(mainSource, /^\s*ipcMain\.handle\('delete-temp-file'/m);
check('delete-temp-file 整条注册语句抽取成功（真跑的必须是它，不是字符串切片）',
    deleteStmt.length > 400, JSON.stringify({ len: deleteStmt.length, head: deleteStmt.slice(0, 40) }));

const runDelete = ({ filePath, exists = true, failCodes = [], roots = tempRoots || [] }) => {
    const calls = [];
    const logs = { info: 0, error: 0, warn: 0 };
    const holder = {};
    let timers = 0;
    const ctx = vm.createContext({
        Object, Array, String, Number, Boolean, Error, JSON, RegExp, Math, Set, Map, Promise, path, os,
        t: (key) => key,
        TEMP_DELETE_ROOTS: roots,
        isPathInsideTempRoots,
        fs: {
            existsSync: (p) => { calls.push(['existsSync', p]); return exists; },
            unlinkSync: (p) => {
                calls.push(['unlinkSync', p]);
                const code = failCodes.shift();
                if (code) {
                    const error = new Error(code);
                    error.code = code;
                    throw error;
                }
            }
        },
        logInfo: () => { logs.info++; },
        logWarn: () => { logs.warn++; },
        logError: () => { logs.error++; },
        // 重试的退避不能真等：桩把定时器立刻兑现，于是「重试了几次」是数出来的，耗时是零。
        setTimeout: (fn) => { timers++; fn(); },
        ipcMain: { handle: (channel, fn) => { holder.reg = [channel, fn]; } }
    });
    const invoke = async () => {
        try {
            vm.runInContext(deleteStmt, ctx);
            if (!holder.reg) return { failedToRegister: true };
            return { value: await holder.reg[1](null, filePath) };
        } catch (error) { return { threw: String((error && error.message) || error) }; }
    };
    return invoke().then((res) => ({
        ...res,
        channel: holder.reg ? holder.reg[0] : null,
        unlinks: calls.filter((c) => c[0] === 'unlinkSync').map((c) => c[1]),
        logs, timers
    }));
};

// 对拍产物在 compare 根下，就固定用它；不再从 tempRoots[0] 反推（见上）。
const TMP = compare;
deferredChecks = (async () => {
    const rows = [];
    const add = (name, cond, extra) => rows.push({ name, cond, extra: extra === undefined ? '' : JSON.stringify(extra) });
    if (!deleteStmt || deleteStmt.length < 400 || !isPathInsideTempRoots) {
        rows.push({ name: 'delete-temp-file 守卫可执行', cond: false, extra: '注册语句或 helper 没抽出来' });
        return rows;
    }
    add('通道名与注册方式没被换掉（还是 handle("delete-temp-file")）',
        (await runDelete({ filePath: path.join(TMP, 'a.exe') })).channel === 'delete-temp-file');

    const inside = await runDelete({ filePath: path.join(TMP, 'std_1.exe') });
    add('白名单内的文件：真去 unlink 一次、返回 true、一条日志都不刷（成功路径别刷屏）',
        inside.value === true && inside.unlinks.length === 1
            && inside.unlinks[0] === path.join(TMP, 'std_1.exe')
            && inside.logs.info + inside.logs.warn + inside.logs.error === 0, inside);

    const missing = await runDelete({ filePath: path.join(TMP, 'gone.exe'), exists: false });
    add('文件本来就不存在：返回 true、一次 unlink 都不发，并按 info 记一笔（不是 error，也不是静音）',
        missing.value === true && missing.unlinks.length === 0
            && missing.logs.info === 1 && missing.logs.error === 0, missing);

    const outside = await runDelete({ filePath: path.join(os.homedir(), 'Documents', 'x.exe') });
    add('白名单外的绝对路径：抛错、fs 一个字节都不碰，并把原因记到 error 级',
        outside.threw === 'error.pathTraversalBlocked' && outside.unlinks.length === 0
            && outside.logs.error === 1 && outside.logs.info === 0, outside);
    const traversal = await runDelete({ filePath: path.join(TMP, '..', '..', 'evil.exe') });
    add('目录穿越（temp 根往上跳）：resolve 之后仍在根外，同样抛错且不碰 fs',
        traversal.threw === 'error.pathTraversalBlocked' && traversal.unlinks.length === 0
            && traversal.logs.error === 1, traversal);
    const rootItself = await runDelete({ filePath: TMP });
    add('白名单目录本身也不许删（只许删里面的文件）',
        rootItself.threw === 'error.pathTraversalBlocked' && rootItself.unlinks.length === 0, rootItself);

    const relative = await runDelete({ filePath: 'std_2.exe' });
    add('相对路径按 codeTemp 根解析，不是按 process.cwd()',
        relative.unlinks.length === 1 && relative.unlinks[0] === path.join(codeTemp, 'std_2.exe')
            && relative.unlinks[0] !== path.resolve(process.cwd(), 'std_2.exe'),
        { got: relative.unlinks[0], cwd: path.resolve(process.cwd(), 'std_2.exe') });

    const flaky = await runDelete({ filePath: path.join(TMP, 'busy.exe'), failCodes: ['EPERM', 'EPERM'] });
    add('Windows 上 exe 句柄没释放（EPERM）：退避重试到成功，最终返回 true 且不报 error',
        flaky.value === true && flaky.unlinks.length === 3 && flaky.timers === 2 && flaky.logs.error === 0,
        flaky);
    const alwaysBusy = await runDelete({
        filePath: path.join(TMP, 'busy.exe'), failCodes: ['EBUSY', 'EBUSY', 'EACCES', 'EPERM', 'EBUSY', 'EPERM', 'EPERM']
    });
    add('重试有上限（不是死循环）：五次退避后带原错误抛出，且只记一条 error',
        alwaysBusy.threw === 'EPERM' && alwaysBusy.unlinks.length === 6 && alwaysBusy.timers === 5
            && alwaysBusy.logs.error === 1, alwaysBusy);
    const hardFail = await runDelete({ filePath: path.join(TMP, 'x.exe'), failCodes: ['ENOTDIR'] });
    add('不可重试的错误立即上抛：一次都不等定时器（别把 ENOTDIR 当句柄占用反复磨）',
        hardFail.threw === 'ENOTDIR' && hardFail.unlinks.length === 1 && hardFail.timers === 0
            && hardFail.logs.error === 1, hardFail);

    for (const bad of [null, undefined, '', 42, {}, []]) {
        const res = await runDelete({ filePath: bad });
        add(`非法 filePath（${JSON.stringify(bad) === undefined ? String(bad) : JSON.stringify(bad)}）：先拦住，不碰 fs`,
            res.threw === 'error.invalidFilePath' && res.unlinks.length === 0, res);
    }
    return rows;
})();

// ---- Bug B/D: 编译缓存按签名命名并交出产物 ----

const cacheBlock = mainSource.slice(
    mainSource.indexOf('const compileCacheVersion'),
    mainSource.indexOf('const args = [', mainSource.indexOf('const compileCacheVersion'))
);
check('compile cache uses a dedicated cache dir', mainSource.includes("path.join(os.homedir(), USER_DATA_DIR_NAME, 'compile-cache')"));
check('cache record no longer requires outputFile', /const createCompileCacheRecord = \(\) => \{\s*if \(!inputFile \|\| !compilerPath\)\s*return null;/.test(cacheBlock));
check('cache signature payload drops outputFile', !/outputFile:\s*path\.resolve/.test(cacheBlock));
check('cache payload still hashes source, compiler, args and cwd', /inputSize/.test(cacheBlock) && /compilerMtimeMs/.test(cacheBlock) && /compilerArgs/.test(cacheBlock) && /workingDirectory/.test(cacheBlock));
check('cached exe and metadata are named by signature', cacheBlock.includes('`${sig}${path.extname(outputFile) || \'.exe\'}`') && cacheBlock.includes('`${sig}.oicpp-cache`'));
check('cache hit copies the cached exe to the requested outputFile', /fs\.copyFileSync\(cacheExePath, outputFile\)/.test(cacheBlock));
check('cache hit still resolves with cached: true', cacheBlock.includes('cached: true'));
check('cache hit is logged', cacheBlock.includes("logInfo('[编译缓存]"));

const cacheWriteBlock = mainSource.slice(
    mainSource.indexOf('if (result.success && outputExists && compileCacheRecord'),
    mainSource.indexOf('if (code === 0) {', mainSource.indexOf('if (result.success && outputExists && compileCacheRecord'))
);
check('successful compile stores the exe into the cache', /fs\.copyFileSync\(outputFile, cacheExePath\)/.test(cacheWriteBlock));
check('successful compile stores signature metadata without outputFile', /fs\.writeFileSync\(cacheMetadataPath, JSON\.stringify\(latestRecord\)/.test(cacheWriteBlock) && !/outputFile:\s*path\.resolve/.test(cacheWriteBlock));
check('cache write failures stay at warn level', cacheWriteBlock.includes("logWarn('[编译缓存] 写入签名失败:'"));
check('stale writes during compilation are still rejected', cacheWriteBlock.includes("logWarn('[编译缓存] 编译期间源文件或编译环境发生变化，跳过写入签名'"));

// ---- 对拍器清理与完成日志 ----

// 原来这里是两条字面量：`comparerSource.includes('await window.electronAPI.deleteTempFile(exe);')`
// 加一条「完成日志没被塞进 if 里」的正则否定。前者只问源码里写过这句没有：把日志删了、
// 把 exe 传成别的变量、甚至改回走 deleteFile 那条无白名单通道，它照样绿；
// 后者锁的是字形，把整段挪进 if 反而更像原样。现在抽出真方法/真回调各跑一遍。
const cleanupMethod = classMethod(comparerSource, 'cleanupCompiledExecutables');
const finishMethod = classMethod(comparerSource, 'finishCompareTask');
const completeStmt = callStatement(comparerSource, /^\s*cleanupComplete = window\.electronAPI\.onCompareComplete\(/m);
check('对拍器三段片段抽取成功（清理方法、收尾方法、完成回调注册语句）',
    cleanupMethod.length > 300 && finishMethod.length > 120 && completeStmt.length > 500,
    JSON.stringify({ cleanup: cleanupMethod.length, finish: finishMethod.length, complete: completeStmt.length }));

const packs = loadLocales();
const fill = (text, params) => String(text).replace(/\{(\w+)\}/g, (m, k) =>
    Object.prototype.hasOwnProperty.call(params || {}, k) ? String(params[k]) : m);

// 假 i18n：键查不到就吐键名，于是「裸键上屏」会被下面的“不许出现键名”抓到。
const makeWindow = (pack, api) => ({ i18n: { t: (key, params) => fill(pack[key] === undefined ? key : pack[key], params) }, electronAPI: api });

const runCleanup = ({ executables, failAt = -1, throwStyle = 'reject' }) => {
    const trace = [];
    const logs = { info: [], warn: [], error: [] };
    const task = { key: 't1', compiledExecutables: executables };
    const ctx = vm.createContext({
        Object, Array, String, Number, Boolean, Error, JSON, RegExp, Math, Set, Map, Promise,
        logInfo: (...a) => { logs.info.push(a.map((x) => String(x)).join(' ')); },
        logWarn: (...a) => { logs.warn.push(a.map((x) => String(x)).join(' ')); },
        logError: (...a) => { logs.error.push(a.map((x) => String(x)).join(' ')); },
        window: makeWindow(packs['zh-cn'], {
            deleteTempFile: (p) => {
                trace.push(['call', p]);
                const shouldFail = failAt === trace.filter((t) => t[0] === 'call').length - 1;
                // 两跳微任务：不 await 的话所有 call 会先于所有 done，顺序就能看出来。
                const tail = Promise.resolve().then(() => Promise.resolve().then(() => trace.push(['done', p])));
                if (shouldFail) {
                    const error = new Error('删除失败');
                    return throwStyle === 'sync' ? (() => { throw error; })() : Promise.reject(error);
                }
                return tail;
            },
            deleteFile: (p) => { trace.push(['deleteFile', p]); return Promise.resolve(); }
        })
    });
    const fn = compileMethod(ctx, cleanupMethod);
    if (!fn) return Promise.resolve({ missing: 'cleanupCompiledExecutables' });
    return fn.call({}, task).then(
        () => ({ task, trace, logs, threw: null }),
        (error) => ({ task, trace, logs, threw: String((error && error.message) || error) }));
};

const runFinish = ({ activeKey, taskKey }) => {
    const order = [];
    const task = { key: taskKey, state: { isRunning: true, mode: 'running' } };
    // finishCompareTask 里全是 this.xxx，所以这些方法得挂在被 .call 的那个 self 上，
    // 挂到 vm 全局上等于给了个不存在的 this。
    // 清理桩在「活干完」那一刻才记账：只记「调用了」的话，去掉 await 也照样是
    // cleanup→updateUI（同步前半段先跑），那条 await 就白测了。
    const self = {
        activeTaskKey: activeKey,
        cleanupCompiledExecutables: async (t) => {
            await Promise.resolve();
            await Promise.resolve();
            order.push('cleanupDone');
            t.__cleaned = true;
        },
        updateUIForTask: (t) => { order.push('updateUI'); t.__updated = true; }
    };
    const ctx = vm.createContext({
        Object, Array, String, Number, Boolean, Error, JSON, RegExp, Math, Set, Map, Promise,
        logInfo: () => { }, logWarn: () => { }, logError: () => { }
    });
    const fn = compileMethod(ctx, finishMethod);
    if (!fn) return Promise.resolve({ missing: 'finishCompareTask' });
    return fn.call(self, task).then(() => ({ order, task }));
};

const runComplete = ({ mode, result, lang = 'zh-cn', state = {} }) => {
    const holder = {};
    const calls = { renderIfActive: 0, finishCompareTask: 0, cleanupAllListeners: 0, updateTaskStatus: [], logInfo: [] };
    const task = {
        key: 't1',
        state: Object.assign({ mode, isRunning: true, completedTests: 7, currentTest: 3, failedTests: 1 }, state)
    };
    const ctx = vm.createContext({
        Object, Array, String, Number, Boolean, Error, JSON, RegExp, Math, Set, Map, Promise,
        task,
        cleanupAllListeners: () => { calls.cleanupAllListeners++; },
        logInfo: (...a) => { calls.logInfo.push(a.map((x) => String(x)).join(' ')); },
        logWarn: (...a) => { calls.logInfo.push('[warn]' + a.map((x) => String(x)).join(' ')); },
        logError: (...a) => { calls.logInfo.push('[error]' + a.map((x) => String(x)).join(' ')); },
        window: makeWindow(packs[lang], {
            onCompareComplete: (cb) => { holder.cb = cb; return () => { }; }
        })
    });
    Object.assign(ctx, {
        updateTaskStatus: (t, msg) => { calls.updateTaskStatus.push(msg); },
        renderIfActive: (t) => { calls.renderIfActive++; },
        finishCompareTask: async (t) => { calls.finishCompareTask++; await Promise.resolve(); }
    });
    try {
        vm.runInContext(completeStmt, ctx);
    } catch (error) {
        return Promise.resolve({ registrationThrew: String((error && error.message) || error) });
    }
    if (!holder.cb) return Promise.resolve({ notRegistered: true });
    return Promise.resolve().then(() => holder.cb(result)).then(
        () => ({ task, calls }),
        (error) => ({ task, calls, threw: String((error && error.message) || error) }));
};

deferredChecks = Promise.all([deferredChecks, (async () => {
    const rows = [];
    const add = (name, cond, extra) => rows.push({ name, cond, extra: extra === undefined ? '' : JSON.stringify(extra) });
    const STD = '/root/.oicpp-plus/compare/std_1.exe';
    const TEST = '/root/.oicpp-plus/compare/test_1.exe';
    const GEN = '/root/.oicpp-plus/compare/generator_1.exe';
    const SPJ = '/root/.oicpp-plus/compare/spj_1.exe';
    const all = { stdExe: STD, testExe: TEST, generatorExe: GEN, spjExe: SPJ };
    const callsOf = (r, kind) => r.trace ? r.trace.filter((t) => t[0] === kind).map((t) => t[1]) : [];

    if (!cleanupMethod || !finishMethod || !completeStmt) {
        rows.push({ name: '对拍器守卫可执行', cond: false, extra: '片段没抽出来' });
        return rows;
    }

    const four = await runCleanup({ executables: { ...all } });
    add('四个产物都走 deleteTempFile：次数、顺序、参数路径全对，且不碰 deleteFile 那条无白名单通道',
        JSON.stringify(callsOf(four, 'call')) === JSON.stringify([STD, TEST, GEN, SPJ])
            && callsOf(four, 'deleteFile').length === 0, four.trace);
    add('删除是串起来的（真 await）：第 n 次 done 一定紧跟在第 n 次 call 之后',
        four.trace.filter((t) => t[0] === 'done').length === 4
            && four.trace.every((t, i) => (i % 2 === 0) === (t[0] === 'call')),
        four.trace.map((t) => t[0] + ':' + t[1].split('/').pop()).join(','));
    add('清完把句柄交出去（compiledExecutables 置 null，别留下指向已删文件的引用）',
        four.task.compiledExecutables === null && four.threw === null, four.task.compiledExecutables);
    add('每个产物记一条 info，一条 error 都不许有（成功路径别刷屏）',
        four.logs.info.length === 4 && four.logs.error.length === 0 && four.logs.warn.length === 0, four.logs);

    const partial = await runCleanup({ executables: { stdExe: STD, testExe: TEST, generatorExe: null, spjExe: undefined } });
    add('没编译出来的产物被 filter 掉：只删存在的两个，绝不把 null/undefined 传给主进程',
        JSON.stringify(callsOf(partial, 'call')) === JSON.stringify([STD, TEST])
            && partial.logs.info.length === 2, partial.trace);
    const none = await runCleanup({ executables: null });
    add('压根没编译过：一次 IPC 都不发、不抛错',
        none.trace.length === 0 && none.threw === null, none);
    const absent = await runCleanup({ executables: undefined });
    add('task 上没这个字段也不炸（可选链那道门）',
        absent.trace.length === 0 && absent.threw === null, absent);

    const oneFails = await runCleanup({ executables: { ...all }, failAt: 1 });
    add('某一个删不掉：其余照删（不早退），失败的记 warn 不是 error，方法本身不外抛',
        callsOf(oneFails, 'call').length === 4 && oneFails.logs.warn.length === 1
            && oneFails.logs.error.length === 0 && oneFails.threw === null
            && oneFails.task.compiledExecutables === null,
        { calls: callsOf(oneFails, 'call').length, logs: oneFails.logs, threw: oneFails.threw });
    const syncThrow = await runCleanup({ executables: { ...all }, failAt: 0, throwStyle: 'sync' });
    add('deleteTempFile 同步抛（不是 reject）也一样被兜住，剩下三个照删',
        callsOf(syncThrow, 'call').length === 4 && syncThrow.threw === null, syncThrow);

    const finishActive = await runFinish({ activeKey: 't1', taskKey: 't1' });
    add('收尾：先置 isRunning=false，产物真删完才刷新 UI（清理不是发完就不管）',
        finishActive.task.state.isRunning === false && finishActive.task.__cleaned === true
            && JSON.stringify(finishActive.order) === JSON.stringify(['cleanupDone', 'updateUI']), finishActive.order);
    const finishOther = await runFinish({ activeKey: 'other', taskKey: 't1' });
    add('收尾切到别的任务：仍然清产物，但不碰当前 UI',
        finishOther.task.__cleaned === true && finishOther.order.indexOf('updateUI') === -1, finishOther.order);

    const running = await runComplete({ mode: 'running', result: { completed: 12, failed: 0 } });
    add('正常完成（running）：状态转 complete、进度写真值、清监听、走收尾，各恰好一次',
        running.task.state.mode === 'complete' && running.task.state.completedTests === 12
            && running.task.state.currentTest === 12 && running.task.state.failedTests === 0
            && running.calls.cleanupAllListeners === 1 && running.calls.finishCompareTask === 1
            && running.calls.renderIfActive === 1 && running.calls.updateTaskStatus.length === 0,
        { mode: running.task.state.mode, calls: running.calls });
    const stopping = await runComplete({ mode: 'stopping', result: { completed: 5, failed: 0 } });
    add('点了停止但回调迟到（stopping）：仍然算正常完成，不被踢进「提前结束」分支',
        stopping.task.state.mode === 'complete' && stopping.calls.logInfo.every((l) => !l.includes('提前结束')),
        stopping.calls.logInfo);
    const alreadyStopped = await runComplete({ mode: 'stopped', result: { completed: 9, failed: 0 } });
    add('已经 stopped 再收到完成回调：状态不被覆盖，但完成日志照打（就是那条被 if 吞掉的）',
        alreadyStopped.task.state.mode === 'stopped'
            && alreadyStopped.calls.logInfo.some((l) => l.includes('状态: stopped'))
            && alreadyStopped.calls.logInfo.some((l) => l.includes('共执行 9'))
            && alreadyStopped.calls.cleanupAllListeners === 1 && alreadyStopped.calls.finishCompareTask === 1,
        alreadyStopped.calls.logInfo);
    const errored = await runComplete({ mode: 'error', result: { completed: 2, failed: 0 } });
    add('error 态收到迟到回调：同样保留原状态、照常收尾',
        errored.task.state.mode === 'error'
            && errored.calls.logInfo.some((l) => l.includes('共执行 2'))
            && errored.calls.finishCompareTask === 1, errored.calls.logInfo);
    const stoppedByUser = await runComplete({
        mode: 'running', result: { stopped: true, completed: 8, failed: 3 }
    });
    add('用户中止（result.stopped）：转 stopped、写 warningMessage，并把停止文案递给状态栏',
        stoppedByUser.task.state.mode === 'stopped' && stoppedByUser.task.state.stopped === true
            && stoppedByUser.task.state.failedTests === 3
            && stoppedByUser.task.state.warningMessage === fill(packs['zh-cn']['compare.genFailedWarning'], { count: 3 })
            && stoppedByUser.calls.updateTaskStatus.length === 1
            && stoppedByUser.calls.updateTaskStatus[0] === fill(packs['zh-cn']['compare.compareStopped'], { completed: 8, failed: 3 }),
        stoppedByUser.task.state);
    const stoppedClean = await runComplete({ mode: 'running', result: { stopped: true, completed: 8, failed: 0 } });
    add('中止但一组都没失败：不留假警告（warningMessage 归 null）',
        stoppedClean.task.state.warningMessage === null,
        stoppedClean.task.state.warningMessage);
    const NaNed = await runComplete({ mode: 'running', result: { completed: NaN, failed: undefined }, state: { completedTests: 4 } });
    add('回调里 completed 不是数（NaN/undefined）：回退到任务已有进度，不被写坏',
        NaNed.task.state.completedTests === 4 && NaNed.task.state.currentTest === 4
            && NaNed.task.state.failedTests === 0, NaNed.task.state);
    const enDone = await runComplete({ mode: 'running', result: { stopped: true, completed: 6, failed: 2 }, lang: 'en' });
    add('换 en 语言包：这两句状态文案跟着换成英文，且屏幕上不出现裸键名',
        enDone.calls.updateTaskStatus[0] === fill(packs['en']['compare.compareStopped'], { completed: 6, failed: 2 })
            && enDone.task.state.warningMessage === fill(packs['en']['compare.genFailedWarning'], { count: 2 })
            && !JSON.stringify(enDone.calls.updateTaskStatus).includes('compare.compareStopped')
            && !String(enDone.task.state.warningMessage).includes('compare.genFailedWarning'),
        { status: enDone.calls.updateTaskStatus, warning: enDone.task.state.warningMessage });

    return rows;
})()]).then(([a, b]) => [...a, ...b]);

(async () => {
    for (const row of await deferredChecks) check(row.name, row.cond, row.extra);
    process.exit(failures > 0 ? 1 : 0);
})().catch((error) => {
    check('本文件的异步守卫自身跑通', false, String((error && error.stack) || error));
    process.exit(1);
});
