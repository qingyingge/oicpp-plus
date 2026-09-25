# LSP 测试与完成度审计

> 审计基线：`b09d579`（`origin/main`）
> 审计日期：2026-09-25
> 范围：最近 13 个 LSP 提交及其 main/preload/renderer 链路
> 协作约束：另一台开发机正在继续扩展 LSP；本审计不把“已注册 provider”视为“已完成”，也不在本阶段重写 LSP 实现。

## 结论

当前 LSP 更准确的状态是：**协议接入和功能面已大幅展开，测试覆盖和失败路径仍不完整**。

最近 13 个 LSP 提交中，只有最初的 `65c1744` 增加了 `tests/lsp.test.js`；后续 provider 和修复提交没有新增测试文件。现有测试主要覆盖纯转换函数和 renderer 侧取消，不覆盖主进程请求生命周期、真实 clangd、跨文件编辑和重启恢复。

## 模块状态

| 模块 | 状态 | 已有内容 | 未闭环内容 |
|---|---|---|---|
| LSP bridge / capability | partial | initialize、能力查询、renderer request ID、取消转发 | 主进程 request timeout、pending 清理、失败后重试、协议级测试 |
| Semantic tokens | partial | delta 转换和基础测试 | provider 生命周期、真实 clangd 增量测试 |
| Inlay hints | partial | provider 注册、resolve 判断 | 取消、超时、空/异常响应测试 |
| Selection range | partial | LSP → Monaco 转换 | 嵌套/异常 range 集成测试 |
| Range formatting | partial | provider 注册 | 取消、失败回滚、dirty model 测试 |
| Document links | partial | link/resolve provider | 打开文件、URI 编码、失效链接测试 |
| CodeLens | partial | resolve、command 注册/执行 | command 失败、超时、权限边界测试 |
| WorkspaceEdit | partial | `changes` / `documentChanges` 转换 | 未打开文件、version 冲突、部分失败报告 |
| Rename | partial | F2 路径和本地 fallback | 重复 prepare/rename、单一入口、i18n、跨文件测试 |
| Crash recovery | missing/partial | main 退出时 reject pending | renderer 状态失效、自动恢复、文档重新同步 |
| Provider lifecycle | missing/partial | `_lspProviders` 去重注册 | dispose、重启后清理、旧 provider 失效 |
| Preload LSP events | partial | lsp request/cancel/notify bridge | `onLspNotification` / `onLspApplyEdit` 返回可清理 listener |

## 重点审计发现

### 1. 主进程请求可能永久挂起

`src/main.js:832-841` 将请求放入 `pending` 后没有 request 级 timeout；`cancel()`（`844-856`）只发送 `$/cancelRequest`，没有删除或 reject 本地 pending。JSON 解析失败路径（`889-896`）也会静默丢弃消息。

另外，`LspClientBridge.start()`（`src/renderer/js/lsp-client.js:52-57`）会保存失败的 `_readyPromise`；如果失败后没有显式 `restart()`，后续 `start()` 可能重复返回同一个 rejected promise。

需要测试：正常响应、服务端错误、取消、超时、非法帧、clangd 退出，以及启动失败后的重试。

### 2. WorkspaceEdit 只覆盖已打开 model

`src/renderer/js/monaco-editor-manager.js:1566-1595` 通过 `findModelByLspUri()` 查找现有 model，找不到就跳过。`versionId` 虽然在转换层保留，但应用时没有冲突校验。

需要测试：单文件、多文件、未打开文件、同文件多个 edit、版本不匹配和部分失败。

### 3. Rename 存在两条重叠路径

`renameIdentifierAtCursor()`（`6677-6767`）已经直接执行 prepare/rename；失败后又进入 `renameViaLsp()`（`6769-6804`），最后才本地替换。对话框和错误提示仍有硬编码中文。

需要先确定唯一入口和 fallback 语义，再写行为测试。

### 4. Provider 没有完整生命周期

`registerAllLspProviders()` 用 `_lspProvidersReady` 防止重复注册，但当前没有统一的 dispose/reset 路径。clangd 重启或 renderer 重建时，旧 provider 是否失效需要验证。

### 5. 现有测试覆盖范围有限

`tests/lsp.test.js` 当前覆盖：

- Location/LocationLink 转换；
- WorkspaceEdit 基础转换；
- semantic token delta；
- server capability lookup；
- renderer 侧取消。

尚未覆盖真实协议握手、provider 行为、WorkspaceEdit 应用和重启恢复。

## 本次已补充的审计基线

为避免与另一台开发机的 LSP 实现修改冲突，本次没有改动 LSP 源码，只新增独立测试：

- `tests/lsp-audit.test.js`：纯转换契约、renderer request ID、取消、诊断通知、applyEdit 回执和 listener 清理；
- `tests/lsp-main-audit.test.js`：从当前 `main.js` 提取 `ClangdLspManager`，验证 fake process 启动、pending、JSON-RPC 写入、分片/多帧解析、WorkspaceEdit 回执、响应、错误、取消和 stop 清理；
- `pnpm run ci:tests`：5/5 测试文件通过。

主进程 fake-process 测试目前仍不能验证 request timeout、异常帧和 clangd crash/restart；这些被保留为下一阶段测试目标，而不是用当前测试假装覆盖。

完整 `pnpm run ci` 的静态部分没有发现本次新增文件导致的失败；当前工作区的完整 CI 被一个被 `.gitignore` 忽略的生成目录 `build/icons/png` 阻断（A3 检查要求该目录不存在），不是 LSP 测试失败。

## 测试分层

### 第一层：纯函数契约

- URI、range、LocationLink；
- `changes` / `documentChanges`；
- semantic token delta；
- 参数和异常输入。

### 第二层：renderer bridge

- request ID 单调递增；
- cancellation token 生命周期；
- listener dispose；
- diagnostics/applyEdit 通知；
- capability fallback。

### 第三层：fake clangd

使用可控的 fake child process 或协议 fixture 验证：

- initialize/initialized；
- 正常请求与错误响应；
- cancel；
- timeout；
- malformed frame；
- process crash/restart。

### 第四层：Monaco 集成

- provider 注册与 capability gate；
- WorkspaceEdit 应用；
- rename；
- CodeLens command；
- provider dispose/restart。

## 当前审计约束

在另一台开发机继续改 LSP 实现期间，本文件只作为基线和测试清单；不要通过修改本审计中的行号或状态来掩盖实现变化。每次新 LSP 提交应同时补充至少一个对应层级的测试。
