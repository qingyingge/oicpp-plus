'use strict';

// clangd 在 Windows 上会自行探测 Visual Studio 工具链并把 MSVC/Windows SDK 的
// -internal-isystem 注入到 cc1 参数里，且 --query-driver / compile_commands.json 都压不过它：
// 探测出的工具链优先级高于用户配置的编译器。clangd 23.1.0 的 --help 里也没有任何关闭该
// 探测的开关（也没有 --fallback-flags），因此应用侧唯一真正生效的通道是 clangd 的
// global compilation database —— compile_flags.txt：
//   * 只有在 per-file 编译数据库（compile_commands.json）缺失时才会被读取；
//   * 其中的 -isystem 会排在 clangd 自动注入的 -internal-isystem 之前。
// 于是这里把用户实际编译器的 include 搜索列表与 target triple 落成一个
// <workspace>/.oicpp-plus/lsp/compile_flags.txt，并用 --compile-commands-dir 指向它。

const fs = require('fs');
const path = require('path');

const LSP_PRIVATE_DIR_NAME = path.join('.oicpp-plus', 'lsp');
const COMPILE_FLAGS_FILE_NAME = 'compile_flags.txt';
// 向上查找用户自带编译数据库的最大层数，避免误判到无关工程的配置
const USER_CDB_SEARCH_DEPTH = 8;
const MAX_INCLUDE_DIRS = 64;
const MSVC_TRIPLE = 'x86_64-pc-windows-msvc';

function toPosixPath(value) {
    return String(value || '').replace(/\\/g, '/');
}

// 工作区（及其若干层父目录）里若已有用户自己的 compile_commands.json，
// 说明该工程已经声明了编译命令，一律不接管，避免覆盖用户的构建配置。
function hasUserCompilationDatabase(workspaceRoot) {
    if (!workspaceRoot) return false;
    let currentDir;
    try {
        currentDir = path.resolve(workspaceRoot);
    } catch (_) {
        return false;
    }

    for (let depth = 0; depth <= USER_CDB_SEARCH_DEPTH; depth++) {
        if (fs.existsSync(path.join(currentDir, 'compile_commands.json'))) {
            return true;
        }
        const parentDir = path.dirname(currentDir);
        if (!parentDir || parentDir === currentDir) {
            break;
        }
        currentDir = parentDir;
    }
    return false;
}

function buildCompileFlagsText({ includePaths = [], target = '', compileFlags = [] } = {}) {
    const lines = [];
    const seen = new Set();
    const push = (value) => {
        const text = String(value || '').trim();
        if (!text || /[\r\n]/.test(text)) return;
        if (seen.has(text)) return;
        seen.add(text);
        lines.push(text);
    };

    // 用户自定义编译参数里只有 -std= 会改变 clangd 的语义判断
    for (const flag of Array.isArray(compileFlags) ? compileFlags : []) {
        if (/^-std=[A-Za-z0-9+]+$/.test(String(flag || '').trim())) {
            push(String(flag).trim());
        }
    }

    let added = 0;
    const seenIncludeDirs = new Set();
    for (const includeDir of Array.isArray(includePaths) ? includePaths : []) {
        if (added >= MAX_INCLUDE_DIRS) break;
        if (!includeDir || !fs.existsSync(includeDir)) continue;
        try {
            if (!fs.statSync(includeDir).isDirectory()) continue;
        } catch (_) {
            continue;
        }
        const normalized = toPosixPath(path.resolve(includeDir));
        if (seenIncludeDirs.has(normalized)) continue;
        seenIncludeDirs.add(normalized);
        // -isystem 与其路径必须成对出现，不能各自去重，否则第二个路径会变成孤立参数
        lines.push('-isystem');
        lines.push(normalized);
        added++;
    }

    const targetTriple = String(target || '').trim();
    // MSVC 目标下 clangd 自带的探测本来就是对的，不要用 gcc triple 覆盖
    if (targetTriple && targetTriple !== MSVC_TRIPLE && /^[A-Za-z0-9_.-]+$/.test(targetTriple)) {
        push(`--target=${targetTriple}`);
    }

    return lines.length > 0 ? lines.join('\r\n') + '\r\n' : '';
}
// 落盘 compile_flags.txt；内容没变时不重写，避免每次启动都动用户工作区。
// 已有文件但内容与探测结果不一致时覆盖——编译器换了版本/路径后必须跟着更新。
function writeCompileFlagsFile({ workspaceRoot, includePaths = [], target = '', compileFlags = [] } = {}) {
    const flagsText = buildCompileFlagsText({ includePaths, target, compileFlags });
    if (!flagsText) {
        return { ok: false, reason: 'no-flags', dir: '', filePath: '' };
    }
    if (!workspaceRoot || hasUserCompilationDatabase(workspaceRoot)) {
        return { ok: false, reason: 'user-compilation-database', dir: '', filePath: '' };
    }

    try {
        if (!fs.statSync(workspaceRoot).isDirectory()) {
            return { ok: false, reason: 'invalid-workspace', dir: '', filePath: '' };
        }
    } catch (_) {
        return { ok: false, reason: 'invalid-workspace', dir: '', filePath: '' };
    }

    const dir = path.join(workspaceRoot, LSP_PRIVATE_DIR_NAME);
    const filePath = path.join(dir, COMPILE_FLAGS_FILE_NAME);
    try {
        if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === flagsText) {
            return { ok: true, dir, filePath, written: false };
        }
    } catch (_) { }

    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, flagsText, 'utf8');
        return { ok: true, dir, filePath, written: true };
    } catch (error) {
        return { ok: false, reason: error?.message || String(error), dir, filePath };
    }
}

function removeCompileFlagsFile(filePath) {
    if (!filePath) return false;
    try {
        if (!fs.existsSync(filePath)) return false;
        fs.rmSync(filePath, { force: true });
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    COMPILE_FLAGS_FILE_NAME,
    LSP_PRIVATE_DIR_NAME,
    buildCompileFlagsText,
    hasUserCompilationDatabase,
    removeCompileFlagsFile,
    writeCompileFlagsFile
};
