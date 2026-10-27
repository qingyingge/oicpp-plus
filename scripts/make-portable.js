#!/usr/bin/env node
'use strict';

// 便携包 = electron-builder 的 dir 产物 + 一个标记文件 + zip。
//
// 运行时不需要任何「便携版专用构建」：src/utils/data-root.ts 认 exe 同级目录里的
// 标记文件，命中就把数据根挪到 exe 旁边，其下仍然叫 .oicpp-plus，布局与安装版逐字
// 相同。所以同一份 win-unpacked 里放上标记就是便携版，拿掉标记就是安装版的内容。
//
// 用法：
//   node scripts/make-portable.js                       # dist/win-unpacked
//   node scripts/make-portable.js dist/linux-unpacked --label linux-x64 --level 1
//
// 压缩级别默认 5：win-unpacked 里 200MB 上下多是已压缩的二进制与 pak，拉满要多花几分钟
// 而只省几 MB；要更小就传 --level 9。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// 标记文件名必须与运行时判定同源，别在这儿重抄一遍字面量
const { PORTABLE_MARKER_FILE, DATA_DIR_NAME } = require('../src/utils/data-root');

function parseArgs(argv) {
    const out = { dir: path.join('dist', 'win-unpacked'), label: null, level: '5' };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--label') { out.label = argv[++i]; continue; }
        if (arg === '--level') { out.level = argv[++i]; continue; }
        if (arg.startsWith('--')) throw new Error(`未知参数: ${arg}`);
        out.dir = arg;
    }
    return out;
}

// 校验目录里确实有主程序，避免把标记写进一个没有 exe 的空壳目录：
// 那种包解压出来「看起来像便携版」，双击的却是别的程序的壳。
function assertHasMainExecutable(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    if (process.platform === 'win32' || /win/i.test(path.basename(dir))) {
        const exe = entries.find((name) => name.toLowerCase().endsWith('.exe'));
        if (!exe) throw new Error(`${dir} 里没有 .exe，不是 electron-builder 的 win dir 产物`);
        return exe;
    }
    // Linux 上 electron-builder 用 pkg.name 作可执行名（本机产物即 oicpp-plus-ide）。
    // 认不出来才退到「有执行位的文件」，并排除 Chromium 的附属二进制 —— chrome-sandbox
    // 同样带执行位，把它当主程序会让这次自检形同虚设。
    const chromiumHelpers = new Set(['chrome-sandbox', 'chrome_crashpad_handler']);
    const hasExecBit = (name) => {
        try {
            return (fs.statSync(path.join(dir, name)).mode & 0o111) !== 0;
        } catch (_) {
            return false;
        }
    };
    const declared = entries.includes(pkg.name) ? pkg.name : null;
    const executable = declared
        || entries.find((name) => !chromiumHelpers.has(name) && hasExecBit(name));
    if (!executable) throw new Error(`${dir} 里没有可执行入口`);
    return executable;
}

function guessLabel(dir) {
    // dist/win-arm64-unpacked / dist/linux-unpacked / dist/win-unpacked
    const base = path.basename(dir).replace(/-unpacked$/, '');
    return /-(x64|arm64|ia32|arm)$/.test(base) ? base : `${base}-x64`;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    const unpackedDir = path.resolve(root, opts.dir);
    if (!fs.existsSync(unpackedDir) || !fs.statSync(unpackedDir).isDirectory()) {
        throw new Error(`目录不存在: ${unpackedDir}（先跑 electron-builder --win dir）`);
    }

    const exeName = assertHasMainExecutable(unpackedDir);
    const markerPath = path.join(unpackedDir, PORTABLE_MARKER_FILE);
    // 内容只作说明与人工核对用，判定只看「存不存在」
    fs.writeFileSync(markerPath, `oicpp-plus portable marker ${pkg.version}\n`);
    console.log(`[portable] 标记写入 ${markerPath}`);
    console.log(`[portable] 主程序 ${exeName}；数据根将是它所在目录下的 ${DATA_DIR_NAME}`);

    const label = opts.label || guessLabel(unpackedDir);
    const zipName = `OICPP-Plus-${pkg.version}-Portable-${label}.zip`;
    const zipPath = path.join(path.dirname(unpackedDir), zipName);
    fs.rmSync(zipPath, { force: true });

    let sevenBinPath = null;
    try {
        sevenBinPath = require('7zip-bin').path7za;
    } catch (_) {
        sevenBinPath = null;
    }
    if (!sevenBinPath || !fs.existsSync(sevenBinPath)) {
        throw new Error('找不到 7za（7zip-bin 未安装），无法生成便携包');
    }
    // 与 download-clangd 同一问题：7zip-bin 落盘可能不带 X_OK，spawn 即 EACCES
    if (process.platform !== 'win32') {
        try {
            fs.accessSync(sevenBinPath, fs.constants.X_OK);
        } catch (_) {
            try { fs.chmodSync(sevenBinPath, 0o755); } catch (_2) { }
        }
    }

    // 归档根要是有名字的目录，而不是 win-unpacked：便携包是直接给用户的，
    // 解压出来一个叫 *unpacked 的目录会让人怀疑拿错了构建残留。
    // 这里用「复制到 dist 下的临时暂存目录」而不是原地改名：改名会把 installer.nsi
    // 依赖的 dist\win-unpacked 短暂搬走，中途失败就留下一个错位的工作区。
    const stageName = `OICPP-Plus-${pkg.version}-Portable-${label}`;
    const stageParent = path.join(path.dirname(unpackedDir), `.portable-stage-${process.pid}`);
    const stageDir = path.join(stageParent, stageName);
    fs.mkdirSync(stageParent, { recursive: true });
    try {
        fs.cpSync(unpackedDir, stageDir, { recursive: true });
        const args = ['a', '-tzip', `-mx=${opts.level}`, zipPath, stageDir];
        const result = spawnSync(sevenBinPath, args, { cwd: root, stdio: 'inherit', shell: false });
        if (result.error || result.status !== 0) {
            throw new Error(`7za 打包失败: ${result.error?.message || `exit ${result.status}`}`);
        }
    } finally {
        // 暂存目录是本脚本自己建的，清掉它不碰任何别的东西
        fs.rmSync(stageParent, { recursive: true, force: true });
    }

    const sizeMb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
    console.log(`[portable] 产物 ${path.relative(root, zipPath)} (${sizeMb} MB)`);
}

try {
    main();
} catch (error) {
    console.error(`[portable] 失败: ${error.message}`);
    process.exitCode = 1;
}
