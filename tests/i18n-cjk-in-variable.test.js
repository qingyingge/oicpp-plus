'use strict';

// CI 项 [I12]「把含中文的字面量直接赋给变量」的守卫。
//
// 为什么需要它：I8 是按行找「用户可见 sink 关键字 + CJK」，所以
//     const msg = `[样例测试器] ${brief}`;
//     manager.appendOutput?.(`${msg}\n`, 'info');
// 这种「先存进变量、下一行再上屏」的写法一条都不报 —— AGENTS.md 里就记着这个盲区
// （主进程同形：const msg = '中文'; return { error: msg }）。真实代价是这一条：
// sampleTester.notifyCompileCacheHit 的前缀一直硬编码中文，切到英文界面后
// 编译输出面板里仍然显示「[样例测试器]」。
//
// 「变量最终去了哪」机械化不了，所以 I12 只认一种形状（等号右边第一个字符就是开引号、
// 闭合前含中文），并配一张白名单；白名单是**行为约束**不是名字清单 —— 登记的那个变量
// 每一次使用都必须落在 logX( 里，哪天被塞进 showMessage 就立刻红。

const fs = require('fs');
const path = require('path');
const { blockByIndent } = require('./fixtures/source-extract');
const { runCiBlock } = require('./fixtures/ci-block-runner');

const root = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const vfile = (rel, content) => ({ [`/proj/src/${rel}`]: content });
// 白名单条目每次都必须成立，所以每个用例都带上这份 main.ts；
// 不带的话「白名单已失效」那条会跟着一起红，报的就不是本用例想隔离的东西了。
const WHITELIST_MAIN = vfile('main.ts', [
    "const logLine = '[LSP] 请求失败, id=' + id;",
    'logError(logLine);',
    ''].join('\n'));

const ciSrc = fs.readFileSync(path.join(root, 'scripts/ci-check.js'), 'utf8');
const I12 = blockByIndent(ciSrc, /\[I12\] CJK string assigned to a variable/);
check('I12 整块抽得出来（真跑的必须是它，不是测试里重抄的判据）',
    I12.startsWith('{') && I12.includes('LOG_ONLY_CJK_VARS'), JSON.stringify(I12.slice(0, 60)));

if (I12.startsWith('{')) {
    // 1. 主案：中文存进变量 → 报，且点名变量与文件
    {
        const { fails } = runCiBlock(I12, Object.assign({}, WHITELIST_MAIN,
            vfile('renderer/js/sidebar/sampleTester.ts', "const msg = `[样例测试器] ${brief}`;\nmanager.appendOutput(`${msg}`);\n")));
        check('硬编码中文赋给变量 → 报红并点名 msg',
            fails.length === 1 && fails[0].includes('sampleTester.ts') && fails[0].includes('msg'),
            JSON.stringify(fails));
    }
    // 2. 对照：同样一句中文，走 t() 就不报（判据不是「看见中文就红」）
    {
        const { fails } = runCiBlock(I12, Object.assign({}, WHITELIST_MAIN,
            vfile('renderer/js/sidebar/sampleTester.ts', "const msg = `[${window.i18n.t('tester.title')}] ${brief}`;\n")));
        check('对照：前缀取自 t() → 一条不报', fails.length === 0, JSON.stringify(fails));
    }
    // 3. 白名单的正反面
    {
        const ok = runCiBlock(I12, WHITELIST_MAIN);
        check('logLine 只用在一个 logError 里 → 放行（且豁免被真跑核对过）',
            ok.fails.length === 0 && ok.oks.length === 1, JSON.stringify(ok));
        const leak = runCiBlock(I12, vfile('main.ts', [
            "const logLine = '[LSP] 请求失败, id=' + id;",
            'logError(logLine);',
            'showMessage(logLine);',
            ''].join('\n')));
        check('同一个变量被塞进 showMessage → 白名单的前提当场作废并报红',
            leak.fails.some((m) => m.includes('logLine') && m.includes('日志之外')),
            JSON.stringify(leak.fails));
    }
    // 4. 曾经假阳的两个形状，现在是硬断言：注释里的中文不算命中
    {
        const { fails } = runCiBlock(I12, Object.assign({}, WHITELIST_MAIN, {
            '/proj/src/a.ts': [
                "let currentTheme = 'dark'; // 默认深色主题",
                "let fontFamily = 'Consolas'; // 默认字体",
                "// const note = '这是注释里的中文'",
                "/* const note2 = '块注释里的中文' */",
                "let fontSize = 14; // 默认字体大小",
                ''].join('\n')
        }));
        check('行尾注释与整行注释里的中文不算命中（I12 的两条历史假阳）',
            fails.length === 0, JSON.stringify(fails));
    }
    // 5. 拼接形状是**已知看不见**的代价，登记成断言而不是留着当惊喜
    {
        const { fails } = runCiBlock(I12, Object.assign({}, WHITELIST_MAIN,
            vfile('a.ts', "const x = prefix + '中文后缀';\nshowMessage(x);\n")));
        check('已知盲区：const x = 前缀 + \'中文\' 这种拼接形状看不见（判据要求等号后紧跟引号）',
            fails.length === 0, JSON.stringify(fails));
    }
}

// 6. 真仓库落点：被 I12 抓出来的那一处已经改成译文，且没有回潮
{
    const src = fs.readFileSync(path.join(root, 'src/renderer/js/sidebar/sampleTester.ts'), 'utf8');
    check('sampleTester 的缓存命中标签取自 tester.title 键',
        src.includes("`[${window.i18n.t('tester.title')}] ${brief}`"),
        String(/\[样例测试器\]/.test(src)));
    // 精确到那条赋值语句：源码注释里现在还会提「[样例测试器]」这个旧形状，那是说明不是回归。
    check('那条硬编码赋值已经不在（const msg = `[样例测试器] …`）',
        !/const msg = `\[样例测试器\]/.test(src));
    // tester.title 必须两份包里都有，否则上面那句会退化成裸键上屏
    for (const code of ['zh-cn', 'en']) {
        const pack = JSON.parse(fs.readFileSync(path.join(root, 'src/lang', `${code}.json`), 'utf8'));
        check(`tester.title 在 ${code} 包里（标签取键之后该键不许被删）`,
            typeof (pack.tester || {}).title === 'string' && (pack.tester || {}).title.length > 0,
            JSON.stringify((pack.tester || {}).title));
    }
}

console.log(`i18n-cjk-in-variable tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
