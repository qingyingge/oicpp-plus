# TypeScript 迁移方案（4 AI agent 并行编排）

> 状态：**路线甲可立即开工；路线乙的关键路径已按实测重排**。
> 基准 commit `335b08a` · tsc **7.0.2** · `node_modules` 下无任何 `@types`
> 行数口径：`sum(1 for _ in open(f))`，末尾无换行的文件计为完整行
>
> **数字性质说明**（避免误用）：
> - **计数类**（行数、文件数、报错数、耦合数）= 实测，测量方法见附录 A
> - **人天与日历天** = 估算模型输出。系数是反推拟合的，**不应作为排期承诺**
> - 本文档全部数字由 `scripts/ts-migration-baseline.ps1` +
>   `scripts/ts-migration-coupling.js` 生成，HEAD 一动就重跑

---

## 0. 结论摘要

| 结论 | 依据 |
|---|---|
| **先做路线甲**（`tsconfig` + `global.d.ts`，零源码改动） | 零测试改动、零 agent 耦合、成本最低 |
| **路线乙可以 4 路并行，不需要拆测试文件** | 实测：注解式改动跨文件零冲突（§2.2） |
| **耦合的真实单位是「被断言的字面量」，不是「被读取的文件」** | 实测：加 JSDoc 0 fail，改字面量 1 fail（§2.2） |
| 关键路径 **25.15 eff**，且**无解锁成本** | 三档耦合模型下均为 25.2–25.3（§4.3） |
| **拆测试文件不是瓶颈**（71 行 / 28 断言，≈0.5 人天），**拆源码文件才是未估成本** | §3.3：monaco 内 538 处 `this.` 跨段调用未进预算 |
| `src/main.js` 本轮不做 | 11660 行 / 多个测试读它源码 |

> **本次修订相对上一版的三处推翻**（详见 §10）：
> 1. 基线从 `6ac0ba1` 漂移到 `335b08a`，全部行号锚点失效
> 2. 「16 文件一个连通分量 → 并行度 1 → 33.6 人天串行」**结论错误**，
>    根因是把「被同一测试读取」误当成「需要改同一个测试」
> 3. 因此「必须拆测试才能解锁」也是错的 —— 只需一条禁改字面量的 prompt 约束

---

## 1. 基线数据（实测）

### 1.1 代码规模

| 层 | 行数 | 文件数 |
|---|---:|---:|
| `src/main.js` | 11660 | 1 |
| `src/renderer/js/monaco-editor-manager.js` | 9098 | 1 |
| `src/renderer/js/tabs.js` | 5572 | 1 |
| `src/renderer/js/main.js` | 4547 | 1 |
| `src/renderer/js/sidebar/sampleTester.js` | 3798 | 1 |
| 其余 renderer（js + sidebar + settings + formatters + ui） | 18414 | 25 |
| `src/preload.js` | 979 | 1 |
| `src/utils/` | 2021 | 8 |
| `src/main-process/` | 480 | 2 |
| `src/lang/` + gdb / terminal / clang-format 服务 | 2713 | 7 |
| **src 合计** | **59359** | **48** |
| `tests/` | 6714 | 37（其中 `*.test.js` **35** 个） |

### 1.2 开发速率

沿用上一版的 churn 结论（`monaco-editor-manager.js` 是最热文件，段级
`lsp-providers` churn 2.64/行）。**churn 数字需按 §4.4 的说明重测后才能用于闸门。**

### 1.3 验证周期

| 命令 | 实测耗时 |
|---|---:|
| `tsc --noEmit` 全量 src（strict false） | ~1.4 s |
| `pnpm run ci:tests`（35 个测试） | ~31 s |
| `pnpm run ci`（74 项检查 + 35 个测试） | ~38 s |

### 1.4 TypeScript 报错量

配置：`tsc --noEmit --allowJs --checkJs --skipLibCheck --strict <flag>
--target es2022 --module esnext --moduleResolution bundler --lib es2022,dom,dom.iterable`

| 配置 | 报错数 | 涉及文件 |
|---|---:|---:|
| `--strict false`（下称 **loose**） | **5396** | 41 |
| `--strict true`（下称 **strict**） | **9617** | 46 |

- 测量前提：`node_modules` 下**无任何 `@types`**。**这是本方案全部数字的原始前提。**
- 上一版引用的 `9593 / 4911 / 863` 是 tsc 旧版 + 装了 `global.d.ts` 之后的数，
  **在本基线下不可复现**，已从本文档移除。
- A1 要求装 `@types/node` / `@types/electron` 后基线会漂移
  （约 400 条 `TS2304` 会消失，`Buffer` 的严格类型可能新增报错），
  **方向与幅度均未实测**。装完必须重跑基线脚本，不许沿用本文档的数字。

loose 5396 条按错误码分布：

| 码 | 条数 | 含义 |
|---|---:|---|
| TS2339 | 2369 | 属性不存在（多为 DOM 收窄不足 / 鸭子类型） |
| TS2304 | 1624 | 找不到名称（`process` / `Buffer` / `require` 等，缺 `@types/node`） |
| TS2551 | 857 | 属性不存在但有建议 |
| TS2552 | 361 | 属性不存在，隐式 any |
| 其余 | 185 | 少量类型不匹配 / 重复标识符 |

---

## 2. 约束分析：并行度由什么决定

### 2.1 反馈快 → 粒度要细

40 秒闭环意味着 agent 可以「改一处跑一次」。

### 2.2 耦合的真实单位：**被断言的字面量**（本次修订的核心）

上一版的规则是：

> 若测试 T 同时读取源码文件 X 与 Y，则修改 X 的 agent 与修改 Y 的 agent
> 都要改 T → 必须串行

**这条规则过粗，而且它的推论是错的。** 它把「读取」当成了「需要修改」。

#### 实测证据

在 `src/renderer/settings/editor.js`（**被 `security-regression`、`bug-report`、
`audit-fixes` 三个测试同时读取**）上做三组递进编辑，每组跑那三个测试：

| 编辑 | security-regression | bug-report | audit-fixes |
|---|---:|---:|---:|
| 顶部注入 `@typedef` JSDoc 块 | 0 fail | 0 fail | 0 fail |
| 在被断言的调用点前插入一行普通语句 | 0 fail | 0 fail | 0 fail |
| 改写被断言的对象字面量 `{ windowOpacity }` | **1 fail** | 0 fail | 0 fail |

再在最危险的一批文件上验证 —— `monaco-editor-manager.js`、`compile-manager.js`、
`i18n.js`、`tabs.js`（这四个带 `eval` 方法体提取器、AST 括号配对、
`.match().length >= N` 次数断言）。四文件各注入 JSDoc 后：

```
security-regression=0  bug-report=0  audit-fixes-2026-10-01=0  cpp-highlight-e2e=0
cpp-highlight-color-slots=0  lsp-main-audit=0  i18n=0  preload=0
```

**结论：耦合是字面量级的。** 加 JSDoc、加语句、改结构都不炸；只有改**被断言的那个
精确字符串**才炸一条。

#### 全仓承重断言清单

由 `scripts/ts-migration-coupling.js` 从 35 个测试里提取：

| 项 | 数量 |
|---|---:|
| 有报错且**无任何**承重断言的文件 | **28 / 46** |
| 有承重断言的文件 | 18 |
| 精确字面量断言 | **34** |
| 结构断言（方法体正则 / 次数断言 / eval） | **8** |

分布（只列 `.js`）：

| 文件 | 字面量 | 结构 | 备注 |
|---|---:|---:|---|
| `src/main.js` | 6 | 0 | 本轮冻结 |
| `src/main-process/compare-worker-v6.js` | 5 | 1 | 次数断言 `if (!running) break; >= 3` |
| `src/gdb-debugger.js` | 4 | 0 | |
| `src/gdb-mi-debugger.js` | 4 | 0 | |
| `src/renderer/js/main.js` | 3 | 0 | 本轮冻结 |
| `src/utils/process-supervisor.js` | 2 | 0 | |
| `src/renderer/js/settings-init.js` | 2 | 0 | |
| `src/lang/index.js` | 2 | 0 | |
| `src/renderer/settings/compiler.js` | 1 | 2 | 2 处方法体正则（`bug-report`） |
| `src/renderer/settings/editor.js` | 1 | 0 | |
| `src/renderer/js/compile-manager.js` | 0 | 1 | 方法体正则（`cloudCompileCurrentFile`） |
| `src/utils/multi-thread-downloader.js` | 0 | 1 | 次数断言 `.body\.resume\(\) >= 3` |
| `src/preload.js` / `js/tabs.js` / `js/sidebar.js` | 各 1 | 0 | |

完整清单（含每个字面量归属哪个测试）由实验台一键导出，直接贴进 agent prompt。

#### 三档耦合模型

| 模型 | 规则 | 关键路径 |
|---|---|---:|
| **注解式**（推荐） | 跨文件无约束；只有字面量约束 | **25.15** |
| 含结构性改动 | 只把带结构断言的文件按同一测试合并 | 25.26 |
| 文件级共读（上一版） | 任何被同一测试读取的两个文件互斥 | 25.33 |

三档几乎无差 —— **因为精确化之后，"需要改同一个测试"的文件只剩 11 个，
而且它们并没有形成必须串行的团。**

#### 附带发现：`security-regression` 耦合到 `src/` 之外

它还断言了 8 个非 `src/` 文件：`installer.nsi`、`binding.gyp`、`package.json`、
`scripts/ci-check.js`、`scripts/build-fastspawn.js`、`scripts/download-clangd.js`、
`scripts/download-clang-format.js`、`scripts/lib/release-downloader.js`。
上一版一个字都没提。**将来若要改 `scripts/ci-check.js`（例如 A4-4 把硬编码列表改
glob），冲突面在这里，不在 `src/`。**

### 2.3 拆测试文件的成本（实测后大幅下修）

上一版把「拆 `security-regression` + `bug-report`」估成 **3 天解锁**。实测：

| 文件 | 行数 | `check()` 数 | `readFileSync` | 断言间共享状态 |
|---|---:|---:|---:|---|
| `security-regression.test.js` | **71** | 28 | 1 | 仅 `read()` helper 与 `failures` 计数器 |
| `bug-report.test.js` | 203 | 23 | 2 | 同上 |
| `audit-fixes-2026-10-01.test.js` | 320 | 81 | 9 | 同上 |

`tests/run-tests.js` 自动发现 `*.test.js` 并逐个 `spawnSync` 运行
（`tests/run-tests.js:11-15`），新增文件零配置；且它强制要求每个文件至少打印一个
标记，否则记 FAIL —— 所以拆分时断言总数必须守恒。

**真实成本 ≈ 0.5 人天，不是 3 天。** 而按 §2.2，**根本不需要拆**。

---

## 3. 拆分可行性（monaco）

### 3.1 分段结构

上一版把 `monaco-editor-manager.js` 切成 18 段。**该表的行号已随基线漂移失效**
（文件从 9076 涨到 9098），必须按当前 HEAD 重算后才能用于 S2。

方法总数 **234** 与上一版一致（实测 `^\s{4}(static |async |get |set )*name(` = 234）。

### 3.2 边界事故（上一版已记录，仍然有效）

- `getCurrentContent` 的声明行紧贴 `breakpoints` 段尾，E1 实验已连带删除过它，
  而「行数精确守恒」给出了虚假的安全信号。
- 当前 HEAD 下 `getCurrentContent` 在 **5408**，`parseFunctions` 在 **9034**，
  `parseStructsAndClasses` 在 **9059** —— 与上一版记录（5384 / 9012）全部不同。
- **归属哪个段至今没有定义。** S2 缺客观判定依据，必须先补。

### 3.3 拆源码文件的成本是空的（本轮最大未估项）

| 项 | 数量 | 来源 |
|---|---:|---|
| 类内 `this.X(` 调用 | **538** | 实测 |
| 文档计划改写的「外部转发点」 | 162 | 上一版估算 |
| 段自包含度低至 | **0%** | 上一版实测（`rename` / `semantic-hl` / `breakpoints`） |

**538 处类内跨段调用是 S2 的主体，而它一行都没进预算。** 段自包含度 0% 意味着
这些方法全在调用段外方法；拆成独立对象后每一处都要改成 `window.<NS>.` 或注入依赖。

> **因此本轮不排 monaco 拆分线。** 在补齐「538 处跨段调用的改写方案 + 每段归属
> 定义 + E1 类边界事故的自动化拦截」之前，S2 的成本模型不成立。

---

## 4. 节点定义（DAG）

### 4.0 路线甲：零源码改动

| ID | 任务 | 人天 | 产出 / 验收 |
|---|---|---:|---|
| **A1** | `tsconfig.json`（`allowJs`+`checkJs`+`noEmit`+`strict:false`）；`typescript` 进 devDeps；加 `typecheck` script；接入 `pnpm run ci` | 2 | 干净环境下 `tsc --noEmit` 可跑；CI 锁报错数不增长 |
| **A2** | `src/types/global.d.ts`（`logInfo/logWarn/logError/monaco/require` + `Window` 上的全局） | 0.5 | 重跑基线脚本，报错数下降且记录降幅 |
| **A3** | `src/types/preload.d.ts`：`electronAPI.*` 方法与 IPC channel 签名 | 2–3 | 渲染层调用有类型 |

**A1 的三项补充是上一版漏掉的**（缺任一项这套东西都无法复现）：

- `typescript` **不在 devDependencies**（实测 devDeps 只有 electron /
  electron-builder / webpack / sharp / icojs / html-webpack-plugin / webpack-cli），
  之前用的是全局 shim，版本不可追溯
- 没有 `typecheck` script
- 没接 `pnpm run ci` —— 5396 条报错会随日常开发漂移。项目已有 I1–I8 的 ratchet
  模式（`scripts/ci-check.js`），直接复用一条「报错数不得增长」即可

> **A1 完成后必须重跑基线脚本**，A2/A3 的验收标准用重测后的数字，不许沿用本文档。

### 4.1 路线乙：4 路并行，无需解锁

| ID | 任务 | 并行度 | 依赖 | 验收 |
|---|---|---:|---|---|
| **B1–B4** | 46 个有报错文件的注解式 TS 化（`@ts-ignore` / JSDoc 收窄） | **4** | A2 | 各文件 loose 报错归零；`ci:tests` 35/35 |
| **B5** | 禁改字面量清单落到每个 agent 的 prompt | 0 | — | 清单由实验台导出，34 条字面量 + 8 条结构断言全覆盖 |

关键路径 **25.15 eff**（注解式模型，4 槽 LPT）。分组由
`docs/ts-split-lab.html` 生成并导出，**不在本文档写死** —— 换 `tsc` 版本、
装 `@types`、或新增文件后，分组都要重算。

> 上一版把这条线拆成「N1–N4 自由 32.7 人天 + N5 串行 33.6 人天」，
> 并把 N5 定为整个方案的单点瓶颈。**该结论已作废。**

### 4.2 与路线甲的关系

两条线**不抢资源**：A1–A3 只碰 `tsconfig.json` / `src/types/*.d.ts`，
B1–B4 只碰 `src/**/*.js`。但 A2 的验收需要重跑 tsc，所以 B 线在 A2 之后起步。

### 4.3 三档耦合模型下的关键路径

| 模型 | 关键路径 | 解锁成本 | 日历（k=1） |
|---|---:|---:|---:|
| 注解式（推荐） | 25.15 | **0** | 25.2 |
| 含结构性改动 | 25.26 | 0 | 25.3 |
| 文件级共读（上一版口径） | 25.33 | 0 | 25.3 |

对比全量串行 **100.53 eff**（不含 3 个冻结文件）→ 降幅 **4.00×**。
上一版报的是「33.6 人天串行、并行度 1」，差距来自 §2.2 的口径错误。

### 4.4 G1 闸门：上一版的判据不可执行

上一版把 G1 定为「拆分后 `churn/行 <= 0.2` 放行」。**该判据在拆分后立刻测不出来** ——
churn 是近 90 天窗口的产物，刚拆出的文件在窗口内没有历史提交。

由于本轮不排拆分线（§3.3），G1 暂时不需要。但若将来重启，必须先换成即时可测的
代理指标，例如：拆分后首月的实际改动行数、单文件月均提交数、
「新文件被外部修改次数 / 主文件被修改次数」。

---

## 5. 排期（4 agent）

```
D1   AG1 A1 tsconfig + typescript 进 devDeps + 接进 ci   AG2 A2 global.d.ts
     AG3 A3 preload.d.ts                                AG4 重跑基线脚本，产出新数字
D2   AG1 A1 收尾（CI 检查）        AG2 A3 支援
     AG3 A3 收尾                   AG4 导出 4 组分组 + 禁改字面量清单
D3+  路线乙 4 路并行（B1–B4），每组跑 tsc --noEmit <自己的文件> + ci:tests
```

**路线甲 2 天 / 4.5–5 人天**；**路线乙关键路径 25.15 eff，无需解锁**。

日历天 = `k × 25.15`（k 无实测依据，见 §6）。上一版的「33.6 人天 → 36 天日历」
不再适用。

---

## 6. 收益与不确定性

| 完成到 | 覆盖文件 | 累计 eff | 日历（k=1） |
|---|---:|---:|---:|
| A1+A2 | 0 | 2.5 | D1 |
| +A3 | 0 | 4.5–5.0 | D2 |
| +B1–B4 | **46 / 46** | ~30 | **3 + 25.15 = 28.2** |

### eff 模型的口径（重要：这是估算，不是实测）

```
eff = LOC × 0.0022 + strictErr × 0.0006 + looseErr × 0.004
```

三个系数是**反推得到的**：先对 `src/main.js` 取一个估值，再解出系数去拟合它。
因此「能复现 `main.js`」**是循环论证，不构成验证**。当前基线下
`src/main.js` 代入得 **29.18**。

已知偏差：

- 未计入 review / 合并冲突 / 重跑回归的摩擦成本
- `strictErr` 系数 0.0006 远小于 `looseErr` 的 0.004，隐含假设是
  「隐式 any 几乎免费、DOM 收窄很贵」—— 与 §1.4 的分布方向一致，但比例未经独立验证

**结论：eff 只应用于横向排序（哪个任务更贵），不应作为排期承诺。**

### agent 吞吐系数 k

**`k` 无任何实测依据。** eff 按人类工作量标定，agent 的实际吞吐（受上下文长度、
工具调用轮次、失败重试影响）与之没有对应关系。

- `k = 1` → 25.2 天
- `k = 2` → 50.3 天
- 比例关系是硬的（并行度提升不依赖 `k`），绝对值是软的

**建议用 B 线第一组做一次实测反推 `k`**，成本仅 1 个包。选文件数少但工作量占比高的
那一组，信号最干净 —— 若 agent 在单包内就超过 2 天，全表要按 3 倍余量重排；
若 1 天内做完，说明分组粒度可以放大。

---

## 7. 明确不做

| 项 | 理由 |
|---|---|
| 拆 `monaco-editor-manager.js` | 538 处类内 `this.` 跨段调用未进预算；段归属未定义；边界事故无自动化拦截（§3.3） |
| `src/main.js` TS 化 | 11660 行 / 6 条字面量断言 + 多个测试读它源码 |
| `tabs.js` / `renderer/js/main.js` TS 化 | 本轮不排 |
| 引入 esbuild / webpack | 收益不抵改 31 个 `<script>` 标签 + monaco AMD 加载 + CSP 的风险 |
| `tsc` 产出运行时 JS | 同上 |
| 拆测试文件 | 实测不需要（§2.2）；成本 0.5 人天，收益 ~0 |
| 删除型分支并行拆分 | 实测相邻段必冲突；且本轮不排拆分线 |

---

## 8. 护栏（写进每个 agent 的 prompt）

| 护栏 | 原因 |
|---|---|
| **禁止修改 §2.2 表中列出的 34 条字面量与 8 处结构** | 改任一条会让 `ci:tests` 变红；清单由实验台导出 |
| 路线甲阶段禁止修改任何 `src/**/*.js` | §4.0 承诺零源码改动 |
| 每个 agent 独占一个 worktree | 渲染层 46 处 `window.X =` 是隐式全局 |
| 禁止改 `<script>` 标签顺序和 HTML | 标签执行顺序就是依赖图 |
| 禁止 `this.t` / `window.__` / 改 `module.exports` 形态 | AGENTS.md 禁令；破坏 `preload.test.js` 的 IPC 白名单断言 |
| 禁止 `innerHTML` 注入类型收窄 | I8 baseline 0，改动会触发 CJK ratchet |
| 每个 agent 只跑 `tsc --noEmit <自己的文件>` + `ci:tests` | 全量 tsc ~1.4 s |
| 禁止修改 `installer.nsi` / `binding.gyp` / `scripts/ci-check.js` | `security-regression` 对它们有断言（§2.2 附带发现） |

---

## 9. 验证协议

| 检查 | 命令 | 判据 |
|---|---|---|
| 语法 | `node -c <file>` | exit 0 |
| 类型 | `tsc --noEmit` 全量 | loose 报错数 **不高于** 基线（CI 锁） |
| 单文件 | `tsc --noEmit <file>` | 退出前该文件的 loose 报错归零 |
| 回归 | `pnpm run ci:tests` | 35/35 PASS |
| 全量 | `pnpm run ci` | 74 项检查 0 failed |

---

## 附录 A：测量方法

全部由脚本封装，不要手工复现：

```powershell
# 一次性产出本文档的全部数字（约 3 s，依赖 PATH 上有 tsc）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ts-migration-baseline.ps1
node scripts\ts-migration-coupling.js

# 重新分组 / 换耦合模型 / 导出禁改清单
# 打开 docs\ts-split-lab.html
```

要点：

- 测量时 `node_modules` 下**无任何 `@types`**，这是数字的前提
- tsc 版本与 HEAD 写进 `docs/ts-migration-baseline.js` 的 `meta`，可追溯
- 脚本里的「文件 → 测试读取关系」是**实测后写死的表**。
  新增或改名测试文件时必须同步更新，否则实验台的冲突检查会静默失效

---

## 10. 相对上一版的修订记录

| 项 | 上一版 | 本版 | 根因 |
|---|---|---|---|
| 基线 commit | `6ac0ba1` | `335b08a` | 未重跑，src 已差 250 行 |
| `monaco-editor-manager.js` | 9076 | 9098 | 同上 |
| `src/main.js` | 11522 | 11660 | 同上 |
| loose 报错 | 863 | **5396** | 上一版是装了 `global.d.ts` 后的数；且 tsc 版本不同 |
| 并行度 | 1（16 文件单一分量） | **4** | 「被读取」≠「需要修改」 |
| 关键路径 | 33.6 人天 | **25.15 eff** | 同上 |
| 解锁成本 | 3 天（拆测试） | **0** | 71 行 / 28 断言，实测不需要拆 |
| `N1–N4` 表 | 文件数 28 / LOC 14213 / 32.7 人天 | 删除 | 三列分别实为 27 / 13969 / 32.1，算术不平 |
| 阶段一总工期 | 「2 天 2.5 人天」 | **2 天 4.5–5 人天** | 2.5 只覆盖 A1+A2，漏了 A3 |
| §5.2 / §5.3 排期表 | 两张 | 合并为一张 | 原两张互相冲突（S2 与 A4-1 派给不同 agent） |
| §6 累计人天 | 末行 86.8–90.8 | 重算 | 原表 4.5+9+66.3+12~16 = 91.8~95.8，与末行差 5 |
| 拆 monaco | S1/S2 排进 D4–D8 | **本轮不排** | 538 处跨段调用未进预算 |
| 耦合单位 | 文件 | **字面量** | §2.2 实测 |
| 非 `src/` 耦合 | 未提 | 8 个文件 | `security-regression` 实测 |