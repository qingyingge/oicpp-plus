# 对拍器性能优化记录

## 摘要

对拍引擎当前形态是 **V20**：原生 `posix_spawn` + `runPair`（std/test 在 addon 内两个
pthread 并行并在 C 层判等）+ **生成器输出也由 C 捕获** + `outputsEqual` 原始字节短路，
并修掉了 stdin 写循环里一个会误杀健康子进程的 `poll`/`errno` 缺陷。

引擎自身 CPU 约占总 CPU 的 17%，是剩余收益所在；V12 把这部分砍掉约 38%，整机吞吐
+10~23%。而重叠、线程数、分片策略这些方向已逐一实测确认**没有肉**。

## 实测数据

### V20 vs V11（钉核 `taskset -c 0-3`、threads=4、每场景 24 组 × 3 轮交错，72/72 全过）

| 场景 | 墙钟 | 引擎 CPU/组 |
|------|------|-------------|
| Sort | **1.142x** | 272.8 → 168.0 ms（1.624x↓） |
| Graph | **1.228x** | 141.9 → 87.9 ms（1.614x↓） |
| Range | **1.102x** | 367.9 → 217.8 ms（1.689x↓） |

进产品前必须过等价闸门：`benchmark/equiv-check.js` 逐条比对各实现的判定序列，其中含一个
故意不等价的 ForceDiff 场景，用来抓「把不等判成相等」这个方向。结论完全一致才允许进基准。

### 单项收益与已排除的方向

| 项 | 结果 |
|----|------|
| V12 生成器改 C 捕获 | **采用**。Node stream 捕获 43.2 ms/MB vs C pump 13-15 ms/MB |
| V13 `outputsEqual` 原始字节短路 | **采用，仅 Windows 有效**。回退路径 Range CPU 1.661x↓；Linux 原生路径 0.0%（`verdict === 1` 先返回，压根不调用它） |
| V14 C 层 normalize 前加 raw memcmp | **淘汰**。Sort 省 19.8ms 过线，Range 省 −1.8ms 不过线 |
| V15 提前投递 / 融合 tee | **不可行**。见「设计教训」第 7 条，两个方向都会造出错判 |
| V17 线程数策略 | 维持。每 worker 实际索取 1.4-1.65 核，`availableParallelism` 对吞吐是对的 |
| V18 动态分片 | **无差别**。异质夹具（规模 cv=0.864）下 dynamic/static = 1.005 |
| V19 缓冲复用 / 管道容量 / 读块调优 | **零收益**，低于本机测量分辨率 20-60 倍 |
| runPair 重叠效率 | 已达 **90-100%**，pair ≈ max(std,test)，无进一步空间 |
| 线程扩展 | T=4 已捕获 87-104% 可得 CPU；T=8 只靠 1.4-2x 超订多换 6-18% |

### 同机交错 A/B（V11 相对工作区版 timeout-wrapper）

| 场景 | 工作区版 (timeout-wrapper) | V11 | V11 vs 工作区版 |
|------|---------------------------|------|----------------|
| Sort | 25888ms | **10462ms** | **2.47x** |
| Graph | 16082ms | **6536ms** | **2.46x** |
| Range | 48223ms | **24286ms** | **1.99x** |

`timeout-wrapper` 那档指「每次跑一个被测程序都起一个完整 Node 进程」的形态，实测比原生
路径慢一倍；且 `asarUnpack` 没覆盖 `timeout-wrapper.js`，打包后子 Node 进程读不到该文件，
那条路在安装包里根本不可用。

### 历史数据（另一台 8 核空闲机器，3 轮中位数，50 测试）

| 场景 | 原版 spawn | 纯 Node 管线 (V3) | 原生 posix_spawn (V10) | 总加速 |
|------|-----------|-------------------|------------------------|--------|
| Sort | 4.3 TPS | 10.7 TPS | 23.3 TPS | 5.4x |
| Graph | 6.4 TPS | 13.2 TPS | 33.1 TPS | 5.2x |
| Range | 2.4 TPS | 5.9 TPS | 10.1 TPS | 4.2x |

⚠️ 这是**另一台机器**的绝对值，不要与本节的 wall/CPU 互相换算。且 V10 那一档
还带着一批被误杀成 `std_re exit 137` 的失败（Range 实测 0/50 全灭），
它的吞吐是被**高估**的 —— 那些组没跑完就"结束"了。

## 核心改动

- **原生进程调度**：N-API 模块 `fastspawn.node`（源码 `fastspawn.cc`），`posix_spawn` 替代 Node `fork`
- **runPair 并行**：std 与 test 互不依赖，pthread 双线程同时执行，单测试耗时从 `gen+std+test` 降为 `gen+max(std,test)`
- **C 层归一化判等**：`runPair(compare=true)` 在 C 里做行尾/空白归一化 + `memcmp`，相等时连两段 MB 级输出的跨边界拷贝都省掉（实测 JS 侧那段要 67-292ms/组）。非 ASCII 时不裁，交回 JS 终裁，防假 WA
- **生成器也走 C 捕获（V12）**：无 args/cwd 时用 `fast.run`，避开 Node stream 的 43.2 ms/MB；Python 生成器（解释器 + 脚本参数）仍走 `runJs`
- **pump 交错 IO**：喂 stdin 与收 stdout/stderr 交错进行。原来的两段式写法对 `cat` 这类边读边写的程序会死锁
- **多 Worker 分片**：每个 Worker Thread = 独立 OS 线程串行跑测试切片，N 个 worker = N 路真并行，无事件循环争抢、无 fd 跨线程竞态
- **JS 回退**：加载不到原生模块时回退 `child_process`，并用 `Promise.all` 保持 std/test 并行（Windows 上这条就是生产路径）；两条路径同 kind / code / message
- **默认并行度** 取 `os.availableParallelism()` 而非 `os.cpus().length`，后者看不见 cgroup 配额与亲和性掩码

## ⚠️ V12 带来的语义变化

渲染层 `codeComparer.ts:809` 把 `generatorTimeout` **恒设为 0（不限时）**。原生调用是同步的，
`stop` 与 `worker.terminate()` 都打不断，所以生成器也沿用 `UNLIMITED_RUN_FALLBACK_MS`：
「不限时」在原生捕获下实际是 **60s 上限**，而此前经 `child_process` 可以真的无限等。
依据：跑超过 60s 的生成器几乎必然是死循环，而旧行为是把整轮对拍无声挂死且不给任何反馈。
若要保留字面无限等，需让 `runGenerator` 在 `timeout === 0` 时回退 `runJs`，代价是 V12
在生产配置下失效。

## 实现文件

- `src/main-process/compare-engine-v2.js` — 引擎入口（生产已接入）
- `src/main-process/compare-worker-v6.js` — V20 worker（原生 + JS 回退双路径，共用一套 judgePair 判定）
- `fastspawn.cc` — 原生 addon 源码（编译产物 `fastspawn.node` 需自行构建）
- `benchmark/ab.js` — 钉核 + 交错 + CPU 口径的 A/B 跑批器
- `benchmark/equiv-check.js` — 判定等价性闸门（先于性能闸门）
- `tests/fastspawn-io-pump.test.js` — 原生层行为守卫（真起子进程；win32 自动跳过）
- `tests/compare-timeout-anchor.test.js` — 时限锚点守卫（V15 的产物）
- `benchmark/probe-ladder.js` — 回退路径开销的**逐级归因**探针（childFloor → writeOnly →
  noKeep → full → native → spawnSync，每级只多一件东西，差值即其代价）。本文里
  「Node stream 捕获 43.2 ms/MB vs C pump 13-15 ms/MB」这条支撑 V12 的数字就出自它
- `benchmark/probe-report.py` — 带计时探针的 fallback worker 日志汇总
- `benchmark/variants/*.cc` + `*.js` — 被否决候选（V14 短路与、V19 缓冲复用等）的变体源码，
  配合 `benchmark/compare-probe/` 里的构建脚本可复现「测出来是零」的结论；该脚手架目录本身
  不进仓库，需要时按 .cc 重新构建即可
- `benchmark/fixtures/gen_mixed.c` — V18 的双峰异质负载夹具（必须先自校验，见教训 10）

## 复现

```bash
# 构建原生模块。改完 fastspawn.cc 必须重建，
# 否则 .node 是旧的，runPair 新增的 compare 参数会被静默忽略。
pnpm run prebuild:native
npx tsc -p tsconfig.build.json          # .ts 是唯一手写源，.js 由它 emit

# 正确性闸门 —— 结论不一致的实现不许进基准
node benchmark/equiv-check.js --cases 6 \
  --worker V11=benchmark/variants/worker-v11-control.js \
  --worker V20=src/main-process/compare-worker-v6.js

# 性能：必须钉核，且 CPU 口径比墙钟可信
node benchmark/ab.js --cpus 0-3 --threads 4 --tests 24 --reps 3 \
  --scenario Sort,Graph,Range \
  --worker V11=benchmark/variants/worker-v11-control.js \
  --worker V20=src/main-process/compare-worker-v6.js
```

## 设计教训

1. 基准必须固定环境负载：Electron/占用 CPU 的进程会系统性低估吞吐（实测 Graph 被低估 33%）。
   本轮同一份 worker 的 `gen` 阶段在两次运行里从 190ms 跳到 627ms —— 所以 A/B 必须
   **交错**跑，串行分批等于测漂移。第一次得出的「工作区版 Range 比 V11 快」就是假结论。
2. **墙钟在本机对 1-2% 量级的效应没有分辨率**，而 `process.cpuUsage()`
   （`getrusage(RUSAGE_SELF)`，含全部 worker 线程、不含子进程）有。CPU 密集型负载下省下的
   CPU 直接兑换成吞吐，所以「引擎 CPU/组」既是判据也是预测器。
3. `taskset -c 0-7` 在 cpuset 只授 0-3 时会**静默成功并降级**（内核取交集）。请求了几个核
   不等于拿到几个核，必须回读 `Cpus_allowed_list`。
4. 原生模块返回裸 fd 给 Node 异步流（V7/V8）有跨线程 fd 竞态，不可修复；fd 全在 addon 内部
   管理才是正解。
5. 同步原生调用占用的只是单个 worker 线程的事件循环，多 worker 下并行度 = 线程数，无性能损失（V6 突破）。
6. **`poll()` 超时会返回 0 且不改 `errno`。** 任何 `poll` 之后的错误判定，用的必须是
   紧邻上一次 `write`/`read` 时保存下来的 `errno`，不能事后读全局值。写成
   `if (wr <= 0 && errno != EINTR)` 时，「子进程只是还没来得及读」会被判成错误并
   SIGKILL，状态折算成 137 报成 RE —— 触发门槛只是输入大于管道缓冲。
7. **时限与「提前投递」不可兼得**（V15 的核心发现，也 retroactively 解释了 V4 为什么必然
   失败）：任何锚在 spawn 的时限，只要 `timeout < 投递完成墙钟` 就造出**假 TLE**；任何锚在
   input-complete 的时限，只要投递前空转超过时限余额就造出**假 AC**。两个方向都有实测样本。
   唯一与现有语义等价的策略是「生成器退出前一个字节都不许投」。
   守卫：`tests/compare-timeout-anchor.test.js`。
8. 父进程写 stdin 与子进程写 stdout 必须**交错**处理，不能「先写完输入再收输出」，
   否则对边读边写的程序是死锁。
9. 判等下沉到 C 之后，JS 侧那份定义要留在源码里当参照物：`normalizeCompare` 与生产
   `normalizeOutput` 逐条对拍（含定种子 fuzz）才敢用。参照物绝不在测试里重抄一份。
10. **测量夹具必须先自校验**。V18 第一版的「失败」是夹具造的：生成规模超出参考程序容量后
    `sort_mergesort` 堆破坏崩溃（输出 md5 恰为空输入那个），拿那批数据比较分片策略，得出的
    方向是反的。现在出现失败组就整轮作废，且夹具在测量前先跑一致性自校验。
