'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const comparerSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'sidebar', 'codeComparer.js'), 'utf8');

// ---- Bug A: delete-temp-file 白名单 ----

// 把 main.js 里真实的包含关系判定逻辑抽出来跑，验证白名单与 path.relative 实现
const helperStart = mainSource.indexOf('const TEMP_DELETE_ROOTS = [');
const helperEnd = mainSource.indexOf("ipcMain.handle('delete-temp-file'");
check('main process declares a delete whitelist for temp roots', helperStart !== -1 && helperEnd > helperStart);

let isPathInsideTempRoots = null;
try {
    const snippet = mainSource.slice(helperStart, helperEnd);
    const context = vm.createContext({ os, path, USER_DATA_DIR_NAME: '.oicpp-plus' });
    vm.runInContext(`${snippet}\nthis.check = isPathInsideTempRoots; this.roots = TEMP_DELETE_ROOTS;`, context);
    isPathInsideTempRoots = context.check;
} catch (error) {
    check('whitelist helper can be evaluated standalone', false, error.message);
}

if (isPathInsideTempRoots) {
    const codeTemp = path.join(os.homedir(), '.oicpp-plus', 'codeTemp');
    const compare = path.join(os.homedir(), '.oicpp-plus', 'compare');
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
}

const deleteHandler = mainSource.slice(
    mainSource.indexOf("ipcMain.handle('delete-temp-file'"),
    mainSource.indexOf("ipcMain.handle('save-file'")
);
check('delete-temp-file no longer uses a startsWith whitelist', !deleteHandler.includes('.startsWith('));
check('delete-temp-file still logs missing files at info level', deleteHandler.includes("logInfo('临时文件不存在，无需删除:'"));
check('delete-temp-file still logs failures at error level', deleteHandler.includes("logError('删除临时文件失败:'"));

// ---- Bug B/D: 编译缓存按签名命名并交出产物 ----

const cacheBlock = mainSource.slice(
    mainSource.indexOf('const compileCacheVersion'),
    mainSource.indexOf('const args = [', mainSource.indexOf('const compileCacheVersion'))
);
check('compile cache uses a dedicated cache dir', mainSource.includes("path.join(os.homedir(), USER_DATA_DIR_NAME, 'compile-cache')"));
check('cache record no longer requires outputFile', /const createCompileCacheRecord = \(\) => \{\s*if \(!inputFile \|\| !compilerPath\) return null;/.test(cacheBlock));
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

process.exit(failures > 0 ? 1 : 0);
