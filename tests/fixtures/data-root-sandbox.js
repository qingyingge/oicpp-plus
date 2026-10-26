'use strict';

// 若干回归测试会从 src/main.js 里切出源码片段丢进 vm 执行，而片段现在调用 userDataPath(...)
// （定义在 src/utils/data-root.js，基目录可以是家目录，也可以是便携模式下的 exe 同级目录）。
// 这里提供与主进程同构的注入，避免每个测试各写一份拼接逻辑。
//
// 目录名一律从 src/utils/data-root.js 里抠出来读，不在测试里再抄一遍字面量：
// 抄了之后一旦改名，注入与期望会一起错，断言就退化成同源循环。
// 期望值本身仍然写死字面路径（各测试原先就是这么做的），这样才咬得住实现漂移。

const fs = require('fs');
const path = require('path');

function readDataDirName() {
    const source = fs.readFileSync(
        path.join(__dirname, '..', '..', 'src', 'utils', 'data-root.js'), 'utf8');
    const match = source.match(/const DATA_DIR_NAME\s*=\s*'([^']+)'/);
    return match ? match[1] : null;
}

// baseRoot 对应主进程里的 getDataRoot() 结果，由各测试自己假装（通常是 HOME 替身）。
function makeUserDataPath(baseRoot, dirName) {
    const name = dirName || readDataDirName();
    if (!baseRoot || !name) {
        throw new Error('makeUserDataPath 需要 baseRoot 与可解析出的 DATA_DIR_NAME');
    }
    return (...segments) => path.join(baseRoot, name, ...segments);
}

module.exports = { readDataDirName, makeUserDataPath };
