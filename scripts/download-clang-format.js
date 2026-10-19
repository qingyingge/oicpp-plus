const fs = require('fs');
const path = require('path');
const { createReleaseDownloader } = require('./lib/release-downloader');
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

// 点名过的项要能区分「用户点了」和「用了内置默认」：Intel mac 的回退只看这两项，
// 只要点过 version 或 tag 里的任何一个就不再擅自换版本。
const pinnedVersion = readArg('version', process.env.CLANG_FORMAT_VERSION || '');
const pinnedTag = readArg('tag', process.env.CLANG_FORMAT_TAG || '');
// 只点 tag 不点 version 时，版本号从 tag 里推 —— 资产名和 releaseTag 必须来自同一次选择，
// 否则拿 llvmorg-20.1.0 去配 LLVM-23.1.2-... 的资产名，找不着资产又拼出个 404 的直链。
const version = pinnedVersion || (pinnedTag ? pinnedTag.replace(/^llvmorg-/i, '') : '23.1.2');
const tag = pinnedTag || `llvmorg-${version}`;
const repo = readArg('repo', process.env.CLANG_FORMAT_REPO || 'llvm/llvm-project');
const platform = normalizePlatform(readArg('platform', process.env.OICPP_CLANG_FORMAT_PLATFORM || process.platform));
const architecture = String(readArg('arch', process.env.OICPP_CLANG_FORMAT_ARCH || process.arch)).toLowerCase();
const isIntelMac = platform === 'darwin' && architecture === 'x64';
const usesIntelMacFallback = isIntelMac && !pinnedVersion && !pinnedTag;
const assetVersion = usesIntelMacFallback ? '19.1.7' : version;
const releaseTag = usesIntelMacFallback ? 'llvmorg-19.1.7' : tag;
if (usesIntelMacFallback) {
    console.warn(`[clang-format] x86_64 macOS 且没有点名版本：取上游最后一个 Intel macOS 包 19.1.7（默认的 ${version} 没有这个资产）`);
}
if (isIntelMac && !usesIntelMacFallback && releaseTag !== 'llvmorg-19.1.7') {
    console.warn(`[clang-format] 按你点名的 ${releaseTag} / ${assetVersion} 取，不再自动换成 19.1.7 —— 上游从 20 起不发 x86_64 macOS 包，取不到是预期结果`);
}
const outputRoot = path.resolve(readArg('output', process.env.CLANG_FORMAT_OUTPUT || path.join(__dirname, '..', 'build', 'clang-format')));
const directUrl = readArg('url', process.env.CLANG_FORMAT_DOWNLOAD_URL || '');
const expectedDigest = String(readArg('digest', process.env.CLANG_FORMAT_SHA256 || '')).replace(/^sha256:/i, '').toLowerCase();
// 校验值是给「你以为要下的那个包」上的锁。回退把包换成另一份时，这把锁要么永远对不上
// （下载到一半才失败，报个和真实原因无关的 checksum 错），要么被悄悄摘掉（装了没验过的东西）。
// 两个都不能接受，所以在这里当场拒掉，并把怎么解写进报错。给了 --url 就不算冲突：
// 那时候下的是你指定的那个文件，回退只改了本地临时文件名。
const digestConflictsWithFallback = usesIntelMacFallback && !!expectedDigest && !directUrl;
const skipSslVerify = process.env.NODE_ENV === 'development' && process.env.OICPP_SKIP_SSL_VERIFY === '1';
const tempRoot = path.join(outputRoot, '_download');
const { requestJson, ensureDownload } = createReleaseDownloader({
    label: 'clang-format',
    userAgent: 'oicpp-clang-format-downloader',
    skipSslVerify,
    maxBytes: 4 * 1024 * 1024 * 1024,
    maxRedirects: 10
});

// 官方压缩包内的 LICENSE.TXT 才是与该二进制严格对应的副本；但它并非每次都存在，
// 缺了就会因为「二进制在、许可不在」而重下整个工具链。仓库内这份是同一份正文
// （Apache-2.0 WITH LLVM-exception，随 LLVM 版本更新），仅在压缩包里抽不到时兜底。
const fallbackLicense = path.join(__dirname, '..', 'third-party', 'licenses', 'llvm-apache-2.0-with-llvm-exception.txt');

const resolveLicenseSource = (extractedLicense) => {
    if (extractedLicense) {
        return extractedLicense;
    }
    if (fs.existsSync(fallbackLicense)) {
        console.log(`[clang-format] LICENSE.TXT missing from the archive, using ${fallbackLicense}`);
        return fallbackLicense;
    }
    return null;
};

const assetNames = {
    'win32-x64': `clang+llvm-${assetVersion}-x86_64-pc-windows-msvc.tar.xz`,
    'win32-arm64': `clang+llvm-${assetVersion}-aarch64-pc-windows-msvc.tar.xz`,
    'darwin-x64': `LLVM-${assetVersion}-macOS-x86_64.tar.xz`,
    'darwin-arm64': `LLVM-${assetVersion}-macOS-ARM64.tar.xz`,
    'linux-x64': `LLVM-${assetVersion}-Linux-X64.tar.xz`,
    'linux-arm64': `LLVM-${assetVersion}-Linux-ARM64.tar.xz`
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

    const releaseUrl = `https://api.github.com/repos/${repo}/releases/tags/${releaseTag}`;
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
            browser_download_url: `https://github.com/${repo}/releases/download/${releaseTag}/${encodeURIComponent(assetName)}`,
            digest: expectedDigest ? `sha256:${expectedDigest}` : null
        };
    }
};

const main = async () => {
    if (digestConflictsWithFallback) {
        throw new Error(`指定的 sha256 属于 ${version} 的包，但 x86_64 macOS 会回退到 19.1.7 —— 二者不可能同时对上。`
            + `请改成 --tag llvmorg-19.1.7 --digest <19.1.7 的 sha256>，或去掉 --digest 改用 Release API 自带的资产校验值`);
    }
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
    // 二进制已就位、只差许可正文时不必重下 1 GB 工具链，直接用仓库里的同一份补齐
    if (fs.existsSync(targetBinary) && fs.existsSync(fallbackLicense)) {
        ensureDir(targetRoot);
        fs.copyFileSync(fallbackLicense, targetLicense);
        console.log(`[clang-format] Filled in missing license from ${fallbackLicense}`);
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
    const licenseSource = resolveLicenseSource(extractedLicense);
    if (!licenseSource) {
        throw new Error(`Unable to locate LICENSE.TXT in ${path.basename(downloadPath)}`);
    }

    const stagingRoot = path.join(outputRoot, `.${platform}.staging-${process.pid}`);
    const stagedBinary = path.join(stagingRoot, 'bin', binaryName);
    const stagedLicense = path.join(stagingRoot, 'LICENSE.TXT');
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    ensureDir(path.dirname(stagedBinary));
    fs.copyFileSync(extractedBinary, stagedBinary);
    fs.copyFileSync(licenseSource, stagedLicense);
    if (platform !== 'win32') {
        fs.chmodSync(stagedBinary, 0o755);
    }

    const versionResult = spawnSync(stagedBinary, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (versionResult.status !== 0 || !/clang-format version/i.test(versionResult.stdout || '')) {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
        throw new Error(`Downloaded clang-format binary is not executable: ${versionResult.stderr || versionResult.error || 'unknown error'}`);
    }

    fs.rmSync(targetRoot, { recursive: true, force: true });
    fs.renameSync(stagingRoot, targetRoot);
    console.log(`[clang-format] Installed ${versionResult.stdout.trim()}`);
};

main().catch((err) => {
    console.error('[clang-format] Failed:', err);
    process.exit(1);
});
