# OICPP-Plus IDE — Project Overview

## Type
Electron desktop app (JS), for competitive programming.

## Entry
`src/main.js`

## Package manager
pnpm@11.7.0

## Key scripts
| Script | Command |
|--------|---------|
| `start` | `electron .` |
| `dev` | `electron . --dev` |
| `build` | prebuild steps + electron-builder |
| `ci` | `node scripts/ci-check.js` |
| `ci:tests` | `node scripts/ci-check.js --only tests`（只跑回归测试） |
| `ci:fast` | `node scripts/ci-check.js --skip tests`（只跑静态检查） |
| `ci:strict` | `node scripts/ci-check.js --strict`（WARN 也判 FAIL，当前 18 WARN 会红） |
| `ci:verbose` | `node scripts/ci-check.js --verbose`（详细输出） |

## Workflows（按任务类型的正确操作方式）
本节按任务类型登记「这件事在本项目里应该怎么做」。动手前先在这里找对应条目，照着走；条目里点名的**反模式**不要试。判断不了就问，不要凭通用经验猜流程。新增条目统一用三级标题，格式：适用场景 → 正确命令序列 → 反模式（附失败特征）→ 坑。

已登记：
- [打安装包](#workflows打安装包)
- [改界面文案 / 加翻译](#workflows改界面文案--加翻译i18n)
- [迁移 .js → .ts](#workflows迁移-js--ts)

### 打安装包（Build / Installer）
本项目的安装包**不用** electron-builder 的 nsis target 出，而是用仓库根目录自带的 `installer.nsi` + 本机 NSIS。`package.json` 里 `build.win.target = "dir"`，electron-builder 只负责产出 `dist\win-unpacked`；`installer.nsi` 直接从该目录取文件，输出 `dist\OICPP-Plus-<version>-Setup.exe`（`installer.nsi:69`）。CI 同流程，见 `.github/workflows/build.yml:319`。

**不要**执行 `electron-builder --win nsis`：它会尝试联网下载 NSIS 工具链（缓存在 `%LOCALAPPDATA%\electron-builder\Cache`），网络不稳时会以 `fetch failed` / `TypeError: terminated` 失败，且该失败与代码无关。

完整流程（Windows）：
```powershell
pnpm run prebuild:icons        # 生成图标
pnpm run prebuild:native       # Windows 上是 no-op（仅 POSIX 需要 fastspawn）
pnpm run prebuild:clangd       # 目标已存在则自动跳过下载
pnpm run prebuild:clang-format # 同上
pnpm exec electron-builder --win dir     # 产出 dist\win-unpacked
& "C:\Program Files (x86)\NSIS\makensis.exe" "/DPRODUCT_VERSION=1.5.4" installer.nsi
```

要点：
- 跑 makensis 前必须先有 `dist\win-unpacked`，它是 installer.nsi 的唯一输入；只跑 makensis 会得到缺文件的包。
- `pnpm run build` 等于「全部 prebuild + electron-builder」，其中含 `prebuild:buildinfo`（会改写构建时间）；要保留原构建时间就别用它，按上面步骤逐条跑。
- 版本号取自 `package.json`，可用 `/DPRODUCT_VERSION=x.y.z` 覆盖（`installer.nsi:6-8`）。
- **构建时间只由 `pnpm run prebuild:buildinfo` 改写**（写入 `src/build-info.json` 的 `buildTime`）。需要保持原构建时间时就跳过该步骤，直接用其余 prebuild + electron-builder + makensis。
- 产物会覆盖同名旧包，必要时先备份。
- 压缩是 solid LZMA + 64MB 字典，打包耗时数分钟到十几分钟属正常，耐心等，不要中途打断重试。

### 改界面文案 / 加翻译（i18n）
**渲染层一律写 `window.i18n.t('key')`。** 不要新增 `this.t` 或 `window.__` 的调用（类上的 `this.t` 包装已随存量清理删除）。模板字符串里重复调用时允许保留局部别名，但**必须包 `window.i18n`**：

```js
// 允许：别包 window.i18n 更可读
const t = (key, params) => window.i18n?.t?.(key, params) || key;
// 需要兜底文案时
const t = (key, params, fallback) => window.i18n?.t?.(key, params) || fallback || key;
```

主进程没有 `window`，走 `src/main.js:20` 的 `const { t } = require('./lang')`（i18next），`utils/` 下的模块用 `require('../lang')`。这条不受「统一 window.i18n.t」约束。

**渲染层底层已是 i18next**（`src/renderer/js/i18n.js` 只是薄适配层）。`index.html` 用 `<script src="../../node_modules/i18next/dist/umd/i18next.min.js">` 引入 UMD 全局（沿用 monaco `loader.js` / xterm 的既有先例），资源经 IPC `get-language-file` 拉原始 JSON 后 `addResourceBundle(code,'translation',data)` 灌入 —— **语言包文件形状不要改**，它同时是 i18next 的 translation bundle。DOM 层（`_applyToDOM` / `enableAutoTranslate` / `onChange`）仍是手写，因为 `data-i18n-args`、`<html lang>` 这些是本项目特有契约，且 `i18next.on()` 返回值不能当 unsubscribe 用。

改渲染层 i18n 后，`tests/i18n-renderer-runtime.test.js` 是运行时行为守卫（vm 里跑真实 i18next UMD + 真实语言包，断言界面实际看到什么），`tests/i18n.test.js` 是契约守卫。两者都要跑。

**⚠️ UMD 的位置有硬约束：必须落在 `index.html` 里「define 为空」的窗口内。** UMD 头是三分支，`"function"==typeof define && define.amd ? define(t) : globalThis.i18next=t()` —— 只要执行的那一刻 `window.define` 是 monaco 的 AMD loader，就会走 `define(t)` 分支**永不挂全局**，`t()` 随即抛 `ReferenceError: i18next is not defined`，全站裸 key。而此时脚本**加载成功、无 console 错误、不过 CSP**，静态检查和 vm 测试全都看不见（vm 里没有 monaco loader.js）。`index.html` 已为 xterm 造好这个窗口：`window.define = undefined` 之后、恢复 `__oicppAmdDefine` 之前。移动该 `<script>` 时**只要求「在 `js/i18n.js` 之前」是不够的**（真实踩过：放在全部 app 脚本之后 → 整站失效）。`tests/i18n-renderer-runtime.test.js` 的 0c 组锁死了这个窗口。

**改 UMD/`index.html` 脚本顺序后必须真实 Electron 实测**（这是唯一能抓到上一条的手段）：
```bash
xvfb-run -a node_modules/electron/dist/electron tests/smoke-electron.js --no-sandbox
```
它故意**不叫 `*.test.js`**（`run-tests.js` 只发现 `*.test.js`，而没装 electron 二进制的机器跑不了它，混进套件会直接让 CI 变红），因此不会被自动执行，需要手动跑。

**形参个数是最容易翻车的地方**：给两参的入口传三个参数只会**静默丢弃** —— 不报错、界面照常显示、CI 全绿，只有 i18n 未就绪时才暴露成裸 key 名。

| 入口 | 形参 | 说明 |
|------|------|------|
| `window.i18n.t(key, params)`（`src/renderer/js/i18n.js:163`） | **2** | **唯一入口** |
| 局部 `const t = ...` 别名 | 按自己定义 | 允许，但形参数必须与调用处一致 |
| `t(key, params)`（`src/main.js:20`） | 2 | 主进程，长期保留 |

`this.t` 与 `window.__` 已全部清理完毕，不要再用（`window.__` 的定义点 `i18n.js` 旧 318 行随 i18next 迁移一并删除，唯一消费 `browser-manager.js` 已改为 `window.i18n?.t?.(k) || k`）。
注意 `src/main.js`（主进程）和 `src/renderer/js/main.js`（渲染层）是两个同名文件，行号别看串。

HTML 静态文案挂 `data-i18n` / `data-i18n-placeholder` / `data-i18n-title` / `data-i18n-aria-label`（另支持 `data-i18n-args` 传插值参数），由 `src/renderer/js/i18n.js:242 _applyToDOM` 统一覆盖。**行内中文只是 JS 加载前的默认值，保留即可**，I8 不计入这类行。

主进程语言切换：启动时 `src/main.js:2960`（`createWindow` 内）`setLanguage`、设置变更时统一走 `applyLanguageChange()`（`src/main.js:8576`，内部 `await setLanguage` → `createMenuBar()` → 广播 `language-changed`），无状态，`t()` 直接调即可。**任何改动 `settings.language` 的入口都必须调用它**（`update-settings` handler、`updateSettings()`、`resetSettings()`、`importSettings()`、云端同步），否则语言只在下次开窗口时生效。

改完必须跑 `pnpm run ci`（I1~I8 + 回归测试）。

**反模式：**

- ❌ 给 `window.i18n.t` 传第三个参数：`window.i18n.t('key', null, '中文兜底')`。第三参数被**静默丢弃**，i18n 未就绪时回退成**裸 key 名**。要兜底就写 `window.i18n?.t?.('key') || '兜底文案'`（`?.` 不能省，见坑）。`tests/i18n.test.js` 有守卫拦这个，但别依赖守卫兜底。
- ❌ 改局部别名的形参个数却不同步调用处。把 `const t = (key, params, fallback) => ...` 缩成两参、而调用处还传第三个，兜底就没了 —— 不会有任何报错。本轮收敛时就踩过：把 5 处三参别名改成两参，30 处调用静默丢了兜底文案。改完务必用形参扫描确认一遍。
- ❌ 用已翻译文案反推语义状态，如 `status.includes(t('compileOutput.successSimple'))` 决定指示灯颜色。耦合方向反了，改一次译文就静默失配。已登记为 M57（`docs/BUG_REPORT.json`），正解是显式传 `setStatus(status, type)`。

**坑：**

- 取消/失败这类**要被代码识别**的状态，不要拿文案匹配。改用错误码：下载器已改为 `error.code = 'DOWNLOAD_CANCELLED'` + 导出的 `isCancelledError`（`utils/multi-thread-downloader.js`），别退回 `error.message.includes(...)`。
- I8 拦硬编码 CJK（baseline 0）；**I8b 拦用户可见行上的硬编码英文散文（baseline 0）** —— 默认语言是 zh-cn，硬编码英文同样会原样显示给用户，只是 I8 的 CJK 判定看不见。I8b 依赖三条豁免把误报压到 0：`throw new Error`/`new Error(` 视为开发者诊断、`writeJson(`/`res.end(`/`code:`/`invalidField:` 视为给 SampleTester 与浏览器扩展的机器可读载荷、判别字段（`type`/`code`/…）向上回看 6 行以覆盖分行书写的对象字面量。**任何一条被放宽，检查会从零容忍退化成几乎不查，而 PASS 看起来一模一样** —— `tests/i18n.test.js` 尾部已锁死这三条 + baseline 0，并对 `looksLikeProse` 做真实行为断言（4 条散文应命中 / 9 条标识符、路径、URL、MIME、枚举、format token 不应命中）。散文识别要求 **≥2 个 ≥3 字母的完整词**，这一条是把标识符和 CSS 类名挡在外面的关键。写新豁免前先想清楚它会不会顺手放过真阳性。
- **I8/I8b 都是按行判定的，静态 HTML 整类漏**。`userVisibleRe` 要命中 `innerHTML`/`label:`/`title:` 这类 sink 关键字才算用户可见，于是 `<div class="unit">0 表示不限制</div>` 这种「纯文本、无关键字」的行一条都不查 —— 而这恰恰是界面上最直接的文字。同理它认 `title:` 和 `.title =` 却不认 HTML 的 `title="…"`，认 `label:` 却不认 `aria-label="…"`。`tests/static-html-i18n.test.js` 补这个洞，三条不变量：A「含 CJK 却整条祖先链没有 `data-i18n` 的可见文本必须为 0」、B「挂了 `data-i18n` 的元素，其直接内联文本要逐字等于该键的 zh-cn 值」（B 抓的是"同屏换话"：默认值一句、JS 落地另一句）、C「`title` / `aria-label` / `placeholder` 属性必须挂上对应的 `data-i18n-*`，且属性默认值 == 键的 zh-cn 值」。上锁是**逐文件、逐指标**的：`ENFORCED` 里每个文件带一个 `metrics` 字符串（如 `"ABC"`），只锁已清干净的那几条 —— 整体进出会让已经干净的指标退回不检查。**不要为了少改文件放宽 A/B/C 或把指标从 `metrics` 里摘掉**；正确做法是清一条开一条。两个已知的坑：B 条**不能**套 CJK 门槛（`data-i18n="menu.browse"` 配英文默认值 `Browse` 同样是不符，index.html 里这类占大头，套上后 35 条只报得出 5 条）；带 `{token}` 的键不参与逐字比较（默认值写的是示例值）。C 条用「≥2 个 ≥3 字母完整词」把 `SPJ`/`MB`/`Ctrl+P` 这类语言中性值挡在外面。
- **主进程也有同类盲区，且出口更多**：`userVisibleRe` 里有 `title:`/`message:`/`detail:`/`label:`，**却没有 `buttons:`（原生对话框按钮）、`name:`（文件对话框过滤器）、`updateProgress(...)`、写入临时 HTML 再 `loadFile` 的窗口模板**。这曾造成一种半迁移状态：同一个 `showMessageBox` 里 title/message/detail 都 `t()` 了，只有 `buttons:` 留硬编码中文；下载窗整个窗口零 i18n。2026-10-30 起这些出口已全部接完，由下述守卫锁死。守卫见 `tests/main-process-i18n.test.js`，锁法与 static-html 守卫一致（六个出口全部零容忍：buttons、过滤器 name、updateProgress、下载窗 HTML、IPC error 文本、**发去外部终端的 shell 命令字符串**）。第六个是 2026-11-02 补的：`printf '\n程序执行完成，按回车键继续...\n'` 这类写在 `bashCmd` 数组元素里的中文，I8 按行看不见（那一行没有任何 sink 关键字），而它是用户在终端窗口里直接看到的字。顺手把这句话整段过一遍 `quoteForBash` —— 原来单引号硬写在模板里，译文里出现撇号就会把整条 bash 命令截断。两个必须知道的口径细节：
  * 取 `error:` 的值要用 `valueSpan`（按顶层 `,` `}` `;` 收尾）而不是「紧跟其后的第一个字面量」，否则会漏掉 `error: err?.message || '读取压缩包失败'` 这种写法。
  * 该守卫**看不见** `const msg = '中文'; return { error: msg }` 这类先赋值给变量的形状（赋值那一步由 [I12] 拦，见下；流向仍看不见），所以 `ERROR_TEXT_BASELINE` 不等于主进程界面文案总量，别拿它当分母。
  * 判据必须是 `name:` 后紧跟 `extensions:` —— 只有 Electron 对话框过滤器是这个形状。编译器预设 `{ name: 'utf8', sourceMode: ... }` 也用 `name:`，但那是内部标识符、永不上屏，用裸 `name:` 会把它们翻译掉。
- **两处 i18next init 都已关掉对插值的 HTML 转义**（`src/lang/index.ts` 与 `src/renderer/js/i18n.ts` 的 `interpolation.escape`）。i18next 默认转义是为 innerHTML 准备的，而本项目绝大多数消息的终点是 `textContent`、toast 或**原生对话框**，默认值会把插进去的路径 / URL / 带引号的错误原文变成 `&#x2F;` `&#39;` 残渣（曾波及 317 处带插值的 `t()`）。代价是 **HTML 出口现在必须自己转义**，`t()` 不再兜底：主进程 `escapeHtmlText`（登录页 + 两个下载窗模板）、渲染层 `escapeDebugHtml`（调试面板所有 innerHTML）、`codeComparer.escapeHtml`（完成告警）。三条规矩：
  1. 只转义**插进去的那个值**，不要转义整串结果 —— 模板常带 `<br><span style=…>` 这类有意排版（`compare.completedWithWarning` 就是）。
  2. 同一句键可能同时喂 HTML 和 `textContent`（下载窗的 `main.downloadingCompiler`：h3 要转义、`updateProgress` 绝不能转义），所以别把它做成全局行为。
  3. 接主进程译文时一律做「与原硬编码 byte-equal」比对 —— 转义残渣、以及往 JSON 里写 `\n` 结果落成字面反斜杠+n，这两类都只有逐字比对抓得到。
  `tests/i18n-main-process.test.js` 锁住两处配置与四个 HTML 出口；`tests/i18n-renderer-runtime.test.js` 用真实 UMD 断言插值不再被转义。注意别用 `/\{[^}]*\}/` 去框 `interpolation` 配置对象 —— `suffix: '}'` 里那个花括号会让它提前截断（本条第一版就假红了）。
- I7 拦孤儿键（baseline 0，常量 `I18N_ORPHAN_KEY_BASELINE`，见 `scripts/ci-check.js`；2026-11-02 一次退役 186 个从未接线/随功能一起停用的键，判定分「引用面 / git 来源 / I6 回归」三层，缺任何一层都不许清仓，理由写在那常量的注释里）—— 语言包里有、源码里查不到引用的键，存量只锁死不许增长，每清一批降一档。往语言包加键后若报孤儿键超标，说明没接上（反向也一样：`settings/editor.html` 曾有 6 个键早就躺在语言包里却没挂 `data-i18n`，主进程 `validateFileName` 一直在手写中文而 `dialog.nameRequired`/`invalidFileNameChars`/`invalidFileNameCharsUnix`/`reservedFileName`/`fileNameEndDot` 五个键零引用 —— 接线即各降一档）。判定口径同时认字符串字面量和**属性访问**（`main.js:3772` 读语言列表用的是 `content.meta.code`，只认引号会把 `meta.code/name/nameEn` 误判成孤儿）。最后 1 个（`compileOutput.analysisEmpty`）也在同日第二批清掉：它是台账 L10 的断言对象、曾被当作「不许删」的理由，查清它跟 `panel.noParseContent` 是同一句话而界面只用后者之后，断言改指活键、死键退役 —— **拿一条挂在死键上的守卫当保留理由，等于把守卫的失责固化成常量**。
- 「一句话一个键」由 **[I10] 与 [I11]** 拦，唯一实现是 `scripts/i18n-duplicate.js`（豁免表 `DUPLICATE_EXEMPTIONS`/`DRIFT_EXEMPTIONS` 也在那儿，CI 与 `tests/i18n-duplicate-value.test.js` 取同一份，别在测试里重抄一张表）：
  * I10 —— **同一个父对象内**不许两句中文逐字相同。新建键之前先搜值；跨命名空间的同句（`menu.delete` 与 `cloud.delete`）是常态，不报。
  * I11 —— 同一句中文的英文不许各自演化。比较**忽略大小写**，因为 `menu.*`/`keybinding.*` 走 Title Case 而 `main.*Title` 走句首大写是表面约定；比的是用词。
  * 两条的豁免都按**整组键集**逐条消费：登记的那组哪天不再分叉、或者新进来一支键，检查会反过来报红。所以豁免表不会随演化烂成没人核对的旧名单。
  * **判据必须跑在 zh-cn 上**。en 里 `spaceBeforeParensAlways` 与 `useTabAlways` 同为 "Always"，zh 却分得开（「始终」/「始终使用 Tab」）—— 源语言不同就是两个概念，拿 en 跑会误报一片（I10 第一版拿 `localeCodes[0]` 跑，那是 en，当场红 5 组）。
  * **插值参数的形态由宿主句子决定，不由键自己决定**。`message.featureRun` 在英文里是 "running" 而不是菜单标签那句 "Run"，因为它被读进 `message.cloudFileLocalOnly` 的「Using {feature} requires a local file」主语位；换句子框架就得换形态，所以 I11 核对这条豁免时会真去查那个 `{feature}` 槽还在不在。反过来说：给两参 `t()` 传进插值槽的键，值不能只按「这个词怎么译」定，要按它被读进哪一句定。原来那句是「…再使用 {feature}」/"…before using {feature}."，填进去得到「再使用运行」和 "before using running" —— 两种语言都不成句，而 CI 全绿。
  * **插值槽填的必须是能上屏的东西**。`sidebar.ts` 曾把 `'debug'/'samples'/'compare'` 这类**内部 id** 直接当 `{feature}` 传进去，屏幕上是「…，debug需要先下载到本地。」—— 也就是键名而不是语言，而 I6/I7 都看不见（它们只查键存不存在、有没有人引用）。现在这类 id→标签的映射写成一张表，被「哪几个面板被锁」、图标 title、提示句三处共用；`tests/i18n-duplicate-value.test.js` 第 8 段逐调用点核：值要么是 `t(...)`，要么是本文件里单独核过来源的联动变量。
  * 顺带一条测试坑：把常量提到**模块级**之后，那些用 `vm` + 假 DOM 抽方法真跑的守卫会在 context 里查不到它，整段断言静默变空（本次是 M22 六条一起红）。修法是把源码里那段 `const` 声明原样灌进 context（`vm.runInContext(mapDecl[0], ctx)`），**不要在测试里抄一份表**。
- **[I12] 拦「中文被存进变量」**（判据与白名单 `LOG_ONLY_CJK_VARS` 在 `scripts/ci-check.js`，真跑守卫在 `tests/i18n-cjk-in-variable.test.js`）。I8 按行找 sink，所以 `const msg = \`[样例测试器] ${brief}\`; manager.appendOutput(msg)` 这种一行存变量、下一行上屏的写法它一条都不报 —— 实测代价是编译输出面板的前缀在英文界面下仍然是中文。判据只认「等号右边紧跟引号且闭合前含中文」这一种形状，白名单是**行为约束**：登记的变量每一次使用都必须落在 `logX(` 里，被塞进 `showMessage` 就红。两条已知代价写在检查项注释里：`const x = 前缀 + '中文'` 的拼接形状看不见（别为了多抓这一形把 `.*` 加回来，那会让行尾注释里的中文全部假阳——真踩过）；流向仍然要靠人。
- **I8 与 I4 各有一档「看着像存量、其实是判据误报」的 baseline，已经查清并降到 0，别再往回抬**：
  * I8 的 `userVisibleRe` 里 `message:` / `label:` / `title:` / `detail:` 是**标签** sink，但
    `e instanceof Error ? e.message : String(e)` 里的三元冒号长得一模一样，于是 `src/utils/logger.js`
    的一条 stderr 自诊断被当成用户可见文案，ratchet 一直挂着 1。正解是给这四个候选加 `(?<![.\w])`
    —— 属性访问不算标签。判据现在叫 `USER_VISIBLE_RE`，**I8 与 I8b 共用这一份**（两处各写一条正则时，
    改一处忘另一处会让中文与英文散文的覆盖面悄悄分叉）。
  * I4 的「中文标点」原先把 U+201C/201D/2018/2019 也算进去，而它们是**标准英文排版弯引号**；
    en.json 里 `The font “{font}” was not found…` 被冤枉成违规，档位挂着 1 没人解释。
    去掉这四个码位不损失判别力：中文里出现弯引号必然伴随汉字，由「en 不许有汉字」那条负责。
  * 两条都由 `tests/audit-fixes-2026-10-01.test.js`（I8 用 `runCiBlock` 真跑整块）与
    `tests/i18n.test.js`（I4 抽出 `cnPunctRe` 实跑正反两组）钉住，且都验过反向：
    把改动撤掉会立刻红。**降档位必须连「为什么这一档本来就该是 0」一起写进注释**，
    否则下一个人会以为是存量没清完而把它抬回去。

- I7 自己报的「未静态引用」大半是误报：它只认 `t('key')`，认不出 `t(c ? 'a' : 'b')`、`_t(key, fb)`、`t(el.dataset.i18n)`。判断键是否真的没人用，要用宽松口径重算。
- 改语言包时 `zh-cn.json` 与 `en.json` 的**逻辑键集**必须完全一致（I1/I2）、`{token}` 占位符一一对应（I3）；`en.json` 不允许残留中文（I4）或中文标点。
- **数量文案用 i18next 复数形态**（`key_one` / `key_other`），不要写 `{count} 个文件` 这种硬量词。规则都在 `scripts/i18n-plural.js`（唯一实现，CI 与测试都从它取）：需要的类别由该语言的 `Intl.PluralRules` 决定 —— **zh 只许有 `_other`，en 必须 `_one`+`_other` 两支齐全**（少一支是漏译，多一支是永远取不到的死键，I2 都判失败）。源码照旧写 `t('compare.completedText', { count })`，引擎自己挑后缀。
  - **I9：复数键的调用点必须传 `count`。** i18next 只按 `options.count` 选后缀，`{total}` / `{bytes}` / `{uploaded}` 这些名字它不认。所以把一个 `{uploaded} files` 的键复数化而不让调用点补 `count: uploaded`，**不是「没改善」，是裸键上屏**（包里已经没基名了）。这条比复数化本身更容易踩中，因为改语言包时看得见、改调用点看不见。
  - I2 因此比的是逻辑键集，I3 只能逐字面键配对 —— **en 的 `_one` 在 I3 里没有对照物**，兜住它的是「复数各支的 `{token}` 只能少不能多」：单数句丢掉 `{count}`（`"Delete this item?"`）合法，引入默认语言 `_other` 没有的新 token 会让屏幕上原样印出 `{name}`，I2 直接判失败。
  - **不许只转换一半**：一份包拆了 `_one`/`_other`、另一份还留裸基名时，`pluralIssues`（按「这里的键名带后缀」判复数形态）和 `pluralTokenIssues`（参照物正是默认语言的 `_other`）会**同时**跳过这一键，而 i18next 靠回落裸键继续正常渲染，界面毫无症状 —— 守卫在但不干活。`pluralConsistencyIssues` 钉住这一形状，转换必须两边同步。
  - 测试里的假 i18n **必须**用 `plural.lookupFlat(pack, code, key, params)` 取值，不许再写 `pack[key]`。那种桩一旦和真引擎的复数解析漂移，就静默退化成「返回裸键名」，而它守的恰好是不让裸键上屏 —— 于是所有下游断言变成假绿。
  - **两种情况不要复数化**：①**标签式文案**（`剩余文件数量: {count}` / `Remaining files: {count}`）—— 那个名词属于标签而非被数的宾语，n=1 时换成 `1 file remaining` 是整句变形，既不自然也不再镜像 zh；②**没有名词可变的**（`attempt {count}`、`({count} ahead)`），1 和 5 长得一样，加 `_one` 只是死键。`cloud.remainingFiles` 在 7b 被错误地复数化过一次，已撤销。
  - **一句话里有两个可数名词时，先消掉第二个**。i18next 只有一根复数轴（只按 `count` 选支），`({count} items, {remaining} slots left)` 这种无论怎么加 `_one` 都会在 `remaining=1` 时写成 `1 slots left`。正解是把第二处改成无需配合的 `{remaining} left`，而不是硬造 `_one`。
  - **数字不是以 `count` 传进来的键根本没法复数化**：`{n}` / `{total}` / `{bytes}` / `{uploaded}` / `{errors}` 都要先让调用点补上 `count: <同一个表达式>`，否则界面直接显示裸键名（比不复数化更糟）。en 里剩下的 `file(s)` / `error(s)` 这类规避写法就是这么来的。
    补的时候 `count` 必须**就是文案里那个数的表达式**（`{ n: diffMin, count: diffMin }`），只改一边会单复数和数字各说各话。这一条机器判不出可靠的样子（`dialog.importDetected` 那种 `{count}` 本身就在文案里、其它 token 是别的数，任何「count 要等于某个 token」的规则都会误报），所以靠 I9 兜住「有没有传」，「传得对不对」靠人 —— 改这类调用点时把两边一起看。
- 批量正则替换 `window.i18n ? window.i18n.t('k') : 'x'` 这类表达式**极易退化成 `= ('k')`**（I5 专门拦这个）。

### 迁移 .js → .ts（TypeScript 路线甲）
**`.ts` 是唯一手写源，`.js` 由 `tsc -p tsconfig.build.json` 就地 emit 出来**（`rootDir`/`outDir` 同为 `src`），所以 `.js` 不许手改。`tsconfig.json` 负责全量 typecheck；`tsconfig.build.json` 带 `noCheck: true` 且 `include: ["src/**/*.ts", "src/**/*.d.ts"]` —— 全量 emit，**没有白名单要登记**，新增 `.ts` 直接会被编译。`.d.ts` 只进程序不出 JS。

**提交前必须先编译一次**：`npx tsc -p tsconfig.build.json`，然后 `git diff --stat -- src` —— 输出非空就是漂移，两种成因：改了 `.ts` 没编译，或者有人手改了 `.js` 产物。漂移不会让 `tsc --noEmit` 报错（两边各自都合法），所以只能靠这一步兜住。历史上这里靠 `files` 白名单兜，代价是「`.ts` 漏登记 → 它的 `.js` 静默不再重生成」，实测已踩到（`gdb-mi-debugger.ts` 只因为被 `gdb-debugger.ts` 的 `import = require` 传递进程序才没漂），白名单已因此取消。

`.js` ↔ `.ts` 的对应关系仍然成立：`src/` 下每个 `.js` 都有同名 `.ts`。

正确命令序列：
```bash
npx tsc -p tsconfig.build.json   # 重新生成 .js（注意：会用 emit 结果覆盖工作区里的 .js）
git diff --stat -- src           # 提交前必查：非空 = 产物漂移（漏编译或手改了 .js）
node tests/run-tests.js          # 快速回归，定位断言失败
pnpm run ci                      # 完整校验（75 项检查 + 35 个回归测试）
npx tsc --noEmit -p tsconfig.json # 单独数本文件的 tsc error
```
迁移完必须把新文件自身的 error 清到 0，再把 `scripts/ci-check.js` 里的 `TS_ERROR_BASELINE` **往下压到实测总数**（ratchet 只减不增，每清一批降一档）。

**反模式：**

- ❌ 给被 `<script src="…js">` 加载的渲染层文件加 `export`/`import`。`module: commonjs` 会把 `export class` emit 成 `Object.defineProperty(exports, "__esModule", …)`，浏览器脚本标签下 `exports` 未定义 → 整文件运行期炸。判据：**文件尾有没有 `module.exports` 守卫**。有的（Node 侧，如 `terminal-manager.ts`）随意用 ES 语法；没有的（浏览器 script 形态，如 `settings/compiler.ts`、`settings/templates.ts`）必须保持**全局 script**，不加任何 import/export。注意 `templates.ts` 已经踩了这个坑。
- ❌ **用 `any` 躲类型错误**（项目明令禁止）。改用 `unknown` + 局部收窄。收窄后若为保住测试锁定的正文形状而必须换形参名（如 `isTimeoutError(cause)` 内部 `const error = cause as TimeoutLikeError`），同步把那条断言从 `/function isTimeoutError\(error\)/` 放宽成 `/function isTimeoutError\(/`。
- ❌ **`JSDoc 类型标注` 与 `非空断言 !` 同样是禁用项**（2026-10-20 起全仓清零并锁死：`src/` 下 `as any`/`: any`/`any[]`/`/** @type {...} */`/`x!.y` 均为 0，strict 下 `tsc --noEmit` 0 报错，这是新的地板，只许保持不许回潮）。要类型进签名、擦除式 `as T` 或 `unknown` + 局部收窄；`require(...)` 一律交还给 `types: ["node"]` 的 `NodeRequire` 供给（不要再写 `declare function require(...): any` 遮蔽它）。
- ❌ 改测试断言去迎合 emit 产物里**语义**的变化。放宽只能针对**排版**（见下条坑），语义收紧就是自废守卫。

**坑：**

- **tsc 的 printer 会重排源码**：`if (x) return;` → `if (x)\n    return;`，`} catch (e) {` → `}\ncatch (e) {`，空行全被删掉。所以所有**读源码做正则断言**的测试在迁移后必然误报（本轮实测 `security-regression`、`compiler-settings-hardening`、`i18n-main-process` 三处）。修法是把断言的排版敏感点改成空白容忍：`\} catch` → `\}\s*catch`，单行 if 的 `\) return 'x'` → `\)\s*return 'x'`。断言的语义（守卫存在、结构顺序、行为验证）不能动。
- **类型标注要写在会被完全擦除的位置**，这样 emit 产物与原 `.js` 逐字一致：`as T`、`<T>` 泛型实参、`!`、`e.target as HTMLInputElement` 都会擦成原表达式。用 `(expr as T)` 单表达式形式包住整个语句，别拆成 `const a = expr; const b = a as T;`（多出一行，且部分断言按行号/前后文切片）。反过来 `catch (e)` 在 strict 下是 `unknown`，写 `e.message` 必须 `(e as Error).message`。
- **锁定形参名的断言**靠签名擦除成立：`async setCompilerPath(path: string)` → emit 成 `async setCompilerPath(path)`。别把形参改成解构或改名，`tests/audit-fixes-2026-10-01.test.js:298` 用 `indexOf('async setCompilerPath(path)')` 定位。
- 字段声明（`settings: T;`）在 es2022 目标下会 emit 成真实 class field（`settings;`），构造赋值之前先置 `undefined`；字段**只声明不初始化**，赋值全留在构造函数里，否则顺序会覆盖。

## CI / Verification
No lint/typecheck scripts. Only CI is `pnpm run ci` — runs `scripts/ci-check.js` which does static analysis (JS syntax, CSS brace matching, HTML DOCTYPE, file reference resolution, IPC channels, DOM selectors, CSP, secrets/eval scanning, dependency audit, etc.) plus a `[T1]` regression-test step: auto-discovers `tests/*.test.js` via `tests/run-tests.js` (add a new `*.test.js` file to extend the suite; failing test → CI FAIL). CI modes via runtime args: `pnpm run ci:tests` (T1 only), `ci:fast` (skip T1), `ci:strict` (WARN counts as FAIL), `ci:verbose`. No Electron smoke test (the old `ci-local.ps1` was removed; its smoke test leaked orphan electron.exe processes).

## Structure
```
src/
  main.js              — Electron main process entry
  preload.js           — preload script
  main-process/        — main process modules
  renderer/            — renderer (HTML/JS/CSS)
    index.html
    css/
    js/
  lang/                — language definitions
  utils/               — utilities
scripts/
  ci-check.js          — CI checks
tests/
  run-tests.js         — regression test runner (auto-discovers *.test.js)
  preload.test.js      — IPC whitelist / event unwrap / markdown render
  downloader.test.js   — multi-thread downloader md5/cancel/failure restore
```

## Key dependencies
- electron ^37.x
- monaco-editor, xterm, node-pty
- markdown-it, katex, highlight.js
- axios, iconv-lite, winreg
- electron-builder (dev)

## Conventions
- Regression tests = plain Node scripts in `tests/` (`pnpm run ci:tests`), no external test framework.
- CI check = `pnpm run ci` only.
- CSP allows `unsafe-eval` (Monaco needs it).
- No GitHub Actions / GitLab CI / Docker.