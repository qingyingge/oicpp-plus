// SampleTester / Competitive Companion 本地 HTTP 服务（抽离自 src/main.ts）
// 端口：20030（SampleTester）、10043（Competitive Companion）
// .ts 是手写源，.js 由 tsc -p tsconfig.build.json emit，不得手改 .js。

const http = require('http');
const logger = require('../utils/logger');

const SampleTesterPort = 20030;
const CompetitiveCompanionPort = 10043;

type SampleTestCaseInput = {
    id: number;
    input: string;
    output: string;
    timeLimit?: number;
    memoryLimit?: number;
};

type SampleTesterPayloadInput = {
    title?: unknown;
    name?: unknown;
    group?: unknown;
    source?: unknown;
    url?: unknown;
    timeLimit?: unknown;
    memoryLimit?: unknown;
    problemName?: unknown;
    tests?: SampleTestCaseInput[];
    samples?: SampleTestCaseInput[];
};

type CompanionNormalizeResult =
    | { ok: false; message: string; invalidField: string; payload?: undefined }
    | { ok: true; message?: undefined; invalidField?: undefined; payload: SampleTesterPayloadInput };

let sampleTesterServer: import('http').Server | null = null;
let competitiveCompanionServer: import('http').Server | null = null;
let mainWindow: import('electron').BrowserWindow | null = null;

// ---- 共用工具 ----

function writeJson(res: import('http').ServerResponse, statusCode: number, payload: unknown) {
    const origin = (res.req as import('http').IncomingMessage)?.headers?.origin;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        Vary: 'Origin'
    };
    if (origin) headers['Access-Control-Allow-Origin'] = origin as string;
    res.writeHead(statusCode, headers);
    res.end(JSON.stringify(payload));
}

function getRequestPath(req: import('http').IncomingMessage): string {
    try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        let pathname = url.pathname || '/';
        if (pathname.length > 1 && pathname.endsWith('/')) {
            pathname = pathname.slice(0, -1);
        }
        return pathname || '/';
    } catch (_) {
        return req.url || '/';
    }
}

// 本地 HTTP 接口（SampleTester/CompetitiveCompanion）只接受本机页面与浏览器扩展的跨域请求，
// 任意网站 Origin（含沙箱 iframe 的 "null"）一律 403，防止恶意页面向 127.0.0.1 注入题目数据（H5）
function isTrustedLocalOrigin(req: import('http').IncomingMessage): boolean {
    const origin = req.headers && req.headers.origin;
    if (origin === undefined) {
        const remote = String(req.socket?.remoteAddress || '');
        return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    }
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return true;
    if (/^(chrome|moz)-extension:\/\//.test(origin)) return true;
    return false;
}

function rejectUntrustedOrigin(req: import('http').IncomingMessage, res: import('http').ServerResponse): boolean {
    if (isTrustedLocalOrigin(req)) return false;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 403, message: 'Forbidden origin' }));
    return true;
}

function readJsonBody(
    req: import('http').IncomingMessage,
    res: import('http').ServerResponse,
    callback: (data: SampleTesterPayloadInput) => void
) {
    const MAX_BODY_BYTES = 2 * 1024 * 1024;
    // 逐块 chunk→string 拼接会在多字节字符横跨两个 chunk 时静默产生 U+FFFD。
    // 攒 Buffer，最后一次性按 utf8 解。
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;

    const rejectTooLarge = () => {
        if (settled) return;
        settled = true;
        try { req.pause(); } catch (_) { }
        try { writeJson(res, 413, { code: 413, message: 'Request body too large' }); } catch (_) { }
        try { res.once('finish', () => { try { req.destroy(); } catch (_) { } }); } catch (_) { }
    };

    req.on('data', (chunk: unknown) => {
        if (settled) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        receivedBytes += buf.length;
        if (receivedBytes > MAX_BODY_BYTES) {
            rejectTooLarge();
            return;
        }
        chunks.push(buf);
    });
    // 客户端中途断开时不抛未捕获异常
    req.on('error', () => { settled = true; });
    req.on('end', () => {
        if (settled) return;
        settled = true;
        const body = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(body || '{}'); } catch (_) { }
        if (!data || typeof data !== 'object') {
            return writeJson(res, 400, { code: 400, message: 'Invalid JSON body' });
        }
        callback(data as SampleTesterPayloadInput);
    });
}

function normalizeCompetitiveCompanionPayload(data: SampleTesterPayloadInput | null | undefined): CompanionNormalizeResult {
    if (!data || typeof data !== 'object') {
        return { ok: false, message: 'body must be JSON object', invalidField: 'body' };
    }

    const titleRaw = (typeof data.title === 'string' && data.title.trim())
        ? data.title.trim()
        : (typeof data.name === 'string' && data.name.trim())
            ? data.name.trim()
            : (typeof data.problemName === 'string' && data.problemName.trim())
                ? data.problemName.trim()
                : '';

    if (!titleRaw) {
        return { ok: false, message: 'problem title missing', invalidField: 'title' };
    }

    if (!Array.isArray(data.tests) || data.tests.length === 0) {
        return { ok: false, message: 'tests must not be empty', invalidField: 'tests' };
    }

    let ojName = 'Competitive Companion';
    if (typeof data.group === 'string' && data.group.trim()) {
        ojName = data.group.trim();
    } else if (typeof data.source === 'string' && data.source.trim()) {
        ojName = data.source.trim();
    } else if (typeof data.url === 'string' && data.url.trim()) {
        try {
            const host = new URL(data.url.trim()).hostname;
            if (host) ojName = host;
        } catch (_) { }
    }

    let timeLimitMs: number;
    if (typeof data.timeLimit === 'number' && Number.isFinite(data.timeLimit) && data.timeLimit > 0) {
        timeLimitMs = data.timeLimit <= 50 ? Math.round(data.timeLimit * 1000) : Math.round(data.timeLimit);
    }

    let memoryLimitMb: number | undefined;
    if (typeof data.memoryLimit === 'number' && Number.isFinite(data.memoryLimit)
        && data.memoryLimit > 0 && data.memoryLimit <= 65536) {
        memoryLimitMb = Math.round(data.memoryLimit * 100) / 100;
    }

    const rawSamples = data.tests.map((t: SampleTestCaseInput) => ({
        input: typeof t?.input === 'string' ? t.input : '',
        output: typeof t?.output === 'string' ? t.output : '',
        timeLimit: timeLimitMs,
        memoryLimit: memoryLimitMb
    }));

    const filteredSamples = rawSamples.filter((s) => !isPlaceholderCompanionSample(s.input, s.output));
    const usableSamples = filteredSamples.length > 0 ? filteredSamples : rawSamples;
    if (usableSamples.length !== rawSamples.length) {
        try { logger.logInfo(`[CompetitiveCompanion] 已自动过滤 ${rawSamples.length - usableSamples.length} 个附件引用占位样例`); } catch (_) { }
    }

    const samples = usableSamples.map((s, idx: number) => ({
        id: idx + 1,
        input: s.input,
        output: s.output,
        timeLimit: s.timeLimit,
        memoryLimit: s.memoryLimit
    }));

    const payload = {
        OJ: ojName,
        problemName: titleRaw,
        samples
    };

    return { ok: true, payload };
}

// 部分 OJ（如某些中文题库）会把样例写成「见附件中的 zoo/zoo3.in」，
// Competitive Companion 会把这段说明当作样例内容抓取下来。这里识别这类附件引用占位样例。
const PLACEHOLDER_SAMPLE_PATTERN = /(?:见|参见|参阅)\s*附\s*件|附\s*件\s*中|see\s+(?:the\s+)?attach|refer(?:s|red)?\s+to\s+(?:the\s+)?attach/i;

function isPlaceholderCompanionSample(input: string, output: string) {
    const text = `${input || ''}\n${output || ''}`;
    return PLACEHOLDER_SAMPLE_PATTERN.test(text);
}

function validateSampleTesterPayload(data: SampleTesterPayloadInput | null | undefined) {
    if (!data || typeof data !== 'object') return { valid: false, message: 'body must be JSON object', invalidField: 'body' };
    if (!data.problemName || typeof data.problemName !== 'string') return { valid: false, message: 'problemName missing.', invalidField: 'problemName' };
    if (!Array.isArray(data.samples) || data.samples.length === 0) return { valid: false, message: 'samples must not be empty.', invalidField: 'samples' };
    if (data.samples.length > 2000) return { valid: false, message: 'too many samples (maximum 2000).', invalidField: 'samples' };
    const ids = new Set();
    for (const s of data.samples) {
        if (!s || typeof s !== 'object') return { valid: false, message: 'sample must be object', invalidField: 'samples' };
        if (!Number.isInteger(s.id) || s.id <= 0) return { valid: false, message: 'sample id invalid', invalidField: 'id' };
        if (ids.has(s.id)) return { valid: false, message: 'duplicate sample id', invalidField: 'id' };
        ids.add(s.id);
        if (typeof s.input !== 'string') return { valid: false, message: 'input must be string', invalidField: 'input' };
        if (s.input.length > 1024 * 1024) return { valid: false, message: 'input is too large', invalidField: 'input' };
        if (typeof s.output !== 'string') return { valid: false, message: 'output must be string', invalidField: 'output' };
        if (s.output.length > 1024 * 1024) return { valid: false, message: 'output is too large', invalidField: 'output' };
        if (s.timeLimit !== undefined && (!Number.isInteger(s.timeLimit) || s.timeLimit <= 0)) return { valid: false, message: 'timeLimit must be positive integer', invalidField: 'timeLimit' };
        if (s.memoryLimit !== undefined && (!Number.isFinite(s.memoryLimit) || s.memoryLimit < 0)) return { valid: false, message: 'memoryLimit must be non-negative number', invalidField: 'memoryLimit' };
    }
    return { valid: true };
}

function sendCreateProblem(payload: SampleTesterPayloadInput) {
    try {
        logger.logInfo('[SampleTesterAPI] 收到题目:', payload.problemName, '样例数:', payload.samples?.length || 0);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('sample-tester-create-problem', payload);
        }
    } catch (e) {
        logger.logerror('发送样例创建事件失败', e);
    }
}

// ---- SampleTester 服务（20030）----

function createSampleTesterServer() {
    const server = http.createServer(async (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
        const requestPath = getRequestPath(req);
        if (rejectUntrustedOrigin(req, res)) return;
        if (req.method === 'OPTIONS') {
            return writeJson(res, 204, { code: 204, message: 'No Content' });
        }
        if (req.method === 'POST' && requestPath === '/createNewProblem') {
            readJsonBody(req, res, (data: SampleTesterPayloadInput) => {
                const result = validateSampleTesterPayload(data);
                if (!result.valid) {
                    const resp = { code: 400, message: 'Invalid parameters: ' + result.message, invalidField: result.invalidField };
                    return writeJson(res, 400, resp);
                }
                sendCreateProblem(data);
                return writeJson(res, 200, { code: 200, message: 'Problem created successfully' });
            });
            return;
        }
        return writeJson(res, 404, { code: 404, message: 'Not Found' });
    });

    server.on('request', (req: import('http').IncomingMessage) => {
        try {
            const requestPath = getRequestPath(req);
            logger.logInfo('[SampleTesterAPI] 请求:', req.method, requestPath, '来自', req.socket?.remoteAddress || 'unknown');
        } catch (_) { }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
        // EADDRINUSE 是异步 'error' 事件，外层 try/catch 抓不到。
        // 不挂监听会冒泡成 uncaughtException；这里降级为警告，样例测试器不可用但主功能不受影响。
        if (err && err.code === 'EADDRINUSE') {
            try { logger.logWarn(`[SampleTesterAPI] 端口 ${SampleTesterPort} 被占用，样例测试器导入功能不可用。可关闭占用进程后重启应用。`); } catch (_) { }
            return;
        }
        try { logger.logerror('[SampleTesterAPI] 服务出错', err); } catch (_) { }
    });

    server.listen(SampleTesterPort, '127.0.0.1', () => {
        logger.logInfo(`[SampleTesterAPI] 服务已启动 http://127.0.0.1:${SampleTesterPort}`);
    });

    return server;
}

// ---- Competitive Companion 服务（10043）----

function createCompetitiveCompanionServer(port: number, tagLabel: string) {
    const label = tagLabel || 'CompetitiveCompanion';
    const server = http.createServer(async (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
        const requestPath = getRequestPath(req);
        if (rejectUntrustedOrigin(req, res)) return;
        const acceptPaths = new Set(['/', '/competitive-companion', '/add', '/receive', '/companion']);
        if (req.method === 'OPTIONS') {
            return writeJson(res, 204, { code: 204, message: 'No Content' });
        }
        if (req.method === 'POST' && acceptPaths.has(requestPath)) {
            readJsonBody(req, res, (data: SampleTesterPayloadInput) => {
                const normalized = normalizeCompetitiveCompanionPayload(data);
                if (!normalized.ok) {
                    const resp = { code: 400, message: 'Invalid parameters: ' + normalized.message, invalidField: normalized.invalidField };
                    return writeJson(res, 400, resp);
                }

                const result = validateSampleTesterPayload(normalized.payload);
                if (!result.valid) {
                    const resp = { code: 400, message: 'Invalid parameters: ' + result.message, invalidField: result.invalidField };
                    return writeJson(res, 400, resp);
                }

                sendCreateProblem(normalized.payload);
                return writeJson(res, 200, { code: 200, message: 'Problem created successfully' });
            });
            return;
        }
        return writeJson(res, 404, { code: 404, message: 'Not Found' });
    });

    server.on('request', (req: import('http').IncomingMessage) => {
        try {
            const requestPath = getRequestPath(req);
            logger.logInfo(`[${label}] 请求:`, req.method, requestPath, '来自', req.socket?.remoteAddress || 'unknown');
        } catch (_) { }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
        if (err && err.code === 'EADDRINUSE') {
            try { logger.logWarn(`[${label}] 端口 ${port} 被占用，可能被其他工具占用（如 cph）。可在 Competitive Companion 中添加 http://127.0.0.1:${port}/ 作为自定义端口。`); } catch (_) { }
            return;
        }
        try { logger.logerror(`[${label}] 服务出错`, err); } catch (_) { }
    });

    server.listen(port, '127.0.0.1', () => {
        logger.logInfo(`[${label}] 服务已启动 http://127.0.0.1:${port}`);
    });

    return server;
}

// ---- 对外 API ----

/**
 * 启动 SampleTester 与 Competitive Companion 本地 HTTP 服务。
 * @param win Electron BrowserWindow 主窗口，用于向渲染层广播 sample-tester-create-problem 事件
 */
export function startSampleTesterServers(win: import('electron').BrowserWindow | null): void {
    mainWindow = win;

    try {
        if (sampleTesterServer) return; // 已启动
        sampleTesterServer = createSampleTesterServer();
    } catch (err) {
        try { logger.logerror('[SampleTesterAPI] 启动失败', err); } catch (_) { }
    }

    startCompetitiveCompanionServer();
}

function startCompetitiveCompanionServer() {
    try {
        if (competitiveCompanionServer) return; // 已启动
        competitiveCompanionServer = createCompetitiveCompanionServer(CompetitiveCompanionPort, 'CompetitiveCompanion');
    } catch (err) {
        try { logger.logerror('[CompetitiveCompanion] 启动失败', err); } catch (_) { }
    }
}

/**
 * 停止 SampleTester 与 Competitive Companion 本地 HTTP 服务。
 * 供退出清理调用。
 */
export function stopSampleTesterServers(): void {
    try {
        if (sampleTesterServer) {
            sampleTesterServer.close();
            sampleTesterServer = null;
        }
    } catch (_) { }
    try {
        if (competitiveCompanionServer) {
            competitiveCompanionServer.close();
            competitiveCompanionServer = null;
        }
    } catch (_) { }
    mainWindow = null;
}
