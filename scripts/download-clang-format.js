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

const assetNames = (ver) => ({
    'win32-x64': `clang+llvm-${ver}-x86_64-pc-windows-msvc.tar.xz`,
    'win32-arm64': `clang+llvm-${ver}-aarch64-pc-windows-msvc.tar.xz`,
    'darwin-x64': `LLVM-${ver}-macOS-x86_64.tar.xz`,
    'darwin-arm64': `LLVM-${ver}-macOS-ARM64.tar.xz`,
    'linux-x64': `LLVM-${ver}-Linux-X64.tar.xz`,
    'linux-arm64': `LLVM-${ver}-Linux-ARM64.tar.xz`
});

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

const getAssetName = (ver, platform, architecture) => {
    const name = assetNames(ver)[`${platform}-${architecture}`];
    if (!name) {
        throw new Error(`Unsupported clang-format platform: ${platform}-${architecture}`);
    }
    return name;
};

const main = async () => {
    // 读取命令行参数和环境变量（移入 main 避免模块作用域副作用）
    const versionArg = readArg('version', process.env.CLANG_FORMAT_VERSION || '');
    const tagArg = readArg('tag', process.env.CLANG_FORMAT_TAG || '');
    const repo = readArg('repo', process.env.CLANG_FORMAT_REPO || 'llvm/llvm-project');
    const platform = normalizePlatform(readArg('platform', process.env.OICPP_CLANG_FORMAT_PLATFORM || process.platform));
    const architecture = String(readArg('arch', process.env.OICPP_CLANG_FORMAT_ARCH || process.arch)).toLowerCase();
    const outputRoot = path.resolve(readArg('output', process.env.CLANG_FORMAT_OUTPUT || path.join(__dirname, '..', 'build', 'clang-format')));
    const directUrl = readArg('url', process.env.CLANG_FORMAT_DOWNLOAD_URL || '');
    const expectedDigest = String(readArg('digest', process.env.CLANG_FORMAT_SHA256 || '')).replace(/^sha256:/i, '').toLowerCase();
    const skipSslVerify = process.env.NODE_ENV === 'development' && process.env.OICPP_SKIP_SSL_VERIFY === '1';
    const tempRoot = path.join(outputRoot, '_download');
    const { requestJson, ensureDownload } = createReleaseDownloader({
        label: 'clang-format',
        userAgent: 'oicpp-clang-format-downloader',
        skipSslVerify,
        maxBytes: 4 * 1024 * 1024 * 1024,
        maxRedirects: 10
    });

    // 版本解析：支持 "latest"/"auto" 从 GitHub API 获取最新 release
    // 优先级：显式 --version > 显式 --tag 推导 > auto/latest > 默认 23.1.2
    // 只有当未显式指定 --version 且未显式指定 --tag 时才自动获取最新版
    const isAutoVersion = (!versionArg && !tagArg) || versionArg.toLowerCase() === 'latest' || versionArg.toLowerCase() === 'auto';
    const isIntelMac = platform === 'darwin' && architecture === 'x64';

    // token 供 selectReleaseAsset 和 auto-version fetch 使用
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

    // 自动获取最新版本
    let assetVersion = versionArg;
    let releaseTag = tagArg;
    if (isAutoVersion) {
        try {
            const latestUrl = `https://api.github.com/repos/${repo}/releases/latest`;
            console.log(`[clang-format] Fetching latest release ${latestUrl}`);
            const latestRelease = await requestJson(latestUrl, token || undefined);
            releaseTag = latestRelease.tag_name;
            assetVersion = releaseTag.replace(/^llvmorg-/i, '');
            console.log(`[clang-format] Latest version: ${assetVersion} (tag: ${releaseTag})`);
        } catch (err) {
            console.warn(`[clang-format] Failed to fetch latest release: ${err?.message || err}, falling back to default 23.1.2`);
            assetVersion = '23.1.2';
            releaseTag = `llvmorg-${assetVersion}`;
        }
    } else if (!versionArg && tagArg) {
        // 仅指定了 --tag，从 tag 推导 version（保持原有行为）
        assetVersion = tagArg.replace(/^llvmorg-/i, '');
    } else if (!versionArg) {
        // 既没指定 --version 也没指定 --tag，用默认版本
        assetVersion = '23.1.2';
    }
    if (!releaseTag) {
        releaseTag = `llvmorg-${assetVersion}`;
    }

    // Intel Mac 回退：仅当自动获取版本且最新版无 x86_64 macOS 资产时
    const isIntelMacFallback = isIntelMac && isAutoVersion && assetVersion !== '19.1.7';
    // 注意：这里无法预知最新版是否有 x86_64 macOS 资产，下载失败时会自然报错
    // 保留 19.1.7 作为已知可用的最后版本供手动指定

    // 校验值冲突检测：仅当显式指定 digest 且会触发 Intel Mac 回退时
    const digestConflictsWithFallback = isIntelMacFallback && !!expectedDigest && !directUrl;

    if (digestConflictsWithFallback) {
        throw new Error(`指定的 sha256 属于 ${assetVersion} 的包，但 x86_64 macOS 会回退到 19.1.7 —— 二者不可能同时对上。`
            + `请改成 --tag llvmorg-19.1.7 --digest <19.1.7 的 sha256>，或去掉 --digest 改用 Release API 自带的资产校验值`);
    }
    if (skipSslVerify) {
        console.warn('[clang-format] SSL certificate verification disabled (OICPP_SKIP_SSL_VERIFY=1)');
    }

    // selectReleaseAsset 需要访问 requestJson，定义在 main 内部
    const selectReleaseAsset = async (token, ver, releaseTag, repo, directUrl, expectedDigest, platform, architecture) => {
        const assetName = getAssetName(ver, platform, architecture);
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

    const binaryName = platform === 'win32' ? 'clang-format.exe' : 'clang-format';
    const targetRoot = path.join(outputRoot, platform);
    const targetBinary = path.join(targetRoot, 'bin', binaryName);
    const targetLicense = path.join(targetRoot, 'LICENSE.TXT');
    const targetVersionFile = path.join(targetRoot, 'version.txt');
    if (fs.existsSync(targetBinary) && fs.existsSync(targetLicense)) {
        console.log(`[clang-format] Target exists: ${targetBinary}, skipping`);
        if (!fs.existsSync(targetVersionFile) && assetVersion) {
            fs.writeFileSync(targetVersionFile, assetVersion, 'utf8');
        }
        return;
    }
    // 二进制已就位、只差许可正文时不必重下 1 GB 工具链，直接用仓库里的同一份补齐
    if (fs.existsSync(targetBinary) && fs.existsSync(fallbackLicense)) {
        ensureDir(targetRoot);
        fs.copyFileSync(fallbackLicense, targetLicense);
        console.log(`[clang-format] Filled in missing license from ${fallbackLicense}`);
        if (assetVersion) fs.writeFileSync(targetVersionFile, assetVersion, 'utf8');
        return;
    }

    const asset = await selectReleaseAsset(token, assetVersion, releaseTag, repo, directUrl, expectedDigest, platform, architecture);
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
    // 写入版本文件供构建信息读取
    fs.writeFileSync(targetVersionFile, assetVersion, 'utf8');
    console.log(`[clang-format] Written version.txt: ${assetVersion}`);
};

main().catch((err) => {
    console.error('[clang-format] Failed:', err);
    process.exit(1);
});