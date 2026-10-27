type ErrorLike = Record<string, unknown> & { cause?: unknown; data?: unknown; error?: unknown };

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SENSITIVE_KEY_RE = /token|password|passwd|secret|authorization|cookie|credential|apikey|api_key/i;
// 裸字符串里的 token=xxx / "password": "xxx" 形式，键名收窄为已知敏感词，避免把普通日志抹平。
// 值这一侧必须一路吃到成对引号结束 / 行尾：旧写法 [^"'\s,}]+ 在第一个空格就停，
// 于是 "apiKey": "abc def ghi" 只抹掉 abc，def 与 ghi 原样落盘（口令是多词的情况很常见）。
const SENSITIVE_INLINE_RE = /(["']?)(token|password|passwd|secret|authorization|cookie|credential|apikey|api_key|login_?token)\1(\s*(?::|=|\bis\b)\s*)(?:"[^"]*"|'[^']*'|Bearer\s+[^\s,}\]]+|[^,}\r\n]+)/gi;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._\-]+/gi;

export class Logger {
    initialized = false;
    logDir: string;
    logFile: string | null = null;
    private _buffer: string[] = [];
    private _batchSize = 200;
    private _maxBufferLines = 5000;
    private _flushScheduled = false;

    constructor() {
        this.logDir = path.join(os.homedir(), '.oicpp-plus', 'logs');
    }

    _scheduleFlush(): void {
        if (this._flushScheduled) return;
        this._flushScheduled = true;
        setImmediate(() => {
            this._flushScheduled = false;
            this._flush();
        });
    }

    _flush(): void {
        if (this._buffer.length === 0) return;
        const lines = this._buffer;
        try {
            if (!this.initialized) this.init();
            if (!this.logFile) {
                if (this._buffer.length > this._maxBufferLines) {
                    this._buffer = this._buffer.slice(-this._maxBufferLines);
                }
                return;
            }
            fs.appendFileSync(this.logFile, lines.join(''), 'utf8');
            this._buffer = [];
        } catch (e) {
            console.error('[Logger] 写入日志失败:', e instanceof Error ? e.message : String(e));
            if (this._buffer.length > this._maxBufferLines) {
                this._buffer = this._buffer.slice(-this._maxBufferLines);
            }
        }
    }

    flushSync(): void {
        this._flush();
    }

    static timestampFilename(date = new Date()): string {
        const pad = (n: number): string => String(n).padStart(2, '0');
        const toCN = (d: Date): Date => {
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

    init(): string | null {
        if (this.initialized) return this.logFile;
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
        } catch (_) {
            return null;
        }
    }

    rotate(keepCount = 5): void {
        try {
            if (!fs.existsSync(this.logDir)) return;
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
                try { fs.unlinkSync(f.full); } catch (_) { }
            }
        } catch (_) { }
    }

    static redactString(text: unknown): string {
        return String(text ?? '')
            .replace(SENSITIVE_INLINE_RE, (_match: string, quote: string, key: string, separator: string) =>
                `${quote}${key}${quote}${separator}[REDACTED]`)
            .replace(BEARER_RE, '$1[REDACTED]');
    }

    static stringifyArgs(args: unknown[], { level = 'info', maxLen = 2000 } = {}): string {
        const redactingReplacer = (key: string, value: unknown): unknown => {
            if (key && SENSITIVE_KEY_RE.test(key)) return '[REDACTED]';
            if (value instanceof Error) return serializeError(value);
            if (typeof value === 'string') return Logger.redactString(value);
            return value;
        };
        const serializeError = (err: unknown): Record<string, unknown> => {
            // err.data 常是云同步/编译的请求载荷，里面就躺着 token；键名黑名单 + 字符串值
            // 两道都要过，否则前面把 message 抹干净、data 原样落盘等于没脱敏。
            const redactData = (value: unknown): unknown => {
                try {
                    return JSON.parse(JSON.stringify(value, (key: string, val: unknown): unknown => {
                        if (key && SENSITIVE_KEY_RE.test(key)) return '[REDACTED]';
                        return typeof val === 'string' ? Logger.redactString(val) : val;
                    }));
                } catch (_) {
                    return Logger.redactString(String(value));
                }
            };
            try {
                const base: {
                    name: string;
                    message: string;
                    stack?: string;
                    cause?: unknown;
                    data?: unknown;
                } = {
                    name: err instanceof Error ? err.name : 'Error',
                    message: Logger.redactString(err instanceof Error ? err.message : String(err)),
                    stack: err instanceof Error && err.stack ? Logger.redactString(err.stack) : undefined,
                };
                ['code', 'errno', 'syscall', 'path', 'address', 'port'].forEach((k) => {
                    if (err && typeof err === 'object' && k in err) {
                        const field = (err as Record<string, unknown>)[k];
                        (base as Record<string, unknown>)[k] = typeof field === 'string' ? Logger.redactString(field) : field;
                    }
                });
                if (err && typeof err === 'object' && 'cause' in err) {
                    const cause = (err as ErrorLike).cause;
                    base.cause = typeof cause === 'object' && cause !== null ? serializeError(cause) : Logger.redactString(String(cause));
                }
                if (err && typeof err === 'object' && 'data' in err) {
                    const data = (err as ErrorLike).data;
                    base.data = data && typeof data === 'object' ? redactData(data) : Logger.redactString(String(data));
                }
                return base;
            } catch (_) {
                return { message: Logger.redactString(String(err)) };
            }
        };
        const INFO_PER_ARG_LIMIT = 1200;
        const clamp = (s: unknown, lim = INFO_PER_ARG_LIMIT): unknown => {
            if (typeof s !== 'string') return s;
            if (s.length <= lim) return s;
            return `${s.slice(0, lim)} ... [truncated ${s.length - lim} chars]`;
        };
        const infoStringify = (v: unknown): string => {
            if (v === null || v === undefined) return String(v);
            if (v instanceof Error) return JSON.stringify(serializeError(v), null, 2);
            if (typeof v === 'string') return clamp(v, INFO_PER_ARG_LIMIT) as string;
            try {
                const full = JSON.stringify(v, redactingReplacer, 2);
                if (full && full.length <= INFO_PER_ARG_LIMIT) return full;

                if (Array.isArray(v)) {
                    const sample = v.slice(0, 10);
                    const sampleStr = JSON.stringify(sample, redactingReplacer, 2);
                    const suffix = v.length > 10 ? ` ... [+${v.length - 10} more]` : '';
                    return `[Array(${v.length}) sample]: ${clamp(sampleStr, INFO_PER_ARG_LIMIT)}${suffix}`;
                }

                if (typeof v === 'object' && v !== null) {
                    const keys = Object.keys(v);
                    const pick = keys.slice(0, 12);
                    const sampleObj: Record<string, unknown> = {};
                    for (const k of pick) sampleObj[k] = (v as Record<string, unknown>)[k];
                    const sampleStr = JSON.stringify(sampleObj, redactingReplacer, 2);
                    const more = keys.length > pick.length ? `, ... ${keys.length - pick.length} more keys` : '';
                    return `{Object with ${keys.length} keys, sample}: ${clamp(sampleStr, INFO_PER_ARG_LIMIT)}${more}`;
                }

                return clamp(String(v), INFO_PER_ARG_LIMIT) as string;
            } catch (_) {
                try { return JSON.stringify(v, redactingReplacer); } catch (_2) { return String(v); }
            }
        };
        const verbose = (v: unknown): string => {
            if (v === null || v === undefined) return String(v);
            if (v instanceof Error) return JSON.stringify(serializeError(v), null, 2);
            if (typeof v === 'string') return v;
            if (typeof v === 'object' && v && 'error' in v && (v as ErrorLike).error instanceof Error && Object.keys(v).length === 1) {
                return JSON.stringify({ error: serializeError((v as ErrorLike).error) }, null, 2);
            }
            try { return JSON.stringify(v, redactingReplacer, 2); } catch (_) { return String(v); }
        };
        try {
            const joined = Logger.redactString(args.map(level === 'info' ? infoStringify : verbose).join(' '));
            if (level === 'info' && joined.length > maxLen) {
                return `${joined.slice(0, maxLen)} ... [truncated ${joined.length - maxLen} chars]`;
            }
            return joined;
        } catch (_) {
            return String(args);
        }
    }

    write(level: string, ...args: unknown[]): void {
        const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
        const now = new Date();
        const offsetMin = now.getTimezoneOffset();
        const delta = (8 * 60 + offsetMin) * 60000;
        const d8 = new Date(now.getTime() + delta);
        const ts = `${d8.getFullYear()}-${pad(d8.getMonth() + 1)}-${pad(d8.getDate())} ${pad(d8.getHours())}:${pad(d8.getMinutes())}:${pad(d8.getSeconds())}.${pad(d8.getMilliseconds(), 3)}+08:00`;
        const line = `[${ts}] [${level.toUpperCase()}] ${Logger.stringifyArgs(args, { level })}\n`;

        this._buffer.push(line);
        if (this._buffer.length >= this._batchSize) {
            this._flush();
        } else {
            this._scheduleFlush();
        }
    }

    logInfo(...args: unknown[]): void { this.write('info', ...args); }
    logwarn(...args: unknown[]): void { this.write('warn', ...args); }
    logerror(...args: unknown[]): void { this.write('error', ...args); }
    logWarn(...args: unknown[]): void { this.write('warn', ...args); }
    logError(...args: unknown[]): void { this.write('error', ...args); }

    getLogFile(): string | null { if (!this.initialized) this.init(); return this.logFile; }
}

export const logger = new Logger();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = logger;
}