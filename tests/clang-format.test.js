'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { EventEmitter } = require('events');
const { callbackBody, classMethod, funcDecl } = require('./fixtures/source-extract');
const {
    buildClangFormatArgs,
    formatCodeWithClangFormat,
    serializeClangFormatStyle
} = require('../src/clang-format-service');

// 挂死不等于通过：await 一个永不 settle 的 promise 时，Node 带着 0 退出码排空
// event loop，runner 只看 status 和 [FAIL] 行数 —— 后半截断言一条不发也算过。
// 这些文件收尾写 process.exitCode 而不是 process.exit，所以定时器必须具名，
// 并在每个收尾点显式 clearTimeout，否则正常跑完会被它多留 60s 再判红。
const watchdog = setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：某个 await 永不 settle（异步守卫没被驱动完）');
    process.exit(1);
}, 60000);

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

// 把 classMethod 抽出来的方法体（`name(params) { ... }`）在指定 vm 上下文里编译成
// `function name(...)`。用 vm 而不是 new Function：new Function 造的函数作用域是
// Node 的全局，注入不了「沙箱里不给 LSP 句柄」这种关键限制；vm 上下文能精确决定
// 这段代码看得见什么，跑通了才证明它真的没依赖语言服务器。
function compileMethod(source, name, ctx) {
    const raw = classMethod(source, name);
    if (!raw) return { raw, fn: undefined };
    const s = raw.replace(/^\s+/, '');
    const decl = /^(?:async\s+)?function\s/.test(s)
        ? s
        : (/^async\s+/.test(s) ? 'async function ' + s.replace(/^async\s+/, '') : 'function ' + s);
    vm.runInContext(`${decl}\nthis.__compiled = ${name};`, ctx);
    return { raw, fn: ctx.__compiled };
}

// 顶层函数声明一族：一次抽多个，抽不到的名字带回去让调用方先断言「抽取成功」，
// 否则后面所有基于返回值的断言都会在 undefined 上真空通过。
function compileFuncs(source, names, ctx) {
    const fns = {};
    const missing = [];
    for (const name of names) {
        const body = funcDecl(source, name);
        if (!body) { missing.push(name); continue; }
        vm.runInContext(`${body}\nthis.__fns.${name} = ${name};`, ctx);
        fns[name] = ctx.__fns[name];
    }
    return { fns, missing };
}

// 下载器脚本正文：整份 require 头 + 配置段 + 各个函数，只要底部那句 `main().catch(...)`
// 之前的部分 —— 别把脚本自己跑起来。锚点用「行首 main() 再 .catch」而不是某行内容，
// 找不到锚点就返回 ''，由调用方断言抽取成功，避免切空之后所有断言真空通过。
function extractDownloaderBlock(source) {
    const stop = source.search(/^\s*main\s*\(\s*\)\s*\.\s*catch/m);
    if (stop < 0) return '';
    return source.slice(0, stop);
}

const DOWNLOADER_BINDINGS = [
    'args', 'readArg', 'normalizePlatform', 'version', 'tag', 'repo', 'platform',
    'architecture', 'usesIntelMacFallback', 'assetVersion', 'releaseTag', 'outputRoot',
    'directUrl', 'expectedDigest', 'skipSslVerify', 'tempRoot', 'assetNames',
    'ensureDir', 'run7z', 'extractFromZip', 'extractFromXz', 'findFile',
    'getAssetName', 'selectReleaseAsset', 'main'
];

// scripts/download-clang-format.js 的行为沙箱：正文原样跑进 vm，require 全部换成记账桩，
// argv / env / 平台 / 架构 / 虚拟文件树由用例喂进来。
// 原来的文本守卫是 includes("'llvm/llvm-project'") && includes("'23.1.2'") ——
// 这两个字符串在注释里出现也算命中；tag 拼错、intel-mac 回退条件写反、
// 下载上限漏传、校验失败没清 staging，全都照样绿。跑起来才有数：
// 版本号是算出来的哪个、7z 收到的参数、落盘改名顺序、失败时留下什么。
function makeDownloaderSandbox(options = {}) {
    const opts = options || {};
    const PATH7ZA = '/opt/7zip-bin/7za';
    const fileSet = new Set((opts.files || []).map((f) => path.resolve(f)));
    const fsOps = [];
    const resolve = (p) => path.resolve(String(p));
    const dirPrefix = (p) => {
        const r = resolve(p);
        return r.endsWith(path.sep) ? r : r + path.sep;
    };
    const hasDir = (p) => {
        const pre = dirPrefix(p);
        for (const f of fileSet) {
            if (f.startsWith(pre)) return true;
        }
        return false;
    };
    const fsStub = {
        existsSync: (p) => fileSet.has(resolve(p)) || hasDir(p),
        mkdirSync: (p) => { fsOps.push(`mkdir ${resolve(p)}`); },
        readdirSync: (p) => {
            const pre = dirPrefix(p);
            const names = new Map();
            for (const f of fileSet) {
                if (!f.startsWith(pre)) continue;
                const rest = f.slice(pre.length);
                const cut = rest.indexOf(path.sep);
                if (cut < 0) names.set(rest, false);
                else names.set(rest.slice(0, cut), true);
            }
            return Array.from(names, ([name, isDir]) => ({ name, isDirectory: () => isDir }));
        },
        rmSync: (p) => {
            const r = resolve(p);
            const pre = dirPrefix(r);
            for (const f of Array.from(fileSet)) {
                if (f === r || f.startsWith(pre)) fileSet.delete(f);
            }
            fsOps.push(`rm ${r}`);
        },
        copyFileSync: (a, b) => {
            fileSet.add(resolve(b));
            fsOps.push(`copy ${resolve(a)} -> ${resolve(b)}`);
        },
        chmodSync: (p, mode) => { fsOps.push(`chmod ${resolve(p)} ${Number(mode).toString(8)}`); },
        renameSync: (a, b) => {
            const from = resolve(a);
            const to = resolve(b);
            for (const f of Array.from(fileSet)) {
                if (f === from) { fileSet.delete(f); fileSet.add(to); } else if (f.startsWith(dirPrefix(from))) {
                    fileSet.delete(f);
                    fileSet.add(to + f.slice(from.length));
                }
            }
            fsOps.push(`rename ${from} -> ${to}`);
        }
    };

    const logs = { log: [], warn: [], error: [] };
    const spawnCalls = [];
    const syncCalls = [];
    const extractCalls = [];
    const requestJsonCalls = [];
    const downloadCalls = [];
    const push = (bucket, row) => { bucket.push(row.map(String)); };

    const makeProc = (cmd, argsList) => {
        const rec = { cmd: String(cmd), args: (argsList || []).map(String) };
        spawnCalls.push(rec);
        const proc = new EventEmitter();
        proc.stdin = { write() {}, end() {}, on() {}, once() {}, emit() {} };
        proc.stderr = { on() {} };
        proc.stdout = { pipe(dest) { rec.pipedTo = dest; } };
        if (rec.cmd === PATH7ZA && !rec.args.includes('-so')) {
            const outArg = rec.args.find((a) => a.startsWith('-o'));
            const extractTo = outArg ? outArg.slice(2) : '';
            const includes = rec.args.filter((a) => a.startsWith('-ir!')).map((a) => a.slice(4));
            extractCalls.push({ extractTo, includes, streaming: rec.args.includes('-ttar') });
            fsOps.push(`extract ${path.resolve(extractTo)}`);
            setImmediate(() => {
                if (opts.omitExtracted) { proc.emit('close', opts.closeCode ?? 0); return; }
                for (const name of opts.extractProduces || includes) {
                    // 放进一层子目录，逼着 findFile 递归找 —— 真实 LLVM 包里正是这样
                    fileSet.add(path.join(path.resolve(extractTo), 'llvm-project', name));
                }
                proc.emit('close', opts.closeCode ?? 0);
            });
        }
        return proc;
    };

    const requireStub = (id) => {
        if (id === 'fs') return fsStub;
        if (id === 'path') return path;
        if (id === './lib/release-downloader') {
            const config = { calls: [] };
            downloaderConfigs.push(config);
            return {
                createReleaseDownloader: (cfg) => {
                    config.cfg = cfg;
                    return {
                        requestJson: async (url, token) => {
                            requestJsonCalls.push({ url, token });
                            if (opts.apiError) throw new Error(opts.apiError);
                            return { assets: (opts.releaseAssets || []) };
                        },
                        ensureDownload: async (url, dest, token, digest) => {
                            downloadCalls.push({ url, dest: path.resolve(String(dest)), token, digest });
                            fsOps.push(`download ${path.resolve(String(dest))}`);
                            fileSet.add(path.resolve(String(dest)));
                            if (opts.downloadImpl) return opts.downloadImpl({ url, dest, token, digest });
                            return { digestVerified: true };
                        }
                    };
                }
            };
        }
        if (id === 'child_process') {
            return {
                spawn: makeProc,
                spawnSync: (cmd, argsList) => {
                    const rec = { cmd: String(cmd), args: (argsList || []).map(String) };
                    syncCalls.push(rec);
                    if (rec.cmd === PATH7ZA) {
                        if ((opts.spawnStatus ?? 0) !== 0) return { status: opts.spawnStatus, stdout: '', stderr: '' };
                        const outArg = rec.args.find((a) => a.startsWith('-o'));
                        const extractTo = outArg ? outArg.slice(2) : '';
                        const includes = rec.args.filter((a) => a.startsWith('-ir!')).map((a) => a.slice(4));
                        extractCalls.push({ extractTo, includes, streaming: false });
                        fsOps.push(`extract ${path.resolve(extractTo)}`);
                        if (!opts.omitExtracted) {
                            for (const name of opts.extractProduces || includes) {
                                fileSet.add(path.join(path.resolve(extractTo), 'llvm-project', name));
                            }
                        }
                        return { status: 0, stdout: '', stderr: '' };
                    }
                    fsOps.push(`verify ${resolve(rec.cmd)}`);
                    return {
                        status: opts.versionStatus ?? 0,
                        stdout: opts.versionStdout ?? 'clang-format version 23.1.2\n',
                        stderr: opts.versionStderr ?? ''
                    };
                }
            };
        }
        if (id === '7zip-bin') return { path7za: PATH7ZA };
        throw new Error(`下载器沙箱里不该 require 这个模块: ${id}`);
    };

    const downloaderConfigs = [];
    const ctx = vm.createContext({
        path, JSON, Math, Number, String, Boolean, Array, Object, Error, RegExp,
        Promise, Map, Set, Buffer, EventEmitter,
        process: {
            argv: ['node', 'download-clang-format.js', ...(opts.argv || [])],
            env: opts.env || {},
            platform: opts.platform || 'linux',
            arch: opts.arch || 'x64',
            pid: opts.pid ?? 4242,
            exit: (code) => { push(logs.error, [`process.exit(${code})`]); }
        },
        __dirname: opts.dirname || '/repo/scripts',
        fs: fsStub,
        require: requireStub,
        console: {
            log: (...a) => push(logs.log, a),
            warn: (...a) => push(logs.warn, a),
            error: (...a) => push(logs.error, a)
        }
    });
    let runError = null;
    try {
        vm.runInContext(`${opts.block}\nthis.__dl = { ${DOWNLOADER_BINDINGS.join(', ')} };`, ctx);
    } catch (e) {
        runError = e;
    }
    const dl = runError ? {} : ctx.__dl;
    const missing = DOWNLOADER_BINDINGS.filter((name) => dl[name] === undefined);
    const call = (name, ...args) => (typeof dl[name] === 'function' ? dl[name](...args) : undefined);
    return {
        ctx, dl, missing, runError, logs, fsOps, spawnCalls, syncCalls, extractCalls,
        requestJsonCalls, downloadCalls, downloaderConfigs, fileSet, call,
        main: () => dl.main(),
        has: (p) => fileSet.has(path.resolve(String(p))),
        fsOpsText: () => fsOps.join('\n')
    };
}

// installer.nsi 解析：先按 Section/SectionEnd 配对切段，再在段内跟着当前 SetOutPath
// 归集 File / RMDir 指令。原来那两条守卫是两段硬编码字符串比对：
// includes('SetOutPath "$INSTDIR\\resources\\clang-format"') —— 把 package.json 里
// extraResources 的 to 改名（clang-format → llvm），安装脚本照样往 resources\clang-format
// 装、主进程照样去 resources\llvm 找，打包完直接没有格式化器，而两条守卫全绿。
// 解析成数据之后，安装目标 / 复制来源 / 卸载删除目标三处必须来自同一份推导。
function nsiSections(source) {
    const closed = [];
    const stack = [];
    for (const raw of source.split(/\r?\n/)) {
        const line = raw.trim();
        if (/^Section\b/i.test(line)) { stack.push({ header: line, body: [] }); continue; }
        if (/^SectionEnd\b/i.test(line)) { if (stack.length) closed.push(stack.pop()); continue; }
        if (stack.length) stack[stack.length - 1].body.push(line);
    }
    return closed;
}

function nsiOps(body) {
    const ops = [];
    let outPath = '';
    for (const line of body) {
        if (line.startsWith(';') || line.startsWith('#')) continue;
        const m = /^([A-Za-z]+)\b(.*)$/.exec(line);
        if (!m) continue;
        const kind = m[1];
        const rest = m[2];
        const quoted = Array.from(rest.matchAll(/"([^"]*)"/g), (q) => q[1]);
        if (/^setoutpath$/i.test(kind)) {
            if (quoted[0] !== undefined) outPath = quoted[0];
            continue;
        }
        if (/^(file|rmdir|delete)$/i.test(kind)) {
            ops.push({
                kind: kind.toLowerCase(),
                recursive: /(^|\s)\/r(\s|$)/i.test(rest),
                outPath,
                targets: quoted
            });
        }
    }
    return ops;
}

// consolepauser 自动构建链的行为沙箱：把 src/main.js 里的 6 个函数原样抽出来跑，
// fs / child_process.spawn / iconv-lite 全是记账桩。
// 原来这两条是文本守卫：includes("{ name: 'utf8-static', ... args: ['-static'] }")
// 与 includes('getConsolePauserSourceFingerprint()') —— 策略数组排第二、指纹写了但
// 从来不比对、编译退出码非 0 也当成功，字符串全都照样命中。跑起来才看得见：
// 第一次 g++ 到底带没带 -static、指纹不匹配时重不重编、失败后留下什么。
function makePauserSandbox(options = {}) {
    const opts = options || {};
    const HOME = '/home/tester';
    const UDN = opts.userDataDirName || '.oicpp-plus';
    const COMPILER = '/opt/mingw/bin/g++.exe';
    const targetPath = path.join(HOME, UDN, 'consolepauser.exe');
    const cppPath = path.join(HOME, UDN, 'consolepauser.cpp');
    const fingerprintPath = `${targetPath}.src.sha256`;

    const files = new Map();
    if (opts.compilerExists !== false) files.set(path.resolve(COMPILER), 'EXE');
    for (const f of (opts.files || [])) files.set(path.resolve(f), '');
    for (const [k, v] of Object.entries(opts.contents || {})) files.set(path.resolve(k), v);
    const writes = [];
    const mkdirs = [];
    const builds = [];
    const logs = { info: [], warn: [] };
    const iconvCalls = [];
    const fmt = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
    const fsStub = {
        existsSync: (p) => files.has(path.resolve(String(p))),
        readFileSync: (p, enc) => {
            const key = path.resolve(String(p));
            if (!files.has(key)) throw new Error(`ENOENT: ${key}`);
            const value = files.get(key);
            return enc ? String(value) : Buffer.from(String(value));
        },
        writeFileSync: (p, data, enc) => {
            const key = path.resolve(String(p));
            files.set(key, data);
            writes.push({ path: key, data, encoding: enc });
        },
        mkdirSync: (p) => { mkdirs.push(path.resolve(String(p))); }
    };
    const requireStub = (id) => {
        if (id === 'child_process') {
            return {
                spawn: (cmd, argsList, spawnOptions) => {
                    const rec = { cmd: String(cmd), args: (argsList || []).map(String), options: spawnOptions };
                    builds.push(rec);
                    const child = new EventEmitter();
                    child.stdout = new EventEmitter();
                    child.stderr = new EventEmitter();
                    child.stdin = new EventEmitter();
                    setImmediate(() => {
                        if (opts.spawnError) {
                            child.emit('error', new Error(opts.spawnError));
                            return;
                        }
                        const at = rec.args.indexOf('-o');
                        const out = at >= 0 ? rec.args[at + 1] : '';
                        const ok = opts.succeed ? opts.succeed(rec.args) : true;
                        if (ok) {
                            if (out && opts.produceExe !== false) files.set(path.resolve(out), 'EXE');
                            child.stdout.emit('data', Buffer.from(opts.stdoutText || 'g++ ok'));
                            child.emit('close', 0);
                            return;
                        }
                        child.stderr.emit('data', Buffer.from(opts.stderrText || 'ld returned 1 exit status'));
                        child.emit('close', opts.exitCode ?? 1);
                    });
                    return child;
                }
            };
        }
        if (id === 'iconv-lite') {
            if (opts.iconvAvailable === false) throw new Error('Cannot find module iconv-lite');
            return {
                encode: (text) => { iconvCalls.push('encode'); return Buffer.from(`GBK:${text}`); },
                decode: (buf) => buf.toString('utf8')
            };
        }
        throw new Error(`pauser 沙箱里不该 require 这个模块: ${id}`);
    };

    const ctx = vm.createContext({
        __fns: {},
        fs: fsStub, path, crypto, Buffer, EventEmitter,
        os: { homedir: () => HOME },
        process: { platform: opts.platform || 'win32', env: { PATH: opts.pathEnv || '/usr/bin' } },
        USER_DATA_DIR_NAME: UDN,
        CONSOLE_PAUSER_SOURCE: opts.pauserSource || 'PAUSER-C-SOURCE',
        logInfo: (...a) => { logs.info.push(a.map(fmt)); },
        logWarn: (...a) => { logs.warn.push(a.map(fmt)); },
        t: (key, params) => `${key}|${(params && params.details) || ''}`,
        detectEncoding: () => 'utf8',
        require: requireStub,
        JSON, Math, Number, String, Boolean, Array, Object, Error, RegExp, Promise, Map, Set
    });
    const names = [
        'findConsolePauser', 'getConsolePauserTargetPath', 'getConsolePauserFingerprintPath',
        'getConsolePauserSourceFingerprint', 'getCompilerRuntimeBinPaths',
        'ensureConsolePauserExecutable'
    ];
    const { fns, missing } = compileFuncs(opts.src, names, ctx);
    const attempt = (compilerPath) => fns.ensureConsolePauserExecutable(
        compilerPath === undefined ? COMPILER : compilerPath);
    const argsAt = (index) => (builds[index] ? builds[index].args : []);
    return {
        fns, missing, files, writes, mkdirs, builds, logs, iconvCalls, attempt, argsAt,
        targetPath, cppPath, fingerprintPath, compilerPath: COMPILER,
        fingerprintOf: (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
        pathEnvOf: (index) => (builds[index] && builds[index].options.env ? String(builds[index].options.env.PATH) : ''),
        writtenCpp: () => {
            const last = writes.filter((w) => w.path === path.resolve(cppPath)).pop();
            return last ? last.data : undefined;
        }
    };
}

function makeFormatSandbox() {
    const registrations = [];
    const logCalls = { info: [], warn: [] };
    const disposableOf = (kind, language) => ({
        kind,
        language,
        disposeCount: 0,
        dispose() { this.disposeCount++; }
    });
    const ctx = vm.createContext({
        monaco: {
            languages: {
                registerDocumentFormattingEditProvider: (language, provider) => {
                    registrations.push({ kind: 'full', language, provider });
                    return disposableOf('full', language);
                },
                registerDocumentRangeFormattingEditProvider: (language, provider) => {
                    registrations.push({ kind: 'range', language, provider });
                    return disposableOf('range', language);
                }
            }
        },
        logInfo: (...a) => { logCalls.info.push(a.map(String)); },
        logWarn: (...a) => { logCalls.warn.push(a.map(String)); },
        Math, JSON, Set, Map, Array, Object, String, Number, Boolean, Error, RegExp, Promise
        // 刻意不给 lsp / window / require / monaco.languages.* 之外的任何 LSP 句柄
    });
    return { ctx, registrations, logCalls };
}

function makeModel(lines, state = {}) {
    const arr = Array.isArray(lines) ? lines.slice() : String(lines).split('\n');
    const flags = { disposed: false, ...state };
    return {
        flags,
        lines: arr,
        getValue: () => arr.join('\n'),
        isDisposed: () => flags.disposed,
        getFullModelRange: () => ({
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: arr.length,
            endColumn: (arr[arr.length - 1] || '').length + 1
        }),
        getLineMaxColumn: (lineNumber) => (arr[lineNumber - 1] || '').length + 1
    };
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

    // -----------------------------------------------------------------------
    // 渲染层的两个格式化提供器：真注册、真调用。
    // 这三条原来是 includes() 读源码长相 —— 注册调用挪个分支、或者整条路径改成
    // 等 clangd，字符串都还在，守卫真空。「不依赖 clangd」看着没有可调用对象，
    // 其实可以这么证：沙箱里只给 monaco.languages 那两个注册函数，lsp / window /
    // require 一个都不给，能算出编辑内容就说明这条路径不经过语言服务器。
    // 「不回退到有损的本地 formatter」也一样：桥缺失时真抛出、provider 真空返回 []。
    // -----------------------------------------------------------------------
    {
        const sandbox = makeFormatSandbox();
        const full = compileMethod(rendererSource, '_registerClangFormatDocumentFormattingProvider', sandbox.ctx);
        const rangeM = compileMethod(rendererSource, '_registerClangFormatDocumentRangeFormattingProvider', sandbox.ctx);
        const minimal = compileMethod(rendererSource, 'buildMinimalFormatEdits', sandbox.ctx);
        check('方法体抽取成功: 两个注册方法 + 最小改动计算',
            !!(full.fn && rangeM.fn && minimal.fn),
            JSON.stringify({ full: !!full.fn, range: !!rangeM.fn, minimal: !!minimal.fn }));

        const bridge = { calls: [], reply: () => 'FORMATTED', onCall: null };
        const manager = {
            _clangFormatProviders: new Map(),
            requestClangFormattedCode: (model, range) => {
                bridge.calls.push({ model, range });
                if (bridge.onCall) bridge.onCall(bridge.calls.length - 1);
                const value = bridge.reply();
                return value instanceof Promise ? value : Promise.resolve(value);
            },
            buildMinimalFormatEdits: (model, original, formatted) => minimal.fn.call(manager, model, original, formatted)
        };
        full.fn.call(manager);
        rangeM.fn.call(manager);

        const fullRegs = sandbox.registrations.filter((row) => row.kind === 'full');
        const rangeRegs = sandbox.registrations.filter((row) => row.kind === 'range');
        check('文档格式化与区域格式化各注册到 cpp 和 c',
            fullRegs.length === 2 && rangeRegs.length === 2 &&
            fullRegs.every((row) => row.language === 'cpp' || row.language === 'c') &&
            rangeRegs.every((row) => row.language === 'cpp' || row.language === 'c'),
            JSON.stringify(sandbox.registrations.map((row) => `${row.kind}:${row.language}`)));
        check('disposable 按 <语言>:clang-format[-range] 记账（切主题重注册要用）',
            [...manager._clangFormatProviders.keys()].sort().join(',') ===
                'c:clang-format,c:clang-format-range,cpp:clang-format,cpp:clang-format-range',
            [...manager._clangFormatProviders.keys()].sort().join(','));
        check('注册时留了日志（排查「格式化不生效」时唯一的抓手）',
            sandbox.logCalls.info.length === 2 &&
            sandbox.logCalls.info.every((row) => row.join(' ').includes('注册文档格式化提供器')),
            JSON.stringify(sandbox.logCalls.info));

        {
            const before = sandbox.registrations.length;
            const infoBefore = sandbox.logCalls.info.length;
            full.fn.call(manager);
            rangeM.fn.call(manager);
            check('重复注册被去重：provider 不会叠上去，也不重复记日志',
                sandbox.registrations.length === before &&
                manager._clangFormatProviders.size === 4 && sandbox.logCalls.info.length === infoBefore,
                `新增注册 ${sandbox.registrations.length - before} 条`);
        }

        const cppFull = fullRegs.find((row) => row.language === 'cpp').provider;
        const cppRange = rangeRegs.find((row) => row.language === 'cpp').provider;
        const provideFull = cppFull && cppFull.provideDocumentFormattingEdits;
        const provideRange = cppRange && cppRange.provideDocumentRangeFormattingEdits;
        check('两个 provider 的接口方法都在',
            typeof provideFull === 'function' && typeof provideRange === 'function',
            `${typeof provideFull}/${typeof provideRange}`);
        check('区域 provider 带 displayName（Monaco 的格式化选择器认这个）',
            cppRange && cppRange.displayName === 'clang-format',
            cppRange ? String(cppRange.displayName) : '没有 provider');

        const LIVE = { isCancellationRequested: false };
        const DEAD = { isCancellationRequested: true };

        {
            const model = makeModel(['int  main( ) { }']);
            const edits = await provideFull(model, {}, LIVE);
            check('整文档格式化产出一条编辑，正文来自桥',
                Array.isArray(edits) && edits.length === 1 && edits[0].text === 'FORMATTED',
                JSON.stringify(edits));
            check('整文档格式化的 range 就是模型的完整范围（沙箱里没有 clangd，能算出来即证明没走 LSP）',
                JSON.stringify(edits[0].range) === JSON.stringify(model.getFullModelRange()),
                JSON.stringify(edits[0].range));
        }

        {
            bridge.calls.length = 0;
            check('model 缺失或已销毁时不发请求、返回空编辑',
                (await provideFull(null, {}, LIVE)).length === 0 &&
                (await provideFull(makeModel(['x'], { disposed: true }), {}, LIVE)).length === 0 &&
                bridge.calls.length === 0,
                `calls=${bridge.calls.length}`);

            const r = await provideFull(makeModel(['x']), {}, DEAD);
            check('token 已取消时直接返回空，不去 spawn clang-format',
                r.length === 0 && bridge.calls.length === 0, JSON.stringify(r));

            const lateCancel = makeModel(['x']);
            bridge.onCall = () => { LIVE.isCancellationRequested = true; };
            const r2 = await provideFull(lateCancel, {}, LIVE);
            bridge.onCall = null;
            LIVE.isCancellationRequested = false;
            check('await 期间被取消：结果丢掉，不把过期正文写回编辑器',
                r2.length === 0, JSON.stringify(r2));

            const lateDispose = makeModel(['x']);
            bridge.onCall = () => { lateDispose.flags.disposed = true; };
            const r3 = await provideFull(lateDispose, {}, LIVE);
            bridge.onCall = null;
            check('await 期间文件被关掉：同样丢掉结果',
                r3.length === 0, JSON.stringify(r3));

            const stale = makeModel(['x']);
            bridge.reply = () => null;
            const r4 = await provideFull(stale, {}, LIVE);
            bridge.reply = () => 'FORMATTED';
            check('桥判定结果过期（返回 null）时不产出编辑',
                r4.length === 0, JSON.stringify(r4));

            bridge.reply = () => { throw new Error('clang-format 未找到：D:/x'); };
            const r5 = await provideFull(makeModel(['x']), {}, LIVE);
            bridge.reply = () => 'FORMATTED';
            const lastWarn = sandbox.logCalls.warn[sandbox.logCalls.warn.length - 1] || [];
            check('桥抛错时 provider 吞成空编辑并把原因记进日志',
                r5.length === 0 && lastWarn.join(' ').includes('clang-format 未找到'),
                JSON.stringify({ edits: r5, warn: lastWarn }));
        }

        {
            bridge.calls.length = 0;
            const model = makeModel(['line1', 'line2', 'line3']);
            const range = { startLineNumber: 2, endLineNumber: 2 };
            const edits = await provideRange(model, range, {}, LIVE);
            check('区域格式化把 Monaco 给的 range 原样转给桥',
                bridge.calls.length === 1 && bridge.calls[0].range === range,
                JSON.stringify(bridge.calls[0] && bridge.calls[0].range));

            bridge.calls.length = 0;
            bridge.onCall = () => { model.lines[2] = 'line3-typed-by-user'; };
            bridge.reply = () => 'line1\nLINE2\nline3';
            const e2 = await provideRange(model, { startLineNumber: 2, endLineNumber: 2 }, {}, LIVE);
            bridge.onCall = null;
            bridge.reply = () => 'FORMATTED';
            check('区域格式化只改写真正变了的那一行：await 期间用户改了第 3 行也不跟着重写',
                e2.length === 1 && e2[0].text === 'LINE2' &&
                e2[0].range.startLineNumber === 2 && e2[0].range.endLineNumber === 2,
                JSON.stringify(e2));

            model.lines[2] = 'line3';
            bridge.calls.length = 0;
            const rNull = await provideRange(model, range, {}, LIVE);
            bridge.reply = () => null;
            const rNull2 = await provideRange(model, range, {}, LIVE);
            bridge.reply = () => 'FORMATTED';
            check('区域格式化同样不吃过期结果', rNull.length === 1 && rNull2.length === 0,
                JSON.stringify({ ok: rNull.length, stale: rNull2.length }));

            const disposed = makeModel(['a', 'b'], { disposed: false });
            bridge.onCall = () => { disposed.flags.disposed = true; };
            const rD = await provideRange(disposed, range, {}, LIVE);
            bridge.onCall = null;
            check('await 期间文档销毁：区域格式化返回空', rD.length === 0, JSON.stringify(rD));

            bridge.calls.length = 0;
            const early = await provideRange(null, range, {}, LIVE);
            const cancelled = await provideRange(makeModel(['a']), range, {}, DEAD);
            check('空文档早退不抛；token 已取消时连请求都不发（不白等一次 clang-format spawn）',
                early.length === 0 && cancelled.length === 0 && bridge.calls.length === 0,
                JSON.stringify({ early, cancelled, calls: bridge.calls.length }));

            bridge.reply = () => { throw new Error('范围格式化炸了'); };
            const rT = await provideRange(makeModel(['a']), range, {}, LIVE);
            bridge.reply = () => 'FORMATTED';
            const warnT = sandbox.logCalls.warn[sandbox.logCalls.warn.length - 1] || [];
            check('区域格式化失败也只返回空编辑并留日志',
                rT.length === 0 && warnT.join(' ').includes('范围格式化炸了'),
                JSON.stringify({ edits: rT, warn: warnT }));
        }

        // -----------------------------------------------------------------------
        // buildMinimalFormatEdits 单独测：它是「只改写受影响行」这条修复的全部实现，
        // 上面那些场景只覆盖了它被调用的那一路。
        // -----------------------------------------------------------------------
        {
            const m = minimal.fn;
            check('buildMinimalFormatEdits 抽取成功', typeof m === 'function');
            check('正文没变就不产出编辑（避免空 undo 记录）',
                m.call(manager, makeModel(['a', 'b']), 'a\nb', 'a\nb').length === 0);
            {
                // 行尾 \r 只让逐行比较相等，overall 字符串仍不等，所以走的是
                // 「prefix 吃满、末尾零宽改写」这条路，而不是早退。锁的语义是
                // 「不重写任何正文」—— 将来若改成直接返回 []，这条照样过。
                const e = m.call(manager, makeModel(['a', 'b']), 'a\r\nb', 'a\nb');
                check('只差行尾 \\r 时不重写任何正文（不剥 \r 就逐行不等，会退化成整篇替换）',
                    e.length <= 1 && e.every((row) => row.text === ''), JSON.stringify(e));
                const e2 = m.call(manager, makeModel(['a', 'b', 'c']), 'a\r\nb\r\nc', 'a\nb\nc');
                check('逐行只差 \\r 时同样不重写正文',
                    e2.every((row) => row.text === ''), JSON.stringify(e2));
            }
            check('非字符串输入直接返回空，不抛进 Monaco',
                m.call(manager, makeModel(['a']), null, 'x').length === 0 &&
                m.call(manager, makeModel(['a']), 'x', undefined).length === 0);
            {
                const e = m.call(manager, makeModel(['a', 'b', 'c']), 'a\nb\nc', 'a\nB\nc');
                check('中间一行变了就只覆盖那一行，列从行首开始',
                    e.length === 1 && e[0].text === 'B' &&
                    e[0].range.startLineNumber === 2 && e[0].range.endLineNumber === 2 &&
                    e[0].range.startColumn === 1, JSON.stringify(e));
            }

            {
                const e = m.call(manager, makeModel(['a', 'b']), 'a\nb', 'a\nX\nb');
                check('纯插入一行：改写区间收成第 2 行行首的零宽范围',
                    e.length === 1 && e[0].range.startLineNumber === 2 &&
                    e[0].range.endLineNumber === 2 && e[0].range.endColumn === 1 &&
                    e[0].text === 'X', JSON.stringify(e));
            }
            {
                const e = m.call(manager, makeModel(['a', 'b', 'c', 'd']), 'a\nb\nc\nd', 'a\nd');
                check('删掉中间一大段：改写区间跟着缩',
                    e.length === 1 && e[0].range.startLineNumber === 2 &&
                    e[0].range.endLineNumber === 3 && e[0].text === '',
                    JSON.stringify(e));
            }
            {
                const e = m.call(manager, makeModel(['a', 'b']), 'a\nb', 'zz\nyy');
                check('整篇重排时退化成全文替换（但至少仍是一条编辑）',
                    e.length === 1 && e[0].range.startLineNumber === 1 &&
                    e[0].range.endLineNumber === 2 && e[0].text === 'zz\nyy',
                    JSON.stringify(e));
            }
            {
                const e = m.call(manager, makeModel(['a', 'b', 'c', 'd']), 'a\nb\nc\nd', 'A\nb\nc\nD');
                check('两处分散的改动合成一条编辑（Monaco 只记一次 undo）',
                    e.length === 1 && e[0].range.startLineNumber === 1 &&
                    e[0].range.endLineNumber === 4 && e[0].text === 'A\nb\nc\nD',
                    JSON.stringify(e));
            }
            {
                const e = m.call(manager, makeModel(['x', '  indented', 'y']),
                    'x\n  indented\ny', 'x\n\tindented\ny');
                check('缩进改动只重写那一行，endColumn 取该行最大列',
                    e.length === 1 && e[0].range.startLineNumber === 2 &&
                    e[0].text === '\tindented' &&
                    e[0].range.endColumn === ('  indented'.length + 1),
                    JSON.stringify(e));
            }
            {
                const noMaxColumn = makeModel(['a', 'b']);
                delete noMaxColumn.getLineMaxColumn;
                const e = m.call(manager, noMaxColumn, 'a\nb', 'a\nB');
                check('模型没有 getLineMaxColumn 时 endColumn 兜到 1，不抛',
                    e.length === 1 && e[0].range.endColumn === 1, JSON.stringify(e));
            }
            {
                const e = m.call(manager, makeModel(['a', 'b', 'c']), 'a\nb\nc', 'a\nb');
                check('删掉末尾一行：改写区间落在被删的那一行上',
                    e.length === 1 && e[0].range.startLineNumber === 3 &&
                    e[0].range.endLineNumber === 3 && e[0].text === '',
                    JSON.stringify(e));
            }
        }
    }

    const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    // 主进程侧的解析与 IPC：这四条原来是 includes() 读源码长相 —— 回退顺序写反、
    // 打包基准目录从 resourcesPath 换成 __dirname、缓存标记忘记置位，字符串全都照样命中。
    // 现在按场景搭 vm 沙箱：existsSync/statSync 由集合驱动并记账，
    // 每次落在哪个候选上、走没走过 PATH 都能数出来。
    const USER_DATA_DIR_NAME = (mainSource.match(/const USER_DATA_DIR_NAME\s*=\s*'([^']+)'/) || [])[1];
    const RESOLVER_LETS = mainSource.match(
        /^let (?:cachedClangFormatExecutablePath|clangFormatExecutablePathResolved)[^\n]*$/gm) || [];
    const CACHE_LIMIT = Number((mainSource.match(/^const CLANG_FORMAT_RESULT_CACHE_LIMIT\s*=\s*(\d+)/m) || [])[1]);

    const RESOLVER_NAMES = [
        'getClangdPlatformKey', 'getUserClangdRoot', 'getClangFormatExecutableName',
        'resolveClangFormatRootFromBundle', 'resolveClangFormatExecutable',
        'findClangFormatExecutableOnPath', 'describeClangFormatSearchPaths',
        'resolveClangFormatExecutablePath', 'cacheClangFormatResult'
    ];

    function makeMainFormatSandbox(opts = {}) {
        const {
            isPackaged = false,
            platform = 'linux',
            resourcesPath = '/pkg/resources',
            homedir = '/home/tester',
            env = {},
            exists = [],
            pathFiles = [],
            pathDirs = [],
            pathThrows = []
        } = opts;
        const fsCalls = { exists: [], stat: [] };
        const existsSet = new Set(exists);
        const fileSet = new Set(pathFiles);
        const dirSet = new Set(pathDirs);
        const throwSet = new Set(pathThrows);
        const logErrors = [];
        const ctx = vm.createContext({
            __fns: {},
            path, JSON, Math, Number, String, Boolean, Array, Object, Error, RegExp, Promise, Map, Set,
            os: { homedir: () => homedir },
            app: { isPackaged },
            process: { platform, resourcesPath, env },
            __dirname: '/app/src',
            USER_DATA_DIR_NAME,
            CLANG_FORMAT_RESULT_CACHE_LIMIT: CACHE_LIMIT,
            clangFormatInFlight: new Map(),
            clangFormatResultCache: new Map(),
            logError: (...a) => { logErrors.push(a.map(String)); },
            fs: {
                existsSync: (candidate) => { fsCalls.exists.push(candidate); return existsSet.has(candidate); },
                statSync: (candidate) => {
                    fsCalls.stat.push(candidate);
                    if (throwSet.has(candidate)) throw new Error(`ENOENT: no such file, '${candidate}'`);
                    if (dirSet.has(candidate)) return { isFile: () => false };
                    if (fileSet.has(candidate)) return { isFile: () => true };
                    throw new Error(`ENOENT: no such file, '${candidate}'`);
                }
            }
        });
        vm.runInContext(RESOLVER_LETS.join('\n'), ctx);
        const { fns, missing } = compileFuncs(mainSource, RESOLVER_NAMES, ctx);
        // 锚点不能停在 'format-cpp-code' —— 参数默认值 request = {} 里那对花括号
        // 会先被配平走，抽出来只剩个空函数体。这里吃到第一个 `) =>` 为止，
        // 但不锁形参名（改名不算破坏行为）。
        const handlerBody = callbackBody(mainSource, /ipcMain\.handle\('format-cpp-code'[\s\S]*?\)\s*=>/);
        let handler;
        if (handlerBody) {
            vm.runInContext(`this.__fns.handler = async (_event, request = {}) => ${handlerBody};`, ctx);
            handler = ctx.__fns.handler;
        }
        const formatter = {
            calls: [],
            // 把参与缓存键的字段都编进正文：缓存认错一项，断言立刻看出来
            impl: (req) => Promise.resolve({
                content: `[${req.content}|${req.filePath}|${req.startLine}|${req.styleRaw}]`
            })
        };
        ctx.formatCodeWithClangFormat = (req) => {
            formatter.calls.push({ ...req });
            return formatter.impl(req);
        };
        const resetResolveCache = () => vm.runInContext(
            'cachedClangFormatExecutablePath = undefined;\nclangFormatExecutablePathResolved = false;', ctx);
        const inFlightSize = () => ctx.clangFormatInFlight.size;
        const cacheSize = () => ctx.clangFormatResultCache.size;
        return {
            ctx, fns, missing, handler, handlerBody, fsCalls, logErrors, formatter,
            resetResolveCache, inFlightSize, cacheSize
        };
    }

    const HOME = '/home/tester';
    const userRoot = () => path.join(HOME, USER_DATA_DIR_NAME, 'LSP');
    const userExe = (exe = 'clang-format') => path.join(userRoot(), 'bin', exe);
    const devRoot = (key = 'linux') => path.join('/app/src', '..', 'build', 'clang-format', key);
    const devExe = (exe = 'clang-format') => path.join(devRoot(), 'bin', exe);
    const pkgExe = (exe = 'clang-format') => path.join('/pkg/resources', 'clang-format', 'bin', exe);

    {
        const sb = makeMainFormatSandbox();
        check('主进程函数与 IPC handler 抽取成功',
            sb.missing.length === 0 && typeof sb.handler === 'function' &&
            sb.handlerBody.length > 400 &&
            RESOLVER_LETS.length === 2 && CACHE_LIMIT > 0,
            JSON.stringify({ missing: sb.missing, handler: typeof sb.handler, body: sb.handlerBody.length, lets: RESOLVER_LETS.length, limit: CACHE_LIMIT }));
        check('exe 名按平台走（win32 才带 .exe）',
            sb.fns.getClangFormatExecutableName &&
            makeMainFormatSandbox({ platform: 'win32' }).fns.getClangFormatExecutableName() === 'clang-format.exe' &&
            sb.fns.getClangFormatExecutableName() === 'clang-format');

        {
            const dev = makeMainFormatSandbox({ exists: [devRoot(), devExe()] });
            check('开发态以 build/clang-format/<平台键> 为基准目录并命中包内 clang-format',
                dev.fns.resolveClangFormatRootFromBundle() === devRoot() &&
                dev.fns.resolveClangFormatExecutablePath() === devExe(),
                String(dev.fns.resolveClangFormatExecutablePath()));
            const pkg = makeMainFormatSandbox({ isPackaged: true, exists: ['/pkg/resources/clang-format', pkgExe()] });
            check('打包态改按 process.resourcesPath 解析（换成 __dirname 就等于装完即失效）',
                pkg.fns.resolveClangFormatRootFromBundle() === path.join('/pkg/resources', 'clang-format') &&
                pkg.fns.resolveClangFormatExecutablePath() === pkgExe(),
                String(pkg.fns.resolveClangFormatExecutablePath()));
            const win = makeMainFormatSandbox({
                isPackaged: true, platform: 'win32',
                exists: ['/pkg/resources/clang-format', pkgExe('clang-format.exe')]
            });
            check('打包 + win32 解析到 clang-format.exe',
                win.fns.resolveClangFormatExecutablePath() === pkgExe('clang-format.exe'),
                String(win.fns.resolveClangFormatExecutablePath()));
        }

        {
            const order = makeMainFormatSandbox({ exists: [userRoot(), userExe()] });
            check('包内目录缺失时回退到用户 LSP 目录（与 clangd 同级）',
                order.fns.resolveClangFormatExecutablePath() === userExe(),
                String(order.fns.resolveClangFormatExecutablePath()));
            const both = makeMainFormatSandbox({
                isPackaged: true,
                exists: ['/pkg/resources/clang-format', pkgExe(), userRoot(), userExe()]
            });
            check('两处都有时用包内的那份，不再去看用户目录',
                both.fns.resolveClangFormatExecutablePath() === pkgExe() &&
                !both.fsCalls.exists.includes(userExe()),
                JSON.stringify(both.fsCalls.exists));
            const onPath = makeMainFormatSandbox({
                env: { PATH: ['/opt/llvm/bin', '/usr/bin'].join(path.delimiter) },
                pathFiles: ['/usr/bin/clang-format']
            });
            check('两处都没有时退到 PATH，逐条试到命中为止',
                onPath.fns.resolveClangFormatExecutablePath() === '/usr/bin/clang-format' &&
                JSON.stringify(onPath.fsCalls.stat) ===
                    JSON.stringify(['/opt/llvm/bin/clang-format', '/usr/bin/clang-format']),
                JSON.stringify(onPath.fsCalls.stat));
            const quoted = makeMainFormatSandbox({
                env: { PATH: `"${path.sep}opt${path.sep}my dir"${path.delimiter}/usr/bin` },
                pathFiles: [`/opt/my dir${path.sep}clang-format`]
            });
            check('PATH 里带引号/空格的条目能正确还原',
                quoted.fns.resolveClangFormatExecutablePath() === `/opt/my dir${path.sep}clang-format`,
                String(quoted.fns.resolveClangFormatExecutablePath()));
            const dirEntry = makeMainFormatSandbox({
                env: { PATH: ['/first', '/second'].join(path.delimiter) },
                pathDirs: ['/first/clang-format'],
                pathFiles: ['/second/clang-format']
            });
            check('PATH 命中的是个目录时继续往下找（不当成可执行文件返回）',
                dirEntry.fns.resolveClangFormatExecutablePath() === '/second/clang-format' &&
                dirEntry.fsCalls.stat.length === 2,
                JSON.stringify(dirEntry.fsCalls.stat));
            const broken = makeMainFormatSandbox({
                env: { PATH: ['/first', '', '/second'].join(path.delimiter) },
                pathThrows: ['/first/clang-format'],
                pathFiles: ['/second/clang-format']
            });
            check('PATH 条目 stat 抛错被吞掉、空条目不产出候选',
                broken.fns.resolveClangFormatExecutablePath() === '/second/clang-format' &&
                broken.fsCalls.stat.length === 2,
                JSON.stringify(broken.fsCalls.stat));
            const none = makeMainFormatSandbox({ env: { PATH: '/usr/bin' } });
            check('三处都找不到时返回 null，而不是抛出或返回假路径',
                none.fns.resolveClangFormatExecutablePath() === null,
                String(none.fns.resolveClangFormatExecutablePath()));
        }

        {
            const cached = makeMainFormatSandbox({
                env: { PATH: '/opt/llvm/bin' }, pathFiles: ['/opt/llvm/bin/clang-format']
            });
            const first = cached.fns.resolveClangFormatExecutablePath();
            const existsOnce = cached.fsCalls.exists.length;
            const statOnce = cached.fsCalls.stat.length;
            const second = cached.fns.resolveClangFormatExecutablePath();
            check('解析结果按进程缓存：第二次不再遍历 PATH',
                second === first && cached.fsCalls.exists.length === existsOnce &&
                cached.fsCalls.stat.length === statOnce,
                JSON.stringify({ first, existsOnce, statOnce, after: cached.fsCalls.stat.length }));
            cached.resetResolveCache();
            const third = cached.fns.resolveClangFormatExecutablePath();
            check('缓存标记复位后确实会重新解析（说明上面那条是缓存在起作用）',
                third === first && cached.fsCalls.stat.length === statOnce * 2,
                JSON.stringify({ statNow: cached.fsCalls.stat.length }));
        }

        {
            const bare = makeMainFormatSandbox();
            check('rootDir 为空时直接判不可用（不拿 undefined 去拼路径）',
                bare.fns.resolveClangFormatExecutable(null) === null &&
                bare.fns.resolveClangFormatExecutable('') === null &&
                bare.fsCalls.exists.length === 0);
            const noBin = makeMainFormatSandbox({ exists: [devRoot()] });
            check('基准目录在但 bin 里没有可执行文件时返回 null（不把目录本身当结果）',
                noBin.fns.resolveClangFormatExecutable(devRoot()) === null &&
                noBin.fsCalls.exists.includes(devExe()));
        }

        {
            const pkg = makeMainFormatSandbox({ isPackaged: true });
            const listed = String(pkg.fns.describeClangFormatSearchPaths()).split(' | ');
            check('报错文案里的搜索路径就是解析真正走过的三处（打包态）',
                listed.length === 3 && listed[0] === pkgExe() && listed[1] === userExe() && listed[2] === 'PATH',
                JSON.stringify(listed));
            const dev = makeMainFormatSandbox({ platform: 'darwin' });
            const devListed = String(dev.fns.describeClangFormatSearchPaths()).split(' | ');
            check('开发态的报错文案跟着 build/clang-format/<平台键> 走',
                devListed[0] === path.join(devRoot('darwin'), 'bin', 'clang-format'),
                JSON.stringify(devListed));
        }
    }

    {
        const REQ = {
            content: 'int  main( ) { }',
            filePath: '/proj/a.cpp',
            style: 'Google',
            styleRaw: '{ BasedOnStyle:  Google }',
            fallbackStyle: 'LLVM',
            startLine: 2,
            endLine: 5
        };
        const missing = makeMainFormatSandbox({ env: { PATH: '' } });
        const reply = await missing.handler(null, REQ);
        const errText = String(reply && reply.error);
        check('找不到 clang-format 时把搜索过的路径原样带回渲染层',
            reply && reply.ok === false && errText.includes('clang-format not found') &&
            errText.includes(devExe()) && errText.includes(userExe()) && errText.includes('PATH'),
            errText);
        check('缺失原因里不塞构建指令（用户装的是安装包，跑不了 pnpm）',
            !/pnpm|prebuild/i.test(errText), errText);
        check('缺失时完全不启动格式化进程',
            missing.formatter.calls.length === 0);

        const ok1 = makeMainFormatSandbox({ exists: [devRoot(), devExe()] });
        const r1 = await ok1.handler(null, REQ);
        check('格式化成功回 {ok:true, content}，正文原样透传',
            r1 && r1.ok === true && typeof r1.content === 'string',
            JSON.stringify(r1));
        const sent = ok1.formatter.calls[0] || {};
        check('请求字段逐个转给格式化服务，可执行文件用解析出来的那份',
            sent.executablePath === devExe() && sent.content === REQ.content &&
            sent.filePath === REQ.filePath && sent.style === REQ.style &&
            sent.styleRaw === REQ.styleRaw && sent.fallbackStyle === REQ.fallbackStyle &&
            sent.startLine === REQ.startLine && sent.endLine === REQ.endLine,
            JSON.stringify(sent));

        const served = (req) => `[${req.content}|${req.filePath}|${req.startLine}|${req.styleRaw}]`;
        const r2 = await ok1.handler(null, REQ);
        check('相同请求第二次命中结果缓存，不再 spawn clang-format',
            r2.ok === true && r2.content === served(REQ) &&
            ok1.formatter.calls.length === 1,
            `calls=${ok1.formatter.calls.length} content=${r2.content}`);
        const r3 = await ok1.handler(null, { ...REQ, content: 'int main(){}' });
        check('正文不同就是不同缓存项（不能把上一份结果端出去）',
            ok1.formatter.calls.length === 2 && r3.content === served({ ...REQ, content: 'int main(){}' }),
            `calls=${ok1.formatter.calls.length} content=${r3.content}`);
        const varied = [
            await ok1.handler(null, { ...REQ, styleRaw: '{ IndentWidth: 4 }' }),
            await ok1.handler(null, { ...REQ, startLine: 3 }),
            await ok1.handler(null, { ...REQ, filePath: '/proj/b.cpp' })
        ];
        check('styleRaw / 行号 / 文件路径都参与缓存键',
            ok1.formatter.calls.length === 5 && ok1.cacheSize() === 5 &&
            new Set(varied.map((row) => row.content)).size === 3,
            JSON.stringify({ calls: ok1.formatter.calls.length, size: ok1.cacheSize(), varied }));

        const gate = (() => {
            let resolve; let reject;
            const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
            return { promise, resolve, reject };
        })();
        const inflight = makeMainFormatSandbox({ exists: [devRoot(), devExe()] });
        inflight.formatter.impl = () => gate.promise;
        const pA = inflight.handler(null, REQ);
        const pB = inflight.handler(null, REQ);
        check('同一请求并发只排队一次（在途合并）',
            inflight.formatter.calls.length === 1 && inflight.inFlightSize() === 1,
            `calls=${inflight.formatter.calls.length} inFlight=${inflight.inFlightSize()}`);
        gate.resolve({ content: 'FORMATTED' });
        const [rA, rB] = await Promise.all([pA, pB]);
        check('合并的两路都拿到同一份结果',
            rA.ok === true && rB.ok === true && rA.content === rB.content,
            JSON.stringify({ rA, rB }));
        check('在途表结算后必须清空（漏清就永远不再重算）',
            inflight.inFlightSize() === 0, `inFlight=${inflight.inFlightSize()}`);

        const boom = makeMainFormatSandbox({ exists: [devRoot(), devExe()] });
        boom.formatter.impl = () => Promise.reject(new Error('clang-format 解析失败: line 3'));
        const rb = await boom.handler(null, REQ);
        check('格式化失败回 {ok:false, error} 并把原始原因带回去',
            rb.ok === false && rb.error === 'clang-format 解析失败: line 3', JSON.stringify(rb));
        check('失败被记进日志（渲染层只看返回值，主进程不留日志就查不到）',
            boom.logErrors.length === 1 &&
            boom.logErrors[0].join(' ').includes('clang-format 解析失败: line 3'),
            JSON.stringify(boom.logErrors));
        check('失败结果不进缓存，下一次会真重试',
            boom.cacheSize() === 0 && boom.inFlightSize() === 0,
            JSON.stringify({ cache: boom.cacheSize(), inFlight: boom.inFlightSize() }));
        boom.formatter.impl = (req) => Promise.resolve({ content: served(req) });
        const rb2 = await boom.handler(null, REQ);
        check('重试成功（失败没有被当成结果缓存下来）',
            rb2.ok === true && rb2.content === served(REQ), JSON.stringify(rb2));

        {
            const many = makeMainFormatSandbox({ exists: [devRoot(), devExe()] });
            const bodies = [];
            for (let i = 0; i < CACHE_LIMIT; i += 1) {
                const one = await many.handler(null, { ...REQ, content: `c${i}` });
                bodies.push(one.content);
            }
            check('灌满缓存：每条都拿到自己的正文，一条没多 spawn',
                bodies.every((body, i) => body === served({ ...REQ, content: `c${i}` })) &&
                many.formatter.calls.length === CACHE_LIMIT && many.cacheSize() === CACHE_LIMIT,
                `size=${many.cacheSize()} calls=${many.formatter.calls.length}`);
            await many.handler(null, { ...REQ, content: 'c-new' });
            check('超上限时淘汰一条，且只多一次 spawn',
                many.cacheSize() === CACHE_LIMIT && many.formatter.calls.length === CACHE_LIMIT + 1,
                `size=${many.cacheSize()} calls=${many.formatter.calls.length}`);
            const stillThere = await many.handler(null, { ...REQ, content: 'c-new' });
            const top = await many.handler(null, { ...REQ, content: `c${CACHE_LIMIT - 1}` });
            check('没被淘汰的条目继续命中，正文不会被串位',
                many.formatter.calls.length === CACHE_LIMIT + 1 &&
                stillThere.content === served({ ...REQ, content: 'c-new' }) &&
                top.content === served({ ...REQ, content: `c${CACHE_LIMIT - 1}` }),
                JSON.stringify({ stillThere, top }));
        }
        {
            const bareReq = makeMainFormatSandbox({ exists: [devRoot(), devExe()] });
            await bareReq.handler(null, { content: 'x' });
            const got = bareReq.formatter.calls[0];
            check('缺省请求也照转（未给的字段留空，不在这里瞎补默认值）',
                bareReq.formatter.calls.length === 1 && got.content === 'x' &&
                got.filePath === undefined && got.style === undefined &&
                got.startLine === undefined && got.fallbackStyle === undefined,
                JSON.stringify(got));
            let bareErr = null;
            let bareReply = null;
            try { bareReply = await bareReq.handler(null, undefined); }
            catch (e) { bareErr = e; }
            check('request 整个缺失也不抛（IPC 返回值必须是对象）',
                bareErr === null && bareReply && typeof bareReply.ok === 'boolean',
                JSON.stringify({ err: bareErr && String(bareErr), reply: bareReply }));
        }
    }

    const installerSource = fs.readFileSync(path.join(root, 'installer.nsi'), 'utf8');

    // 下面这几条留作文本守卫，理由写在这：
    // - cmd start 那两条是历史故障 H16 的「反面」断言 —— 它锁的是某段写法不存在，
    //   而那段代码在 run 主流程的巨型函数里，抽出来跑等于要把整条运行链路搬进沙箱；
    //   构建链的行为已经由上面的 pauser 沙箱覆盖，这里只补「别退回 cmd /c start」。
    // - consolepauser 的 C 源码是要拿去 g++ 编译的源文本，CI 上没有 MinGW，
    //   能跑的只有「字符串本身」这一层，改成行为守卫就得真编译。

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
    {
        const ps = (o = {}) => makePauserSandbox({ src: mainSource, userDataDirName: USER_DATA_DIR_NAME, ...o });
        const ok = ps();
        const FIRST = String(ok.fns.getConsolePauserSourceFingerprint &&
            ok.fns.getConsolePauserSourceFingerprint());
        check('consolepauser 构建链抽取成功（函数抽不到就别再往下断言）',
            ok.missing.length === 0 && typeof ok.fns.ensureConsolePauserExecutable === 'function',
            JSON.stringify({ missing: ok.missing }));
        check('指纹文件挂在 exe 旁边，内容就是当前 C 源码的 sha256',
            ok.fns.getConsolePauserTargetPath() === ok.targetPath &&
                ok.fns.getConsolePauserFingerprintPath() === `${ok.targetPath}.src.sha256` &&
                FIRST === ok.fingerprintOf('PAUSER-C-SOURCE') && FIRST.length === 64,
            JSON.stringify({ fp: FIRST.slice(0, 12), path: ok.fns.getConsolePauserFingerprintPath() }));
        await ok.attempt();
        check('第一次编译就带 -static（静态链接，免得用户机器缺 libgcc/libstdc++ DLL）',
            ok.builds.length === 1 && ok.argsAt(0).includes('-static') &&
                ok.argsAt(0).includes('-O2') &&
                ok.argsAt(0)[ok.argsAt(0).indexOf('-o') + 1] === ok.targetPath &&
                ok.argsAt(0).includes(ok.cppPath),
            JSON.stringify(ok.argsAt(0)));
        check('构建成功后把当前源码指纹写进指纹文件，日志里写清用的哪条策略',
            String(ok.files.get(path.resolve(ok.fingerprintPath))) === FIRST &&
                ok.logs.info.join(' ').includes('utf8-static'),
            JSON.stringify({ written: String(ok.files.get(path.resolve(ok.fingerprintPath))).slice(0, 12), logs: ok.logs.info }));
        check('spawn 用 shell:false、cwd 在用户目录、stdio 全 pipe（不能退回 cmd 包装）',
            ok.builds[0].options.shell === false &&
                ok.builds[0].options.cwd === path.resolve(path.dirname(ok.targetPath)) &&
                JSON.stringify(ok.builds[0].options.stdio) === JSON.stringify(['ignore', 'pipe', 'pipe']),
            JSON.stringify(ok.builds[0].options));
        check('findConsolePauser 只有 exe 真在才返回路径',
            ps({ files: [] }).fns.findConsolePauser() === null &&
                ok.fns.findConsolePauser() === ok.targetPath,
            String(ok.fns.findConsolePauser()));
        check('编译器不存在时 PATH 前缀是空数组（不把不存在的路径塞进去）',
            JSON.stringify(ok.fns.getCompilerRuntimeBinPaths('/nope/g++.exe')) === '[]');

        const other = ps({ platform: 'linux' });
        check('非 Windows 直接返回 null，一次编译都不发（POSIX 有自己的终端，不需要 pauser）',
            await other.attempt() === null && other.builds.length === 0 && other.writes.length === 0,
            JSON.stringify({ builds: other.builds.length }));
        const warm = ps({ files: [ok.targetPath], contents: { [ok.fingerprintPath]: FIRST } });
        check('exe 在、指纹也对 → 直接复用，一次 g++ 都不发',
            await warm.attempt() === warm.targetPath && warm.builds.length === 0,
            JSON.stringify({ builds: warm.builds.length }));
        const noRecord = ps({ files: [ok.targetPath] });
        await noRecord.attempt();
        check('有 exe 但没有指纹记录，也按旧版处理重编一次',
            noRecord.builds.length === 1 &&
                noRecord.logs.info.join(' ').includes('源码指纹不匹配'),
            JSON.stringify({ builds: noRecord.builds.length, logs: noRecord.logs.info }));
        const stale = ps({ files: [ok.targetPath], contents: { [ok.fingerprintPath]: 'deadbeef' } });
        await stale.attempt();
        check('C 源码改过（指纹对不上）必须重编，并记下新指纹，否则用户永远跑旧 exe',
            stale.builds.length === 1 &&
                String(stale.files.get(path.resolve(stale.fingerprintPath))) === FIRST,
            JSON.stringify({ builds: stale.builds.length }));

        const noCompiler = ps({ compilerExists: false });
        let ncErr = null;
        try { await noCompiler.attempt(); } catch (e) { ncErr = e; }
        let blankErr = null;
        try { await ps().attempt(''); } catch (e) { blankErr = e; }
        check('没装编译器时报「缺编译器」，不写 .cpp、不发 spawn',
            ncErr !== null && /error\.consolePauserNoCompiler/.test(String(ncErr.message)) &&
                noCompiler.builds.length === 0 && noCompiler.writes.length === 0 &&
                blankErr !== null && /error\.consolePauserNoCompiler/.test(String(blankErr.message)),
            JSON.stringify({ nc: String(ncErr && ncErr.message), blank: String(blankErr && blankErr.message) }));

        const fb = ps({ succeed: (args) => !args.includes('-static') });
        const fbPath = await fb.attempt();
        check('静态链接失败会退到不带 -static 的第二次尝试，成功照样返回路径',
            fb.builds.length === 2 && fb.argsAt(0).includes('-static') &&
                !fb.argsAt(1).includes('-static') && fbPath === fb.targetPath,
            JSON.stringify(fb.builds.map((b) => b.args)));
        const allBad = ps({ succeed: () => false, stderrText: 'cc1plus: fatal error: no input files' });
        let abErr = null;
        try { await allBad.attempt(); } catch (e) { abErr = e; }
        check('四条策略全失败才抛错，错误里要能看出每次尝试的退出码与 stderr',
            abErr !== null && /error\.consolePauserBuildFailed/.test(String(abErr.message)) &&
                (String(abErr.message).match(/exit=/g) || []).length === 4 &&
                String(abErr.message).includes('cc1plus: fatal error: no input files') &&
                !allBad.writes.some((w) => w.path === path.resolve(allBad.fingerprintPath)),
            String(abErr && abErr.message).slice(0, 220));
        const ghost = ps({ produceExe: false });
        let ghostErr = null;
        try { await ghost.attempt(); } catch (e) { ghostErr = e; }
        check('编译器返回 0 但没产出 exe 也算失败，四条策略都得走一遍',
            ghostErr !== null && ghost.builds.length === 4 &&
                !ghost.files.has(path.resolve(ghost.targetPath)),
            JSON.stringify({ builds: ghost.builds.length, err: String(ghostErr && ghostErr.message).slice(0, 60) }));
        const eno = ps({ spawnError: 'spawn /opt/mingw/bin/g++.exe ENOENT' });
        let enoErr = null;
        try { await eno.attempt(); } catch (e) { enoErr = e; }
        check('spawn 自身报错记成 exit=-1 并继续下一条策略（不能一条卡死整个构建）',
            enoErr !== null && String(enoErr.message).includes('exit=-1') && eno.builds.length === 4,
            String(enoErr && enoErr.message).slice(0, 160));

        const noIconv = ps({ iconvAvailable: false, succeed: () => false });
        let noIconvErr = null;
        try { await noIconv.attempt(); } catch (e) { noIconvErr = e; }
        // 缺 iconv 时必须「跳过 gbk 策略继续兜」，不能把 require 的异常抛穿：
        // 抛穿的话用户看到的是一条模块报错，而不是结构化失败详情
        check('缺 iconv-lite 时跳过两条 gbk 策略，只试两次、都按 utf8 写盘，仍以结构化失败报错',
            noIconv.builds.length === 2 && noIconv.writes.length === 2 &&
                noIconv.writes.every((w) => w.encoding === 'utf8' && !String(w.data).startsWith('GBK:')) &&
                noIconvErr !== null && String(noIconvErr.message).includes('error.consolePauserBuildFailed') &&
                (String(noIconvErr.message).match(/exit=/g) || []).length === 2,
            JSON.stringify({ builds: noIconv.builds.length, writes: noIconv.writes.length, err: String(noIconvErr && noIconvErr.message).slice(0, 80) }));
        const gbk = ps({ succeed: (args) => args.includes('-finput-charset=gbk') });
        await gbk.attempt();
        check('走到 gbk 策略时源码按 gbk 编码落盘（MinGW 按本地代码页读文件）',
            gbk.builds.length === 3 && gbk.argsAt(2).includes('-finput-charset=gbk') &&
                String(gbk.writtenCpp()).startsWith('GBK:PAUSER-C-SOURCE'),
            JSON.stringify({ builds: gbk.builds.length, cpp: String(gbk.writtenCpp()).slice(0, 24) }));

        const withDirs = ps({ files: ['/opt/mingw/bin', '/opt/mingw/mingw64/bin'] });
        await withDirs.attempt();
        check('PATH 前缀只补真实存在的编译器目录，原 PATH 留在最后',
            withDirs.pathEnvOf(0).startsWith(`/opt/mingw/bin${path.delimiter}`) &&
                withDirs.pathEnvOf(0).includes('/opt/mingw/mingw64/bin') &&
                !withDirs.pathEnvOf(0).includes('/opt/mingw/mingw32/bin') &&
                withDirs.pathEnvOf(0).endsWith(`${path.delimiter}/usr/bin`),
            withDirs.pathEnvOf(0));
    }
    check('detached run failures are logged through the child exit code', mainSource.includes("logInfo('[运行] 子进程已退出:'"));

    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    check('build downloads standalone clang-format', packageJson.scripts['prebuild:clang-format'] === 'node scripts/run-node-compat.js scripts/download-clang-format.js');
    const packagedSources = ['win', 'mac', 'linux'].flatMap(platform => packageJson.build[platform].extraResources || []);
    check('standalone clang-format is packaged for every desktop platform', packagedSources.filter(item => item.to === 'clang-format').length === 3);

    // ---- 下载器：把 scripts/download-clang-format.js 真跑起来 ----
    // 原来是 downloaderSource.includes("'llvm/llvm-project'") && includes("'23.1.2'")：
    // 字符串出现在注释里也算命中，tag 拼错、回退条件反了、上限漏传全都照样绿。
    const downloaderSource = fs.readFileSync(path.join(root, 'scripts', 'download-clang-format.js'), 'utf8');
    const downloaderBlock = extractDownloaderBlock(downloaderSource);
    {
        const base = makeDownloaderSandbox({ block: downloaderBlock });
        const d = base.dl;
        check('下载器正文抽取成功（锚点失配就别再往下断言）',
            downloaderBlock.length > 2000 && base.runError === null && base.missing.length === 0,
            JSON.stringify({
                len: downloaderBlock.length,
                err: base.runError && String(base.runError.message),
                missing: base.missing
            }));
        check('默认从官方 LLVM 仓库取 23.1.2，tag 按版本推',
            d.repo === 'llvm/llvm-project' && d.version === '23.1.2' &&
            d.tag === 'llvmorg-23.1.2' && d.releaseTag === 'llvmorg-23.1.2',
            JSON.stringify({ repo: d.repo, version: d.version, tag: d.tag, releaseTag: d.releaseTag }));

        {
            const TABLE = [
                ['version', 'CLANG_FORMAT_VERSION', 'version', '18.1.8', '20.1.0'],
                ['tag', 'CLANG_FORMAT_TAG', 'tag', 'llvmorg-9.9.9', 'llvmorg-8.8.8'],
                ['repo', 'CLANG_FORMAT_REPO', 'repo', 'someone/else', 'other/else'],
                ['url', 'CLANG_FORMAT_DOWNLOAD_URL', 'directUrl', 'https://mirror/a.tar.xz', 'https://mirror/b.tar.xz'],
                ['digest', 'CLANG_FORMAT_SHA256', 'expectedDigest', 'deadbeef', 'cafebabe'],
                ['platform', 'OICPP_CLANG_FORMAT_PLATFORM', 'platform', 'linux', 'win32'],
                ['arch', 'OICPP_CLANG_FORMAT_ARCH', 'architecture', 'arm64', 'x64'],
                ['output', 'CLANG_FORMAT_OUTPUT', 'outputRoot', '/tmp/one', '/tmp/two']
            ];
            const bad = [];
            for (const [flag, envName, binding, envValue, cliValue] of TABLE) {
                const fromEnv = makeDownloaderSandbox({ block: downloaderBlock, env: { [envName]: envValue } }).dl[binding];
                const fromArg = makeDownloaderSandbox({
                    block: downloaderBlock,
                    env: { [envName]: envValue },
                    argv: [`--${flag}`, cliValue]
                }).dl[binding];
                const want = binding === 'outputRoot' ? path.resolve(envValue) : envValue;
                const wantArg = binding === 'outputRoot' ? path.resolve(cliValue) : cliValue;
                if (fromEnv !== want) bad.push(`${flag}:env=${fromEnv}`);
                if (fromArg !== wantArg) bad.push(`${flag}:arg=${fromArg}`);
            }
            check('每个配置项都是「命令行参数 > 环境变量 > 内置默认」，两级都不能被吞',
                bad.length === 0, bad.join(' '));
            const defaults = [
                ['version', d.version, '23.1.2'], ['tag', d.tag, 'llvmorg-23.1.2'],
                ['repo', d.repo, 'llvm/llvm-project'], ['directUrl', d.directUrl, ''],
                ['expectedDigest', d.expectedDigest, ''],
                ['outputRoot', d.outputRoot, path.resolve('/repo/build/clang-format')],
                ['tempRoot', d.tempRoot, path.resolve('/repo/build/clang-format/_download')]
            ].filter(([name, got, want]) => got !== want);
            check('什么都不给时落到内置默认（输出目录跟着脚本位置走，不是硬编码绝对路径）',
                defaults.length === 0, JSON.stringify(defaults));
            const dangling = makeDownloaderSandbox({ block: downloaderBlock, argv: ['--version'] }).dl;
            const nearMiss = makeDownloaderSandbox({ block: downloaderBlock, argv: ['--versions', '1.2.3'] }).dl;
            const firstWins = makeDownloaderSandbox({ block: downloaderBlock, argv: ['--version', '1.1.1', '--version', '2.2.2'] }).dl;
            check('flag 取值只认整词、只认第一次出现，后面没跟值就退回默认',
                dangling.version === '23.1.2' && nearMiss.version === '23.1.2' && firstWins.version === '1.1.1',
                JSON.stringify({ dangling: dangling.version, nearMiss: nearMiss.version, firstWins: firstWins.version }));
        }

        {
            const np = d.normalizePlatform;
            const aliasOk = np('win') === 'win32' && np('Windows') === 'win32' &&
                np('MAC') === 'darwin' && np('osx') === 'darwin' && np('macOS') === 'darwin' &&
                np('Linux') === 'linux';
            check('平台别名归一到 process.platform 的写法', aliasOk,
                JSON.stringify(['win', 'Windows', 'MAC', 'osx', 'macOS', 'Linux'].map(np)));
            check('空值回落当前平台，未知平台原样小写（别把 freebsd 悄悄当成 linux 下包）',
                np('') === 'linux' && np(undefined) === 'linux' && np('FreeBSD') === 'freebsd',
                JSON.stringify([np(''), np(undefined), np('FreeBSD')]));
            const quoted = makeDownloaderSandbox({ block: downloaderBlock, argv: ['--arch', 'X64'] }).dl;
            check('架构强制小写（大写 ARCH 环境变量在 CI 里很常见）',
                quoted.architecture === 'x64' &&
                makeDownloaderSandbox({ block: downloaderBlock, env: { OICPP_CLANG_FORMAT_ARCH: 'ARM64' } }).dl.architecture === 'arm64',
                quoted.architecture);
        }

        {
            const mac = (o = {}) => makeDownloaderSandbox({ block: downloaderBlock, platform: 'darwin', ...o }).dl;
            const fb = mac({ arch: 'x64' });
            check('intel mac 换 19.1.7 那份（上游不再出 x86 macOS 包），资产名跟着换',
                fb.usesIntelMacFallback === true && fb.assetVersion === '19.1.7' &&
                fb.releaseTag === 'llvmorg-19.1.7' && fb.assetNames['darwin-x64'] === 'LLVM-19.1.7-macOS-x86_64.tar.xz',
                JSON.stringify({ v: fb.assetVersion, tag: fb.releaseTag, name: fb.assetNames['darwin-x64'] }));
            const byArg = mac({ arch: 'x64', argv: ['--version', '20.1.0'] });
            const byEnv = mac({ arch: 'x64', env: { CLANG_FORMAT_VERSION: '20.1.0' } });
            const arm = mac({ arch: 'arm64' });
            const lin = makeDownloaderSandbox({ block: downloaderBlock, platform: 'linux', arch: 'x64' }).dl;
            check('只要显式指定了版本（参数或环境变量）就停止回退，否则会下错版本还报成功',
                byArg.usesIntelMacFallback === false && byArg.assetVersion === '20.1.0' &&
                byEnv.usesIntelMacFallback === false && byEnv.assetVersion === '20.1.0',
                JSON.stringify({ byArg: byArg.assetVersion, byEnv: byEnv.assetVersion }));
            check('回退只针对 darwin+x64，arm64 mac 和 linux 不许被换版本',
                arm.usesIntelMacFallback === false && arm.assetVersion === '23.1.2' &&
                lin.usesIntelMacFallback === false && lin.assetVersion === '23.1.2',
                JSON.stringify({ arm: arm.assetVersion, lin: lin.assetVersion }));
        }

        {
            const want = {
                'win32-x64': `clang+llvm-${d.assetVersion}-x86_64-pc-windows-msvc.tar.xz`,
                'win32-arm64': `clang+llvm-${d.assetVersion}-aarch64-pc-windows-msvc.tar.xz`,
                'darwin-x64': `LLVM-${d.assetVersion}-macOS-x86_64.tar.xz`,
                'darwin-arm64': `LLVM-${d.assetVersion}-macOS-ARM64.tar.xz`,
                'linux-x64': `LLVM-${d.assetVersion}-Linux-X64.tar.xz`,
                'linux-arm64': `LLVM-${d.assetVersion}-Linux-ARM64.tar.xz`
            };
            const got = Object.keys(d.assetNames).sort();
            const mismatched = Object.keys(want).filter((k) => d.assetNames[k] !== want[k]);
            check('资产表恰好六个键、命名与上游一致，且都用当前版本',
                JSON.stringify(got) === JSON.stringify(Object.keys(want).sort()) &&
                mismatched.length === 0 &&
                Object.values(d.assetNames).every((n) => n.includes(d.assetVersion) && n.endsWith('.tar.xz')),
                JSON.stringify({ got, mismatched }));
            const sb = makeDownloaderSandbox({ block: downloaderBlock, platform: 'win32' }).dl;
            check('资产选择按 平台-架构 取键，win32 拿到 msvc 那份',
                sb.getAssetName() === want['win32-x64'], String(sb.getAssetName()));
            const bad = makeDownloaderSandbox({ block: downloaderBlock, platform: 'freebsd' });
            let badErr = null;
            try { bad.dl.getAssetName(); } catch (e) { badErr = e; }
            check('没配过的平台直接报错并带上 平台-架构（不能悄悄下个别平台的包）',
                badErr !== null && String(badErr.message) === 'Unsupported clang-format platform: freebsd-x64',
                String(badErr && badErr.message));
        }

        {
            const combos = [
                [{}, false],
                [{ NODE_ENV: 'development' }, false],
                [{ OICPP_SKIP_SSL_VERIFY: '1' }, false],
                [{ NODE_ENV: 'development', OICPP_SKIP_SSL_VERIFY: '1' }, true],
                [{ NODE_ENV: 'development', OICPP_SKIP_SSL_VERIFY: '0' }, false],
                [{ NODE_ENV: 'production', OICPP_SKIP_SSL_VERIFY: '1' }, false]
            ];
            const wrong = combos.filter(([env, want]) =>
                makeDownloaderSandbox({ block: downloaderBlock, env }).dl.skipSslVerify !== want);
            check('跳过证书校验要两个开关同时满足（少一个条件就是发布包里能关 TLS）',
                wrong.length === 0, JSON.stringify(wrong.map(([, want]) => want)));
            const cfg = base.downloaderConfigs[0].cfg;
            check('下载上限 4GiB / 重定向 10 次 / label 与 UA 都真的传给了下载库',
                cfg.label === 'clang-format' && cfg.userAgent === 'oicpp-clang-format-downloader' &&
                cfg.maxBytes === 4 * 1024 * 1024 * 1024 && cfg.maxRedirects === 10 &&
                cfg.skipSslVerify === false,
                JSON.stringify(cfg));
            check('开关打开时把 skipSslVerify 一起带给下载库',
                makeDownloaderSandbox({
                    block: downloaderBlock,
                    env: { NODE_ENV: 'development', OICPP_SKIP_SSL_VERIFY: '1' }
                }).downloaderConfigs[0].cfg.skipSslVerify === true);
            check('digest 前缀大小写都剥掉并转小写',
                makeDownloaderSandbox({ block: downloaderBlock, env: { CLANG_FORMAT_SHA256: 'sha256:DEADBEEF' } }).dl.expectedDigest === 'deadbeef' &&
                makeDownloaderSandbox({ block: downloaderBlock, env: { CLANG_FORMAT_SHA256: 'DEADBEEF' } }).dl.expectedDigest === 'deadbeef',
                makeDownloaderSandbox({ block: downloaderBlock, env: { CLANG_FORMAT_SHA256: 'sha256:DEADBEEF' } }).dl.expectedDigest);
        }

        {
            const assets = [];
            const api = makeDownloaderSandbox({ block: downloaderBlock, releaseAssets: assets, env: { GITHUB_TOKEN: 'ghp_x' } });
            const name = api.dl.assetNames['linux-x64'];
            assets.push({ name, browser_download_url: 'https://gh/api-asset', digest: 'sha256:BEEF' });
            const gotAsset = await api.dl.selectReleaseAsset('ghp_x');
            check('release 接口按 repo + tag 拼 URL，token 一起带上',
                api.requestJsonCalls.length === 1 &&
                api.requestJsonCalls[0].url === 'https://api.github.com/repos/llvm/llvm-project/releases/tags/llvmorg-23.1.2' &&
                api.requestJsonCalls[0].token === 'ghp_x',
                JSON.stringify(api.requestJsonCalls));
            check('命中就用上游给的资产对象（自己拼 URL 等于绕过 release 表）',
                gotAsset.browser_download_url === 'https://gh/api-asset' && gotAsset.name === name,
                JSON.stringify(gotAsset));
            await api.dl.selectReleaseAsset('');
            check('没 token 时传 undefined，不传空串（库会把空串当有效凭据）',
                api.requestJsonCalls[1].token === undefined, String(api.requestJsonCalls[1].token));

            const off = makeDownloaderSandbox({ block: downloaderBlock, platform: 'win32', apiError: 'API rate limit exceeded' });
            const winName = off.dl.assetNames['win32-x64'];
            const fallbackAsset = await off.dl.selectReleaseAsset('');
            check('API 挂了回落到官方直链，且资产名必须转义（clang+llvm 里的 + 会被解成空格）',
                off.requestJsonCalls.length === 1 &&
                off.requestJsonCalls[0].url === 'https://api.github.com/repos/llvm/llvm-project/releases/tags/llvmorg-23.1.2' &&
                fallbackAsset.browser_download_url ===
                    `https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.2/${encodeURIComponent(winName)}` &&
                fallbackAsset.name === winName &&
                off.logs.warn.join(' ').includes('API rate limit exceeded'),
                JSON.stringify({ url: fallbackAsset.browser_download_url, warn: off.logs.warn }));

            const macOff = makeDownloaderSandbox({
                block: downloaderBlock,
                platform: 'darwin',
                arch: 'x64',
                apiError: 'boom',
                env: { CLANG_FORMAT_SHA256: 'sha256:BEEF' }
            });
            const macAsset = await macOff.dl.selectReleaseAsset('');
            check('回落 URL 用的是生效 tag（intel mac 回退到 19.1.7 时不能用原 tag）',
                macAsset.browser_download_url ===
                    'https://github.com/llvm/llvm-project/releases/download/llvmorg-19.1.7/' +
                    encodeURIComponent('LLVM-19.1.7-macOS-x86_64.tar.xz') &&
                macAsset.name === 'LLVM-19.1.7-macOS-x86_64.tar.xz',
                String(macAsset.browser_download_url));
            check('回落时也要把 digest 带上，否则校验形同没有',
                macAsset.digest === 'sha256:beef', String(macAsset.digest));

            const miss = makeDownloaderSandbox({                block: downloaderBlock,
                releaseAssets: [{ name: 'LLVM-some-other-thing.tar.xz', browser_download_url: 'https://gh/other' }]
            });
            const missAsset = await miss.dl.selectReleaseAsset('');
            const missName = miss.dl.assetNames['linux-x64'];
            check('release 表里没有目标资产时，警告要说清有哪些可选，仍然走官方直链',
                missAsset.name === missName &&
                missAsset.browser_download_url.endsWith(encodeURIComponent(missName)) &&
                miss.logs.warn.join(' ').includes('LLVM-some-other-thing.tar.xz'),
                JSON.stringify(miss.logs.warn));

            const direct = makeDownloaderSandbox({
                block: downloaderBlock,
                argv: ['--url', 'https://mirror.internal/LLVM-23.1.2-Linux-X64.tar.xz', '--digest', 'sha256:ABCD']
            });
            const directAsset = await direct.dl.selectReleaseAsset('');
            check('指定 --url 就完全不碰 API，digest 补上 sha256: 前缀交给下载库',
                direct.requestJsonCalls.length === 0 &&
                directAsset.browser_download_url === 'https://mirror.internal/LLVM-23.1.2-Linux-X64.tar.xz' &&
                directAsset.digest === 'sha256:abcd',
                JSON.stringify(directAsset));
        }

        {
            function installRun(o = {}) {
                const assets = [];
                const sb = makeDownloaderSandbox({
                    block: downloaderBlock,
                    dirname: path.join(root, 'scripts'),
                    releaseAssets: assets,
                    pid: 4242,
                    ...o
                });
                const key = `${sb.dl.platform}-${sb.dl.architecture}`;
                const name = sb.dl.assetNames[key];
                assets.push({
                    name,
                    browser_download_url: `https://up.example/${name}`,
                    digest: o.assetDigest === undefined ? 'sha256:AAAA' : o.assetDigest
                });
                return { sb, name, out: String(sb.dl.outputRoot), key };
            }

            const run = installRun();
            await run.sb.main();
            const linuxRoot = path.join(run.out, 'linux');
            const linuxBin = path.join(linuxRoot, 'bin', 'clang-format');
            const linuxLicense = path.join(linuxRoot, 'LICENSE.TXT');
            const staging = path.join(run.out, '.linux.staging-4242');
            check('装完落在 build/clang-format/<平台>/bin/clang-format，并带 LICENSE.TXT',
                run.sb.has(linuxBin) && run.sb.has(linuxLicense),
                run.sb.fsOpsText());
            check('下载落到临时目录里的资产同名文件，URL 用 release 给的那份',
                run.sb.downloadCalls.length === 1 &&
                run.sb.downloadCalls[0].dest === path.join(run.out, '_download', run.name) &&
                run.sb.downloadCalls[0].url === `https://up.example/${run.name}`,
                JSON.stringify(run.sb.downloadCalls));
            {
                const seq = run.sb.fsOps.join('\n');
                const at = (needle) => seq.indexOf(needle);
                const extractRoot = path.join(run.out, '_download', 'extract');
                const order = [
                    at(`download ${path.join(run.out, '_download', run.name)}`),
                    at(`extract ${extractRoot}`),
                    at(`-> ${path.join(staging, 'bin', 'clang-format')}`),
                    at('verify'),
                    at(`rm ${linuxRoot}`),
                    at(`rename ${staging} -> ${linuxRoot}`)
                ];
                check('顺序是「解压到 staging → 跑 --version 校验 → 才删目标目录 → 原子改名」',
                    order.every((i) => i >= 0) && order.every((i, k) => k === 0 || i > order[k - 1]),
                    JSON.stringify({ order, seq }));
            }
            check('非 win32 给二进制补 0755',
                run.sb.fsOpsText().includes(`chmod ${path.join(staging, 'bin', 'clang-format')} 755`),
                run.sb.fsOpsText());
            check('7z 只解 clang-format 与 LICENSE.TXT，走 -so | -si -ttar 两级管道',
                run.sb.extractCalls.length === 1 &&
                JSON.stringify(run.sb.extractCalls[0].includes) === JSON.stringify(['clang-format', 'LICENSE.TXT']) &&
                run.sb.extractCalls[0].streaming === true,
                JSON.stringify(run.sb.extractCalls));
            check('默认用 release 表里的 digest（sha256: 前缀剥掉后交给校验）',
                run.sb.downloadCalls[0].digest === 'AAAA', String(run.sb.downloadCalls[0].digest));

            const winRun = installRun({ platform: 'win32' });
            await winRun.sb.main();
            check('win32 装 clang-format.exe 且不 chmod（Windows 没有这个语义）',
                winRun.sb.has(path.join(winRun.out, 'win32', 'bin', 'clang-format.exe')) &&
                winRun.sb.extractCalls[0].includes[0] === 'clang-format.exe' &&
                !winRun.sb.fsOpsText().includes('chmod'),
                JSON.stringify({ ops: winRun.sb.fsOps, extract: winRun.sb.extractCalls }));

            const pinned = installRun({ env: { CLANG_FORMAT_SHA256: 'sha256:BEEFBEEF' } });
            await pinned.sb.main();
            check('自己指定的 digest 优先于 release 表里的（内网镜像没有可信 tag 时靠这个）',
                pinned.sb.downloadCalls[0].digest === 'beefbeef', String(pinned.sb.downloadCalls[0].digest));

            const halfDone = installRun({ files: [linuxBin] });
            await halfDone.sb.main();
            check('只有二进制没有 LICENSE 也要重装（缺许可证不能算已装好）',
                halfDone.sb.downloadCalls.length === 1, String(halfDone.sb.downloadCalls.length));
            const installed = installRun({ files: [linuxBin, linuxLicense] });
            await installed.sb.main();
            check('目标已存在就整个跳过：一次下载、一次解压、一次校验都不发',
                installed.sb.downloadCalls.length === 0 && installed.sb.spawnCalls.length === 0 &&
                installed.sb.syncCalls.length === 0 &&
                installed.sb.logs.log.join(' ').includes('Target exists'),
                JSON.stringify({ logs: installed.sb.logs.log }));

            for (const [label, probe] of [
                ['--version 退出码非零', { versionStatus: 1 }],
                ['--version 输出不是 clang-format', { versionStdout: 'GNU indent, version 2.2.11' }]
            ]) {
                const broken = installRun(probe);
                let err = null;
                try { await broken.sb.main(); } catch (e) { err = e; }
                check(`${label} → 报错、清掉 staging、目标目录一个字节没动`,
                    err !== null && /not executable/.test(String(err.message)) &&
                    broken.sb.fsOps.join('\n').includes(`rm ${staging}`) &&
                    !broken.sb.fsOpsText().includes('rename') &&
                    !broken.sb.has(linuxBin),
                    JSON.stringify({ err: String(err && err.message), ops: broken.sb.fsOps }));
            }

            const noLicense = installRun({ extractProduces: ['clang-format'] });
            let licenseErr = null;
            try { await noLicense.sb.main(); } catch (e) { licenseErr = e; }
            check('解压结果里没有 LICENSE.TXT 也要报错，不能只把二进制装上去',
                licenseErr !== null && /Unable to locate LICENSE.TXT/.test(String(licenseErr.message)) &&
                !noLicense.sb.has(linuxBin) && !noLicense.sb.fsOpsText().includes('rename'),
                String(licenseErr && licenseErr.message));

            const emptyExtract = installRun({ omitExtracted: true });
            let locateErr = null;
            try { await emptyExtract.sb.main(); } catch (e) { locateErr = e; }
            check('解压结果里找不到 clang-format 就报错，别把半个目录改名上架',
                locateErr !== null && /Unable to locate clang-format/.test(String(locateErr.message)) &&
                !emptyExtract.sb.has(linuxBin) && !emptyExtract.sb.fsOpsText().includes('rename'),
                String(locateErr && locateErr.message));

            const failExtract = installRun({ closeCode: 1 });
            let extractErr = null;
            try { await failExtract.sb.main(); } catch (e) { extractErr = e; }
            check('7z 解压非零退出必须报错，不能当成功继续装',
                extractErr !== null && /Unable to extract clang-format/.test(String(extractErr.message)),
                String(extractErr && extractErr.message));

            {
                const zipRun = installRun();
                zipRun.sb.call('extractFromZip', '/tmp/LLVM.zip', '/tmp/out', 'clang-format');
                const zipArgs = zipRun.sb.syncCalls[0] ? zipRun.sb.syncCalls[0].args : [];
                check('zip 分支走单次 7z x，include 过滤同样只取二进制和许可证',
                    zipArgs[0] === 'x' && zipArgs[1] === '/tmp/LLVM.zip' &&
                    zipArgs.includes('-o/tmp/out') && zipArgs.includes('-y') &&
                    zipArgs.includes('-ir!clang-format') && zipArgs.includes('-ir!LICENSE.TXT'),
                    JSON.stringify(zipArgs));
                const seven = installRun({ spawnStatus: 2 });
                let sevenErr = null;
                try { seven.sb.call('extractFromZip', '/tmp/a.zip', '/tmp/out', 'clang-format'); } catch (e) { sevenErr = e; }
                check('7z 非零退出要抛错（否则后面 copyFileSync 拷的是空气）',
                    sevenErr !== null && /7z failed/.test(String(sevenErr.message)),
                    String(sevenErr && sevenErr.message));
            }

            {
                const bfs = installRun({ files: ['/x/c/clang-format', '/x/a/b/clang-format'] });
                check('findFile 逐层往下找，浅层的先命中（深层优先会跟着目录顺序漂）',
                    bfs.sb.call('findFile', '/x', 'clang-format') === path.resolve('/x/c/clang-format'),
                    String(bfs.sb.call('findFile', '/x', 'clang-format')));
                check('找不到返回 null，不抛（调用方自己决定怎么报错）',
                    bfs.sb.call('findFile', '/x', 'no-such-file') === null);
            }

            // ---- 打包链路交叉链接：下载器落点 → package.json → installer.nsi → 主进程解析 ----
            const chainBad = [];
            const RESOURCE_BY_PLATFORM = { win32: 'win', darwin: 'mac', linux: 'linux' };
            for (const [key, buildName] of Object.entries(RESOURCE_BY_PLATFORM)) {
                const one = installRun({ platform: key });
                await one.sb.main();
                const builtFrom = path.relative(root, path.join(one.out, key)).split(path.sep).join('/');
                const exeName = key === 'win32' ? 'clang-format.exe' : 'clang-format';
                const entry = (packageJson.build[buildName].extraResources || [])
                    .find((item) => item.from === builtFrom);
                if (!entry) chainBad.push(`${key}: 下载器写到 ${builtFrom}，package.json 里没有这份 from`);
                else if (!one.sb.has(path.join(one.out, key, 'bin', exeName))) {
                    chainBad.push(`${key}: 下载器没把二进制放进 package.json 期望的目录`);
                }
            }
            check('三个平台的 extraResources.from 必须正好是下载器的落点（改一边就得同步另一边）',
                chainBad.length === 0, chainBad.join(' | '));

            const sections = nsiSections(installerSource);
            const installSection = sections.find((s) => /SEC01/i.test(s.header));
            const uninstallSection = sections.find((s) => /\bUninstall\b/i.test(s.header));
            const installOps = installSection ? nsiOps(installSection.body) : [];
            const uninstallOps = uninstallSection ? nsiOps(uninstallSection.body) : [];
            const cfEntry = (packageJson.build.win.extraResources || [])
                .find((item) => /clang-format/.test(String(item.from)));
            const winUnpacked = path.posix.join(packageJson.build.directories.output, 'win-unpacked');
            const wantSrc = `${winUnpacked.replace(/\//g, '\\')}\\resources\\${cfEntry ? cfEntry.to : ''}\\*`;
            const wantDest = `$INSTDIR\\resources\\${cfEntry ? cfEntry.to : ''}`;
            const fileOp = installOps.find((op) => op.kind === 'file' && op.targets[0] === wantSrc);
            const rmdirOps = uninstallOps.filter((op) => op.kind === 'rmdir' && op.recursive);
            check('安装段把 extraResources 那份目录整包复制到 $INSTDIR\\resources\\<to>（来源与目标都由 package.json 推导）',
                sections.length >= 2 && !!installSection && !!uninstallSection && !!fileOp &&
                fileOp && fileOp.recursive === true && fileOp.outPath === wantDest,
                JSON.stringify({ wantSrc, wantDest, file: fileOp, ops: installOps.length }));
            check('卸载删掉的目录必须与安装写入的完全一致（装了就删不干净会越攒越大）',
                rmdirOps.some((op) => op.targets[0] === wantDest),
                JSON.stringify(rmdirOps.map((op) => op.targets[0])));
            const pkgRuntime = makeMainFormatSandbox({
                isPackaged: true, exists: ['/pkg/resources/clang-format', pkgExe()]
            });
            const runtimeDir = path.basename(String(pkgRuntime.fns.resolveClangFormatRootFromBundle &&
                pkgRuntime.fns.resolveClangFormatRootFromBundle()));
            check('运行期打包态解析出的目录名，就是安装脚本写入的那个（两边都改了才算接上）',
                runtimeDir === (cfEntry && cfEntry.to) && wantDest.endsWith(runtimeDir),
                JSON.stringify({ runtimeDir, to: cfEntry && cfEntry.to }));
            check('Windows 用 dir 目标出 win-unpacked 给 installer.nsi 取文件（不是 nsis target）',
                packageJson.build.win.target === 'dir');
        }
    }

    console.log(`clang-format tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
    clearTimeout(watchdog);
    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.error(`[FAIL] clang-format unexpected error | ${error?.stack || error}`);
    clearTimeout(watchdog);
    process.exitCode = 1;
});
