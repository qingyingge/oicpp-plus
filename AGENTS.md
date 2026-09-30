# OICPP-Plus IDE — Project Overview

## Type
Electron desktop app (JS), for competitive programming.

## Entry
`src/main.js`

## Package manager
pnpm@11.7.0

## Key scripts
| Script | Command |
|--------|---------|
| `start` | `electron .` |
| `dev` | `electron . --dev` |
| `build` | prebuild steps + electron-builder |
| `ci` | `node scripts/ci-check.js` |
| `ci:tests` | `node scripts/ci-check.js --only tests`（只跑回归测试） |
| `ci:fast` | `node scripts/ci-check.js --skip tests`（只跑静态检查） |
| `ci:strict` | `node scripts/ci-check.js --strict`（WARN 也判 FAIL，当前 18 WARN 会红） |
| `ci:verbose` | `node scripts/ci-check.js --verbose`（详细输出） |

## Workflows（按任务类型的正确操作方式）
本节按任务类型登记「这件事在本项目里应该怎么做」。动手前先在这里找对应条目，照着走；条目里点名的**反模式**不要试。判断不了就问，不要凭通用经验猜流程。新增条目统一用三级标题，格式：适用场景 → 正确命令序列 → 反模式（附失败特征）→ 坑。

已登记：
- [打安装包](#workflows打安装包)
- [改界面文案 / 加翻译](#workflows改界面文案--加翻译i18n)

### 打安装包（Build / Installer）
本项目的安装包**不用** electron-builder 的 nsis target 出，而是用仓库根目录自带的 `installer.nsi` + 本机 NSIS。`package.json` 里 `build.win.target = "dir"`，electron-builder 只负责产出 `dist\win-unpacked`；`installer.nsi` 直接从该目录取文件，输出 `dist\OICPP-Plus-<version>-Setup.exe`（`installer.nsi:69`）。CI 同流程，见 `.github/workflows/build.yml:319`。

**不要**执行 `electron-builder --win nsis`：它会尝试联网下载 NSIS 工具链（缓存在 `%LOCALAPPDATA%\electron-builder\Cache`），网络不稳时会以 `fetch failed` / `TypeError: terminated` 失败，且该失败与代码无关。

完整流程（Windows）：
```powershell
pnpm run prebuild:icons        # 生成图标
pnpm run prebuild:native       # Windows 上是 no-op（仅 POSIX 需要 fastspawn）
pnpm run prebuild:clangd       # 目标已存在则自动跳过下载
pnpm run prebuild:clang-format # 同上
pnpm exec electron-builder --win dir     # 产出 dist\win-unpacked
& "C:\Program Files (x86)\NSIS\makensis.exe" "/DPRODUCT_VERSION=1.5.4" installer.nsi
```

要点：
- 跑 makensis 前必须先有 `dist\win-unpacked`，它是 installer.nsi 的唯一输入；只跑 makensis 会得到缺文件的包。
- `pnpm run build` 等于「全部 prebuild + electron-builder」，其中含 `prebuild:buildinfo`（会改写构建时间）；要保留原构建时间就别用它，按上面步骤逐条跑。
- 版本号取自 `package.json`，可用 `/DPRODUCT_VERSION=x.y.z` 覆盖（`installer.nsi:6-8`）。
- **构建时间只由 `pnpm run prebuild:buildinfo` 改写**（写入 `src/build-info.json` 的 `buildTime`）。需要保持原构建时间时就跳过该步骤，直接用其余 prebuild + electron-builder + makensis。
- 产物会覆盖同名旧包，必要时先备份。
- 压缩是 solid LZMA + 64MB 字典，打包耗时数分钟到十几分钟属正常，耐心等，不要中途打断重试。

### 改界面文案 / 加翻译（i18n）
**渲染层一律写 `window.i18n.t('key')`。** 不要新增 `this.t` 或 `window.__` 的调用（类上的 `this.t` 包装已随存量清理删除）。模板字符串里重复调用时允许保留局部别名，但**必须包 `window.i18n`**：

```js
// 允许：别包 window.i18n 更可读
const t = (key, params) => window.i18n?.t?.(key, params) || key;
// 需要兜底文案时
const t = (key, params, fallback) => window.i18n?.t?.(key, params) || fallback || key;
```

主进程没有 `window`，走 `src/main.js:20` 的 `const { t } = require('./lang')`（i18next），`utils/` 下的模块用 `require('../lang')`。这条不受「统一 window.i18n.t」约束。

**形参个数是最容易翻车的地方**：给两参的入口传三个参数只会**静默丢弃** —— 不报错、界面照常显示、CI 全绿，只有 i18n 未就绪时才暴露成裸 key 名。

| 入口 | 形参 | 说明 |
|------|------|------|
| `window.i18n.t(key, params)`（`src/renderer/js/i18n.js:103`） | **2** | **唯一入口** |
| 局部 `const t = ...` 别名 | 按自己定义 | 允许，但形参数必须与调用处一致 |
| `t(key, params)`（`src/main.js:20`） | 2 | 主进程，长期保留 |

`window.__`（`i18n.js:318`，`i18n.t.bind(i18n)`）与 `this.t` 已全部清理完毕，不要再用。
注意 `src/main.js`（主进程）和 `src/renderer/js/main.js`（渲染层）是两个同名文件，行号别看串。

HTML 静态文案挂 `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` / `data-i18n-aria-label`，由 `src/renderer/js/i18n.js:215 _applyToDOM` 统一覆盖。**行内中文只是 JS 加载前的默认值，保留即可**，I8 不计入这类行。

主进程语言切换：启动时 `src/main.js:2663` 加载、设置变更时 `src/main.js:7891` `setLanguage`，无状态，`t()` 直接调即可。

改完必须跑 `pnpm run ci`（I1~I8 + 回归测试）。

**反模式：**

- ❌ 给 `window.i18n.t` 传第三个参数：`window.i18n.t('key', null, '中文兜底')`。第三参数被**静默丢弃**，i18n 未就绪时回退成**裸 key 名**。要兜底就写 `window.i18n?.t?.('key') || '兜底文案'`（`?.` 不能省，见坑）。`tests/i18n.test.js` 有守卫拦这个，但别依赖守卫兜底。
- ❌ 改局部别名的形参个数却不同步调用处。把 `const t = (key, params, fallback) => ...` 缩成两参、而调用处还传第三个，兜底就没了 —— 不会有任何报错。本轮收敛时就踩过：把 5 处三参别名改成两参，30 处调用静默丢了兜底文案。改完务必用形参扫描确认一遍。
- ❌ 用已翻译文案反推语义状态，如 `status.includes(t('compileOutput.successSimple'))` 决定指示灯颜色。耦合方向反了，改一次译文就静默失配。已登记为 M57（`docs/BUG_REPORT.json`），正解是显式传 `setStatus(status, type)`。

**坑：**

- 取消/失败这类**要被代码识别**的状态，不要拿文案匹配。改用错误码：下载器已改为 `error.code = 'DOWNLOAD_CANCELLED'` + 导出的 `isCancelledError`（`utils/multi-thread-downloader.js`），别退回 `error.message.includes(...)`。
- I8 拦硬编码 CJK（baseline 0）；I7 拦孤儿键（baseline 205，`scripts/ci-check.js:843`）—— 语言包里有、源码里查不到引用的键，存量 205 暂不清理，只锁死不许增长，每清一批降一档。往语言包加键后若报孤儿键超标，说明没接上。判定口径同时认字符串字面量和**属性访问**（`main.js:3617` 读语言列表用的是 `content.meta.code`，只认引号会把 `meta.code/name/nameEn` 误判成孤儿）。
- I7 自己报的「未静态引用 266」大半是误报：它只认 `t('key')`，认不出 `t(c ? 'a' : 'b')`、`_t(key, fb)`、`t(el.dataset.i18n)`。判断键是否真的没人用，要用宽松口径重算。
- 改语言包时 `zh-cn.json` 与 `en.json` 键集必须完全一致（I1/I2）、`{token}` 占位符一一对应（I3）；`en.json` 不允许残留中文（I4）或中文标点。
- 批量正则替换 `window.i18n ? window.i18n.t('k') : 'x'` 这类表达式**极易退化成 `= ('k')`**（I5 专门拦这个）。

## CI / Verification
No lint/typecheck scripts. Only CI is `pnpm run ci` — runs `scripts/ci-check.js` which does static analysis (JS syntax, CSS brace matching, HTML DOCTYPE, file reference resolution, IPC channels, DOM selectors, CSP, secrets/eval scanning, dependency audit, etc.) plus a `[T1]` regression-test step: auto-discovers `tests/*.test.js` via `tests/run-tests.js` (add a new `*.test.js` file to extend the suite; failing test → CI FAIL). CI modes via runtime args: `pnpm run ci:tests` (T1 only), `ci:fast` (skip T1), `ci:strict` (WARN counts as FAIL), `ci:verbose`. No Electron smoke test (the old `ci-local.ps1` was removed; its smoke test leaked orphan electron.exe processes).

## Structure
```
src/
  main.js              — Electron main process entry
  preload.js           — preload script
  main-process/        — main process modules
  renderer/            — renderer (HTML/JS/CSS)
    index.html
    css/
    js/
  lang/                — language definitions
  utils/               — utilities
scripts/
  ci-check.js          — CI checks
tests/
  run-tests.js         — regression test runner (auto-discovers *.test.js)
  preload.test.js      — IPC whitelist / event unwrap / markdown render
  downloader.test.js   — multi-thread downloader md5/cancel/failure restore
```

## Key dependencies
- electron ^37.x
- monaco-editor, xterm, node-pty
- markdown-it, katex, highlight.js
- axios, iconv-lite, winreg
- electron-builder (dev)

## Conventions
- Regression tests = plain Node scripts in `tests/` (`pnpm run ci:tests`), no external test framework.
- CI check = `pnpm run ci` only.
- CSP allows `unsafe-eval` (Monaco needs it).
- No GitHub Actions / GitLab CI / Docker.