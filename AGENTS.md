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