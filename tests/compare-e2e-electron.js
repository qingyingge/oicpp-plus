// 真机端到端：起真实的 Electron app（真实主进程 + 真实 preload + 真实渲染层），
// 用 CDP 驱动对拍器跑真正的 g++ 编译与真正的 testlib checker，然后读界面上实际
// 渲染出来的文字。
//
// 它验的是所有 vm/正则守卫都碰不到的那段路径：编译 IPC 真跑通、引擎真收到 spjExe、
// checker 真被起来判定、freopen 的文件真的落真的收、错误面板真按 code 查到 i18n 文案
// （而不是把裸键名印在屏幕上）、没有正解时「标准程序输出」那一节真的被藏起来。
//
// 手动运行（**故意不叫 *.test.js** —— run-tests.js 只发现 *.test.js，而没装 electron
// 二进制、没有 C++ 编译器、没有 X 的机器跑不了它，混进套件会直接让 CI 变红；同
// smoke-electron.js 的先例）：
//   node tests/compare-e2e-electron.js
//
// 数据根走 OICPP_DATA_ROOT 临时目录（见 AGENTS.md「便携版」一节的_env_ 覆盖），
// 不碰使用者真实的 .oicpp-plus。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9311;
const TIMEOUT_MS = 300000;

let failures = 0;
let ran = 0;
const check = (name, cond, extra = '') => {
    ran++;
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-spj-e2e-'));
const DATAROOT = path.join(WORK, 'data-root');
fs.mkdirSync(DATAROOT, { recursive: true });

// app 读的是 <数据根>/.oicpp-plus/settings.json（OICPP_DATA_ROOT 给的是外层），
// 写错位置不会有任何报错，只会让 checker 因为找不到 testlib.h 而编译失败。
const USER_SETTINGS = path.join(os.homedir(), '.oicpp-plus', 'settings.json');
if (fs.existsSync(USER_SETTINGS)) {
    fs.mkdirSync(path.join(DATAROOT, '.oicpp-plus'), { recursive: true });
    fs.copyFileSync(USER_SETTINGS, path.join(DATAROOT, '.oicpp-plus', 'settings.json'));
}

const write = (name, body) => {
    const p = path.join(WORK, name);
    fs.writeFileSync(p, body);
    return p;
};

// 数据生成器：每组给一对随机整数，三组输入各不相同（用微秒做种，同一秒内连续跑也不会
// 拿到同一对数 —— 拿 time() 做种的话三组输入完全相同，「每组独立」这件事就没在测）
const GEN = write('gen.cpp', `#include <cstdio>
#include <cstdlib>
#include <sys/time.h>
int main(){ struct timeval tv; gettimeofday(&tv, nullptr);
  srand((unsigned)(tv.tv_sec ^ tv.tv_usec));
  printf("%d %d\\n", rand()%500+1, rand()%500+1); return 0; }
`);
// 正解：只参与产出 answer，不参与判等
const STD = write('std.cpp', `#include <cstdio>
int main(){ long long a,b; if(scanf("%lld %lld",&a,&b)!=2) return 1; printf("%lld\\n", a+b); return 0; }
`);
const CUR_OK = write('cur-ok.cpp', `#include <cstdio>
int main(){ long long a,b; if(scanf("%lld %lld",&a,&b)!=2) return 1; printf("%lld\\n", a+b); return 0; }
`);
const CUR_BAD = write('cur-bad.cpp', `#include <cstdio>
int main(){ long long a,b; if(scanf("%lld %lld",&a,&b)!=2) return 1; printf("%lld\\n", a+b+1); return 0; }
`);
// 真 testlib checker，且它自己验答案（不读 ans）—— 这正是「正解可以留空」那一类
const CHECKER = write('checker.cpp', `#include "testlib.h"
using namespace std;
int main(int argc, char *argv[]) {
    setName("verify the sum");
    registerTestlibCmd(argc, argv);
    int a = inf.readInt();
    int b = inf.readInt();
    int p = ouf.readInt(-1000000000, 1000000000, "the sum");
    if (p == a + b) quitf(_ok, "sum is correct: %d", p);
    quitf(_wa, "expected %d, found %d", a + b, p);
}
`);

// freopen 型程序：完全不看父进程重定向的 stdin/stdout，自己按相对路径开文件。
// 它们以前只能整轮退回旧引擎（每测三次 IPC 往返、没有 native、没有 worker 并行）。
const FP_STD = write('fp-std.cpp', `#include <cstdio>
int main(){ FILE* f = fopen("data.in", "r"); long long a, b;
  if (fscanf(f, "%lld %lld", &a, &b) != 2) return 1;
  FILE* o = fopen("data.out", "w"); fprintf(o, "%lld\\n", a + b); return 0; }
`);
const FP_BAD = write('fp-bad.cpp', `#include <cstdio>
int main(){ FILE* f = fopen("data.in", "r"); long long a, b;
  if (fscanf(f, "%lld %lld", &a, &b) != 2) return 1;
  FILE* o = fopen("data.out", "w"); fprintf(o, "%lld\\n", a + b + 1); return 0; }
`);

const TESTLIB = '/root/.oicpp/Testlibs/0.9.41/testlib.h';
if (!fs.existsSync(TESTLIB)) {
    console.log(`[SKIP] 找不到 testlib.h：${TESTLIB}`);
    process.exit(0);
}

const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron');
if (!fs.existsSync(ELECTRON)) {
    console.log('[SKIP] 没有 electron 二进制（node_modules/electron/dist/electron），也无法在 CI 里下载');
    process.exit(0);
}

const electronBin = ELECTRON;
const childArgs = ['.', '--no-sandbox', `--remote-debugging-port=${PORT}`];

// Electron 是单实例的：上一个没退干净的实例会让本次「主进程启动完成、但没有窗口」，
// 表现成一句错都报不出来的死等（踩过，白等了五分钟）。先拦住，给个能看懂的原因。
const staleCheck = spawn('ps', ['-eo', 'args']);
let staleText = '';
staleCheck.stdout.on('data', (d) => { staleText += d.toString(); });
const staleReady = new Promise((resolve) => staleCheck.on('close', () => {
    const mine = staleText.split('\n').filter(l => l.indexOf('dist/electron') >= 0 && l.indexOf('grep') < 0).length;
    if (mine > 0) {
        console.log(`[FAIL] 已经有 ${mine} 个本项目的 electron 实例在跑；单实例锁会让本次起不了窗口。` +
            `先退干净再跑：\n  ps -eo pid,args | grep dist/electron | grep -v grep | awk '{print $1}' | xargs -r kill -9`);
        process.exit(1);
    }
    resolve();
}));

// 一律走 xvfb-run：直接挂到使用者已有的 DISPLAY 上时，窗口归属与别的应用互相干扰，
// 冒烟结果不可复现（实测同一段驱动脚本在两种起法下就绪时机不同）。
// detached + 按进程组杀：xvfb-run 只是包装，杀它留 electron 子孙在跑，下一次就被上面的
// 单实例检查拦住 —— 泄漏的实例比测试失败本身更难查。
let child = null;
staleReady.then(() => {
    child = spawn('xvfb-run', ['-a', electronBin].concat(childArgs), {
        cwd: ROOT,
        detached: true,
        env: Object.assign({}, process.env, { OICPP_DATA_ROOT: DATAROOT })
    });
    child.stdout.on('data', () => { });
    child.stderr.on('data', () => { });
    return waitForPage();
}).then(async (page) => {
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send('Runtime.enable');
    await waitForComparer(cdp);
    return runAll(cdp);
}).catch(e => { cleanup(); console.log('[FAIL] e2e 自身异常: ' + ((e && e.stack) || e)); process.exit(1); });

const cleanup = () => {
    // 按进程组杀：child 是 xvfb-run，electron 是它的子孙，只杀包装会留下实例占住单实例锁
    if (child && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (__) { } }
    }
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch (_) { }
};
setTimeout(() => { console.log('[FAIL] 整体超时：e2e 没有跑到结尾'); cleanup(); process.exit(1); }, TIMEOUT_MS);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
    const res = await fetch(url);
    return JSON.parse(await res.text());
}

// 页内驱动脚本：配置全走 codeComparer 自己的实例字段与真实 DOM 输入，
// 然后调真实的 startComparison()（编译、引擎、错误面板全是真链路）
const driver = (cfg) => `(async () => {
    const cc = window.codeComparer;
    if (!cc) return { fatal: 'window.codeComparer 不存在（渲染层没起来）' };
    cc.testCodePath = ${JSON.stringify(cfg.cur)};
    cc.standardCodePath = ${JSON.stringify(cfg.std === null ? '' : cfg.std)};
    cc.generatorPath = ${JSON.stringify(cfg.gen)};
    cc.useTestlib = ${JSON.stringify(!!cfg.spj)};
    cc.spjPath = ${JSON.stringify(cfg.spj || '')};
    cc.freopenInputFile = ${JSON.stringify(cfg.freopenIn || '')};
    cc.freopenOutputFile = ${JSON.stringify(cfg.freopenOut || '')};
    const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    setVal('compare-count', String(${cfg.count || 3}));
    setVal('time-limit', '2000');
    setVal('compare-threads', String(${cfg.threads || 2}));
    // freopen 的文件名以 DOM 为准（syncInstanceConfigToTask 先读输入框），必须真填进去
    const freopenInputEl = document.getElementById('compare-freopen-input-file');
    const freopenOutputEl = document.getElementById('compare-freopen-output-file');
    if (freopenInputEl) freopenInputEl.value = ${JSON.stringify(cfg.freopenIn || '')};
    if (freopenOutputEl) freopenOutputEl.value = ${JSON.stringify(cfg.freopenOut || '')};

    const key = cc.normalizeTaskKey(cc.testCodePath);
    const keys = Object.keys(cc.tasks || {});
    const mapKeys = cc.tasks && typeof cc.tasks.keys === 'function' ? Array.from(cc.tasks.keys()) : [];
    // 同一个被测文件复用同一个任务；上一条留下的 mode='error' 会被下面的轮询当成
    // 「已经收尾」，于是这一条读到的是上一条的结论。先清干净再跑。
    const prev = cc.tasks.get(key) || cc.tasks.get(mapKeys[0]);
    if (prev) { prev.state.mode = 'idle'; prev.state.errorResult = null; prev.state.completedTests = 0; prev.state.failedTests = 0; prev.state.isRunning = false; prev.state.starting = false; }
    const running = cc.startComparison();
    const deadline = Date.now() + 45000;
    let settled = false;
    while (Date.now() < deadline) {
        const t = cc.tasks.get(key) || cc.tasks.get(mapKeys[0]);
        if (t && !t.state.starting && !t.state.isRunning && t.state.mode !== 'idle' && t.state.mode !== 'running') { settled = true; break; }
        await new Promise(r => setTimeout(r, 100));
    }
    const t = cc.tasks.get(key) || cc.tasks.get(mapKeys[0]);
    if (!t) return { fatal: '任务没建出来，key=' + key + ', mapKeys=' + JSON.stringify(mapKeys) + ', objKeys=' + JSON.stringify(keys) };
    if (!settled) return { fatal: '等不到收尾，mode=' + t.state.mode + ' isRunning=' + t.state.isRunning + ' starting=' + t.state.starting + ' completed=' + t.state.completedTests };
    await running;
    const er = t.state.errorResult;
    const stdPre = document.getElementById('std-output-diff');
    return {
        mode: t.state.mode,
        completed: t.state.completedTests,
        failed: t.state.failedTests,
        engineSawSpj: true,
        errorType: er ? er.errorType : null,
        errorCode: er ? er.errorCode : null,
        errorMessage: er ? er.errorMessage : null,
        rawErrorMessage: er ? er.rawErrorMessage : null,
        usedSpj: er ? er.usedSpj : null,
        stdOutput: er ? er.stdOutput : null,
        testOutput: er ? er.testOutput : null,
        input: er ? er.input : null,
        title: (document.getElementById('error-title') || {}).textContent,
        testLabel: (document.getElementById('test-output-diff-label') || {}).textContent,
        testPanel: (document.getElementById('test-output-diff') || {}).textContent,
        stdSectionDisplay: stdPre && stdPre.parentElement ? stdPre.parentElement.style.display : null,
        stdPanel: stdPre ? stdPre.textContent : null,
        progressText: (document.getElementById('progress-text') || {}).textContent,
        statusText: (document.getElementById('compare-status') || {}).textContent,
        // 屏幕上出现裸键名就是 i18n 没接上，CI 的静态检查看不见这种运行期失配
        bareKeys: [ (document.getElementById('error-title')||{}).textContent,
                    er ? er.errorMessage : null,
                    (document.getElementById('test-output-diff-label')||{}).textContent ]
                    .filter(s => typeof s === 'string' && /\\bcompare\\.[A-Za-z]+/.test(s))
    };
})()`;

async function runCase(cdp, cfg) {
    const t0 = Date.now();
    console.log(`  … case: cur=${path.basename(cfg.cur)} std=${cfg.std === null ? '(空)' : path.basename(cfg.std)} checker=${cfg.spj ? 'yes' : 'no'} count=${cfg.count || 3}`);
    const res = await cdp.send('Runtime.evaluate', { expression: driver(cfg), awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error('页内异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 400));
    const value = res.result.value;
    const detail = value && value.rawErrorMessage ? ' ' + String(value.rawErrorMessage).replace(/\s+/g, ' ').slice(0, 220) : '';
    console.log(`    → ${Date.now() - t0}ms ${value && value.fatal ? 'FATAL ' + value.fatal : 'mode=' + (value && value.mode) + ' err=' + (value && value.errorType) + detail}`);
    if (!value || value.fatal) throw new Error('e2e 前置条件不成立: ' + JSON.stringify(value));
    return value;
}

// 页面目标出现 ≠ 渲染层跑完：window.codeComparer 是 init.js 最后一批脚本才挂上去的，
// 不等它就驱动，拿到的全是「对象不存在」，而每条断言都会因此假红（或更糟：假绿）。
async function waitForComparer(cdp) {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
        const res = await cdp.send('Runtime.evaluate', { expression: 'typeof window.codeComparer === "object" && !!window.codeComparer.startComparison', returnByValue: true });
        if (res.result && res.result.value === true) return true;
        await sleep(1000);
    }
    throw new Error('等不到 window.codeComparer（渲染层脚本没跑完？）');
}

async function waitForPage() {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
        try {
            const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
            const page = list.find(t => t.type === 'page' && /index\.html/.test(t.url));
            if (page && page.webSocketDebuggerUrl) return page;
        } catch (_) { }
        await sleep(500);
    }
    throw new Error('等不到 renderer 页面目标（app 没起来？）');
}

class Cdp {
    constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
        ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); p.resolve(msg); }
        });
    }
    send(method, params) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve: (m) => m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error).slice(0, 300))) : resolve(m.result) });
            this.ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
    }
    static async connect(url) {
        for (let i = 0; i < 20; i++) {
            try {
                const ws = new WebSocket(url);
                await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
                return new Cdp(ws);
            } catch (_) { await sleep(500); }
        }
        throw new Error('CDP 连不上');
    }
}

async function runAll(cdp) {
    // 先确认真 testlib checker 能被 app 自己的编译路径编出来（编不出来后面全是假绿）
    const boot = await runCase(cdp, { cur: CUR_OK, std: STD, gen: GEN, spj: null, count: 1 });
    check('渲染层与对拍器就绪，无 checker 的文本判等能跑完（编译器与真程序都接通了）',
        (boot.mode === 'complete' || boot.mode === 'stopped') && boot.completed >= 1 && !boot.errorType,
        JSON.stringify({ mode: boot.mode, completed: boot.completed, errorType: boot.errorType, msg: boot.rawErrorMessage }));

    const ok = await runCase(cdp, { cur: CUR_OK, std: STD, gen: GEN, spj: CHECKER, count: 3 });
    check('SPJ + 真 testlib checker：答案正确的程序 3 组全部判过，一个错误都没有',
        !ok.fatal && ok.completed === 3 && (!ok.errorType),
        JSON.stringify({ mode: ok.mode, completed: ok.completed, errorType: ok.errorType, errorCode: ok.errorCode }));

    const bad = await runCase(cdp, { cur: CUR_BAD, std: STD, gen: GEN, spj: CHECKER, count: 3 });
    check('SPJ + 答案错误的程序：判成 checker 的 WA（spj_wa），不是引擎错误也不是文本 mismatch',
        bad.errorType === 'spj_wa' && bad.errorCode === 'spj_wa',
        JSON.stringify({ errorType: bad.errorType, errorCode: bad.errorCode }));
    check('checker 的判词真的到了界面上（"expected X, found Y"，不是只会说不）',
        typeof bad.rawErrorMessage === 'string' && /expected \d+, found \d+/.test(bad.rawErrorMessage),
        JSON.stringify(bad.rawErrorMessage));
    check('错误面板标题是本地化文案而不是裸键名',
        Array.isArray(bad.bareKeys) && bad.bareKeys.length === 0 && typeof bad.title === 'string' && bad.title.length > 0,
        JSON.stringify({ title: bad.title, bareKeys: bad.bareKeys }));
    check('填了正解时「标准程序输出」那一节仍然显示（有内容可看）',
        bad.stdSectionDisplay === '' && typeof bad.stdOutput === 'string' && bad.stdOutput.trim().length > 0,
        JSON.stringify({ display: bad.stdSectionDisplay, stdOutput: bad.stdOutput }));
    check('待测程序输出与输入都带回了面板',
        typeof bad.testOutput === 'string' && bad.testOutput.trim().length > 0 && typeof bad.input === 'string' && bad.input.trim().length > 0,
        JSON.stringify({ test: bad.testOutput, input: bad.input }));

    const noStd = await runCase(cdp, { cur: CUR_BAD, std: null, gen: GEN, spj: CHECKER, count: 3 });
    check('正解留空也能判定：SPJ 不要求填正解（自己验答案的 checker 用空 answer）',
        noStd.errorType === 'spj_wa' && !noStd.stdOutput,
        JSON.stringify({ errorType: noStd.errorType, stdOutput: noStd.stdOutput }));
    check('正解留空时「标准程序输出」整节被藏掉（留个空面板比不显示更误导）',
        noStd.stdSectionDisplay === 'none',
        JSON.stringify({ display: noStd.stdSectionDisplay }));

    const back = await runCase(cdp, { cur: CUR_BAD, std: STD, gen: GEN, spj: CHECKER, count: 3 });
    check('隐藏状态不残留：上一条没正解、这一条有正解，那一节必须重新显示出来',
        back.stdSectionDisplay === '' && typeof back.stdOutput === 'string' && back.stdOutput.trim().length > 0,
        JSON.stringify({ display: back.stdSectionDisplay, stdOutput: back.stdOutput }));

    const broken = await runCase(cdp, { cur: CUR_OK, std: path.join(WORK, 'no-such-file.cpp'), gen: GEN, spj: CHECKER, count: 1 });
    check('正解填了但编译不过：如实报错，不静默降级成无正解模式',
        broken.mode === 'error' && broken.errorType === 'compile_error' && broken.completed === 0,
        JSON.stringify({ mode: broken.mode, errorType: broken.errorType, completed: broken.completed }));

    // ---- freopen：真实 app 里跑真正 fopen 文件的程序 ----
    // 配了 freopen 后 std 也要走文件，所以两个程序都用 freopen 版；
    // 拿一个只读 stdin 的程序当正解的话，它会因为 stdin 被清空而产出空文件，
    // 测的就不是 freopen 而是「谁没读到输入」了。
    const fpOk = await runCase(cdp, {
        cur: FP_STD, std: FP_STD, gen: GEN, spj: null,
        count: 4, threads: 2, freopenIn: 'data.in', freopenOut: 'data.out'
    });
    check('freopen 程序跑在新引擎上：4 组 × 2 worker 全部判过',
        fpOk.mode === 'complete' && fpOk.completed === 4 && !fpOk.errorType,
        JSON.stringify({ mode: fpOk.mode, completed: fpOk.completed, err: fpOk.errorType, msg: fpOk.rawErrorMessage }));

    const fpBad = await runCase(cdp, {
        cur: FP_BAD, std: FP_STD, gen: GEN, spj: null,
        count: 4, threads: 2, freopenIn: 'data.in', freopenOut: 'data.out'
    });
    check('freopen 下差异判得出来，且带回来的正是文件里的内容（不是空 stdout）',
        fpBad.errorType === 'mismatch' && /^\d+$/.test(String(fpBad.stdOutput).trim())
        && /^\d+$/.test(String(fpBad.testOutput).trim())
        && String(fpBad.stdOutput).trim() !== String(fpBad.testOutput).trim(),
        JSON.stringify({ type: fpBad.errorType, std: fpBad.stdOutput, test: fpBad.testOutput }));

    // slot 布局是「每 worker × 每角色」两个固定目录长期复用；旧引擎那套是
    // freopen_runs/<任务名>/<角色>_<组号> —— 每组一个目录、跑完只删文件不删目录。
    // 看到旧布局就说明还有代码路径走回旧引擎去了。
    const runsRoot = path.join(DATAROOT, '.oicpp-plus', 'compare', 'freopen_runs');
    const workerDirs = fs.existsSync(runsRoot) ? fs.readdirSync(runsRoot) : [];
    const rolesOf = workerDirs.map(w => fs.readdirSync(path.join(runsRoot, w)).sort().join(','));
    const legacyShapes = workerDirs.filter(w => !/^w\d+$/.test(w));
    check('slot 目录是新布局（每 worker 一套、角色分目录），旧引擎的每组一目录形态没有再出现',
        workerDirs.length === 2 && rolesOf.every(r => r === 'std,test') && legacyShapes.length === 0,
        JSON.stringify({ workerDirs: workerDirs, rolesOf: rolesOf }));

    await cdp.send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => { });
    cleanup();
    if (ran === 0) { console.log('[FAIL] 一条断言都没跑'); failures++; }
    console.log(`\n${ran} 条断言，${failures} 失败`);
    process.exit(failures ? 1 : 0);
}
