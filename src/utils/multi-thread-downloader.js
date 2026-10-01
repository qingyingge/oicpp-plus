const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { t } = require('../lang');

// 取消错误用固定 code 标识，调用方靠它判断「用户取消」而不是匹配 message 文本，
// 否则一旦文案被翻译，main.js 的 error.message.includes('下载已取消') 就会失效。
const CANCELLED_CODE = 'DOWNLOAD_CANCELLED';
// 服务器忽略 Range 返回整个文件时抛这个码，由 download() 捕获后降级单线程
const RANGE_UNSUPPORTED_CODE = 'RANGE_UNSUPPORTED';
const cancelledError = () => {
    const err = new Error(t('downloader.cancelled'));
    err.code = CANCELLED_CODE;
    return err;
};
const isCancelledError = (error) => error?.code === CANCELLED_CODE;

function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const isHttps = urlObj.protocol === 'https:';
        const client = isHttps ? https : http;

        const requestOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || {},
            timeout: options.timeout || 30000
        };

        const req = client.request(requestOptions, (res) => {

            resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                statusText: res.statusMessage,
                headers: {
                    get: (name) => res.headers[name.toLowerCase()]
                },
                body: res
            });
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.end();
    });
}


class MultiThreadDownloader {
    constructor(options = {}) {
        this.isCancelled = false;
        this.cancelError = null;
        this.maxConcurrency = options.maxConcurrency || 16; // 最大并发数
        this.chunkSize = options.chunkSize || 1024 * 1024 * 2; // 每个分片大小 (2MB)
        this.timeout = options.timeout || 30000; // 超时时间 (30秒)
        this.retryCount = options.retryCount || 8; // 增加重试次数到8次
        this.minMultiThreadSize = options.minMultiThreadSize || 1024 * 1024 * 2;
        this.progressCallback = options.progressCallback || (() => { });
    }

    cancel() {
        this.isCancelled = true;
        logInfo('[多线程下载] 下载已取消');
        this.cancelError = cancelledError();
    }


    async checkRangeSupport(url) {
        try {
            const headResponse = await makeRequest(url, {
                method: 'HEAD'
            });

            const acceptRanges = headResponse.headers.get('accept-ranges');
            try { headResponse.body.resume(); } catch (_) { }
            if (acceptRanges === 'bytes') {
                return true;
            }

            const rangeResponse = await makeRequest(url, {
                headers: {
                    'Range': 'bytes=0-1'
                }
            });
            const isSupported = rangeResponse.status === 206;
            try {
                rangeResponse.body.resume();
            } catch (_) { }

            return isSupported;
        } catch (error) {
            logWarn('[多线程下载] 检查范围请求支持失败:', error.message);
            return false;
        }
    }


    async getFileSize(url) {
        try {
            const response = await makeRequest(url, { method: 'HEAD' });
            try { response.body.resume(); } catch (_) { }
            const contentLength = response.headers.get('content-length');
            return contentLength ? parseInt(contentLength, 10) : null;
        } catch (error) {
            logWarn('[多线程下载] 获取文件大小失败:', error.message);
            return null;
        }
    }


    async downloadChunk(url, start, end, chunkIndex, tempDir) {
        const chunkFile = path.join(tempDir, `chunk_${chunkIndex}.tmp`);
        let retries = 0;

        while (retries < this.retryCount) {
            if (this.isCancelled) throw cancelledError();
            try {
                const rangeHeader = `bytes=${start}-${end}`;

                const response = await makeRequest(url, {
                    headers: {
                        'Range': rangeHeader
                    },
                    timeout: this.timeout
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                if (response.status !== 206) {
                    // 服务器忽略了 Range 并回整个文件：写盘得到的是「整个文件」而非分片，
                    // 合并后会静默产出损坏结果（原先只 logWarn 就继续）。
                    // 必须拒绝，让调用方回退到单线程路径。
                    const err = new Error(t('downloader.chunkNotPartial', { index: chunkIndex, status: response.status }));
                    // 标记为「Range 不可用」，供 download() 识别后降级到单线程，
                    // 而不是直接让整次下载失败
                    err.code = RANGE_UNSUPPORTED_CODE;
                    throw err;
                }

                const writer = fs.createWriteStream(chunkFile);
                let downloadedBytes = 0;

                // 必须 await：缺 await 时内层 reject 不会冒泡进下方 catch，分片重试机制整体失效
                return await new Promise((resolve, reject) => {
                    response.body.on('data', (chunk) => {
                        if (this.isCancelled) {
                            writer.end(() => {
                                if (fs.existsSync(chunkFile)) {
                                    fs.unlinkSync(chunkFile); // 清理文件
                                }
                            });
                            response.body.destroy();
                            return reject(this.cancelError || cancelledError());
                        }
                        writer.write(chunk);
                        downloadedBytes += chunk.length;

                        if (this.progressCallback) {
                            this.progressCallback({
                                type: 'chunk',
                                chunkIndex,
                                downloadedBytes,
                                totalBytes: end - start + 1
                            });
                        }
                    });

                    response.body.on('end', () => {
                        writer.end((error) => {
                            if (error) {
                                reject(error);
                            } else {
                                logInfo(`[多线程下载] 分片 ${chunkIndex} 下载完成`);
                                resolve({ chunkIndex, file: chunkFile, size: downloadedBytes });
                            }
                        });
                    });

                    response.body.on('error', (error) => {
                        if (this.isCancelled) {
                            return reject(this.cancelError);
                        }
                        if (!writer.destroyed) {
                            writer.destroy();
                        }
                        reject(error);
                    });

                    writer.on('error', (error) => {
                        if (this.isCancelled) {
                            return reject(this.cancelError);
                        }
                        reject(error);
                    });
                });

            } catch (error) {
                // 取消不属于可重试错误：立即上抛，保持 CANCELLED_CODE 不被洗成普通失败
                if (isCancelledError(error) || this.isCancelled) {
                    throw error?.code === CANCELLED_CODE ? error : cancelledError();
                }

                retries++;

                const errorMessage = String(error?.message || '');
                const isNetworkError = error?.code === 'ECONNRESET' ||
                    error?.code === 'ENOTFOUND' ||
                    error?.code === 'ETIMEDOUT' ||
                    error?.code === 'ECONNREFUSED' ||
                    errorMessage.includes('aborted') ||
                    errorMessage.includes('timeout');

                if (isNetworkError) {
                    logWarn(`[多线程下载] 分片 ${chunkIndex} 网络错误 (尝试 ${retries}/${this.retryCount}):`, error?.code || errorMessage);
                } else {
                    logWarn(`[多线程下载] 分片 ${chunkIndex} 下载失败 (尝试 ${retries}/${this.retryCount}):`, errorMessage);
                }

                if (fs.existsSync(chunkFile)) {
                    try {
                        fs.unlinkSync(chunkFile);
                    } catch (cleanupError) {
                        logWarn(`[多线程下载] 清理失败分片文件出错:`, cleanupError.message);
                    }
                }

                if (retries >= this.retryCount) {
                    // 保留原始 error（含 code），仅在 message 上补充上下文
                    error.message = t('downloader.chunkFailed', { index: chunkIndex, message: errorMessage });
                    throw error;
                }

                let delay;
                if (isNetworkError) {
                    delay = Math.pow(2, retries) * 1000; // 2s, 4s, 8s, 16s
                    logInfo(`[多线程下载] 分片 ${chunkIndex} 网络错误，将在 ${delay / 1000}s 后重试`);
                } else {
                    delay = Math.pow(2, retries - 1) * 1000; // 1s, 2s, 4s, 8s
                    logInfo(`[多线程下载] 分片 ${chunkIndex} 将在 ${delay / 1000}s 后重试`);
                }

                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }


    async mergeChunks(chunks, outputFile) {
        logInfo('[多线程下载] 开始合并分片文件');

        const sorted = chunks.slice().sort((a, b) => a.chunkIndex - b.chunkIndex);

        // 合并到临时文件再 rename：直接覆盖 outputFile 时，中途 ENOSPC 会留下
        // 半截目标文件且分片已删，既无法重试也无法回退到原有文件
        const tempOutput = `${outputFile}.merging`;
        const writer = fs.createWriteStream(tempOutput);

        try {
            await new Promise((resolve, reject) => {
                // 流式管道而非逐块 readFileSync：后者把整个分片读进内存，
                // 且丢弃 write() 的返回值 = 没有背压，大文件会撑爆内存
                const pipeline = (async () => {
                    for (const chunk of sorted) {
                        if (this.isCancelled) throw cancelledError();
                        if (!fs.existsSync(chunk.file)) {
                            throw new Error(t('downloader.chunkMissing', { index: chunk.chunkIndex }));
                        }
                        // 校验分片实际长度：服务器未回 206 时该分片文件是整个文件，
                        // 不校验就会静默写出损坏结果，错误延后到解压阶段才暴露
                        const expected = typeof chunk.size === 'number' ? chunk.size : null;
                        if (expected !== null && expected > 0) {
                            const actual = fs.statSync(chunk.file).size;
                            if (actual !== expected) {
                                throw new Error(t('downloader.chunkSizeMismatch', {
                                    index: chunk.chunkIndex, actual, expected
                                }));
                            }
                        }

                        // 只有在数据真正落盘（drain）之后才删源分片
                        await new Promise((res, rej) => {
                            const rs = fs.createReadStream(chunk.file);
                            let settled = false;
                            const fail = (e) => {
                                if (settled) return;
                                settled = true;
                                try { rs.destroy(); } catch (_) { }
                                rej(e);
                            };
                            rs.on('error', fail);
                            rs.on('end', () => {
                                if (settled) return;
                                settled = true;
                                res();
                            });
                            // 背压：write 返回 false 时等 drain 再推进
                            rs.on('data', (piece) => {
                                if (!writer.write(piece)) {
                                    rs.pause();
                                    writer.once('drain', () => rs.resume());
                                }
                            });
                            rs.on('error', fail);
                        });

                        try {
                            fs.unlinkSync(chunk.file);
                        } catch (error) {
                            logWarn(`[多线程下载] 删除临时文件失败:`, error.message);
                        }
                    }
                })();

                writer.on('error', reject);
                writer.on('finish', resolve);
                // 全部写完后必须 end()，否则 'finish' 永不触发（曾因此挂起）
                pipeline.then(() => writer.end(), reject);
            });

            // rename 是同分区内的原子操作：要么旧文件，要么完整新文件
            fs.renameSync(tempOutput, outputFile);
            logInfo('[多线程下载] 分片合并完成');
        } catch (error) {
            try {
                if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
            } catch (_) { }
            throw error;
        } finally {
            if (!writer.destroyed) {
                writer.destroy();
            }
        }
    }


    async downloadSingleThread(url, outputFile) {
        logInfo('[多线程下载] 使用单线程下载模式');

        const maxAttempts = Math.max(1, this.retryCount);
        let attempt = 0;
        let lastError = null;

        // 写临时文件、成功后 rename。原先直接写 outputFile 并在每次重试前
        // unlinkSync(outputFile)：一次网络抖动就把磁盘上原有的文件删干净，
        // 而重试无任何续传/offset，每次都从 0 重来。
        const partialFile = `${outputFile}.downloading`;

        while (attempt < maxAttempts) {
            attempt++;
            if (this.isCancelled) throw cancelledError();

            let response = null;
            let writer = null;
            let inactivityTimer = null;
            let finished = false;

            try {
                response = await makeRequest(url, {
                    timeout: this.timeout * 3
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }

                const totalSize = parseInt(response.headers.get('content-length') || '0');
                // 写临时文件，validateOutputSize 也针对它
                writer = fs.createWriteStream(partialFile);

                let downloadedBytes = 0;
                const startTime = Date.now();
                let lastProgressTime = startTime;

                const resetInactivityTimer = () => {
                    if (inactivityTimer) clearTimeout(inactivityTimer);
                    inactivityTimer = setTimeout(() => {
                        try { response.body.destroy(new Error(t('downloader.stalled'))); } catch (_) { }
                    }, this.timeout);
                };

                resetInactivityTimer();

                const validateOutputSize = () => {
                    if (typeof totalSize === 'number' && totalSize > 0) {
                        const stat = fs.statSync(partialFile);
                        if (stat.size < totalSize) {
                            throw new Error(t('downloader.incompleteSize', { actual: stat.size, expected: totalSize }));
                        }
                    }
                };

                await new Promise((resolve, reject) => {
                    response.body.on('data', (chunk) => {
                        if (this.isCancelled) {
                            try { writer.end(() => { if (fs.existsSync(partialFile)) fs.unlinkSync(partialFile); }); } catch (_) { }
                            try { response.body.destroy(); } catch (_) { }
                            return reject(this.cancelError || cancelledError());
                        }

                        resetInactivityTimer();
                        const canContinue = writer.write(chunk);
                        if (!canContinue) {
                            response.body.pause();
                            writer.once('drain', () => {
                                try { response.body.resume(); } catch (_) { }
                            });
                        }
                        downloadedBytes += chunk.length;

                        const now = Date.now();
                        if (now - lastProgressTime > 500) { // 每500ms报告一次进度
                            const progress = totalSize > 0 ? (downloadedBytes / totalSize) * 100 : 0;
                            const elapsed = (now - startTime) / 1000;
                            const speed = elapsed > 0 ? (downloadedBytes / elapsed) : 0;

                            logInfo(`[单线程下载] 进度: ${progress.toFixed(1)}%, 已下载: ${(downloadedBytes / 1024 / 1024).toFixed(1)}MB, 速度: ${(speed / 1024 / 1024).toFixed(1)}MB/s`);

                            if (this.progressCallback) {
                                this.progressCallback({
                                    type: 'single',
                                    downloadedBytes,
                                    totalBytes: totalSize,
                                    progress,
                                    speed
                                });
                            }

                            lastProgressTime = now;
                        }
                    });

                    response.body.on('end', () => {
                        if (finished) return;
                        finished = true;
                        if (inactivityTimer) clearTimeout(inactivityTimer);
                        const elapsed = Math.max(0.001, (Date.now() - startTime) / 1000);
                        if (this.progressCallback) {
                            this.progressCallback({
                                type: 'single',
                                downloadedBytes: totalSize || downloadedBytes,
                                totalBytes: totalSize || downloadedBytes,
                                progress: totalSize ? Math.min(100, (downloadedBytes / totalSize) * 100) : 100,
                                speed: downloadedBytes / elapsed
                            });
                        }
                        // 等待文件流真正关闭后再校验大小，避免异步 flush 未完成导致误判
                        writer.end((error) => {
                            if (error) {
                                reject(error);
                                return;
                            }
                            try {
                                validateOutputSize();
                                // 校验通过才落到目标路径：原子替换，原有文件在此之前完好
                                fs.renameSync(partialFile, outputFile);
                                resolve();
                            } catch (validateError) {
                                reject(validateError);
                            }
                        });
                    });

                    response.body.on('close', () => {
                        if (!finished) {
                            return reject(new Error(t('downloader.closedIncomplete')));
                        }
                    });

                    response.body.on('error', (error) => {
                        if (this.isCancelled) {
                            return reject(this.cancelError);
                        }
                        try { if (writer && !writer.destroyed) writer.destroy(); } catch (_) { }
                        reject(error);
                    });

                    writer.on('error', (error) => {
                        if (this.isCancelled) {
                            return reject(this.cancelError);
                        }
                        reject(error);
                    });

                    writer.on('finish', () => {
                    });
                });

                return;
            } catch (error) {
                lastError = error;
                logWarn(`[单线程下载] 失败(尝试 ${attempt}/${maxAttempts}):`, error?.message || String(error));
                try { if (writer && !writer.destroyed) writer.destroy(); } catch (_) { }
                // 只清自己的临时文件，不动 outputFile —— 后者是磁盘上原有的文件
                try { if (fs.existsSync(partialFile)) fs.unlinkSync(partialFile); } catch (_) { }
                if (attempt < maxAttempts) {
                    const backoff = Math.min(8000, Math.pow(2, attempt - 1) * 1000);
                    await new Promise(r => setTimeout(r, backoff));
                    continue;
                }
                throw error;
            } finally {
                try { if (writer && !writer.destroyed) writer.destroy(); } catch (_) { }
            }
        }

        // 全部尝试失败：清掉残留的临时文件，但保留 outputFile 原有的内容
        try { if (fs.existsSync(partialFile)) fs.unlinkSync(partialFile); } catch (_) { }
        throw lastError || new Error(t('downloader.singleThreadFailed'));
    }


    async download(url, outputFile, options = {}) {
        const startTime = Date.now();
        logInfo(`[多线程下载] 开始下载: ${url}`);

        if (!url || typeof url !== 'string') {
            throw new Error(t('downloader.invalidUrl'));
        }

        if (!outputFile || typeof outputFile !== 'string') {
            throw new Error(t('downloader.invalidOutputPath'));
        }

        try {
            const fileSize = await this.getFileSize(url);
            if (!fileSize) {
                logInfo('[多线程下载] 无法获取文件大小，使用单线程下载');
                await this.downloadSingleThread(url, outputFile);
                return;
            }

            logInfo(`[多线程下载] 文件大小: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

            logInfo('[多线程下载] 检查服务器范围请求支持...');
            const supportsRange = await this.checkRangeSupport(url);
            logInfo(`[多线程下载] 范围请求支持检测结果: ${supportsRange}`);

            if (!supportsRange) {
                logInfo('[多线程下载] 服务器不支持范围请求，切换为单线程下载模式');
                await this.downloadSingleThread(url, outputFile);
                return;
            }

            if (fileSize < this.minMultiThreadSize) {
                logInfo('[多线程下载] 文件较小，使用单线程下载');
                await this.downloadSingleThread(url, outputFile);
                return;
            }

            // 加上随机后缀：原先只用 Date.now()，同毫秒并发两次下载会共用同一目录，
            // chunk_${i}.tmp 互相覆盖
            const tempDir = path.join(path.dirname(outputFile),
                `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }
            try {
                const totalParts = Math.ceil(fileSize / this.chunkSize);
                const parts = [];
                for (let i = 0; i < totalParts; i++) {
                    const start = i * this.chunkSize;
                    const end = Math.min(start + this.chunkSize - 1, fileSize - 1);
                    parts.push({ index: i, start, end });
                }

                logInfo(`[多线程下载] 文件大小: ${(fileSize / 1024 / 1024).toFixed(2)} MB，分片数: ${totalParts}，每片 ${(this.chunkSize / 1024 / 1024).toFixed(2)} MB`);

                const originalCallback = this.progressCallback;
                const chunkProgress = new Array(totalParts).fill(0);
                let lastProgressReport = Date.now();
                let activeCount = 0;

                const reportMultiThreadProgress = () => {
                    const totalDownloaded = chunkProgress.reduce((sum, v) => sum + v, 0);
                    const percent = Math.min(100, (totalDownloaded / fileSize) * 100);
                    const elapsed = (Date.now() - startTime) / 1000;
                    const speed = elapsed > 0 ? (totalDownloaded / elapsed) : 0;
                    if (originalCallback) {
                        originalCallback({
                            type: 'multi',
                            downloadedBytes: totalDownloaded,
                            totalBytes: fileSize,
                            progress: percent,
                            speed,
                            activeChunks: activeCount
                        });
                    }
                };

                const enhancedProgressCallback = (progress) => {
                    if (progress.type === 'chunk') {
                        const safeDownloaded = Math.min(
                            typeof progress.downloadedBytes === 'number' ? progress.downloadedBytes : 0,
                            typeof progress.totalBytes === 'number' && isFinite(progress.totalBytes) ? progress.totalBytes : Infinity
                        );
                        chunkProgress[progress.chunkIndex] = safeDownloaded;
                        const now = Date.now();
                        if (now - lastProgressReport > 500) {
                            reportMultiThreadProgress();
                            lastProgressReport = now;
                        }
                    }
                };

                this.progressCallback = enhancedProgressCallback;

                const results = new Array(totalParts);
                let cursor = 0;

                try {
                    const runWorker = async () => {
                        while (true) {
                            if (this.isCancelled) throw this.cancelError || cancelledError();
                            const idx = cursor++;
                            if (idx >= parts.length) break;
                            const myTask = parts[idx];
                            activeCount++;
                            try {
                                const r = await this.downloadChunk(url, myTask.start, myTask.end, myTask.index, tempDir);
                                results[myTask.index] = r;
                            } finally {
                                activeCount--;
                            }
                        }
                    };

                    const workerCount = Math.min(this.maxConcurrency, parts.length);
                    const workers = new Array(workerCount).fill(0).map(() => runWorker());
                    await Promise.all(workers);
                } finally {
                    this.progressCallback = originalCallback;
                }

                reportMultiThreadProgress();
                if (originalCallback) {
                    originalCallback({
                        type: 'multi',
                        downloadedBytes: fileSize,
                        totalBytes: fileSize,
                        progress: 100,
                        speed: fileSize / Math.max(0.001, (Date.now() - startTime) / 1000),
                        activeChunks: 0
                    });
                }

                const completedChunks = results.filter(Boolean);
                logInfo(`[多线程下载] 分片全部完成，准备合并 ${completedChunks.length} 个分片`);
                await this.mergeChunks(completedChunks, outputFile);

                try {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                } catch (error) {
                    logWarn('[多线程下载] 清理临时目录失败:', error.message);
                }

            } catch (error) {
                try {
                    if (fs.existsSync(tempDir)) {
                        fs.rmSync(tempDir, { recursive: true, force: true });
                    }
                } catch (cleanupError) {
                    logWarn('[多线程下载] 清理临时目录失败:', cleanupError.message);
                }
                // 探测阶段说支持 Range、实际分片时又不支持（CDN 常见）：
                // 降级到单线程重下，而不是让整次下载失败
                if (error?.code === RANGE_UNSUPPORTED_CODE && !this.isCancelled) {
                    logWarn('[多线程下载] 服务器实际不支持范围请求，降级为单线程下载');
                    await this.downloadSingleThread(url, outputFile);
                    return;
                }
                throw error;
            }

            const elapsed = (Date.now() - startTime) / 1000;
            const speed = fileSize / elapsed;
            const speedText = speed > 1024 * 1024
                ? `${(speed / 1024 / 1024).toFixed(1)} MB/s`
                : `${(speed / 1024).toFixed(0)} KB/s`;

            logInfo(`[多线程下载] 下载完成，耗时: ${elapsed.toFixed(1)}s，平均速度: ${speedText}`);

        } catch (error) {
            logError('[多线程下载] 下载失败:', error);
            throw error;
        } finally {
            // 单线程路径的临时文件：成功时已 rename，失败/降级时在这里兜底清理。
            // 不能碰 outputFile —— 那是磁盘上原有的文件
            try {
                const leftover = `${outputFile}.downloading`;
                if (fs.existsSync(leftover)) fs.unlinkSync(leftover);
            } catch (_) { }
        }
    }


    async verifyFile(filePath, expectedMd5) {
        // 无期望值时返回 null 而不是 true：true 与「校验通过」不可区分，
        // 调用方会误以为校验过了
        if (!expectedMd5) return null;

        return new Promise((resolve) => {
            try {
                // 流式算 MD5：原先 readFileSync 把整个文件读进内存，
                // 编译器动辄上百 MB
                const hash = crypto.createHash('md5');
                const rs = fs.createReadStream(filePath);
                rs.on('data', (piece) => hash.update(piece));
                rs.on('error', (error) => {
                    logError('[多线程下载] 文件验证失败:', error.message);
                    resolve(false);
                });
                rs.on('end', () => resolve(hash.digest('hex') === expectedMd5));
            } catch (error) {
                logError('[多线程下载] 文件验证失败:', error.message);
                resolve(false);
            }
        });
    }
}

module.exports = MultiThreadDownloader;
module.exports.CANCELLED_CODE = CANCELLED_CODE;
module.exports.RANGE_UNSUPPORTED_CODE = RANGE_UNSUPPORTED_CODE;
module.exports.isCancelledError = isCancelledError;
