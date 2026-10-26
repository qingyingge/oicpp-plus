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

// 7zip-bin 的可执行文件经 pnpm 硬链接落盘后可能不带 X_OK，直接 spawn 会 EACCES
// （CI 的 Prepare clang-format bundle 就是这么红的）。spawn 前补一次可执行位。
const ensureSevenZipExecutable = () => {
    if (process.platform === 'win32') return;
    try {
        fs.accessSync(path7za, fs.constants.X_OK);
    } catch (_) {
        try { fs.chmodSync(path7za, 0o755); } catch (_2) { }
    }
};

const run7z = (argsList) => {
    ensureSevenZipExecutable();
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
    ensureSevenZipExecutable();
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

// 纯配置解析：argv > env > 内置默认。读的是模块作用域的 readArg/process/__dirname，
// 所以同一个沙箱里换一组 argv/env 再调一次就是另一份配置，不需要跑起 main() 才能观察。
// 抽出来之前这段内联在 main() 里，测试靠「顶层绑定」读它；245e19e 把它挪进 main() 之后
// 顶层绑定消失，27 处断言在 undefined 上静默真空通过了整整一批（见 tests/clang-format.test.js）。
const resolveDownloadConfig = () => {
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
    // 「点名版本」= 给了真版本号；latest/auto 是「就要最新」，不算点名
    const wantsLatest = !versionArg || /^(latest|auto)$/i.test(versionArg);
    const pinnedVersion = !wantsLatest;
    const pinnedTag = !!tagArg;
    // 只有既没点名版本又没点名 tag 时才去取最新版（点名 tag 就按 tag 走）
    const isAutoVersion = wantsLatest && !pinnedTag;
    const isIntelMac = platform === 'darwin' && architecture === 'x64';
    return {
        versionArg, tagArg, repo, platform, architecture, outputRoot, directUrl,
        expectedDigest, skipSslVerify, tempRoot, pinnedVersion, pinnedTag,
        isAutoVersion, isIntelMac
    };
};

// 版本选择纯函数。fetchedTag = 从 GitHub API 取到的 latest tag，取不到传空。
// Intel Mac 单列：上游从 LLVM 20 起不再发 x86_64 macOS 包，所以没点名时直接取最后一个
// 有该资产的 19.1.7，而不是先取 latest 再去下一必然不存在的东西。
// 一旦回退就是在换包，用户钉的 sha256 必然对不上 —— 在下任何字节之前当场拒掉，
// 既不悄悄摘校验、也不留一个和真实原因无关的 checksum 错。
const planVersionSelection = (config, fetchedTag) => {
    if (config.isIntelMac && !config.pinnedVersion && !config.pinnedTag) {
        const assetVersion = '19.1.7';
        return {
            assetVersion,
            releaseTag: `llvmorg-${assetVersion}`,
            usesIntelMacFallback: true,
            digestConflictsWithFallback: !!config.expectedDigest && !config.directUrl,
            needsLatestFetch: false
        };
    }
    let assetVersion = config.versionArg;
    let releaseTag = config.tagArg;
    if (config.isAutoVersion) {
        assetVersion = fetchedTag ? String(fetchedTag).replace(/^llvmorg-/i, '') : '23.1.2';
        releaseTag = fetchedTag || `llvmorg-${assetVersion}`;
    } else if (!config.pinnedVersion && config.pinnedTag) {
        // 只点名 tag：版本号从 tag 里推，保证资产名和 releaseTag 出自同一次选择
        assetVersion = String(config.tagArg).replace(/^llvmorg-/i, '');
    }
    if (!releaseTag) {
        releaseTag = `llvmorg-${assetVersion}`;
    }
    return {
        assetVersion,
        releaseTag,
        usesIntelMacFallback: false,
        digestConflictsWithFallback: false,
        needsLatestFetch: config.isAutoVersion
    };
};

// 挑资产：点了 --url 就完全不碰 API；Release API 命中就用上游那份（自带 digest）；
// API 挂了、或 release 表里没这个资产，才拼官方直链。两条路径都必须把用户钉的校验值带上，
// 否则等于下一份没验过的东西。requestJson 作参数传入，所以这段是可单测的纯逻辑。
const selectReleaseAsset = async (requestJson, token, ver, releaseTag, repo, directUrl, expectedDigest, platform, architecture) => {
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

const main = async () => {
    const config = resolveDownloadConfig();
    const {
        repo, platform, architecture, outputRoot, directUrl,
        expectedDigest, skipSslVerify, tempRoot
    } = config;
    const { requestJson, ensureDownload } = createReleaseDownloader({
        label: 'clang-format',
        userAgent: 'oicpp-clang-format-downloader',
        skipSslVerify,
        maxBytes: 4 * 1024 * 1024 * 1024,
        maxRedirects: 10
    });

    // token 供 selectReleaseAsset 和 auto-version fetch 使用
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

    // 版本解析：显式 --version > 显式 --tag 推导 > auto/latest > 默认 23.1.2，
    // Intel Mac 未点名则直接锁定 19.1.7（needsLatestFetch 为 false，不去问 API）
    let selection = planVersionSelection(config, null);
    if (selection.needsLatestFetch) {
        try {
            const latestUrl = `https://api.github.com/repos/${repo}/releases/latest`;
            console.log(`[clang-format] Fetching latest release ${latestUrl}`);
            const latestRelease = await requestJson(latestUrl, token || undefined);
            selection = planVersionSelection(config, latestRelease.tag_name);
            console.log(`[clang-format] Latest version: ${selection.assetVersion} (tag: ${selection.releaseTag})`);
        } catch (err) {
            console.warn(`[clang-format] Failed to fetch latest release: ${err?.message || err}, falling back to default 23.1.2`);
            selection = planVersionSelection(config, null);
        }
    }
    const { assetVersion, releaseTag, usesIntelMacFallback, digestConflictsWithFallback } = selection;

    if (usesIntelMacFallback) {
        console.warn('[clang-format] x86_64 macOS 且没有点名版本：取上游最后一个 Intel macOS 包 19.1.7（默认版本没有这个资产）');
    } else if (config.isIntelMac && releaseTag !== 'llvmorg-19.1.7') {
        console.warn(`[clang-format] 按你点名的 ${releaseTag} / ${assetVersion} 取，不再自动换成 19.1.7 —— 上游从 20 起不发 x86_64 macOS 包，取不到是预期结果`);
    }

    if (digestConflictsWithFallback) {
        throw new Error('x86_64 macOS 未点名版本会取 19.1.7（上游最后一个 Intel macOS 包），'
            + `但你钉的 sha256 属于 ${releaseTag} 之外的另一个包 —— 二者不可能同时对上。`
            + '请改成 --tag llvmorg-19.1.7 --digest <19.1.7 的 sha256>，或去掉 --digest 改用 Release API 自带的资产校验值');
    }
    if (skipSslVerify) {
        console.warn('[clang-format] SSL certificate verification disabled (OICPP_SKIP_SSL_VERIFY=1)');
    }

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

    const asset = await selectReleaseAsset(requestJson, token, assetVersion, releaseTag, repo, directUrl, expectedDigest, platform, architecture);
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