'use strict';
// 本地 HTTP 服务器实测 MultiThreadDownloader：多线程/单线程/取消/失败恢复
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

global.logInfo = () => { };
global.logWarn = () => { };
global.logError = () => { };

const ROOT = path.resolve(__dirname, '..');
const Downloader = require(path.join(ROOT, 'src', 'utils', 'multi-thread-downloader.js'));

const SIZE = 3 * 1024 * 1024;
const source = crypto.randomBytes(SIZE);
const sourceMd5 = crypto.createHash('md5').update(source).digest('hex');

let rangeSupport = true;
const STEP = 32 * 1024;
const DELAY = 30;

const writeThrottled = (res, buf) => {
    let offset = 0;
    const pump = () => {
        if (offset >= buf.length) { res.end(); return; }
        const piece = buf.subarray(offset, offset + STEP);
        offset += STEP;
        res.write(piece);
        setTimeout(pump, DELAY);
    };
    pump();
};

const server = http.createServer((req, res) => {
    if (req.url === '/fail') {
        if (req.method === 'HEAD') {
            res.writeHead(200, { 'Content-Length': String(SIZE), 'Accept-Ranges': 'bytes' });
            res.end();
            return;
        }
        // 探测请求放行以进入多线程分支，正式分片请求全部 500
        if (req.headers.range === 'bytes=0-1') {
            res.writeHead(206, { 'Content-Range': `bytes 0-1/${SIZE}`, 'Content-Length': '2', 'Accept-Ranges': 'bytes' });
            res.end(source.subarray(0, 2));
            return;
        }
        res.writeHead(500);
        res.end('boom');
        return;
    }

    const headers = { 'Content-Type': 'application/octet-stream', 'Content-Length': String(SIZE) };
    if (rangeSupport) headers['Accept-Ranges'] = 'bytes';
    if (req.method === 'HEAD') {
        res.writeHead(200, headers);
        res.end();
        return;
    }

    const rh = req.headers.range;
    if (rangeSupport && rh) {
        const m = /bytes=(\d+)-(\d+)/.exec(rh);
        if (m) {
            const start = +m[1];
            const end = Math.min(+m[2], SIZE - 1);
            const slice = source.subarray(start, end + 1);
            res.writeHead(206, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(slice.length),
                'Content-Range': `bytes ${start}-${end}/${SIZE}`,
                'Accept-Ranges': 'bytes'
            });
            writeThrottled(res, slice);
            return;
        }
    }
    res.writeHead(200, headers);
    writeThrottled(res, source);
});

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-dl-'));
const md5Of = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const clean = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { } };

(async () => {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // 1. 多线程下载
    const out1 = path.join(tmp, 'multi.bin');
    await new Downloader({ chunkSize: 1024 * 1024, retryCount: 2 }).download(`${base}/file.bin`, out1);
    check('多线程下载内容与源一致', md5Of(out1) === sourceMd5);
    check('多线程临时目录已清理', fs.readdirSync(tmp).filter(n => n.startsWith('temp_')).length === 0);

    // 2. 服务器不支持 Range → 单线程
    rangeSupport = false;
    const out2 = path.join(tmp, 'single.bin');
    await new Downloader({ retryCount: 2 }).download(`${base}/file.bin`, out2);
    check('单线程回退下载内容与源一致', md5Of(out2) === sourceMd5);
    rangeSupport = true;

    // 3. 取消下载
    const d3 = new Downloader({ chunkSize: 512 * 1024, retryCount: 2 });
    const out3 = path.join(tmp, 'cancel.bin');
    setTimeout(() => d3.cancel(), 300);
    let err3 = null;
    try { await d3.download(`${base}/file.bin`, out3); } catch (e) { err3 = e; }
    check('取消下载抛出下载已取消', !!err3 && /下载已取消/.test(err3.message), err3 && err3.message);
    check('取消后临时目录已清理', fs.readdirSync(tmp).filter(n => n.startsWith('temp_')).length === 0);

    // 4. 多线程失败后 progressCallback 被还原
    const d4 = new Downloader({ chunkSize: 1024 * 1024, retryCount: 1 });
    const origCb = d4.progressCallback;
    let err4 = null;
    try { await d4.download(`${base}/fail`, path.join(tmp, 'fail.bin')); } catch (e) { err4 = e; }
    check('分片全部失败时下载抛错', !!err4, err4 && err4.message);
    check('失败后 progressCallback 还原为原始值', d4.progressCallback === origCb);
    check('失败后临时目录已清理', fs.readdirSync(tmp).filter(n => n.startsWith('temp_')).length === 0);

    server.close();
    clean(tmp);
    console.log(failures === 0 ? '\nDOWNLOADER TESTS: ALL PASSED' : `\nDOWNLOADER TESTS: ${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(e => {
    console.error('FATAL', e);
    server.close();
    clean(tmp);
    process.exit(1);
});
