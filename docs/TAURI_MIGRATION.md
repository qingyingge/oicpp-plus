# Electron → Tauri 迁移工作量分析

> 分析基线：`tauri-test` 分支 @ 49ffb81（2026-09-23）

## 一、现状盘点

| 模块 | 规模 | 迁移难度 |
|------|------|----------|
| `src/main.js`（Electron 主进程） | 11,239 行 | ★★★★★ 核心工作量 |
| `src/preload.js` | 751 行，**152 个 IPC 通道**，暴露 8 类全局 API | ★★★★ |
| `src/renderer/js/`（渲染层） | 39,619 行，15 个文件引用 electron（main.js 145 处、monaco-editor-manager 55 处、tabs 52 处） | ★★★ 大部分可保留 |
| `src/main-process/`（对拍引擎） | compare-engine-v2 + worker | ★★★ Node worker → Rust 或 sidecar |
| `src-tauri/`（spike 已存在） | 脚手架 + S2 库兼容性测试页 | 已验证 WebKitGTK 下 Monaco/xterm/pdfjs 可加载 |

### 渲染层依赖的全局 API（preload 暴露）

`electronAPI`（约 120+ 方法）、`electronIPC`（ipcRenderer 包装）、`electron`（shell/ipcRenderer）、`getElectronModule`、`process`、`Buffer`、`logInfo/logWarn/logError`、`markdownAPI`、`turndownAPI`。

### 主进程硬依赖（19 处 child_process.spawn）

- **node-pty**（终端）→ Rust 侧 `portable-pty`（tauri-plugin-shell 内置基础）
- **node-gyp 原生编译**（fastspawn.cc）→ 直接 Rust 化，反而是收益点
- **winreg**（Windows 注册表：右键菜单/文件关联）→ `winreg` crate 或 `windows` crate
- **7zip-bin**（spawn 7za）→ 保留 spawn 或换 `sevenz-rust`
- clangd / 编译器 / gdb spawn → Rust `std::process::Command` / `tokio::process`
- dialog / clipboard / shell / Menu / BrowserWindow / webContents（108 处）→ Tauri 窗口 API、原生菜单、插件

## 二、分阶段工作量估算

### P0 Spike 验证（已完成约 80%）
- ✅ src-tauri 脚手架、WebKitGTK 编译环境、S2 库兼容测试页
- ⏳ 实测项：Monaco Web Worker、xterm + PTY 吞吐、pdfjs、KaTeX 字体、拖拽、自定义标题栏
- **估时：3–5 人日**

### P1 Rust 后端骨架（IPC 门面）
- 统一 `invoke` 分发层，先做透明代理：Tauri command → Node sidecar（`tauri-plugin-shell` 子进程跑现有 main-process JS），保证功能不丢
- 窗口管理：自定义标题栏（`decorations: false`）、单实例、关闭拦截
- **估时：8–12 人日**

### P2 IPC 通道逐域迁移（152 通道，主体工作）
按域拆批，每批 = Rust command + renderer 适配 + 回归测试：

| 域 | 通道数（约） | 估时 |
|----|------------|------|
| 文件 IO / dialog / 临时文件 / 文件历史 | ~30 | 6 人日 |
| 编译运行 / 对拍 / 测评（spawn 链 + 编码 iconv） | ~30 | 10 人日 |
| 终端（node-pty → portable-pty） | ~10 | 5 人日 |
| 设置 / 云同步 / 更新器 / 安装包 | ~25 | 6 人日 |
| 浏览器 tab（webview 多标签 → Tauri WebviewWindow/Webview） | ~10 | 5 人日 |
| LSP(clangd) / GDB 调试 | ~15 | 6 人日 |
| 菜单 / 快捷键 / 剪贴板 / 注册表 / 其他 | ~32 | 7 人日 |

**小计：约 45 人日**

### P3 renderer 适配层
- `electron-helper.js` 改造为 Tauri `invoke`/`event` 门面，保留 `window.electronAPI` 同名签名，避免 4 万行大改
- 15 个 electron 引用文件逐个切换；`Buffer` polyfill；菜单事件 → Tauri event
- **估时：10–15 人日**

### P4 CI / 打包 / 回归
- ci-check.js 增加 Rust 检查（`cargo clippy`）、src-tauri 感知
- electron-builder → tauri bundler（nsi/deb/AppImage），clangd 预下载脚本改造
- tests/ 回归套件扩展 Tauri 侧用例
- **估时：8–10 人日**

### P5 清理
- 移除 electron 依赖、node-gyp、electron-builder；文档更新
- **估时：2–3 人日**

## 三、总计与风险

**总计约 76–90 人日**（1 人全职约 4 个月；关键路径是 P2 的 spawn/PTY/编码链）。

主要风险：
1. **WebKitGTK 兼容性**：Monaco 0.56 在 WebKit 的 Web Worker/字体渲染需实测（S2 套件已铺好）
2. **node-pty 流式吞吐**：跨语言 IPC 带宽是终端体验瓶颈，需要 chunk 批量化
3. **Windows 专有能力**：winreg、consolepauser、tasklist 等需在 Windows 实机验证（当前环境仅 Linux）
4. **对拍引擎**：worker 线程模型差异大，建议先 sidecar 保功能、后期再 Rust 重写提速
5. **pdfjs 6.x**：依赖较新 JS 特性，WebKitGTK 版本要盯紧

## 四、结论

可行，但属于**月级工程**。推荐路线：sidecar 先行（P1 保功能）→ 通道逐域 Rust 化（P2）→ renderer 薄适配（P3），全程保持双栈可运行、每域可回归。

## 五、附：第三方库选型调研（2026-09-24）

### 各阶段可用轮子

| 阶段 | 需求 | 推荐轮子 | 版本状态 | 结论 |
|------|------|----------|----------|------|
| P1/P2 | 子进程 spawn（编译器/gdb/7za） | `tauri-plugin-shell` | v2.3.6（2026-08）✅ 活跃 | 官方插件，内置 `encoding_rs`/`shared_child`/tokio 异步流，JS 侧有 `@tauri-apps/plugin-shell` 绑定 |
| P2 | 终端 PTY | `portable-pty`（wezterm 出品） | ⚠️ 0.9.0（2025-02）；spike 现用 0.8.1 | 该领域事实标准、无替代品；0.9 相对 0.8 有 breaking change（nix 0.28），建议 spike 验证后升级 |
| P2 | Windows 注册表 | `winreg` crate | v0.56.0（2026-03）✅ 活跃 | 支持 REG_* 类型映射/事务/serde 序列化，文件关联、右键菜单场景直接覆盖 |
| P2 | 7z 解压 | `sevenz-rust` | v0.6.1（2024-07）偏冷 | 纯 Rust，LZMA/LZMA2/AES256/多线程解压可用；**建议保留 spawn 7za 为默认路线**，此库作备选 |
| P2 | iconv-lite 替代 | `encoding_rs`（WHATWG 标准 Rust 实现） | 成熟（Firefox 同源） | 完整支持 GBK/GB18030/Big5，OJ 输出乱码的正解；tauri-plugin-shell 已内置 |
| P2 | 更新器 | 官方 `updater` 插件 | v2 主线 ✅ | 比原估成熟，设置/更新域工作量可下调 |
| P1/P2 | 单实例/对话框/剪贴板/全局快捷键/自启/通知 | `tauri-apps/plugins-workspace` v2 官方插件全家桶 | ✅ | 全部免自研 |

### 调研发现的坑

1. **Tauri 3 已在路上**：`tauri-plugin-shell` 已发 3.0.0-alpha（2026-09-21）。锁 v2 没问题，但 P1/P3 的 IPC 门面必须把插件 API 封装在一层之后，禁止 `@tauri-apps/plugin-*` 直接散进渲染层。
2. **官方插件不含 PTY**：shell 插件只能 spawn+pipe，无伪终端语义（行编辑/信号），终端域 `portable-pty` 是必选，事件批量化仍要自研。
3. **winreg 版本线分裂**：存在 0.56.x 与 0.16.x 两条并行发布线（同一作者，0.16 为旧 windows-sys 兼容线）；配新版 `windows-sys` 选 `0.56`。

### 对工作量估算的修正

- P2「编译运行/编码」域：iconv 迁移可视为 `encoding_rs` 的 drop-in 接入，非从零实现，**该域取估时下限**。
- P2「设置/更新器」域：官方 updater/single-instance 等成熟，**该域取估时下限**。
- P2「终端」域维持原估：portable-pty 无捷径，chunk 批量化、resize、进程树清理均为自有工作。
