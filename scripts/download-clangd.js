const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { path7za } = require('7zip-bin');
const extractZip = require('extract-zip');

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
    const idx = args.findIndex((value) => value === `--${name}`);
    if (idx >= 0 && idx + 1 < args.length) {
        return args[idx + 1];
    }
    return fallback;
};

const normalizePlatform = (raw) => {
    const value = String(raw || '').toLowerCase();
    if (value === 'win' || value === 'windows') return 'win32';
    if (value === 'mac' || value === 'osx' || value === 'macos') return 'darwin';
    if (value === 'linux') return 'linux';
    return value || process.platform;
};

const version = readArg('version', process.env.CLANGD_VERSION || '23.1.0');
const tag = readArg('tag', process.env.CLANGD_TAG || version);
const repo = readArg('repo', process.env.CLANGD_REPO || 'clangd/clangd');
const platform = normalizePlatform(readArg('platform', process.env.OICPP_CLANGD_PLATFORM || process.platform));
const outputRoot = path.resolve(readArg('output', process.env.CLANGD_OUTPUT || path.join(__dirname, '..', 'build', 'clangd')));
const directUrl = readArg('url', process.env.CLANGD_DOWNLOAD_URL || '');
const skipSslVerify = process.env.OICPP_SKIP_SSL_VERIFY === '1' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';
const tempRoot = path.join(outputRoot, '_download');
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 10;

const platformPatterns = {
    win32: [
        /^clangd-windows-.*\.zip$/i,
        /^clangd-win.*\.zip$/i
    ],
    darwin: [
        /^clangd-mac-.*\.zip$/i,
        /^clangd-macos-.*\.zip$/i
    ],
    linux: [
        /^clangd-linux-.*\.zip$/i
    ]
};

const ensureDir = (dirPath) => {
    fs.mkdirSync(dirPath, { recursive: true });
};

const getRetryDelayMs = (retryAfter) => {
    const seconds = Number.parseInt(retryAfter, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 30 * 1000;
};

const retryAfterRateLimit = (retryAfter, retriesLeft, action) => {
    if (retriesLeft <= 0) return null;
    const delayMs = getRetryDelayMs(retryAfter);
    console.warn(`[clangd] GitHub returned 403, retrying in ${Math.ceil(delayMs / 1000)} seconds (${retriesLeft} retries left)`);
    return new Promise((resolve) => setTimeout(resolve, delayMs)).then(action);
};

const requestJson = (url, token, retriesLeft = 3) => new Promise((resolve, reject) => {
    const opts = new URL(url);
    const headers = {
        'User-Agent': 'oicpp-clangd-downloader',
        'Accept': 'application/vnd.github+json'
    };
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }
    opts.headers = headers;
    if (skipSslVerify) opts.rejectUnauthorized = false;
    https.get(opts, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            if (res.statusCode === 403) {
                const retry = retryAfterRateLimit(res.headers['retry-after'], retriesLeft, () => requestJson(url, token, retriesLeft - 1));
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
            } catch (err) {
                reject(err);
            }
        });
    }).on('error', reject);
});

const downloadFile = (url, dest, token, retriesLeft = 3, redirectsLeft = MAX_REDIRECTS) => new Promise((resolve, reject) => {
    const opts = new URL(url);
    const headers = { 'User-Agent': 'oicpp-clangd-downloader' };
    if (token) {
        headers.Authorization = `Bearer ${token}`;
    }
    opts.headers = headers;
    if (skipSslVerify) opts.rejectUnauthorized = false;

    https.get(opts, (res) => {
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
            const retry = retryAfterRateLimit(res.headers['retry-after'], retriesLeft, () => downloadFile(url, dest, token, retriesLeft - 1, redirectsLeft));
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
            try { fs.unlinkSync(dest); } catch (_) {}
            reject(error);
        };
        const file = fs.createWriteStream(dest);
        file.on('error', fail);
        res.on('aborted', () => fail(new Error(`Download aborted: ${url}`)));
        res.on('error', fail);
        res.on('data', (chunk) => {
            receivedBytes += chunk.length;
            if (receivedBytes > MAX_DOWNLOAD_BYTES) {
                res.destroy();
                fail(new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes: ${url}`));
            }
        });
        res.pipe(file);
        file.on('finish', () => file.close((error) => {
            if (settled) return;
            settled = true;
            if (error) reject(error);
            else resolve();
        }));
    }).on('error', (err) => {
        try { fs.unlinkSync(dest); } catch (_) {}
        reject(err);
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
            console.log('[clangd] Using cached download');
        } else {
            const partPath = `${dest}.part`;
            try { fs.unlinkSync(partPath); } catch (_) {}
            console.log(`[clangd] Downloading to ${dest}`);
            await downloadFile(url, partPath, token);
            fs.renameSync(partPath, dest);
        }
        if (!expected) {
            console.warn('[clangd] No SHA-256 digest was provided; archive integrity was not verified');
            return;
        }
        const actual = await hashFile(dest);
        if (actual === expected) return;
        console.warn(`[clangd] SHA-256 mismatch for ${dest}`);
        try { fs.unlinkSync(dest); } catch (_) {}
        if (attempt === 1) {
            throw new Error(`clangd archive SHA-256 mismatch: expected ${expected}, got ${actual}`);
        }
    }
};

const run7z = (argsList) => {
    const result = spawnSync(path7za, argsList, { stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`7z failed: ${argsList.join(' ')}`);
    }
};

const extractArchive = async (archivePath, extractTo) => {
    ensureDir(extractTo);
    const lower = archivePath.toLowerCase();
    if (lower.endsWith('.zip')) {
        await extractZip(archivePath, { dir: extractTo });
        return;
    }

    run7z(['x', archivePath, `-o${extractTo}`, '-y']);
    if (lower.endsWith('.tar.xz') || lower.endsWith('.tar.gz')) {
        const tarPath = path.join(extractTo, path.basename(archivePath).replace(/\.(xz|gz)$/i, ''));
        if (fs.existsSync(tarPath)) {
            run7z(['x', tarPath, `-o${extractTo}`, '-y']);
        }
    }
};

const walkForClangdRoot = (baseDir) => {
    const queue = [{ dir: baseDir, depth: 0 }];
    const maxDepth = 6;
    const found = [];

    while (queue.length) {
        const { dir, depth } = queue.shift();
        if (depth > maxDepth) continue;
        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (_) {
            continue;
        }

        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                queue.push({ dir: full, depth: depth + 1 });
                continue;
            }
            const lower = entry.name.toLowerCase();
            if (lower === 'clangd' || lower === 'clangd.exe') {
                const binDir = path.dirname(full);
                if (path.basename(binDir).toLowerCase() === 'bin') {
                    found.push(path.dirname(binDir));
                }
            }
        }
    }

    if (!found.length) return null;
    found.sort((a, b) => a.length - b.length);
    return found[0];
};

const main = async () => {
    if (!platformPatterns[platform]) {
        throw new Error(`Unsupported platform: ${platform}`);
    }

    if (skipSslVerify) {
        console.warn('[clangd] SSL certificate verification disabled (OICPP_SKIP_SSL_VERIFY=1)');
    }

    const targetRoot = path.join(outputRoot, platform);
    const targetBinary = path.join(targetRoot, 'bin', platform === 'win32' ? 'clangd.exe' : 'clangd');
    if (fs.existsSync(targetBinary)) {
        const versionCheck = spawnSync(targetBinary, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        if (versionCheck.status === 0 && /clangd version/i.test(versionCheck.stdout || '')) {
            console.log(`[clangd] Target exists: ${targetBinary}, skipping`);
            return;
        }
        console.warn('[clangd] Existing target is incomplete or invalid; reinstalling');
        fs.rmSync(targetRoot, { recursive: true, force: true });
    }

    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    const patterns = platformPatterns[platform] || [];
    let selected = null;

    if (directUrl) {
        const parsedUrl = new URL(directUrl);
        selected = {
            name: path.basename(parsedUrl.pathname) || `clangd-${platform}-${version}.zip`,
            browser_download_url: parsedUrl.toString()
        };
        console.log(`[clangd] Using direct release asset: ${selected.name}`);
    } else {
        const releaseUrl = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
        console.log(`[clangd] Fetching release ${releaseUrl}`);

        try {
            const release = await requestJson(releaseUrl, token || undefined);
            const assets = Array.isArray(release.assets) ? release.assets : [];
            for (const pattern of patterns) {
                selected = assets.find((asset) => pattern.test(asset.name));
                if (selected) break;
            }

            if (!selected) {
                const names = assets.map((asset) => asset.name).join(', ');
                throw new Error(`clangd asset not found for ${platform}. Assets: ${names}`);
            }
        } catch (err) {
            const fallbackAssetNames = {
                win32: `clangd-windows-${version}.zip`,
                darwin: `clangd-mac-${version}.zip`,
                linux: `clangd-linux-${version}.zip`
            };
            const fallbackName = fallbackAssetNames[platform];
            if (!fallbackName) throw err;

            console.warn(`[clangd] Release API unavailable, trying direct asset: ${err?.message || err}`);
            selected = {
                name: fallbackName,
                browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${fallbackName}`
            };
        }
    }

    console.log(`[clangd] Selected asset: ${selected.name}`);
    ensureDir(tempRoot);
    const downloadPath = path.join(tempRoot, selected.name);

    const extractRoot = path.join(tempRoot, 'extract');
    const extractWithRetry = async () => {
        fs.rmSync(extractRoot, { recursive: true, force: true });
        ensureDir(extractRoot);

        console.log('[clangd] Extracting...');
        await extractArchive(downloadPath, extractRoot);
    };

    const digest = String(selected.digest || process.env.CLANGD_SHA256 || '').replace(/^sha256:/i, '');
    await ensureDownload(selected.browser_download_url, downloadPath, token || undefined, digest);

    try {
        await extractWithRetry();
    } catch (err) {
        console.log('[clangd] Cached archive failed to extract, re-downloading...');
        try { fs.unlinkSync(downloadPath); } catch (_) {}
        await ensureDownload(selected.browser_download_url, downloadPath, token || undefined, digest);
        await extractWithRetry();
    }

    const installRoot = walkForClangdRoot(extractRoot);
    if (!installRoot) {
        throw new Error('Unable to locate clangd root (bin/clangd) after extraction');
    }

    fs.rmSync(targetRoot, { recursive: true, force: true });
    ensureDir(outputRoot);

    console.log(`[clangd] Copying ${installRoot} -> ${targetRoot}`);
    fs.cpSync(installRoot, targetRoot, { recursive: true });
    const installedBinary = path.join(targetRoot, 'bin', platform === 'win32' ? 'clangd.exe' : 'clangd');
    const versionCheck = spawnSync(installedBinary, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (versionCheck.status !== 0 || !/clangd version/i.test(versionCheck.stdout || '')) {
        throw new Error(`Downloaded clangd binary is not executable: ${versionCheck.stderr || versionCheck.error || 'unknown error'}`);
    }

    console.log(`[clangd] Installed ${versionCheck.stdout.trim()}`);
};

main().catch((err) => {
    console.error('[clangd] Failed:', err);
    process.exit(1);
});
