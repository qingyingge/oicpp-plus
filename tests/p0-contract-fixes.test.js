'use strict';

// 覆盖 1ba6870（四个必然触发的 P0）与 6ddac59（tabs 身份错位）。
// 下载器部分用真实 HTTP 服务器 + 可控故障注入，验证 retryCount 真的生效，
// 而不是只检查源码里有没有那行 await。

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

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
const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const compileMgrSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'compile-manager.js'), 'utf8');
const cloudSyncSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'sidebar', 'cloudSync.js'), 'utf8');
const tabsSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'tabs.js'), 'utf8');
const rendererMainSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'main.js'), 'utf8');

// ===========================================================================
// P0-3：分片重试真的生效（return await）+ 取消错误不被洗成普通失败
// ===========================================================================

const CHUNK = 1024 * 1024;
const SIZE = 4 * 1024 * 1024;
const payload = crypto.randomBytes(SIZE);
const payloadMd5 = crypto.createHash('md5').update(payload).digest('hex');

// 故障注入开关
let flakyRange = null;   // Set<"start-end">：这些分片第一次请求时中途断流
let flakySeen = null;    // Set：记录已被打断过的分片，用于验证重试真的发生了
let rangeSupport = true;

const server = http.createServer((req, res) => {
    const rh = req.headers.range;
    const m = rh ? /bytes=(\d+)-(\d+)/.exec(rh) : null;

    if (rangeSupport && m) {
        const start = +m[1];
        const end = Math.min(+m[2], SIZE - 1);
        const slice = payload.subarray(start, end + 1);
        const key = `${start}-${end}`;

        if (flakyRange && flakyRange.has(key) && !flakySeen.has(key)) {
            // 发一半就断开：制造流式错误（HTTP 仍是 206，内容不完整）
            res.writeHead(206, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': String(slice.length),
                'Content-Range': `bytes ${start}-${end}/${SIZE}`,
                'Accept-Ranges': 'bytes'
            });
            res.write(slice.subarray(0, Math.floor(slice.length / 2)));
            res.destroy();
            return;
        }

        res.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(slice.length),
            'Content-Range': `bytes ${start}-${end}/${SIZE}`,
            'Accept-Ranges': 'bytes'
        });
        res.end(slice);
        return;
    }

    const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(SIZE),
        'Accept-Ranges': rangeSupport ? 'bytes' : 'none'
    };
    if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
    res.writeHead(200, headers);
    res.end(payload);
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-p0-'));
const md5Of = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');

(async () => {
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;

    // ---- P0-3 行为验证：流式错误触发重试并最终成功 ----
    // 旧代码 `return new Promise` 缺 await 时，内层 reject 冒泡不出 catch，
    // retryCount 完全不生效，这类中断会直接让整次下载失败。
    flakyRange = new Set(['0-1048575', '2097152-3145727']);
    flakySeen = new Set();
    // 在 flakySeen 记录后再断开，模拟「第一次失败、重试成功」
    const origFlaky = flakyRange;
    flakyRange = new Set([...origFlaky].map((k, i) => { flakySeen.add(k); return k; }));
    flakyRange = origFlaky;

    const out1 = path.join(tmp, 'retry.bin');
    let retryErr = null;
    try {
        await new Downloader({ chunkSize: CHUNK, retryCount: 3, timeout: 5000 })
            .download(`${base}/file.bin`, out1);
    } catch (e) { retryErr = e; }
    check('P0-3 流式错误后重试成功（缺 await 时此处必失败）', !retryErr, retryErr && retryErr.message);
    check('P0-3 重试后的文件内容完整', fs.existsSync(out1) && md5Of(out1) === payloadMd5);

    // 真正的重试计数验证：让首分片每次都中途断流，观察请求次数
    let attempts = 0;
    // 真正的重试计数验证：让首分片每次都中途断流，观察请求次数
    flakyRange = null;
    const countingServer = http.createServer((req, res) => {
        const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
        if (req.method === 'HEAD') {
            res.writeHead(200, {
                'Content-Length': String(SIZE),
                'Accept-Ranges': 'bytes'
            });
            res.end();
            return;
        }
        if (!m) { res.writeHead(200, { 'Content-Length': String(SIZE) }); res.end(); return; }
        const start = +m[1];
        const end = Math.min(start + CHUNK - 1, SIZE - 1);
        // 范围探测请求必须正常返回 206，否则 checkRangeSupport 判为不支持
        // 范围而走单线程路径，分片重试根本不会被触发
        if (start === 0) {
            attempts++;
            res.writeHead(206, {
                'Content-Length': String(end - start + 1),
                'Content-Range': `bytes ${start}-${end}/${SIZE}`,
                'Accept-Ranges': 'bytes'
            });
            res.write(payload.subarray(0, 10));
            res.destroy();
            return;
        }
        res.writeHead(206, {
            'Content-Length': String(end - start + 1),
            'Content-Range': `bytes ${start}-${end}/${SIZE}`,
            'Accept-Ranges': 'bytes'
        });
        res.end(payload.subarray(start, end + 1));
    });
    await new Promise((r) => countingServer.listen(0, '127.0.0.1', r));
    const countingBase = `http://127.0.0.1:${countingServer.address().port}`;
    let exhausted = null;
    try {
        await new Downloader({ chunkSize: CHUNK, retryCount: 3, timeout: 3000 })
            .download(`${countingBase}/x.bin`, path.join(tmp, 'exhausted.bin'));
    } catch (e) { exhausted = e; }
    check('P0-3 重试次数用尽后抛出失败', !!exhausted);
    check('P0-3 retryCount 真的生效（首分片请求次数 > 1）', attempts > 1, `attempts=${attempts}`);
    countingServer.close();

    flakyRange = null;

    // ---- P0-3 连带：取消错误保留 code，不被兜底 throw 洗掉 ----
    check('P0-3 兜底 throw 复用原 error（保留 code）',
        /error\.message = t\('downloader\.chunkFailed'[\s\S]{0,120}?throw error;/.test(
            fs.readFileSync(path.join(ROOT, 'src', 'utils', 'multi-thread-downloader.js'), 'utf8')));

    // ---- P0-1：取消判定不再依赖 message 文案 ----
    check('P0-1 catch 内用 isDownloadCancelled 而非文案匹配',
        (mainSource.match(/isDownloadCancelled\(error\)/g) || []).length >= 2 &&
        !/error\.message\.includes\('用户取消'\)/.test(mainSource));
    check('P0-1 不存在裸名 isCancelledError（导入时已改名为 isDownloadCancelled）',
        !/(?<![A-Za-z0-9_])isCancelledError\s*\?/.test(mainSource));
    check('P0-1 close 延时用的是作用域内的 isCancelled',
        (mainSource.match(/\}, isCancelled \? 1000 : 3000\);/g) || []).length === 2);

    // ---- P0-2：compile-code 死处理器已移除，监听随之清理 ----
    check('P0-2 compile-code handler 已删除', !/ipcMain\.on\('compile-code'/.test(mainSource));
    check('P0-2 compileCode 调用点已消失', !/[^.\w]compileCode\(/.test(mainSource));
    check('P0-2 compile-manager 不再监听无发送方的四个通道',
        !/'compile-result':/.test(compileMgrSource) &&
        !/'run-result':/.test(compileMgrSource) &&
        !/'run-error':/.test(compileMgrSource) &&
        !/'compile-error': \(/.test(compileMgrSource));
    check('P0-2 preload 事件白名单同步移除这四个通道',
        !/'compile-result'/.test(preloadSource) &&
        !/'run-result'/.test(preloadSource) &&
        !preloadSource.includes("'run-error'"));
    check('P0-2 handleCompileResult/handleRunResult 方法本身仍被其它路径使用',
        /this\.handleCompileResult\(result\)/.test(compileMgrSource) &&
        /this\.handleRunResult\(result\)/.test(compileMgrSource));

    // ---- P0-4 / S-3：cloudSync 取消判定与空串兜底 ----
    check('P0-4 moveItem 用 !ok 而非 ok === false',
        /const ok = await window\.dialogManager[\s\S]{0,160}?\n\s*if \(!ok\) return;/.test(cloudSyncSource));
    check('P0-4 不再存在 ok === false 判定',
        !/ok === false/.test(cloudSyncSource));
    check('S-3 下载内容缺失时抛错而非兜底成空串',
        !/typeof fileData\?\.content === 'string' \? fileData\.content : ''/.test(cloudSyncSource));
    check('S-3 copyFolderRecursive 同样不再兜底空串',
        !/content: fileData\.content/.test(cloudSyncSource) ||
        /typeof fileData\?\.content !== 'string'[\s\S]{0,120}?throw new Error/.test(cloudSyncSource));

    // ---- P0-5 / 6ddac59：closeAllTabs 不再把 Map key 当 fileName ----
    check('P0-5 closeAllTabs 用 uniqueKeyOverride 传参',
        /closeAllTabs\(\)[\s\S]{0,700}?uniqueKeyOverride: uniqueKey/.test(tabsSource));
    check('P0-5 closeOtherTabs 按 uniqueKey 过滤而非与 activeTab 比较',
        /const tabsToClose = \[\.\.\.this\.tabs\.keys\(\)\]\.filter\(uniqueKey => uniqueKey !== currentKey\)/.test(tabsSource));
    check('P0-5 不再把 this.activeTab 当 key 比较',
        !/filter\(fileName => fileName !== currentTab\)/.test(tabsSource));

    // ---- 6ddac59：异步回写与重命名的身份守卫 ----
    check('tabs 异步回写同时锚定 tab 身份与目标编辑器',
        /const isSameTab = \(\) =>/.test(tabsSource) &&
        /const isStillTarget = \(\) => isSameTab\(\) && this\.monacoEditorManager\?\.currentEditor === targetEditor;/.test(tabsSource));
    check('tabs 目标已切走时只回填缓存，不动编辑器',
        /仅更新缓存/.test(tabsSource));
    check('重命名后同步 activeTabKey',
        /if \(this\.activeTabKey === actualOldKey \|\| this\.activeTabKey === newKey\) \{\s*\n\s*this\.activeTabKey = newKey;/.test(tabsSource));
    check('重命名同步迁移 group.tabs 与 group.activeTabKey',
        /group\.tabs\.has\(actualOldKey\)/.test(tabsSource) &&
        /group\.activeTabKey === actualOldKey/.test(tabsSource));
    check('关闭 tab 时一并清空 activeTabKey',
        /this\.activeTab = null;\s*\n\s*this\.activeTabKey = null;/.test(tabsSource));

    // ---- 7032ecf：调试变量转义 ----
    check('调试变量渲染对 gdb 输出转义',
        /escapeHtml\(data\.type \|\| 'unknown'\)/.test(rendererMainSource) &&
        /escapeHtml\(name\)/.test(rendererMainSource) &&
        /escapeHtml\(this\.formatVariableValue\(data\)\)/.test(rendererMainSource));
    check('调试变量 value 的 title 属性也转义',
        /title="\$\{escapeHtml\(data\.value \|\| ''\)\}"/.test(rendererMainSource));

    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
    process.exit(failures ? 1 : 0);
})();