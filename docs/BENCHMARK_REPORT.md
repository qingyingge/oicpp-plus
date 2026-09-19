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
