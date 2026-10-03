# TypeScript 迁移方案（4 AI agent 并行编排）

> 状态：**方案已定，待排期**。
> 适用版本：1.5.4 · 测量基准 commit `6ac0ba1`
> 行数口径：`sum(1 for _ in open(f))`，末尾无换行的文件计为完整行（故与 `wc -l` 差 5）
>
> **数字性质说明**（避免误用）：
> - **计数类**（行数、文件数、报错数、提交数、churn、测试读取数）= 实测，测量方法见附录 A
> - **人天与日历天** = 估算模型输出，模型局限见 §7 末与 §5.3 的警告框。
>   系数是反推拟合的，**不应作为排期承诺**。

---

## 0. 结论摘要

| 结论 | 依据 |
|---|---|
| **先只做路线甲**（`tsconfig` + `global.d.ts`，零源码改动） | 2.5 人天 / 2 天拿到 −49% 报错，且不触碰任何 agent 耦合 |
| **不做全量 `.ts` 重写** | 固定成本只买到「工具链」，不做任何业务代码类型化 |
| **路线乙可延后** | 收益 863 条报错，代价是 33.6 人天**完全串行**的耦合链 |
| **拆分与迁移必须串行，顺序不可颠倒** | 拆出的段需要独立文件才能表达 `import` |
| **拆分的并行只有「纯新增文件」一种方式可行** | 实测：删除型分支在段相邻时必冲突 |
| **瓶颈是 16 个「有测试依赖」文件构成的单一连通分量** | 经 `compiler.js` 传递相连（§2.2），33.6 人天不可并行 |
| **`src/main.js` 本轮不做** | 11522 行 / 15 个测试读它源码 |

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
| 其余 renderer（js + sidebar + settings + formatters + ui） | 18414 | 25 |
| `src/preload.js` | 966 | 1 |
| `src/utils/` | 2021 | 8 |
| `src/main-process/` | 480 | 2 |
| `src/lang/` + gdb / terminal / clang-format 服务 | 2713 | 7 |
| **src 合计** | **59109** | **48** |
| `scripts/` | 2374 | 10 |
| `tests/` | 6642 | 36 |

> 逐行求和 = 59109，与合计一致。`wc -l` 口径为 59104，差 5 来自末尾无换行的文件。

### 1.2 开发速率

| 指标 | 值 |
|---|---|
| 项目龄期 | 418 天 |
| 总提交（基准 `6ac0ba1`） | 702 |
| 近 90 天提交 | 397 |
| 近 30 天提交 | 314（约 10/天） |
| 近 90 天活跃者 | qingyingge 266 + mywwzh 131 |
| `copilot-swe-agent` 累计 | 76，**全部发生在 90 天之前，近 90 天内为 0** |
| **近 90 天 src churn（原始）** | **51513 行（0.87x）** |
| **近 90 天 src churn（剔除事故）** | **40482 行（0.68x）** |

> **重要修正 —— 还原提交清单此前漏了一个。**
> `src` 下近 90 天有**三个**整文件还原提交，全部为 2026-08-13：
>
> | commit | parent | 消息 | +行 |
> |---|---|---|---:|
> | `ce90668fd4eb` | `5840d615` | 修复了编辑器核心文件被错误覆盖的 bug | 6908 |
> | `87e1deb0f2d2` | `fe57bac8` | 修复了编辑器核心文件被错误覆盖的 bug | 6908 |
> | `a92e11a04841` | — | 修复了编辑器核心文件缺失导致功能异常的 bug | 4118 |
>
> `ce90668` 与 `87e1deb` 是 parent 不同的**两个独立提交**（同消息、同行数），此前只排除了这两个，
> `a92e11a` 的 +4118 一直被计入。三个都排除后：
> src 整体 **1.40x → 0.87x → 0.68x**，
> `monaco-editor-manager.js` **5.40x → 2.92x → 1.70x**（等价重写周期 17 天 → 42 天 → **53 天**）。
>
> 全代码库并未「每季度重写一遍」，而是少数文件高频重写、其余稳定演化。

### 1.3 关键文件 churn（剔除三个还原提交后）

| 文件 | LOC | 原始 churn/行 | 剔除后 | 等价重写周期 |
|---|---:|---:|---:|---:|
| monaco-editor-manager.js | 9076 | 2.92 | **1.70** | 53 天 |
| browser-manager.js | 643 | 1.57 | 1.57 | 57 天 |
| compare-worker-v6.js | 275 | 1.49 | 1.49 | 61 天 |
| **tabs.js** | 5572 | 0.56 | **0.56** | 161 天 |
| **sampleTester.js** | 3798 | 0.64 | **0.64** | 141 天 |
| **main.js** | 11522 | 0.43 | **0.43** | 208 天 |
| settings/editor.js | 2145 | 0.20 | 0.20 | 448 天 |
| terminal-panel.js | 1178 | 0.15 | 0.15 | 599 天 |
| cppFormatter.js | 542 | 0.02 | 0.02 | — |
| gdb-utils.js | 597 | 0.00 | 0.00 | — |

### 1.4 验证周期（AI agent 的货币单位）

| 命令 | 实测耗时 |
|---|---:|
| `tsc --noEmit` 全量 src | **4.2 s** |
| `tsc --noEmit` 单目录 | 0.9 s |
| `pnpm run ci:tests`（35 个测试） | **31 s** |
| `pnpm run ci`（53 项检查） | **38 s** |

### 1.5 TypeScript 报错量

配置：`tsc --noEmit --allowJs --checkJs --skipLibCheck --strict false --moduleResolution bundler`

| 配置 | 报错数 |
|---|---:|
| 裸 checkJs | **9593** |
| + 一份 15 行 `global.d.ts` | **4911**（−49%） |
| + `--strict false` | **863** |

> **测量前提**：`node_modules` 下**无任何 `@types`**（`@types/node`、`@types/electron` 均未安装）。
> 9593 / 4911 / 863 全部在该状态下测得。A1 要求装 `@types/node` 后基线会漂移
> （`process` / `__dirname` / `Buffer` 等约 400 条 `TS2304` 会消失，
> 但 `Buffer` 的严格类型可能新增报错），**方向与幅度均未实测**。
> 因此「−49%」应视为**下限估计**。
>
> 863 条中 637 条为 `TS2339`。按类型分组：
>
> | 模式 | 条数 | 占 637 |
> |---|---:|---:|
> | `.value` on `HTMLElement` | 152 | 24% |
> | `.style` on `Element` | 72 | 11% |
> | `.value`/`.dataset`/`.closest` on `EventTarget`/`Element` | 78 | 12% |
> | `.checked` on `HTMLElement` | 39 | 6% |
> | **DOM 收窄小计** | **341** | **54%** |
> | 其余非 DOM（`Token.prototype.*`、`Error.code`、`ChildProcess._*` 等） | 296 | 46% |
>
> 后者含**存量类型缺陷**：`Token.prototype.extractString`（17 处）、
> `Token.prototype.trim`（4 处）是挂在原型上的动态方法，TS 不可见；
> `Error.code`（18 处）、`ChildProcess._result`/`_collectors`（10 处）是鸭子类型。

---

## 2. 约束分析：4 并发的三个硬约束

### 2.1 反馈快 → 粒度要细

40 秒闭环意味着 agent 可以「改一处跑一次」。

### 2.2 并行上限由测试共享决定 —— 且必须取传递闭包

35 个测试中有 32 个用 `readFileSync` 读源码做文本断言。

**耦合规则**：若存在测试 T 同时读取源码文件 X 与 Y，则修改 X 的 agent 与修改 Y 的
agent 都要改 T（或至少都要验证 T）→ 必须在同一个 agent / 同一个分支内串行完成。

按此规则对 16 个「有测试依赖」文件求**连通分量**（并查集）：

```
security-regression.test.js 读 14 个 → 11 个候选进入分量
audit-fixes-2026-10-01.test.js 读  6 个 → cloudSync, compare-engine-v2 并入
bug-report.test.js 读  7 个          → sidebar, sampleTester, lang/index 并入
                    ↑
        compiler.js 被上述三个测试同时读取 —— 它就是把所有文件串起来的桥

结果：16 个文件全部落在【同一个连通分量】
```

```
分量 1：16 文件 / 14179 LOC / 33.6 人天
  sampleTester  editor  compiler  compile-manager  cloudSync  preload
  multi-thread-downloader  gdb-mi-debugger  sidebar  compare-worker-v6
  settings-init  compare-engine-v2  init  process-supervisor
  lang/index  gdb-debugger
```

> **有效并行度 = 1，合计 33.6 人天全部串行。**
>
> ⚠️ 此前版本按「是否被 `security-regression` 读取」一刀切，得出「11 耦合 + 5 自由」
> 是**错的** —— 漏掉了经 `compiler.js` 的传递链接。
> 判断 agent 可并行性时**必须取传递闭包**，不能只看单个测试的覆盖集合。

### 2.3 关键路径是串行的

瓶颈不是并发度不足，而是 §2.2 那条 33.6 人天的串行链。完整模型见 §5.3。

---

## 3. 拆分可行性实测（关键章节）

对 `monaco-editor-manager.js`（9076 行 / 234 方法）做分支并行合并实验。

### 3.1 分段结构

按「方法声明行的归属」切分，18 个段：

| 段 | 行数 | 方法 | 自包含度 | churn/行 | 外部转发点 |
|---|---:|---:|---:|---:|---:|
| lsp-providers | 2450 | 58 | 79% | **2.64** | 34 |
| include-resolution | 931 | 28 | 86% | 0.01 | 12 |
| groups+open | 859 | 9 | 42% | 0.21 | 7 |
| theme+colors | 697 | 19 | 66% | 0.20 | 17 |
| settings-apply | 603 | 16 | 68% | 0.49 | 9 |
| cpp-parser | 634 | 23 | 94% | 0.05 | 4 |
| tab-ops+diff | 438 | 15 | 47% | 0.07 | 17 |
| diag+markers | 424 | 15 | 60% | 0.21 | 7 |
| keybindings | 400 | 15 | 41% | 0.10 | 20 |
| editor-lifecycle | 337 | 2 | 100% | 0.09 | 0 |
| completion | 309 | 8 | 46% | 0.03 | 7 |
| selection-guard | 267 | 8 | 64% | 0.00 | 4 |
| clipboard+fmt | 251 | 7 | 25% | 0.29 | 9 |
| rename | 126 | 2 | 0% | 0.02 | 1 |
| semantic-hl | 106 | 3 | 0% | 0.26 | 9 |
| breakpoints | 106 | 1 | 0% | 0.78 | 1 |
| open-at-pos | 69 | 2 | 20% | 0.00 | 4 |
| legacy（死代码） | 65 | 3 | 100% | 0.00 | 0 |
| **段合计** | **9072** | **234** | — | — | **162** |

> 段行数合计 9072 + 文件头 4 行（注释 / 常量 / 空行 / `class` 声明）= 9076 ✓
> 方法数合计 234 = 文件方法总数 ✓
>
> **口径说明**：`churn/行` 一列是**段级** hunk 归属统计（按 hunk 落点行号），
> 与 §1.3 的**文件级** churn 不是同一口径。
> `lsp-providers` 段级 2.64 显著高于所在文件的 1.70 —— 说明该段的改动密度
> 确实远高于文件其余部分，这是「只拆热段」策略的依据。
>
> **段边界口径**：上表按方法声明行归属切分，边界落在方法之间。
> `getCurrentContent`（5384-5395）虽与 `breakpoints` 段行号相邻，但**属活代码** ——
> 被 `renderer/js/main.js:2249` 与 `sidebar/sampleTester.js:2767` 调用，
> **不得随 breakpoints 段删除**。

### 3.2 实测结果

| 实验 | 分支策略 | 结果 |
|---|---|---|
| **E1** | 4 分支各删 1 段，间隔 1000–1994 行 | ⚠️ 零冲突，行数守恒，**但已误删 `getCurrentContent`**（见下） |
| **E2** | 4 分支各删 1 段，段相邻 | ❌ 1 冲突块 |
| **E3** | 3 分支贪心着色分组 | ❌ 5 冲突块 |
| **E4** | 2 分支交替奇偶分组 | ❌ 6 冲突块 |
| **E5** | 4 分支**只新增文件**，主文件不动 | ✅ 4/4 零冲突，18 文件全部落地 |

> **E1 不是干净的成功案例。** `breakpoints` 段区间 `[5278, 5384]` 的末行 5384
> 正是 `getCurrentContent() {` 的声明行 —— E1 已经删掉了这个有外部调用者的方法，
> 而「行数 9076→7574 精确守恒」正是给出虚假安全感的信号。
> 真正的成功案例只有 **E5**。

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
`this.getFileNameFromPath()`。git 把两条相邻行的改动合成同一个冲突块。

**更强约束**：18 个段在文件中首尾相接，两两间隔均为 0。任何两段分到不同分支时，
删除边界直接相接，git 缺少锚定行，必然冲突。

| 分支类型 | 可行性 |
|---|---|
| 只**新增**文件，主文件不动 | ✅ 任意数量并行，零冲突 |
| 从主文件**删除**一个段，与其它分支的段**间隔 ≥ ~1000 行** | ⚠️ 可合并，但仍须校验方法数（见 E1） |
| 从主文件**删除**一个段，与其它分支的段**相邻或近邻（<100 行）** | ❌ 必冲突 |

### 3.4 方案：两阶段拆分

```
阶段 S1（4 路并行，零冲突）：agent 各自【新增】拆出文件
     每路只写自己的新文件，主文件完全不动
        ↓  顺序 merge，每步 32s 验证
阶段 S2（1 路，单 agent）：从主文件删除 17 个活段 + legacy 死代码
     + 改写 162 处外部转发点 + 新文件挂到 index.html
```

S1 产物是纯新增文件，可 4 路并行；S2 是唯一有冲突风险的操作，单点执行。

> **S2 的边界纪律**：段边界必须落在方法声明行之间，逐方法核对归属。
> `getCurrentContent`（5384-5395）严禁随 `breakpoints` 段删除。

---

## 4. 节点定义（DAG）

### 4.0 前置：本方案不修改任何 `.js` 源文件

`noEmit` 模式下，**只加 `tsconfig.json` + `global.d.ts`，`src/**/*.js` 一行不改**，
32 个文本断言测试完全不受影响，A4 也不必做。

代价是剩余 863 条报错无法消除。取舍：

| 路线 | 源码改动 | 报错 | 测试影响 | agent 耦合 |
|---|---|---|---|---|
| **路线甲（推荐起步）** | 零 | 4911 → 维持 | 零 | 零，可全并行 |
| 路线乙（加 `@ts-ignore` / JSDoc 注解） | 每文件数十行 | 863 → 趋近 0 | **32 个文本断言测试需同步改** | §2.2 的耦合全部生效 |

> **建议：先只做路线甲。** 它拿到 49% 的报错削减、零测试改动、零 agent 耦合，
> 成本 2.5 人天。路线乙的收益（863 条）远小于其引入的串行链（33.6 人天）。
> 下方 N1–N5 描述的是路线乙，**仅在确有必要时启动**。

### L0 — 引导（路线甲，全部零源码改动）

| ID | 任务 | 人天 | 产出 / 验收 |
|---|---|---:|---|
| **A1** | `tsconfig.json`（`allowJs`+`checkJs`+`noEmit`+`strict:false`）+ 装 `@types/node`、`@types/electron` | 2 | `tsc --noEmit` 可跑 |
| **A2** | `src/types/global.d.ts`（~15 行：`logInfo/logWarn/logError/monaco/require` + `Window` 上 15 个全局） | 0.5 | **报错 9593 → 4911（−49%）** |
| **A3** | `src/types/preload.d.ts`：131 个 `electronAPI.*` 方法 + 153 个 IPC channel 签名 | 2–3 | 渲染层 709 处 `electronAPI.*` 调用有类型 |

> **A1 完成后必须重测基线**（§1.5 已说明理由）。A2 的「−49%」是装 `@types` **之前**的数字。

**A4（测试去路径硬编码）仅在启动路线乙或执行 S2 时才需要**，届时拆 4 个并行子任务：

| 子任务 | 位置 | 备注 |
|---|---|---|
| A4-1 | `cpp-highlight-color-slots.test.js` 的 `methodBody()` 提取器 | 最脆：正则按 `^\s{4}method(` 定位 + `eval` |
| A4-2 | `cpp-highlight-rules/e2e.test.js` + `clang-format.test.js` | 3 处同模式 |
| A4-3 | `lsp-{completion-command,diagnostics-uri,provider-registration,main-audit}.test.js` | 4 处同模式 |
| A4-4 | `ci-check.js` 4 处硬编码文件列表改 glob | D1/D8/BOM/selector |

### L1 — 路线乙的叶子层 TS 化（可选）

| ID | 任务 | 人天 | 并行度 | 依赖 | 验收 |
|---|---|---:|---:|---|---|
| **N1–N4** | **28 个零测试依赖文件**（14213 LOC / 1101 报错） | 32.7 | **4** | A2, A4 | 各文件 `tsc` 零报错 |
| **N5** | **16 个「有测试依赖」文件构成单一连通分量**（14179 LOC / 1531 报错） | 33.6 | **1（完全串行）** | A2, A4 | 同上 |
| **N6** | 删死代码：`monaco-editor-manager.js:9012-9076` | 0.5 | 1 | — | 减 65 行 |

> **N5 不可拆分。** 依据见 §2.2 —— 16 个文件经 `compiler.js` 传递相连，
> 分给不同 agent 必然在 `audit-fixes` / `bug-report` / `security-regression`
> 三个测试文件上冲突。
>
> **这是整个方案最大的单点**：1 个 agent 连续 33.6 天。
> 缩短它的唯一办法是改掉那三个测试的源码文本断言（属 A4 范畴），
> 但即使 A4 全部做完，也只是把「文本断言」换成「标记搜索」，耦合依旧存在 ——
> 必须改成运行时行为断言才能真正解耦。

> **N6 的死代码判定依据**（已实测）：
> `parseFunctions` 与 `parseStructsAndClasses` 在**全仓库零调用点**
> （`grep -rn` 仅命中自身定义行 9012 / 9037）；
> `removeComments` 的 2 处调用（9014 / 9039）**都在这两个死方法内部**，
> 因此整段 9012-9076 可整体删除。`completion` 已改走 `parseFunctionsWithLocations`（6821 行）。

**N1–N4 的 4 包划分**（LPT 均衡，每包报错数 245–304）：

| 包 | 文件数 | LOC | 报错 | 人天 |
|---|---:|---:|---:|---:|
| PKG-1 | 4 | 3688 | 304 | 8.6 |
| PKG-2 | 3 | 3458 | 251 | 7.8 |
| PKG-3 | 9 | 3378 | 245 | 7.8 |
| PKG-4 | 11 | 3445 | 301 | 7.9 |

### L2 — 拆分（两阶段）

| ID | 任务 | 并发 | 依赖 | 验收 |
|---|---|---:|---|---|
| **S1a–S1d** | 阶段 S1：**新增** 18 个拆出文件（每 agent 4–5 个） | **4** | N6 | `node -c` 全通过 |
| **S2** | 阶段 S2：主文件删除 17 个活段 + legacy 死代码 + 改写 162 处外部转发 + `index.html` 挂载 | **1** | S1, A4 | `ci:tests` 35/35 **且方法数守恒** |
| **🚦 G1** | 复测 `churn/行` | 人工 | S2 | 判据见下 |

**G1 判据**：

```
churn/行 ≤ 0.2  → 放行，执行 N7
churn/行 > 0.5   → 停止，重评，不执行 N7
```

> 依据：`lsp-providers` 段级 churn 2.64，冷段实测 0.01–0.29。
> 拆分后若 churn 未降到 ≤0.2，说明改动量并未真正隔离。

### L3 — 仅在 G1 放行后

| ID | 任务 | 并发 | 人天 |
|---|---|---:|---:|
| **N7** | 冷段 TS 化：拆分后 monaco 其余 ~6600 行 + 18 个新文件 | **4** | 12–16 |

---

## 5. 4-agent 排期

### 5.1 阶段一：路线甲（推荐先落地）

| 天 | AG-1 | AG-2 | AG-3 | AG-4 |
|---|---|---|---|---|
| **D1** | A1 tsconfig + @types | A2 global.d.ts | A3 preload.d.ts | 复核基线并更新本文档 §1.5 |
| **D2** | A3 支援 | 写 `docs/TS_MIGRATION_STATUS.md` | — | — |

**阶段一总工期 2 天，2.5 人天，零源码改动，零测试影响。**

### 5.2 阶段二：拆分线（与阶段三并行）

| 天 | AG-1 | AG-2 | AG-3 | AG-4 |
|---|---|---|---|---|
| **D3** | A4-1 测试改造 ★ | A4-2 | A4-3 | A4-4 ci-check glob |
| **D4** | A4 收尾 | **S1a** 新增拆出文件 | | |
| **D5–D6** | **S1b** | **S1c** | **S1d** | 合并 S1a→d，每步 32s 验证 |
| **D7** | **S2** 单开：主文件删除 + 转发改写 + index.html | | | |
| **D8** | 🚦 **G1 闸门** | | | |
| **D9–D12** | **N7** 冷段 TS 化 ×4 并发 | | | |

**拆分线：D3–D12 = 10 天（A4 2 + S1 2 + S2 1 + G1 0.5 + N7 3.5 = 9 人天）。**

### 5.3 阶段三：叶子线 —— 真正的瓶颈

| 天 | AG-1 | AG-2 | AG-3 | AG-4 |
|---|---|---|---|---|
| **D3–D36** | **N5** 单一连通分量（33.6 人天，1 agent 连做） | 见下 | 见下 | 见下 |
| **D3** | ↑ | A4-1 | A4-2/3 | A4-4 |
| **D4–D14** | ↑ | N1–N4 包 1 | N1–N4 包 2 | N1–N4 包 3 |
| **D4–D6** | ↑ | ↑ | ↑ | **S1a–S1d** |
| **D7** | ↑ | **S2** 单开 | 合并验证 | ↑ |
| **D8** | ↑ | 🚦 **G1 闸门** | ↑ | ↑ |
| **D9–D12** | ↑ | ↑ | **N7** ×4 并发 | ↑ |
| **D15–D36** | ↑ | 空闲 / 拆分后续 | ↑ | ↑ |

**关键路径模型**（统一用日历天）：

```
路径甲（拆分线）：D1–D12  = 12 天
路径乙（叶子线）：D3–D36  = 34 天   ← N5 从 D3 起独占 1 个 agent 连做 33.6 天
总日历 = D1–D36 = 36 天
```

> ⚠️ **此处隐含一个未验证假设：「1 人天 = 1 个 agent 的 1 个工作日」。**
> §7 的 eff 模型是按人类工作量标定的，而 agent 的实际吞吐
> （受上下文长度、工具调用轮次、失败重试影响）与之没有实测对应关系。
> 若 agent 实际吞吐高于 1 人天/天，N5 可缩短；若低于，日历会进一步拉长。
> **这是本方案最大的不确定性来源，建议在 N1–N4 完成后用实测速率重算 §5。**

> **瓶颈是 N5 那条 33.6 人天的完全串行链**（§2.2）。
> AG-1 从 D3 到 D36 连续 34 天只做一个任务，是整个方案的资源瓶颈；
> 其余 3 个 agent 在 D15 之后全部空闲。
>
> **这也是 §4.0 强烈建议先只做路线甲的原因**：
> 路线甲完全不触碰 `.js` 源文件，因此**不存在任何 agent 耦合**，
> **2.5 人天 / 2 天即可交付**。
>
> 若要缩短总工期，唯一有效手段是拆掉 §2.2 的耦合 ——
> 把 `audit-fixes` / `bug-report` / `security-regression` 三个测试的
> 源码文本断言改成运行时行为断言。
> **注意 A4 只能把「路径硬编码」换成「标记搜索」，耦合依旧存在**；
> 必须改成行为断言才能真正解耦。建议单独立项评估。

---

## 6. 收益曲线

| 完成到 | LOC 覆盖 | 累计人天 | 日历 | 说明 |
|---|---:|---:|---|---|
| A1+A2 | 0% | 2.5 | D1 | 零源码改动，报错 −49% |
| +A3 | 0% | 5.0 | D2 | 153 channel 契约文档化 |
| +S1+S2+G1 | 0%（仅拆分，无类型化） | 8.5 | D8 | — |
| +N1–N4 | **24%** | 41.2 | D14 | 28 文件 = 14213 LOC |
| +N5 | **48%** | 74.8 | **D36** | 16 文件 = 14179 LOC（串行） |
| **+N7** | **59%** | 86.8–90.8 | **D36** | + 拆分后 monaco 冷段 ~6600 行 |

> 累计人天含 L0（4.5）+ 拆分线（9）+ 叶子线（66.3）+ N7（12–16）。
> 日历取两条路径的较大者：拆分线 D1–D12，叶子线 D3–D36。
> N7 在 D9–D12 即可完成，不推迟总工期。

**覆盖率口径**：`(28392 + 6600) / 59109 = 59%`。

**59% 同时是天花板**，因为按 §7 明确排除的部分共 24091 行：

| 排除项 | 行数 | 理由 |
|---|---:|---|
| `src/main.js` | 11522 | 15 个测试读其源码，26.6 人天 |
| `src/renderer/js/tabs.js` | 5572 | 本轮不排 |
| `src/renderer/js/main.js` | 4547 | 本轮不排 |
| `lsp-providers` 段（拆分后独立文件） | 2450 | churn 2.64/行，留 JS |
| **合计排除** | **24091** | `59109 − 24091 = 35018 = 59.2%` |

> 此前版本写「80%」是错的 —— 它把 `tabs.js` 与 `renderer/main.js` 计入了分子，
> 而这两者恰在 §7 的排除清单里。

---

## 7. 明确不做

| 项 | 人天 | 理由 |
|---|---:|---|
| `lsp-providers` 段 TS 化 | 5.9 | 段级 churn **2.64/行**，全项目最热。拆出去正是为了让它留在 JS |
| `src/main.js` TS 化 | 26.6 | 11522 行 / 15 个测试读它源码。4 并发下占满一槽，负价值 |
| `tabs.js` / `sampleTester.js` / `renderer/main.js` TS 化 | 31.9 | churn 0.45–0.64 可接受但成本高。N7 后按需再排 |
| 引入 esbuild / webpack | 10–15 | 拆出的新文件仍可用 `<script>` + `window.X` 挂载 |
| `tsc` 产出运行时 JS | 5–8 | 只做 `noEmit`。改 31 个 script 标签 + monaco AMD 加载 + CSP，风险大于收益 |
| 删除型分支并行拆分 | — | 实测必冲突（§3.3）。改为「新增并行 + 单点集成」 |
| **路线乙（N1–N5）整体** | 66.8 | **可延后** —— 收益 863 条报错，代价 33.6 人天完全串行。优先做路线甲 |

> **人天口径（重要：这是估算模型，不是实测）**
> `eff = LOC×0.0022 + strictErr×0.0006 + looseErr×0.004`
>
> 三个系数是**反推得到的**：先对 `main.js` 取 26.6 人天这一估值，
> 再解出系数去拟合它。因此「能复现 main.js（26.55）与三巨头合计（31.88）」
> **是循环论证，不构成验证**。
>
> 该模型的已知偏差：
> - 未计入「改动会触发多少条文本断言测试需同步修改」这一成本，
>   而这正是 §2.2 那条 33.6 人天串行链的来源 —— **模型系统性低估路线乙**
> - 未计入 review / 合并冲突 / 重跑回归的摩擦成本
> - `strictErr` 系数 0.0006 远小于 `looseErr` 的 0.004，隐含假设是
>   「隐式 any 几乎免费、DOM 收窄很贵」。这与 §1.5 的报错分布一致
>   （2246 条 TS7006 vs 637 条 TS2339），但比例未经独立验证
>
> **结论：人天数字只应用于横向排序（哪个任务更贵），不应作为排期承诺。**
> §5 的日历天同样继承此不确定性。真实排期建议在完成 N1–N4 后按实测速率重算。

---

## 8. 护栏（写进每个 agent 的 prompt）

| 护栏 | 原因 |
|---|---|
| 路线甲阶段**禁止修改任何 `src/**/*.js`** | 32 个文本断言测试按源码文本断言 |
| 每个 agent **独占一个 worktree + 一个文件** | 渲染层 46 处 `window.X =` 是隐式全局 |
| **禁止改 `<script>` 标签顺序和 HTML**（S2 阶段除外） | 31 个标签的执行顺序就是依赖图 |
| **禁止 `this.t` / `window.__` / 改 `module.exports` 形态** | AGENTS.md 禁令，破坏 `preload.test.js` 的 IPC 白名单断言 |
| **禁止 `innerHTML` 注入类型收窄** | I8 baseline 0，改动会触发 CJK ratchet |
| 每 agent 只跑 `tsc --noEmit <自己的文件>` + `ci:tests` | 全量 `tsc` 仅 4.2s |
| **`src/main.js` 全程冻结** | 15 个测试读它文本 |
| S2 阶段**主文件由单 agent 独占 worktree** | 删除型操作是唯一有冲突风险的动作 |
| S2 阶段**段边界必须落在方法声明行之间** | `getCurrentContent`（5384）行号贴着 `breakpoints` 段尾但属活代码 |
| **求 agent 可并行性必须取测试依赖的传递闭包** | 16 个文件经 `compiler.js` 构成单一连通分量（§2.2），按单个测试的覆盖集合判断会漏 |
| 每次 merge 后必跑 `node -c` + `ci:tests` | 32s 闭环 |

---

## 9. 拆分阶段的验证协议

| 检查 | 命令 | 判据 |
|---|---|---|
| 语法 | `node -c <file>` | exit 0（**每个拆出文件单独跑**） |
| **方法数守恒** | `grep -cE "^    (async \|static \|get \|set )*[a-zA-Z_#][a-zA-Z0-9_]*\("` 合并前后对比 | 差值 = 计划移出数（**S2 全部 18 段 = 234 − 剩余**）；不符即驳回 |
| 行数守恒 | `wc -l` | 差值 = 移出行数（**必要但不充分**，见下） |
| 外部调用存活 | `grep -rn "<方法名>" src/ tests/` | 每个被摘出段的公开方法，其外部调用点必须已改为 `window.<NS>.` |
| 回归 | `pnpm run ci:tests` | 35/35 PASS |
| 零逻辑变更 | `git diff -M --stat main..<branch>` | 相似度 ≥95% |

**行数守恒不是充分条件。** E1 实测：`breakpoints` 段区间 `[5278, 5384]` 的末行
正是 `getCurrentContent() {` 的声明行，该方法（有 2 处外部调用）被连带删除，
而行数仍「精确守恒」。**只有方法数守恒 + 外部调用存活检查能拦住。**

---

## 附录 A：测量方法

```bash
# 1. 类型报错量（注意：测量时 node_modules 下无任何 @types）
tsc --noEmit --allowJs --checkJs --skipLibCheck --strict false \
    --target es2022 --module esnext --moduleResolution bundler \
    --lib es2022,dom,dom.iterable $(find src -name '*.js')

# 2. 剔除还原提交后的 churn（三个，不是两个）
git log --since="90 days ago" --numstat --format='C %H' -- src
# 排除：
#   ce90668fd4ebc7b2892fbc12fca1e16ca21e593b  (parent 5840d615, +6908)
#   87e1deb0f2d2ba4cf1db0e285edc4aad3f22799e  (parent fe57bac8, +6908)
#   a92e11a048419111ee600a3fde2c04c4da80afb2  (+4118)
# 后两个 parent 不同的提交消息相同，只按消息过滤会漏

# 3. 测试→源码耦合分析
grep -roE "src/[A-Za-z0-9_/.-]+\.js" tests/*.test.js | sort -u
# security-regression.test.js 单独列出：它命中 14 个文件，是最强耦合

# 4. 分支并行合并冲突实验
git clone --no-hardlinks . /tmp/mtest
# 每个分支：① 删除自己那段 ② 改写该段的外部 this.X 调用点
git merge --no-edit <branch>   # 观察 CONFLICT
# 注意：E1 显示「零冲突 + 行数守恒」仍可能误删边界方法，必须另查方法数
```

---

## 附录 B：实测冲突数据

**段间隔**（前一 end → 后一 start）：18 个段两两间隔**全部为 0**（首尾相接）。

| 实验 | 分支 | 段间隔 | 结果 |
|---|---|---|---|
| E1 | 4 删+转发 | 1000 / 1789 / 1994 | ⚠️ 零冲突但误删 `getCurrentContent` |
| E2 | 4 删+转发 | 0（相邻） | ❌ 1 冲突块 |
| E3 | 3 贪心着色 | 混合 | ❌ 5 冲突块 |
| E4 | 2 奇偶交替 | 0 | ❌ 6 冲突块 |
| E5 | 4 **纯新增** | N/A | ✅ 零冲突，18 文件全部落地 |

**E5 的副产物 —— 方法数偏差**：

```
base1 方法数 188 → 合并后 116
计划移出       64 个（22+14+14+14）
实际移出       72 个          ← 多出 8 个
```

多出的 8 个全是**段边界溢出**：

| 被误删的方法 | 真实归属 | 外部调用者 |
|---|---|---|
| `getCurrentContent` | breakpoints / tab-ops+diff 边界 | **`renderer/main.js:2249`、`sampleTester.js:2767`** |
| `getCurrentEditor` | groups+open / diag+markers 边界 | — |
| `getDefaultKeybindings` | semantic-hl / keybindings 边界 | — |
| `getIncludedFilePaths` | cpp-parser / include-resolution 边界 | — |

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
