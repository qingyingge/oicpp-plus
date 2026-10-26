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
exports.logger = exports.Logger = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const data_root_1 = require("./data-root");
const SENSITIVE_KEY_RE = /token|password|passwd|secret|authorization|cookie|credential|apikey|api_key/i;
// 裸字符串里的敏感键值：键名可以带引号（两边必须配平）、分隔符除 : = 外还认 "token is xxx"
// 这种散文写法，值优先整段引号内容吃掉 —— 只吃第一个非空白字符的话，
// "token": "a b" 会留下尾巴 a 在日志里。
const SENSITIVE_INLINE_RE = /(["']?)(token|password|passwd|secret|authorization|cookie|credential|apikey|api_key|login_?token)\1(\s*(?::|=|\bis\b)\s*)(?:"[^"]*"|'[^']*'|Bearer\s+[^\s,}\]]+|[^,}\r\n]+)/gi;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._\-]+/gi;
class Logger {
    initialized = false;
    logFile = null;
    _buffer = [];
    _batchSize = 200;
    _maxBufferLines = 5000;
    _flushScheduled = false;
    _logDir = null;
    // 目录延迟到第一次真正要用时才解析：main.js 第 19 行就 require 本模块，
    // 在构造期把路径固化会让便携模式的日志永远写在系统盘。
    get logDir() {
        if (this._logDir === null)
            this._logDir = (0, data_root_1.userDataPath)('logs');
        return this._logDir;
    }
    _scheduleFlush() {
        if (this._flushScheduled)
            return;
        this._flushScheduled = true;
        setImmediate(() => {
            this._flushScheduled = false;
            this._flush();
        });
    }
    _flush() {
        if (this._buffer.length === 0)
            return;
        const lines = this._buffer;
        try {
            if (!this.initialized)
                this.init();
            if (!this.logFile) {
                if (this._buffer.length > this._maxBufferLines) {
                    this._buffer = this._buffer.slice(-this._maxBufferLines);
                }
                return;
            }
            fs.appendFileSync(this.logFile, lines.join(''), 'utf8');
            this._buffer = [];
        }
        catch (e) {
            console.error('[Logger] 写入日志失败:', e instanceof Error ? e.message : String(e));
            if (this._buffer.length > this._maxBufferLines) {
                this._buffer = this._buffer.slice(-this._maxBufferLines);
            }
        }
    }
    flushSync() {
        this._flush();
    }
    static timestampFilename(date = new Date()) {
        const pad = (n) => String(n).padStart(2, '0');
        const toCN = (d) => {
            const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
            const delta = 8 * 3600000;
            return new Date(utcMs + delta);
        };
        const d8 = toCN(date);
        const YYYY = d8.getFullYear();
        const MM = pad(d8.getMonth() + 1);
        const DD = pad(d8.getDate());
        const hh = pad(d8.getHours());
        const mm = pad(d8.getMinutes());
        const ss = pad(d8.getSeconds());
        return `${YYYY}-${MM}-${DD}_${hh}-${mm}-${ss}.log`;
    }
    init() {
        if (this.initialized)
            return this.logFile;
        try {
            if (!fs.existsSync(this.logDir)) {
                fs.mkdirSync(this.logDir, { recursive: true });
            }
            const fileName = Logger.timestampFilename();
            this.logFile = path.join(this.logDir, fileName);
            fs.writeFileSync(this.logFile, '', { flag: 'a' });
            this.rotate(5);
            this.initialized = true;
            return this.logFile;
        }
        catch (_) {
            return null;
        }
    }
    rotate(keepCount = 5) {
        try {
            if (!fs.existsSync(this.logDir))
                return;
            const files = fs
                .readdirSync(this.logDir)
                .filter((f) => f.endsWith('.log'))
                .map((f) => ({
                name: f,
                full: path.join(this.logDir, f),
                mtime: fs.statSync(path.join(this.logDir, f)).mtimeMs,
            }))
                .sort((a, b) => b.mtime - a.mtime);
            const toDelete = files.slice(keepCount);
            for (const f of toDelete) {
                try {
                    fs.unlinkSync(f.full);
                }
                catch (_) { }
            }
        }
        catch (_) { }
    }
    static redactString(text) {
        return String(text ?? '')
            .replace(SENSITIVE_INLINE_RE, '$1$2$3[REDACTED]')
            .replace(BEARER_RE, '$1[REDACTED]');
    }
    static stringifyArgs(args, { level = 'info', maxLen = 2000 } = {}) {
        const redactingReplacer = (key, value) => {
            if (key && SENSITIVE_KEY_RE.test(key))
                return '[REDACTED]';
            if (value instanceof Error)
                return serializeError(value);
            if (typeof value === 'string')
                return Logger.redactString(value);
            return value;
        };
        const serializeError = (err) => {
            try {
                const base = {
                    name: err instanceof Error ? err.name : 'Error',
                    // 报错正文与栈里最常出现的就是「Authorization: Bearer …」「token=…」，
                    // 不跟着脱敏的话，前面那套 replacer 对 Error 参数完全无效（#541）。
                    message: Logger.redactString(err instanceof Error ? err.message : String(err)),
                    stack: err instanceof Error && err.stack ? Logger.redactString(err.stack) : undefined,
                };
                ['code', 'errno', 'syscall', 'path', 'address', 'port'].forEach((k) => {
                    if (err && typeof err === 'object' && k in err) {
                        const value = err[k];
                        base[k] = typeof value === 'string' ? Logger.redactString(value) : value;
                    }
                });
                if (err && typeof err === 'object' && 'cause' in err) {
                    const cause = err.cause;
                    base.cause = typeof cause === 'object' && cause !== null
                        ? serializeError(cause)
                        : Logger.redactString(String(cause));
                }
                if (err && typeof err === 'object' && 'data' in err) {
                    const data = err.data;
                    try {
                        base.data = JSON.parse(JSON.stringify(data, (key, value) => {
                            if (key && SENSITIVE_KEY_RE.test(key))
                                return '[REDACTED]';
                            return typeof value === 'string' ? Logger.redactString(value) : value;
                        }));
                    }
                    catch (_) {
                        base.data = Logger.redactString(String(data));
                    }
                }
                return base;
            }
            catch (_) {
                return { message: Logger.redactString(String(err)) };
            }
        };
        const INFO_PER_ARG_LIMIT = 1200;
        const clamp = (s, lim = INFO_PER_ARG_LIMIT) => {
            if (typeof s !== 'string')
                return s;
            if (s.length <= lim)
                return s;
            return `${s.slice(0, lim)} ... [truncated ${s.length - lim} chars]`;
        };
        const infoStringify = (v) => {
            if (v === null || v === undefined)
                return String(v);
            if (v instanceof Error)
                return JSON.stringify(serializeError(v), null, 2);
            if (typeof v === 'string')
                return clamp(Logger.redactString(v), INFO_PER_ARG_LIMIT);
            try {
                const full = JSON.stringify(v, redactingReplacer, 2);
                if (full && full.length <= INFO_PER_ARG_LIMIT)
                    return full;
                if (Array.isArray(v)) {
                    const sample = v.slice(0, 10);
                    const sampleStr = JSON.stringify(sample, redactingReplacer, 2);
                    const suffix = v.length > 10 ? ` ... [+${v.length - 10} more]` : '';
                    return `[Array(${v.length}) sample]: ${clamp(sampleStr, INFO_PER_ARG_LIMIT)}${suffix}`;
                }
                if (typeof v === 'object' && v !== null) {
                    const keys = Object.keys(v);
                    const pick = keys.slice(0, 12);
                    const sampleObj = {};
                    for (const k of pick)
                        sampleObj[k] = v[k];
                    const sampleStr = JSON.stringify(sampleObj, redactingReplacer, 2);
                    const more = keys.length > pick.length ? `, ... ${keys.length - pick.length} more keys` : '';
                    return `{Object with ${keys.length} keys, sample}: ${clamp(sampleStr, INFO_PER_ARG_LIMIT)}${more}`;
                }
                return clamp(String(v), INFO_PER_ARG_LIMIT);
            }
            catch (_) {
                try {
                    return JSON.stringify(v, redactingReplacer);
                }
                catch (_2) {
                    return String(v);
                }
            }
        };
        const verbose = (v) => {
            if (v === null || v === undefined)
                return String(v);
            if (v instanceof Error)
                return JSON.stringify(serializeError(v), null, 2);
            if (typeof v === 'string')
                return v;
            if (typeof v === 'object' && v && 'error' in v && v.error instanceof Error && Object.keys(v).length === 1) {
                return JSON.stringify({ error: serializeError(v.error) }, null, 2);
            }
            try {
                return JSON.stringify(v, redactingReplacer, 2);
            }
            catch (_) {
                return String(v);
            }
        };
        try {
            const joined = Logger.redactString(args.map(level === 'info' ? infoStringify : verbose).join(' '));
            if (level === 'info' && joined.length > maxLen) {
                return `${joined.slice(0, maxLen)} ... [truncated ${joined.length - maxLen} chars]`;
            }
            return joined;
        }
        catch (_) {
            return String(args);
        }
    }
    write(level, ...args) {
        const pad = (n, w = 2) => String(n).padStart(w, '0');
        const now = new Date();
        const offsetMin = now.getTimezoneOffset();
        const delta = (8 * 60 + offsetMin) * 60000;
        const d8 = new Date(now.getTime() + delta);
        const ts = `${d8.getFullYear()}-${pad(d8.getMonth() + 1)}-${pad(d8.getDate())} ${pad(d8.getHours())}:${pad(d8.getMinutes())}:${pad(d8.getSeconds())}.${pad(d8.getMilliseconds(), 3)}+08:00`;
        const line = `[${ts}] [${level.toUpperCase()}] ${Logger.stringifyArgs(args, { level })}\n`;
        this._buffer.push(line);
        if (this._buffer.length >= this._batchSize) {
            this._flush();
        }
        else {
            this._scheduleFlush();
        }
    }
    logInfo(...args) { this.write('info', ...args); }
    logwarn(...args) { this.write('warn', ...args); }
    logerror(...args) { this.write('error', ...args); }
    logWarn(...args) { this.write('warn', ...args); }
    logError(...args) { this.write('error', ...args); }
    getLogFile() { if (!this.initialized)
        this.init(); return this.logFile; }
}
exports.Logger = Logger;
exports.logger = new Logger();
if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports.logger;
}
