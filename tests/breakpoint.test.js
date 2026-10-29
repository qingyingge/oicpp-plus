'use strict';

// 断点取消链路回归。
//
// 历史故障是「取消断点后实际上没有取消」，由四个独立缺陷叠加而成：
//   1. 渲染层 sendIPC 的守卫读 window.app?.isDebugging，而 window.app 从未赋值
//      （全局是 window.oicppApp），send 恒为空函数；
//   2. 即便修好守卫，require('electron') 拿到的是 preload 的白名单版
//      ipcRenderer，debug-add-breakpoint / debug-remove-breakpoint 不在
//      ALLOWED_SEND_CHANNELS 里，send 被静默丢弃；
//   3. 主进程 removeBreakpoint 用 bp.file === breakpoint.file 严格相等匹配，
//      GDB 侧 file 经 _normalizePath 处理过，win32 短名/大小写/分隔符不一致
//      就匹配不上；
//   4. 匹配失败时仍无条件 breakpoints.delete + return {success:true}，
//      渲染层据此认为取消成功，GDB 端断点还在。
//
// 下面分别对这几层设断言。findBreakpointEntry 直接从 main.js 源码抽取后执行，
// 测的是被测实现本身，不是测试里的副本。

const fs = require('fs');
const path = require('path');
const { samePath } = require('../src/utils/path-identity');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

// 统一成 LF 再做源码断言：本仓库是 CRLF，否则每个跨行的正则都要写成 \r?\n
// 文件缺失按空内容处理（compile-output.js 已在 ts-migration 里退役，守卫对它退化为恒真）。
const read = (rel) => {
    try {
        return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
    } catch (_) {
        return '';
    }
};

const mainSource = read('src/main.js');
const preloadSource = read('src/preload.js');
const rendererSource = read('src/renderer/js/monaco-editor-manager.js');
const gdbSource = read('src/gdb-mi-debugger.js');

// ---------------------------------------------------------------- 路径身份

const winLike = process.platform === 'win32';
check('samePath rejects unrelated paths', !samePath('/a/main.cpp', '/b/main.cpp'));
check('samePath rejects empty input', !samePath('', '/a/main.cpp') && !samePath('/a/main.cpp', null));
if (winLike) {
    check('samePath folds case on win32', samePath('C:\\Foo\\Bar.cpp', 'c:\\foo\\bar.cpp'));
    check('samePath folds separators on win32', samePath('C:\\Foo\\Bar.cpp', 'C:/Foo/Bar.cpp'));
} else {
    check('samePath folds case only on win32', !samePath('/A/main.cpp', '/a/main.cpp'));
}

const here = __filename;
check('samePath accepts the same file written two ways',
    samePath(here, path.join(__dirname, 'breakpoint.test.js')));
check('samePath resolves symlinked temp dirs',
    samePath(here, fs.realpathSync.native(here)));

// ------------------------------------------- findBreakpointEntry（从源码抽取）

const fnMatch = /function findBreakpointEntry\(file, line\) \{[\s\S]*?\n\}/.exec(mainSource);
check('main.js exposes findBreakpointEntry', !!fnMatch);

if (fnMatch) {
    const samePathShim = samePath;
    // eslint-disable-next-line no-new-func
    const factory = new Function('samePath', `
        let breakpoints = new Map();
        return {
            setBreakpoints: (entries) => {
                breakpoints = new Map(entries.map(e => [e.key, e]));
            },
            clear: () => breakpoints.clear(),
            find: ${fnMatch[0]}
        };
    `);
    const store = factory(samePathShim);

    const key = `${here}:42`;
    store.setBreakpoints([
        { key, file: here, line: 42, number: 7, enabled: true },
        { key: `${here}:100`, file: here, line: 100, number: 8, enabled: true }
    ]);

    const exact = store.find(here, 42);
    check('exact file+line hit', exact && exact.key === key && exact.entry.number === 7);

    check('missing line returns null instead of a wrong entry', store.find(here, 999) === null);

    // GDB 把断点吸附到最近语句时会差一行，±1 必须能命中
    const offByOne = store.find(here, 43);
    check('line within +/-1 still matches', offByOne && offByOne.key === key);
    check('line 2 away does not match', store.find(here, 44) === null);

    // 路径写法不同但同一个文件必须命中（win32 大小写/分隔符，posix 相对路径）
    const spelled = store.find(path.join(__dirname, '.', 'breakpoint.test.js'), 42);
    check('differently spelled path matches', spelled && spelled.key === key);

    const nearMiss = store.find(here.replace(/breakpoint\.test\.js$/, 'breakpointXtest.js'), 42);
    check('similar filename is not confused for the breakpoint', nearMiss === null);

    store.clear();
    check('clearing the map drops every entry', store.find(here, 42) === null);
}

// ---------------------------------------------------------- 记账与失败语义

const addFn = /async function addBreakpoint\(breakpoint\) \{[\s\S]*?\n\}/.exec(mainSource);
const removeFn = /async function removeBreakpoint\(breakpoint\) \{[\s\S]*?\n\}/.exec(mainSource);
check('addBreakpoint is defined', !!addFn);
check('removeBreakpoint is defined', !!removeFn);

if (addFn && removeFn) {
    check('addBreakpoint keeps the authoritative GDB breakpoint number',
        /const bp = await gdbDebugger\.setBreakpoint/.test(addFn[0]) && /number: bp\.number/.test(addFn[0]));

    check('addBreakpoint records GDB-normalised file and line, not the caller request',
        /file: bp\.file/.test(addFn[0]) && /line: bp\.line/.test(addFn[0])
        && !/file: breakpoint\.file/.test(addFn[0]));

    check('removeBreakpoint matches by path identity, not string equality',
        /findBreakpointEntry\(breakpoint\.file, breakpoint\.line\)/.test(removeFn[0])
        && !/bp\.file === breakpoint\.file/.test(removeFn[0]));

    check('removeBreakpoint refuses to report success when the breakpoint is unknown',
        /if \(!found\) \{[\s\S]*?throw new Error\(t\('error\.breakpointNotFound'/.test(removeFn[0]));

    check('removeBreakpoint deletes from the map only after GDB confirmed',
        /await gdbDebugger\.removeBreakpoint\(breakpointNumber\);\s*\n\s*breakpoints\.delete\(key\);/.test(removeFn[0]));

    check('removeBreakpoint always returns a number back to the renderer',
        /return \{ success: true, file: entry\.file, line: entry\.line, number: breakpointNumber \}/.test(removeFn[0]));
}

// ------------------------------------------------- 启动设点与会话结束清理

check('session start registers initial breakpoints through addBreakpoint',
    /for \(const breakpoint of options\.breakpoints\)[\s\S]{0,600}?await addBreakpoint\(target\)/.test(mainSource));
check('session start no longer calls setBreakpoint directly',
    !/await gdbDebugger\.setBreakpoint\(filePath,/.test(mainSource));
check('session stop clears the breakpoint map',
    /autoSkipInternalCounter = 0;\s*\n\s*breakpoints\.clear\(\);/.test(mainSource));
check('debugger exit clears the breakpoint map',
    /gdbDebugger\.on\('exited'[\s\S]{0,400}?breakpoints\.clear\(\);/.test(mainSource));

// -------------------------------------------------------------- IPC 通道

check('debug-set-breakpoint is registered as invoke/handle',
    /ipcMain\.handle\('debug-set-breakpoint'/.test(mainSource));
check('debug-remove-breakpoint is registered as invoke/handle',
    /ipcMain\.handle\('debug-remove-breakpoint'/.test(mainSource));
check('the fire-and-forget debug-add-breakpoint channel is gone',
    !/ipcMain\.on\('debug-add-breakpoint'/.test(mainSource)
    && !/ipcRenderer\.send\('debug-add-breakpoint'/.test(rendererSource));
const allowlistBody = (name) => {
    const m = new RegExp(`${name}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(preloadSource);
    return m ? m[1] : '';
};
const invokeAllowlist = allowlistBody('ALLOWED_INVOKE_CHANNELS');
const eventAllowlist = allowlistBody('ALLOWED_EVENT_CHANNELS');

check('both breakpoint channels are in the preload invoke allowlist',
    /'debug-set-breakpoint'/.test(invokeAllowlist) && /'debug-remove-breakpoint'/.test(invokeAllowlist));
check('debug-breakpoint-set/removed are in the preload event allowlist',
    /'debug-breakpoint-set'/.test(eventAllowlist) && /'debug-breakpoint-removed'/.test(eventAllowlist));
const sendAllowlist = /ALLOWED_SEND_CHANNELS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(preloadSource);
check('breakpoint channels are not in the send allowlist',
    !!sendAllowlist && !/'debug-(?:set|remove|add)-breakpoint'/.test(sendAllowlist[1]));

// --------------------------------------------------------------- 渲染层

const toggleBody = /const toggleAt = async \(line\) => \{[\s\S]*?\n {8}\};\n/.exec(rendererSource);
check('toggleAt is async and awaits main', !!toggleBody);
if (toggleBody) {
    const body = toggleBody[0];
    check('toggleAt no longer gates on the never-assigned window.app',
        !/window\.app\b/.test(body));
    check('toggleAt reads the real app singleton',
        /window\.oicppApp\?\.isDebugging/.test(body));
    check('toggleAt goes through invoke so it can await a receipt',
        /ipcRenderer\.invoke\('debug-remove-breakpoint'/.test(body)
        && /ipcRenderer\.invoke\('debug-set-breakpoint'/.test(body));
    check('toggleAt only mutates decorations after success:true',
        /if \(result && result\.success\)\s+removeDeco\(idx\)/.test(body)
        && /if \(result && result\.success\)\s+addDeco\(line\)/.test(body));
}

// 只查代码，注释里提到这个历史名字不算残留引用
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const liveWindowApp = (rel) => /window\.app\b/.test(stripComments(read(rel)));
// compile-output.js 已随 ts-migration 退役（不存在），对它的守卫恒真，不再列入
check('renderer no longer references window.app in code',
    !liveWindowApp('src/renderer/js/tabs.js')
    && !liveWindowApp('src/renderer/js/sidebar/debugPanel.js')
    && !liveWindowApp('src/renderer/js/monaco-editor-manager.js'));

// --------------------------------------------------------------- GDB 层

check('_normalizePath no longer skips non-win32 platforms',
    !/if \(process\.platform !== 'win32'\) return filePath;/.test(gdbSource));
check('_normalizePath falls back to path.resolve when realpath fails',
    /catch \(_\) \{\s*\n\s*return path(?:_1\.default)?\.resolve\(filePath\);/.test(gdbSource));
check('GDB exposes a breakpoint snapshot for cross-checking',
    gdbSource.includes('getBreakpoints()'));

// --------------------------------------------------------------- i18n

const zh = JSON.parse(read('src/lang/zh-cn.json'));
const en = JSON.parse(read('src/lang/en.json'));
check('error.breakpointNotFound exists in both languages',
    !!zh.error?.breakpointNotFound && !!en.error?.breakpointNotFound);
check('error.breakpointNotFound carries file and line placeholders',
    /\{file\}/.test(zh.error.breakpointNotFound) && /\{line\}/.test(zh.error.breakpointNotFound)
    && /\{file\}/.test(en.error.breakpointNotFound) && /\{line\}/.test(en.error.breakpointNotFound));
check('en.json breakpointNotFound has no CJK', !/[\u4e00-\u9fff]/.test(en.error.breakpointNotFound));

if (failures) {
    console.error(`\n${failures} assertion(s) failed`);
    process.exit(1);
}
