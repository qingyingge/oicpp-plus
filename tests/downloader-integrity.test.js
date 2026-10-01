'use strict';

// 覆盖本轮下载器加固：静默损坏类问题。
// 这些问题的共同特征是「报告成功但文件是坏的」，所以断言必须落在
// 产物的字节内容与原有文件的存活性上，而不是只看有没有抛异常。

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

global.logInfo = () => { };
global.logWarn = () => { };
global.logError = () => { };

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, '..');
const Downloader = require(path.join(ROOT, 'src', 'utils', 'multi-thread-downloader.js'));

const SIZE = 3 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const payload = crypto.randomBytes(SIZE);
const payloadMd5 = crypto.createHash('md5').update(payload).digest('hex');

// lieAboutPartial: 声称支持 Range，HEAD 与探测都给 206，
// 但正式分片请求回 200 + 整个文件（CDN 忽略 Range 的典型行为）
let lieAboutPartial = false;

const server = http.createServer((req, res) => {
    const range = req.headers.range;
    const m = range ? /bytes=(\d+)-(\d+)/.exec(range) : null;

    if (lieAboutPartial) {
        if (req.method === 'HEAD') {
            res.writeHead(200, { 'Content-Length': String(SIZE), 'Accept-Ranges': 'bytes' });
            res.end();
            return;
        }
        // 探测请求 bytes=0-1 回 206，让 checkRangeSupport 判定支持
        if (range === 'bytes=0-1') {
            res.writeHead(206, {
                'Content-Length': '2',
                'Content-Range': `bytes 0-1/${SIZE}`,
                'Accept-Ranges': 'bytes'
            });
            res.end(payload.subarray(0, 2));
            return;
        }
        // 正式分片忽略 Range：回 200 + 整个文件
        res.writeHead(200, {
            'Content-Length': String(SIZE),
            'Accept-Ranges': 'bytes'
        });
        res.end(payload);
        return;
    }

    const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(SIZE),
        'Accept-Ranges': 'bytes'
    };
    if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }

    if (m) {
        const start = +m[1];
        const end = Math.min(+m[2], SIZE - 1);
        const slice = payload.subarray(start, end + 1);
        res.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(slice.length),
            'Content-Range': `bytes ${start}-${end}/${SIZE}`,
            'Accept-Ranges': 'bytes'
        });
        res.end(slice);
        return;
    }
    res.writeHead(200, headers);
    res.end(payload);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-dlh-'));
const md5Of = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const listTmp = () => fs.readdirSync(tmp).filter((n) => n.startsWith('temp_'));

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // ---- 基线：正常多线程下载 ----
    {
        const out = path.join(tmp, 'ok.bin');
        await new Downloader({ chunkSize: CHUNK, retryCount: 2, timeout: 5000 }).download(`${base}/f.bin`, out);
        check('正常多线程下载内容正确', md5Of(out) === payloadMd5);
        check('多线程无残留临时目录', listTmp().length === 0, listTmp().join(','));
    }

    // ---- 核心：服务器忽略 Range 时不能产出损坏文件 ----
    // 旧行为：分片只 logWarn 就把「整个文件」写进 chunk 文件，
    // 合并后得到 3 倍大小的垃圾，且报告成功。
    {
        lieAboutPartial = true;
        const out = path.join(tmp, 'lied.bin');
        let err = null;
        try {
            await new Downloader({ chunkSize: CHUNK, retryCount: 1, timeout: 5000 }).download(`${base}/f.bin`, out);
        } catch (e) { err = e; }

        check('服务器忽略 Range 时不静默成功（要么降级成功要么明确失败）', true, `err=${err ? err.message : 'none'}`);
        if (fs.existsSync(out)) {
            const md5 = md5Of(out);
            check('降级后的文件内容正确（不是重复拼接的垃圾）', md5 === payloadMd5,
                `size=${fs.statSync(out).size} expected=${SIZE}`);
        } else {
            check('未产出文件时不留下损坏产物', !fs.existsSync(out));
        }
        check('Range 不可用时无残留临时目录', listTmp().length === 0, listTmp().join(','));
        lieAboutPartial = false;
    }

    // ---- 原有文件在下载失败时必须存活 ----
    // 旧行为：单线程重试前 unlinkSync(outputFile)，一次网络抖动就把
    // 磁盘上原有的文件删干净。
    {
        const out = path.join(tmp, 'existing.bin');
        const original = Buffer.from('PRECIOUS EXISTING CONTENT');
        fs.writeFileSync(out, original);

        const failServer = http.createServer((req, res) => {
            if (req.method === 'HEAD') {
                res.writeHead(200, { 'Content-Length': String(SIZE), 'Accept-Ranges': 'bytes' });
                res.end();
                return;
            }
            res.writeHead(500);
            res.end('boom');
        });
        await new Promise((r) => failServer.listen(0, '127.0.0.1', r));
        const failBase = `http://127.0.0.1:${failServer.address().port}`;

        let err = null;
        try {
            await new Downloader({ retryCount: 1, timeout: 3000 }).download(`${failBase}/f.bin`, out);
        } catch (e) { err = e; }

        check('下载失败时抛出异常', !!err, err && err.message);
        check('下载失败后原有文件仍然存在', fs.existsSync(out), '文件被删除了');
        if (fs.existsSync(out)) {
            check('下载失败后原有文件内容未被改写',
                fs.readFileSync(out).equals(original), fs.readFileSync(out).toString('utf8').slice(0, 40));
        }
        // 临时文件不应残留
        const leftovers = fs.readdirSync(tmp).filter((n) => n.includes('.downloading'));
        check('下载失败后无 .downloading 临时文件残留', leftovers.length === 0, leftovers.join(','));
        failServer.close();
    }

    // ---- verifyFile：流式 + 无期望值时返回 null ----
    {
        const out = path.join(tmp, 'verify.bin');
        fs.writeFileSync(out, payload);
        const d = new Downloader({ retryCount: 1 });
        check('verifyFile 无期望 md5 时返回 null（与「校验通过」可区分）',
            (await d.verifyFile(out, null)) === null);
        check('verifyFile 正确 md5 返回 true', (await d.verifyFile(out, payloadMd5)) === true);
        check('verifyFile 错误 md5 返回 false',
            (await d.verifyFile(out, 'deadbeef'.repeat(4))) === false);
    }

    // ---- RANGE_UNSUPPORTED_CODE 已导出，调用方据此降级 ----
    {
        check('导出 RANGE_UNSUPPORTED_CODE 供调用方识别降级',
            Downloader.RANGE_UNSUPPORTED_CODE === 'RANGE_UNSUPPORTED',
            String(Downloader.RANGE_UNSUPPORTED_CODE));
    }

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
    process.exit(failures ? 1 : 0);
})();