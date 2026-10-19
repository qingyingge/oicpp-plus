'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

// 挂死不等于通过：某个 await 永不 settle 时 Node 会以 0 退出码排空 event loop，
// 后半截断言一条不发也「全绿」。留一个不 unref 的定时器把「跑不完」顶成失败。
setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：某个 await 永不 settle（异步守卫没被驱动完）');
    process.exit(1);
}, 60000);

let failures = 0;
// 需要在假 fs 里 await 一遍的断言攒到这里，文件末尾统一执行
let deferredChecks = Promise.resolve([]);
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.join(__dirname, '..');
const { callStatement, classMethod, compileMethod, ifStatement } = require('./fixtures/source-extract');
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
    // 这条是 security-boundaries 里那条 `!startsWith(codeTempDir)` 文本锁的行为替身：
    // 只要 containment 退化成前缀匹配，同前缀兄弟目录就会被当成白名单内、真去 unlink。
    const sibling = await runDelete({ filePath: path.join(path.dirname(codeTemp), 'codeTempEvil', 'x.exe') });
    add('同前缀兄弟目录 codeTempEvil 不在白名单里（containment 退化成 startsWith 会先在这里红）',
        sibling.threw === 'error.pathTraversalBlocked' && sibling.unlinks.length === 0
            && sibling.logs.error === 1, sibling);

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

// 这一段原来是十几条「切一段源码下来比字面量」：比的是 copyFileSync 的参数顺序、
// 模板字符串的长相、logInfo 的中文字。把缓存挪到 outputFile 旁边、把 chmod 摘掉、
// 命中时改成 resolve(result)（调用方拿到一个不存在的文件）、把 workingDirectory 从签名里漏掉，
// 这些断言全都照绿 —— 它们读的是排版，不是「同签名复用不复用、复用后文件在不在」。
// 现在把编译处理里的两段真语句（查缓存 / 写缓存）原样抽出来，接一个虚拟 fs 跑：
// 签名跟着什么变、命中与未命中各写不写盘、失败落在哪一级，全是从调用记录里数出来的。
const readStart = mainSource.indexOf('const compileCacheVersion');
const readLen = readStart < 0 ? -1
    : mainSource.slice(readStart).search(/^ {8}const outputDir = path\.dirname\(outputFile\);/m);
const cacheReadBlock = readStart >= 0 && readLen > 0 ? mainSource.slice(readStart, readStart + readLen) : '';
const cacheWriteBlock = ifStatement(mainSource, /^[ \t]+if \(result\.success && outputExists && compileCacheRecord/m);
check('编译缓存两段真语句抽取成功（查缓存 + 写缓存）',
    cacheReadBlock.length > 1500 && cacheWriteBlock.length > 500,
    JSON.stringify({ read: cacheReadBlock.length, write: cacheWriteBlock.length }));

const HOME = '/home/oicpp';
const SRC = path.join(HOME, 'src', 'a.cpp');
const GPP = path.join(HOME, 'bin', 'g++');
const CACHE_DIR = path.join(HOME, '.oicpp-plus', 'compile-cache');

const runCache = (opts = {}) => {
    const o = Object.assign({
        inputFile: SRC,
        compilerPath: GPP,
        outputFile: path.join(HOME, 'out', 'a_1700.exe'),
        workingDirectory: path.join(HOME, 'work'),
        parsedUserArgs: ['-O2', '-std=c++17'],
        sourceSize: 100, sourceMtime: 1000, compilerSize: 500, compilerMtime: 800,
        cacheExeExists: false, cacheExeMtime: 2000,
        cacheMetaExists: false, cacheMeta: null,
        result: { success: true }, outputExists: true,
        platform: 'linux', outputDirExists: true,
        sourceChangesMidCompile: false, throwOn: null,
        missingInput: false, missingCompiler: false
    }, opts);
    const logs = { info: [], warn: [], error: [] };
    const writes = { copy: [], writeFile: [], mkdir: [], chmod: [], stat: [] };
    // 跨类型的落盘顺序：只分开记 copy/writeFile 看不出「先 exe 后元数据」这个先后关系，
    // 而那个先后正是中断时不留「有元数据却没产物」的有效假缓存的关键。
    const seq = [];
    const resolved = [];
    const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const inCacheDir = (p) => typeof p === 'string' && p.startsWith(CACHE_DIR + path.sep);
    let inputStatCount = 0;
    const fsStub = {
        existsSync: (p) => {
            if (p === o.inputFile) return !o.missingInput;
            if (p === o.compilerPath) return !o.missingCompiler;
            if (inCacheDir(p)) return p.endsWith('.oicpp-cache') ? o.cacheMetaExists : o.cacheExeExists;
            if (p === path.dirname(o.outputFile)) return o.outputDirExists;
            return false;
        },
        statSync: (p) => {
            writes.stat.push(p);
            if (p === o.inputFile) {
                if (o.missingInput) throw enoent();
                inputStatCount++;
                // 「编译期间源文件变了」就是这么来的：第二次 stat 读到新的 size/mtime
                const bump = o.sourceChangesMidCompile && inputStatCount > 1;
                return { size: o.sourceSize + (bump ? 1 : 0), mtimeMs: o.sourceMtime + (bump ? 500 : 0) };
            }
            if (p === o.compilerPath) {
                if (o.missingCompiler) throw enoent();
                return { size: o.compilerSize, mtimeMs: o.compilerMtime };
            }
            if (inCacheDir(p)) return { size: 4096, mtimeMs: o.cacheExeMtime };
            throw enoent();
        },
        readFileSync: (p) => {
            if (inCacheDir(p) && o.cacheMeta !== null) return JSON.stringify(o.cacheMeta);
            throw enoent();
        },
        copyFileSync: (a, b) => {
            if (o.throwOn === 'copy') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
            writes.copy.push([a, b]);
            seq.push('copy');
        },
        writeFileSync: (p, content) => {
            if (o.throwOn === 'write') throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
            writes.writeFile.push([p, String(content)]);
            seq.push('writeFile');
        },
        mkdirSync: (p, options) => {
            writes.mkdir.push([p, (options && options.recursive) === true]);
            seq.push('mkdir');
        },
        chmodSync: (p, mode) => {
            writes.chmod.push([p, mode]);
            seq.push('chmod');
        }
    };
    const ctx = vm.createContext({
        Object, Array, String, Number, Boolean, Error, JSON, RegExp, Math, Set, Map, Promise,
        path, os: { homedir: () => HOME }, USER_DATA_DIR_NAME: '.oicpp-plus',
        crypto: require('crypto'), process: { platform: o.platform, cwd: () => HOME },
        fs: fsStub,
        logInfo: (...a) => { logs.info.push(a.map((x) => String(x)).join(' ')); },
        logWarn: (...a) => { logs.warn.push(a.map((x) => String(x)).join(' ')); },
        logError: (...a) => { logs.error.push(a.map((x) => String(x)).join(' ')); },
        resolve: (v) => { resolved.push(v); },
        inputFile: o.inputFile, compilerPath: o.compilerPath, outputFile: o.outputFile,
        workingDirectory: o.workingDirectory, parsedUserArgs: o.parsedUserArgs,
        result: o.result, outputExists: o.outputExists
    });
    // 探针插在两段之间：命中时真代码走 resolve + return，探针就不会执行 ——
    // 「命中后不再往下写」是跑出来的，不是数字数数出来的。
    const readSrc = o.readBlock || cacheReadBlock;
    vm.runInContext(`this.__run = function () {\n${readSrc}\n`
        + 'this.__afterRead = { cacheExePath, cacheMetadataPath, record: compileCacheRecord };\n'
        + `${cacheWriteBlock}\nthis.__done = true;\n};`, ctx);
    let threw = null;
    try {
        ctx.__run();
    } catch (error) {
        threw = String((error && error.message) || error);
    }
    const after = ctx.__afterRead || null;
    return {
        threw, resolved, logs, writes, seq,
        hit: !!resolved.length && resolved[0] && resolved[0].cached === true,
        record: after && after.record ? after.record : null,
        cacheExePath: after ? after.cacheExePath : null,
        cacheMetadataPath: after ? after.cacheMetadataPath : null,
        ranWriteBlock: ctx.__done === true
    };
};

deferredChecks = Promise.all([deferredChecks, (async () => {
    const rows = [];
    const add = (name, cond, extra) => rows.push({ name, cond, extra: extra === undefined ? '' : JSON.stringify(extra) });
    if (!cacheReadBlock || !cacheWriteBlock) {
        rows.push({ name: '编译缓存守卫可执行', cond: false, extra: '两段真语句没抽出来' });
        return rows;
    }

    const miss = runCache();
    const sig = miss.record && miss.record.signature;
    add('未命中时按 sha256 签名给缓存产物命名，落在独立的 compile-cache 目录里（不是 outputFile 旁边）',
        /^[0-9a-f]{64}$/.test(String(sig)) && miss.cacheExePath === path.join(CACHE_DIR, sig + '.exe')
            && miss.cacheMetadataPath === path.join(CACHE_DIR, sig + '.oicpp-cache'),
        { sig, exe: miss.cacheExePath, meta: miss.cacheMetadataPath });
    add('签名里不许掺 outputFile 这类每次不同的随机值（否则永远命中不了）',
        miss.record && !Object.prototype.hasOwnProperty.call(miss.record, 'outputFile')
            && miss.record.inputSize === 100 && miss.record.compilerMtimeMs === 800
            && JSON.stringify(miss.record.compilerArgs) === JSON.stringify(['-O2', '-std=c++17'])
            && miss.record.workingDirectory === path.resolve(path.join(HOME, 'work')),
        miss.record);
    add('编译成功：exe 与元数据都写进缓存目录，元数据就是那份签名记录',
        miss.writes.copy.length === 1 && miss.writes.copy[0][0] === path.join(HOME, 'out', 'a_1700.exe')
            && miss.writes.copy[0][1] === miss.cacheExePath
            && miss.writes.writeFile.length === 1 && miss.writes.writeFile[0][0] === miss.cacheMetadataPath
            && miss.writes.writeFile[0][1] === JSON.stringify(miss.record)
            && miss.ranWriteBlock === true,
        { copy: miss.writes.copy, writeFile: miss.writes.writeFile.map((w) => w[0]) });
    add('缓存目录不存在时先 recursive 建目录（否则 copyFileSync 直接失败）',
        miss.writes.mkdir.length === 1 && miss.writes.mkdir[0][0] === CACHE_DIR
            && miss.writes.mkdir[0][1] === true, miss.writes.mkdir);

    const sameOtherName = runCache({ outputFile: path.join(HOME, 'out', 'a_9999.exe') });
    add('换了 outputFile 的名字签名不变（同一段源码第二次编译能命中）',
        sameOtherName.record && sameOtherName.record.signature === sig
            && sameOtherName.cacheExePath === path.join(CACHE_DIR, sig + path.extname(path.join(HOME, 'out', 'a_9999.exe'))),
        { sig2: sameOtherName.record && sameOtherName.record.signature, exe: sameOtherName.cacheExePath });
    const edited = runCache({ sourceSize: 101 });
    add('源文件变一个字节签名就变（不复用旧产物）',
        edited.record.signature !== sig, { old: sig.slice(0, 8), neo: edited.record.signature.slice(0, 8) });
    const touched = runCache({ sourceMtime: 2000 });
    add('源文件 mtime 变（size 没变）签名也变', touched.record.signature !== sig, touched.record.signature.slice(0, 8));
    const otherCompiler = runCache({ compilerMtime: 900 });
    add('编译器本体变了签名变（升级了 g++ 不能复用老产物）', otherCompiler.record.signature !== sig, '');
    const biggerCompiler = runCache({ compilerSize: 501 });
    add('编译器换了构建（mtime 没变、size 变了）签名也变', biggerCompiler.record.signature !== sig, '');
    // 把源码里那个代际常量改成 3 再跑一遍：换了缓存格式，旧签名必须整体作废，
    // 而不是只靠元数据里那个 cacheVersion 字段（签名本身就得跟着变）。
    const gen3 = runCache({
        readBlock: cacheReadBlock.replace('const compileCacheVersion = 2;', 'const compileCacheVersion = 3;')
    });
    add('缓存代际号进签名：compileCacheVersion 从 2 升到 3，所有签名都换（旧缓存整体失效）',
        gen3.record && gen3.record.signature !== sig && /^[0-9a-f]{64}$/.test(gen3.record.signature),
        { v2: sig.slice(0, 8), v3: gen3.record && gen3.record.signature.slice(0, 8) });
    const otherArgs = runCache({ parsedUserArgs: ['-O2'] });
    add('编译参数变了签名变（少了 -std=c++17 就是另一个产物）', otherArgs.record.signature !== sig, '');
    const otherCwd = runCache({ workingDirectory: path.join(HOME, 'other') });
    add('工作目录变了签名变（相对 include 会编出不同东西）', otherCwd.record.signature !== sig, '');
    const noExt = runCache({ outputFile: path.join(HOME, 'out', 'a.out') });
    const otherExt = runCache({ outputFile: path.join(HOME, 'out', 'a_bin') });
    add('缓存 exe 跟产物扩展名走，没扩展名时退回 .exe',
        noExt.cacheExePath.endsWith('.out') && otherExt.cacheExePath.endsWith('.exe'),
        { out: noExt.cacheExePath.slice(-8), bin: otherExt.cacheExePath.slice(-8) });

    const hit = runCache({
        cacheExeExists: true, cacheMetaExists: true, cacheExeMtime: 5000,
        cacheMeta: { cacheVersion: 2, signature: sig }
    });
    const OUT_EXE = path.join(HOME, 'out', 'a_1700.exe');
    add('命中：resolve({success:true, cached:true}) 并把缓存产物拷到本次 outputFile',
        hit.hit === true && hit.resolved.length === 1 && hit.resolved[0].exitCode === 0
            && hit.writes.copy.length === 1 && hit.writes.copy[0][0] === path.join(CACHE_DIR, sig + '.exe')
            && hit.writes.copy[0][1] === OUT_EXE, hit.writes.copy);
    add('命中即返回：写缓存那段一行都不执行（不把刚复用的东西再写回去）',
        hit.ranWriteBlock === false && hit.writes.writeFile.length === 0 && hit.writes.mkdir.length === 0, hit.logs);
    add('命中记一条 info，且不带 warn/error（正常复用别刷屏）',
        hit.logs.info.length === 1 && hit.logs.warn.length === 0 && hit.logs.error.length === 0, hit.logs);
    const hitNoDir = runCache({
        cacheExeExists: true, cacheMetaExists: true, cacheExeMtime: 5000,
        cacheMeta: { cacheVersion: 2, signature: sig }, outputDirExists: false
    });
    add('命中时输出目录不在：先 recursive 建目录再拷（调用方拿到的路径一定存在）',
        hitNoDir.writes.mkdir.length === 1 && hitNoDir.writes.mkdir[0][1] === true
            && hitNoDir.writes.copy.length === 1, hitNoDir.writes);
    const hitPosix = runCache({ cacheExeExists: true, cacheMetaExists: true, cacheExeMtime: 5000, cacheMeta: { cacheVersion: 2, signature: sig } });
    const hitWin = runCache({
        cacheExeExists: true, cacheMetaExists: true, cacheExeMtime: 5000,
        cacheMeta: { cacheVersion: 2, signature: sig }, platform: 'win32'
    });
    add('非 Windows 补回可执行位（copyFileSync 不保留权限），Windows 上不 chmod',
        hitPosix.writes.chmod.length === 1 && hitPosix.writes.chmod[0][0] === path.join(HOME, 'out', 'a_1700.exe')
            && hitPosix.writes.chmod[0][1] === 0o755 && hitWin.writes.chmod.length === 0,
        { posix: hitPosix.writes.chmod, win: hitWin.writes.chmod });
    const staleHit = runCache({
        cacheExeExists: true, cacheMetaExists: true, cacheExeMtime: 500,
        cacheMeta: { cacheVersion: 2, signature: sig }
    });
    add('缓存 exe 比源文件还旧：不算命中，正常编译并覆盖写回（不返回过期产物）',
        staleHit.hit === false && staleHit.resolved.length === 0
            && staleHit.writes.copy.length === 1 && staleHit.writes.copy[0][0] === path.join(HOME, 'out', 'a_1700.exe'),
        { copy: staleHit.writes.copy, hit: staleHit.hit });
    for (const [name, opt] of [
        ['缓存元数据不在（只有孤儿 exe）：不算命中', { cacheExeExists: true, cacheMetaExists: false }],
        ['元数据版本号不匹配（旧版缓存）：不算命中', {
            cacheExeExists: true, cacheMetaExists: true, cacheExeMtime: 5000,
            cacheMeta: { cacheVersion: 1, signature: sig }
        }],
        ['元数据签名对不上（换机器/换编译器）：不算命中', {
            cacheExeExists: true, cacheMetaExists: true, cacheExeMtime: 5000,
            cacheMeta: { cacheVersion: 2, signature: 'f'.repeat(64) }
        }]
    ]) {
        const r = runCache(opt);
        add(name, r.hit === false && r.resolved.length === 0 && r.logs.error.length === 0
            && r.writes.copy.length === 1 && r.writes.copy[0][0] === OUT_EXE
            && r.writes.copy[0][1] === path.join(CACHE_DIR, sig + '.exe'),
            { hit: r.hit, resolved: r.resolved.length, copy: r.writes.copy });
    }
    const failed = runCache({ result: { success: false }, outputExists: true });
    const noOutput = runCache({ result: { success: true }, outputExists: false });
    add('编译失败 / 产物不在：一个字节都不写进缓存（别把坏产物签成好的）',
        failed.writes.copy.length === 0 && failed.writes.writeFile.length === 0
            && noOutput.writes.copy.length === 0 && noOutput.writes.writeFile.length === 0,
        { failed: failed.writes, noOutput: noOutput.writes });
    const midChanged = runCache({ sourceChangesMidCompile: true });
    add('编译期间源文件被改了：跳过写入并 warn 一条（存进去的签名对不上下次命中不了）',
        midChanged.writes.copy.length === 0 && midChanged.writes.writeFile.length === 0
            && midChanged.logs.warn.length === 1 && midChanged.threw === null, midChanged.logs);
    const diskFull = runCache({ throwOn: 'copy' });
    const writeFail = runCache({ throwOn: 'write' });
    add('落盘失败只 warn，绝不影响编译结果（缓存是加速，不是正确性）',
        diskFull.threw === null && diskFull.logs.warn.length === 1 && diskFull.logs.error.length === 0
            && writeFail.threw === null && writeFail.logs.warn.length === 1,
        { copy: diskFull.logs, write: writeFail.logs });
    add('先落 exe 再落元数据：元数据写失败时最多留个没人认的孤儿 exe',
        miss.seq.join('>') === 'mkdir>copy>writeFile'
            && writeFail.writes.copy.length === 1 && writeFail.writes.writeFile.length === 0,
        { seq: miss.seq, writeFail: writeFail.writes });
    const broken = runCache({ missingInput: true });
    const noCompiler = runCache({ missingCompiler: true });
    add('源文件或编译器不在：不建签名记录、不外抛，安静走正常编译',
        broken.record === null && broken.threw === null && broken.resolved.length === 0
            && noCompiler.record === null && noCompiler.threw === null,
        { broken: broken.logs, noCompiler: noCompiler.logs });
    const statBoom = runCache({ cacheExeExists: true, cacheMetaExists: true, cacheExeMtime: 5000, cacheMeta: null });
    add('读缓存元数据本身炸了：降级成 warn 继续正常编译（不是 error，也不静默）',
        statBoom.threw === null && statBoom.logs.warn.length >= 1 && statBoom.hit === false, statBoom.logs);

    return rows;
})()]).then(([a, b]) => [...a, ...b]);

// ---- 对拍器清理与完成日志 ----

// 原来这里是两条字面量：`comparerSource.includes('await window.electronAPI.deleteTempFile(exe);')`
// 加一条「完成日志没被塞进 if 里」的正则否定。前者只问源码里写过这句没有：把日志删了、
// 把 exe 传成别的变量、甚至改回走 deleteFile 那条无白名单通道，它照样绿；
// 后者锁的是字形，把整段挪进 if 反而更像原样。现在抽出真方法/真回调各跑一遍。
const cleanupMethod = classMethod(comparerSource, 'cleanupCompiledExecutables');
const finishMethod = classMethod(comparerSource, 'finishCompareTask');
const completeStmt = callStatement(comparerSource, /^\s*cleanupComplete = window\.electronAPI\.onCompareComplete\(/m);
// 完成回调现在把「这一轮到底该显示哪句告警」交给 getCompletionWarningMessage，
// 那句又借 getEngineErrorMessage 的码表拼 incompleteRun 的计数。给真身而不是桩：
// 桩会让这两条断言只测到我的桩，计数漏传一个参数照样绿。
const warnMethod = classMethod(comparerSource, 'getCompletionWarningMessage');
const engineMsgMethod = classMethod(comparerSource, 'getEngineErrorMessage');
check('对拍器三段片段抽取成功（清理方法、收尾方法、完成回调注册语句）',
    cleanupMethod.length > 300 && finishMethod.length > 120 && completeStmt.length > 500,
    JSON.stringify({ cleanup: cleanupMethod.length, finish: finishMethod.length, complete: completeStmt.length }));
check('收尾告警与引擎码表两段抽取成功（抽不到下面的 warningMessage 断言就是真空通过）',
    warnMethod.length > 60 && engineMsgMethod.length > 300,
    JSON.stringify({ warn: warnMethod.length, engineMsg: engineMsgMethod.length }));

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
        getCompletionWarningMessage: compileMethod(ctx, warnMethod),
        getEngineErrorMessage: compileMethod(ctx, engineMsgMethod),
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
