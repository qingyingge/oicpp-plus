import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

const CLANG_FORMAT_TIMEOUT_MS = 10000;
const CLANG_FORMAT_MAX_INPUT_BYTES = 5 * 1024 * 1024;
const CLANG_FORMAT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const CLANG_FORMAT_MAX_STYLE_BYTES = 256 * 1024;
const PRESET_STYLES = new Set(['LLVM', 'GNU', 'Google', 'Chromium', 'Microsoft', 'Mozilla', 'WebKit']);

function serializeClangFormatStyle(style: unknown): string {
    if (style === null || style === undefined || style === '') {
        return 'file';
    }
    if (typeof style === 'string') {
        const value = style.trim();
        if (value.toLowerCase() === 'file') return 'file';
        const preset = Array.from(PRESET_STYLES).find((item) => item.toLowerCase() === value.toLowerCase());
        if (preset) return preset;
        if (value.startsWith('{')) {
            const parsed = JSON.parse(value);
            if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
                throw new Error('clang-format style must be a JSON object');
            }
            return JSON.stringify(parsed);
        }
        throw new Error(`Unsupported clang-format style: ${value}`);
    }
    if (typeof style === 'object' && !Array.isArray(style)) {
        return JSON.stringify(style);
    }
    throw new Error('clang-format style must be an object, preset name, or file');
}

interface ClangFormatArgsOptions {
    filePath?: string;
    style?: unknown;
    styleFilePath?: string;
    fallbackStyle?: string;
    startLine?: number;
    endLine?: number;
    inputFilePath?: string;
}

function buildClangFormatArgs({
    filePath,
    style,
    styleFilePath,
    fallbackStyle = 'LLVM',
    startLine,
    endLine,
    inputFilePath
}: ClangFormatArgsOptions = {}): string[] {
    const args: string[] = [];
    if (typeof filePath === 'string' && filePath.trim() && !inputFilePath) {
        args.push(`--assume-filename=${filePath}`);
    }
    if (styleFilePath) {
        args.push(`--style=file:${styleFilePath}`);
    } else {
        const serializedStyle = serializeClangFormatStyle(style);
        args.push(`--style=${serializedStyle}`);
        if (serializedStyle === 'file') {
            args.push(`--fallback-style=${fallbackStyle || 'LLVM'}`);
        }
    }
    const hasStartLine = Number.isInteger(startLine) && startLine! > 0;
    const hasEndLine = Number.isInteger(endLine) && endLine! >= startLine!;
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

interface ClangFormatOptions {
    executablePath?: string;
    content?: string;
    filePath?: string;
    style?: unknown;
    styleRaw?: unknown;
    fallbackStyle?: string;
    startLine?: number;
    endLine?: number;
    timeoutMs?: number;
    spawnImpl?: typeof spawn;
}

interface ClangFormatResult {
    content: string;
    args: string[];
}

function formatCodeWithClangFormat({
    executablePath,
    content,
    filePath,
    style,
    styleRaw,
    fallbackStyle,
    startLine,
    endLine,
    timeoutMs = CLANG_FORMAT_TIMEOUT_MS,
    spawnImpl = spawn
}: ClangFormatOptions = {}): Promise<ClangFormatResult> {
    if (!executablePath || typeof executablePath !== 'string') {
        return Promise.reject(new Error('clang-format executable is unavailable'));
    }
    if (typeof content !== 'string') {
        return Promise.reject(new Error('clang-format input must be a string'));
    }

    const input = Buffer.from(content, 'utf8');
    if (input.length > CLANG_FORMAT_MAX_INPUT_BYTES) {
        return Promise.reject(new Error(`clang-format input exceeds ${CLANG_FORMAT_MAX_INPUT_BYTES} bytes`));
    }
    if (typeof styleRaw === 'string' && Buffer.byteLength(styleRaw, 'utf8') > CLANG_FORMAT_MAX_STYLE_BYTES) {
        return Promise.reject(new Error(`clang-format style exceeds ${CLANG_FORMAT_MAX_STYLE_BYTES} bytes`));
    }

    const hasRange = startLine !== undefined || endLine !== undefined;
    const hasRawStyle = typeof styleRaw === 'string' && styleRaw.trim().length > 0;
    let tempRoot: string | null = null;
    let styleFilePath: string | null = null;
    let inputFilePath: string | null = null;

    try {
        if (hasRawStyle || hasRange) {
            tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-clang-format-'));
            if (hasRawStyle) {
                styleFilePath = path.join(tempRoot, '.clang-format');
                fs.writeFileSync(styleFilePath, styleRaw, 'utf8');
            }
            if (hasRange) {
                const sourceExtension = typeof filePath === 'string' && /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(filePath)
                    ? path.extname(filePath)
                    : '.cpp';
                inputFilePath = path.join(tempRoot, `source${sourceExtension}`);
                fs.writeFileSync(inputFilePath, input);
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
        } as ClangFormatOptions);
        const requestedDirectory = typeof filePath === 'string' && path.isAbsolute(filePath) ? path.dirname(filePath) : '';
        const cwd = requestedDirectory && fs.existsSync(requestedDirectory) ? requestedDirectory : process.cwd();

        const run = new Promise<ClangFormatResult>((resolve, reject) => {
            const child = spawnImpl(executablePath, args, {
                cwd,
                windowsHide: true,
                shell: false,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            const stdout: Buffer[] = [];
            const stderr: Buffer[] = [];
            let outputBytes = 0;
            let settled = false;
            let timedOut = false;

            const finish = (error: Error | null, result?: ClangFormatResult): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) reject(error);
                else resolve(result as ClangFormatResult);
            };

            const append = (chunks: Buffer[], chunk: Buffer | string): boolean => {
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

            child.stdout.on('data', (chunk: Buffer) => { append(stdout, chunk); });
            child.stderr.on('data', (chunk: Buffer) => { append(stderr, chunk); });
            child.on('error', (error: Error) => finish(error));
            child.on('close', (code: number) => {
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

            child.stdin.on('error', (error: Error) => {
                if (!timedOut) finish(error);
            });
            if (inputFilePath) {
                child.stdin.end();
            } else {
                child.stdin.end(input);
            }
        });

        return run.finally(() => {
            if (tempRoot) {
                fs.rmSync(tempRoot, { recursive: true, force: true });
            }
        });
    } catch (error) {
        if (tempRoot) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
        return Promise.reject(error);
    }
}

export {
    CLANG_FORMAT_MAX_INPUT_BYTES,
    CLANG_FORMAT_MAX_OUTPUT_BYTES,
    CLANG_FORMAT_TIMEOUT_MS,
    buildClangFormatArgs,
    formatCodeWithClangFormat,
    serializeClangFormatStyle
};
