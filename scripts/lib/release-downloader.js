'use strict';

const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

function createReleaseDownloader(options = {}) {
    const label = options.label || 'release';
    const userAgent = options.userAgent || `${label}-downloader`;
    const skipSslVerify = !!options.skipSslVerify;
    const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
        ? options.maxBytes
        : 512 * 1024 * 1024;
    const maxRedirects = Number.isFinite(options.maxRedirects) && options.maxRedirects > 0
        ? options.maxRedirects
        : 10;
    const retryDelayMs = Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0
        ? options.retryDelayMs
        : 30000;

    const getRetryDelayMs = (retryAfter) => {
        const seconds = Number.parseInt(retryAfter, 10);
        return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : retryDelayMs;
    };

    const retryAfterRateLimit = (retryAfter, retriesLeft, action) => {
        if (retriesLeft <= 0) return null;
        const delayMs = getRetryDelayMs(retryAfter);
        console.warn(`[${label}] GitHub returned 403, retrying in ${Math.ceil(delayMs / 1000)} seconds (${retriesLeft} retries left)`);
        return new Promise((resolve) => setTimeout(resolve, delayMs)).then(action);
    };

    const getTransport = (url) => {
        if (url.protocol === 'http:') {
            if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
                throw new Error('HTTP release downloads are restricted to loopback hosts');
            }
            return http;
        }
        return https;
    };

    const requestJson = (url, token, retriesLeft = 3) => new Promise((resolve, reject) => {
        const opts = new URL(url);
        const headers = {
            'User-Agent': userAgent,
            'Accept': 'application/vnd.github+json'
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        opts.headers = headers;
        if (skipSslVerify) opts.rejectUnauthorized = false;
        const request = getTransport(opts).get(opts, (res) => {
            let data = '';
            let receivedBytes = 0;
            res.on('data', (chunk) => {
                receivedBytes += chunk.length;
                if (receivedBytes > 8 * 1024 * 1024) {
                    res.destroy(new Error(`${label} API response exceeds size limit`));
                    return;
                }
                data += chunk;
            });
            res.on('error', reject);
            res.on('end', () => {
                if (res.statusCode === 403) {
                    const retry = retryAfterRateLimit(
                        res.headers['retry-after'],
                        retriesLeft,
                        () => requestJson(url, token, retriesLeft - 1)
                    );
                    if (retry) {
                        retry.then(resolve, reject);
                        return;
                    }
                }
                if (res.statusCode && res.statusCode >= 400) {
                    reject(new Error(`GitHub API error ${res.statusCode}: ${data.slice(0, 200)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data));
                } catch (error) {
                    reject(error);
                }
            });
        });
        request.setTimeout(30000, () => request.destroy(new Error(`${label} API request timed out`)));
        request.on('error', reject);
    });

    const downloadFile = (url, dest, token, retriesLeft = 3, redirectsLeft = maxRedirects) => new Promise((resolve, reject) => {
        const opts = new URL(url);
        const headers = { 'User-Agent': userAgent };
        if (token) headers.Authorization = `Bearer ${token}`;
        opts.headers = headers;
        if (skipSslVerify) opts.rejectUnauthorized = false;

        const request = getTransport(opts).get(opts, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0) {
                    reject(new Error(`Too many redirects while downloading ${url}`));
                    return;
                }
                const nextUrl = new URL(res.headers.location, opts);
                const nextToken = nextUrl.origin === opts.origin ? token : '';
                downloadFile(nextUrl.toString(), dest, nextToken, retriesLeft, redirectsLeft - 1).then(resolve).catch(reject);
                return;
            }
            if (res.statusCode === 403) {
                res.resume();
                const retry = retryAfterRateLimit(
                    res.headers['retry-after'],
                    retriesLeft,
                    () => downloadFile(url, dest, token, retriesLeft - 1, redirectsLeft)
                );
                if (retry) {
                    retry.then(resolve, reject);
                    return;
                }
            }
            if (res.statusCode && res.statusCode >= 400) {
                res.resume();
                reject(new Error(`Download failed ${res.statusCode}: ${url}`));
                return;
            }

            let receivedBytes = 0;
            let settled = false;
            const fail = (error) => {
                if (settled) return;
                settled = true;
                try { fs.unlinkSync(dest); } catch (_) { }
                reject(error);
            };
            const file = fs.createWriteStream(dest);
            file.on('error', fail);
            res.on('aborted', () => fail(new Error(`Download aborted: ${url}`)));
            res.on('error', fail);
            res.on('data', (chunk) => {
                receivedBytes += chunk.length;
                if (receivedBytes > maxBytes) {
                    res.destroy();
                    fail(new Error(`Download exceeds ${maxBytes} bytes: ${url}`));
                }
            });
            res.pipe(file);
            file.on('finish', () => file.close((error) => {
                if (settled) return;
                settled = true;
                if (error) reject(error);
                else resolve();
            }));
        });
        request.setTimeout(60000, () => request.destroy(new Error(`${label} download timed out`)));
        request.on('error', (error) => {
            try { fs.unlinkSync(dest); } catch (_) { }
            reject(error);
        });
    });

    const hashFile = (filePath) => new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', reject);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });

    const ensureDownload = async (url, dest, token, digest = '') => {
        const expected = String(digest || '').replace(/^sha256:/i, '').toLowerCase();
        for (let attempt = 0; attempt < 2; attempt++) {
            if (fs.existsSync(dest)) {
                console.log(`[${label}] Using cached download`);
            } else {
                const partPath = `${dest}.part`;
                try { fs.unlinkSync(partPath); } catch (_) { }
                console.log(`[${label}] Downloading to ${dest}`);
                await downloadFile(url, partPath, token);
                fs.renameSync(partPath, dest);
            }
            if (!expected) {
                console.warn(`[${label}] No SHA-256 digest was provided; archive integrity was not verified`);
                return;
            }
            const actual = await hashFile(dest);
            if (actual === expected) return;
            console.warn(`[${label}] SHA-256 mismatch for ${dest}`);
            try { fs.unlinkSync(dest); } catch (_) { }
            if (attempt === 1) {
                throw new Error(`${label} archive SHA-256 mismatch: expected ${expected}, got ${actual}`);
            }
        }
    };

    return {
        downloadFile,
        ensureDownload,
        hashFile,
        requestJson
    };
}

module.exports = {
    createReleaseDownloader
};
