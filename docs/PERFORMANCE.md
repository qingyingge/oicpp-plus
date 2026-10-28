# 对拍器性能优化记录

## 摘要

对拍器引擎经三轮架构演进，吞吐提升 **4.2–5.4 倍**（8 核 ARM64 Cortex-A53 实测，3 轮中位数，50 测试）。

## 实测数据

| 场景 | 原版 spawn | 纯 Node 管线 (V3) | 原生 posix_spawn (V10) | 总加速 |
|------|-----------|-------------------|------------------------|--------|
| Sort | 4.3 TPS | 10.7 TPS | **23.3 TPS** | **5.4x** |
| Graph | 6.4 TPS | 13.2 TPS | **33.1 TPS** | **5.2x** |
| Range | 2.4 TPS | 5.9 TPS | **10.1 TPS** | **4.2x** |

## 核心改动

- **原生进程调度**：新增 N-API 模块 `fastspawn.node`（源码 `fastspawn.cc`），`posix_spawn` 替代 Node `fork`（7ms → 17ms，快 2.2 倍）
- **runPair 并行**：std 与 test 程序互不依赖，pthread 双线程同时执行，单测试耗时从 `gen+std+test` 降为 `gen+max(std,test)`
- **多 Worker 分片**：每个 Worker Thread = 独立 OS 线程串行跑测试切片，N 个 worker = N 路真并行，无事件循环争抢、无 fd 跨线程竞态
- **JS 回退**：原生模块加载失败时自动回退纯 Node 实现，功能不受影响

## 实现文件

- `src/main-process/compare-engine-v2.js` — 引擎入口（生产已接入，`main.js` 第 5960 行引用）
- `src/main-process/compare-worker-v6.js` — V6/V10 worker（原生 + JS 回退双路径）
- `fastspawn.cc` — 原生 addon 源码（编译产物 `fastspawn.node` 需自行构建）

## 复现

```bash
# 构建原生模块（需 Node headers）
g++ -O2 -fPIC -shared -pthread -I$NODE_HEADERS/include/node -o fastspawn.node fastspawn.cc

# 跑基准（自动记录每测试 JSONL 日志到 benchmark/logs/）
node benchmark/bench-logged.js --threads 8
```

## 设计教训

1. 基准必须固定环境负载：Electron/占用 CPU 的进程会系统性低估吞吐（实测 Graph 被低估 33%）
2. 原生模块返回裸 fd 给 Node 异步流（V7/V8）有跨线程 fd 竞态，不可修复；fd 全在 addon 内部管理才是正解（V6/V10）
3. 同步原生调用占用的只是单个 worker 线程的事件循环，多 worker 下并行度 = 线程数，无性能损失（V6 突破）

---

# 第二轮：Windows/JS 回退路径加速（2026-10-27）

第一轮数据全部来自 POSIX fastspawn 路径；Windows 没有原生模块，100% 走 worker 的
JS 回退分支，而该分支当时仍是 `gen → std → test` 三阶段串行 + 每组两侧各一轮全量
字符串规范化。本轮只动回退路径（`compare-worker-v6.ts`），fastspawn 路径不变。

## 改动

- **std/test 并发**：回退路径两个 `await runJs(...)` 改为一次 `Promise.all`，
  与 fastpath 的 runPair 对齐：每组从 `gen+std+test` 降为 `gen+max(std,test)`
- **判等 fast path**：`outputsEqual` 先裸 `Buffer.equals`（长度短路）再回落
  `normalizeOutput`；逐字节相同（对拍主情形）时免掉 MB 级输出两侧各一轮
  Buffer 复制 + utf8 解码 + 4 趟 replace/split/join。判等口径不变，不一致仍走同一套归一化
- **生成器流水线**：回退路径跑第 i 组 std/test 的同时预起第 i+1 组生成器
  （std/test 并发后事件循环有空档，预取真实有效；fastpath 的同步 native 调用
  占死循环，不预取）。可用 `OICPP_COMPARE_PREFETCH=0` 关闭 A/B
- **基准程序去 fastio**：`compare-benchmark/progs` 的场景程序全部改用 scanf/printf——
  真实用户程序不保证带自定义快读，用 fastio 会系统性低估 spawn/管道占比、高估吞吐
- **bench-logged.js 修复**：消息字段 `genPath` 已不被当前 worker 识别（会静默全判
  generator 失败），改为 `gen` + Windows 补 `.exe`

## 实测（win32/x64，20 逻辑核，8 线程 × 50 测试，3 轮中位）

| 场景 | 优化前 TPS | 优化后 TPS | 加速 |
|------|-----------|-----------|------|
| Sort  | 8.9  | **14.6** | **1.64x** |
| Graph | 19.1 | **19.9** | 1.04x（进程启动开销主导，非流水线瓶颈） |
| Range | 5.1  | **6.6**  | **1.30x** |

单线程无争用探针：每组流水线周期 ≈ `max(gen, std, test)`，即每 worker 槽位的理论下限；
8 线程下 std/test 的 216→390ms 膨胀全部来自 CPU 饱和（每槽 3 个并发进程 > 核数摊薄）。
Graph 场景是 Windows `CreateProcess`/Node spawn 固定开销主导，程序本体太短，摊不掉。

## 遗留（评估过、未做）

- **引擎动态队列**（worker 跑完领下一块）：均时长场景收益≈0，只在 RE/TLE 方差大时消尾差；
  改动引擎↔worker 协议会撞上 compare-engine-hardening 的全套 mock 契约（mock 只回一条
  done，续派会挂死 await），代价远超收益
- **fastspawn napi 零拷贝**（`napi_create_buffer_copy` → external buffer）：本机无法编译验证，
  且拷贝量级（ms 内）相对 spawn 可忽略
- **runOne 写完 stdin 才排空 stdout** 的互等窗口（大输入 + 先输后读的程序会误判 TLE）：
  POSIX 专属问题，本机验证不了，留待 Linux CI 环境再修

## 守卫同步

`tests/security-regression.test.js` 的 runLoop harness 随并发结构更新停机点计数
（std/test 同批并发后「批内停机不发 progress/不报错、循环在批边界停」仍逐条断言），
并在 vm 里补 `pendingGen`/`PREFETCH_ENABLED` 声明。全部不变式保留。

---

# 第三轮：默认并行度纠偏（2026-10-27 同日）

## 发现

第二轮之前，**真实用户默认在单线程跑对拍**：`index.html` 的并行线程输入框
`value="1"`，`startComparison` 在读不到数值时又兜回 1。benchmark 里的 8/12 线程
数字从来不是用户的实际体验。

## 改动（`codeComparer.ts` + `index.html` + 语言包）

- 输入框默认留空 = **自动跟随上限**（`ensureThreadLimitUI` 填充、`startComparison`
  兜底同口径，读到留空时用 maxParallel 而不是 1）；用户手填仍最高优先级
- 上限公式 `cpu/2` → `round(cpu×0.6)`：旧公式的假设是每 worker 同时只有 1 个进程，
  prefetch 流水线后每槽 2–3 个并发进程，0.6 是 sweep 实测（8/10/12/16）中位最优档；
  4 核机 2、8 核机 5、20 核机 12，小机器不高于旧值
- 任务默认 `config.threadCount` 由 1 改为 NaN（= 未显式设置，跟随自动值），
  `mergeTaskConfigIfEmpty` 的 isFinite 语义不变
- i18n：`compare.threadHint` 更新、新增 `compare.threadsAutoPlaceholder`（留空自动），
  zh/en 键集同步

## 实测（同机 20 逻辑核，50 测试/场景，3 轮中位 + 收口复测）

| 场景 | 基线(8线程) | 第二轮(8线程) | 第二轮(12线程) | 收口复跑(12) | 全加速 |
|------|------------|--------------|---------------|-------------|--------|
| Sort  | 8.9  | 14.6 | 16.9 | **17.4** | **1.95x** |
| Graph | 19.1 | 19.9 | 26.4 | **25.9** | **1.36x** |
| Range | 5.1  | 6.6  | 7.4  | **7.7**  | **1.51x** |

用户视角：默认从 1 worker 起步，20 核机实际变成 12 worker —— 仅并行度纠偏一项
即 ≈4x（1 worker 实测 Sort 4.1 TPS → 12 worker 17.4 TPS），叠加第二轮流水线后
相对「优化前且默认设置」的总体提升在 **4–9 倍** 量级。

## 评估后否决的候选（留档防止重走）

- **生成器输入落盘 + 子进程继承 fd**（替代两路管道写 4.6MB）：微基准在真实全量
  4.6MB 下 pipe≈file（505±40ms vs 545±40ms，程序运行主导），1.4MB 截断数据上
  看到的 2x 差异是伪影。否决。
- **SAB 原子计数器动态领取**：循环头 `for (let i = startIdx; ...)` 的定次语义与
  「领到空为止」不可共存；改造必削 security-regression 真循环守卫或 engine 分片
  守卫的保护面，收益（尾差 ~5%）不抵守卫损失。否决。
- **fastspawn napi 零拷贝 / native stdin-drain 并发**：本机（win32）无法编译验证，
  WSL 无发行版；留待有 POSIX  runner 时再做。

## 复测命令

`/benchmark/` 与 `/compare-benchmark/` 已整体进 `.gitignore`（跑分日志、基准程序与
编译产物都是本地内容，不入库）。基准程序的口径：**纯 stdio 实现（scanf/printf，
不带 fastio）**——真实用户程序不保证有自定义快读，用 fastio 会低估 spawn/管道占比。
场景规格：Sort = 20 万随机数（gen → std::sort vs 归并）；Graph = 1e3 点 5e4 边最短路
（Dijkstra vs SPFA）；Range = 2e5 元素 2e5 操作区间和（BIT vs 线段树）；另有 _empty（空
程序，测固定开销）与 wrong_dijkstra（造 WA 用）。按上表规格现写 .cpp 后：

```bash
g++ -O2 -o compare-benchmark/progs/<name>.exe compare-benchmark/progs/<name>.cpp   # 9 个场景程序
node benchmark/bench-logged.js --threads 12 --log benchmark/logs/run.jsonl
OICPP_COMPARE_PREFETCH=0 node benchmark/bench-logged.js --threads 12   # 预取 A/B 开关
```