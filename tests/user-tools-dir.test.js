'use strict';

// 随包分发的工具二进制（clangd、clang-format）过去放在 ~/.oicpp-plus/LSP/bin。
// 该目录名只描述了其中一个工具，实际装的是通用工具链；且 ~/ 下其它目录都是
// 小写功能名（logs / compare / sampleTester / codeTemp），只有它是全大写缩写。
// 1.6 起统一为扁平的 ~/.oicpp-plus/bin，并在启动时把旧目录内容平移过来。

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const mainSource = read('src/main.js');
const installerSource = read('installer.nsi');

const getUserToolsRoot = /function getUserToolsRoot\(\) \{[\s\S]*?\n\}/.exec(mainSource);
check('user tools root is ~/.oicpp-plus/bin',
    !!getUserToolsRoot &&
    getUserToolsRoot[0].includes("USER_DATA_DIR_NAME, 'bin'") &&
    !getUserToolsRoot[0].includes("'LSP'"));
check('the legacy LSP root is only kept for migration',
    mainSource.includes("USER_DATA_DIR_NAME, 'LSP', 'bin'") &&
    /getLegacyUserToolsRoot/.test(mainSource));
check('the old LSP root is no longer the new install target',
    !/return path\.join\(os\.homedir\(\), USER_DATA_DIR_NAME, 'LSP'\)/.test(mainSource) &&
    !mainSource.includes('getUserClangdRoot'));

// 扁平化后两个解析器都直接看目录根，不再往下拼一层 bin
const resolveClangdExecutable = /function resolveClangdExecutable\(rootDir\) \{[\s\S]*?\n\}/.exec(mainSource);
const resolveClangFormatExecutable = /function resolveClangFormatExecutable\(rootDir\) \{[\s\S]*?\n\}/.exec(mainSource);
check('resolveClangdExecutable reads the directory root',
    !!resolveClangdExecutable &&
    resolveClangdExecutable[0].includes('path.join(rootDir, exeName)') &&
    !resolveClangdExecutable[0].includes("'bin'"));
// 用户工具目录扁平（exe 直接在根）必须命中；打包目录（resources/clang-format）上游结构里还套着
// 一层 bin/，合并版把 nested 作为回退探测 —— 只锁扁平会让打包态永远解析不到 clang-format。
check('resolveClangFormatExecutable reads the directory root',
    !!resolveClangFormatExecutable &&
    /path\.join\(rootDir,\s*(exeName|getClangFormatExecutableName\(\))\)/.test(resolveClangFormatExecutable[0]) &&
    resolveClangFormatExecutable[0].includes('fs.existsSync'));

// 打包目录仍保持上游的 <root>/bin 结构，只在拷进用户目录时拍平
const ensureClangdUserBundle = /async function ensureClangdUserBundle\(\) \{[\s\S]*?\n\}/.exec(mainSource);
check('ensureClangdUserBundle flattens the bundle bin/ into the tools root',
    !!ensureClangdUserBundle &&
    ensureClangdUserBundle[0].includes("path.join(bundledRoot, 'bin'), userRoot") &&
    ensureClangdUserBundle[0].includes('getUserToolsRoot()') &&
    ensureClangdUserBundle[0].includes('migrateLegacyUserTools()'));
check('ensureClangdUserBundle still copies asynchronously and de-duplicates',
    !!ensureClangdUserBundle &&
    ensureClangdUserBundle[0].includes('fs.promises.cp') &&
    !ensureClangdUserBundle[0].includes('cpSync') &&
    ensureClangdUserBundle[0].includes('clangdBundlePromise'));

// 迁移：新目录已有 clangd 就不动；旧目录没有 clangd 也不动；否则平移后清掉旧目录
const migrate = /async function migrateLegacyUserTools\(\) \{[\s\S]*?\n\}/.exec(mainSource);
check('migration only runs when the new dir has no clangd but the legacy one does',
    !!migrate &&
    migrate[0].includes('getLegacyUserToolsRoot()') &&
    migrate[0].includes('if (resolveClangdExecutable(userRoot))') &&
    migrate[0].includes('if (!legacyExe)'));
check('migration copies the files across and removes the legacy dir',
    !!migrate &&
    migrate[0].includes('fs.promises.copyFile') &&
    migrate[0].includes('path.dirname(legacyRoot)') &&
    migrate[0].includes('recursive: true, force: true'));
check('migration failures degrade to a warning instead of throwing',
    !!migrate && /catch \(error\) \{[\s\S]*?logWarn/.test(migrate[0]));

check('clang-format still searches the user tools dir as its second candidate',
    mainSource.includes('resolveClangFormatExecutable(getUserToolsRoot())') &&
    mainSource.includes('path.join(getUserToolsRoot(), getClangFormatExecutableName())') &&
    mainSource.includes('resolveClangFormatExecutable(getUserToolsRoot())') &&
    mainSource.includes('findClangFormatExecutableOnPath()'));
check('the missing clang-format error points at the flat tools dir',
    mainSource.includes('place ${getClangFormatExecutableName()} into ${getUserToolsRoot()}'));
check('the LSP start path resolves clangd from the tools root',
    mainSource.includes('ensured.root || getUserToolsRoot()'));

// 安装器：装到扁平的 bin，清掉旧 LSP 残留，卸载时两个都删
check('installer ships the clangd binaries into .oicpp-plus\\bin',
    installerSource.includes('SetOutPath "$OICPP_USER_PROFILE\\.oicpp-plus\\bin"') &&
    installerSource.includes('File /r "dist\\win-unpacked\\resources\\clangd\\bin\\*"') &&
    !installerSource.includes('SetOutPath "$OICPP_USER_PROFILE\\.oicpp-plus\\LSP"'));
check('installer drops the legacy LSP directory on install',
    installerSource.includes('RMDir /r "$OICPP_USER_PROFILE\\.oicpp-plus\\LSP"'));
check('installer removes both tool directories on uninstall',
    installerSource.includes('RMDir /r "$OICPP_USER_PROFILE\\.oicpp-plus\\bin"') &&
    installerSource.includes('RMDir /r "$OICPP_USER_PROFILE\\.oicpp-plus\\LSP"'));

// 工作区内的 compile_flags.txt 私有目录是另一回事，不该跟着改
const compileFlagsSource = read('src/utils/clangd-compile-flags.js');
check('the per-workspace compile_flags.txt dir is untouched',
    compileFlagsSource.includes("path.join('.oicpp-plus', 'lsp')") &&
    !compileFlagsSource.includes("path.join('.oicpp-plus', 'bin')"));

process.exit(failures ? 1 : 0);