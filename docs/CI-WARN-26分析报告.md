# CI 检查 26 个 WARN 完整分析报告

**日期**: 2026-11-09  
**项目**: OICPP-Plus IDE  
**CI 状态**: `pnpm run ci:fast` → 82 OK, 0 FAIL, 26 WARN  
**目标**: 为每个 WARN 确定根本原因，给出修复建议或 baseline 常量，最终启用 `ci:strict`

---

## 概览

| 类别 | WARN 数 | 处理方式 | 是否需改代码 |
|------|---------|----------|-------------|
| D3 DOM/CSS 选择器 | 1 | 加 baseline | 否 |
| D4 IPC channel | 1 | 加 baseline 或重命名 | 可选 |
| D7 调试日志 | 3 | 修复 alert/console.log 或加 baseline | 是(部分) |
| E1 死 IPC handler | 1 | 审计或加 baseline | 可选 |
| E2 CSP unsafe-eval | 1 | 加 baseline（Monaco 必需） | 否 |
| E6 子进程 | 4 | 安全审查或加 baseline | 是(部分) |
| E12 allowpopups | 1 | 移除或加 baseline | 可选 |
| E14 IPC sender 校验 | 1 | 实现校验或维持 baseline 2 | 是 |
| E15 file:// 协议 | 6 | 替换方案或加 baseline | 可选 |
| E16 Electron Fuses | 1 | 配置或维持 baseline 2 | 是(配置) |
| G1 大文件 | 5 | 拆分或加 baseline | 是(重构) |
| H2 sandbox:false | 1 | 开启沙箱或加 baseline | 是 |

**总计: 26 个 WARN**

---

## D3 — DOM/CSS 选择器（1 WARN，23 个选择器）

### 检查规则
`scripts/ci-check.js` [D3] 扫描所有 `.js`/`.ts` 文件中的 `querySelector('.xxx')` 和 `querySelectorAll('.xxx')`，检查这些 class 是否在静态 CSS 文件中定义。Monaco 相关 class 和 `tab-*` 前缀被豁免。

### 根本原因
23 个 class 选择器仅在**动态创建的 DOM** 中使用（调试面板变量树、对话框、Monaco 小部件等），不存在于静态 HTML/CSS 中。CI 只扫描静态文本，无法匹配。

### 文件与行号
- `src/renderer/js/sidebar/debugPanel.js` — 变量树节点 class（如 `.variable-node`, `.scope-group` 等）
- `src/renderer/js/main.js` — 运行时创建的 toast、对话框元素
- 其他渲染层 JS — 运行时插入的 Monaco 相关元素

### 解决方案
**加 baseline**: 在 `scripts/ci-check.js` 中添加 `DOM_SELECTOR_BASELINE = 23`，口径同 `TS_ERROR_BASELINE`（只减不增，注释说明理由）。  
**不推荐修改**: 这些 class 是动态生成的，强行加进 CSS 会导致无用样式，且新增 class 会持续增加 baseline。

---

## D4 — IPC channel 不匹配（1 WARN，6 个方法）

### 检查规则
`scripts/ci-check.js` [D4] 提取 `src/main.js` 中的 `ipcMain.handle`/`ipcMain.on` channel 名，以及 `src/renderer/js/main.js` 中 `electronAPI.xxx()` 调用，按归一化后（去除 `-_`、小写）匹配。未匹配到的报 WARN。

### 根本原因
6 个渲染层调用的方法在主进程中没有同名 channel：

| 方法 | 渲染层调用 | 主进程实际 channel | 原因 |
|------|-----------|-------------------|------|
| `getIdeLoginStatus` | `electronAPI.getIdeLoginStatus()` | `ide-login-status` | 命名不一致（camelCase vs kebab-case） |
| `startIdeLogin` | `electronAPI.startIdeLogin()` | `ide-login-start` | 同上 |
| `logoutIdeAccount` | `electronAPI.logoutIdeAccount()` | `ide-logout` | 同上 |
| `openFile` | `electronAPI.openFile()` | 无直接对应 | 主进程用 `open-file-dialog`/`open-folder-dialog` |
| `writeTerminal` | `electronAPI.writeTerminal(...)` | `terminal-write` | 命名不一致 |
| `getTerminalTTY` | `electronAPI.getTerminalTTY(...)` | `terminal-get-tty` | 同上 |

### 解决方案
**选项 A（加 baseline）**: 添加 `IPC_CHANNEL_BASELINE = 6`，注释说明这 6 个是命名差异导致的假阳性。  
**选项 B（重命名）**: 将主进程 channel 重命名为与 `electronAPI` 方法名一致，或在渲染层统一用 kebab-case。但这会改动多处调用点，风险较大。  
**推荐**: 先加 baseline，后续有机会时统一命名规范。

---

## D7 — 调试日志（3 WARN）

### 检查规则
`scripts/ci-check.js` [D7] 扫描所有 JS 文件中的 `console.log(`、`debugger;`、`alert(`。`debugger;` 为 FAIL，`console.log`/`alert` 为 WARN。

### 根本原因

| 文件 | 位置 | 内容 | 说明 |
|------|------|------|------|
| `src/preload.js` | line 988 | `console.log(...args)` | preload 脚本内部调试输出 |
| `src/renderer/js/main.js` | line 1911 | `alert(window.i18n.t('message.openFolderElectronRequired'))` | 原生 alert 弹窗 |
| `src/renderer/js/main.js` | line 3577 | `alert(window.i18n.t('feedback.externalLinkFailed', { url }))` | 原生 alert 弹窗 |
| `src/renderer/js/main.js` | line 3582 | `alert(window.i18n.t('feedback.externalLinkFailed', { url }))` | 原生 alert 弹窗 |
| `src/renderer/js/main.js` | line 3842 | `alert(window.i18n?.t?.('message.updateUnavailable'))` | 原生 alert 弹窗 |
| `src/renderer/js/main.js` | line 3847 | `alert(window.i18n?.t?.('message.updateElectronOnly'))` | 原生 alert 弹窗 |
| `src/renderer/js/sidebar/debugPanel.js` | line 330 | `console.log('[DebugPanel] _renderVariables:', v)` | 调试面板日志 |
| `src/renderer/js/sidebar/debugPanel.js` | line 769 | `console.log('[DebugPanel] Sending IPC: ${channel}', args)` | 调试面板日志 |

### 解决方案
- **`alert()` (5 处)**: 替换为统一 toast 组件或对话框。`alert` 会阻塞渲染进程，且无法国际化样式。建议改用 `window.i18n.t()` + `showToast()`（preload 已提供）。
- **`console.log` preload (1 处)**: preload 无 DOM，可移除或改用主进程 logger 通过 IPC 发送。
- **`console.log` debugPanel (2 处)**: 封装为仅在 `--dev` 模式下输出，或移除。

或加 baseline `DEBUG_LOG_BASELINE = 3`（按文件数）或 `DEBUG_LOG_BASELINE = 8`（按调用次数）。

---

## E1 — 死 IPC handler（1 WARN，18 个 handler）

### 检查规则
`scripts/ci-check.js` [E1] 提取 `src/main.js` 中所有 `ipcMain.handle`/`ipcMain.on` 注册的 channel，与渲染层/preload 中实际引用的 channel 对比。未被引用的报 WARN。CI 用简单字符串匹配，无法识别动态 channel 名。

### 根本原因
18 个 handler 在主进程注册，但 CI 找不到渲染层引用：

| Channel | 注册类型 | 是否被引用 | 说明 |
|---------|---------|-----------|------|
| `open-folder` | `ipcMain.on` | 预载白名单有 `open-folder-dialog`，不匹配 | 命名差异 |
| `window-is-maximized` | `ipcMain.handle` | 预载事件白名单有 `window-maximized` | 事件 vs handle 差异 |
| `request-new-file` | `ipcMain.on` | 无渲染层调用 | 可能废弃 |
| `request-open-file` | `ipcMain.on` | 无渲染层调用 | 可能废弃 |
| `request-save-file` | `ipcMain.on` | 无渲染层调用 | 可能废弃 |
| `get-top-level-settings` | `ipcMain.handle` | 无渲染层 `electronAPI.getTopLevelSettings` | 可能废弃 |
| `updateSettings` | `ipcMain.handle` | 有 `electronAPI.updateSettings` | CI 字符串匹配可能因大小写/下划线未命中 |
| `get-system-info` | `ipcMain.handle` | 无渲染层调用 | 可能废弃 |
| `show-message-box` | `ipcMain.handle` | 无渲染层调用 | 可能废弃 |
| `debug-run` | `ipcMain.on` | 有 `ipcRenderer.send('debug-run')` | CI 只看 `invoke` 不看 `send` |
| `debug-request-callstack` | `ipcMain.on` | 有 `ipcRenderer.send` | 同上 |
| `debug-goto-frame` | `ipcMain.on` | 有 `ipcRenderer.send` | 同上 |
| `debug-refresh-variables` | `ipcMain.on` | 有 `ipcRenderer.send` | 同上 |
| `debug-load-more-variable` | `ipcMain.on` | 有 `ipcRenderer.send` | 同上 |
| `debug-collapse-variable` | `ipcMain.on` | 有 `ipcRenderer.send` | 同上 |
| `get-current-file` | `ipcMain.handle` | 无渲染层调用 | 可能废弃 |
| `get-breakpoints` | `ipcMain.handle` | 无渲染层调用 | 可能废弃 |

### 解决方案
**逐个审计**: 
1. 确认哪些 handler 真的废弃（cloud 相关、旧版 API），从主进程移除。
2. 确认哪些是 CI 误报（如 `updateSettings` 被调用但 CI 未匹配），在调用处添加显式字符串字面量或注释。
3. 对确认保留的动态调用，加 baseline `DEAD_IPC_HANDLER_BASELINE = 18`。

**推荐**: 先审计明确废弃的（request-*、get-top-level-settings、get-system-info、show-message-box、get-current-file、get-breakpoints），其余加 baseline。

---

## E2 — CSP unsafe-eval（1 WARN）

### 检查规则
`scripts/ci-check.js` [E2] 检查 `index.html` 中 Content-Security-Policy 的 `script-src` 是否包含 `'unsafe-eval'`。

### 根本原因
Monaco Editor 需要 `unsafe-eval` 来 JIT 编译编辑器 Worker 和语言服务。这是 Monaco 的已知必要权衡，无法移除。

### 解决方案
**加 baseline**: `CSP_UNSAFE_EVAL_BASELINE = 1`，注释说明 Monaco 依赖。  
**不能移除**: 移除后编辑器无法工作。

---

## E6 — child_process 安全（4 WARN，34 次调用）

### 检查规则
`scripts/ci-check.js` [E6] 扫描所有 JS 文件中 `child_process` 的 `exec`/`execSync`/`spawn`/`spawnSync` 裸调用，以及 `shell: true` 的 spawn。

### 根本原因
`src/main.js` 中 34 次合法子进程调用：

| 类型 | 次数 | 用途 |
|------|------|------|
| `execSync` | 6× | Windows 注册表查询（reg query）、PATH 检查、command -v |
| `spawn` | 21× | clangd、编译器、gdb、tasklist/ps、7zip、python3 |
| `spawnSync` | 7× | clangd 版本检查、内存监控、fuser、python3、sh -c |

所有调用都有合法理由：
- **clangd/gdb/编译器**: 核心功能，参数来自配置文件（非用户直接输入）
- **powershell reg query**: 仅 Windows，查询系统版本和 PATH
- **7zip**: 解压测试库，参数固定
- **tasklist/ps**: 内存监控，PID 来自内部跟踪
- **python3**: 终端控制序列，脚本固定

### 解决方案
**安全审查**: 确认所有传入 `spawn`/`execSync` 的参数都经过严格验证：
- 用户可控输入（文件路径、编译器参数）使用参数数组形式 `spawn(cmd, [args...])` 而非字符串
- 路径参数使用 `quoteForBash()` 或绝对路径白名单
- 避免 `shell: true`

或加 baseline `CHILD_PROCESS_BASELINE = 34`（按调用次数）或 `CHILD_PROCESS_CALL_BASELINE = 4`（按调用点）。

**推荐**: 先审查关键调用点（特别是用户可控输入路径），再加 baseline。

---

## E12 — webview allowpopups（1 WARN）

### 检查规则
`scripts/ci-check.js` [E12] 扫描 HTML 和 JS 文件中的 `allowpopups`。

### 根本原因
`src/renderer/js/browser-manager.js` line 125 和 `src/renderer/js/browser-manager.ts` line 154：
```javascript
webview.setAttribute('allowpopups', 'true');
```

**故意保留**: 内置浏览器需要允许 `target="_blank"` 和 `window.open` 打开新标签页。否则 Electron 会在 webview 层拦截弹窗，`setWindowOpenHandler` 不会触发，导致网页内链接无法在新标签页打开。

### 解决方案
**加 baseline**: `WEBCVIEW_ALLOWPOPUPS_BASELINE = 1`，注释说明这是内置浏览器功能所必需。  
**可选加固**: 确保 webview 有 `sandbox` 属性限制，且 partition 隔离。

---

## E14 — IPC sender 校验缺失（1 WARN，baseline 2）

### 检查规则
`scripts/ci-check.js` [E14] 检查 `src/main.js` 中是否有 `senderFrame.origin`、`validateSender` 或 `senderFrame &&` 等发送者验证代码。

### 根本结果
**未找到任何 sender 校验代码**。主进程处理 IPC 消息时不验证 `event.senderFrame.origin`，无法确认消息来源合法性，存在跨源伪造风险。

### 解决方案
**实现校验**（推荐）: 在主进程 IPC handler 入口处增加来源校验：
```javascript
function isTrustedOrigin(origin) {
    // 仅允许同源渲染进程
    return origin === null || origin.startsWith('electron://') || origin === 'file://';
}
// 在每个 handler 开头：
if (!isTrustedOrigin(event.senderFrame.origin)) {
    logWarn('IPC 来自不信任来源，拒绝:', channel);
    return;
}
```

或维持现有 baseline `HARDENING_GAP_BASELINE = 2`（E14 + E16 共用）。

---

## E15 — file:// 协议使用（6 WARN，26 处引用）

### 检查规则
`scripts/ci-check.js` [E15] 扫描所有 JS 文件中的 `file://` 字符串。

### 根本原因
所有 26 处都是合法的 path-to-fileURL 转换，用于加载本地资源：

| 文件 | 次数 | 用途 |
|------|------|------|
| `src/main.js` | 3× | `normalizeDroppedPath` 解析拖放的 file:// 路径 |
| `src/preload.js` | 1× | 外部协议白名单检查 |
| `src/renderer/js/main.js` | 4× | 背景图路径 `file:///` + 路径 |
| `src/renderer/js/monaco-editor-manager.js` | 11× | Monaco 编辑器资源 URI 编码/解码 |
| `src/renderer/js/settings-init.js` | 3× | 背景图路径 `file:///` |
| `src/renderer/js/tabs.js` | 4× | 编辑器 URI 前缀判断 |

### 解决方案
**加 baseline**: `FILE_PROTOCOL_BASELINE = 26`，注释说明都是合法的本地路径转换。  
**可选优化**: 将 Monaco 资源加载改用 AMD loader 路径，但改动面大、收益小。

---

## E16 — Electron Fuses 缺失（1 WARN，baseline 2）

### 检查规则
`scripts/ci-check.js` [E16] 检查 `package.json` 的 `build.electronFuses` 或 `build['electron-fuses']`，或 forge.config 文件，或 `@electron/fuses` 依赖。

### 根本原因
`package.json` 的 `build` 字段中没有 `electronFuses` 配置，Electron Fuses（运行时安全开关，如禁用 `runAsNode`、`nodeCliInspect`）未启用。

### 解决方案
**配置 Fuses**: 在 `package.json` `build` 字段添加：
```json
"electronFuses": {
    "version": "^1.0.0",
    "selected": [
        {
            "fuse": "runAsNode",
            "enabled": false
        },
        {
            "fuse": "nodeCliInspect",
            "enabled": false
        },
        {
            "fuse": "nodeEmbedded",
            "enabled": true
        }
    ]
}
```
需要安装 `@electron/fuses` 依赖。

或维持现有 baseline `HARDENING_GAP_BASELINE = 2`（E14 + E16 共用）。

---

## G1 — 大文件（5 WARN）

### 检查规则
`scripts/ci-check.js` [G1] 扫描所有 JS 文件，行数超过 3000 的报 WARN。

### 根本原因
5 个文件超过 3000 行阈值：

| 文件 | 行数 | 超过 |
|------|------|------|
| `src/main.js` | 12543 | 9543 |
| `src/renderer/js/monaco-editor-manager.js` | 9321 | 6321 |
| `src/renderer/js/tabs.js` | 5460 | 2460 |
| `src/renderer/js/main.js` | 4473 | 1473 |
| `src/renderer/js/sidebar/sampleTester.js` | 3665 | 665 |

这些文件违反单文件职责单一原则，难以维护和测试。

### 解决方案
**重构拆分**（推荐，但工作量大）:
- `src/main.js` → 拆分为 `main-process/` 下的多个模块（调试、编译器、LSP、文件系统、设置等）
- `src/renderer/js/monaco-editor-manager.js` → 按功能拆分（编辑器管理、格式化、语言服务）
- `src/renderer/js/tabs.js` → 标签管理与文件历史分离
- `src/renderer/js/main.js` → 渲染层应用逻辑拆分
- `src/renderer/js/sidebar/sampleTester.js` → 样例测试器逻辑拆分

或加 baseline `LARGE_FILE_BASELINE = 5`（按文件数）。

**推荐**: 先加 baseline，逐步重构大文件。

---

## H2 — BrowserWindow sandbox:false（1 WARN，5 个窗口）

### 检查规则
`scripts/ci-check.js` [H2] 检查 `src/main.js` 中 `sandbox:false` 的出现次数。

### 根本原因
5 个 `BrowserWindow` 实例设置了 `sandbox: false`：

| 行 | 窗口类型 | 原因 |
|----|---------|------|
| 3237 | 主窗口 | 需要 preload 集成 |
| 8373 | 编译器设置窗口 | 需要 preload 集成 |
| 8409 | 编辑器设置窗口 | 需要 preload 集成 |
| 8450 | 代码模板窗口 | 需要 preload 集成 |
| 8484 | 备份设置窗口 | 需要 preload 集成 |

所有窗口都使用 `preload.js`，且 `nodeIntegration: false`、`contextIsolation: true`，仅 `sandbox: false` 为了允许 preload 脚本访问某些 Node.js API。

### 解决方案
**加固**（推荐）: 对不需要 Node.js 的窗口，设置 `sandbox: true` 并确保 preload 通过 `contextBridge` 暴露所需 API。  
**或加 baseline**: `SANDBOX_FALSE_BASELINE = 5`，注释说明这些窗口需要 preload 集成。

---

## E13 — will-navigate（已 OK）

已在 1.6.0-beta1 移植批中清掉，主窗口有 `will-navigate`/`will-redirect` 处理，webview 有守卫。此项不计入 26 个 WARN。

---

## 推荐执行顺序

### 第一阶段：安全加固（改代码，可降 WARN）
1. **E14 IPC sender 校验** — 实现 `senderFrame.origin` 验证
2. **H2 sandbox:false** — 评估各窗口是否可开启沙箱
3. **E6 子进程** — 审查关键调用点，确保参数验证
4. **D7 alert()** — 5 处替换为 toast/对话框

### 第二阶段：配置 baseline（改 ci-check.js，不改业务代码）
5. **D3 DOM_SELECTOR_BASELINE = 23**
6. **D4 IPC_CHANNEL_BASELINE = 6**
7. **D7 DEBUG_LOG_BASELINE = 3** 或 8
8. **E1 DEAD_IPC_HANDLER_BASELINE = 18**（审计后可能降低）
9. **E2 CSP_UNSAFE_EVAL_BASELINE = 1**
10. **E12 WEBCVIEW_ALLOWPOPUPS_BASELINE = 1**
11. **E15 FILE_PROTOCOL_BASELINE = 26**
12. **E16 electronFuses** — 配置或维持 baseline
13. **G1 LARGE_FILE_BASELINE = 5**

### 第三阶段：重构（长期）
14. G1 大文件拆分
15. E1 真正废弃的 handler 移除

所有 baseline 常量应遵循 `TS_ERROR_BASELINE` 的口径：**只减不增**，并写明理由注释。

---

## 预期结果

完成上述所有 baseline 后，`pnpm run ci:fast` 应为 0 WARN，此时可安全启用 `pnpm run ci:strict`（WARN 将判 FAIL）。