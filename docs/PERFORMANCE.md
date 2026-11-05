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

- `src/main-process/compare-engine.ts` — 引擎入口（生产已接入，`src/main.ts` 的 `start-comparison` handler 引用）
- `src/main-process/compare-worker.ts` — worker（原生 + JS 回退双路径）
- `fastspawn.cc` — 原生 addon 源码（编译产物 `fastspawn.node` 需自行构建）

> 2026-11-03 文件名去版本号：`compare-engine-v2` → `compare-engine`、`compare-worker-v6` →
> `compare-worker`、导出类 `CompareEngineV2` → `CompareEngine`。本文与 `BENCHMARK_REPORT.md` /
> `BUG_REPORT.json` / `ts-migration-baseline.*` 各轮记录里出现的旧名是当时的路径与读数，不改写。

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
字符串规范化。本轮只动回退路径（`compare-worker.ts`，当时名为 `compare-worker-v6.ts`），fastspawn 路径不变。

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

## 第四轮：spawn 时间解剖与一次被评审撤回的尝试（2026-10-28）

### 时间去哪了（benchmark/profile-pipeline.js，阶段级中位）

| 探针 | spawn 事件 | stdin 写排空 | 首输出 | close 全程 |
|------|-----------|-------------|--------|-----------|
| 空程序（现状 windowsHide） | 5.6ms | — | — | **33~35ms** |
| 空程序 detached 试验 | 5.6ms | — | — | **11.7ms** |
| scanf 干 1.3MB | 6.4ms | 134ms | — | 142ms |
| scanf 干 4.6MB | 7.3ms | 428ms | — | 437ms |

- drain 的 134/428ms 完全吻合 scanf ~10MB/s —— 是**用户程序自己的 CPU**，管道本身
  只摊 ~1ms；worker 侧写 stdin 不与关键路径争用（std‖test 并发后各写各的）。
- 每进程 33ms 地板与 stdio 配置无关、与 exe 是否静态无关，是 windowsHide 在非
  detached 子进程上分配隐藏 conhost 的成本（Electron GUI 父进程语境实测同幅）。
- 判等：1.3MB 逐字节相同 0.12ms（equals 短路）；不同才进归一化（双侧 3.2ms，一次性）。

### DETACHED_PROCESS：尝试 → 撤回 → 再翻案的完整决策记录

**尝试**：detached（win32 不分配 conhost）把每进程地板从 35ms 砍到 11.7ms。
**撤回**（/review 发现）：`system("pause")` 在无控制台子进程里永挂（A/B 交替可复现），
当时按「OI 遗留代码里 pause 是高频习惯」回退。
**再翻案**（产品判断 + 补全实测）：正常代码不会往评测代码里塞 pause/getch——保护不存在
的用户群不值得 20~32% 的吞吐；且补测揭示了更硬的理由：

| console 依赖调用 | 隐藏控制台（旧） | DETACHED（现行） | OJ（stdin 文件重定向） |
|-----------------|-----------------|-----------------|----------------------|
| `system("pause")`（cmd 尊重重定向） | 秒回（80ms） | 永挂 → **如实报 std_timeout** | EOF 秒回 |
| `_getch()`（conio 直读 CONIN$） | **永挂**（读了不存在的一把键） | EOF 立返 -1 | 依工具链，多读 stdin 见 EOF 即返 |
| scanf/cin/fread（正常代码） | 正常 | 正常 | 正常 |

隐藏控制台同时存在「读 CONIN$ 幽灵键」与「碰巧放行」两条**不可预期的分裂路径**；
DETACHED 把 stdin 语义统一成「读重定向、EOF 即止」——与 OJ 同构，失败形态是
带组号的 std_timeout（实测 e2e），可见、可定位、可操作。按第四轮判定原则（对拍
如实复现，不比 OJ 更宽更严），DETACHED 才是正确侧。

**现行实测（t12，两轮各 3 轮共 6 轮合并中位，fail=0）**：

| 场景 | TPS | vs 原始基线 | 上限达成度 |
|------|-----|------------|-----------|
| Sort  | 18.6 | **2.10x** | ~61%（余量为核间争用与流水线粒度） |
| Graph | 33.5 | **1.75x** | 建进程串行仍主导，但地板已减半 |
| Range | 7.9  | **1.55x** | ~77%（接近程序自身 CPU 极限） |

达成度口径：单槽无争用 CPU 合计（Sort≈400ms/测）×50 ÷ 12.5 等效核（10 物理+HT 增益）。
判等设计原则不变：**对拍只如实复现字节流，不清洗 stdout 里的提示类垃圾**（pause 提示
实测进入 stdout 且因全缓冲错位排在答案前——该暴露就暴露）。POSIX 行为零变化（本来
就 detached）；win32 杀树走 taskkill /T 按父子关系，与进程组无关。

## 复测命令

`benchmark/` 下的**脚本**（`bench-logged.js`、`ab.js`、`equiv-check.js`）入库，忽略的只是内容目录
（`benchmark/logs/`、`compare-benchmark/`）—— 之前把 `benchmark/` 整个目录排除，git 无法在被排除的
目录里重新纳入文件，结果就是基准脚本只能靠 `-f` 硬加、文档里的数字没人能重跑。基准程序的口径：
**纯 stdio 实现（scanf/printf，不带 fastio）**——真实用户程序不保证有自定义快读，用 fastio 会低估
spawn/管道占比。场景规格：Sort = 20 万随机数（gen → std::sort vs 归并）；Graph = 1e3 点 5e4 边最短路
（Dijkstra vs SPFA）；Range = 2e5 元素 2e5 操作区间和（BIT vs 线段树）；另有 _empty
（空程序，测固定开销）、_drain（scanf 干 stdin，隔离读取成本）、_tiny/_tinygen（小数据
测地板）与 wrong_dijkstra（造 WA 用）。按上表规格现写 .cpp 后：

```bash
g++ -O2 -o compare-benchmark/progs/<name>.exe compare-benchmark/progs/<name>.cpp   # 9 个场景程序
node benchmark/bench-logged.js --threads 12 --log benchmark/logs/run.jsonl
node benchmark/bench-logged.js --scenario Range --tests 30   # 只跑一段，对照用
OICPP_COMPARE_PREFETCH=0 node benchmark/bench-logged.js --threads 12   # 预取 A/B 开关
```

跑之前必须 `pnpm run prebuild:native`（改过 `fastspawn.cc` 更要——旧的 `.node` 会静默忽略新参数），
并且**钉核**：本机 `Cpus_allowed_list` 会在一次会话里从 3 变到 8，而 `os.cpus().length` 恒报 8，
不钉核的两次跑不是同一台机器。`ab.js` 就是为这件事写的：钉 CPU 集 + 交错跑 + 报 CPU 口径。

### 一条会反复骗人的教训：`poll()` 超时返回 0 且**不改动 errno**

写 stdin 的循环里 `write` 返回 -1/EAGAIN 后 `poll(&fd,1,50)` 等可写；超时那次 `poll` 返回 0
并且**保留上一步 `write` 留下的 EAGAIN**，于是老代码 `if (wr <= 0 && errno != EINTR) kill(-pid, SIGKILL)`
把「子进程还没来得及读」判成错误，杀掉之后收割状态折算成 `128+9 = 137`，对拍里报成
`std_re: standard program exit 137`。触发门槛只是输入大于管道缓冲（64KB），也就是任何真实
规模的生成数据。

规则：**任何 `poll`/`select` 之后的错误判定，只能用刚保存下来的 `errno`**（`int saved = errno;`
紧跟在系统调用后面），超时分支一律 `continue` 而不是当错误。同一文件里收输出的 `drainBoth`
早就按这个写法处理 `pr == 0`，写循环是漏改的那一处——所以「同一段逻辑的两半各自演化」本身
就是要提防的形状。

实测（本机 4 核可用、Range 场景 gen 输出 3.5MB，`--scenario Range --tests 20`）：

| fastspawn.cc | 结果 |
|---|---|
| 修复前（main 的旧版） | `Range 0/20  fail={"std_re":20}` —— 20 组全部误杀成 137 |
| 修复后（pump + saved errno） | `Range 20/20  fail=0`，genLen=3,499,880B |

行为守卫在 `tests/fastspawn-io-pump.test.js`（cat 回读 2MB 逐字节相同、截止时间落在写 stdin
期间判 `-3` 而不是 137、C 层归一化与 JS `normalizeOutput` 22 条边界 + 4000 条定种子 fuzz 全等、
非 ASCII 分歧交回 JS 终裁）。反证也做过：把 main 的旧 `fastspawn.cc` 重编译回去，同一台机器
立刻复现 0/20。
---

# 第三轮：四项候选优化的实测与否决（2026-11-05）

这一轮的结论是**否定的**：四个看起来该做的优化，量过之后都不做。记录下来是为了避免
下一个人重新 litigate 一遍 —— 也因为「本机测不出真话」这件事本身就是要记的东西。

## 前提：这台机器的测量能力

proot 容器里每一次 syscall 都被 ptrace 拦一遍，进程创建变成 **CPU 密集**而非等待。
后果是所有「重叠/调度」类优化的收益被这个artifact吃掉，而纯裁剪类优化埋在噪声里。

先量噪声地板：把同一个 worker 复制一份自比（`compare-worker.js` vs 它的逐字节副本），
交错 4 轮，引擎自身 CPU **差 1.5%**。所以**任何低于 ~2% 的读数都不算结论**。

墙钟口径另有一层坑：第一次按 BASE→V1→V2 固定顺序跑，得出「V1/V2 慢 8~11%」；
改成每轮轮换顺序后同一对变体变成「快 5~8%」——**符号直接翻转**。ab.js 早就写了这条
警告，我第一次自己踩了。

## 各项候选与读数

| 候选 | 实测 | 判定 |
|------|------|------|
| fastpath 预取生成器（原来只有 JS 路预取） | 轻场景 0.995×；Graph 的 gen 占一轮 37%、输出 683KB 小于 1MB 管道，理论可整段隐藏，实测墙钟无变化、CPU 反而升 | **撤回** |
| native `compare=true`（判等下沉，等值时两侧缓冲不回传） | 1MB 输出时回传从 2048KB 降到 0，但耗时 **+1~3%**（要先把两份缓冲归一化才能比） | **不做** |
| 生成器 / checker 走 native（需先给 `run` 加 argv） | 单次 spawn 33.0ms → 15.6ms（省 53%）是真，但生成器常是单轮里最长的一段，而同步 native 调用期间 `postMessage('stop')` 与 `terminate()` 都进不去 —— 停止最长要等满兜底的 60s | **不做**：不拿响应性换 ~5% |
| `pump` 前 3 次 `F_GETFL`+`F_SETFL` 改成直设 `O_NONBLOCK`、管道容量按需放大 | 省 3~5 个 syscall/子进程，全部读数落在 ±2% 噪声内 | **不做** |

另外量了两件有用于决策的事实：

- **我前面几轮的改动没有把 diff 路径拖慢**：与 `main` 的 worker 交错 4 轮，引擎自身
  CPU 差 +1.9%，落在 1.5% 噪声地板之内，不可区分。第一次用 2 轮时读出 7~12%，是噪声。
- **JS 回退路径（= Windows 的全部流量）在这台机器上慢 1.203×**。这是目前已知最大的
  一块剩余收益，但它是「要不要为 win32 移植原生 spawn」的决策，不是能盲写的优化 ——
  这里既编不了也验不了，写完就是个没人测过的 CreateProcess + overlapped pipe 实现。

## 教训

1. **换指标而不是换次数**：墙钟在这台机器上方差太大（±5~8%），改成量 worker 自身的
   `process.cpuUsage()` 才稳定到能分辨 ~1.5% 的量级。
2. **先测噪声地板再测效果**：自比副本这一条花两分钟，省掉之后所有「我优化了 3%」的
   自欺。
3. 判定「重叠类优化有没有用」之前要先问**这台机器的瓶颈是不是 CPU**；proot 把 spawn
   变成 CPU 活，于是所有 overlap 都是零和 —— 换一台真机再谈。
