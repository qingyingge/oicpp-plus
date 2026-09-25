const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { path7za } = require('7zip-bin');

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

const version = readArg('version', process.env.CLANG_FORMAT_VERSION || '23.1.2');
const tag = readArg('tag', process.env.CLANG_FORMAT_TAG || `llvmorg-${version}`);
const repo = readArg('repo', process.env.CLANG_FORMAT_REPO || 'llvm/llvm-project');
const platform = normalizePlatform(readArg('platform', process.env.OICPP_CLANG_FORMAT_PLATFORM || process.platform));
const architecture = String(readArg('arch', process.env.OICPP_CLANG_FORMAT_ARCH || process.arch)).toLowerCase();
const outputRoot = path.resolve(readArg('output', process.env.CLANG_FORMAT_OUTPUT || path.join(__dirname, '..', 'build', 'clang-format')));
const directUrl = readArg('url', process.env.CLANG_FORMAT_DOWNLOAD_URL || '');
const expectedDigest = String(readArg('digest', process.env.CLANG_FORMAT_SHA256 || '')).replace(/^sha256:/i, '').toLowerCase();
const skipSslVerify = process.env.OICPP_SKIP_SSL_VERIFY === '1' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';
const tempRoot = path.join(outputRoot, '_download');

const assetNames = {
    'win32-x64': `clang+llvm-${version}-x86_64-pc-windows-msvc.tar.xz`,
    'win32-arm64': `clang+llvm-${version}-aarch64-pc-windows-msvc.tar.xz`,
    'darwin-x64': `LLVM-${version}-macOS-x86_64.tar.xz`,
    'darwin-arm64': `LLVM-${version}-macOS-ARM64.tar.xz`,
    'linux-x64': `LLVM-${version}-Linux-X64.tar.xz`,
    'linux-arm64': `LLVM-${version}-Linux-ARM64.tar.xz`
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
    console.warn(`[clang-format] GitHub returned 403, retrying in ${Math.ceil(delayMs / 1000)} seconds (${retriesLeft} retries left)`);
    return new Promise((resolve) => setTimeout(resolve, delayMs)).then(action);
};

const requestJson = (url, token, retriesLeft = 3) => new Promise((resolve, reject) => {
    const opts = new URL(url);
    const headers = {
        'User-Agent': 'oicpp-clang-format-downloader',
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

const downloadFile = (url, dest, token, retriesLeft = 3, redirectsLeft = 10) => new Promise((resolve, reject) => {
    const opts = new URL(url);
    const headers = { 'User-Agent': 'oicpp-clang-format-downloader' };
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
            downloadFile(res.headers.location, dest, token, retriesLeft, redirectsLeft - 1).then(resolve).catch(reject);
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
        const file = fs.createWriteStream(dest);
        file.on('error', reject);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
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

const ensureDownload = async (url, dest, token, digest) => {
    for (let attempt = 0; attempt < 2; attempt++) {
        if (fs.existsSync(dest)) {
            console.log('[clang-format] Using cached download');
        } else {
            console.log(`[clang-format] Downloading to ${dest}`);
            await downloadFile(url, dest, token);
        }
        if (!digest) return;
        const actual = await hashFile(dest);
        if (actual === digest) return;
        console.warn(`[clang-format] SHA-256 mismatch for ${dest}`);
        fs.unlinkSync(dest);
        if (attempt === 1) {
            throw new Error(`clang-format archive SHA-256 mismatch: expected ${digest}, got ${actual}`);
        }
    }
};

const run7z = (argsList) => {
    const result = spawnSync(path7za, argsList, { stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`7z failed: ${argsList.join(' ')}`);
    }
};

const extractFromZip = (archivePath, extractTo, binaryName) => {
    run7z([
        'x', archivePath, `-o${extractTo}`, '-y',
        `-ir!${binaryName}`,
        '-ir!LICENSE.TXT'
    ]);
};

const extractFromXz = (archivePath, extractTo, binaryName) => new Promise((resolve, reject) => {
    const source = spawn(path7za, ['x', archivePath, '-so'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const target = spawn(path7za, [
        'x', '-si', '-ttar', `-o${extractTo}`, '-y',
        `-ir!${binaryName}`,
        '-ir!LICENSE.TXT'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    source.stderr.on('data', (chunk) => { stderr += chunk; });
    target.stderr.on('data', (chunk) => { stderr += chunk; });
    source.on('error', reject);
    target.on('error', reject);
    source.stdout.pipe(target.stdin);
    target.on('close', (code) => {
        if (code === 0) {
            resolve();
            return;
        }
        reject(new Error(`Unable to extract ${binaryName} from ${path.basename(archivePath)}: ${stderr.trim()}`));
    });
});

const findFile = (baseDir, fileName) => {
    const queue = [baseDir];
    while (queue.length) {
        const current = queue.shift();
        let entries = [];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch (_) {
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(fullPath);
            } else if (entry.name === fileName) {
                return fullPath;
            }
        }
    }
    return null;
};

const getAssetName = () => {
    const name = assetNames[`${platform}-${architecture}`];
    if (!name) {
        throw new Error(`Unsupported clang-format platform: ${platform}-${architecture}`);
    }
    return name;
};

const selectReleaseAsset = async (token) => {
    const assetName = getAssetName();
    if (directUrl) {
        return {
            name: assetName,
            browser_download_url: directUrl,
            digest: expectedDigest ? `sha256:${expectedDigest}` : null
        };
    }

    const releaseUrl = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
    console.log(`[clang-format] Fetching release ${releaseUrl}`);
    try {
        const release = await requestJson(releaseUrl, token || undefined);
        const asset = (release.assets || []).find((candidate) => candidate.name === assetName);
        if (!asset) {
            const names = (release.assets || []).map((candidate) => candidate.name).join(', ');
            throw new Error(`asset not found: ${assetName}. Assets: ${names}`);
        }
        return asset;
    } catch (error) {
        console.warn(`[clang-format] Release API unavailable, using the official asset URL: ${error?.message || error}`);
        return {
            name: assetName,
            browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(assetName)}`,
            digest: expectedDigest ? `sha256:${expectedDigest}` : null
        };
    }
};

const main = async () => {
    if (skipSslVerify) {
        console.warn('[clang-format] SSL certificate verification disabled (OICPP_SKIP_SSL_VERIFY=1)');
    }

    const binaryName = platform === 'win32' ? 'clang-format.exe' : 'clang-format';
    const targetRoot = path.join(outputRoot, platform);
    const targetBinary = path.join(targetRoot, 'bin', binaryName);
    const targetLicense = path.join(targetRoot, 'LICENSE.TXT');
    if (fs.existsSync(targetBinary) && fs.existsSync(targetLicense)) {
        console.log(`[clang-format] Target exists: ${targetBinary}, skipping`);
        return;
    }

    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    const asset = await selectReleaseAsset(token);
    const digest = expectedDigest || String(asset.digest || '').replace(/^sha256:/i, '');
    ensureDir(tempRoot);
    const downloadPath = path.join(tempRoot, asset.name);
    const extractRoot = path.join(tempRoot, 'extract');

    await ensureDownload(asset.browser_download_url, downloadPath, token || undefined, digest);

    fs.rmSync(extractRoot, { recursive: true, force: true });
    ensureDir(extractRoot);
    console.log('[clang-format] Extracting clang-format and license...');
    if (downloadPath.toLowerCase().endsWith('.zip')) {
        extractFromZip(downloadPath, extractRoot, binaryName);
    } else if (downloadPath.toLowerCase().endsWith('.tar.xz') || downloadPath.toLowerCase().endsWith('.tar.gz')) {
        await extractFromXz(downloadPath, extractRoot, binaryName);
    } else {
        throw new Error(`Unsupported clang-format archive: ${downloadPath}`);
    }

    const extractedBinary = findFile(extractRoot, binaryName);
    if (!extractedBinary) {
        throw new Error(`Unable to locate ${binaryName} in ${path.basename(downloadPath)}`);
    }
    const extractedLicense = findFile(extractRoot, 'LICENSE.TXT');
    if (!extractedLicense) {
        throw new Error(`Unable to locate LICENSE.TXT in ${path.basename(downloadPath)}`);
    }

    fs.rmSync(targetRoot, { recursive: true, force: true });
    ensureDir(path.dirname(targetBinary));
    fs.copyFileSync(extractedBinary, targetBinary);
    fs.copyFileSync(extractedLicense, targetLicense);
    if (platform !== 'win32') {
        fs.chmodSync(targetBinary, 0o755);
    }

    const versionResult = spawnSync(targetBinary, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (versionResult.status !== 0 || !/clang-format version/i.test(versionResult.stdout || '')) {
        throw new Error(`Downloaded clang-format binary is not executable: ${versionResult.stderr || versionResult.error || 'unknown error'}`);
    }

    console.log(`[clang-format] Installed ${versionResult.stdout.trim()}`);
};

main().catch((err) => {
    console.error('[clang-format] Failed:', err);
    process.exit(1);
});
