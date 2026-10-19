'use strict';

// 第三方许可分发合规的回归守卫：
// 正文在仓库里、UI 读得到、构建打进去、安装器装到位、声明覆盖全部依赖 —— 五处缺一即 FAIL。

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let failures = 0;

const check = (name, condition, extra = '') => {
    if (condition) {
        console.log(`[PASS] ${name}`);
    } else {
        failures++;
        console.log(`[FAIL] ${name}${extra ? ' — ' + extra : ''}`);
    }
};

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const readSafe = (relative) => {
    try {
        return read(relative);
    } catch (_) {
        return '';
    }
};

const LLVM_LICENSE = 'third-party/licenses/llvm-apache-2.0-with-llvm-exception.txt';
const NOTICES = 'third-party/licenses/THIRD-PARTY-NOTICES.md';
const mainSource = read('src/main.js');
const preloadSource = read('src/preload.js');
const rendererSource = read('src/renderer/js/main.js');
const pkg = JSON.parse(read('package.json'));

// --- 1. LLVM 许可正文在仓库里，且是真正的正文而不是占位文本 ---
const llvmBody = readSafe(LLVM_LICENSE);
check('llvm license file exists and is non-trivial', llvmBody.length > 5000, `${llvmBody.length} chars`);
check('llvm license carries the Apache-2.0 body', /Apache License/.test(llvmBody) && /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/.test(llvmBody));
check('llvm license carries the LLVM exception appendix', /LLVM Exceptions to the Apache 2\.0 License/.test(llvmBody));

// Windows 上 NSIS 按字节拷贝，CRLF 混入会让安装后的正文与上游不一致
check('llvm license uses LF line endings only', !/\r\n/.test(llvmBody));
const llvmRaw = fs.readFileSync(path.join(root, LLVM_LICENSE));
check('llvm license is UTF-8 without BOM', !(llvmRaw[0] === 0xef && llvmRaw[1] === 0xbb && llvmRaw[2] === 0xbf));

// --- 2. 主进程白名单与磁盘文件一致（防加了文件忘了接 IPC，或接了不存在的文件）---
const whitelistBlock = /const THIRD_PARTY_LICENSE_FILES = new Set\(\[([\s\S]*?)\]\)/.exec(mainSource);
const whitelisted = whitelistBlock ? [...whitelistBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
const onDisk = fs.readdirSync(path.join(root, 'third-party', 'licenses')).filter((n) => n !== 'README.md');
check('THIRD_PARTY_LICENSE_FILES whitelist is parsed', whitelisted.length > 0, `got ${whitelisted.length}`);
check('every license file on disk is readable through the IPC whitelist',
    onDisk.every((n) => whitelisted.includes(n)), onDisk.filter((n) => !whitelisted.includes(n)).join(', '));
check('every whitelisted license file exists on disk',
    whitelisted.every((n) => onDisk.includes(n)), whitelisted.filter((n) => !onDisk.includes(n)).join(', '));

// --- 3. 渲染层引用的文件名都在白名单内 ---
const usedLicenseFiles = [...rendererSource.matchAll(/licenseFile:\s*'([^']+)'/g)].map((m) => m[1]);
check('showOpenSourceLicenses() links at least one license body', usedLicenseFiles.length > 0);
check('every linked licenseFile is whitelisted',
    usedLicenseFiles.every((n) => whitelisted.includes(n)), usedLicenseFiles.filter((n) => !whitelisted.includes(n)).join(', '));
check('the clangd and clang-format rows both link a license body', usedLicenseFiles.length >= 2);
check('the OSS dialog renders the license body container', /id="oss-license-body"/.test(rendererSource));
check('the OSS dialog renders the back button', /id="oss-back-btn"/.test(rendererSource));

// --- 4. IPC 双向连通（E1 之外再加一条语义级断言）---
check('preload exposes readThirdPartyLicense', /readThirdPartyLicense:\s*\(name\)\s*=>\s*safeIpcRenderer\.invoke\('read-third-party-license',\s*name\)/.test(preloadSource));
check("preload whitelists the 'read-third-party-license' channel", /'read-third-party-license'/.test(preloadSource));
check('main registers a read-third-party-license handler', /ipcMain\.handle\('read-third-party-license'/.test(mainSource));

// 参数不参与路径拼接：白名单用 Set.has 判定，拼路径前先过白名单
check('read-third-party-license rejects unknown file names', /if \(!THIRD_PARTY_LICENSE_FILES\.has\(fileName\)\) \{\s*return null;/.test(mainSource));

// --- 5. 打包必须带上该目录，否则读 IPC 在安装后必然返回 null ---
const buildFiles = (pkg.build && pkg.build.files) || [];
check('build.files ships third-party/**/*', buildFiles.some((f) => String(f).includes('third-party')));

// --- 6. 构建脚本兜底：官方包缺正文时不至于重下整个工具链 ---
check('download-clangd.js falls back to the bundled license body', readSafe('scripts/download-clangd.js').includes('llvm-apache-2.0-with-llvm-exception.txt'));
check('download-clang-format.js falls back to the bundled license body', readSafe('scripts/download-clang-format.js').includes('llvm-apache-2.0-with-llvm-exception.txt'));
check('download-clang-format.js no longer hard-fails when the archive has no LICENSE.TXT',
    /const licenseSource = resolveLicenseSource\(/.test(readSafe('scripts/download-clang-format.js')));

// --- 7. 安装器随包分发与卸载清理 ---
const installerSource = read('installer.nsi');
check('installer ships the clangd license alongside the binaries',
    /File\s+"dist\\win-unpacked\\resources\\clangd\\LICENSE\.TXT"/.test(installerSource));
check('uninstaller removes the shipped clangd license',
    /Delete\s+"\$OICPP_USER_PROFILE\\\.oicpp-plus\\LICENSE\.TXT"/.test(installerSource));

// --- 8. 清单覆盖 package.json 的全部依赖 ---
const notices = readSafe(NOTICES);
check('THIRD-PARTY-NOTICES.md exists', notices.length > 0);
if (notices) {
    const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
    const missing = deps.filter((d) => !notices.includes('`' + d + '`'));
    check(`THIRD-PARTY-NOTICES.md lists all ${deps.length} declared dependencies`, missing.length === 0, missing.join(', '));
    check('THIRD-PARTY-NOTICES.md points at the license body file', notices.includes('llvm-apache-2.0-with-llvm-exception.txt'));
    // 自研组件（如 fastspawn）不进本清单；项目自身的 GPL-3.0 协议只写在 README 的分工说明里
    check('the notices file does not list first-party components', !/fastspawn/.test(notices));
    check('README.md keeps the project-vs-third-party split explicit', readSafe('third-party/licenses/README.md').includes('GPL-3.0-only'));
}

// --- 9. i18n 双语键齐全（UI 新增了列头、按钮与失败提示）---
const zh = JSON.parse(read('src/lang/zh-cn.json'));
const en = JSON.parse(read('src/lang/en.json'));
for (const key of ['licenseText', 'viewLicense', 'licenseLoadFailed', 'back']) {
    check(`openSource.${key} exists in both language packs`,
        !!(zh.openSource && zh.openSource[key]) && !!(en.openSource && en.openSource[key]));
}

console.log(`[INFO] ${onDisk.length} license file(s) on disk, ${whitelisted.length} readable through IPC`);
process.exit(failures ? 1 : 0);
