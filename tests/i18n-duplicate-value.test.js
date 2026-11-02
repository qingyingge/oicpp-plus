'use strict';

// scripts/i18n-duplicate.js 与 CI 项 [I10]/[I11] 的守卫。
//
// 起因是台账 L10：包里挂着两个键，中文逐字相同（「暂无可解析的内容，先查看原始输出或等待下
// 一次编译。」），而界面真正取用的只有 panel.noParseContent，compileOutput.analysisEmpty
// 从未接线。16c4bfd 当年修的是那个没在用的键，于是「已修复」的台账条目与实际症状并存，
// 直到把这串的 5 次提交（6e28d60 建键 → 015fb4b 立案 → 16c4bfd 改值 → c3fa954 写守卫 →
// 1be2b08 记 fix.commit）逐个查过，才看清「改的从来不是上屏的那句」。根因不是翻译，是同一句话两个键。
//
// I1~I9 全是逐键自问自答（两边都有吗、能解析吗、en 有没有残留中文、有没有人引用），
// 一条都不会问「这两个键是不是同一句话」。所以这里补两条：
//   [I10] 同一个父对象内不许两句中文逐字相同（新建键前先复用）；
//   [I11] 同一句中文的英文不许各自演化 —— 分叉之后「这句走哪个键」又得靠 git 考古，
//         而那正是 L10 花掉 5 次提交的地方。
// 判据细节与为什么不看 en、不跨命名空间、什么时候允许不同，写在 scripts/i18n-duplicate.js 的头注释里。

const fs = require('fs');
const path = require('path');
const { blockByIndent } = require('./fixtures/source-extract');
const { loadLocales, runCiBlock } = require('./fixtures/ci-block-runner');
const {
    DRIFT_EXEMPTIONS, DUPLICATE_EXEMPTIONS, partitionGroups, sameParentDuplicates, translationDriftGroups,
} = require('../scripts/i18n-duplicate');

const root = path.resolve(__dirname, '..');
let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

// ---------------------------------------------------------------------------
// 1. 判据本身（合成包：每条都要能既红又绿）
// ---------------------------------------------------------------------------
{
    const two = sameParentDuplicates({ 'menu.save': '保存', 'menu.store': '保存', 'panel.save': '保存' });
    check('同父对象同句 → 报一组', two.length === 1 && two[0].parent === 'menu', JSON.stringify(two));
    check('跨父对象的那一份不报（范围就是「同一个对象内」）',
        two.length === 1 && !two[0].bases.includes('panel.save'), JSON.stringify(two));
    check('重复组带上原句，报红时人能直接判断', two[0].value === '保存', two[0].value);
    check('bases 给出的是逻辑键名', two[0].bases.join() === 'menu.save,menu.store', two[0].bases.join());

    const plural = sameParentDuplicates({ 'tester.n_one': '1 个', 'tester.n_other': '1 个', 'tester.m': '1 个' });
    check('复数兄弟形态同句算合法形状，不因 zh 的 one/other 同文而虚报',
        plural.length === 1 && plural[0].bases.join() === 'tester.m,tester.n', JSON.stringify(plural));

    const blank = sameParentDuplicates({ 'a.x': '   ', 'a.y': '', 'a.z': ' x ', 'a.w': 'x' });
    check('空值不计，两侧都 trim 后才比较',
        blank.length === 1 && blank[0].bases.join() === 'a.w,a.z', JSON.stringify(blank));

    const orderA = sameParentDuplicates({ 'g.b': '同', 'g.a': '同' });
    const orderB = sameParentDuplicates({ 'g.c': '同', 'g.a': '同', 'g.b': '同' });
    check('输出顺序与 JSON 键序无关（CI 与测试拿到的必须是同一个列表）',
        JSON.stringify(orderA) === JSON.stringify(sameParentDuplicates({ 'g.a': '同', 'g.b': '同' }))
            && orderB.length === 1 && orderB[0].bases.join() === 'g.a,g.b,g.c',
        JSON.stringify({ orderA, orderB }));

    const pair = sameParentDuplicates({ 'g.a': '同', 'g.b': '同', 'g.c': '异' });
    const hit = partitionGroups(pair, [{ keys: ['g.a', 'g.b'], reason: 'x' }]);
    check('豁免恰好消费一组时 violations 与 stale 都空',
        hit.violations.length === 0 && hit.stale.length === 0, JSON.stringify(hit));
    const stale = partitionGroups(pair, [{ keys: ['g.a', 'g.zz'], reason: '已不成立' }]);
    check('豁免不再对应真实重复 → 列进 stale，这张表不许烂成旧名单',
        stale.stale.length === 1 && stale.violations.length === 1, JSON.stringify(stale));
    const none = partitionGroups(pair, []);
    check('表为空时全部报红（不会因为没登记就自动放行）',
        none.violations.length === 1, JSON.stringify(none));
    const triple = partitionGroups(sameParentDuplicates({ 'g.a': '同', 'g.b': '同', 'g.c': '同' }),
        [{ keys: ['g.a', 'g.b'], reason: '只登记两支' }]);
    check('豁免按**整组键集**匹配，不是两两匹配（三支只登记两支不许放行）',
        triple.violations.length === 1 && triple.stale.length === 1, JSON.stringify(triple));
}

// ---------------------------------------------------------------------------
// 2. 真语言包
// ---------------------------------------------------------------------------
{
    const locales = loadLocales();
    const dupes = sameParentDuplicates(locales['zh-cn']);
    const { violations, stale } = partitionGroups(dupes, DUPLICATE_EXEMPTIONS);
    check('真包（zh-cn）没有未登记的同句键', violations.length === 0, JSON.stringify(violations));
    check('豁免表每条都仍然成立', stale.length === 0, JSON.stringify(stale));
    check('判据是真跑出来的（真包里确实有 N 组且 N==豁免条数，不许 0==0 假绿）',
        dupes.length > 0 && dupes.length === DUPLICATE_EXEMPTIONS.length,
        JSON.stringify({ dupes: dupes.length, exemptions: DUPLICATE_EXEMPTIONS.length }));

    // 登记不等于「登记得对」：逐条复跑三件事 —— 两个键都还在包里、值仍然逐字相同、
    // 而且**两个都还在源码里被引用**。哪天其中一支变成孤儿，那是 I7 该处理的死孪生键，
    // 不该挂在这张表上（L10 的孪生键正是「孤儿 + 同句」，靠 I7 归零才终于露出来）。
    const srcBlobs = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (/\.(js|html)$/.test(entry.name) && !p.includes(`${path.sep}lang${path.sep}`)) {
                srcBlobs.push(fs.readFileSync(p, 'utf8'));
            }
        }
    };
    walk(path.join(root, 'src'));
    const mentioned = (key) => srcBlobs.some((blob) => blob.includes(key));
    for (const ex of DUPLICATE_EXEMPTIONS) {
        const values = ex.keys.map((k) => locales['zh-cn'][k]);
        check(`豁免 ${ex.keys.join(' / ')} 两支都仍在包里且同句`,
            values.every((v) => typeof v === 'string' && v.length > 0) && new Set(values).size === 1,
            JSON.stringify(values));
        for (const key of ex.keys) {
            check(`豁免 ${key} 仍在源码里被引用（变成孤儿就该按孤儿删掉，不许挂豁免）`, mentioned(key));
        }
    }
}

// ---------------------------------------------------------------------------
// 3. 接线：真跑 ci-check 里的 [I10] 整块
// ---------------------------------------------------------------------------
{
    const ciSrc = fs.readFileSync(path.join(root, 'scripts/ci-check.js'), 'utf8');
    const block = blockByIndent(ciSrc, /\[I10\] Same-parent duplicate values/);
    check('I10 整块抽得出来，且用的就是 ci-check 里那份 require（不是测试里的副本）',
        block.startsWith('{') && block.includes("require('./i18n-duplicate')"),
        JSON.stringify(block.slice(0, 80)));
    if (block.startsWith('{')) {
        const real = runCiBlock(block, {});
        check('真包真跑：一条不报，并给出一条 ok 汇总',
            real.fails.length === 0 && real.oks.length === 1, JSON.stringify(real));

        // 变异键特意选 dialog.ok 而不是 menu.run* —— 后者那一对本来就在豁免表里，
        // 再塞第三支会把整组撑成三支，同时触发「未登记」和「豁免失效」两条，
        // 于是这条变异测的就不是「新孪生键会被抓」这一件事了。
        const mutated = loadLocales();
        mutated['zh-cn']['dialog.okTwin'] = mutated['zh-cn']['dialog.ok'];
        const twin = runCiBlock(block, {}, { locales: mutated });
        check('变异真跑：塞一个同父同句的孪生键 → 报红且两个键名都点出来',
            twin.fails.length === 1 && twin.fails[0].includes('dialog.ok') && twin.fails[0].includes('dialog.okTwin'),
            JSON.stringify(twin.fails));

        const drifted = loadLocales();
        drifted['zh-cn']['menu.runCode'] = '运行代码';
        const lost = runCiBlock(block, {}, { locales: drifted });
        check('变异真跑：登记的那对不再重复 → 反过来报「豁免已失效」，不许悄悄少一条',
            lost.fails.length === 1 && lost.fails[0].includes('no longer match'), JSON.stringify(lost.fails));

        const noZh = runCiBlock(block, {}, { locales: { en: drifted['en'] } });
        check('locales 里没有 zh-cn → 直接报红（不许退回 localeCodes[0]，那一份是 en）',
            noZh.fails.length === 1 && noZh.fails[0].includes('zh-cn'), JSON.stringify(noZh.fails));

        // 范围的另一半也要可证伪：en 里造一对同句，I10 一条都不该报 ——
        // 源语言不同概念时译文撞车只是翻译粗略（settings.language/languageLabel 就是实例）。
        const enOnlyDup = loadLocales();
        enOnlyDup.en['menu.dupA'] = 'Run';
        enOnlyDup.en['menu.dupB'] = 'Run';
        const enDup = runCiBlock(block, {}, { locales: enOnlyDup });
        check('en 侧同句不报（判据只看源语言，误报为 0 是靠这个范围换来的）',
            enDup.fails.length === 0, JSON.stringify(enDup.fails));
    }
}

// ---------------------------------------------------------------------------
// 4. 本批合并的落点：退役的孪生键不许回来
// ---------------------------------------------------------------------------
{
    const locales = loadLocales();
    const RETIRED = [
        'compileOutput.analysisEmpty',
        'menu.delete_spj', 'menu.delete_grader',
        'settings.resetClangFormat', 'settings.resetKeybinding',
        'backup.saveFailSimple', 'backup.syncSettingsBtn',
        'compare.compileError', 'compare.genRunError', 'compare.errorOverLimit',
        'debug.array', 'debug.container',
        'templates.snippetDialogTitle',
    ];
    for (const key of RETIRED) {
        check(`已退役的重复键不回来：${key}`,
            locales['zh-cn'][key] === undefined && locales.en[key] === undefined,
            `zh=${JSON.stringify(locales['zh-cn'][key])} en=${JSON.stringify(locales.en[key])}`);
    }
    // 合并的方向必须是「复用已有键」。settings.reset 早于本批就存在，两个 reset 按钮并进它 ——
    // 我第一版造了个 settings.resetToDefault，被 I10 当场抓出来（与 settings.reset 同句），
    // 这条就是那次教训的落点：reset 家族只许是这五个键，各句都不同。
    const resetKeys = Object.keys(locales['zh-cn']).filter((k) => k.startsWith('settings.reset')).sort();
    check('settings.reset* 家族就是已知的五个键（再造一个同义键即红）',
        resetKeys.join() === ['settings.reset', 'settings.resetFail', 'settings.resetKeybindings',
            'settings.resetSuccess', 'settings.resetSyntaxColors'].join(),
        JSON.stringify(resetKeys));
    // 这五个键的 zh 值必须两两不同 —— 家族里冒出同句就是又一次 L10。
    const resetValues = resetKeys.map((k) => String(locales['zh-cn'][k]).trim());
    check('settings.reset* 五键的 zh 文案互不相同', new Set(resetValues).size === resetValues.length,
        JSON.stringify(resetValues));
}

// ---------------------------------------------------------------------------
// 5. [I11] 的判据：同一句中文在英文里长得不一样
// ---------------------------------------------------------------------------
{
    const zh = { 'a.x': '编译失败', 'b.y': '编译失败' };
    const caseOnly = translationDriftGroups(zh, { 'a.x': 'Compilation failed', 'b.y': 'Compilation Failed' });
    check('只差大小写 → 不算分叉（Title Case 与句首大写是表面约定）',
        caseOnly.length === 0, JSON.stringify(caseOnly));
    const lexical = translationDriftGroups(zh, { 'a.x': 'Compilation failed', 'b.y': 'Compile error' });
    check('用词不同 → 报一组，并带上双方译文',
        lexical.length === 1 && lexical[0].translations.join() === 'Compilation failed,Compile error',
        JSON.stringify(lexical));
    check('zh 不同句、en 撞车 → 不报（那是翻译粗略，不是同一句话）',
        translationDriftGroups({ 'a.x': '始终', 'b.y': '始终使用 Tab' }, { 'a.x': 'Always', 'b.y': 'Always' }).length === 0);
    check('复数形态本来就该两支不同句 → 整支跳过，不与 [I2] 抢口径',
        translationDriftGroups({ 'a.x_other': '有 {count} 个' },
            { 'a.x_one': '{count} item', 'a.x_other': '{count} items' }).length === 0);
    check('en 缺键不在这里重复报',
        translationDriftGroups(zh, { 'a.x': 'Compilation failed' }).length === 0);
    check('只有一支键的句子不参与',
        translationDriftGroups({ 'a.x': '独立的一句' }, { 'a.x': 'Alone' }).length === 0);
}

// ---------------------------------------------------------------------------
// 6. [I11] 的真包
// ---------------------------------------------------------------------------
{
    const locales = loadLocales();
    const drift = translationDriftGroups(locales['zh-cn'], locales.en);
    const { violations, stale } = partitionGroups(drift, DRIFT_EXEMPTIONS);
    check('真包没有未登记的译文分叉', violations.length === 0, JSON.stringify(violations));
    check('分叉豁免每条都仍然成立（哪天并了句就该划掉）', stale.length === 0, JSON.stringify(stale));
    check('判据是真跑出来的（真包里有 N 组且 N==豁免条数，不许 0==0 假绿）',
        drift.length > 0 && drift.length === DRIFT_EXEMPTIONS.length,
        JSON.stringify({ drift: drift.length, exemptions: DRIFT_EXEMPTIONS.length }));

    // 豁免的实质核对，不只是「表里有这条」：那几支 feature* 之所以可以和菜单标签不同句，
    // 是因为它们被插进 message.cloudFileLocalOnly 的 {feature} 槽 —— 形态由那个句子决定。
    // 哪天帧没了（键不再被插句），豁免理由当场不成立，必须并句而不是继续挂着。
    const zhFrame = String(locales['zh-cn']['message.cloudFileLocalOnly'] || '');
    const enFrame = String(locales.en['message.cloudFileLocalOnly'] || '');
    check('豁免所依赖的 {feature} 插值槽仍在两份包里',
        zhFrame.includes('{feature}') && enFrame.includes('{feature}'),
        JSON.stringify({ zh: zhFrame, en: enFrame }));
    // 顺带锁死本批修掉的语法错配：{feature} 不再被放在动词后面
    check('{feature} 不落在「再使用 …」/「before using …」那种动词槽里',
        !/再使用\s*\{feature\}/.test(zhFrame) && !/before using \{feature\}/i.test(enFrame),
        JSON.stringify({ zh: zhFrame, en: enFrame }));
    const mainRendererSrc = fs.readFileSync(path.join(root, 'src/renderer/js/main.js'), 'utf8');
    for (const key of ['message.featureRun', 'message.featureCompile', 'message.featureDebug', 'message.featureCompileAndRun']) {
        check(`豁免涉及的插值键仍被引用：${key}`, mainRendererSrc.includes(key));
    }
}

// ---------------------------------------------------------------------------
// 7. [I11] 整块真跑
// ---------------------------------------------------------------------------
{
    const ciSrc = fs.readFileSync(path.join(root, 'scripts/ci-check.js'), 'utf8');
    const block = blockByIndent(ciSrc, /\[I11\] One source sentence, one translation/);
    check('I11 整块抽得出来，且用的就是 ci-check 里那份 require',
        block.startsWith('{') && block.includes("require('./i18n-duplicate')"),
        JSON.stringify(block.slice(0, 60)));
    if (block.startsWith('{')) {
        const real = runCiBlock(block, {});
        check('真包真跑：一条不报，并给出一条 ok 汇总',
            real.fails.length === 0 && real.oks.length === 1, JSON.stringify(real));

        // 变异对象是**数据驱动**找出来的：真包里找一组「zh 同句且 en 也一致」的键，
        // 把其中一支的译文改得更长。不写死键名 —— 键会换，而这个类永远存在（83 组同句键）。
        const locales = loadLocales();
        const zh = locales['zh-cn'];
        const en = locales.en;
        const byValue = new Map();
        for (const [key, value] of Object.entries(zh)) {
            if (!/_(one|other|zero|two|few|many)$/.test(key)) {
                const text = String(value || '').trim();
                if (text) byValue.set(text, (byValue.get(text) || []).concat(key));
            }
        }
        const twin = [...byValue.entries()].find(([, ks]) => ks.length >= 2
            && ks.every((k) => en[k])
            && new Set(ks.map((k) => String(en[k]).toLowerCase())).size === 1);
        check('真包里找得到一组「zh 同句且 en 也一致」的键做变异对象', !!twin, JSON.stringify(twin));
        if (twin) {
            const mutated = loadLocales();
            const victim = twin[1][0];
            mutated.en[victim] = mutated.en[victim] + ' (drifted)';
            const driftRun = runCiBlock(block, {}, { locales: mutated });
            check('变异真跑：把其中一支译文改得不同 → 报红且点出被改的键',
                driftRun.fails.length === 1 && driftRun.fails[0].includes(victim),
                JSON.stringify(driftRun.fails));
        }

        const reconciled = loadLocales();
        reconciled.en['message.featureRun'] = 'Run';
        const lostRun = runCiBlock(block, {}, { locales: reconciled });
        check('变异真跑：把豁免那组的译文并成一致 → 反过来报「豁免已失效」',
            lostRun.fails.length === 1 && lostRun.fails[0].includes('no longer match'),
            JSON.stringify(lostRun.fails));

        const noEn = runCiBlock(block, {}, { locales: { 'zh-cn': loadLocales()['zh-cn'] } });
        check('缺 en 时直接报红（I11 要两份包：zh 定同句，en 看分叉）',
            noEn.fails.length === 1 && noEn.fails[0].includes('I11 跑不了'), JSON.stringify(noEn.fails));
    }
}

console.log(`i18n duplicate-value tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
