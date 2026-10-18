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
const { callStatement } = require('./fixtures/source-extract');
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

check('comparer cleanup deletes compiled products through deleteTempFile', comparerSource.includes('await window.electronAPI.deleteTempFile(exe);'));
check('compare completion log is no longer skipped when already stopped', !/if \(task\.state\.mode === 'running'\) \{\s*task\.state\.mode = 'complete';\s*logInfo\(/.test(comparerSource));

(async () => {
    for (const row of await deferredChecks) check(row.name, row.cond, row.extra);
    process.exit(failures > 0 ? 1 : 0);
})().catch((error) => {
    check('本文件的异步守卫自身跑通', false, String((error && error.stack) || error));
    process.exit(1);
});
