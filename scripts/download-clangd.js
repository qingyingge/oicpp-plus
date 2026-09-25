const fs = require('fs');
const path = require('path');
const { createReleaseDownloader } = require('./lib/release-downloader');
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
const skipSslVerify = process.env.NODE_ENV === 'development' && process.env.OICPP_SKIP_SSL_VERIFY === '1';
const tempRoot = path.join(outputRoot, '_download');
const { requestJson, ensureDownload } = createReleaseDownloader({
    label: 'clangd',
    userAgent: 'oicpp-clangd-downloader',
    skipSslVerify,
    maxBytes: 512 * 1024 * 1024,
    maxRedirects: 10
});

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

const run7z = (argsList) => {
    const result = spawnSync(path7za, argsList, { stdio: 'inherit', timeout: 300000 });
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
