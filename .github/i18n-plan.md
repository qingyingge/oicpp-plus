# i18n 完善计划

> 👉 所有计划和进度在 [GitHub Project Board](https://github.com/qingyingge/oicpp-plus/projects) 跟踪

## 状态：渲染层迁移已完成（2026-10-15）

原先项目里**并存两套 i18n**：主进程 `src/lang/index.js` 用 i18next，渲染层
`src/renderer/js/i18n.js` 是自研 `I18nManager`。这源于 `c5d088d`
（refactor(i18n): 集成 i18next）只重写了主进程，渲染层那份被漏掉。

现已统一，渲染层只是 i18next 的薄适配层。

### 已完成

| 提交 | 内容 |
|------|------|
| `8ef26ae` | `index.html` 引入 i18next UMD（`node_modules/i18next/dist/umd/i18next.min.js`） |
| `dca567c` | `t()` 委托 i18next，删手写 `_getNested` / 插值 / `_fallbackMessages`；删 `window.__` 与死 API |
| `a8b6765` | 修 `lowerCaseLng`（语言码大小写不一致导致界面全是裸 key）；`t()` 对 undefined 降级成 key |
| `586620a` | 清 `compiler.js` 漏 await、`folder-picker._t`、6 处三参别名 |
| `dfba681` | 修启动时渲染层语言与 settings 不同步（en 设置下界面显示中文） |
| `26f7ef1` | 补齐 5 个设置窗口的 i18next UMD（`8ef26ae` 引入的回归） |
| `8142b1a` | AGENTS.md 行号/基线校正 |

### 设计取舍：什么仍是手写的

保留在 `src/renderer/js/i18n.js`：

- **`_applyToDOM()`** —— `data-i18n` / `-placeholder` / `-title` / `-aria-label` /
  `-args` 与 `<html lang>` 是本项目特有契约，i18next 的 DOM 绑定不覆盖；
  且有 4 处外部调用（`settings-init.js` 等）
- **`enableAutoTranslate()`** —— MutationObserver，同上
- **`onChange()`** —— `i18next.on()` 的返回值是 object，不能当 unsubscribe 用

迁移只换「查表 + 插值 + 语言切换」内核，不动 DOM 应用层，所以 1100+ 处调用点零改动。

### 资源加载

语言包 JSON 形状**同时就是** i18next 的 translation bundle。渲染层经 IPC
`get-language-file` 拿原始 JSON，`addResourceBundle(code,'translation',data)` 灌入，
因此**主进程与 IPC 无需任何改动**。改语言包时别改文件形状。

### 遗留

- I7 孤儿键 baseline 202，存量待清（每清一批降一档，`scripts/ci-check.js:984`）
- `t() || 兜底` 形式的兜底恒不触发（缺键时 `t()` 返回 key 本身，非空 truthy），
  存量调用点可逐步收敛为直接 `t()`