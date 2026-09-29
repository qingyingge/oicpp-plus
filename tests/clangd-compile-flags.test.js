'use strict';

// H15 / M52 / M53: clangd 在 Windows 上会自行探测 MSVC 工具链并注入
// -internal-isystem，优先级高于 --query-driver 与用户 compile_commands.json。
// 应用侧唯一生效的通道是 global compilation database（compile_flags.txt），
// 落点为 <workspace>/.oicpp-plus/lsp/compile_flags.txt。

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    buildCompileFlagsText,
    hasUserCompilationDatabase,
    removeCompileFlagsFile,
    writeCompileFlagsFile
} = require('../src/utils/clangd-compile-flags');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-clangd-flags-'));
const includeDirs = ['inc/a', 'inc/b', 'inc/c'].map((rel) => {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
});

try {
    // --- buildCompileFlagsText --------------------------------------------
    const text = buildCompileFlagsText({
        includePaths: includeDirs,
        target: 'x86_64-w64-mingw32',
        compileFlags: ['-std=c++17']
    });
    const lines = text.trim().split(/\r?\n/);
    check('H15: -isystem pairs are emitted for every probed include dir',
        lines.filter((line) => line === '-isystem').length === includeDirs.length,
        `${lines.length} lines`);
    check('H15: include dirs are normalized to posix separators',
        lines.includes(includeDirs[0].replace(/\\/g, '/')) && !text.includes('\\'));
    check('H15: gcc target triple overrides clangd msvc autodetection',
        lines.includes('--target=x86_64-w64-mingw32'));

    check('M52: an msvc triple is not written back as --target',
        !buildCompileFlagsText({ includePaths: includeDirs, target: 'x86_64-pc-windows-msvc' })
            .includes('--target='));

    check('M52: non -std compile args are dropped',
        buildCompileFlagsText({ includePaths: includeDirs, compileFlags: ['-O2', '-lws2_32', '--coverage'] })
            .includes('-std=c++17') === false &&
        !buildCompileFlagsText({ includePaths: includeDirs, compileFlags: ['-O2'] }).includes('-O2'));

    check('H15: user -std is preserved ahead of the include list',
        buildCompileFlagsText({ includePaths: includeDirs, compileFlags: ['-std=c++14'] }).trim().startsWith('-std=c++14'));

    check('M52: unknown or invalid targets are ignored',
        !buildCompileFlagsText({ includePaths: includeDirs, target: 'a b; rm -rf' }).includes('--target='));

    check('M52: missing include dirs are skipped',
        !buildCompileFlagsText({ includePaths: [path.join(root, 'nope')] }).includes('-isystem'));

    check('M52: no flags yields empty output',
        buildCompileFlagsText({ includePaths: [], target: '', compileFlags: [] }) === '');

    check('M52: duplicate include dirs are collapsed',
        buildCompileFlagsText({ includePaths: [includeDirs[0], includeDirs[0]] })
            .split(/\r?\n/).filter((line) => line === '-isystem').length === 1);

    // --- writeCompileFlagsFile -------------------------------------------
    const workspace = fs.mkdtempSync(path.join(root, 'ws-'));
    const written = writeCompileFlagsFile({
        workspaceRoot: workspace,
        includeDirs,
        target: 'x86_64-w64-mingw32',
        compileFlags: ['-std=c++17']
    });
    check('H15: flags land under <workspace>/.oicpp-plus/lsp/compile_flags.txt',
        written.ok === true &&
        written.filePath === path.join(workspace, '.oicpp-plus', 'lsp', 'compile_flags.txt') &&
        fs.existsSync(written.filePath),
        written.filePath);
    check('H15: --compile-commands-dir target dir is the private LSP dir',
        written.dir === path.join(workspace, '.oicpp-plus', 'lsp'));

    const second = writeCompileFlagsFile({
        workspaceRoot: workspace,
        includeDirs,
        target: 'x86_64-w64-mingw32',
        compileFlags: ['-std=c++17']
    });
    check('L34/L36: unchanged content is not rewritten',
        second.ok === true && second.written === false);

    const changed = writeCompileFlagsFile({
        workspaceRoot: workspace,
        includeDirs,
        target: 'x86_64-w64-mingw32',
        compileFlags: ['-std=c++20']
    });
    check('H15: a compiler flag change rewrites the file',
        changed.written === true &&
        fs.readFileSync(changed.filePath, 'utf8').includes('-std=c++20'));

    const removed = removeCompileFlagsFile(written.filePath);
    check('removeCompileFlagsFile deletes a generated flags file', removed === true && !fs.existsSync(written.filePath));

    // --- 用户自带编译数据库优先 ------------------------------------------
    const userWorkspace = fs.mkdtempSync(path.join(root, 'user-cdb-'));
    fs.writeFileSync(path.join(userWorkspace, 'compile_commands.json'), '[]', 'utf8');
    check('H15: a user compile_commands.json disables the generated flags',
        hasUserCompilationDatabase(userWorkspace) === true);
    const skipped = writeCompileFlagsFile({
        workspaceRoot: userWorkspace,
        includeDirs,
        target: 'x86_64-w64-mingw32'
    });
    check('H15: nothing is written into a workspace with its own compilation database',
        skipped.ok === false && skipped.reason === 'user-compilation-database' &&
        !fs.existsSync(path.join(userWorkspace, '.oicpp-plus')));

    check('H15: parent compile_commands.json is also detected',
        hasUserCompilationDatabase(path.join(userWorkspace, 'a', 'b')) === true);

    check('M52: a workspace without flags yields no-flags',
        writeCompileFlagsFile({ workspaceRoot: fs.mkdtempSync(path.join(root, 'empty-')), includeDirs: [], target: '' }).reason === 'no-flags');
    check('M52: a missing workspace is rejected',
        writeCompileFlagsFile({ workspaceRoot: path.join(root, 'does-not-exist'), includeDirs, target: 'x86_64-w64-mingw32' }).reason === 'invalid-workspace');
    check('M52: no workspace at all is rejected',
        writeCompileFlagsFile({ workspaceRoot: '', includeDirs, target: 'x86_64-w64-mingw32' }).reason === 'user-compilation-database');

    // --- L26: 设置页不再有 100ms 人为延迟 ---------------------------------
    const settingsInit = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'renderer', 'js', 'settings-init.js'), 'utf8');
    check('L26: settings-init no longer sleeps 100ms on boot',
        !/await new Promise\(resolve => setTimeout\(resolve,\s*100\)\)/.test(settingsInit));
} finally {
    fs.rmSync(root, { recursive: true, force: true });
}

console.log(`clangd-compile-flags regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
