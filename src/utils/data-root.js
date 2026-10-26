"use strict";
// 应用自有状态的基目录（base root）——「便携模式」唯一的开关。
//
// 命中便携标记时基目录变成 exe 同级目录，其下的 `.oicpp-plus/` 布局与家目录模式
// 逐字相同，所以切换模式不需要改动任何子路径，也不需要迁移代码。
//
// 本模块**不得** require ./logger 或 electron：
//   - main.js 第 19 行就加载 logger，那时 USER_DATA_DIR_NAME 等常量还没求值，
//     logger 反过来依赖本模块才不会成环；
//   - electron 的 app 在便携标记判定之前也不可用（判定只用 process.execPath 与 fs）。
// 因此这里的诊断信息走 console.warn：I8 只豁免 logWarn/logError 与注释行，
// 所以本文件的中文只出现在注释里，字符串保持 ASCII。
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DATA_DIR_NAME = exports.DATA_ROOT_ENV = exports.PORTABLE_MARKER_FILE = void 0;
exports.resolveDataRoot = resolveDataRoot;
exports.getDataRoot = getDataRoot;
exports.userDataPath = userDataPath;
exports.isPortableDataRoot = isPortableDataRoot;
exports.resetDataRootCache = resetDataRootCache;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
// 便携标记文件名。打包侧（installer.nsi / 便携 zip 渠道）必须写同名文件，
// 改这个名字要同步改打包，否则产出的“便携包”会静默退回家目录模式。
const PORTABLE_MARKER_FILE = 'portable.txt';
exports.PORTABLE_MARKER_FILE = PORTABLE_MARKER_FILE;
// 显式覆盖数据根：优先级最高。用于「程序在 U 盘、状态放本地盘」这类混合用法，
// 也让回归测试能构造出不依赖真实文件系统的路径。
const DATA_ROOT_ENV = 'OICPP_DATA_ROOT';
exports.DATA_ROOT_ENV = DATA_ROOT_ENV;
// 基目录之下的固定一段。历史布局就叫这个名字，便携模式沿用它是为了让两种模式
// 只差一个基目录，子路径逻辑与迁移代码都不用改。
const DATA_DIR_NAME = '.oicpp-plus';
exports.DATA_DIR_NAME = DATA_DIR_NAME;
let cachedRoot = null;
// 盘根（`C:\` 或 `/`）绝不能当数据根：退出清理会对 `<root>/codeTemp` 做递归强删，
// 一旦便携标记误判成盘根，那一次删除会抹掉整张盘。这里拒绝，调用方再兜一层断言。
function isFileSystemRoot(dir) {
    const parsed = path.parse(dir);
    return parsed.root === dir || parsed.dir === '';
}
// 候选不可用时返回 null 并说明来源，让调用方继续往下找下一个来源。
// 必须是绝对路径：相对值交给 path.resolve 会被按 cwd 补全，那样「OICPP_DATA_ROOT=state」
// 会安静地指向当前工作目录下的 state，用户以为配置在 U 盘上，其实跟着启动方式漂。
function usableCandidate(dir, source) {
    if (!dir || typeof dir !== 'string')
        return null;
    if (!path.isAbsolute(dir)) {
        console.warn('[data-root] relative candidate ignored:', source, dir);
        return null;
    }
    let resolved;
    try {
        resolved = path.resolve(dir);
    }
    catch (_) {
        console.warn('[data-root] unparsable candidate ignored:', source, dir);
        return null;
    }
    if (isFileSystemRoot(resolved)) {
        console.warn('[data-root] unusable candidate ignored:', source, resolved);
        return null;
    }
    return resolved;
}
function resolveDataRoot(probes) {
    const fromEnv = usableCandidate(probes.env[DATA_ROOT_ENV], DATA_ROOT_ENV);
    if (fromEnv)
        return fromEnv;
    const exeDir = path.dirname(probes.execPath);
    if (probes.portableMarkerExists) {
        const fromMarker = usableCandidate(exeDir, PORTABLE_MARKER_FILE);
        if (fromMarker)
            return fromMarker;
        // 开发者在仓库根直接跑 electron 时，execPath 可能就在盘根所在卷的顶层目录；
        // 这时宁可退回家目录，也不要拿着一个盘根去做递归删除。
    }
    const fromHome = usableCandidate(probes.homedir, 'os.homedir()');
    if (fromHome)
        return fromHome;
    // env 未设、无便携标记、home 又为空或盘根：此时 exe 同级是唯一还可能有写权限的地方，
    // 但盘根形态必须被拒绝，所以最后兜到一个明确命名的临时目录。
    return path.join(os.tmpdir(), 'oicpp-plus-data');
}
function currentProbes() {
    const exeDir = path.dirname(process.execPath);
    return {
        env: process.env,
        execPath: process.execPath,
        homedir: os.homedir(),
        portableMarkerExists: fs.existsSync(path.join(exeDir, PORTABLE_MARKER_FILE))
    };
}
// 结果在进程生命周期内只算一次：TEMP_DELETE_ROOTS 与敏感目录前缀都在启动期快照，
// 允许运行时切换会让这些快照与真实根失配（判定和实际写入指向不同目录）。
function getDataRoot() {
    if (cachedRoot === null)
        cachedRoot = resolveDataRoot(currentProbes());
    return cachedRoot;
}
// 自有状态路径的唯一拼装点。新增任何读写应用状态的目录都必须走这里，
// 不要再拿 os.homedir() 自行拼基目录——那样便携模式会只迁移一半，日志、编译器、
// 临时目录各写一处，事后既看不出问题也没法清理。
function userDataPath(...segments) {
    return path.join(getDataRoot(), DATA_DIR_NAME, ...segments);
}
function isPortableDataRoot() {
    return getDataRoot() === path.resolve(path.dirname(process.execPath));
}
// 仅回归测试用：改了 env / execPath 之后重算一次。
function resetDataRootCache() {
    cachedRoot = null;
}
