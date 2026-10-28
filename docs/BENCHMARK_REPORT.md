# OICPP 对拍器性能基准测试报告

## 测试环境

- **设备**: ARM64 Linux × 8 cores
- **Node.js**: v22.22.3
- **Electron**: v37.2.0
- **编译器**: g++ -O2 -std=c++14
- **测试日期**: 2026-09-11

## 测试场景

| 场景 | 算法A | 算法B | 数据规模 | 类型 |
|------|-------|-------|----------|------|
| Sort | std::sort | 手写归并排序 | n=200K | CPU 密集 |
| Graph | Dijkstra (堆优化) | SPFA | n=10K, m=50K | CPU 密集 |
| Range | 树状数组 | 线段树 | n=200K, q=200K | I/O 密集 |

所有场景为**不同算法产出相同结果**，符合真实 OI 对拍用例。

---

## 实验一：管线延迟 (单组测试)

### 串行 vs std/test 并行 (Promise.all)

| 负载 | 串行 (ms) | 并行 (ms) | 加速比 |
|------|-----------|-----------|--------|
| 轻量 sort 1K | 83.3 | 64.0 | 1.30x |
| 中量 逆序对 50K×50 | 87.9 | 75.3 | 1.17x |
| 大量 逆序对 1M×3 | 2599 | 1413 | 1.84x |

**结论**: 输出越大并行收益越高。小输出 spawn 开销占比大，大输出 CPU 计算占比大。

### 不同算法场景 (15次迭代平均)

| 场景 | 串行 (ms) | 并行 (ms) | 加速比 |
|------|-----------|-----------|--------|
| Sort: std vs mergesort | 396 | 265 | 1.49x |
| Graph: Dijkstra vs SPFA | 243 | 154 | 1.58x |
| Range: BIT vs SegTree | 764 | 502 | 1.52x |
| **平均** | **468** | **307** | **1.52x** |

---

## 实验二：Worker Pool 吞吐量

### 不同 worker 数 (200组中量)

| workers | 旧(限4) TPS | 新(限7) TPS | 加速比 |
|---------|-------------|-------------|--------|
| 1 | 10.1 | 11.7 | 1.16x |
| 2 | 11.9 | 14.9 | 1.25x |
| 4 | 11.2 | 12.9 | 1.15x |
| 8 | 12.5 | 14.3 | 1.14x |

**结论**: 线程数从 cpu/2 → cpu×0.9 后，worker 上限 +75%。

### V2 (Worker Threads) 多线程扩展

| 线程数 | Sort TPS | Graph TPS | Range TPS |
|--------|----------|-----------|-----------|
| 2 | 4.9 | 7.9 | 2.8 |
| 4 | 5.6 | 9.9 | 3.3 |
| 8 | 5.6 | 7.8 | 3.3 |

**结论**: 4 线程为峰值，8 线程无提升。瓶颈在 spawn 系统调用。

### V3 (Worker Threads + 预启动进程池)

| 线程数 | Sort TPS | Graph TPS | Range TPS |
|--------|----------|-----------|-----------|
| 4 | 7.9 | 11.6 | 4.1 |
| 8 | 6.3 | 8.9 | 3.9 |

**结论**: V3 相比 V2 提升 41% (Sort: 5.6→7.9)。预启动 spawn 与计算重叠。

---

## 实验三：Logger 写盘性能

### 逐条同步 vs 批量异步

| 行数 | 同步逐条 (ms) | 批量异步 (ms) | 加速比 |
|------|--------------|--------------|--------|
| 100 | 50 | 2 | 25.0x |
| 1,000 | 465 | 4 | 116.3x |
| 5,000 | 2,387 | 22 | 108.5x |
| 9,000 | 4,575 | 45 | 101.7x |

**结论**: 批量写盘 (200行/batch) 相比逐条写盘提升 ~100x。

---

## 实验四：硬件天花板分析

### Spawn 开销实测

| 指标 | 数值 |
|------|------|
| 空进程 spawn 平均 | 17.3ms |
| P50 | 16ms |
| P95 | 28ms |
| 每组测试 spawn ×3 | 51ms |

### 时间分解 (Sort 场景, 每组测试 ~95ms)

| 组件 | 耗时 | 占比 |
|------|------|------|
| spawn ×3 | 51ms | 54% |
| CPU 计算 | 35ms | 37% |
| 管道/IPC | 9ms | 9% |

### CPU 利用率

| 指标 | 数值 |
|------|------|
| 纯 CPU 计算时间 | ~35ms/组 |
| 8核理论最大 | 228 TPS |
| 当前实测 (V3) | 7.9 TPS |
| CPU 利用率 | 3.5% |

### 多核扩展性预测

| 核数 | 预期 TPS | CPU 利用率 | 原因 |
|------|----------|-----------|------|
| 4 | ~4 | 1.8% | 足够 |
| 8 | ~6.6 | 1.5% | 当前 |
| 16 | ~6.6 | 0.7% | spawn 串行瓶颈 |
| 32 | ~6.6 | 0.4% | 不会更快 |

**结论**: 更多核不会提升性能。`fork()+exec()` 是串行系统调用。

---

## 实验五：Electron 全栈架构对比

### 同台 Electron (20组测试, 4 workers)

| 场景 | 旧(runProgram IPC) | V3(WorkerThreads+预启动) | 加速比 |
|------|--------------------|-------------------------|--------|
| Sort | 15,176ms (1.3 TPS) | 3,552ms (5.6 TPS) | **4.28x** |
| Graph | 6,106ms (3.3 TPS) | 2,026ms (9.9 TPS) | **3.01x** |
| Range | 21,020ms (1.0 TPS) | 6,060ms (3.3 TPS) | **3.47x** |

### 同台 Electron (50组测试, 4 workers)

| 场景 | 旧(runProgram IPC) | V3(WorkerThreads+预启动) | 加速比 |
|------|--------------------|-------------------------|--------|
| Sort | 19,360ms (2.6 TPS) | 7,585ms (6.6 TPS) | **2.54x** |
| Graph | 7,868ms (6.4 TPS) | 5,041ms (9.9 TPS) | **1.55x** |
| Range | 25,303ms (2.0 TPS) | 13,571ms (3.7 TPS) | **1.85x** |
| **平均** | | | **1.98x** |

---

## 实验六：IPC 开销分析

### 旧架构 IPC 调用次数 (每组测试)

| 操作 | 次数 | 类型 |
|------|------|------|
| runProgram (gen/std/test) | 3 | 必需 |
| pathJoin | 6 | 可本地化 |
| ensureDir | 2 | 可预创建 |
| writeFile | 1 | 可合并 |
| checkFileExists + deleteFile | 2~4 | 可并行 |
| **总计** | **~15** | |

### 新架构 IPC 调用次数

| 操作 | 次数 |
|------|------|
| startCompare (1次启动) | 1 |
| onCompareProgress (事件) | 0 (被动) |
| **总计** | **1** |

### IPC 开销实测

| 架构 | IPC/组 | Electron 开销 |
|------|--------|--------------|
| 旧 (runProgram) | ~15 次 | ~15ms/组 |
| V3 (startCompare) | 0 次 | ~0ms/组 |

---

## 优化总结

| 优化项 | 实测收益 | 代码位置 |
|--------|----------|----------|
| P0: Logger 批量写盘 | **100x** 日志写盘 | `logger.js` |
| P1: 热路径日志削减 | 省 3s+ (1000组) | `main.js` |
| P2: std/test 并行 | **1.52x** 管线加速 | `codeComparer.js` |
| P3: 动态线程数 | +75% worker上限 | `codeComparer.js` |
| P4: 并行文件清理 | 2-3x 文件操作 | `codeComparer.js` |
| **P5: Worker Threads** | **3.5x** 真并行 | `compare-engine-v2.js` |
| **P6: 预启动 spawn** | **+41%** spawn 重叠 | `compare-worker.js` |
| **综合 (Electron)** | **2.0-4.3x** | 全部 |

---

## 文件清单

### 新增文件

| 文件 | 行数 | 内容 |
|------|------|------|
| `src/main-process/compare-worker.js` | ~120 | Worker Thread: 独立事件循环 + 预启动 spawn 流水线 |
| `src/main-process/compare-engine-v2.js` | ~110 | 对拍引擎: Worker Thread 线程池调度 |
| `src/main-process/compare-pool.js` | ~130 | 进程池: semaphore 并发控制 (备用) |
| `src/main-process/compare-engine.js` | ~240 | 对拍引擎: 主进程单线程版本 (备用) |

### 修改文件

| 文件 | 改动 | 内容 |
|------|------|------|
| `src/main.js` | +60行 | compare-start/stop IPC handler |
| `src/preload.js` | +6行 | startCompare/stopCompare/onCompareProgress API |
| `src/utils/logger.js` | +35行 | 批量写盘 + flushSync |
| `src/renderer/js/sidebar/codeComparer.js` | +57行 | 重构 runTask 为事件驱动 |

### 基准测试文件

| 文件 | 内容 |
|------|------|
| `benchmark/bench.js` | 综合管线基准 (串行/并行) |
| `benchmark/bottleneck.js` | 热路径微基准 |
| `benchmark/logger-bench.js` | Logger 同步/异步对比 |
| `benchmark/cpu-analysis.js` | CPU 利用率分析 |
| `benchmark/test-engine-v2.js` | V2 Worker Threads 单测 |
| `benchmark/test-v3.js` | V3 预启动流水线单测 |
| `benchmark/electron-v2.js` | Electron 全栈基准 |
| `benchmark/electron-final.js` | Old vs V3 最终对比 |
| `benchmark/e2e-hpc-test.js` | HPC 集成测试 (5/5 PASS) |
| `benchmark/e2e-integration.js` | CompareEngine 集成测试 (13/13 PASS) |

---

## 架构变更

```
旧架构: renderer → 30+次IPC → main.js → spawn → IPC → renderer
        (每组测试 30+ 次往返)

V3架构: renderer → 1次IPC → CompareEngineV2 → Worker Thread(s) → spawn
        (1次启动, 事件驱动, 独立事件循环, 预启动进程)
```

---

## 实验七：V4/V5/V6 进阶架构探索

### V4: 流式 tee 管道 (gen.stdout 直接分流给 std/test)

| 场景 | V3 (4线程) | V4 (4线程) | 结论 |
|------|-----------|-----------|------|
| Sort | 7.4 TPS | 5.4 TPS | 更慢 — 批量程序无流式收益, 丢失 fork 重叠 |
| Graph | 8.3 TPS | 7.2 TPS | 更慢 |
| Range | 4.9 TPS | 3.3 TPS | 更慢 |

**结论**: 对拍程序是批处理 (读全量输入再计算), 流式管道无法重叠计算, 反而增加 fork 竞争。

### V5: 全流水线预启动 (3 fork 全部重叠到计算期)

| 场景 | V3 (4线程) | V5 (4线程) | 结论 |
|------|-----------|-----------|------
| Sort | 9.0 TPS | 4.6 TPS | 更慢 — 迭代内 3+3 fork 竞争, 且存在竞态 bug |
| Graph | 7.9 TPS | 6.3 TPS | 更慢 |
| Range | 4.7 TPS | 2.1 TPS | 更慢 |

**结论**: 更多并发 fork 不等于更快, 内核 fork 锁成为瓶颈。

### V6: 原生 posix_spawn 同步执行 (N-API 插件)

| 场景 | V3 (4线程) | V6 (4线程) | 结论 |
|------|-----------|-----------|------| 
| Sort | 8.1 TPS | 1.3 TPS | 更慢 — 同步阻塞 worker 事件循环, 丢失所有重叠 |
| Graph | 10.7 TPS | 2.2 TPS | 更慢 |
| Range | 5.5 TPS | - | 更慢 |

原生 posix_spawn 本身快 2x (17ms→7.7ms), 但同步阻塞整线程使测试串行化, 得不偿失。

### 关键发现: 程序 IO 才是真瓶颈

对拍程序本体是 CPU 密集, 但 IO 占了 70%+ 时间:

| 程序 | scanf/printf | 快IO (fread/fwrite) | 加速 |
|------|-------------|--------------------|------|
| gen_sort | 144ms (43ms user) | 77ms (43ms user) | 1.9x |
| sort_std | 308ms (256ms user) | 117ms (71ms user) | 2.6x |
| sort_mergesort | 308ms (280ms user) | 138ms (93ms user) | 2.2x |

**结论: 评测机/用户的 C++ 程序若不用快IO, 对拍上限被 scanf/printf 拖垮。这是最值得写进 Issue 的优化建议。**

### V3 最终线程扩展 (快IO 程序)

| 线程数 | Sort | Graph | Range |
|--------|------|-------|-------|
| 1 | 10.2 | 11.4 | 3.9 |
| 2 | 10.1 | 10.8 | 3.7 |
| 4 | **10.3** | **11.6** | **4.1** |
| 6 | 9.1 | 10. Feldman | 3.6 |
| 8 | 8.0 | 9.呼叫 | 3.3 |

**峰值在 4 线程; 更多线程因 Node 管道 I/O 调度开销反而下降。**

## 最终结论

1. 对拍性能天花板: Node.js 子进程管道 I/O + 每测试 3 次 spawn, 而非 CPU 核数
2. 纯 JS 最优解: **V3 预启动流水线 + 4 线程** = Sort 10.3 / Graph 11.6 / Range 4.1 TPS
3. 原生插件 (posix_spawn): spawn 快 2x, 但同步阻塞吞掉全部重叠, 不如纯异步
4. 给用户的最大红利: 提醒使用 fast IO (printf/scanf → fread/fwrite), 单程可快 2x

---

## 实验七：Fast-IO 基准程序 (scanf/printf → 自研快读快写)

### 发现

基准程序的 `scanf/printf` 是隐藏瓶颈 (stdio 逐字符解析 + 逐格式串处理):

| 程序 | 旧 (scanf/printf) | Fast-IO (自研fread/fwrite) | 加速 |
|------|-------------------|--------------------------|------|
| gen_sort (200K输出) | 144ms real / 118ms user | 77ms real / 43ms user | 1.9x |
| sort_std (200K输入+输出) | 308ms real / 256ms user | 117ms real / 71ms user | 2.6x |
| sort_mergesort | 308ms real / 280ms user | 138ms real / 93ms user | 2.2x |

### Electron 全栈最终数据 (50组测试, 4线程, fast-IO 程序)

```
场景       旧(runProgram IPC)     V3(WorkerThreads+预启动)    加速比
────────────────────────────────────────────────────────────────────
Sort        23292ms  2.1 TPS      5564ms   9.0 TPS            4.28x
Graph        6726ms  7.4 TPS      4036ms  12.4 TPS            1.67x
Range       19261ms  2.6 TPS      9615ms   5.2 TPS            2.00x
────────────────────────────────────────────────────────────────────
平均加速: 2.6x (Sort 峰值 4.3x)
```

### 原生 posix_spawn 实验 (fastspawn.cc, N-API)

| 方式 | 空进程 spawn | 说明 |
|------|-------------|------|
| Node fork() | 17.3ms | libuv spawn |
| 原生 posix_spawn | 7.7ms | 2.2x 快 |

- 同步原生 run() 虽快但阻塞 worker 线程事件循环, 无法管线重叠 → 实际吞吐反而低于 V3
- 原生 spawn 返回 fd + 异步流 组合 (V7) 有 fd 泄漏与竞态问题 → 放弃
- **结论: V3 的异步管线 + 预启动重叠是纯 Node.js 架构最优解**

### 线程数扩展 (fast-IO 程序, V3)

| 线程数 | Sort | Graph | Range |
|--------|------|-------|-------|
| 3 | 10.5 TPS | 11.3 TPS | 5.3 TPS |
| 4 | 8.8 TPS | 12.4 TPS | 5.0 TPS |

**结论**: 4 线程为最佳平衡点; 5+ 线程出现 fork 竞争与 EPIPE 稳定性问题。

### V8 验证 (原生 spawn + 异步 fd 流)

| 场景 | V3 (纯异步) | V8 (原生spawn) | 结论 |
|------|-----------|--------------|------|
| Sort 3线程 | 10.5 TPS | 9.3 TPS | 无增益 |
| Graph 4线程 | 12.4 TPS | 11.9 TPS | 无增益 |

**结论**: posix_spawn 的 ~10ms/测试节省已被 V3 预启动重叠完全隐藏。
多 worker 并发下裸 fd 跨线程竞态 (EBADF/僵尸堆积) 不可修复 → **V3 是最终架构**。

## 最终结论

从原始 1.3 TPS (Sort) 到 9.0 TPS (Electron) / 10.0 TPS (Node direct):
**累计加速 7.7x**, 架构上限分析 (8核, 每测试3进程串行工作流):

| 瓶颈 | 占比 (旧) | 占比 (新) |
|------|----------|----------|
| 进程 spawn/exec | 54% | 45% (隐藏部分) |
| 程序运行时 (含IO) | 37% | 35% |
| 管道/IPC | 9% | 20% |

纯 Node.js 的架构极限在 ~10 TPS。超过需要:
1. C++ 原生引擎 + io_uring 异步 I/O
2. 常驻进程协议 (testlib 风格) 消除 spawn
3. 用户程序 fast-IO (scanf/printf 是隐藏的 2-3x 成本)

---

## 实验八：V6 原生 posix_spawn — 真正的突破

### 关键修正

之前 V6 判定"失败"是测试 harness bug: 单 worker 收到 N 个 run-tests 消息,
同步原生调用串行化消息 → 首个 done 即被 harness 终止, 只剩 1 个分片跑完。

**正确做法: N 个独立 Worker, 各跑 1 个分片** (与生产引擎一致):

| 场景 | V3 (Node spawn) | V6 (原生 posix_spawn) | 提升 |
|------|----------------|----------------------|------|
| Sort 8线程 | 10.5 TPS | **16.7 TPS** | +59% |
| Graph 6线程 | 12.4 TPS | **25.1 TPS** | +102% (达理论上限) |
| Range 8线程 | 5.3 TPS | **7.1 TPS** | +34% |

### Electron 全栈最终 (8 线程, 50 测试)

```
场景       原始(runProgram)     V6(原生引擎)              总加速
──────────────────────────────────────────────────────────────
Sort        1.3 TPS             16.1 TPS                  12.4x
Graph       3.3 TPS             19.1 TPS                   5.8x
Range       1.0 TPS              8.2 TPS                   8.2x
```

### 为什么有效 (对比失败路径)

| 方案 | 结果 | 原因 |
|------|------|------|
| V6 同步原生 + 单worker多分片 | 假失败 | harness 首个 done 终止 |
| V8 原生 spawn + 异步 fd 流 | EBADF | fd 进程级全局, 跨线程竞态 |
| **V6 同步原生 + 每 worker 一薄分片** | **16-25 TPS** | 每线程 = 1 OS 线程串行, 无事件循环阻塞, fd 全在 addon 内部 |

### 教训

- Node 的 async spawn (V3) 到 ~10 TPS 就撞上 fork+exec 系统调用 + 事件循环开销
- 原生同步 (V6) 不是"阻塞"问题 — 每个 Worker Thread 就是独立 OS 线程,
  同步调用只占该线程; 正确分片后并行度 = 线程数, 无任何共享状态
- 之前 7 轮实验多次因工具链损坏(字符乱码)/harness 缺陷得到错误结论

## 实验八附：V8 原生 spawn + 异步 fd 流 (失败) — 关键架构发现

### 设计
V3 管线重叠 + 原生 posix_spawn 返回裸 fd + Node fs 流异步读写 + waitpidBlocking 收割。

### 结果

| 阶段 | 结果 |
|------|------|
| 单 worker 单测试 | 通过 (3 tests: 531ms) |
| 单 worker 多测试 | 通过 (10/25/34 tests 全部通过) |
| 多 worker 并发 | **全部失败**: generator 5s 超时, 僵尸进程堆积 |

### 根因：文件描述符是进程级全局资源，跨 worker 线程竞态

```
1. worker A spawn → fd 26 (stdout pipe)
2. worker A 测试结束, _reap 中 closeSync(26) 关闭 fd
3. worker B 并发 spawn → 内核复用 fd 26
4. worker A 的旧 fs.ReadStream 延迟 destroy → 关闭"fd 26"
   → 实际关闭了 worker B 进程的管道 → EBADF / 数据串线
```

- `fs.createReadStream(null, { fd })` 的流对象销毁是异步的，与另一线程的 fd 复用产生竞态
- 这是 Node.js 架构性限制：**原生模块返回裸 fd 后，无法与 Worker Thread 的异步流安全共存**
- 实测证据：UV_THREADPOOL_SIZE=32 后出现 `EBADF: bad file descriptor, write` 崩溃；进程表中僵尸数每 3s +3

### 结论（重要）

| 方案 | 结论 |
|------|------|
| 原生同步 run (V6) | 快但阻塞事件循环 → 无管线重叠 → 反而慢 |
| 原生 spawn + 异步流 (V7/V8) | fd 跨线程竞态，不可修复 |
| **V3 纯异步 spawn + 预启动管线** | **Node.js 架构下的最终可行方案** |

**V3 以正确 harness 实测: Sort 7.6 TPS / Graph 8+ / Range 5+。**
此前的 10.4 TPS 是 harness 单 worker 并发共享状态的测量假象。

## 实验九：V10 原生 runPair (std+test 双线程并行)

### 动机
V6 每 worker 串行 gen→std→test。std 与 test 只依赖 gen 输出、彼此独立，可并行。原生层用两个 pthread 同时跑 std 和 test。

### 实现 (fastspawn.cc)
- 提取 `runOne()` 纯 C helper（不碰 napi，只做 spawn/write/drain/waitpid），Run() 重构为调用它
- 新增 `runPair` 导出：两个 pthread 并行 runOne，pthread_create 失败回退串行；pthread 内严禁 napi 调用
- worker: gen 后一次 runFastPair(std, test, input) 替代两次 run

### 结果 (Node 直接, 8 线程, 50 测试, 日志 benchmark/logs/runpair-8t-50.jsonl)

| 场景 | V6 (前) | V10 runPair | 提升 | CPU 理论上限 | 效率 |
|------|---------|-------------|------|-------------|------|
| Sort | 17.4 TPS | **19.9 TPS** | +14% | 23.1 | 86% |
| Graph | 23.6 TPS | **24.8 TPS** | +5% | 33.0 | 75% |
| Range | 7.3 TPS | **8.3 TPS** | +14% | 8.9 | 93% |

线程扫描：6 线程 16.3/24.4/8.1，10 线程 18.2/21.1/8.0，12 线程 14.9/18.9/7.9 → 8 线程仍最优

### Electron 全栈 (50 测试)
Sort 16.0 / Graph 23.5 / Range 8.9 TPS（worker 独立进程加载新 .node，无需重启 Electron；但 main 进程缓存旧模块时 runPair 不存在，需重启 Electron 加载新 fastspawn.node）

### 结论
- std+test 并行消除了串行等待，wall 时间降 15%+，CPU 总量不变（CPU-bound 上限不受影响）
- 8 线程 + runPair 是当前最优配置；总优化链路 1.3→19.9 TPS = **15.3x**（Sort）

---

## 实验十一：V11 — 修复 stdin 写循环误杀 + C 层归一化判等

### 先说结论

工作区里那版未提交的重构（std/test 改为每次 `spawn(process.execPath, [timeout-wrapper.js])`）
实测比 HEAD 的原生路径**慢一倍**，且打包后**根本跑不起来**。本实验把原生路径恢复，
顺带修掉一个一直在悄悄吞测试的 native bug，并把输出判等下沉到 C 层。

| 场景 | 工作区版 (timeout-wrapper) | HEAD 原生 + 本次修复 | V11（含 C 层判等） | V11 vs 工作区版 |
|------|---------------------------|----------------------|-------------------|----------------|
| Sort | 25888ms (0 失败) | 11966ms | **10462ms** | **2.47x** |
| Graph | 16082ms (0 失败) | 6426ms | **6536ms** | **2.46x** |
| Range | 48223ms (0 失败) | 28675ms | **24286ms** | **1.99x** |

（25 组/场景 × 3 交错重复取中位数 wall time，三者失败数均为 0，日志 `benchmark/logs/ab/`）

Graph 那栏 V11 比「HEAD 原生 + 修复」略慢属噪声：Graph 的输出只有几行，
C 层判等在那里本来就没有可省的活。

### 缺陷一：poll 超时被当成错误，健康子进程被 SIGKILL（本次最重要）

`fastspawn.cc` 的 stdin 写循环判错写成：

```c
int wr = (remain < 0) ? poll(&writeFd, 1, -1) : poll(&writeFd, 1, ...);
if (wr <= 0 && errno != EINTR) { kill(-pid, SIGKILL); break; }
```

**`poll()` 超时时返回 0 且不改动 `errno`。** 此时 `errno` 还是上一步 `write()` 留下的
`EAGAIN`，条件于是成立 —— 「子进程只是还没来得及读」被当成错误，健康的 std/test 被
SIGKILL，收割状态折算成 `128 + 9 = 137`，对拍里显示为 `std_re: standard program exit 137`。

触发门槛仅仅是**输入大于管道缓冲**（默认 64KB），也就是任何真实规模的生成数据。
实测空闲机器上单次 `run(range_bit, 3.5MB, 20000ms)` 在 **139ms** 就被杀 —— 与负载无关，
与截止时间无关，百分之百复现。

这就是历史上 Range 场景 0/50、Sort 偶发 `std_re` 的真正原因。同文件里 `drainBoth`
对同一个 `pr == 0` 分支的处理一直是正确的（`continue`），只有写循环漏改。

修法：抽出 `pump()`，`pr == 0` 一律 `continue`；只在截止时间到达时 kill，并且
**直接返回 -3**，绝不从收割状态反推超时（反推正是 137 的来源）。`errno` 必须在
`write`/`read` 之后立刻存进局部变量再判断。

守卫：`tests/fastspawn-io-pump.test.js`（真起子进程的行为断言，win32 自动跳过）。

### 缺陷二：「先写完 stdin 再收输出」的两段式写法会死锁

`run()` 是 CPU 密集的，但父进程把 input 全部写完之前完全不去读子进程的 stdout。
`cat` 这类边读边写的程序把输出管道写满后就停住不再读输入，而我们还堵在写输入上 ——
双方互等，只能靠超时收场。实测 `run(cat, 2MB)` 耗满截止时间返回 -3。

修成 `pump()` 交错进行后：`run(cat, 2MB)` = **85ms**，且输出与输入逐字节相同。
附带收益：喂数据与被测程序计算重叠，每组白赚一段并行。

### 缺陷三：原生路径丢掉 stderr

`runOne()` 捕获 stderr 之后在函数末尾直接 `free(errBuf)`，从不回传。于是原生路径下
一次段错误只能显示成「standard program killed by SIGSEGV」而没有任何崩溃栈。

这不是架构限制，只是实现疏漏。现在 `run`/`runPair` 都回传 stderr（独立上限 64KB：
只可能用前缀诊断，同时把 worker 最坏驻留内存从每线程 2×(64MB+64MB) 压到 2×(64MB+64KB)），
并把 `truncated` 收窄为**只看 stdout** —— 原先 `truncatedOut || truncatedErr`
会让一个正常退出但喷了 70MB 日志的程序被误判 `output_limit`。

这正是工作区那版重构唯一的真实收益，现已吸收进原生路径。端到端实测：
RE 的 message 现在是 `FATAL: assertion failed in solver.cpp:42`。

### C 层归一化判等

`normalizeOutput` 在 JS 里是 `toString('utf8') + replace + split/map/join`，
MB 级输出下实测每组 **67-292ms**（Sort 的 1.97MB 单行输出 67-98ms；
Range 的 875KB / 99,635 行 244-292ms），而同尺寸 `memcmp` 不到 1ms。

现在 `runPair` 第 5 参 `compare` 为真时在 C 层原地归一化并判等，相等时连两段大输出的
跨边界拷贝都省掉（相等是最常见的路径）。原地归一化成立的理由：归一化只会**删**字节，
写游标恒不超过读游标，不需要第二块缓冲。

**假 WA 防护**：`normalizeOutput` 先 `.toString('utf8')`，无效字节序列各自塌成一个
U+FFFD，因此存在「字节不同而解码相同」的两段输出，JS 判相等而 `memcmp` 判不等 ——
那会是一次无声的 AC→WA。所以 C 层只在**两侧都是纯 ASCII** 时自己下结论
（此时 UTF-8 解码是单射，字节相等 ⇔ 字符串相等）；任一侧出现 `>= 0x80` 就回 `-1`
不裁，把两段交回 worker 的 `outputsEqual` 终裁。真实评测数据都是 ASCII，这条回退
几乎不触发，但它是唯一能证明「不会假 WA」的兜底。

等价性守卫：`normalizeCompare` 导出真实的 `normalizeInPlace` + `compareNormalized`，
测试里与**从生产 worker 源码抽出的** `normalizeOutput` 逐条对拍
（22 条手写边界 + 4000 条定种子 fuzz，字母表专挑 `\r`/`\n`/空格/制表符的组合，
其中 2767 条判等 / 1233 条判不等），全部一致。参照物不在测试里重抄一份，
否则它会跟着源码漂移，然后两边都「对」。

### 附带修复

- `runJsPair` 用 `Promise.all` 并行跑 std/test。HEAD 的回退路径是**串行**的，
  白白丢掉 runPair 的全部收益；而 Windows 上根本没有 `.node`，回退路径就是生产路径。
- 生成数据长度不再 `Buffer.from(genOut.output).length` —— 那会为拿一个数字把整块
  MB 级输入再拷一份。
- 默认并行度改用 `os.availableParallelism()`：`os.cpus().length` 看不见 cgroup 配额
  与亲和性掩码，本机报 8 而实际允许 3-4，按它起 worker 是 2 倍超订，测到的排队时间
  会被误当成引擎性能。基准脚本同步采用。

### 环境说明（绝对值不可与实验八/九直接比）

本轮机器 `Cpus_allowed_list` 只有 **3-4** 个 CPU，而 `os.cpus().length` 报 8；
可用内存约 2.6GB；node 冷启动 339-377ms。文档里 23.3 / 33.1 / 10.1 TPS 是当年
8 核空闲机器的绝对值，这里**不可比**，因此本实验全部用同机交错 A/B 的相对值。

另外本轮再次确认了实验八的教训：串行分批跑 A/B 会被机器负载漂移骗到。
第一次跑出的「工作区版 Range 1779ms/组 vs V11 2649ms/组」是假结论 ——
交错重跑后工作区版是 V11 的 1.99 倍耗时。同一个 worker 在两次运行里
`gen` 从 190ms 跳到 627ms，足以说明问题。

### 复现

```bash
pnpm run prebuild:native                 # 重建 fastspawn.node（改完 .cc 必须重建，
                                         # 否则 runPair 的新 compare 参数被静默忽略）
npx tsc -p tsconfig.build.json           # .ts 是唯一手写源
node benchmark/bench-logged.js --scenario Range --tests 12 --worker <path>   # 单场景对照
node tests/fastspawn-io-pump.test.js     # native 层行为守卫
```

---

## 实验十二〜二十：V12-V20（生成器路径、判等快路、以及「提前投递」的不可行性证明）

### 先更正本会话自己的一条错误结论

实验十一里我写过「原生跑生成器**无收益**（gen_sort 1.15x、gen_graph 1.56x、gen_range 0.92x
反而更慢）」。那个结论是**错的**，错在量具：我用的是墙钟，而且没有钉核，而本机
`Cpus_allowed_list` 会在一次会话中途从 3 变到 4 再变到 8。同一份 worker 的 `gen` 阶段
在两次运行里从 190ms 跳到 627ms，足以说明那次测量的分辨率根本不足以判 10% 量级的差异。

V12 用 CPU 口径重测之后，结论反转：生成器路径是**剩余最大的单项收益**。

### 方法论升级（这一轮才真正建立可信的比较）

1. **钉核**：所有跑批经 `taskset -c 0-3`。另注意 `taskset -c 0-7` 在 cpuset 只授 0-3 时会
   **静默成功并降级到 0-3**（内核取交集），所以「请求了几个核」必须回读 `Cpus_allowed_list`
   确认，不能看 taskset 的返回码。
2. **用 CPU 而不是墙钟作判据**：`process.cpuUsage()` 即 `getrusage(RUSAGE_SELF)`，含全部
   worker 线程且不含子进程，正好是「引擎自身 CPU」，不受争抢影响。墙钟在本机对 1-2% 量级
   的效应没有分辨率。
3. **交错 + 偶数轮反序**：`benchmark/ab.js` 在同一轮内跑完所有 (场景, 变体) 再进下一轮，
   且偶数轮反转变体顺序，避免「总排后面那个」系统性吃亏。
4. **正确性闸门先于性能闸门**：`benchmark/equiv-check.js` 先逐条比对各实现的 kind 序列
   （含一个故意不等价的 ForceDiff 场景，用来抓「把不等判成相等」这个方向），**只有结论
   完全一致的实现才允许进入基准环节**。性能优化最危险的失效方式是结论变了但速度数字很好看。

### 总览

| 编号 | 内容 | 结论 |
|------|------|------|
| **V12** | 生成器输出改由 C 捕获（无 args/cwd 时走 `fast.run`） | **采用**。引擎 CPU −38%，吞吐 +10~23% |
| **V13** | `outputsEqual` 原始字节短路 | **采用，但仅 Windows 有效**（回退路径 Range CPU −40%；Linux 原生路径 0.0%） |
| **V14** | C 层 `normalizeInPlace` 之前加 raw memcmp | **淘汰**。Sort 省 19.8ms 过线，Range 省 −1.8ms 不过线 |
| **V15** | 融合 `runTriple` / 让 std/test 提前拿到输入 | **淘汰，且不可行**：收益只能用错判换来（见下） |
| **V16** | 时限锚点守卫（V15 的产物） | **新增为回归测试** `tests/compare-timeout-anchor.test.js`，4/4 PASS |
| **V17** | 线程数策略 | 维持现状：每 worker 实际索取 1.4-1.65 核，`availableParallelism` 对吞吐是对的 |
| **V18** | 异质负载下动态分片实测 | **无差别**（dynamic/static = 1.005，落在噪声带内） |
| **V19** | DrainBuf 复用 / 管道容量 / 读块大小调优 | **零收益**，低于本机测量分辨率 20-60 倍 |
| **V20** | V12 + V13 组合（已进产品源码） | 72/72 全过，等价闸门 SAME |

### V12 明细：生成器捕获

`compare-worker-v6.ts` 原来无论什么情况都用 `runJs`（child_process + stream `data` 回调 +
`Buffer.concat`）捕获生成器输出。实测两种机制的引擎 CPU 单价：

| 捕获方式 | 引擎 CPU |
|---|---|
| Node stream 逐块回调 + concat | **43.2 ms/MB** |
| addon 的 C pump | **13-15 ms/MB** |
| `readFileSync`（不经管道） | 2.5 ms/MB |

于是 `runGenerator` 在「无 args 且无 cwd」时改走 `fast.run()`；Python 生成器
（解释器 + 脚本参数）仍然走 `runJs`。

钉核 `0-3`、threads=4、每场景 24 组 × 3 轮、对照 V11 完整还原件：

| 场景 | 墙钟 | 引擎 CPU/组 | 失败 |
|---|---|---|---|
| Sort | 1.142x | 272.8 → **168.0ms** (1.624x↓) | 0/72 |
| Graph | 1.228x | 141.9 → **87.9ms** (1.614x↓) | 0/72 |
| Range | 1.102x | 367.9 → **217.8ms** (1.689x↓) | 0/72 |

与独立测得的分母完全对得上：引擎原本占总 CPU 的 17.2-17.5%，砍掉约 45% 的引擎 CPU
≈ 总 CPU 的 7.7%，实测吞吐 +10%（Range）。CPU 密集型负载下「省下的 CPU」直接兑换成吞吐，
这个链路是闭合的。

**⚠ V12 带来的语义变化（必须知道）**：渲染层 `codeComparer.ts:809` 把 `generatorTimeout`
**恒设为 0（不限时）**。原生调用是同步的、`stop` 与 `worker.terminate()` 都打不断，
所以沿用 std/test 已有的 `UNLIMITED_RUN_FALLBACK_MS` —— 「不限时」在原生捕获下实际是
**60s 上限**，而此前经 child_process 可以真的无限等。取舍依据：跑超过 60s 的生成器几乎
必然是死循环，而旧行为是把整轮对拍无声挂死且不给任何反馈。**若不接受这条，就让
`runGenerator` 在 `timeout === 0` 时回退 `runJs`，代价是 V12 在生产配置下失效。**

**V12 顺带修掉的一个静默截断**：原生捕获超限后是「继续读但丢弃」，生成器照样退出 0。
所以主循环的生成器闸门加上了 `genOut.outputTruncated` —— 不拦就会拿一份被截断的输入去跑
std/test，两边算出同一个错答案然后判你 AC。旧路径靠杀进程间接暴露，换成原生后不会了。

### V13 明细：判等快路（仅 Windows）

回退路径把 `verdict` 硬编码为 -1，于是**每个 AC 都要跑两遍 `normalizeOutput`**
（`Buffer.from` + `toString` + `replace` + `split/map/join`）。加上原始字节相同就直接返回：

| 回退路径 | Sort | Graph | Range |
|---|---|---|---|
| 引擎 CPU/组 | 1.193x↓ | 0.973x | **1.661x↓** |

审计明确记录的一条限制：**这条在 Linux 的原生路径上是 0.0%**（0.132 → 0.115 ms/组），
因为 `verdict === 1` 在 `judgePair` 里先返回，`outputsEqual` 根本不会被调用。它的价值
是 Windows（那里没有 `.node`，回退路径就是生产路径），不能当成引擎整体吞吐来汇报。

快路无条件安全：字节相同 ⇒ 归一化与 UTF-8 解码后必然相同（两者都是字节的函数，与是否
合法 UTF-8 无关），所以它不削弱、也不触碰「非 ASCII 不自己下结论」那道闸门。

### V15 最重要的发现：时限与「提前投递」不可兼得

融合方案（gen 的 stdout 在 C 里广播给 std+test，输入不进 JS）实测每组墙钟
Range −32% / Sort −40% / Graph −36%，看着很香。它**不可实现**，因为超时锚点两个方向都会
产生错判，而且都错得无声，两边都有实测样本：

- **锚在 spawn** → 子进程被算上生成器那段时间。只要 `timeout < 投递完成墙钟`，两个都正确的
  程序就被判成 TLE。实测：投递耗时 1073ms、时限 1000ms → 返回 `0/137/137`，而两个程序本身
  只需 157-195ms。**假 TLE**。
- **锚在输入投递完成** → 子进程白拿「投递前它自己空转的那段 CPU」。实测：`range_bit` /
  `range_segtree` 需要 787/911ms CPU，时限 500ms，融合版返回 `0/0/0` **且答案全对**。**假 AC**。

形式化：**任何锚在 spawn 的时限，只要 `timeout < 投递墙钟` 就造出假 TLE；任何锚在
input-complete 的时限，只要投递前空转超过时限余额就造出假 AC。** 唯一与现有语义等价的
策略是「生成器退出之前一个字节都不许投」，而那正好把 −32% 整个删掉。

这一条同时 retroactively 解释了 **V4 为什么必然失败**（不只是「更慢」），并且顺手否掉了
「预启动下一组的 std/test」这类想法：那是同一个投递前计算的机制换了个外壳。

产物是 `tests/compare-timeout-anchor.test.js`：生成器慢于时限、std/test 快且答案正确时
必须判通过且不得出现任何 `*_tle`；同时保留「答案不同仍报 mismatch」与「真超时仍报
std_timeout」两条反向断言，防止有人为了绕过问题而把时限关掉。

### V18 / V19：测出来是「没有」的两条

- **V18 动态分片**：纸面结论是 0%（基准生成器耗时 cv 只有 0.059）。为了不把纸面当实测，
  造了双峰异质夹具重跑：8 轮全部 0 失败，dynamic/static = 1.005，**无差别**。
  *harness 缺陷自曝*：脚本里那个 `cv=0.761` 是混了语义算的 —— 静态模式 `w.__t0` 只在启动时
  设一次，记录的是**整片**耗时，动态模式记录的才是**单组**耗时。所以该 cv 不能当异质度证据，
  有效证据是夹具单独测出的规模 cv=0.864（n 跨度 5193-187238）。
- **V19 缓冲复用 / 管道容量 / 读块大小**：直接测 `drainAppend` 的分配链、pipe 往返次数、
  读块尺寸的影响，收益为零到 0.19%，低于本机测量分辨率 20-60 倍。另外确认
  `F_SETPIPE_SZ` 请求的 1048576 就是本机 `pipe-max-size` 上限，V11 那一步已经吃满。

### 一次「夹具自己造假失败」的教训

V18 第一版把生成规模放到 400k，实测 `sort_mergesort` 在 **n ≥ 250000 时堆破坏崩溃**
（它的输出 md5 恰好是空输入的 `d41d8cd9…`），于是 13/20 组「失败」是夹具造的。拿那批数据
比较两种分片策略，得出的方向是反的。现在 `v18-sharding.js` 的做法是：**任何一轮出现失败
就整轮作废、不参与结论**，并且夹具在测量前必须自校验（当前 0/20 不一致）。

### 复现

```bash
pnpm run prebuild:native            # 改完 fastspawn.cc 必须重建，否则新参数被静默忽略
npx tsc -p tsconfig.build.json

# 1) 先过正确性闸门（结论不一致就不许进基准）
node benchmark/equiv-check.js --cases 6 \
  --worker V11=benchmark/variants/worker-v11-control.js \
  --worker V20=src/main-process/compare-worker-v6.js
# 2) 钉核 + 交错 + CPU 口径
node benchmark/ab.js --cpus 0-3 --threads 4 --tests 24 --reps 3 \
  --scenario Sort,Graph,Range \
  --worker V11=benchmark/variants/worker-v11-control.js \
  --worker V20=src/main-process/compare-worker-v6.js
# 3) 变体单独造
gcc -O2 -o benchmark/fixtures/gen_mixed benchmark/fixtures/gen_mixed.c
taskset -c 0-3 node benchmark/v18-sharding.js --threads 4 --tests 20 --reps 4
```

变体 id 与最终编号的对应：`worker-v12.js`=V12，`worker-v15fb.js`=V13（回退路径），
`worker-v14.js`/`fastspawn-v14.node`=V14，`worker-v11-control.js`=对照 V11，
`src/main-process/compare-worker-v6.js`=V20。文件名沿用开发期 id，未随编号重命名。

### 本轮净结论

引擎的 CPU 天花板已经摸清：**runPair 的 std/test 重叠已到 90-100% 效率、T=4 就吃满可得
CPU、静态分片在均匀与异质负载下都不劣于动态**。剩下的真实收益在「引擎自己烧掉的 CPU」，
V12 把它砍掉约 38%，V13 在 Windows 上再砍最多 40%。想再往上只剩「常驻进程协议消除
exec」这一条，而那需要用户程序配合，不在引擎能单方面决定的范围内。
