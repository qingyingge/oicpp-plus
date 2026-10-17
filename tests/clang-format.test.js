'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const {
    buildClangFormatArgs,
    formatCodeWithClangFormat,
    serializeClangFormatStyle
} = require('../src/clang-format-service');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

class FakeChildProcess extends EventEmitter {
    constructor({ stdout = '', stderr = '', code = 0 } = {}) {
        super();
        this.stdout = new EventEmitter();
        this.stderr = new EventEmitter();
        this.stdin = new EventEmitter();
        this.killed = false;
        this.stdin.end = (input) => {
            this.input = input;
            setImmediate(() => {
                if (stdout) this.stdout.emit('data', Buffer.from(stdout));
                if (stderr) this.stderr.emit('data', Buffer.from(stderr));
                this.emit('close', code);
            });
        };
    }

    kill() {
        this.killed = true;
    }
}

(async () => {
    const userStyle = {
        BasedOnStyle: 'Google',
        IndentWidth: 2,
        UseTab: 'Never'
    };
    const args = buildClangFormatArgs({
        filePath: 'D:/project/main.cpp',
        style: userStyle,
        fallbackStyle: 'LLVM'
    });
    check('clang-format assumes the edited filename', args[0] === '--assume-filename=D:/project/main.cpp');
    check('user style is passed as the highest-priority style argument', args[1] === `--style=${JSON.stringify(userStyle)}`);
    check('explicit user style does not fall back to a style file', !args.some((arg) => arg.startsWith('--fallback-style=')));

    const fileArgs = buildClangFormatArgs({ filePath: '/tmp/main.cpp' });
    check('missing style uses the project .clang-format', fileArgs.includes('--style=file'));
    check('project style has a deterministic fallback', fileArgs.includes('--fallback-style=LLVM'));
    check('preset style is normalized', serializeClangFormatStyle('google') === 'Google');

    let captured = null;
    const formatted = await formatCodeWithClangFormat({
        executablePath: '/fake/clang-format',
        content: 'int  main( ){return 0;}',
        filePath: '/tmp/main.cpp',
        style: userStyle,
        spawnImpl: (executablePath, spawnArgs, options) => {
            captured = { executablePath, args: spawnArgs, options };
            const child = new FakeChildProcess({ stdout: 'int main() { return 0; }\n' });
            const end = child.stdin.end;
            child.stdin.end = (input) => {
                captured.input = input;
                end(input);
            };
            return child;
        }
    });
    check('standalone clang-format receives source through stdin', captured && Buffer.from(captured.input || '').toString('utf8').includes('int  main'));
    check('standalone clang-format is executed without a shell', captured?.options?.shell === false);
    check('standalone clang-format output is returned unchanged', formatted.content === 'int main() { return 0; }\n');

    let rangeCapture = null;
    await formatCodeWithClangFormat({
        executablePath: '/fake/clang-format',
        content: 'int main() {\n  return 0;\n}\n',
        filePath: 'D:/project/main.cpp',
        style: userStyle,
        styleRaw: 'BasedOnStyle: Google\nIndentWidth: 2\n',
        startLine: 2,
        endLine: 3,
        spawnImpl: (executablePath, args, options) => {
            rangeCapture = { executablePath, args, options };
            return new FakeChildProcess({ stdout: 'int main() {\n  return 0;\n}\n' });
        }
    });
    const rawStyleArg = rangeCapture?.args?.find((arg) => arg.startsWith('--style=file:'));
    const rangeInputPath = rangeCapture?.args?.at(-1);
    check('raw user configuration is passed through an explicit style file', !!rawStyleArg && rawStyleArg !== `--style=file:${rangeInputPath}`);
    check('range formatting uses standalone clang-format line ranges', rangeCapture?.args?.includes('--lines=2:3'));
    check('temporary style and source files are removed after formatting', !fs.existsSync(rawStyleArg?.slice('--style=file:'.length) || '') && !fs.existsSync(rangeInputPath || ''));

    let rejected = null;
    try {
        await formatCodeWithClangFormat({
            executablePath: '/fake/clang-format',
            content: 'invalid',
            style: userStyle,
            spawnImpl: () => new FakeChildProcess({ stderr: 'parse error', code: 1 })
        });
    } catch (error) {
        rejected = error;
    }
    check('clang-format failures preserve diagnostics', /parse error/.test(rejected?.message || ''));

    const root = path.resolve(__dirname, '..');
    const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'monaco-editor-manager.js'), 'utf8');

    // 这两条原来是 includes() 读源码长相：
    //   'window.electronAPI.formatCppCode(request)'  —— 点号↔方括号改写会静默失配
    //   'styleRaw: this.clangFormatRaw'              —— 属性写法一变就失配
    // 改成真调 requestClangFormattedCode，直接看它把什么样的请求交给了桥。
    function toFn(src) {
        if (!src) return undefined;
        const s = src.replace(/^\s+/, '');
        const isAsync = /^async\s+/.test(s);
        return new Function('return (' + (isAsync ? 'async function ' : 'function ') +
            s.replace(/^async\s+/, '') + ')')();
    }
    function classMethod(name) {
        const m = new RegExp('^\\s{4}(?:async\\s+)?' + name + '\\s*\\(', 'm').exec(rendererSource);
        if (!m) return '';
        let i = rendererSource.indexOf('(', m.index), p = 0;
        for (; i < rendererSource.length; i++) {
            if (rendererSource[i] === '(') p++;
            else if (rendererSource[i] === ')') { p--; if (p === 0) break; }
        }
        let d = 0;
        for (i = rendererSource.indexOf('{', i); i < rendererSource.length; i++) {
            if (rendererSource[i] === '{') d++;
            else if (rendererSource[i] === '}') { d--; if (d === 0) return rendererSource.slice(m.index, i + 1); }
        }
        return '';
    }
    const bridgeSrc = classMethod('requestClangFormattedCode');
    check('方法体抽取成功: requestClangFormattedCode', bridgeSrc.length > 0);

    const RAW_STYLE = '{ BasedOnStyle:  LLVM,  IndentWidth: 7 }';  // 双空格+乱序，正是 lossy 解析会吃掉的东西
    function makeBridge({ noBridge = false, reply, onRequest } = {}) {
        const seen = { calls: 0, requests: [] };
        const state = { version: 3, disposed: false };
        const manager = {
            clangFormatStyle: 'Google',
            clangFormatRaw: RAW_STYLE,
            getClangFormatModelPath: () => 'D:/proj/a.cpp',
            normalizeClangFormatStyle: (s) => 'normalized:' + s,
            requestClangFormattedCode: toFn(bridgeSrc)
        };
        const model = {
            getValue: () => 'int  main( )  { }',
            isDisposed: () => state.disposed,
            getVersionId: () => state.version
        };
        global.window = noBridge ? {} : {
            electronAPI: {
                formatCppCode: async (req) => {
                    seen.calls++;
                    seen.requests.push({ ...req });
                    if (onRequest) onRequest(state, req);
                    return reply === undefined ? { ok: true, content: 'FORMATTED' } :
                        (typeof reply === 'function' ? reply(state) : reply);
                }
            }
        };
        return { manager, model, seen, state };
    }

    {
        const { manager, model, seen } = makeBridge();
        const out = await manager.requestClangFormattedCode(model);
        check('格式化走独立桥，且只发一次请求', out === 'FORMATTED' && seen.calls === 1,
            `calls=${seen.calls} out=${out}`);
        const req = seen.requests[0] || {};
        check('styleRaw 原样透传用户写法（不做 lossy 解析）', req.styleRaw === RAW_STYLE,
            JSON.stringify(req.styleRaw));
        check('style 走归一化、content 取整文档、filePath 取自模型路径',
            req.style === 'normalized:Google' && req.content === 'int  main( )  { }' &&
            req.filePath === 'D:/proj/a.cpp', JSON.stringify({ style: req.style, filePath: req.filePath }));
        check('未给 range 时不带行号，请求的是整文档格式化',
            !('startLine' in req) && !('endLine' in req), JSON.stringify(req));
        check('保留兜底风格字段', req.fallbackStyle === 'LLVM', String(req.fallbackStyle));
    }

    {
        const { manager, model, seen } = makeBridge();
        await manager.requestClangFormattedCode(model, { startLineNumber: 2, endLineNumber: 5 });
        check('给 range 时只带首末行，桥自己做局部格式化',
            seen.requests[0].startLine === 2 && seen.requests[0].endLine === 5,
            JSON.stringify(seen.requests[0]));
    }

    {
        // 桥不可用必须抛，不能悄悄退回有损的本地 formatter —— 这是 :120 那条
        // 「不调 window.cppFormatter.format」真正想守的东西，用行为表达更硬
        const { manager, model, seen } = makeBridge({ noBridge: true });
        let err = null;
        try { await manager.requestClangFormattedCode(model); } catch (e) { err = e; }
        check('桥缺失时抛错而不是回退到有损的本地格式化',
            err && /bridge is unavailable/.test(err.message) && seen.calls === 0,
            err ? err.message : '没抛');

        const bad = makeBridge({ reply: { ok: false, error: 'clang-format 未找到：D:/x' } });
        let err2 = null;
        try { await bad.manager.requestClangFormattedCode(bad.model); } catch (e) { err2 = e; }
        check('桥返回失败时把原始原因抛出去，不吞成通用文案',
            err2 && /clang-format 未找到/.test(err2.message), err2 ? err2.message : '没抛');

        const noContent = makeBridge({ reply: { ok: true, content: 42 } });
        let err3 = null;
        try { await noContent.manager.requestClangFormattedCode(noContent.model); } catch (e) { err3 = e; }
        check('桥回来的不是字符串时抛错，不把脏数据写进编辑器',
            !!err3, err3 ? err3.message : '没抛');
    }

    {
        // 过期结果不能吃：await 期间用户又敲了字 / 关了文件
        const changed = makeBridge({ onRequest: (state) => { state.version += 1; } });
        const r1 = await changed.manager.requestClangFormattedCode(changed.model);
        check('await 期间文档版本变了就丢弃结果', r1 === null, String(r1));

        const disposed = makeBridge({ onRequest: (state) => { state.disposed = true; } });
        const r2 = await disposed.manager.requestClangFormattedCode(disposed.model);
        check('await 期间文档销毁了就丢弃结果', r2 === null, String(r2));

        const gone = makeBridge();
        const r3 = await gone.manager.requestClangFormattedCode(null);
        gone.state.disposed = true;
        const r4 = await gone.manager.requestClangFormattedCode(gone.model);
        check('model 缺失或已销毁时根本不发请求',
            gone.seen.calls === 0 && r3 === null && r4 === null,
            `calls=${gone.seen.calls} r3=${r3} r4=${r4}`);
    }

    check('standalone formatters register without waiting for clangd', rendererSource.includes('this._registerClangFormatDocumentFormattingProvider();') && rendererSource.includes('this._registerClangFormatDocumentRangeFormattingProvider();'));
    check('renderer no longer delegates C/C++ formatting to clangd', !rendererSource.includes('textDocument/formatting') && !rendererSource.includes('textDocument/rangeFormatting'));
    check('renderer never invokes the lossy local formatter fallback', !rendererSource.includes('window.cppFormatter.format('));

    const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    check('main process exposes the standalone formatter IPC', mainSource.includes("ipcMain.handle('format-cpp-code'"));
    check('packaged app resolves a separately bundled clang-format', mainSource.includes("path.join(process.resourcesPath, 'clang-format')"));
    check('clang-format resolution falls back to the user LSP dir and PATH', mainSource.includes('resolveClangFormatExecutable(getUserClangdRoot())') && mainSource.includes('findClangFormatExecutableOnPath()'));
    check('missing clang-format error reports the searched paths instead of build instructions', mainSource.includes('describeClangFormatSearchPaths()') && !mainSource.includes('Run pnpm run prebuild:clang-format'));

    const installerSource = fs.readFileSync(path.join(root, 'installer.nsi'), 'utf8');
    check('installer ships clang-format into the resources dir the app resolves', installerSource.includes('File /r "dist\\win-unpacked\\resources\\clang-format\\*"') && installerSource.includes('SetOutPath "$INSTDIR\\resources\\clang-format"'));
    check('installer removes clang-format on uninstall', /RMDir \/r "\$INSTDIR\\resources\\clang-format"/.test(installerSource));

    const pauserSource = fs.readFileSync(path.join(root, 'src', 'utils', 'consolepauser-source.js'), 'utf8');
    // H16: shell:false 下 libuv 会把参数内的 " 转义成 \"，cmd.exe 不认这种转义，
    // start 会把字面量 "Program Running 当成程序名。必须直接 spawn consolepauser.exe。
    check('the pauser is spawned directly instead of through cmd start',
        mainSource.includes('command = absoluteConsolePauserPath;') &&
        mainSource.includes('args = [absoluteExePath];') &&
        !mainSource.includes('start "Program Running"') &&
        !mainSource.includes("command = 'cmd';"));
    // IDE 以 detached + stdio:'ignore' 启动 pauser，不附加控制台；此时 _getch() 无 stdin 可读，
    // 立即返回 EOF，控制台窗口在程序退出的瞬间消失。必须由 pauser 自行 AllocConsole 并重绑句柄。
    check('console pauser allocates its own console so the pause prompt survives',
        pauserSource.includes('bool EnsureConsole()') &&
        pauserSource.includes('GetConsoleWindow() == NULL && !AllocConsole()') &&
        pauserSource.includes('freopen("CONIN$", "r", stdin)') &&
        /int main\(int argc, char\*\* argv\)\s*\{\s*EnsureConsole\(\);/.test(pauserSource));
    check('console output is gated on GetConsoleMode again', pauserSource.includes('GetConsoleMode(outputHandle, &mode)') && !pauserSource.includes('if (WriteConsoleW(outputHandle, line'));
    check('console pauser keeps the legacy summary wording', pauserSource.includes('-----------------------------------------------') && pauserSource.includes('\\u6267\\u884c\\u65f6\\u95f4') && pauserSource.includes('\\u5cf0\\u503c\\u5185\\u5b58\\u4f7f\\u7528') && pauserSource.includes('\\u7a0b\\u5e8f\\u8fd4\\u56de\\u503c') && pauserSource.includes('\\u8bf7\\u6309\\u4efb\\u610f\\u952e\\u7ee7\\u7eed...'));
    check('console pauser is built statically first so it needs no MinGW runtime DLLs', mainSource.includes("{ name: 'utf8-static', sourceMode: 'utf8', args: ['-static'] }"));
    check('stale console pauser binaries are rebuilt from a source fingerprint', mainSource.includes('getConsolePauserSourceFingerprint()') && mainSource.includes('getConsolePauserFingerprintPath()'));
    check('detached run failures are logged through the child exit code', mainSource.includes("logInfo('[运行] 子进程已退出:'"));

    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    check('build downloads standalone clang-format', packageJson.scripts['prebuild:clang-format'] === 'node scripts/run-node-compat.js scripts/download-clang-format.js');
    const packagedSources = ['win', 'mac', 'linux'].flatMap(platform => packageJson.build[platform].extraResources || []);
    check('standalone clang-format is packaged for every desktop platform', packagedSources.filter(item => item.to === 'clang-format').length === 3);

    const downloaderSource = fs.readFileSync(path.join(root, 'scripts', 'download-clang-format.js'), 'utf8');
    check('clang-format comes from the official LLVM project', downloaderSource.includes("'llvm/llvm-project'") && downloaderSource.includes("'23.1.2'"));

    console.log(`clang-format tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.error(`[FAIL] clang-format unexpected error | ${error?.stack || error}`);
    process.exitCode = 1;
});
