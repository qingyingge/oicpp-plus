# OICPP-Plus — 合并 upstream/main 计划

> 本文档为 `upstream/main` (mywwzh/oicpp) 向本地 `main` (qingyingge/oicpp-plus，已含 origin + integrate 内容) 合并的执行计划。**origin 侧已就绪，剩下的大活即 upstream/main 合并。**  
> 计划仅供审阅，文档生成后不自动执行任何 `git merge` / `cherry-pick` / `commit` 或文件写入。

---

## 1. 现状概览

| 项目 | 内容 |
|------|------|
| 当前分支 | `main`（本地） |
| 已就绪 | `origin/main`（4 个 ci/build 提交，fast-forward） + `origin/integrate/upstream-1.6.0-beta1`（上游 1.6.0-beta1 安全移植批，74 文件） |
| 待处理 | `upstream/main`（上游主线，从 v1.5.4 往后一大串，至 `8ffe41a`） |
| 远程 | `origin` = qingyingge/oicpp-plus；`upstream` = mywwzh/oicpp |
| 工作区未暂存 | `src/build-info.json`（buildTime / clangFormatVersion 已更新，需在合并前 stash 或提交） |
| 未跟踪 | `.qoder/`（IDE 配置，加入 `.gitignore`，避免误入提交） |

### 两条线的核心分歧（决定了不能直接整体 merge）

| 维度 | 本地 main（origin + integrate） | upstream/main |
|------|-------------------------------|---------------|
| package name | `oicpp-plus-ide` | `oicpp-ide` |
| productName | `OICPP-Plus` | `OICPP IDE` |
| appId | `com.oicpp.plus.ide` | `com.oicpp.ide` |
| 版本 | `1.5.4`（integrate 跟到 `1.6.0-beta1-plus1`） | `1.6.0-beta1` |
| 用户数据目录 | `.oicpp-plus` | `.oicpp` |
| 构建 target | `dir`（`installer.nsi` + 本机 NSIS） | `nsis`（electron-builder 内置） |
| 图标 | `oicpp-plus.ico` | `oicpp.ico` |
| homepage | `github.com/qingyingge/oicpp-plus` | `oicpp.mywwzh.top` |
| `.gitignore` / `AGENTS.md` / `scripts/ci-check.js` | 存在（CI 核心） | **全部删除** |
| `tests/*.test.js` | 35 个回归测试 | 绝大多数被删除 |
| 大量 `.ts` | 与 `.js` 对应，tsc emit 产物 | 大量 `.ts` 被删除，`.js` 保留 |
| `src/main.js` | integrate 安全补丁（~60 处改点） | 近乎重写（+4419 / -5086，9505 行变更） |
| `src/lang/*.json` | integrate 对称新增 18 个键 | 大量键删除（-1305） |

**结论：** `upstream/main` 是大重构/简化方向，与本地 main 的安全补丁叠加方向在核心文件上**相反**。直接 `git merge --no-ff upstream/main` 大概率产生大量手动冲突，且合并后极难通过 `pnpm run ci`。推荐采用 **以本地 main 为 base，逐个 cherry-pick upstream 需要的安全修复提交**，对极高冲突文件手动挑选合并。

---

## 2. 合并目标与顺序

```
本地 main (base, 已含 origin + integrate)
  └─ cherry-pick v1.6.0-beta1 之后的 16 个安全修复提交（按 §4.2 执行顺序）
  └─ 极高冲突文件手动挑选合并（package.json / installer.nsi / src/main.js / src/lang/*.json / src/build-info.json）
  └─ 处理 .ts/.js 漂移
  └─ pnpm run ci 验证
```

---

## 3. 极高冲突文件预判与取舍建议

### P0 极高冲突（必手动解决）

| 文件 | 本地 main 侧 | upstream 侧 | 建议取舍 |
|------|-------------|-------------|----------|
| `package.json` | 完整依赖 + ci/ci:tests/ci:fast/ci:strict/ci:verbose/typecheck 脚本 + `dir` target | 依赖大幅删减，部分改 `"latest"`，scripts 仅保留基础 build，`nsis` target | **以本地 main 为主**。upstream 的 `"latest"` 依赖和移除 ci 脚本不合本项目约定；版本号可参考 `1.6.0-beta1`，但保留 `oicpp-plus-ide` / `OICPP-Plus` 命名 |
| `installer.nsi` | 仅版本号 bump（`1.5.4` → `1.6.0-beta1`），保留 solid LZMA + 64MB 字典、`dir` 输入 | 彻底重写：产品名 `OICPP IDE`、用户目录 `.oicpp`、移除 solid LZMA、`nsis` target、文件列表和注册表全改 | **以本地 main 为主**。AGENTS.md 明确：本项目不用 electron-builder nsis target，用 `installer.nsi` + 本机 NSIS，solid LZMA + 64MB 字典 |
| `src/main.js` | integrate 安全补丁（~60 处，如 `getPublicSettingsSnapshot`、`assertExecutableAllowed`、`readJsonBody` Buffer 攒块、zip bomb 上限、`lockSettingsWindowTitle` 等） | 近乎重写：移除 CommonJS 包装、大量 require，新增 `killProcessTree`、`approvedWritePaths`、`assertPathInWorkspace`/`assertWriteAllowed`、`SETTINGS_ALLOWED_KEYS`、`sanitizeIncomingSettings` 等 | **以本地 main 为基础，逐条 cherry-pick upstream 的兼容安全改进**（见 §4），不直接整体合并 |
| `src/lang/en.json` / `zh-cn.json` | integrate 对称新增 18 个键（`copyFolderIntoSelf`、`saveFailed*`、`fileSwitched`、`globalVariables`、`dataFormatError`、`pasteIntoSelfForbidden`、`fileTooLargeToRead`、`zipTooManyEntries`、`zipTextTooLarge`、`settingsWriteFailed` 等） | 大量键删除（-1305） | **以本地 main 为主**，保留 integrate 新增键；upstream 删除的键若在 main 中仍有引用，不能删除，否则 I7 孤儿键/运行时报错 |
| `src/build-info.json` | version `1.6.0-beta1-plus1`，保留 `clangdVersion`/`clangFormatVersion`，author `mywwzh (修改: qingyingge)` | version `1.6.0-beta1`，去掉 clangd/clangFormatVersion，author 简化为 `mywwzh` | 手动合并：version 用 `1.6.0-beta1-plus1`，保留 `clangdVersion`/`clangFormatVersion`（本项目 prebuild 需要） |

### P1 中高冲突

| 文件 | 冲突点 |
|------|--------|
| `.github/workflows/build.yml` 及 `*test.yml` | 本地有 Node 24 + pnpm + Release 链路收口；upstream 部分 workflow 删除/修改 |
| `scripts/download-clang-format.js` | 本地有 Intel Mac 回退 + 下载器守卫；upstream 删除了该文件 |
| `tests/clang-format.test.js` | 本地有下载器守卫测试；upstream 删除 |
| `.ts` ↔ `.js` 对应关系 | 本地保持 `.ts` → `.js` emit；upstream 大量 `.ts` 被删除，会导致 `tsc -p tsconfig.build.json` 产物漂移检查失败 |

---

## 4. 推荐执行策略：cherry-pick 而非整体 merge

### 阶段 1：确认 base 与工作区清理

```bash
# 确认当前在 main 且已包含 origin + integrate
git checkout main
git log --oneline -5

# 工作区清理：src/build-info.json 未暂存修改先 stash
git stash push -m "build-info pre-merge" -- src/build-info.json

# .qoder/ 未跟踪：加入 .gitignore 或暂时移出，避免误入提交
```

### 阶段 2：从 upstream/main 挑选需要的安全修复

upstream `main` vs 本地 main 的关键提交（按优先级）：

| 提交 | 内容 | 建议 |
|------|------|------|
| `8ffe41a` | 修复安全问题：完善日志敏感信息脱敏 (#541) | **cherry-pick** |
| `23183f0` | 修复安全问题：避免 GDB 断点解析正则回溯 (#540) | **cherry-pick** |
| `bb1c0ce` | 修复安全问题：设置事件脱敏 (#534) | **cherry-pick** |
| `794793c` | 修复安全问题：设置页编译器名称属性转义 (#538) | **cherry-pick** |
| `99b520b` | 进一步收紧工作区外写入与编译输出路径校验 | **cherry-pick**（与 integrate 的 `assertWriteAllowed` 互补） |
| `bc69107` | 修复内置浏览器新标签页无法加载的 bug | **cherry-pick**（允许 data:text/html 内部欢迎页，≤1MB，安全相关） |
| `fafa196` | 修复 PDF 预览不可用的 bug (#544) | **cherry-pick**（readFileBuffer 改用 safeIpcRenderer，CSP frame-src 增加 file:，安全相关） |
| `cb03abe` | 主进程 HTTP/进程树/GDB/编译缓存等系统层 bug (#404 #416 #417 #418 #423 #425 #429 #431) | **跳过**（v1.5.4→v1.6.0-beta1 之间旧提交，integrate 已覆盖或不相关） |
| `bc78684` | 多线程下载器在服务器忽略 Range 时生成损坏文件 (#402) | **跳过**（v1.5.4→v1.6.0-beta1 之间旧提交，integrate 已覆盖或不相关） |
| `ecdca61` | IPC 通道白名单、XSS 转义、路径校验、CSP 等 (#392 … #515) | 已被 integrate 移植部分，避免重复 |
| `7787937` / `be24056` / `f28bc6e` / `3fda410` | 对话框/编辑器/样例测试/界面层 bug | 已被 integrate 移植，跳过 |
| `v1.6.0-beta1` 标签及版本相关 | 版本标签 | 按需，与本地命名保持一致 |

示例命令：

```bash
git cherry-pick 8ffe41a 23183f0 bb1c0ce 794793c 99b520b
```

若某提交冲突，可 `git cherry-pick --abort` 回退，改为手动挑入该提交的相关 diff。

#### 4.2 v1.6.0-beta1 之后提交详细分析（与 integrate 已移植的 8 个提交不重复）

upstream/main 相对于 v1.6.0-beta1 (7a56198) 之后的新提交共 16 个，涉及 12 个独立变更（其中 tabs.js 连续涉及 3 个提交，需按顺序 cherry-pick）。integrate 分支已移植 ecdca61, 99b520b, be24056, 7787937, 57706d9, f28bc6e, 402e042, 3fda410，以下不再重复列出。

⚠️ **重要：部分提交修复的 bug 可能已在 integrate 中通过其他方式修复。** 在 cherry-pick 前，先用以下命令检查该文件在 integrate 是否已有等价修复，若已有则跳过该提交，避免重复冲突：

```bash
# 查看 integrate 分支对该文件的改动
git log integrate --oneline -- <文件路径>

# 比较 main 和 integrate 在该文件上的差异
git diff main..integrate -- <文件路径>
```

| # | 提交 | PR | 主要文件 | 变更摘要 | 有效性 | 需确认/替换 | 执行动作 |
|---|------|-----|------|----------|--------|-------------|----------|
| 1 | d0845f9 | #545 | `src/renderer/js/sidebar/sampleTester.js` | 2 处 textContent 改为 `window.i18n.t('tester.compileStatus'/'running')`，兜底中文 | 高 | 语言包需 `tester.compileStatus`、`tester.running` | 补全语言包键后 cherry-pick |
| 2 | accdd71 | #521 | `src/renderer/js/tabs.js` | 保存失败不再 silent return，改为 throw Error + dialog/alert | 中 | 需 `window.dialogManager.showConfirmDialog`、`message.saveFailed` 键 | 补全语言包键后 cherry-pick（须在 d90f567+bcdcc74 之后） |
| 3 | 9ee5ef1 | #517 | `src/renderer/css/debug.css` | 新增 `.debug-split` / `.debug-split > .left` flex 布局类，13 行 | 高 | 无 | 直接 cherry-pick |
| 4 | d90f567 | #515 | `src/renderer/js/tabs.js` | 删除另存为重复写入逻辑 | 中 | 与 #7 #2 同文件，有顺序依赖 | 按顺序 cherry-pick（第 1 个） |
| 5 | d872ba1 | #512 | `src/main.js` | 安装包文件名正则允许预发布后缀 `(?:-[0-9A-Za-z.]+)?` | 中 | `OICPP-` 前缀需替换为 `OICPP-Plus` | cherry-pick + 替换前缀 |
| 6 | a989e63 | #511 | `src/renderer/js/compile-manager.js` | `cloudCompileRunId` 改为 `let`，非 Windows 跳过后才赋值，catch 中 `runId===null` 检查 | 高 | 无 | 直接 cherry-pick |
| 7 | bcdcc74 | #509 | `src/renderer/js/tabs.js` | `updateTabPathBySource` 新增 `targetUniqueKey` 参数，`markTabAsSavedByUniqueKey` 用 `norm(savedPath)` | 中 | 与 #4 #2 同文件，有顺序依赖 | 按顺序 cherry-pick（第 2 个） |
| 8 | 4066a7c | #508 | `src/renderer/js/formatters/cppFormatter.js` | 空定界符 `R"()"` 解析，`delimEnd` 从 while 循环改为 `i+1` | 高 | 无 | 直接 cherry-pick |
| 9 | 564f25d | #507 | `src/renderer/js/monaco-editor-manager.js` | 保存确认超时从 `success:true` 改为 `success:false` | 高 | 无 | 直接 cherry-pick |
| 10 | 57f5a6a | #543 | `src/renderer/settings/editor.js` | 字体加载提示改为 `window.i18n.t('settings.loadingFonts')`，兜底中文 | 中 | 语言包需 `settings.loadingFonts` | 补全语言包键后 cherry-pick |
| 11 | 8ffe41a | #541 | `src/utils/logger.js` | 日志敏感信息脱敏，`redactString` 正则加强，`err.data` 递归脱敏 | 高 | 无 | 直接 cherry-pick |
| 12 | 23183f0 | #540 | `src/gdb-debugger.js` | `reBreak` 正则重写，去掉 `\\x1a*` 和 `[A-Za-z]*[:]*` 前缀 | 高 | 无 | 直接 cherry-pick |
| 13 | bb1c0ce | #534 | `src/main.js` | 所有 settings-* IPC 发送改用 `getPublicSettingsSnapshot()` 剥离 loginToken | 高 | 需 `getPublicSettingsSnapshot()` 函数存在 | 直接 cherry-pick |
| 14 | 794793c | #538 | `src/renderer/settings/compiler.js` | 下载按钮 `data-name` 从 `safeName` 改为 `safeNameAttr` (`escapeAttribute`) | 中 | 需 `escapeAttribute` 方法存在 | cherry-pick |
| 15 | bc69107 | (无PR) | `src/main.js` | webview `will-attach-webview` 允许 `data:text/html` 内部欢迎页，≤1MB | 中 | 检查 `createWindow` 中 webview 处理上下文 | cherry-pick |
| 16 | fafa196 | #544 | `src/preload.js` + `src/renderer/index.html` | `readFileBuffer` 改用 `safeIpcRenderer`；CSP `frame-src` 增加 `'file:'` | 中 | 需 `safeIpcRenderer` 存在于 preload.js | cherry-pick |

**产品名差异替换：** upstream 使用产品名 "OICPP IDE"、用户目录 ".oicpp"，本地 main 为 "OICPP-Plus"/".oicpp-plus"。合并时上述提交若涉及硬编码命名（如 d872ba1 的 `OICPP-` 前缀），需替换为本地命名。

##### tabs.js 三连提交的顺序依赖（关键）

`tabs.js` 涉及 3 个提交，**必须按以下顺序**应用，否则会产生冲突或逻辑错误：

1. **先应用 d90f567 (#515)**：删除另存为分支中的重复 saveFile 调用。
2. **再应用 bcdcc74 (#509)**：给 `updateTabPathBySource` 新增 `targetUniqueKey` 参数，`markTabAsSavedByUniqueKey` 用 `norm(savedPath)`。此提交在 d90f567 基础上重新引入带参数的调用。
3. **最后应用 accdd71 (#521)**：保存失败改为 throw Error + dialog/alert，在 d90f567+bcdcc74 基础上加错误处理。

##### cherry-pick 前前置条件清单

在执行 cherry-pick 前，确认本地 main 已具备以下前提：

1. **语言包键**（供 d0845f9、57f5a6a、accdd71）：`tester.compileStatus`、`tester.running`、`settings.loadingFonts`、`message.saveFailed`。检查 `src/lang/zh-cn.json` 和 `src/lang/en.json`，缺失则补全（键集必须一致，I1/I2 检查）。
2. **`getPublicSettingsSnapshot()`**（供 bb1c0ce）：integrate 已移植，本地 main 应已有，需确认。
3. **`escapeAttribute` 方法**（供 794793c）：检查 `src/renderer/settings/compiler.js` 的 `CompilerSettings` 类。
4. **`safeIpcRenderer`**（供 fafa196）：检查 `src/preload.js` 是否已定义 `safeIpcRenderer`。
5. **`window.dialogManager.showConfirmDialog`**（供 accdd71）：检查渲染层是否有 dialogManager。

##### 推荐 cherry-pick 执行顺序

```
1. 9ee5ef1 (debug.css)              — 无依赖，先做
2. 4066a7c (cppFormatter.js)        — 无依赖
3. 564f25d (monaco-editor-manager.js) — 无依赖
4. 8ffe41a (logger.js)              — 无依赖
5. 23183f0 (gdb-debugger.js)         — 无依赖
6. a989e63 (compile-manager.js)       — 无依赖
7. bb1c0ce (main.js settings IPC)     — 依赖 getPublicSettingsSnapshot
8. d872ba1 (main.js 正则)            — 需替换 OICPP- 为 OICPP-Plus
9. bc69107 (main.js webview data:)   — 检查上下文
10. fafa196 (preload.js + index.html) — 检查 safeIpcRenderer
11. 794793c (compiler.js)            — 检查 escapeAttribute
12. d90f567 → bcdcc74 → accdd71 (tabs.js 三连，按此顺序)
13. d0845f9 (sampleTester.js)         — 检查语言包键
14. 57f5a6a (editor.js)               — 检查语言包键
```

每个 cherry-pick 后运行语法检查：`node --check <文件>`。全部完成后运行 `pnpm run ci:fast` + `node tests/run-tests.js`。

### 阶段 3：极高冲突文件手动挑选合并

对以下文件**不**使用 git 自动合并，而是以本地 main 当前内容为基础，手动从 upstream diff 中挑入兼容的安全改进：

1. **`package.json`**：保留本项目名称、productName、appId、依赖版本锁定、ci 脚本、`dir` target；可参考 upstream 的版本号 `1.6.0-beta1` 和部分依赖版本下调（如 katex ^0.16.25、markdown-it ^14.1.0、pdfjs-dist 5.0.375），但**不要**改为 `"latest"`，不要删除 ci 脚本。
2. **`installer.nsi`**：保留 `OICPP-Plus IDE` 产品名、`.oicpp-plus` 用户目录、solid LZMA + 64MB 字典、`dir` 输入；仅同步 version 号（`1.6.0-beta1-plus1`）和必要的文件列表调整。
3. **`src/main.js`**：保留 integrate 的 ~60 处安全补丁；手动挑入 upstream 的兼容机制，如：
   - `getPublicSettingsSnapshot` 的 `loggedIn` 脱敏方式（upstream：`clone.account.loggedIn = !!settings.account.loginToken; delete clone.account.loginToken;`）
   - `SETTINGS_ALLOWED_KEYS` + `sanitizeIncomingSettings` 白名单机制
   - `readFileContent` 的 32MB 上限 + UTF-8 BOM 过滤
   - `walk-directory` 的深度 32 上限
   - `copyDirectorySync` 防无限递归（已在 integrate 中有 `main.copyFolderIntoSelf`）
4. **`src/lang/en.json` / `zh-cn.json`**：保留 integrate 新增的 18 个键，确保两语言包键集完全一致（I1/I2）、占位符对应（I3）、en.json 无中文/中文标点（I4）。
5. **`src/build-info.json`**：version `1.6.0-beta1-plus1`，保留 `clangdVersion`/`clangFormatVersion`，author 保留 `mywwzh (修改: qingyingge)`。

### 阶段 4：处理 .ts/.js 漂移

upstream 删除了大量 `.ts` 但保留了 `.js`。合并后：

```bash
npx tsc -p tsconfig.build.json
git diff --stat -- src
```

- 若有 `.js` 漂移：检查是哪些 `.ts` 被 upstream 删除了而对应 `.js` 仍被保留。决定是补回 `.ts`，还是接受 `.js` 为最终形态（并相应调整 `tsconfig.build.json` 的 include）。
- 确保 `src/` 下每个 `<script src="…js">` 加载的渲染层文件不含 `export`/`import`（浏览器脚本形态约定）。

---

## 5. 合并后验证（对应 AGENTS.md CI 流程）

所有步骤必须通过，不得新增 WARN。

| 步骤 | 命令 | 说明 |
|------|------|------|
| 1 | `npx tsc -p tsconfig.build.json` | 重新生成 `.js` 产物 |
| 2 | `git diff --stat -- src` | 输出应为空（无产物漂移） |
| 3 | `pnpm run ci:fast` | 静态检查：JS 语法、CSS 花括号、HTML DOCTYPE、文件引用、IPC 通道、DOM 选择器、CSP、secrets/eval 扫描、依赖审计 |
| 4 | `pnpm run ci:tests` | 回归测试，`tests/*.test.js` 全部通过 |
| 5 | `pnpm run ci:strict` | WARN 也判 FAIL，当前 18 WARN 基线，合并后不得新增 WARN |
| 6 | i18n 守卫 | I1/I2 键集一致、I3 占位符对应、I4 en.json 无中文/中文标点、I7 孤儿键不超 baseline 202 |
| 7 | Electron 实测（若涉及 index.html 脚本顺序或 i18n） | `xvfb-run -a node_modules/electron/dist/electron tests/smoke-electron.js --no-sandbox` |

---

## 6. 回滚方案

每阶段 cherry-pick / 手动合并前，在 `main` 上建立备份分支：

```bash
git branch main-backup-before-upstream-cherrypick
```

若 cherry-pick 产生不可接受冲突，或合并后 `pnpm run ci` 红且无法快速修复：

```bash
git reset --hard main-backup-before-upstream-cherrypick
```

回滚后重新评估。不推送任何分支，除非用户明确要求。

---

## 7. 不建议的做法（反模式）

- ❌ 直接 `git merge --no-ff upstream/main`：两条线在 `package.json`/`installer.nsi`/`src/main.js`/`src/lang/*.json` 上方向相反，冲突极多，合并后代码大概率无法通过 `pnpm run ci`（`ci-check.js` 被删、`.gitignore` 被删、大量 tests 被删、`.ts` 被删导致 emit 漂移）。
- ❌ 把 upstream 的 `"latest"` 依赖、`nsis` target、删除 ci 脚本等直接带入本地 main：违反 AGENTS.md 的构建约定和 CI 基线。
- ❌ 把 upstream 删除的 lang 键同步删除到本地 main：会导致 I7 孤儿键和运行时裸 key。
- ❌ 在合并前不处理 `src/build-info.json` 的未暂存修改：可能被合并覆盖或产生意外冲突。

---

## 8. 执行方案（已确定）

1. **要 cherry-pick 的提交：** v1.6.0-beta1 之后的 16 个提交全部 cherry-pick（按 §4.2 表格的执行动作），v1.5.4→v1.6.0-beta1 之间的 11 个旧提交全部跳过。
   - 无依赖提交（9 个）：9ee5ef1, 4066a7c, 564f25d, 8ffe41a, 23183f0, a989e63, bb1c0ce, d872ba1（需替换 OICPP- 前缀）、bc69107、fafa196、794793c
   - 需补全语言包键后 cherry-pick（3 个）：d0845f9, accdd71, 57f5a6a
   - tabs.js 三连按顺序（3 个）：d90f567 → bcdcc74 → accdd71

2. **极高冲突文件取舍：** 接受「以本地 main 为基础，手动挑入 upstream 兼容改进」的取舍策略（§3 和 §4 阶段 3）。

3. **pnpm 配置：** 保留本地 `packageManager: pnpm@11.7.0`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`，不采纳 upstream 移除 pnpm 的任何更改。

4. **开始执行条件：** 前置条件清单（§4.2）全部确认无误后，即可开始执行 cherry-pick。不推送任何分支，除非用户明确要求。

---

## 9. 执行结果（本轮实际落地，2026-10-27）

### 9.1 计划本身需要修正的两点

1. **cherry-pick 全线不可行**（§4/§8 的前提不成立）。upstream 改的是 `src/**/*.js`，而 fork 的 `.js` 全部是同名 `.ts` 经 `tsc -p tsconfig.build.json` emit 的产物。任何 cherry-pick 都会把产物改成「与 `.ts` 不一致」的下一次 emit 又被覆盖，且 merge-base 是空树，没有可复用的 blob 历史。实际做法改为**按意图手工移植**：读上游 diff → 在 fork 的 `.ts` 里找到对应函数 → 用 fork 的约定重写该修复。
2. **审计范围是 26 个提交，不是 16 个**。写计划时本地只 fetch 到 `d0845f9`；执行期间 upstream 已发布 `v1.6.0-beta2`（`7b24fef`，2026-10-27 14:51），多出 10 个提交，一并审掉了。

### 9.2 逐提交判定（`git log v1.6.0-beta1..upstream/main`，26 条）

| 提交 | 主题 | 判定 | fork 里的依据 |
|---|---|---|---|
| `bb1c0ce` | #534 设置事件脱敏 | **已移植** | `src/main.ts` 14 处广播 + 3 处 return 全改走 `getPublicSettingsSnapshot()`；守卫 `tests/security-boundaries.test.js`「settings-* 广播载荷里没有 account.loginToken」 |
| `8ffe41a` | #541 日志脱敏 | **已移植（改良）** | `src/utils/logger.ts` `SENSITIVE_INLINE_RE` 值分支原来停在首个空白 → `password: a b c` 只抹 `a`；现整段吞到 `,}\r\n`；`serializeError` 的 message/stack/errno/data 也过 `redactString`。守卫在 `tests/upstream-160-security-ports.test.js`（4 条行为断言） |
| `d872ba1` | #512 beta 更新包校验正则 | **已移植（并修掉自己引入的漏）** | `resolveValidatedInstallerPath` 与 `cleanupOldInstallers` 两处判定都放开 `OICPP-Plus-` 与预发布后缀；守卫 `tests/upstream-160-posttag-ports.test.js` |
| `bcdcc74` | #509 保存全部时未命名标签路径错绑 | **已移植** | `updateTabPathBySource` 加第 4 个默认形参 `targetUniqueKey`，点名要换绑的标签，不再统统落到活动标签 |
| `d90f567` | #515 另存为重复写入 | **已移植** | `saveAllFiles` 删掉第二次写（主进程 `save-as-file` 已 write+markLocalSave+broadcast），并把 mark 换成换绑后的新路径 |
| `accdd71` | #521 保存失败关闭标签页无提示 | **已移植** | `closeTab` 的 `proceedSave` 五条死路（原来全是裸 `return`）改成 `throw new Error(window.i18n.t(...))`，catch 统一弹窗；唯一保留静默返回的是「用户在系统保存框里主动取消」 |
| `9ee5ef1` | #517 调试面板变量布局 | **已移植** | fork 标记早就写着 `.debug-split > .left`，但 `debug.css` 一条规则都没有 → `.sidebar-panel .variables-panel{flex:1 1 auto;overflow-y:auto}` 永不生效；补 12 行 |
| `fafa196` | #544 PDF 预览 | 已生效 | `preload.ts:736` + 白名单 `:536`、`index.html` CSP `frame-src 'self' data:`、pdf-viewer `frame-src 'none'`；守卫 `upstream-160-security-ports.test.js:215` |
| `bc69107` | 新标签页 `data:` | 已生效 | `main.ts:3537-3544` 对内联新标签页放行 `data:` |
| `794793c` | #538 编译器名属性转义 | 已生效 | `settings/compiler.ts:2-9` 的 `escapeHtml` 已连引号一起转，用于 `:616`/`:1399` |
| `57f5a6a` | #543 字体加载提示 i18n | 已生效 | `editor.ts:1595` + 双语键齐备 |
| `d0845f9` | #545 批量运行状态 i18n | 已生效 | `sampleTester.ts:2406`/`:2512` |
| `564f25d` | #507 保存超时误判成功 | 已生效 | fork 走 invoke，事件对整体不存在；`monaco-editor-manager.ts:6143-6154` |
| `23183f0` | #540 GDB 断点正则回溯 | 不适用 | fork 的 `src/gdb-debugger.ts` 是 6 行 shim，真身 `gdb-mi-debugger.ts` 走 MI 解析，`reBreak`/`begmidl`/`\x1a` 在 src/tests/scripts 里都查不到 |
| `4066a7c` | #508 空定界符原始字符串格式化 | 不适用 | fork 无 `renderer/js/formatters/`，只有 clang-format（`clang-format-options.ts:7` 记着这次删除）；`buildMinimalFormatEdits` 在 `monaco-editor-manager.ts:7120` |
| `a989e63` | #511 云编译无效调用 | 不适用 | `cloudCompileCurrentFile()` 是禁用桩（`compile-manager.ts:496-498`），并被 `security-regression.test.js:161-163` 锁死 |
| `2aa5f84` | 编译运行结束后未暂停 | **不移植（fork 已用更强的机制解决）** | 上游是退回 `cmd /c start` + `shell:true`；fork 的 `utils/consolepauser-source.js` 自己 `AllocConsole()` + `CreateProcess` + `WaitForSingleObject` + `_getch()`，还会打印执行时间/峰值内存。照抄反而把 fork 的注释里写明的引号语义坑（`main.ts:10352-10356`）重新引入，并多一层 `shell:true` |
| `c9758e6` | #546 打开文件后 Ctrl+K 失效 | **不移植（fork 达成方式不同）** | fork 把 Ctrl+K 放在主进程菜单 accelerator（`main.ts:3839`），Ctrl+Shift+S 同样（`:3854`）；上游那套「renderer 里 600ms 延迟等第二个按键」是与「fork 没有菜单 accelerator」配套的方案 |
| `3819f99` | Ctrl+Shift+I 打开内置浏览器失效 | **不移植（同上）** | fork 有 `CmdOrCtrl+Shift+I` → `menu-open-browser`（`main.ts:3945`）。注意残留风险：Electron 的 accelerator 在 `<webview>` 子文档聚焦时不触发，而 `tabs.ts:3793 openBrowserTab` 每次都生成新 uniqueKey、不去重 —— 若要补 renderer 兜底，得先加去重，否则双击开两个浏览器标签 |
| `14e6269` `33240b7` `1ace3a4` `a80d063` `0ccb2a5` | 手动发布工作流 | **不动** | 五条只改 `.github/workflows/build.yml`；fork 的同名文件与之已分叉 95+/164-（fork 走 `installer.nsi` + 自己的产物清单），且这类改动本地无法验证、只在 GitHub runner 上生效，本轮「不推送」的前提下不碰 |
| `0420597` | 1.6.0-beta2 版本号 | **不动** | 纯版本号（`installer.nsi`/`package.json` + 两处硬编码回退串）。fork 版本口径是 `1.6.0-beta1-plus1`，是否跟进到 `1.6.0-beta2-plus1` 属产品决策 |
| `7b24fef` | package-lock 依赖版本 | 不适用 | fork 用 pnpm，无 `package-lock.json` |

### 9.3 本轮落地的文件

```
src/main.ts                    #534 脱敏出口 17 处 + #512 两处正则
src/utils/logger.ts            #541 值分支 + serializeError
src/renderer/js/tabs.ts        #509 / #515 / #521
src/renderer/css/debug.css     #517 12 行
src/lang/{zh-cn,en}.json       dialog.saveContentUnavailable / dialog.saveTargetUnknown（各 2 键，双语对称）
（以上各自的 .js 由 tsc 重新 emit，无手改产物）
tests/security-boundaries.test.js        沙箱补 getPublicSettingsSnapshot + 载荷捕获，新增 loginToken 泄漏守卫
tests/upstream-160-security-ports.test.js 新增 4 条日志脱敏行为断言（带空格值、JSON 片段、Error.message、不误伤）
tests/upstream-160-close-save-ports.test.js 原先锁住 bug 形状的 3 条断言改成修复后形状（tighten，未放宽语义）
tests/upstream-160-posttag-ports.test.js  新增：#512 两处判定行为 + 口径一致、#517 规则与标记类名对应、#521 proceedSave 不再静默
```

### 9.4 验证

- `npx tsc -p tsconfig.build.json` 后 `git diff --stat -- src` 只剩本轮 9 个文件，无 emit 漂移。
- `npx tsc --noEmit -p tsconfig.json`：0 error。
- `pnpm run ci`：**79 PASS / 22 WARN / 0 FAIL**，回归测试 **53/53**（比基线多一个文件）。WARN 数与基线持平，I7 孤儿键 201（≤基线 202，未擅自下调该常量，因为这 −1 无法归因到本轮改动），I8 仍 1、I8b 仍 0。

### 9.5 过程中修掉的两个自伤（记录以免重犯）

1. 第一次写 `d872ba1` 的正则时，预发布段用了 `[0-9A-Za-z.]+`，**不含连字符**，于是 fork 自己的 `OICPP-Plus-1.6.0-beta1-plus1-Setup.exe` 仍然判非法 —— 与上游原 bug 同一症状。是新加的 posttag 守卫跑出来的，不是人眼看出来的；守卫因此必须在写完后立刻跑。
2. `#521` 的兜底最初写成 `window.alert`，把 tabs.js 的 `alert()` 计数从 0 抬到 1，CI 的 WARN 由 22 变 23。改用本文件既有的 `dialogManager.showError`  surface 后回到 22。

### 9.6 遗留（需用户拍板，本轮未动）

- **`main.ts:5786` 仍返回 `reason:'stopped'`**（上游 `cb03abe` 改成 `started/updated`）：全仓找不到 renderer 消费点，零影响，按「不新增无消费者的改动」原则跳过。
- **`multi-thread-downloader.ts:213`** 抛错前可选 `response.body.destroy()`：上游 `bc78684` 有，fork 缺；只是资源回收更早一点，不改也不泄漏（socket 随 error 关闭）。
- **Ctrl+K 与 Monaco chord 的冲突**：fork 的 `CmdOrCtrl+K` 菜单 accelerator 会先于页面吞掉按键，编辑器内 `Ctrl+K Ctrl+C` 这类序列前缀因此收不到第二个按键（fork 注释 `main.ts:1553-1555` 只处理了 renderer 层抢占，没覆盖 native 层）。改法要么去掉该 accelerator，要么学 `c9758e6` 在 renderer 侧做 chord 延迟 —— 都是改用户已习惯的快捷键，需要产品决策。
- **是否跟进 `1.6.0-beta2` 版本号**、**是否把手动发布工作流的健壮化（校验输入、缺 secret 即失败、`nullglob` 防空产物假装成功）搬到 fork 的 build.yml**：都属发布基建，本地无法验证，建议下次出包前一起处理。

---

文档版本：v1.2（本轮移植已执行并验证；§4/§8 的 cherry-pick 方案作废，以 §9 为准）  
适用仓库：`D:\Users\admin\Desktop\oicpp-plus`
