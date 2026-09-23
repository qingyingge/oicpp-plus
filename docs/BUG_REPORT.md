# OICPP-Plus IDE — 全面 Bug 报告

生成时间: 2026-09-21
最后更新: 2026-09-23（纳入仓库跟踪，标记改为三态）
总发现: 100+ 个 bug

状态标记（三态）：
- **待确认**：原判定「部分有效」，需进一步确认复现与影响范围
- **待修复**：原判定「有效」，问题确认存在，尚未修复
- **已修复**：已修复且有代码/回归测试覆盖（条目引用块含对应 commit）
另有 22 条已证伪条目标记为 **无效**，不属于 bug，不计入三态。

---

## 🔴 CRITICAL（严重）

### C1. IPC 白名单完全被绕过 【待确认】
- **文件**: `src/preload.js:483-675`
- **问题**: `electronAPI` 直接调用 `ipcRenderer.invoke()`/`ipcRenderer.send()`，完全绕过 `safeIpcRenderer`。`ALLOWED_SEND_CHANNELS` 和 `ALLOWED_INVOKE_CHANNELS` 白名单（L418-441）是死代码。所有 `window.electronAPI.*` 方法可调用任意 IPC channel。
- **影响**: 渲染进程可调用任意 IPC channel，包括未在白名单中的（如 `'get-all-settings'`、`'compile-file'`、`'write-file'`、`'open-external'`、`'ide-login-start'` 等）。

### C2. `cmd /c` 命令注入 【已修复】
> 🔧 已修复: commit 671732a — cmd /c 分支禁用 shell 透传并对命令过滤
- **文件**: `src/main.js:4687-4694`
- **问题**: `executablePath` 参数直接来自渲染进程 IPC，以 `cmd /c ` 开头时，`actualCommand` 未经过滤直接传入 `spawn('cmd', ['/c', actualCommand], { shell: true })`。攻击者可注入 `&`、`|`、`||`、`>` 等 shell 元字符。
- **影响**: Windows 上的 OS 级命令注入。

### C3. `webSecurity: false` 禁用同源策略 【已修复】
> 🔧 已修复: commit 8e1d3fc — 5 处 BrowserWindow webSecurity 全改 true；上游 API 实测无 CORS 头，4 处 renderer fetch 改经 fetch-remote-json IPC 由主进程 axios 代理（4 路径白名单 + 15s 超时）
- **文件**: `src/main.js:2375,6790,6824,6864,6895`
- **问题**: 所有 `BrowserWindow` 均设置 `webSecurity: false`，禁用同源策略。渲染进程可跨域请求任何 URL（包括 `file://`）。
- **影响**: 任何渲染进程 XSS 都可读取本地文件或与本地 HTTP 服务器交互。

---

## 🟠 HIGH（高）

### H1. 10+ 个 IPC handler 无路径校验 【已修复】
> 🔧 已修复: commit 542e852 — 16 处 handler 加 assertSafeIoPath 敏感路径校验(系统/凭据/userData 目录, realpath+大小写归一), dialog defaultPath 消毒, validateFileName 拒绝 . 与 ..; 原 settings.workspace 检查因字段不存在实际失效, 一并修复
- **文件**: `src/main.js`
- **涉及 handler**:
  - `save-file` event (L3904): 无路径穿越检查，可覆盖任意文件
  - `rename-file` (L4337): 只验证 newName，不验证 oldPath
  - `move-file` (L4504): 无工作区边界检查，可移动任意文件
  - `paste-file` (L4475): 无工作区约束
  - `delete-file` handle (L5333): 无工作区检查（对比 L4362 的 event 版本有检查）
  - `write-file` handle (L5320): 无路径验证
  - `ensure-dir` (L5309): 可在任意位置创建目录
  - `read-file-buffer` (L4278): 可读取任意文件为 base64
  - `walk-directory` (L4295): 可递归遍历任意目录
  - `open-path` (L5352): 可用系统默认应用打开任意文件
  - `show-open/save-dialog` (L3502): options 对象直接传入，可设 defaultPath 到敏感目录

### H2. `compilerArgs` 未过滤直接传入 spawn 【已修复】
> 🔧 已修复: commit 542e852 — compileFile 经 collectRejectedCompilerArgs 拦截 @响应文件/-include/-specs=/-fplugin=/-plugin/-B 高危参数(取舍: 报告所述 allowlist 会破坏 -I/-D 等合法组合, 实装高危 blocklist)
- **文件**: `src/main.js:7876,7987,8068-8071`
- **问题**: `compilerArgs` 字符串经自定义 `parseArgsPreservingQuotes` 解析后直接传入 `spawn(compilerPath, args, ...)`，无 allowlist 过滤。可注入 `-include /etc/passwd`、`@/etc/shadow` 等任意标志。

### H3. `import-settings` 可注入 `account` 凭据 【已修复】
> 🔧 已修复: commit 671732a — import-settings 删除 account, 合并后恢复 previousAccount
- **文件**: `src/main.js:4549-4573,7621`
- **问题**: 导入的 JSON 文件经 `mergeSettings` 处理，`account` 在 `validKeys` 中，可覆盖登录 token。对比云备份路径（L9460）正确删除了 `account`。
- **影响**: 社会工程攻击可注入伪造登录 token。

### H4. `get-top-level-settings` 暴露 `loginToken` 【已修复】
> 🔧 已修复: commit 671732a — get-top-level-settings 返回前剔除 account
- **文件**: `src/main.js:3432-3434`
- **问题**: 返回整个 `settings` 对象，包括 `settings.account` 中的 `loginToken` 和用户凭据。无过滤或脱敏。

### H5. 本地 HTTP 服务器 CORS 通配符 【已修复】
> 🔧 已修复: commit 671732a — 本机 HTTP 端点新增 isTrustedLocalOrigin/rejectUntrustedOrigin 来源校验
- **文件**: `src/main.js:2806-2814`
- **问题**: SampleTesterAPI (port 20030) 和 CompetitiveCompanion (port 10043) 绑定 `127.0.0.1` 但响应头含 `Access-Control-Allow-Origin: *`。结合 `webSecurity: false`，任何页面可跨域 POST 到这些端点。
- **影响**: 恶意 webview 可向 SampleTester 注入题目数据。

### H6. `executeJavaScript` 中 JSON.stringify 不防注入 【无效】
> ❌ 已证伪: JSON.stringify 产物是合法 JS 字面量，无法逃逸出字符串上下文；模板字符串不会被二次求值。报告所述注入机制不成立。
- **文件**: `src/main.js:5657-5660`
- **问题**: 下载错误消息通过 `JSON.stringify` 传入 `executeJavaScript()`。`JSON.stringify` 不防模板字符串或 `</script>` 模式。恶意服务器可构造 HTTP 响应实现代码执行。

### H7. `save-setting` IPC 接受任意 key 【已修复】
> 🔧 已修复: commit 671732a — save-setting 新增 SETTINGS_WRITABLE_KEYS 白名单
- **文件**: `src/main.js:10150-10159`
- **问题**: `settings[key] = value` 无 key 验证。渲染进程可设置任意 settings key，包括 `compilerPath`、`account` 等。

### H8. `electronIPC.on`/`once` 无 channel 过滤 【已修复】
> 🔧 已修复: commit 2374082 — preload 新增 ALLOWED_EVENT_CHANNELS(35 通道), on/once 拦截非白名单并告警; tests/preload.test.js 断言覆盖
- **文件**: `src/preload.js:680-691`
- **问题**: `electronIPC` 传递任意 channel 给 `ipcRenderer.on`，无过滤。渲染进程可窃听内部 IPC channel（如 `'compare-progress'`、`'terminal-data'`、`'lsp-notification'` 等）。

### H9. markdown-it `html: true` XSS 【已修复】
> 🔧 已修复: commit 2374082 — MarkdownIt html 改为 false, 默认转义内联 HTML
- **文件**: `src/preload.js:239`
- **问题**: `html: true` 使 markdown 中的原始 HTML 标签（`<script>`、`<img onerror=...>`）原样渲染。不信任来源的 markdown 内容可触发 XSS。

### H10. `postMessage("*")` 数据泄漏 【待确认】
- **文件**: `src/renderer/pdf-viewer.html:369`
- **问题**: PDF viewer 用 `postMessage(..., "*")` 向父窗口发送数据，可被任意 origin 接收。

### H11. CSP `frame-src *` 【待确认】
- **文件**: `src/renderer/index.html:7`
- **问题**: Content-Security-Policy 含 `frame-src *`，允许任意网站嵌入此 Electron 应用。结合 `postMessage("*")` 构成数据泄漏向量。

### H12. `folder-picker.js` `process.platform` 空引用 【无效】
> ❌ 已证伪: process 已由 contextBridge 暴露（preload.js:713-720 提供 platform/versions/env），process.platform 可用；仅 env 缺 USERPROFILE/HOME 导致 home 快捷项缺失，属功能降级而非空引用崩溃。
- **文件**: `src/renderer/js/folder-picker.js:41,52`
- **问题**: 在 `contextIsolation: true` 下，`process` 全局不可用。会抛 `ReferenceError: process is not defined`。

### H13. `editor.js` `#cancel-settings` 空引用 【无效】
> ❌ 已证伪: `#cancel-settings` 元素存在于 editor.html:489，getElementById 必非 null，“缺失→TypeError→初始化崩溃”不会发生。
- **文件**: `src/renderer/settings/editor.js:1045`
- **问题**: `document.getElementById('cancel-settings').addEventListener(...)` 无空值检查。元素缺失时抛 `TypeError`，崩溃整个 EditorSettings 初始化。

### H14. `editor.js` parseInt 无 radix 【待确认】
- **文件**: `src/renderer/settings/editor.js:1227,1640-1641`
- **问题**: `parseInt(e.target.value)` 无第二个参数。空输入产生 `NaN`，传播到 Monaco 编辑器破坏渲染。对比 `lineHeight`（L1645）和 `tabSize`（L1656）有 `!Number.isNaN()` 保护。

---

## 🟡 MEDIUM（中）

### M1. LSP `request()` 无超时 【待修复】
- **文件**: `src/main.js:821-831`
- **问题**: clangd 挂起时 pending promise 永不 resolve/reject。`exit` handler 只在进程退出时清理，hang 情况下永远泄漏。

### M2. LSP JSON 解析失败静默丢弃 【待修复】
- **文件**: `src/main.js:869`
- **问题**: `JSON.parse` 失败时 `continue` 跳过，pending map 中对应条目永不清理。长时间运行会累积泄漏。

### M3. `recentExternalOpens` Map 遍历时删除 【无效】
> ❌ 已证伪: 在 Map 迭代回调中执行 delete 是 ECMAScript 规范明确允许（规范要求支持）的行为，并非“违反规范”。
- **文件**: `src/main.js:60-65`
- **问题**: `for...of` 循环中 `Map.delete()` 违反 ECMAScript 规范。V8 当前容忍但不保证。

### M4. `requestSaveAllAndClose` 多次调用累积监听器 【待确认】
- **文件**: `src/main.js:2296-2322`
- **问题**: 每次调用注册新的 `ipcMain.once` 监听器和新 timeout。只第一个会触发，其余成为孤儿。

### M5. `memoryTimer` 在 error 事件未清除 【无效】
> ❌ 已证伪: spawn error 后 Node 仍会派发 close 事件，close 处理器（main.js:4892）会 clearInterval(memoryTimer)，定时器不会泄漏。
- **文件**: `src/main.js:4976-4997`
- **问题**: `childProcess.on('error')` 未清除 `memoryTimer`，泄漏 `setInterval` 轮询已死进程。

### M6. `mergeSettings` 重复定义 【已修复】
> 🔧 已修复: commit 2374082 — 删除首份重复定义, 合并跳过 account 并对 plain object 深合并(G2 WARN 消除)
- **文件**: `src/main.js:7488-7508,7619-7632`
- **问题**: 第一个定义做递归深合并，第二个做浅合并。第二个覆盖第一个。`importSettings` 和 `syncSettingsFromCloud` 使用浅合并版本，丢失嵌套属性。

### M7. `checkDailyUpdate` 死代码 【待确认】
- **文件**: `src/main.js:7431-7478`
- **问题**: `return;` 使后续代码不可达。`isAutoUpdateCheckInProgress` 设为 true 后永不清除，菜单显示"自动检查更新中..."且禁用手动检查按钮。

### M8. Base64 "token" 泄露设备指纹 【待修复】
- **文件**: `src/main.js:9215-9222`
- **问题**: `generateEncodedToken` 是 base64 编码的明文，含用户名、主机名、CPU 型号、OS。作为 `X-OICPP-Token` 头发送，可被网络观察者解码。

### M9. `readJsonBody` 超限后 `res` 未关闭 【待确认】
- **文件**: `src/main.js:2829-2844`
- **问题**: `req.destroy()` 后 `end` 事件不触发，`res` 永不关闭，客户端连接挂起。

### M10. 外部文件队列丢弃并发请求 【待确认】
- **文件**: `src/main.js:9030-9051`
- **问题**: `if (processingExternalOpenQueue) return` 丢弃所有并发调用。新项目入队但无人触发处理。

### M11. ~30 个 `on*` 方法无 cleanup 函数 【待修复】
- **文件**: `src/preload.js:568-663`
- **问题**: 大多数 `on*` 方法返回 `ipcRenderer.on()` 的返回值（IpcRenderer 对象），调用者无法移除监听器。对比 `onExternalFileChange`（L601-606）正确返回 cleanup 函数。

### M12. `removeAllListeners` 杀死所有消费者 【已修复】
> 🔧 已修复: onCompareProgress 已返回 removeListener cleanup（preload.js:557-559），tests/preload.test.js:129-134 有断言覆盖。
- **文件**: `src/preload.js:538-540`
- **问题**: compare 监听器的 cleanup 用 `removeAllListeners` 而非 `removeListener`，一个消费者 cleanup 会破坏所有消费者。

### M13. 图片路径穿越 【待修复】
- **文件**: `src/preload.js:315-325`
- **问题**: `![x](../../etc/passwd)` 经 `path.join` 解析为 `file:///etc/passwd`，无穿越检查。

### M14. turndown fallback `innerHTML` 【待确认】
- **文件**: `src/preload.js:343-345,351-353`
- **问题**: fallback 路径用 `innerHTML` 解析 HTML，可执行内联 `<script>` 和触发 `onload`/`onerror`。

### M15. `shouldRunAfterCompile` 竞态 【待修复】
- **文件**: `src/renderer/js/compile-manager.js:579-586`
- **问题**: `compileCurrentFile()` 成功但 `handleCompileResult` 未调用时标志残留为 true。

### M16. `window.resize` 监听器泄漏 【已修复】
> 🔧 已修复: commit af28a71 — resize 监听改具名 _onWindowResize 并在重建前移除
- **文件**: `src/renderer/js/compile-manager.js:153-157`
- **问题**: 每次重建输出窗口添加新的匿名 resize 监听器，旧的从不移除。

### M17. `setCloudPanelVisible` 忽略参数 【待修复】
- **文件**: `src/renderer/js/sidebar.js:523-524`
- **问题**: `visible` 参数被 `const show = false` 完全丢弃。

### M18. `quick-open.js` 异步竞态 【无效】
> ❌ 已证伪: quick-open.js:172-178 是“按键→await ensureIndex→open”的正常预期流程，所述竞态与代码结构不符。
- **文件**: `src/renderer/js/quick-open.js:172-178`
- **问题**: `ensureIndex()` 异步，用户关闭后 `resolve` 触发 `open()` 意外重开。

### M19. `compile-output.js` keydown 全局监听器泄漏 【已修复】
> 🔧 已修复: commit af28a71 — keydown 监听存 _onGlobalKeydown, show/hide 配对增删
- **文件**: `src/renderer/js/compile-output.js:44-50`
- **问题**: `document.addEventListener('keydown', ...)` 无对应移除。

### M20. `dialog.js` overlay 监听器累积 【已修复】
> 🔧 已修复: commit af28a71 — overlay keydown 先 remove 再 add
- **文件**: `src/renderer/js/dialog.js:114-116`
- **问题**: 每次 `showInputDialog()` 添加新的 keydown 监听器到同一 overlay 节点。

### M21. `browser-manager.js` IPC 监听器泄漏 【已修复】
> 🔧 已修复: commit af28a71 — destroy() 接上已存储的 _removeOpenNewTabListener
- **文件**: `src/renderer/js/browser-manager.js:48-52`
- **问题**: `_removeOpenNewTabListener` 存储了但从未用于清理。

### M22. `sampleTester.js` setInterval 泄漏 【待确认】
- **文件**: `src/renderer/js/sidebar/sampleTester.js:244`
- **问题**: `setupEditorChangeListener` 在构造函数调用，`deactivate()` 不清除 interval。

### M23. `init.js` 未 await `initializeApp()` 【待修复】
- **文件**: `src/renderer/js/init.js:12`
- **问题**: `initializeApp()` 是 async 但未 await。`setTimeout` 在 350ms 后运行，不管初始化是否完成。

### M24. `dialog.js` 双重 resolve 【无效】
> ❌ 已证伪: Promise 二次 resolve 是无害 no-op，消费者只收到第一次的值。
- **文件**: `src/renderer/js/dialog.js:321-332`
- **问题**: `hideDialog` 总是 resolve `pending.resolve(null)`，即使已被 `confirmDialog` resolve 过。

### M25. `tabs.js` PDF 监听器泄漏 【待修复】
- **文件**: `src/renderer/js/tabs.js:31-32`
- **问题**: 构造函数添加 `window.addEventListener('message', ...)` 从不移除。

### M26. `terminal-panel.js` keydown/wheel 监听器泄漏 【已修复】
> 🔧 已修复: commit af28a71 — keydown/wheel 改具名 onKeyShield/onWheelShield, closeTerminal 时按 capture 匹配移除
- **文件**: `src/renderer/js/terminal-panel.js:478,538`
- **问题**: 终端关闭时 `keydown` 和 `wheel` 监听器未移除。

### M27. `currentProc` 共享竞态 【待确认】
- **文件**: `src/main-process/compare-worker-v6.js:18,27,28,108`
- **问题**: 模块级 `currentProc` 被多次 `spawnProcess` 覆盖，`stop` 消息只杀最新进程。

### M28. GDB `_cmdQueue` 退出后未 reject 【待修复】
- **文件**: `src/gdb-debugger.js:116-121`
- **问题**: GDB 进程退出时未清空命令队列，等待中的 promise 永不 resolve/reject，UI 挂起。

### M29. HTTP 响应体未 destroy 【待确认】
- **文件**: `src/utils/multi-thread-downloader.js:66-88,92-100`
- **问题**: `checkRangeSupport` 和 `getFileSize` 中 `.body` 流未读取或 destroy，TCP socket 泄漏。

### M30. `writer.write` after `end` 【已修复】
> 🔧 已修复: 取消在 data 回调内同步 end+reject（multi-thread-downloader.js:310-315），tests/downloader.test.js 有覆盖；未复现 TOCTOU 窗口。
- **文件**: `src/utils/multi-thread-downloader.js:308-314`
- **问题**: `isCancelled` 检查与 `writer.write()` 之间有 TOCTOU 竞态，可触发 `ERR_STREAM_WRITE_AFTER_END`。

### M31. GDB 队列死锁 【待修复】
- **文件**: `src/gdb-debugger.js:62-63`
- **问题**: GDB 静默崩溃时 `_parseOutput` 永不执行，`_queueBusy` 永远为 true，队列永久卡住。

### M32. compare-engine-v2 双重终止 【无效】
> ❌ 已证伪: compare-engine-v2.js 的 stop() 中 setTimeout 闭包捕获 stop 时刻的 workers 快照（147-155），不会终止新 start() 创建的 worker。
- **文件**: `src/main-process/compare-engine-v2.js:140-156`
- **问题**: `stop()` 的 2 秒 setTimeout 可能终止新 `start()` 的 worker。

### M33. `parseGDBWatchValueRecursive` 畸形输入无限循环 【待修复】
> ✅ 已证实（报告机制有误）: 实测输入 `{, a = hello b = 5}` 使 parseGDBWatchValueRecursive 死循环（gdb-utils.js L401 `position = tokenRealEnd` 被 L283-292 反向逗号回溯写回 entry 之前，形成周期循环）；getNextToken 所有成功路径均前进，报告所述“getNextToken 返回未前进 position”机制不成立。
- **文件**: `src/gdb-utils.js:207-403`
- **问题**: `getNextToken` 返回未前进的 position 时 `while(true)` 死循环。

### M34. PID TOCTOU 【待修复】
- **文件**: `src/terminal-manager.js:797-858`
- **问题**: PID 复用后读取新进程的 `/proc/PID/fd`，返回错误 TTY。

### M35. disposeAll race 【待确认】
- **文件**: `src/terminal-manager.js:503-509`
- **问题**: `close` 事件处理器在 `disposeAll` 完成后仍发送消息到已销毁的 renderer。

### M36. logger `_flush` buffer 增长 【待修复】
- **文件**: `src/utils/logger.js:24-36`
- **问题**: `init()` 失败后 buffer 仅在 >5000 行时截断一半，持续失败时无限增长。

### M37. Stray `*/` CSS 语法错误 【已修复】
> 🔧 已修复: commit 2374082 — 删除孤立 */
- **文件**: `src/renderer/css/monaco-editor.css:82`
- **问题**: 孤立的 `*/` 无匹配 `/*`，CSS 解析错误可能影响后续规则。

### M38. Settings HTML 缺少 CSP 【无效】
> ❌ 已证伪: 四个 settings/*.html 均含 Content-Security-Policy meta 标签（grep -l 全命中）。
- **文件**: `settings/compiler.html`, `editor.html`, `templates.html`, `backup.html`
- **问题**: 无 `<meta http-equiv="Content-Security-Policy">` 标签，独立窗口无 CSP 保护。

### M39. `compiler.js` innerHTML XSS 【已修复】
> 🔧 已修复: commit 2374082 — name/version/platform/download_url/error.message(两处) 全部 escapeHtml
- **文件**: `src/renderer/settings/compiler.js:484-499`
- **问题**: 远程 API 返回的 `compiler.name/version/platform/download_url` 未经转义直接注入 `innerHTML`。

### M40. `compiler.js` Python 浏览显示错误消息 【已修复】
> 🔧 已修复: commit 2374082 — 改用专用 key compiler.pythonPathSaved(en/zh-cn)
- **文件**: `src/renderer/settings/compiler.js:347`
- **问题**: `browsePythonInterpreter` 显示 "testlib path saved" 而非 Python 相关消息。

### M41. `compiler.js` Python 路径不持久化 【已修复】
> 🔧 已修复: commit 2374082 — browsePythonInterpreter 成功分支调用 saveSetting 持久化 pythonInterpreterPath
- **文件**: `src/renderer/settings/compiler.js:340-348`
- **问题**: `browsePythonInterpreter` 只更新 UI，不调用 `saveSetting()`。

### M42. `compiler.js` 并发 fetch 无防抖 【已修复】
> 🔧 已修复: commit 1ef212a — 列表加载入口 abort 旧请求, 防并发覆盖
- **文件**: `src/renderer/settings/compiler.js:437,1164`
- **问题**: `showInstallDialog` 无防抖，快速点击触发并发请求。

### M43. `compiler.js` fetch 无超时 【已修复】
> 🔧 已修复: commit 1ef212a — AbortController 15 秒超时, 超时提示可重试
- **文件**: `src/renderer/settings/compiler.js:444,1171`
- **问题**: 无 `AbortController`，服务器无响应时 UI 永久挂起。

### M44. `settings-init.js` 字体验证反馈循环 【待修复】
- **文件**: `src/renderer/js/settings-init.js:80-89`
- **问题**: 字体修正触发 `updateSettings` → `settings-changed` → `applySettingsToUI` → 再次验证，循环 2 次。

### M45. `editor.js` opacity bypass Cancel 【待修复】
- **文件**: `src/renderer/settings/editor.js:1128-1133`
- **问题**: opacity 变更立即 `updateSettings`，用户点 Cancel 也无法撤销。

### M46. `monaco-editor-manager.js` LSP 重启后文档状态不一致 【待确认】
- **文件**: `src/renderer/js/monaco-editor-manager.js:366-371,410-415`
- **问题**: `_finishStartup` 异常时 `_lspReadyPromise` 设为 null 但文档可能部分打开。

### M47. `installer.nsi` 删除全局 .cpp 关联 【待修复】
- **文件**: `installer.nsi:450-451`
- **问题**: 卸载器删除整个 `.cpp` 注册表键，可能删除其他程序设置的关联。

### M48. `installer.nsi` 路径含空格提权失败 【无效】
> ❌ 已证伪: installer.nsi:154 实为 `ExecShell "runas" "$EXEFILE" "$R0"`，$EXEFILE 已加引号。
- **文件**: `installer.nsi:154`
- **问题**: `$EXEFILE` 未加引号，路径含空格时 `ExecShell "runas"` 失败。

### M49. `settings/compiler.js` `saveSettings` 遗漏 `testlibPath` 【无效】
> ❌ 已证伪: updateSettings（main.js:7654-7667）按键部分合并、不删除未传入的键，testlibPath 不会被丢弃。
- **文件**: `src/renderer/settings/compiler.js:542-547`
- **问题**: `newSettings` 对象不含 `testlibPath`，主保存按钮点击时丢失。

### M50. `settings/compiler.js` 重复事件监听器 【待修复】
- **文件**: `src/renderer/settings/compiler.js:142-150,255-261`
- **问题**: `close-install-dialog` 按钮绑定两次 click 事件。

---

## 🔵 LOW（低）

### L1. 死代码 — `debugProcess`/`debugSession` 【待修复】
- **文件**: `src/main.js:1963-1964`
- **问题**: 声明但从未使用。

### L2. `checkForUpdates` 不可达代码 【待修复】
- **文件**: `src/main.js:6919-7003`
- **问题**: `return;` 使所有后续代码不可达。

### L3. `ideLoginServer` race 条件 【无效】
> ❌ 已证伪: 与 M24 同因，Promise 二次 resolve 为无害 no-op。
- **文件**: `src/main.js:1183-1200`
- **问题**: error 事件与 listen 回调竞态，可能导致 double-resolve。

### L4. `compile-output.js` keydown 泄漏 【已修复】
> 🔧 已修复: commit af28a71 — 同 M19 修复(报告内部重复条目)
- **文件**: `src/renderer/js/compile-output.js:44-50`
- **问题**: `document.addEventListener('keydown', ...)` 无对应移除。

### L5. `sidebar.js` mouse 监听器泄漏 【已修复】
> 🔧 已修复: commit af28a71 — resize 的 mousemove/mouseup 改具名 function, mouseup 即移除
- **文件**: `src/renderer/js/sidebar.js:127-168`
- **问题**: `document.addEventListener('mousemove/mouseup')` 从不清理。

### L6. `monaco-editor.css` 重复 `:root` 【待确认】
- **文件**: `src/renderer/css/monaco-editor.css:1-18,557-583`
- **问题**: 两个 `:root` 块定义相同变量，第一个是死代码。

### L7. `sidebar.css` 重复 `min-width` 【待修复】
- **文件**: `src/renderer/css/sidebar.css:109,113`
- **问题**: `min-width: 200px` 被 `min-width: 0` 覆盖，前者是死代码。

### L8. `templates.html` textarea 样式泄漏 【待修复】
- **文件**: `src/renderer/settings/templates.html:60-69`
- **问题**: `.message-toast.warning` 含 textarea 属性（`resize: vertical`、monospace 字体）。

### L9. `templates.html` 死代码 【待修复】
- **文件**: `src/renderer/settings/templates.html:310-321`
- **问题**: 查询 `.settings-tabs .tab-btn`，但 HTML 用 `.sidebar-item`，永远无匹配。

### L10. 英文翻译含中文 【待修复】
- **文件**: `src/lang/en.json:789`
- **问题**: `compileOutput.analysisEmpty` 值是中文而非英文。

### L11. zh-cn.json 缺少 `tabs` 章节 【无效】
> ❌ 已证伪: zh-cn.json:1061 已存在 tabs 章节。
- **文件**: `src/lang/zh-cn.json`
- **问题**: 英文文件有 `tabs` 章节（8 个 key），中文文件完全缺失。

### L12. 终端 i18n key 缺失 【无效】
> ❌ 已证伪: 三个 key 均存在（en.json 404/407/408，zh-cn.json 387/390/391）。
- **文件**: `terminal-panel.js:309-310`
- **问题**: `terminal.unicodeAddonMissing`、`terminal.unicodeAddonDetail`、`terminal.tabLabel` 在两个 JSON 文件中均不存在。

### L13. 硬编码中文（12 处） 【无效】
> ❌ 已证伪: terminal-panel.js 全文硬编码中文扫描 0 命中（原 12 处已 i18n 化）。
- **文件**: `src/renderer/js/terminal-panel.js`
- **行号**: 135,136,285,286,297,298,390,410,1048-1050,1103,1111

### L14. 硬编码中文（10 处） 【无效】
> ❌ 已证伪: tabs.js 硬编码中文扫描 0 命中（报告所列行号处已是 i18n 调用）。
- **文件**: `src/renderer/js/tabs.js`
- **行号**: 1812,1818,1820,1822,1826-1831,1838,1899,1939

### L15. `lang/index.js` `reload()` 无效 【待修复】
- **文件**: `src/lang/index.js:29-31`
- **问题**: 资源静态加载，`reloadResources()` 什么都不做。

### L16. `ci-check.js` 正则尾部匹配假阴性 【待修复】
- **文件**: `scripts/ci-check.js:160`
- **问题**: `/oicpp\.ico[^-]/` 不匹配文件末尾的 `oicpp.ico`。

### L17. `ci-check.js` 秘密扫描用 warn 【待修复】
- **文件**: `scripts/ci-check.js:474,489,494`
- **问题**: 标题说 "FAIL" 但用 `warn()` 而非 `fail()`。

### L18. `ci-check.js` IPC 一致性子串匹配 【无效】
> ❌ 已证伪: 当前 ci-check.js E1 用 Set.has/includes 精确匹配（500-545），无双向子串匹配。
- **文件**: `scripts/ci-check.js:338`
- **问题**: 双向子串匹配产生误报。

### L19. `download-clangd.js` 重定向无深度限制 【待修复】
- **文件**: `scripts/download-clangd.js:110`
- **问题**: 重定向用 `retriesLeft` 参数，重定向循环会耗尽重试次数。

### L20. `generate-build-info.js` author.name 【无效】
> ❌ 已证伪: package.json:5 author 是对象格式，author.name 合法。
- **文件**: `scripts/generate-build-info.js:54`
- **问题**: `packageJson.author.name` 假设 author 是对象格式。

### L21. `package.json` sharp 重复 【待修复】
- **文件**: `package.json:34,56`
- **问题**: `sharp` 同时在 `dependencies` 和 `devDependencies`。

### L22. `package.json` 两个 markdown-it-katex 【待修复】
- **文件**: `package.json:41,50`
- **问题**: `@iktakahiro/markdown-it-katex` 和 `markdown-it-katex` 同时安装，后者未使用。

### L23. `pnpm-workspace.yaml` 无效配置 【无效】
> ❌ 已证伪: pnpm 二进制内置 allowBuilds 官方文案（strings 命中 18 处）；实测 `pnpm install --lockfile-only` 对 totallyBogusKey 告警而对 allowBuilds 不告警，该键被识别、未被静默忽略（实测 pnpm 12.5.1，项目标注 11.7.0）。
- **文件**: `pnpm-workspace.yaml:1-5`
- **问题**: `allowBuilds` 不是 pnpm 有效配置键，文件被静默忽略。

### L24. `compare-worker-v6.js` null `.equals()` 崩溃 【无效】
> ❌ 已证伪: output 为 null 的路径（exit -1/-3）已被 timeout/error 的前置 continue 拦截，到达 output.equals 时 _collect() 必为 Buffer。
- **文件**: `src/main-process/compare-worker-v6.js:67,161`
- **问题**: 进程退出码 0 但 `_collect()` 返回 null 时 `output.equals()` 崩溃。

### L25. `settings/editor.js` catch 块缺少 fontLigaturesEnabled 【待修复】
- **文件**: `src/renderer/settings/editor.js:1512-1539`
- **问题**: catch 默认设置缺少 `fontLigaturesEnabled`。

### L26. `settings-init.js` 任意 100ms 延迟 【待修复】
- **文件**: `src/renderer/js/settings-init.js:5`
- **问题**: `await new Promise(resolve => setTimeout(resolve, 100))` 导致可见闪烁。

### L27. `settings/compiler.js` 递归 browseCompiler 【待修复】
- **文件**: `src/renderer/settings/compiler.js:400-402`
- **问题**: 取消时递归调用自身，应用循环替代。

### L28. `settings/compiler.js` setTestlibPath 无空检查 【待修复】
- **文件**: `src/renderer/settings/compiler.js:1365`
- **问题**: `document.getElementById('testlib-path').value` 无空检查。

### L29. toast 重叠 【已修复】
> 🔧 已修复: commit af28a71 — backup/editor/compiler showMessage 开头移除既有 toast(对齐 templates.js)
- **文件**: `settings/backup.js:260-301`, `compiler.js:857-905`, `editor.js:2061-2109`
- **问题**: `showMessage` 不移除之前的 toast，快速操作时重叠。对比 `templates.js:510` 正确移除。

### L30. `cloudSync.js` 混用硬编码中文和 i18n 【待修复】
- **文件**: `src/renderer/js/sidebar/cloudSync.js:825,835,895,1054`
- **问题**: 部分消息硬编码中文，部分用 `window.i18n.t()`。

### L31. `Buffer` 暴露给 renderer 【待修复】
- **文件**: `src/preload.js:703`
- **问题**: `contextBridge.exposeInMainWorld('Buffer', Buffer)` 扩大攻击面。

### L32. `main.js` renderer `showMessage` 未定义 【无效】
> ❌ 已证伪: showMessage 已在 main.js:3954 定义，58 处调用正常。
- **文件**: `src/renderer/js/main.js:181,188,275,402,413,433`
- **问题**: `OICPPApp` 类未定义 `showMessage()`，每次调用抛 TypeError。

### L33. `folder-picker.js` process.platform 【无效】
> ❌ 已证伪: 与 H12 重复；process 已由 contextBridge 暴露，不会抛 ReferenceError。
- **文件**: `src/renderer/js/folder-picker.js:41,52`
- **问题**: contextIsolation 下 `process` 全局不可用。

---

## 按模块统计

| 模块 | Bug 数 | 关键问题 |
|------|--------|----------|
| `main.js` | ~45 | 命令注入、路径穿越、凭据泄漏、资源泄漏 |
| `preload.js` | ~10 | 白名单失效、XSS、监听器泄漏 |
| `renderer/*.js` | ~25 | 竞态条件、DOM 空引用、监听器泄漏 |
| `settings/*.js` | ~15 | XSS、设置丢失、NaN 崩溃 |
| `gdb/terminal/compare` | ~10 | 进程泄漏、队列挂起、null 崩溃 |
| `scripts` | ~7 | 正则误报、重定向循环 |
| `html/css/i18n` | ~15 | CSP 缺失、XSS、翻译缺失 |
| `config` | ~5 | 依赖混乱、无效配置 |

---

## 状态汇总（判定于 2026-09-22）

> 基于 commit 49ffb81（git pull fast-forward 22eb1de→49ffb81，无冲突）全量复核 100 条，全部完成初判并纳入三态跟踪。

| 状态 | 数量 | ID |
|------|------|----|
| 🔴 待修复 | 36 | L1, L2, L7, L8, L9, L10, L15, L16, L17, L19, L21, L22, L25, L26, L27, L28, L30, L31, M1, M2, M8, M11, M13, M15, M17, M23, M25, M28, M31, M33, M34, M36, M44, M45, M47, M50 |
| 🟡 待确认 | 15 | C1, H10, H11, H14, L6, M4, M7, M9, M10, M14, M22, M27, M29, M35, M46 |
| ❌ 无效（已证伪，理由见各条目下引用块，不计入三态） | 22 | H6, H12, H13, L3, L11, L12, L13, L14, L18, L20, L23, L24, L32, L33, M3, M5, M18, M24, M32, M38, M48, M49 |
| ✅ 已修复（最新代码/回归测试已覆盖，批次1-6 见各条引用块） | 27 | C2, C3, H1, H2, H3, H4, H5, H7, H8, H9, L4, L5, L29, M6, M12, M16, M19, M20, M21, M26, M30, M37, M39, M40, M41, M42, M43 |

备注：
- L4=M19、L33=H12 为报告内部重复条目。
- 部分文件行号已因本次 pull 漂移（ci-check.js、en.json、preload.js、index.html、monaco-editor-manager.js、tabs.js、terminal-manager.js、logger.js、multi-thread-downloader.js），以现文件为准。
- M33 动态复现：种子 `{, a = hello b = 5}` 必现死循环；L15/L23 于 2026-09-22 完成源码与运行时实证。
- 验证方式：源码逐条取证 + 针对性动态测试（fuzz / 实测 pnpm 行为）。
