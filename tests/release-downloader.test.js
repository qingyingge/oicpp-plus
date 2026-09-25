'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createReleaseDownloader } = require('../scripts/lib/release-downloader');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const listen = (server) => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

(async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-release-downloader-'));
    const seenAuth = [];
    const server = http.createServer((req, res) => {
        seenAuth.push(req.headers.authorization || '');
        if (req.url === '/redirect') {
            res.writeHead(302, { Location: '/asset' });
            res.end();
            return;
        }
        if (req.url === '/large') {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
            res.end(Buffer.alloc(2048, 65));
            return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('release-asset');
    });
    const port = await listen(server);
    const downloader = createReleaseDownloader({ label: 'test-release', maxBytes: 1024, maxRedirects: 3 });
    const destination = path.join(directory, 'asset.bin');
    await downloader.downloadFile(`http://127.0.0.1:${port}/redirect`, destination, 'token');
    check('shared downloader follows bounded redirects', fs.readFileSync(destination, 'utf8') === 'release-asset');
    check('shared downloader preserves authorization on same origin', seenAuth.every((value) => value === 'Bearer token'));

    let limited = false;
    try {
        await downloader.downloadFile(`http://127.0.0.1:${port}/large`, destination, 'token');
    } catch (_) {
        limited = true;
    }
    check('shared downloader enforces response size limits', limited);

    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
    console.log(`release-downloader tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.error(`[FAIL] release-downloader unexpected error | ${error?.stack || error}`);
    process.exitCode = 1;
});
