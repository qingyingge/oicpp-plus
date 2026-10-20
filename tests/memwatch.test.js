'use strict';

// memwatch 契约回归。背景：mywwzh/oicpp#368 报「样例测试器占用内存显示 0.0MB」，
// 根因是旧实现每 500ms spawn 一次 tasklist 采瞬时工作集，短命进程整个生命周期
// 都在两次采样之间，峰值永远采不到。memwatch 改为附着到目标进程读取内核维护的
// PeakWorkingSetSize 高水位值。
//
// 这里锁定的是「不要退回旧采样」的结构性约束 + 上报协议的解析口径；
// 真正的 Win32 行为由 src/utils/memwatch-source.js 的源码在目标平台上验证。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const mainSource = read('src', 'main.js');
const memwatchSourceModule = require(path.join(__dirname, '..', 'src', 'utils', 'memwatch-source.js'));

// ---------------------------------------------------------------- 内嵌源码

check('memwatch source is a non-empty C++ string', typeof memwatchSourceModule === 'string' && memwatchSourceModule.length > 500,
    `len=${String(memwatchSourceModule).length}`);
check('memwatch reads PeakWorkingSetSize (kernel high-water mark, immune to sampling races)',
    memwatchSourceModule.includes('PeakWorkingSetSize'));
check('memwatch reads PrivateUsage so commit-style usage is covered too',
    memwatchSourceModule.includes('PrivateUsage'));
check('memwatch takes max(peak, private) as the measured value, matching the LemonLime metric',
    /currentPeak\s*>\s*currentPrivate\s*\?/.test(memwatchSourceModule));
check('memwatch resolves GetProcessMemoryInfo dynamically like consolepauser does',
    memwatchSourceModule.includes('GetProcAddress') && memwatchSourceModule.includes('psapi.dll'));
check('memwatch attaches to an existing pid instead of creating the process (no stdio relay)',
    memwatchSourceModule.includes('OpenProcess') && !memwatchSourceModule.includes('CreateProcess'));
check('memwatch opens with the rights it needs and no more',
    memwatchSourceModule.includes('PROCESS_QUERY_LIMITED_INFORMATION') &&
    memwatchSourceModule.includes('PROCESS_TERMINATE') &&
    memwatchSourceModule.includes('SYNCHRONIZE'));
check('memwatch terminates the target when the limit is exceeded',
    memwatchSourceModule.includes('TerminateProcess'));
check('memwatch re-reads counters after exit while the handle is still held',
    /finalPeak/.test(memwatchSourceModule));
check('memwatch reports an explicit attach failure instead of a silent zero',
    memwatchSourceModule.includes('attach-failed'));

// 源码里不能出现非 ASCII：它要按 utf8/gbk 两种编码落盘再交给 g++，
// 非 ASCII 注释会让 GBK 策略下的编译结果依赖编译器 locale。
const nonAscii = memwatchSourceModule.split('').filter((ch) => ch.charCodeAt(0) > 127);
check('memwatch source stays pure ASCII (it is compiled from utf8 and gbk rewrites)',
    nonAscii.length === 0, `non-ascii chars=${nonAscii.length}`);

// ---------------------------------------------------------------- 主进程接线

check('main.js requires the memwatch source module',
    mainSource.includes("require('./utils/memwatch-source')"));
check('memwatch is built through the shared helper pipeline, not a private copy',
    mainSource.includes('ensureHelperExecutable') &&
    mainSource.includes("label: 'MemWatch'") &&
    mainSource.includes("sourceFileName: 'memwatch.cpp'"));
check('consolepauser was refactored onto the same pipeline',
    mainSource.includes("label: 'ConsolePauser'") &&
    mainSource.includes('ensureConsolePauserExecutable(compilerPath)'));
check('memwatch source fingerprint drives rebuilds',
    mainSource.includes('getHelperSourceFingerprint') &&
    mainSource.includes('getHelperFingerprintPath'));
check('memwatch is warmed up after first paint, not on the critical path',
    /setTimeout\(\(\) => \{\s*warmUpMemWatch\(\)/.test(mainSource));
check('memwatch is killed when the last window closes',
    /window-all-closed[\s\S]{0,200}killAllMemWatch\(\)/.test(mainSource));

check('run-program attaches memwatch to the spawned pid',
    /startMemWatch\(childProcess\.pid,\s*memoryLimitBytes\)/.test(mainSource));
check('run-program skips tasklist polling while memwatch is attached',
    /if \(memWatchHandle\) \{[\s\S]{0,200}return;/.test(mainSource));
check('run-program resolves the memwatch report inside the close handler',
    /childProcess\.on\('close',[\s\S]{0,600}resolveMemWatchReport\(memWatchHandle\)/.test(mainSource));
check('memwatch MLE verdict is recorded without inferring it from the exit code',
    /memWatchReport\.exceeded && !memoryLimitExceeded/.test(mainSource));
check('a memwatch MLE clears the timeout flag so TLE is not reported alongside',
    /memWatchReport\.exceeded && !memoryLimitExceeded[\s\S]{0,200}timeout = false;/.test(mainSource));

check('the interactive path watches the contestant and the grader separately',
    mainSource.includes('contestantMemWatch = startMemWatch(contestant.pid, memoryLimitBytes)') &&
    mainSource.includes('graderMemWatch = startMemWatch(grader.pid, 0)'));
check('only the contestant is subject to the memory limit, not the grader',
    mainSource.includes('startMemWatch(grader.pid, 0)'));
check('the interactive path stops polling tasklist when memwatch is attached',
    /if \(!contestantMemWatch && !graderMemWatch\) \{/.test(mainSource));

// ---------------------------------------------------------------- 上报协议解析

const parseContext = {
    module: { exports: {} },
    require
};
const parseSource = mainSource.slice(
    mainSource.indexOf('function parseMemWatchReport('),
    mainSource.indexOf('function startMemWatch(')
);
vm.runInNewContext(`${parseSource}\nthis.parseMemWatchReport = parseMemWatchReport;`, parseContext);
const parseMemWatchReport = parseContext.parseMemWatchReport;

const parsed = parseMemWatchReport('125116416 77824 1 1');
check('a well-formed report yields byte counts and the exceeded flag',
    parsed && parsed.peakBytes === 125116416 && parsed.privateBytes === 77824 && parsed.exceeded === true,
    JSON.stringify(parsed));

const parsedOk = parseMemWatchReport('125116416 77824 0 1\n');
check('trailing newline is tolerated',
    parsedOk && parsedOk.peakBytes === 125116416 && parsedOk.exceeded === false);

check('attach failure parses to null rather than a misleading 0',
    parseMemWatchReport('attach-failed 87') === null);
check('a failed read (ok=0) parses to null so callers keep the fallback path',
    parseMemWatchReport('0 0 0 0') === null);
check('empty and garbage output parse to null',
    parseMemWatchReport('') === null &&
    parseMemWatchReport('   ') === null &&
    parseMemWatchReport('not a report') === null &&
    parseMemWatchReport(undefined) === null);

// ---------------------------------------------------------------- 兜底与限额

check('tasklist sampling is retained as the fallback when memwatch is missing',
    mainSource.includes('readMemoryBytes') && mainSource.includes("spawn('tasklist'"));
check('the fallback polling interval constants are still defined',
    mainSource.includes('MEMORY_SAMPLE_INTERVAL_MS_WITH_LIMIT') &&
    mainSource.includes('MEMORY_SAMPLE_INTERVAL_MS_PLAIN'));
check('the memwatch report wait is bounded so close cannot hang',
    mainSource.includes('MEMWATCH_REPORT_TIMEOUT_MS'));
check('i18n keys exist for both memwatch build failures',
    read('src', 'lang', 'zh-cn.json').includes('memWatchBuildFailed') &&
    read('src', 'lang', 'en.json').includes('memWatchBuildFailed') &&
    read('src', 'lang', 'zh-cn.json').includes('memWatchNoCompiler') &&
    read('src', 'lang', 'en.json').includes('memWatchNoCompiler'));

console.log(`memwatch regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
