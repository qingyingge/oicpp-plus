'use strict';

// upstream 1.6.0-beta1 安全批（ecdca61 / 99b520b）移植到 fork 后的行为守卫。
//
// 判定原则与既有测试一致：能跑的跑起来断言，跑不了的（Electron 事件接线）至少
// 锁住「守卫确实在调用点上」，而不是只比字符串 —— 上游那条 assertWriteAllowed
// 在 fork 里被换成了 deny-list 口径的单点收紧，光看 includes 看不出接没接上。

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const mainSource = read('src/main.js');
const preloadSource = read('src/preload.js');
const loggerSource = read('src/utils/logger.js');
const terminalSource = read('src/terminal-manager.js');

// ---------------------------------------------------------------- 日志脱敏
{
    const Logger = require('../src/utils/logger').constructor;
    check('Logger.redactString 已导出为静态方法', typeof Logger.redactString === 'function');

    const obj = Logger.stringifyArgs([{ loginToken: 'SECRET-TOKEN-1', theme: 'dark' }], { level: 'warn' });
    check('对象里的敏感键整值替换', !obj.includes('SECRET-TOKEN-1') && obj.includes('[REDACTED]'), obj);
    check('非敏感键不受影响', obj.includes('"dark"'), obj);

    const inline = Logger.stringifyArgs(['request to /api with loginToken=ABCDEF123456 done'], { level: 'warn' });
    check('裸字符串里的 key=value 形式也被抹掉', !inline.includes('ABCDEF123456'), inline);

    const bearer = Logger.stringifyArgs(['header: Bearer aaa.bbb-ccc_ddd'], { level: 'warn' });
    check('Bearer 令牌被替换', !bearer.includes('aaa.bbb-ccc_ddd') && /Bearer \[REDACTED\]/.test(bearer), bearer);

    const plain = Logger.stringifyArgs(['compiled main.cpp in 1.2s'], { level: 'warn' });
    check('普通日志原样保留', plain.includes('compiled main.cpp in 1.2s'), plain);

    // info 走的是截断分支，同样不能漏 token
    const info = Logger.stringifyArgs([{ account: { loginToken: 'XYZ789' } }], { level: 'info' });
    check('info 级别同样脱敏', !info.includes('XYZ789'), info);

    check('redactingReplacer 不再是原样返回的占位实现',
        /const redactingReplacer = \(key, value\) => \{/.test(loggerSource)
        && !/const redactingReplacer = \(_?key, value\) => value;/.test(loggerSource));
}

// ---------------------------------------------------------- terminal shell 白名单
{
    const body = /_isUsableShellCandidate\(shellPath\) \{[\s\S]*?\n    \}/.exec(terminalSource);
    check('抽取到 _isUsableShellCandidate 正文', !!body, String(body && body[0].length));
    const makeChecker = (platform, envShell) => {
        const fakePath = {
            basename: (p) => String(p).split(/[\\/]/).pop(),
            isAbsolute: (p) => p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)
        };
        const fakeFs = { accessSync: () => { }, constants: { X_OK: 1 } };
        const factory = new Function('path', 'fs', 'process',
            `const obj = { _extractExecutablePath: (v) => String(v || '').trim(), ${body[0]} };\nreturn obj;`);
        const obj = factory(fakePath, fakeFs, { platform, env: { SHELL: envShell } });
        return (p) => obj._isUsableShellCandidate(p);
    };

    const win = makeChecker('win32');
    const allowedWin = ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'cmd.exe', 'pwsh.exe', 'C:\\Program Files\\Git\\bin\\bash.exe'];
    const rejectedWin = ['C:\\Windows\\System32\\notepad.exe', 'C:\\Users\\me\\Downloads\\evil.exe', 'C:\\Windows\\explorer.exe'];
    check('win32 只放行常见 shell', allowedWin.every((p) => win(p)), JSON.stringify(allowedWin.filter((p) => !win(p))));
    check('win32 拒绝任意程序', rejectedWin.every((p) => !win(p)), JSON.stringify(rejectedWin.filter((p) => win(p))));

    const unix = makeChecker('linux');
    check('posix 只放行已知 shell 名', ['/bin/bash', '/bin/sh', '/usr/bin/zsh'].every((p) => unix(p)));
    check('posix 拒绝非 shell 可执行文件', ['/usr/bin/xxd', '/home/me/.oicpp-plus/bin/tool'].every((p) => !unix(p)));
}

// ------------------------------------------------------------ openPath 扩展名黑名单
{
    const reDecl = /const BLOCKED_OPEN_EXTENSIONS = [^;]+;/.exec(preloadSource);
    const fnDecl = /const safeOpenPath = \(targetPath\) => \{[\s\S]*?\n\};/.exec(preloadSource);
    check('preload 里有 safeOpenPath 与扩展名黑名单', !!reDecl && !!fnDecl);
    if (reDecl && fnDecl) {
        const opened = [];
        const shell = { openPath: (p) => { opened.push(p); return Promise.resolve('ok'); } };
        const safeOpenPath = new Function('shell', 'console', `${reDecl[0]}\n${fnDecl[0]}\nreturn safeOpenPath;`)(shell, console);
        const risky = ['C:\\Users\\me\\Downloads\\payload.exe', 'note.cmd', 'game.scr', 'setup.lnk', 'a.jar'];
        const fine = ['main.cpp', 'C:\\docs\\readme.txt', 'report.pdf'];
        const rejected = [];
        for (const p of risky) {
            let threw = false;
            try { const r = safeOpenPath(p); if (r && typeof r.catch === 'function') r.catch(() => { }); } catch (_) { threw = true; }
            // 允许同步抛或异步 reject：只要没落到 shell.openPath 就行
            if (!threw && opened.includes(p)) rejected.push(p);
        }
        check('可执行扩展名不会交给 shell.openPath', rejected.length === 0, JSON.stringify(rejected));
        for (const p of fine) {
            try { const r = safeOpenPath(p); if (r && typeof r.catch === 'function') r.catch(() => { }); } catch (_) { /* 不该抛 */ }
        }
        const accepted = fine.filter((p) => opened.includes(p));
        check('普通文件仍然放行', accepted.length === fine.length, JSON.stringify({ opened, fine }));
    }
}

// ------------------------------------------------------ preload removeListener 白名单
{
    const block = /const safeIpcRenderer = \{[\s\S]*?\n\};/.exec(preloadSource);
    check('抽取到 safeIpcRenderer 字面量', !!block);
    if (block) {
        const removed = [];
        const ipcRenderer = {
            send: () => { }, invoke: () => Promise.resolve(), on: () => ({}), once: () => ({}),
            removeListener: (ch) => removed.push(ch), removeAllListeners: (ch) => removed.push(ch)
        };
        const build = new Function('ipcRenderer', 'ALLOWED_SEND_CHANNELS', 'ALLOWED_INVOKE_CHANNELS',
            'ALLOWED_EVENT_CHANNELS', 'SETTINGS_MUTATING_CHANNELS', 'console',
            `return (${block[0].replace(/^const safeIpcRenderer = /, '').replace(/;$/, '')});`);
        const api = build(ipcRenderer, new Set(['a-send']), new Set(['a-invoke']), new Set(['file-saved', 'compile-result']), new Set([]), { warn: () => { } });
        api.removeListener('file-saved', () => { });
        api.removeAllListeners('compile-result');
        api.removeListener('ipc-admin-channel', () => { });
        api.removeAllListeners('settings-reset-x');
        check('白名单内事件通道照常解除', removed.includes('file-saved') && removed.includes('compile-result'), JSON.stringify(removed));
        check('白名单外通道被拦下', !removed.includes('ipc-admin-channel') && !removed.includes('settings-reset-x'), JSON.stringify(removed));
    }
}

// ------------------------------------------------ 主进程守卫：必须挂在调用点上
{
    const compileFile = /async function compileFile\(options\) \{[\s\S]*?\n    function parseArgsPreservingQuotes/.exec(mainSource);
    check('抽取到 compileFile 开头', !!compileFile);
    check('outputFile 在进 g++ -o 之前过敏感目录黑名单',
        !!compileFile && /assertSafeIoPath\(outputFile\)/.test(compileFile[0])
        && /if \(!outputFile \|\| typeof outputFile !== 'string'\)/.test(compileFile[0]),
        String(compileFile && compileFile[0].slice(-160)));

    const runExecutable = /function runExecutable\(options\) \{[\s\S]*?\n\s*function decodeBufferAuto/.exec(mainSource);
    check('runExecutable 入口即校验可执行路径',
        !!runExecutable && /assertExecutableAllowed\(executablePath\)/.test(runExecutable[0]),
        String(runExecutable && runExecutable[0].slice(0, 200)));

    const runProgramGuard = mainSource.indexOf('Shell command strings are disabled');
    check('run-program 在 shell 串拦截之后同样过一遍白名单',
        runProgramGuard > 0 && /assertExecutableAllowed\(executablePath\)/.test(mainSource.slice(runProgramGuard, runProgramGuard + 400)));

    const helper = /function assertExecutableAllowed\(targetPath\) \{[\s\S]*?\n\}/.exec(mainSource);
    check('assertExecutableAllowed 走 deny-list（空/非字符串 + 敏感目录）',
        !!helper && /typeof targetPath !== 'string'/.test(helper[0]) && /assertSafeIoPath\(path\.resolve\(targetPath\)\)/.test(helper[0]),
        String(helper && helper[0]));

    const snapshot = /function getPublicSettingsSnapshot\(\) \{[\s\S]*?\n\}/.exec(mainSource);
    check('IPC 设置快照剥掉 loginToken',
        !!snapshot && /delete safeAccount\.loginToken/.test(snapshot[0]));
    const getAll = /ipcMain\.handle\('get-all-settings'[\s\S]{0,200}?\}\);/.exec(mainSource);
    check('get-all-settings 返回的是快照而不是原始 settings',
        !!getAll && /getPublicSettingsSnapshot\(\)/.test(getAll[0]) && !/return settings;/.test(getAll[0]),
        String(getAll && getAll[0]));
    const getOne = /ipcMain\.handle\('get-settings'[\s\S]{0,200}?\}\);/.exec(mainSource);
    check('get-settings 同样返回快照', !!getOne && /getPublicSettingsSnapshot\(\)/.test(getOne[0]));

    const pending = /function resolveValidatedInstallerPath\(pending\) \{[\s\S]*?\n\}/.exec(mainSource);
    check('pendingUpdate 安装包路径限定在用户目录且文件名像安装包',
        !!pending && /isPathInsideDir\(installerPath, installerDir\)/.test(pending[0])
        && /OICPP\|OICPP-Plus/.test(pending[0]), String(pending && pending[0]));
    const armed = /function armPendingUpdateSilentInstallOnQuit\([\s\S]*?\n\}/.exec(mainSource);
    check('静默安装只能拿校验过的路径', !!armed
        && /resolveValidatedInstallerPath\(pending\)/.test(armed[0])
        && !/armInstallerLaunchOnQuit\(pending\.installerPath/.test(armed[0]));

    const walk = /ipcMain\.handle\('walk-directory'[\s\S]*?\n    \}\);/.exec(mainSource);
    check('walk-directory 钳制 maxFiles 并限制深度',
        !!walk && /Math\.min\(Number\(maxFiles\)[^)]*\)/.test(walk[0]) && /depth > 32/.test(walk[0]),
        String(walk && walk[0].slice(0, 200)));

    const buffer = /ipcMain\.handle\('read-file-buffer'[\s\S]*?\n    \}\);/.exec(mainSource);
    check('read-file-buffer 有大小上限', !!buffer && /MAX_BUFFER_BYTES/.test(buffer[0])
        && /stat\.size > MAX_BUFFER_BYTES/.test(buffer[0]));

    const zip = /ipcMain\.handle\('read-zip-text-files'[\s\S]*?\n    \}\);/.exec(mainSource);
    check('压缩包读取有条目数 / 单条目 / 总量三重上限',
        !!zip && ['MAX_ENTRIES', 'MAX_ENTRY_BYTES', 'MAX_TOTAL_BYTES'].every((k) => (zip[0] || '').includes(k)));

    // Electron 事件接线跑不起来，锁「挂在了主窗口 webContents 上」
    const createWindow = /function createWindow\(\) \{[\s\S]*?\n\}\n/.exec(mainSource);
    check('主窗口挂了 permission / webview / 导航三类守卫',
        !!createWindow && ['setPermissionRequestHandler', 'will-attach-webview', 'will-navigate', 'will-redirect']
            .every((k) => (createWindow[0] || '').includes(k)), String(createWindow && createWindow[0].length));
    check('内置浏览器的 data: 新标签页没有被 webview 守卫误杀',
        !!createWindow && /parsed\.protocol === 'data:'/.test(createWindow[0]));
    check('X-Frame-Options 剥离按 fork 决定保留（不移植 upstream 的撤销）',
        !!createWindow && (createWindow[0] || '').includes("delete headers['X-Frame-Options']"));
}

// -------------------------------------------- 安装包文件名校验容得下预发布后缀（#512）
{
    const literal = /const looksLikeInstaller = (\/.+\/i)\.test\(base\)/.exec(mainSource);
    check('抽到安装包名判定正则', !!literal, String(literal && literal[1]));
    if (literal) {
        const re = new Function(`return ${literal[1]};`)();
        const accepted = [
            'OICPP-1.5.4-Setup.exe',
            'OICPP-Plus-1.6.0-beta1-plus1-Setup.exe',   // fork 当前版本号，拒了就永远静默不装
            'OICPP-1.6.0-Setup.deb',
            'oicpp-plus-1.6.0-beta1-Setup.zip'
        ];
        const rejected = ['OICPP-1.5-Setup.exe', 'OICPP-Plus-tool.exe', 'OICPP-1.6.0-Setup-evil.exe', 'calc.exe'];
        check('正式与预发布版本号都认', accepted.every((n) => re.test(n)),
            JSON.stringify(accepted.filter((n) => !re.test(n))));
        check('不像安装包的名称仍然拒（路径在用户目录里也不给执行）',
            rejected.every((n) => !re.test(n)), JSON.stringify(rejected.filter((n) => re.test(n))));
        const cleanupPattern = /const installerPattern = (\/.+\/i);/.exec(mainSource);
        check('清理旧安装包用的是同一条正则（否则清不掉 beta 包，越攒越大）',
            !!cleanupPattern && new Function(`return ${cleanupPattern[1]};`)().test('OICPP-Plus-1.6.0-beta1-plus1-Setup.exe'),
            String(cleanupPattern && cleanupPattern[1]));
    }
}

// ---------------------------------- 设置广播一律发剥了凭据的快照（#534）
{
    const rawBroadcasts = (mainSource.match(/send\('settings-[a-z-]+', (?:null, )?settings[,)]/g) || []);
    check('没有任何 settings-* 广播直接发原始 settings', rawBroadcasts.length === 0, JSON.stringify(rawBroadcasts));
    const snapshotSites = (mainSource.match(/send\('settings-[a-z-]+', (?:null, )?getPublicSettingsSnapshot\(\)/g) || []).length;
    check('settings-loaded / changed / applied / imported / reset 都走快照', snapshotSites >= 12, String(snapshotSites));
    check('导入/重置的返回值也发快照',
        (mainSource.match(/return \{ success: true, settings: getPublicSettingsSnapshot\(\) \}/g) || []).length === 2,
        String((mainSource.match(/return \{ success: true, settings:/g) || []).length));
}

// ------------------------------------------------ 日志脱敏覆盖 Error 与散文写法（#541）
{
    const Logger = require('../src/utils/logger').constructor;
    const err = new Error('request failed: Authorization: Bearer aaa.bbb-ccc_ddd');
    err.stack = 'Error: token=SEKRITVALUE at foo.js:1:1';
    err.code = 'ETIMEDOUT for api_key=KEYINSIDE';
    err.data = { loginToken: 'IN DATA', note: 'cookie=COOKIEVALUE here' };
    err.cause = 'nested failure with password=hunter2';
    const out = Logger.stringifyArgs([err], { level: 'warn' });
    for (const secret of ['aaa.bbb-ccc_ddd', 'SEKRITVALUE', 'KEYINSIDE', 'IN DATA', 'COOKIEVALUE', 'hunter2']) {
        check(`Error 的 message/stack/code/data/cause 都不漏 ${secret}`, !out.includes(secret), out.slice(0, 120));
    }

    const prose = Logger.stringifyArgs(['login token is abc123def, done'], { level: 'warn' });
    check('散文写法 token is xxx 也抹', !prose.includes('abc123def'), prose);
    const quoted = Logger.stringifyArgs(['{"password": "hello world"}'], { level: 'warn' });
    check('带空格的引号值整段吃掉（只截第一个词会漏后半段）', !quoted.includes('hello world'), quoted);
    const unaffected = Logger.stringifyArgs(['compiled main.cpp in 1.2s'], { level: 'warn' });
    check('普通日志不受影响', unaffected.includes('compiled main.cpp in 1.2s'), unaffected);
}

// ------------------------------------------ webview 的 data: 只放行受控欢迎页
{
    const guard = /const isInternalDataPage = parsed\.protocol === 'data:'[\s\S]*?src\.length <= 1024 \* 1024;/.exec(mainSource);
    check('webview 守卫里 data: 收窄到 data:text/html + 大小上限', !!guard, String(guard && guard[0].length));
    if (guard) {
        const predicate = new Function('URL', `return function (src) {
            const parsed = new URL(src);
            ${guard[0]}
            return isInternalDataPage;
        };`)(URL);
        check('内置新标签页那种 data:text/html;charset=utf-8,... 仍然放行',
            predicate('data:text/html;charset=utf-8,' + encodeURIComponent('<html></html>')) === true);
        check('data:text/javascript 不算欢迎页',
            predicate('data:text/javascript,alert(1)') === false);
        check('超过 1MB 的 data: 一律拒',
            predicate('data:text/html;charset=utf-8,' + 'x'.repeat(1024 * 1024 + 10)) === false);
    }
}

// ------------------------------------------------------- 独立文档必须有 CSP meta
{
    const docs = [
        'src/renderer/index.html',
        'src/renderer/pdf-viewer.html',
        'src/renderer/settings/backup.html',
        'src/renderer/settings/compiler.html',
        'src/renderer/settings/editor.html',
        'src/renderer/settings/templates.html'
    ];
    for (const doc of docs) {
        const html = read(doc);
        const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/i.exec(html);
        check(`${doc} 有 CSP meta`, !!meta, String(meta && meta[1].slice(0, 40)));
        if (!meta) continue;
        const csp = meta[1];
        check(`${doc} 锁死 object-src / base-uri / form-action`,
            /object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp) && /form-action 'none'/.test(csp), csp);
    }
    const indexCsp = (/Content-Security-Policy" content="([^"]*)"/i.exec(read('src/renderer/index.html')) || ['', ''])[1];
    // 主窗口不能跟着 upstream 把 frame-src 收成 none：PDF 预览与内置浏览器都在 iframe 里。
    // 上游 1.6.0-beta1 就是这么把 PDF 整块废掉再补的（#544）；本 fork 的 iframe 是
    // file:// 文档，'self' 在这台 Electron 上实测也能放行，但 file: 一并列出与上游一致、
    // 不依赖那个匹配差异。
    check('主窗口 frame-src 保留 self 且不用 none（PDF iframe / 内置浏览器）',
        indexCsp.includes("frame-src 'self'") && !indexCsp.includes("frame-src 'none'"), indexCsp);
    check('主窗口 frame-src 显式列出 file: 与 data:',
        /frame-src 'self' data: file:;/.test(indexCsp) || /frame-src 'self' file: data:;/.test(indexCsp), indexCsp);
}

// ------------------------------------------------------ 语言包：新增键双语齐备
{
    const zh = JSON.parse(read('src/lang/zh-cn.json'));
    const en = JSON.parse(read('src/lang/en.json'));
    const keys = ['error.fileTooLargeToRead', 'error.zipTooManyEntries', 'error.zipTextTooLarge'];
    const pick = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    for (const key of keys) {
        const hasZh = typeof pick(zh, key) === 'string';
        const hasEn = typeof pick(en, key) === 'string';
        check(`${key} 双语都在包内`, hasZh && hasEn, JSON.stringify({ hasZh, hasEn }));
        const tokens = (s) => (String(s).match(/\{[a-zA-Z_]+\}/g) || []).sort().join(',');
        check(`${key} 占位符一一对应`, hasZh && hasEn && tokens(pick(zh, key)) === tokens(pick(en, key)));
        check(`${key} 在源码里真有引用`, mainSource.includes(`t('${key}'`));
    }
}

console.log(`\nupstream 1.6.0-beta1 安全移植 tests completed: ${failures === 0 ? 'all checks passed' : failures + ' FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
