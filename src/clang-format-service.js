"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.serializeClangFormatStyle = exports.CLANG_FORMAT_TIMEOUT_MS = exports.CLANG_FORMAT_MAX_OUTPUT_BYTES = exports.CLANG_FORMAT_MAX_INPUT_BYTES = void 0;
exports.buildClangFormatArgs = buildClangFormatArgs;
exports.formatCodeWithClangFormat = formatCodeWithClangFormat;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const { serializeClangFormatStyle } = require('./utils/clang-format-options');
exports.serializeClangFormatStyle = serializeClangFormatStyle;
const CLANG_FORMAT_TIMEOUT_MS = 10000;
exports.CLANG_FORMAT_TIMEOUT_MS = CLANG_FORMAT_TIMEOUT_MS;
const CLANG_FORMAT_MAX_INPUT_BYTES = 5 * 1024 * 1024;
exports.CLANG_FORMAT_MAX_INPUT_BYTES = CLANG_FORMAT_MAX_INPUT_BYTES;
const CLANG_FORMAT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
exports.CLANG_FORMAT_MAX_OUTPUT_BYTES = CLANG_FORMAT_MAX_OUTPUT_BYTES;
const CLANG_FORMAT_MAX_STYLE_BYTES = 256 * 1024;
async function removeTempRoot(tempRoot) {
    if (!tempRoot)
        return;
    try {
        await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
    catch (_) {
        // 临时目录清理失败不阻断格式化结果
    }
}
function buildClangFormatArgs({ filePath, style, styleFilePath, fallbackStyle = 'LLVM', startLine, endLine, inputFilePath } = {}) {
    const args = [];
    if (typeof filePath === 'string' && filePath.trim() && !inputFilePath) {
        args.push(`--assume-filename=${filePath}`);
    }
    if (styleFilePath) {
        args.push(`--style=file:${styleFilePath}`);
    }
    else {
        const serializedStyle = serializeClangFormatStyle(style);
        args.push(`--style=${serializedStyle}`);
        if (serializedStyle === 'file') {
            args.push(`--fallback-style=${fallbackStyle || 'LLVM'}`);
        }
    }
    const hasStartLine = Number.isInteger(startLine) && startLine > 0;
    const hasEndLine = Number.isInteger(endLine) && endLine >= startLine;
    if (hasStartLine !== hasEndLine) {
        throw new Error('clang-format range requires both startLine and endLine');
    }
    if (hasStartLine && hasEndLine) {
        args.push(`--lines=${startLine}:${endLine}`);
    }
    if (inputFilePath) {
        args.push(inputFilePath);
    }
    return args;
}
async function formatCodeWithClangFormat({ executablePath, content, filePath, style, styleRaw, fallbackStyle, startLine, endLine, timeoutMs = CLANG_FORMAT_TIMEOUT_MS, spawnImpl = child_process_1.spawn } = {}) {
    if (!executablePath || typeof executablePath !== 'string') {
        throw new Error('clang-format executable is unavailable');
    }
    if (typeof content !== 'string') {
        throw new Error('clang-format input must be a string');
    }
    const input = Buffer.from(content, 'utf8');
    if (input.length > CLANG_FORMAT_MAX_INPUT_BYTES) {
        throw new Error(`clang-format input exceeds ${CLANG_FORMAT_MAX_INPUT_BYTES} bytes`);
    }
    if (typeof styleRaw === 'string' && Buffer.byteLength(styleRaw, 'utf8') > CLANG_FORMAT_MAX_STYLE_BYTES) {
        throw new Error(`clang-format style exceeds ${CLANG_FORMAT_MAX_STYLE_BYTES} bytes`);
    }
    const hasRange = startLine !== undefined || endLine !== undefined;
    const hasRawStyle = typeof styleRaw === 'string' && styleRaw.trim().length > 0;
    let tempRoot = null;
    let styleFilePath = null;
    let inputFilePath = null;
    try {
        if (hasRawStyle || hasRange) {
            tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'oicpp-clang-format-'));
            if (hasRawStyle) {
                styleFilePath = path.join(tempRoot, '.clang-format');
                await fs.promises.writeFile(styleFilePath, styleRaw, 'utf8');
            }
            if (hasRange) {
                const sourceExtension = typeof filePath === 'string' && /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(filePath)
                    ? path.extname(filePath)
                    : '.cpp';
                inputFilePath = path.join(tempRoot, `source${sourceExtension}`);
                await fs.promises.writeFile(inputFilePath, input);
            }
        }
        const args = buildClangFormatArgs({
            filePath,
            style,
            styleFilePath,
            fallbackStyle,
            startLine,
            endLine,
            inputFilePath
        });
        const requestedDirectory = typeof filePath === 'string' && path.isAbsolute(filePath) ? path.dirname(filePath) : '';
        const cwd = requestedDirectory && fs.existsSync(requestedDirectory) ? requestedDirectory : process.cwd();
        const run = new Promise((resolve, reject) => {
            const child = spawnImpl(executablePath, args, {
                cwd,
                windowsHide: true,
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            const stdout = [];
            const stderr = [];
            let outputBytes = 0;
            let settled = false;
            let timedOut = false;
            const finish = (error, result) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                if (error)
                    reject(error);
                else
                    resolve(result);
            };
            const append = (chunks, chunk) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                outputBytes += buffer.length;
                if (outputBytes > CLANG_FORMAT_MAX_OUTPUT_BYTES) {
                    child.kill();
                    finish(new Error(`clang-format output exceeds ${CLANG_FORMAT_MAX_OUTPUT_BYTES} bytes`));
                    return false;
                }
                chunks.push(buffer);
                return true;
            };
            child.stdout.on('data', (chunk) => { append(stdout, chunk); });
            child.stderr.on('data', (chunk) => { append(stderr, chunk); });
            child.on('error', (error) => finish(error));
            child.on('close', (code) => {
                if (timedOut) {
                    finish(new Error('clang-format timed out'));
                    return;
                }
                if (code !== 0) {
                    const message = Buffer.concat(stderr).toString('utf8').trim();
                    finish(new Error(message || `clang-format exited with code ${code}`));
                    return;
                }
                finish(null, {
                    content: Buffer.concat(stdout).toString('utf8'),
                    args
                });
            });
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill();
                finish(new Error('clang-format timed out'));
            }, timeoutMs);
            child.stdin.on('error', (error) => {
                if (!timedOut)
                    finish(error);
            });
            if (inputFilePath) {
                child.stdin.end();
            }
            else {
                child.stdin.end(input);
            }
        });
        const result = await run;
        await removeTempRoot(tempRoot);
        return result;
    }
    catch (error) {
        await removeTempRoot(tempRoot);
        throw error;
    }
}
