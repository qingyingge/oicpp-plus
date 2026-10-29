# benchmark/variants — 编号实验的变体

这里放**对照实验用的 worker 变体**。每个变体都是对 `src/main-process/compare-worker-v6.js`
（由 `.ts` emit，勿手改）的一次文本改写，配一份可选的 `fastspawn-<id>.cc` 派生 addon。
`.node` 与 `.cc` 不进仓库：前者是二进制产物，后者与 `fastspawn.cc` 高度重复，改一处就得同步
六处。重建方式记在下面，需要时照着做即可。

加载哪份 addon 由 `loadFastspawn()` 的候选路径决定；下面每条都给出把它指过去的那一处改动。

| 变体 | 对应实验 | 怎么造出来 |
|------|---------|-----------|
| `worker-v11-control.js` | **V11 对照件**（所有 V20-vs-V11 数字的分母） | 对当前 emit 产物反向打三个补丁：删 `outputsEqual` 里的 `left.equals(right)` 快路；删 `runGenerator` 里 `if (fast && args.length === 0 && !cwd) return runFast(...)`；把主循环生成器闸门里的 `genOut.outputTruncated` 及其两处派生用法去掉。再把 `../utils/process-supervisor` 与 `../../fastspawn.node` 改成绝对路径。 |
| `worker-v12.js` | V12 生成器改 C 捕获 | `runGenerator` 内，在 `return await runJs(...)` 之前插入 `if (fast && args.length === 0 && !cwd) return runFast(exe, null, timeout);` |
| `worker-v14.js` | V14 C 层 normalize 前置 memcmp | addon 换成 v14 版：`RunPair` 的 compare 分支里，在归一化之前加<br>`else if (arg1.outLen == arg2.outLen && (arg1.outLen == 0 \|\| memcmp(arg1.out, arg2.out, arg1.outLen) == 0)) { verdict = 1; }`<br>worker 侧只改 `loadFastspawn()` 的候选路径指向它。**结论：淘汰。** |
| `worker-v1214.js` | V12 + V14 组合 | 上面两条叠加。**结论：V14 部分不带收益。** |
| `worker-v11fb.js` | 回退路径对照（Windows 形态） | 把 `const useFast = !!fast;` 改成 `const useFast = false;` |
| `worker-v15fb.js` | V13 回退路径判等快路 | 上一条 + `outputsEqual` 里加原始字节短路。**结论：采用，但只在回退路径有效。** |
| `worker-head-native.js` | 实验八的 **V6** 原样 | `git show HEAD~N:src/main-process/compare-worker-v6.js`（V11 之前的那一版），addon 换成 v6 版（即修复前的 `fastspawn.cc`：写循环里是 `if (wr <= 0 && errno != EINTR) { kill(-pid, SIGKILL); break; }`，且 `runOne` 末尾 `free(errBuf)` 不回传 stderr）。 |
| `worker-worktree-wrapper.js/.ts` | 工作区那版 timeout-wrapper 重构 | 见下方"这份是留档"。 |
| `timeout-wrapper.js` | 上一行的依赖 | **归档副本，已进仓库**。`src/main-process/timeout-wrapper.*` 已在 V20 收尾时删除（该架构被否决，且它经 `files: ["src/**/*"]` 只会给安装包添死重），所以这份副本是该方案的唯一存留，只为复现「工作区版 vs V11」那张对照表而保留。 |

重建 addon（`.node` 已在 .gitignore 里）：

```bash
NI=$(ls -d /root/.cache/node-gyp/*/include/node | tail -1)
g++ -O2 -fPIC -shared -pthread -D_GNU_SOURCE -DBUILDING_NODE_EXTENSION \
    -DNODE_GYP_MODULE_NAME=fastspawn_v14 -I"$NI" \
    -o benchmark/variants/fastspawn-v14.node <上面那段派生 .cc>
```

模块名必须与 `-DNODE_GYP_MODULE_NAME` 一致，否则 `NAPI_MODULE(...)` 注册的符号名对不上。

改完任何 `.cc` 都必须重新构建 `.node`：**产物陈旧不会报错**，只会让新增的 `compare` 参数
被静默忽略，于是你以为在测 V14，实际测的是 V11。

## `worker-worktree-wrapper.*` 是留档，不是待选方案

它保存的是本次会话开始前工作区里那份**未提交**的 `compare-worker-v6.ts`（std/test 每次跑都
`spawn(process.execPath, [timeout-wrapper.js])`）。那份原文件已被优化改动覆盖，这里留一份副本
是为了不丢在制品，同时让 A/B 能在同机同参数下重跑，而不是只靠历史记录。

它没有被采纳，两个原因都写在 `docs/PERFORMANCE.md`：实测比原生路径慢一倍；且 `asarUnpack`
没覆盖 `timeout-wrapper.js`，打包后子 Node 进程读不到该文件，这条路径在安装包里不可用。

另有若干 `worker-v11-native.js` / `worker-v11-fallback*.js` /
`worker-v11-fb-fastcmp.js` / `worker-v6-*.js` 是回退路径归因（V13）过程中的中间插桩探针，
不属于编号实验本身，留着是为了那张 43.2 vs 13-15 ms/MB 的阶梯能重跑。

## 变体的存在意义

性能优化最危险的失效方式是**结论变了但速度数字很好看**。所以每个变体在进基准之前必须先过
`benchmark/equiv-check.js`——逐条比对判定序列（含故意不等价的 ForceDiff 场景），结论不完全
一致就不许进基准环节。
