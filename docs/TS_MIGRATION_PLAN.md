# TypeScript迁移方案（4 AI agent 并行编排）

> 状态：**方案已定，待排期**。所有数字为实测值，测量方法见附录A。
> 适用版本：1.5.4 · 测量基准commit `6ac0ba1`

---

## 0. 结论摘要

| 结论 | 依据 |
|---|---|
| **不做全量 `.ts` 重写** | 固定成本 8–11 人天只买到"工具链"，不做任何业务代码类型化 |
| **拆分与迁移必须串行，且顺序不可颠倒** | 拆分要先于TS（拆出的段需要独立文件才能表达 `import`） |
| **拆分的并行上限 = 4，且只有一种并行方式可行** | 实测：只有「纯新增文件」型分支能零冲突；「从主文件删除」型分支在段相邻时必冲突 |
| **关键路径 = A4 测试改造 → 拆分 → G1 闸门 → 冷段TS 化** | 约 10–13 人天，加并发也压不动 |
| **`src/main.js` 本轮不做** | 11522 行 / 15 个测试读它源码 / 26.6 人天，4 并发下是负价值 |

---

## 1. 基线数据（实测）

### 1.1 代码规模

| 层 | 行数 | 文件数 |
|---|---:|---:|
| `src/main.js` | 11522 | 1 |
| `src/renderer/js/monaco-editor-manager.js` | 9076 | 1 |
| `src/renderer/js/tabs.js` | 5572 | 1 |
| `src/renderer/js/main.js` | 4547 | 1 |
| `src/renderer/js/sidebar/sampleTester.js` | 3798 | 1 |
| 其余 renderer（js + sidebar + settings + formatters + ui） | ~20.7k | 27 |
| `src/preload.js` | 966 | 1 |
| `src/utils/` | 2018 | 8 |
| `src/main-process/` | 480 | 2 |
| gdb / terminal / clang-format 服务 | 2682 | 6 |
| **src 小计** | **59109** | **48** |
| `scripts/` | 2374 | 10 |
| `tests/` | 6642 | 36 |

### 1.2 开发速率

| 指标 | 值 |
|---|---|
| 项目龄期 | 418 天 |
| 总提交 | 702 |
| 近 90 天提交 | 397 |
| 近 30 天提交 | 314（约 10/天） |
| 近 90 天活跃者 | qingyingge 266 + mywwzh 131（+76 bot） |
| **近 90 天 src churn** | **82858 行变动（+46434 / −36424）** |

> **重要修正**：初版分析称 churn 为 1.40x/季度，源于两个事故恢复提交被计入：
> `ce90668` "修复了编辑器核心文件被错误覆盖的 bug"（+6908 行）、
> `a92e11a` "编辑器核心文件缺失导致功能异常的 bug"（+4118 行）。
> 剔除后 **src 整体 churn = 0.75x**，`monaco-editor-manager.js` = **2.16x**。
>
> 全代码库并未"每季度重写一遍"，而是**少数文件在高频重写，其余在稳定演化**。

### 1.3 关键文件 churn（剔除事故提交后）

| 文件 | LOC | churn/行 | 等价重写周期 |
|---|---:|---:|---:|
| monaco-editor-manager.js | 9076 | 2.16 | 42 天 |
| browser-manager.js | 643 | 1.57 | 57 天 |
| compare-worker-v6.js | 275 | 1.49 | 60 天 |
| **tabs.js** | 5572 | **0.56** | 161 天 |
| **sampleTester.js** | 3798 | **0.64** | 141 天 |
| **main.js** | 11522 | **0.43** | 208 天 |
| settings/editor.js | 2145 | 0.20 | 448 天 |
| gdb-utils.js | 597 | 0.00 | — |
| cppFormatter.js | 542 | 0.02 | — |

### 1.4 验证周期（AI agent 的货币单位）

| 命令 | 实测耗时 |
|---|---:|
| `tsc --noEmit` 全量 src | **4.2 s** |
| `tsc --noEmit` 单目录 | 0.9 s |
| `pnpm run ci:tests`（35 个测试） | **31 s** |
| `pnpm run ci`（53 项检查） | **38 s** |

反馈周期 40 秒 → **工作包应按报错簇切（最小 8 条、最大 280 条），而不是按人天打包**。

### 1.5 TypeScript 报错量

配置：`tsc --noEmit --allowJs --checkJs --skipLibCheck --moduleResolution bundler`

| 配置 | 报错数 |
|---|---:|
| 裸 checkJs | **9593** |
| + 一份 15 行 `global.d.ts` | **4911**（−49%） |
| + `--strict false` | **863** |

> 9593 → 4911 的落差全部来自"缺声明"而非"缺类型"。
> 863 条中 637 条是 `TS2339`，集中在 4 个 DOM 收窄模式：
> `.value` on `HTMLElement`（152）、`.style` on `Element`（72）、
> `.checked` on `HTMLElement`（39）、`.value`/`.dataset`/`.closest` on `EventTarget`（78）。
>
> **另有存量类型缺陷被顺带发现**：`Token.prototype.extractString`（17 处）、
> `Token.prototype.trim`（4 处）是挂在原型上的动态方法；`Error.code`（18 处）、
> `ChildProcess._result`/`_collectors`（10 处）是鸭子类型。

---

## 2. 约束分析：4 并发的三个硬约束

### 2.1 反馈快 → 粒度要细

40 秒闭环意味着 agent 可以"改一处跑一次"，不需要攒批。

### 2.2 关键路径是串行的，加并发压不动

```
A1 tsconfig → A4 测试改造 → 拆分 → G1 闸门 → 冷段 TS 化
        约 10–13 人天，无论 4 个还是 40 个 agent
```

### 2.3 并行上限由测试共享决定

用 `readFileSync` 路径分析 35 个测试对源码的依赖，得到强约束组：

```
共享测试文件 → 必须同一个 agent / 同一个 PR
  src/main.js                    ← 15 个测试   🔴 最热冲突面
  src/settings/compiler.js + src/main.js      ← 3 个测试
  src/preload.js + compile-manager.js         ← 2 个测试
  src/settings/editor.js + tabs.js            ← 2 个测试
  src/lang/index.js + sampleTester.js + sidebar.js
  src/compare-engine-v2.js + cloudSync.js
  monaco-editor-manager.js       ← 2 个测试
```

**27 个文件与任何其他文件零冲突** —— 这是可以完全并行撒出去的部分。

---

## 3. 拆分可行性实测（关键章节）

对 `monaco-editor-manager.js`（9076 行 / 234 方法）做分支并行合并实验。

### 3.1 分段结构

按主题将文件切成 18 个段：

| 段 | 行数 | 方法 | 自包含度 | churn/行 | 外部转发点 |
|---|---:|---:|---:|---:|---:|
| lsp-providers | 2450 | 57 | 83% | **2.64** | 34 |
| include-resolution | 931 | 27 | 89% | 0.01 | 12 |
| groups+open | 859 | 8 | 8% | 0.21 | 7 |
| theme+colors | 697 | 18 | **100%** | 0.20 | 12 |
| settings-apply | 603 | 15 | 51% | 0.49 | 9 |
| cpp-parser | 634 | 22 | **98%** | 0.05 | 2 |
| tab-ops+diff | 438 | 14 | 54% | 0.07 | 17 |
| diag+markers | 424 | 14 | 83% | 0.21 | 5 |
| keybindings | 400 | 14 | 81% | 0.10 | 19 |
| selection-guard | 267 | 7 | 44% | 0.00 | 4 |
| clipboard+fmt | 251 | 6 | 75% | 0.29 | 7 |
| completion | 309 | 7 | 55% | 0.03 | 4 |
| editor-lifecycle | 337 | 2 | 6% | 0.09 | 0 |
| rename | 126 | 1 | 0% | 0.02 | 0 |
| semantic-hl | 106 | 2 | 0% | 0.26 | 6 |
| breakpoints | 106 | 1 | — | 0.78 | 1 |
| open-at-pos | 69 | 1 | 20% | 0.00 | 1 |
| legacy（死代码） | 65 | 2 | — | 0.00 | 0 |

> **段边界口径**：上表按「方法声明行的归属」切分，边界落在方法之间。
> 特别注意 `getCurrentContent`（5384-5395）虽与 `breakpoints` 段行号相邻，
> 但**属于活代码** —— 被 `renderer/js/main.js:2249` 与
> `sidebar/sampleTester.js:2767` 通过 `editorManager.getCurrentContent()` 调用，
> **不得随 breakpoints 段一起删除**。

### 3.2 实测结果

| 实验 | 分支策略 | 结果 |
|---|---|---|
| **E1** | 4 分支，各删 1 段（theme+colors / breakpoints / legacy / cpp-parser），间隔 1000–1994 行 | ✅ **4/4 零冲突**，行数 9076→7574 精确守恒 |
| **E2** | 4 分支，各删 1 段（include-resolution / diag+markers / keybindings / tab-ops+diff） | ❌ S8 冲突 1 块 |
| **E3** | 3 分支贪心着色分组 | ❌ 5 个冲突块 |
| **E4** | 2 分支交替奇偶分组 | ❌ 6 个冲突块 |
| **E5** | 4 分支**只新增文件**，主文件不动 | ✅ **4/4 零冲突**，18 个文件全部落地 |

> E1 的行数守恒（9076−697−106−65−634 = 7574）证明**行数层面**无冲突。
> 但 E5 的方法数检查暴露了另一类问题：区间边界会把边界方法一并带走（见附录 B）。
> **行数守恒 ≠ 方法守恒**，两者必须分别校验。

### 3.3 冲突机制（已完全定位）

E2 冲突块原文：

```
<<<<<<< HEAD
            const workspaceName = workspaceRoot ? this.getFileNameFromPath(workspaceRoot) : 'workspace';
            const { compilerPath, compilerArgs } = await window.monacoInclude.getCompilerSettingsSnapshot();
=======
            const workspaceName = workspaceRoot ? window.monacoTabs.getFileNameFromPath(workspaceRoot) : 'workspace';
            const { compilerPath, compilerArgs } = await this.getCompilerSettingsSnapshot();
>>>>>>> S8
```

**根因**：第 389 行与第 390 行相邻。S5（include-resolution）改写第 390 行的
`this.getCompilerSettingsSnapshot()`，S8（tab-ops+diff）改写第 389 行的
`this.getFileNameFromPath()`。git把两条相邻行的改动合成同一个冲突块。

进一步定位发现更强的约束：**18 个段在文件中首尾相接，两两间隔均为 0**。
任何两个段分配到不同分支时，它们的删除边界直接相接，git 缺少锚定行，
必然冲突。

**规律**：

| 分支类型 | 可行性 |
|---|---|
| 分支只**新增**文件，主文件不动 | ✅ 任意数量并行，零冲突 |
| 分支从主文件**删除**一个段，且与其它分支的段**间隔 ≥ ~1000 行** | ✅ 可行 |
| 分支从主文件**删除**一个段，且与其它分支的段**相邻或近邻（<100 行）** | ❌ 必冲突 |

### 3.4 方案

采用「**两阶段拆分**」：把并行放在安全的一侧。

```
阶段 S1（4 路并行，零冲突）：agent 各自【新增】拆出文件
     每路只写自己的新文件，主文件完全不动
        ↓  顺序 merge，每步 32s 验证
阶段 S2（1 路，单 agent）：从主文件删除 17 个活段 + legacy 死代码
     + 改写外部转发点 + 新文件挂到 index.html
```

S1 的产物是纯新增文件，可 4 路并行；S2 是唯一有冲突风险的操作，单点执行。
**拆分总工期从「4 路并行但互相冲突反复 abort」变成「4 路并行准备 + 1 次集成」。**

> **S2 的边界纪律**：段边界必须落在方法声明行之间。
> `getCurrentContent`（5384-5395）虽与 `breakpoints` 段行号相邻，
> 但**属于活代码** —— `renderer/js/main.js:2249` 与
> `sidebar/sampleTester.js:2767` 通过 `editorManager.getCurrentContent()` 调用，
> **严禁随段删除**。S2 验收必须包含「方法数守恒」检查（§7），
> 差值与计划移出数不符即驳回。

---

## 4. 节点定义（DAG）

### L0 — 引导（4 路并行）

| ID | 任务 | 人天 | 产出 / 验收 |
|---|---|---:|---|
| **A1** | `tsconfig.json`（`allowJs`+`checkJs`+`noEmit`+`strict:false`）+ 装 `@types/node`、`@types/electron` | 2 | `tsc --noEmit` 可跑 |
| **A2** | `src/types/global.d.ts`（~15 行：`logInfo/logWarn/logError/monaco/require` + `Window` 上 15 个全局） | 0.5 | **报错 9593 → 4911（−49%）** |
| **A3** | `src/types/preload.d.ts`：131 个 `electronAPI.*` 方法 + 153 个 IPC channel 签名 | 2–3 | 渲染层 709 处 `electronAPI.*` 调用有类型 |
| **A4** | 测试去路径硬编码（9 处→ 标记搜索），拆 4 个并行子任务 | 1.5–2 | 拆文件后测试不ENOENT |

**A4 的 4 个并行子任务**：

| 子任务 | 位置 | 备注 |
|---|---|---|
| A4-1 | `cpp-highlight-color-slots.test.js` 的 `methodBody()` 提取器 | 最脆：正则按 `^\s{4}method(` 定位 + `eval` |
| A4-2 | `cpp-highlight-rules/e2e.test.js` + `clang-format.test.js` | 3 处同模式 |
| A4-3 | `lsp-{completion-command,diagnostics-uri,provider-registration,main-audit}.test.js` | 4 处同模式 |
| A4-4 | `ci-check.js` 4 处硬编码文件列表改glob | D1/D8/BOM/selector |

> **A4 与 TS 无关也该做** —— 它是现存 CI 脆弱点。两个"文件被覆盖"事故能通过 CI，
> 就是这些文本断言的盲区。

### L1 — 依赖 L0

| ID | 任务 | 人天 | 依赖 | 验收 |
|---|---|---:|---|---|
| **N1–N4** | 叶子层 TS 化：27 个**零测试依赖**文件（13969 LOC / 1101 报错） | 32/4 = **8.0** | A2, A4 | 各文件 `tsc` 零报错 |
| **N5–N8** | 温/冷叶子：15 个有测试依赖文件（14176 LOC / 1531 报错） | 33.6/4 = **8.3** | A2, A4 | 同上 |
| **N9** | 删死代码：`monaco-editor-manager.js:9012-9076` 的 `parseFunctions` / `parseStructsAndClasses` / `removeComments` | 0.5 | — | 减 65 行 |

> **N9 的死代码判定依据**（已实测）：
> `parseFunctions` 与 `parseStructsAndClasses` 在**全仓库零调用点**
> （`grep -rn` 仅命中自身定义行 9012 / 9037）；
> `removeComments` 的 2 处调用（9014 / 9039）**都在这两个死方法内部**，
> 因此整段 9012-9076 可整体删除，不影响任何活代码。
> LSP 改造后 `completion` 已改走 `parseFunctionsWithLocations`（6821 行）。

**N1–N4 的 4 包划分**（LPT 均衡，每包报错数 245–304）：

| 包 | 文件数 | LOC | 报错 |
|---|---:|---:|---:|
| PKG-1 | 4 | 3688 | 304 |
| PKG-2 | 3 | 3458 | 251 |
| PKG-3 | 9 | 3378 | 245 |
| PKG-4 | 11 | 3445 | 301 |

**N5–N8 的强约束组**（共享测试文件，不能拆给不同 agent）：

```
G1: gdb-mi-debugger + compare-worker-v6 + init + settings-init
    + multi-thread-downloader + process-supervisor← security-regression
G2: lang/index + sidebar + sampleTester(3798行)                     ← bug-report
G3: compare-engine-v2 + cloudSync                                  ← audit-fixes
G4: preload + compile-manager + compiler(1570行)← audit-fixes + security
G5: settings/editor(2145行)                                        ← security + bug-report
```

### L2 — 拆分（两阶段）

| ID | 任务 | 并发 | 依赖 | 验收 |
|---|---|---:|---|---|
| **S1a–S1d** | 阶段 S1：**新增** 18 个拆出文件（每 agent 4–5 个） | **4** | N9 | `node -c` 全通过 |
| **S2** | 阶段 S2：主文件删除 17 个活段 + 删 legacy 死代码 + 改写外部转发点 + `index.html` 加 `<script>` | **1** | S1 | `ci:tests` 35/35 |
| **🚦 G1** | 复测 `churn/行` | 人工 | S2 | 判据见下 |

**G1 判据**：

```
churn/行 ≤ 0.2  → 放行，执行 N10
churn/行 > 0.5   → 停止，重评，不执行 N10
```

> 依据：热段 `lsp-providers` 实测 2.64，冷段实测 0.01–0.21。
> 拆分后若 churn 未降到 ≤0.2，说明改动量并未真正隔离，N10 的前提不成立。

### L3 — 仅在 G1 放行后

| ID | 任务 | 并发 | 人天 |
|---|---|---:|---:|
| **N10** | 冷段 TS 化：拆分后 monaco 其余 ~6600 行 + 18 个新文件 | **4** | 12–16 |

---

## 5. 4-agent 排期

| 天 | AG-1 | AG-2 | AG-3 | AG-4 |
|---|---|---|---|---|
| **D1** | A1 tsconfig + @types | A2 global.d.ts | A3 preload.d.ts | A4-1 测试改造 ★ |
| **D2** | A4-2/3 支援 | A4-4 ci-check glob | A3 收尾 | A4-1 收尾 |
| **D3** | A4 收尾 ★关键路径 | 读 monaco 设计拆分 | PKG-1 | PKG-2 |
| **D4** | PKG-1 续 | PKG-3 | PKG-4 | **S1a** 新增拆出文件 |
| **D5–D11** | PKG-1 (8.0d) | PKG-3 | PKG-4 | PKG-2 |
| **D6–D12** | ↓ | PKG-5 | PKG-6 | **S1b** 新增拆出文件 |
| **D8–D14** | PKG-7 | PKG-8 | **S1c** | **S1d** |
| **D13** | 合并 S1a→S1b→S1c→S1d（每步 32s 验证） | | | |
| **D14** | **S2** 单开：主文件删除 + 转发改写 + index.html | | | |
| **D15** | 🚦 **G1 闸门** | | | |
| **D16–D19** | N10 冷段 TS 化 ×4 并发 | | | |

**关键路径**：`A4(2d) → S1(2d) → S2(1d) → G1(0.5d) → N10(3-4d)` ≈ **19 天**
（叶子层 N1–N8 在关键路径外并行吃掉）

---

## 6. 收益曲线

| 完成到 | LOC 覆盖 | strict 报错解决 | 累计人天 | 日历 |
|---|---:|---|---:|---:|
| A1+A2 | 0% | **49%** | 2.5 | D1 |
| +A4（4 路） | 0% | 49% + CI 可持续 | 4.5 | D2 |
| +N1–N4 | **24%** | 71% | 36 | D11 |
| +N5–N8 | **48%** | 100%（除三巨头） | 70 | D14 |
| +S1+S2+G1 | 48% | — | 79 | D15 |
| **+N10** | **80%** | 100% | 92–96 | **D19** |

---

## 7. 明确不做

| 项 | 人天 | 理由 |
|---|---:|---|
| `lsp-providers` 段 TS 化 | ~14 | churn **2.64/行**，全项目最热。拆出去正是为了让它留在 JS |
| `src/main.js` TS 化 | 26.6 | 11522 行 / 15 个测试读它源码。4 并发下占满一槽 6–7 天，负价值。列为此后候选 |
| `tabs.js` / `sampleTester.js` / `renderer/main.js` TS 化 | ~31 | 0.45–0.64x，churn 可接受但成本高。N10 后按需再排 |
| 引入 esbuild / webpack | 10–15 | 拆出的新文件仍可用 `<script>` + `window.X` 挂载。全局单例架构短期不改 |
| `tsc` 产出运行时 JS | 5–8 | 只做 `noEmit` 类型检查。改 31 个 script 标签 + monaco AMD 加载 + CSP，风险大于收益 |
| 删除型分支并行拆分 | — | 实测必冲突（§3.3）。改为「新增并行 + 单点集成」 |

---

## 8. 护栏（写进每个 agent 的 prompt）

| 护栏 | 原因 |
|---|---|
| 每个 agent **独占一个 worktree + 一个文件** | 渲染层 52 处 `window.X =` 是隐式全局，两 agent 改同一文件必冲突 |
| **禁止改 `<script>` 标签顺序和 HTML**（S2 阶段除外） | 31 个标签的执行顺序就是依赖图 |
| **禁止 `this.t` / `window.__` / 改 `module.exports` 形态** | 已有 AGENTS.md 禁令，破坏 `preload.test.js` 的 IPC 白名单断言 |
| **禁止 `innerHTML` 注入类型收窄** | I8 baseline 0，改动会触发 CJK ratchet |
| 每 agent 只跑 `tsc --noEmit <自己的文件>` + `ci:tests` | 全量 `tsc` 仅 4.2s，不必省 |
| **`src/main.js` 全程冻结** | 15 个测试读它文本，并发改动会与 N5–N8 产生测试串扰 |
| S2 阶段**主文件由单 agent 独占 worktree** | 删除型操作是唯一有冲突风险的动作 |
| S2 阶段**段边界必须落在方法声明行之间** | `getCurrentContent`（5384）行号贴着 `breakpoints` 段尾，但被 `renderer/main.js:2249` 与 `sampleTester.js:2767` 调用，属活代码 |
| 每次 merge 后必跑 `node -c` + `ci:tests` | 32s 闭环，不设闸门等于没验证 |

---

## 9. 拆分阶段的验证协议

| 检查 | 命令 | 判据 |
|---|---|---|
| 语法 | `node -c <file>` | exit 0（**每个拆出文件都要单独跑**） |
| 方法数守恒 | `grep -cE "^    (async \|static \|get \|set )*[a-zA-Z_#][a-zA-Z0-9_]*\("` 合并前后对比 | 差值 = 移出方法数；**不符即驳回** |
| 行数守恒 | `wc -l` | 差值 = 移出行数 |
| 回归 | `pnpm run ci:tests` | 35/35 PASS |
| 零逻辑变更 | `git diff -M --stat main..<branch>` | 相似度 ≥95% |

`git diff -M`（rename detection）能自动识别"这段代码被移走了"。
相似度低说明 agent 顺手改了逻辑，必须驳回。

**方法数守恒是唯一能拦住"误删活代码"的闸门。** E5 实验里曾出现
「计划移出 64 个方法、实际移出 72 个」的偏差 —— 多出的 8 个全部是
**段边界溢出**（方法落在被删区间的尾巴上被一并带走）。
`getCurrentContent` 就是这类边界方法，且它**有外部调用者**，
误删会让 `renderer/main.js:2249` 在运行时抛 `TypeError`。
因此：

- S2 的每一步删除都必须记录「预期移出方法数」
- 合并后立刻比对实际值，**多一个都不能放过**
- 删除区间的起止行必须逐个方法核对归属，不能只按区间边界切

---

## 附录 A：测量方法

```bash
# 1. 类型报错量
tsc --noEmit --allowJs --checkJs --skipLibCheck --strict false \
    --target es2022 --module esnext --moduleResolution bundler \
    --lib es2022,dom,dom.iterable src/**/*.js

# 2. 剔除事故提交后的 churn
git log --since="90 days ago" --numstat --format='C %H' -- src
# 排除 87e1deb0f2d2 / ce90668fd4eb（整文件还原，+6908/+4118 行）

# 3. 段间调用图与 SCC
#   按 this.method() 建图，Tarjan 求强连通分量
#   结果：15 个段（8204 行）构成单个 SCC，不可独立摘出

# 4. 分支并行合并冲突实验
git clone --no-hardlinks . /tmp/mtest
# 每个分支：① 删除自己那段 ② 改写该段的外部 this.X 调用点
git merge --no-edit <branch>   # 观察 CONFLICT
```

---

## 附录 B：实测冲突数据

**段间隔**（前一 end → 后一 start）：18 个段两两间隔**全部为 0**（首尾相接）。

**冲突实验矩阵**：

| 实验 | 分支 | 段间隔 | 结果 |
|---|---|---|---|
| E1 | 4 删+转发 | 1000 / 1789 / 1994 | ✅ 零冲突，行数精确守恒 |
| E2 | 4 删+转发 | 0（相邻） | ❌ 1 冲突块 |
| E3 | 3 贪心着色 | 混合 | ❌ 5 冲突块 |
| E4 | 2 奇偶交替 | 0 | ❌ 6 冲突块 |
| E5 | 4 **纯新增** | N/A | ✅ 零冲突，18 文件全部落地 |

**E5 的重要副产物 —— 方法数偏差**：

```
base1 方法数 188 → 合并后 116
计划移出       64 个（22+14+14+14）
实际移出       72 个          ← 多出 8个
```

多出的 8 个全部是**段边界溢出** —— 方法声明行落在被删区间的尾巴上被一并带走：

| 被误删的方法 | 真实归属 | 外部调用者 |
|---|---|---|
| `getCurrentContent` | breakpoints / tab-ops+diff 边界 | **`renderer/main.js:2249`、`sampleTester.js:2767`** |
| `getCurrentEditor` | groups+open / diag+markers 边界 | — |
| `getDefaultKeybindings` | semantic-hl / keybindings 边界 | — |
| `getIncludedFilePaths` | cpp-parser / include-resolution 边界 | — |

**教训**：段边界不能只按行号区间切，必须逐方法核对归属。
`getCurrentContent` 有真实外部调用者，误删会在运行时抛 `TypeError`，
而 **`node -c` 与 `git merge` 都发现不了** —— 只有方法数守恒检查能拦住。

**E2 冲突原文**：

```
<<<<<<< HEAD
            const workspaceName = workspaceRoot ? this.getFileNameFromPath(workspaceRoot) : 'workspace';
            const { compilerPath, compilerArgs } = await window.monacoInclude.getCompilerSettingsSnapshot();
=======
            const workspaceName = workspaceRoot ? window.monacoTabs.getFileNameFromPath(workspaceRoot) : 'workspace';
            const { compilerPath, compilerArgs } = await this.getCompilerSettingsSnapshot();
>>>>>>> S8
```
