# [Performance] 对拍器多线程利用率低，大规模对拍耗时远超预期

## 描述

对拍器 (`codeComparer.js`) 存在多处性能瓶颈，导致大规模对拍（100+ 组）耗时远超预期：
1. logger 同步写盘 (`fs.appendFileSync`) 逐条写入，1000 组对拍 9000 条日志耗时 4.6 秒
2. `run-program` IPC handler 每次执行记录 3 条日志，占热路径开销
3. std/test 程序串行执行，浪费约 40% 的管线时间
4. 线程数限制 `cpuThreads/2` 过于保守，仅利用 50% CPU
5. 文件清理 `cleanupFreopenContext` 使用 `for...of` 串行删除

## 重现步骤

1. 打开对拍器面板，配置标准程序、测试程序、数据生成器
2. 设置 1000 组测试，线程数取默认最大值
3. 点击开始对拍
4. 观察对拍耗时远超预期

## 预期行为

1. std/test 应并行执行（二者互不依赖）
2. 日志写盘不应阻塞对拍热路径
3. 线程数应接近 CPU 满载而非一半

## 实际行为

### 瓶颈定位

| # | 瓶颈 | 代码位置 |
|---|------|----------|
| 1 | logger 同步写盘 `fs.appendFileSync` 逐条写入 | `logger.js:157` |
| 2 | run-program 热路径每程序 3 条日志 | `main.js:4616-4813` |
| 3 | std/test 串行执行 | `codeComparer.js:843-931` |
| 4 | 线程数限制 `cpuThreads/2` | `codeComparer.js:1261` |
| 5 | 文件清理串行删除 | `codeComparer.js:1162` |

### 实测数据

使用附件 `compare-benchmark.zip` 复现（不同算法产出相同结果）：

```
Pipeline latency: serial vs parallel (15 iters)

Scenario                  Serial    Parallel   Speedup
--------------------------------------------------------------
Sort: std vs mergesort       816ms     486ms   1.68x
Graph: Dijkstra vs SPFA      456ms     282ms   1.62x
Range: BIT vs SegTree       1965ms    1233ms   1.59x
--------------------------------------------------------------
Average                     1079ms     667ms   1.62x

Worker pool throughput (30 groups, parallel mode):
  Sort:   1w=1.9  2w=3.2  4w=3.8  8w=4.3 TPS
  Graph:  1w=3.3  2w=5.2  4w=6.7  8w=7.4 TPS
  Range:  1w=0.7  2w=1.2  4w=1.7  8w=1.9 TPS

Logger bottleneck (9000 lines = 1000 tests x 9 lines):
  Sync  (per-line): 4575ms
  Batch (200-line):   45ms
  Speedup:          101.7x
```

## 附加上下文

### 根因分析

**瓶颈 1: logger 同步写盘**

`logger.js:157` 使用 `fs.appendFileSync` 逐条写盘：

```javascript
write(level, ...args) {
    const line = `[${ts}] [${level.toUpperCase()}] ${Logger.stringifyArgs(args, { level })}\n`;
    if (this.logFile) fs.appendFileSync(this.logFile, line, 'utf8');
}
```

每次 `runProgram` IPC 调用产生 3 条日志，每个测试 3 个程序 = 9 条。1000 组 = 9000 次同步写盘 = 4575ms。

**瓶颈 2: run-program 热路径日志过多**

`main.js` 的 `run-program` handler 每次执行记录 3 条 logInfo（准备/启动/结束），成功时可省略前两条。

**瓶颈 3: std/test 串行执行**

`codeComparer.js:843-931` worker 内部 std 和 test 严格串行，但二者互不依赖（路径 `std_N` vs `test_N` 天然隔离），可以并行。

**瓶颈 4: 线程数限制过于保守**

`codeComparer.js:1261` 限制 `maxParallel = cpuThreads/2`。对拍是 I/O-bound 任务（等待 spawn/IPC），JS 主线程在 `await` 期间不占 CPU。

**瓶颈 5: 文件清理串行**

`codeComparer.js:1162-1172` 的 `cleanupFreopenContext` 用 `for...of` 串行删除文件。

### 修复建议

**P0: logger 批量写盘**

```javascript
// src/utils/logger.js
write(level, ...args) {
    const line = /* ... */;
    this._buffer.push(line);
    if (this._buffer.length >= 200) {
        this._flush();
    } else {
        this._scheduleFlush();
    }
}

_flush() {
    if (this._buffer.length === 0) return;
    const lines = this._buffer;
    this._buffer = [];
    if (this.logFile) fs.appendFileSync(this.logFile, lines.join(''), 'utf8');
}

_scheduleFlush() {
    if (this._flushScheduled) return;
    this._flushScheduled = true;
    setImmediate(() => {
        this._flushScheduled = false;
        this._flush();
    });
}

flushSync() { this._flush(); }

// src/main.js 退出时 flush
process.on('exit', () => { try { logger.flushSync(); } catch (_) {} });
app.once('will-quit', () => { try { logger.flushSync(); } catch (_) {} });
```

**P1: run-program 热路径日志削减**

删除 `main.js` 中成功路径的 2 条日志（准备/启动），仅保留结束日志。

**P2: std/test 并行执行**

```javascript
// src/renderer/js/sidebar/codeComparer.js
const stdFreopenContext = await this.prepareFreopenContext(task, 'std', i, inputData);
const testFreopenContext = await this.prepareFreopenContext(task, 'test', i, inputData);

const [stdResultWrapped, testResultWrapped] = await Promise.all([
    (async () => {
        try {
            const stdRunOptions = stdFreopenContext.workingDirectory
                ? { executablePath: stdExe, workingDirectory: stdFreopenContext.workingDirectory }
                : stdExe;
            const stdOutput = await this.runProgram(stdRunOptions, stdFreopenContext.runInput, 0);
            stdOutput.output = await this.resolveProgramOutput(stdOutput.output, stdFreopenContext);
            return { ok: true, output: stdOutput };
        } catch (error) { return { ok: false, error }; }
        finally { await this.cleanupFreopenContext(stdFreopenContext); }
    })(),
    (async () => {
        try {
            const testRunOptions = testFreopenContext.workingDirectory
                ? { executablePath: testExe, workingDirectory: testFreopenContext.workingDirectory }
                : testExe;
            const testOutput = await this.runProgram(testRunOptions, testFreopenContext.runInput, timeLimit);
            testOutput.output = await this.resolveProgramOutput(testOutput.output, testFreopenContext);
            return { ok: true, output: testOutput };
        } catch (error) { return { ok: false, error }; }
        finally { await this.cleanupFreopenContext(testFreopenContext); }
    })()
]);

if (!stdResultWrapped.ok || !testResultWrapped.ok) { return; }
const stdOutput = stdResultWrapped.output;
const testOutput = testResultWrapped.output;
```

**P3: 动态线程数**

```javascript
async getMaxParallelThreads(hasFreopen = false) {
    const maxParallel = hasFreopen
        ? Math.max(1, Math.floor(cpuThreads * 0.75))
        : Math.max(1, Math.floor(cpuThreads * 0.9));
    return { cpuThreads, maxParallel };
}
```

**P4: 并行文件清理**

```javascript
async cleanupFreopenContext(context) {
    if (!context?.cleanupFiles?.length) return;
    await Promise.all(context.cleanupFiles.map(async (filePath) => {
        try {
            if (await window.electronAPI.checkFileExists(filePath))
                await window.electronAPI.deleteFile(filePath);
        } catch (_) {}
    }));
}
```

### 综合预期收益

| 优化项 | 单管线加速 | 大规模吞吐加速 | 改动量 |
|--------|-----------|---------------|--------|
| P0: logger 批量化 | — | ~100x 日志写盘 | ~40 行 |
| P1: 热路径日志削减 | — | 省 3s+ (1000组) | ~6 行 |
| P2: std/test 并行 | **1.59-1.68x** | 1.3-1.7x | ~50 行 |
| P3: 动态线程数 | — | +75% worker | ~5 行 |
| P4: 并行清理 | 微量 | 微量 | ~5 行 |
| **综合** | **~1.6x** | **~1.6x + 日志100x** | ~100 行 |

## 附件

`compare-benchmark.zip` — 独立基准测试，可直接运行验证：

```bash
unzip compare-benchmark.zip
cd compare-benchmark
node bench.js           # 完整测试 (~5分钟)
node bench.js --quick   # 快速测试 (~1分钟)
```

需要 `g++` 在 PATH 中（或设置 `CXX` 环境变量）。

测试场景（不同算法产出相同结果）：

| 场景 | 算法A | 算法B | 数据规模 |
|------|-------|-------|----------|
| Sort | std::sort | 手写归并 | n=200K |
| Graph | Dijkstra (堆优化) | SPFA | n=10K, m=50K |
| Range | 树状数组 | 线段树 | n=200K, q=200K |

### Electron 全栈实测结果

同台 Electron、同样编译产物、同样输入数据（50组测试，4 workers/threads）：

```
场景       旧(runProgram IPC)     V3(WorkerThreads+预启动)    加速比
────────────────────────────────────────────────────────────────────
Sort        19360ms  2.6 TPS      7585ms   6.6 TPS            2.54x
Graph        7868ms  6.4 TPS      5041ms   9.9 TPS            1.55x
Range       25303ms  2.0 TPS     13571ms   3.7 TPS            1.85x
────────────────────────────────────────────────────────────────────
平均加速: ~2.0x
```

Fast-IO 基准程序（消除 scanf/printf 隐藏成本后，50组测试，8线程）：

```
场景       原始(runProgram)      V6(原生posix_spawn引擎)      总加速
────────────────────────────────────────────────────────────────────
Sort        1.3 TPS               16.1 TPS                    12.4x
Graph       3.3 TPS               19.1 TPS                     5.8x
Range       1.0 TPS                8.2 TPS                     8.2x
────────────────────────────────────────────────────────────────────
```

### V6 原生引擎构建

对拍引擎核心使用原生 `posix_spawn` 模块 (`fastspawn.cc`，N-API 稳定 ABI，Electron/Node 通用)：

```bash
# 在项目根目录 (需 node-gyp 下载的 headers)
g++ -O2 -fPIC -shared -I$NODE_HEADERS/include/node -o fastspawn.node fastspawn.cc
```

worker (`compare-worker-v6.js`) 加载失败时自动回退到纯 Node spawn 实现。

架构变更：
```
旧: renderer → 30+次IPC → main.js → spawn ×3/组 → IPC → renderer
新: renderer → 1次IPC → CompareEngineV2 → Worker Threads → 预启动spawn
```

详细数据见 `BENCHMARK_REPORT.md`。

## 最早提交

logger 同步写盘问题自 logger 引入起即存在。std/test 串行执行自对拍器功能实现起即存在。

## 环境

- 操作系统：全平台（Linux/macOS/Windows）
- 软件版本：v1.5.3+
