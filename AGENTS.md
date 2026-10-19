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
- [迁移 .js → .ts](#workflows迁移-js--ts)

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

### 迁移 .js → .ts（TypeScript 路线甲）
**`.ts` 是唯一手写源，`.js` 由 `tsc -p tsconfig.build.json` 就地 emit 出来**（`rootDir`/`outDir` 同为 `src`），所以 `.js` 不许手改。`tsconfig.json` 负责全量 typecheck；`tsconfig.build.json` 带 `noCheck: true` 且 `include: ["src/**/*.ts", "src/**/*.d.ts"]` —— 全量 emit，**没有白名单要登记**，新增 `.ts` 直接会被编译。`.d.ts` 只进程序不出 JS。

**提交前必须先编译一次**：`npx tsc -p tsconfig.build.json`，然后 `git diff --stat -- src` —— 输出非空就是漂移，两种成因：改了 `.ts` 没编译，或者有人手改了 `.js` 产物。漂移不会让 `tsc --noEmit` 报错（两边各自都合法），所以只能靠这一步兜住。历史上这里靠 `files` 白名单兜，代价是「`.ts` 漏登记 → 它的 `.js` 静默不再重生成」，实测已踩到（`gdb-mi-debugger.ts` 只因为被 `gdb-debugger.ts` 的 `import = require` 传递进程序才没漂），白名单已因此取消。

`.js` ↔ `.ts` 的对应关系仍然成立：`src/` 下每个 `.js` 都有同名 `.ts`。

正确命令序列：
```bash
npx tsc -p tsconfig.build.json   # 重新生成 .js（注意：会用 emit 结果覆盖工作区里的 .js）
git diff --stat -- src           # 提交前必查：非空 = 产物漂移（漏编译或手改了 .js）
node tests/run-tests.js          # 快速回归，定位断言失败
pnpm run ci                      # 完整校验（75 项检查 + 35 个回归测试）
npx tsc --noEmit -p tsconfig.json # 单独数本文件的 tsc error
```
迁移完必须把新文件自身的 error 清到 0，再把 `scripts/ci-check.js:1332` 的 `TS_ERROR_BASELINE` **往下压到实测总数**（ratchet 只减不增，每清一批降一档）。

**反模式：**

- ❌ 给被 `<script src="…js">` 加载的渲染层文件加 `export`/`import`。`module: commonjs` 会把 `export class` emit 成 `Object.defineProperty(exports, "__esModule", …)`，浏览器脚本标签下 `exports` 未定义 → 整文件运行期炸。判据：**文件尾有没有 `module.exports` 守卫**。有的（Node 侧，如 `terminal-manager.ts`）随意用 ES 语法；没有的（浏览器 script 形态，如 `settings/compiler.ts`、`settings/templates.ts`）必须保持**全局 script**，不加任何 import/export。注意 `templates.ts` 已经踩了这个坑。
- ❌ **用 `any` 躲类型错误**（项目明令禁止）。改用 `unknown` + 局部收窄。收窄后若为保住测试锁定的正文形状而必须换形参名（如 `isTimeoutError(cause)` 内部 `const error = cause as TimeoutLikeError`），同步把那条断言从 `/function isTimeoutError\(error\)/` 放宽成 `/function isTimeoutError\(/`。
- ❌ 改测试断言去迎合 emit 产物里**语义**的变化。放宽只能针对**排版**（见下条坑），语义收紧就是自废守卫。

**坑：**

- **tsc 的 printer 会重排源码**：`if (x) return;` → `if (x)\n    return;`，`} catch (e) {` → `}\ncatch (e) {`，空行全被删掉。所以所有**读源码做正则断言**的测试在迁移后必然误报（本轮实测 `security-regression`、`compiler-settings-hardening`、`i18n-main-process` 三处）。修法是把断言的排版敏感点改成空白容忍：`\} catch` → `\}\s*catch`，单行 if 的 `\) return 'x'` → `\)\s*return 'x'`。断言的语义（守卫存在、结构顺序、行为验证）不能动。
- **类型标注要写在会被完全擦除的位置**，这样 emit 产物与原 `.js` 逐字一致：`as T`、`<T>` 泛型实参、`!`、`e.target as HTMLInputElement` 都会擦成原表达式。用 `(expr as T)` 单表达式形式包住整个语句，别拆成 `const a = expr; const b = a as T;`（多出一行，且部分断言按行号/前后文切片）。反过来 `catch (e)` 在 strict 下是 `unknown`，写 `e.message` 必须 `(e as Error).message`。
- **锁定形参名的断言**靠签名擦除成立：`async setCompilerPath(path: string)` → emit 成 `async setCompilerPath(path)`。别把形参改成解构或改名，`tests/audit-fixes-2026-10-01.test.js:298` 用 `indexOf('async setCompilerPath(path)')` 定位。
- 字段声明（`settings: T;`）在 es2022 目标下会 emit 成真实 class field（`settings;`），构造赋值之前先置 `undefined`；字段**只声明不初始化**，赋值全留在构造函数里，否则顺序会覆盖。

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