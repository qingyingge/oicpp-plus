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
    check('renderer formats C/C++ through the standalone bridge', rendererSource.includes('window.electronAPI.formatCppCode(request)'));
    check('renderer forwards the raw user style without lossy parsing', rendererSource.includes('styleRaw: this.clangFormatRaw'));
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
    check('console pauser no longer allocates its own console', !pauserSource.includes('AllocConsole()') && !pauserSource.includes('freopen("CONIN$", "r", stdin)'));
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
