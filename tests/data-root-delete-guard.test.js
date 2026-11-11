'use strict';

// TEMP 删除白名单与递归删除闸门的回归。
//
// 这两处原先都用字符串判包含（path.relative / 手工 norm+toLowerCase），而包含判定要防的是
// 「名字看起来在里面，实际指向外面」—— 软链恰好就是这个名字形状的攻击。所以这里不写桩：
// 真建一个临时目录树、真下一个软链、抽 main.js 里真实的那段判定来跑。
//
// 递归强删那条闸门（assertDeletableUnderDataRoot）是便携模式带来的新要求：数据根不再
// 恒等于家目录，"路径是拼出来的" 不等于 "它还在应用自己的目录里"。

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const dataRoot = require('../src/utils/data-root');
const pathIdentity = require('../src/utils/path-identity');
const { funcDecl } = require('./fixtures/source-extract');

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-dataroot-'));

// 数据根走真实解析路径：用显式覆盖把它指到这次建出来的临时树
process.env[dataRoot.DATA_ROOT_ENV] = sandboxRoot;
dataRoot.resetDataRootCache();

const codeTemp = dataRoot.userDataPath('codeTemp');
const compare = dataRoot.userDataPath('compare');
const userProject = path.join(sandboxRoot, 'user-project');
fs.mkdirSync(codeTemp, { recursive: true });
fs.mkdirSync(compare, { recursive: true });
fs.mkdirSync(userProject, { recursive: true });
const victim = path.join(userProject, 'solution.cpp');
fs.writeFileSync(victim, 'int main() { return 0; }');

let symlinkOk = true;
try {
    fs.symlinkSync(userProject, path.join(codeTemp, 'link'));
} catch (_) {
    symlinkOk = false; // Windows 无开发者模式/非管理员时建不了软链
}

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

// ---- 真实白名单判定 ----
const helperStart = mainSource.indexOf('const TEMP_DELETE_ROOTS = [');
const helperEnd = mainSource.indexOf("ipcMain.handle('delete-temp-file'");
check('白名单片段抽取成功', helperStart !== -1 && helperEnd > helperStart);

const ctx = vm.createContext({
    os, path, fs,
    isInside: pathIdentity.isInside,
    samePath: pathIdentity.samePath,
    userDataPath: dataRoot.userDataPath
});
let isPathInsideTempRoots = null;
try {
    vm.runInContext(
        `${mainSource.slice(helperStart, helperEnd)}\nthis.check = isPathInsideTempRoots; this.roots = TEMP_DELETE_ROOTS;`,
        ctx);
    isPathInsideTempRoots = ctx.check;
} catch (error) {
    check('白名单 helper 能独立求值', false, error.message);
}

check('抽到的是函数', typeof isPathInsideTempRoots === 'function');
if (typeof isPathInsideTempRoots === 'function') {
    // 期望值不从 TEMP_DELETE_ROOTS 反推，否则数组被改写时断言跟着一起错
    check('白名单落在本次的临时树上',
        ctx.roots.includes(codeTemp) && ctx.roots.includes(compare), JSON.stringify(ctx.roots));
    check('codeTemp 下的普通文件在内',
        isPathInsideTempRoots(path.join(codeTemp, 'tmp.cpp')) === true);
    check('compare 下的多层产物在内',
        isPathInsideTempRoots(path.join(compare, 'freopen_runs', 'task', 'in.txt')) === true);
    check('根自身判在外（这条通道只删根下面的文件）',
        isPathInsideTempRoots(codeTemp) === false && isPathInsideTempRoots(compare) === false);
    check('同前缀兄弟目录被拒（startsWith 的原漏洞）',
        isPathInsideTempRoots(dataRoot.userDataPath('codeTempEvil', 'x.exe')) === false);
    check('数据根之外的路径被拒',
        isPathInsideTempRoots(victim) === false);
    if (symlinkOk) {
        // 旧实现在这里放行：path.relative 只看字符串，
        // <codeTemp>/link/solution.cpp 相对 <codeTemp> 就是个干净的子路径，
        // 一次「删临时文件」删到的却是用户工程里的真文件。
        check('软链指向根外的文件判在外（realpath 之后才看得见）',
            isPathInsideTempRoots(path.join(codeTemp, 'link', 'solution.cpp')) === false);
    } else {
        console.log('[SKIP] 本平台建不了软链，逃逸用例跳过');
    }
}

// ---- 递归强删闸门 ----
const guardSrc = funcDecl(mainSource, 'assertDeletableUnderDataRoot');
check('闸门函数抽取成功', guardSrc.length > 0, guardSrc.replace(/\s+/g, ' ').slice(0, 60));
const guardCtx = vm.createContext({
    path, isInside: pathIdentity.isInside, samePath: pathIdentity.samePath,
    userDataPath: dataRoot.userDataPath, Error
});
let guard = null;
try {
    vm.runInContext(`${guardSrc}\nthis.g = assertDeletableUnderDataRoot;`, guardCtx);
    guard = guardCtx.g;
} catch (error) {
    check('闸门函数能独立求值', false, error.message);
}
if (typeof guard === 'function') {
    const throws = (dir, leaf) => {
        try { guard(dir, leaf); return null; } catch (error) { return error.message; }
    };
    check('正常 codeTemp 放行', throws(codeTemp, 'codeTemp') === null, String(throws(codeTemp, 'codeTemp')));
    check('指向数据根本身被拒（少一段子目录就是毁掉整个状态目录）',
        throws(dataRoot.userDataPath(), 'codeTemp') !== null);
    check('末段名字不符被拒', throws(dataRoot.userDataPath('compare'), 'codeTemp') !== null);
    check('同名但在数据根之外被拒',
        throws(path.join(sandboxRoot, 'user-project', 'codeTemp'), 'codeTemp') !== null);
    check('盘根被拒', throws(path.parse(sandboxRoot).root, 'codeTemp') !== null);
}

// ---- 清理自己的临时树（只删本次 mkdtemp 出来的目录）----
try { fs.rmSync(sandboxRoot, { recursive: true, force: true }); } catch (_) { }
delete process.env[dataRoot.DATA_ROOT_ENV];
dataRoot.resetDataRootCache();

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`);
process.exitCode = failures === 0 ? 0 : 1;
