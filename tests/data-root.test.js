'use strict';

// 数据根解析（src/utils/data-root.ts）的回归。
//
// 便携模式的全部行为都压在这一个函数上，而它的三种来源里只有「家目录」是历史上
// 一直存在的那条。最需要咬住的两件事：
//   1. 命中便携标记时，根必须跟着 exe 走，否则日志/编译器/codeTemp 会只迁一半；
//   2. 任何来源给出盘根都必须被拒绝 —— 退出清理会对 <根>/codeTemp 递归强删，
//      盘根一旦通过就是抹掉整张盘。
// 盘根在 POSIX 上是 `/`，在 Windows 上是 `C:\`；path.parse 的盘根语义跟宿主平台走，
// 所以这里只能真实覆盖 POSIX 那一侧，win32 分支要靠 Windows 上的实测（见 AGENTS.md
// 里登记的 smoke-electron 命令）。

const path = require('path');
const os = require('os');

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const dataRoot = require('../src/utils/data-root');

// 空串是这组用例要验证的输入之一，所以取值不能用 ||（'' 会被默认值吞掉）。
const probes = (o) => ({
    env: o.env || {},
    execPath: o.execPath || path.join('/opt', 'oicpp', 'OICPP-Plus'),
    homedir: o.homedir === undefined ? '/home/tester' : o.homedir,
    portableMarkerExists: !!o.portableMarkerExists
});

check('DATA_DIR_NAME 仍是 .oicpp-plus（改名要同步 installer.nsi 与语言包文案）',
    dataRoot.DATA_DIR_NAME === '.oicpp-plus', String(dataRoot.DATA_DIR_NAME));

// ---- 三种来源的优先级 ----
check('默认走家目录',
    dataRoot.resolveDataRoot(probes({})) === '/home/tester');

check('便携标记命中时走 exe 同级目录',
    dataRoot.resolveDataRoot(probes({ portableMarkerExists: true }))
        === path.join('/opt', 'oicpp'));

check('显式覆盖压过便携标记（程序在 U 盘、状态放本地盘的用法）',
    dataRoot.resolveDataRoot(probes({
        portableMarkerExists: true,
        env: { [dataRoot.DATA_ROOT_ENV]: '/var/lib/oicpp' }
    })) === '/var/lib/oicpp');

check('覆盖值是相对路径时不接受，继续往下找',
    dataRoot.resolveDataRoot(probes({ env: { [dataRoot.DATA_ROOT_ENV]: 'relative/dir' } }))
        === '/home/tester');

// ---- 盘根必须被拒 ----
check('家目录是 / 时拒绝（递归删除的兜底闸门）',
    dataRoot.resolveDataRoot(probes({ homedir: '/' })) === path.join(os.tmpdir(), 'oicpp-plus-data'));

check('家目录为空时同样不返回空值',
    dataRoot.resolveDataRoot(probes({ homedir: '' })) === path.join(os.tmpdir(), 'oicpp-plus-data'));

check('任何来源都不会给出盘根',
    (() => {
        const candidates = [
            probes({}), probes({ homedir: '/' }), probes({ homedir: '' }),
            probes({ portableMarkerExists: true }),
            probes({ portableMarkerExists: true, homedir: '/' }),
            probes({ env: { [dataRoot.DATA_ROOT_ENV]: '/' } }),
            probes({ env: { [dataRoot.DATA_ROOT_ENV]: '..' } })
        ];
        return candidates.every((p) => {
            const root = dataRoot.resolveDataRoot(p);
            const parsed = path.parse(root);
            return typeof root === 'string' && root.length > 0
                && path.isAbsolute(root)
                && parsed.root !== root && parsed.dir !== '';
        });
    })());

// ---- userDataPath 与进程级缓存 ----
check('userDataPath() 是 <根>/.oicpp-plus，且逐段拼接',
    (() => {
        process.env[dataRoot.DATA_ROOT_ENV] = '/home/tester';
        dataRoot.resetDataRootCache();
        const bare = dataRoot.userDataPath();
        const nested = dataRoot.userDataPath('codeTemp');
        const deep = dataRoot.userDataPath('compare', 'freopen_runs', 'task1');
        return bare === path.join('/home/tester', '.oicpp-plus')
            && nested === path.join('/home/tester', '.oicpp-plus', 'codeTemp')
            && deep === path.join('/home/tester', '.oicpp-plus', 'compare', 'freopen_runs', 'task1');
    })(),
    `${dataRoot.userDataPath()} / ${dataRoot.userDataPath('codeTemp')}`);

check('结果在进程内缓存：改了 env 不重算，reset 之后才重算',
    (() => {
        process.env[dataRoot.DATA_ROOT_ENV] = '/first';
        dataRoot.resetDataRootCache();
        const first = dataRoot.getDataRoot();
        process.env[dataRoot.DATA_ROOT_ENV] = '/second';
        const stillFirst = dataRoot.getDataRoot();
        dataRoot.resetDataRootCache();
        const second = dataRoot.getDataRoot();
        return first === '/first' && stillFirst === '/first' && second === '/second';
    })());

delete process.env[dataRoot.DATA_ROOT_ENV];
dataRoot.resetDataRootCache();

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 条失败`);
process.exitCode = failures === 0 ? 0 : 1;
