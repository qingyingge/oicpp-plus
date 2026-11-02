'use strict';

// 「同一个父对象里两个键写同一句话」与「同一句话的两种译文」的检测，唯一实现。
// 前者是 CI 项 [I10]（sameParentDuplicates），后者是 [I11]（translationDriftGroups）。
//
// 为什么要有这个文件：I1~I9 除了这一条之外的全都是**逐键自问自答** ——
// 这个键两边都有吗（I2）、这个键能解析吗（I6）、en 侧有没有残留中文（I4）、
// 这个键有没有人引用（I7）。没有一条会问「这两个键是不是同一句话」。
// 而台账 L10 正是死在这里：6e28d60 给「暂无可解析的内容」新建了
// compileOutput.analysisEmpty，可 panel.noParseContent 早就存在、而且才是界面
// 真正取用的那一个。孪生键从未接线 → 它是个孤儿，但当时 I7 的 baseline 是 188，
// 孤儿不报红；于是 16c4bfd 去修那个**没在用的键**，修完界面症状照旧，
// 前后 5 次提交才查清「改的不是上屏的那句」。
//
// I7 现在 baseline 0，「死孪生键」这条路已经被拦住了。本模块管的是另一半：
// **两个都在用**的同句键。它们不会立刻出问题，但会在后续演化里各自漂移 ——
// 本批合并后实测：1477 个逻辑键里 83 组同句挂在不同键上，其中 33 组的 en 已经分叉
// （合并前 settings.resetClangFormat 是 "Reset to Default"、settings.resetKeybinding 是 "Reset"，
// 同一父对象、同一句中文、两种英文，就是现成的例子；那对现已并入 settings.reset）。
// 一旦漂移，「界面这句走的到底是哪个键」就重新变成需要 git 考古的问题 —— 那正是 L10 的死因。
//
// 判定范围刻意收到「同一个父对象内」：跨组的同句是常态且合理（menu.delete 与
// cloud.delete 分别是菜单项与列表按钮，将来也可能各自演化），而同一个对象里
// 两个字段逐字相同，几乎只能是「给已经有的一句话又建了一个键」。
//
// sameParentDuplicates **必须收源语言（zh-cn）的包**，别传 en：源语言里两个值不同就说明
// 本来就是两个概念，译文书面撞车只是翻译粗略。反例（在 en 上跑会误报，在 zh-cn 上跑一条都不报）：
//   settings.spaceBeforeParensAlways「始终」  vs settings.useTabAlways「始终使用 Tab」
//   —— 两个下拉框各自的选项，en 都塌成 "Always"，合并才是错。调用点的注释记着这件事。
//   （translationDriftGroups 反过来正好用这件事：它先要 zh 同句，才去看 en 是否分叉。）

const { splitPlural, indexPack } = require('./i18n-plural');

// 已登记的「同句但确实是两回事」。放这里而不是放 ci-check，理由与 i18n-plural 一样：
// 口径只有一份，CI 与 tests/i18n-duplicate-value.test.js 取的是同一个数组，
// 测试里再抄一份就会和真语言包脱节（本仓已三次踩到「两套口径给出两个数」）。
//
// 每条都必须仍然对应一个真实重复组，否则 partitionDuplicates 会把它列进 stale，
// 调用点据此报红 —— 所以这张表不会随演化烂成没人核对的旧名单。
const DUPLICATE_EXEMPTIONS = [
    // menu.run 是子菜单标题、menu.runCode 是它内部那一条目，两处都显示「运行」。
    // 合并成一键会让标题与条目再也无法分别翻译 —— 那才是错的。正解是给条目换更具体的
    // 措辞（例如「运行代码」），那是产品决定而不是 i18n 决定，所以这里逐条登记而非顺手并键。
    { keys: ['menu.run', 'menu.runCode'], reason: 'submenu 标题与其内条目同词，语义不同' },
];

// [I11] 的豁免：同一句中文在英文里**合法地**长成两个样子。只剩两类，每条都写清为什么。
//   · message.feature* 是被插进句子的，形态由它所在的语法槽决定，不属于自己的措辞选择；
//   · settings.syntaxColorVariable 是一个配色项的名字，debug.variables 是一个面板的标题。
// 注意匹配的是**整组键集**：往「运行」这一组里再加一支新键，这条豁免立刻失配并报红，
// 逼着加键的人当场决定新键该跟哪一句一致。
const DRIFT_EXEMPTIONS = [
    {
        keys: ['menu.run', 'menu.runCode', 'message.featureRun', 'tester.run'],
        reason: 'message.featureRun 被插进 cloudFileLocalOnly 的「Using {feature} requires…」主语位，形态由那句决定；其余三支是命令标签',
    },
    {
        keys: ['menu.compile', 'message.featureCompile'],
        reason: '同上：插值槽要 compiling，菜单标签是 Compile',
    },
    {
        keys: ['menu.compileAndRun', 'keybinding.compileAndRun', 'message.featureCompileAndRun'],
        reason: '同上：插值槽要 compiling and running，菜单与快捷键列表是命令标签',
    },
    {
        keys: ['menu.debug', 'sidebar.debug', 'message.featureDebug'],
        reason: '同上：插值槽要 debugging，菜单与侧栏是命令标签',
    },
    {
        keys: ['debug.variables', 'settings.syntaxColorVariable'],
        reason: '一个是面板标题（复数），一个是单个配色项的名字（单数）',
    },
];

// 扫一份扁平语言包，返回同父对象内的重复文案组。
//
// 复数形态只与**自己的兄弟形态**互不比较：zh 的 x_one 与 x_other 常是同一句话，
// 那是合法形状；但 x_other 与别的键同句仍然要报。
//
// 返回的每一项形如 { parent, value, bases }，bases 是去掉复数后缀后的逻辑键名。
function sameParentDuplicates(flat) {
    const slots = new Map();
    for (const [key, value] of Object.entries(flat || {})) {
        const text = String(value === undefined || value === null ? '' : value).trim();
        if (!text) continue;
        const lastDot = key.lastIndexOf('.');
        const parent = lastDot === -1 ? '' : key.slice(0, lastDot);
        const logic = splitPlural(key).base;
        const slot = `${parent}\u0000${text}`;
        let bucket = slots.get(slot);
        if (!bucket) { bucket = new Set(); slots.set(slot, bucket); }
        bucket.add(logic);
    }
    const out = [];
    for (const [slot, bucket] of slots) {
        if (bucket.size < 2) continue;
        const sep = slot.indexOf('\u0000');
        out.push({
            parent: slot.slice(0, sep),
            value: slot.slice(sep + 1),
            bases: [...bucket].sort(),
        });
    }
    // 顺序必须稳定：CI 报告与测试断言都要可比，Map 的插入序受 JSON 键序影响，
    // 显式排序后两边（ci-check 与 tests）拿到的才是同一个列表。
    out.sort((a, b) => `${a.parent}\u0000${a.bases.join()}`.localeCompare(`${b.parent}\u0000${b.bases.join()}`));
    return out;
}

// 把重复组按豁免表拆成「必须报红的」与「已登记的」。
//
// 豁免表是**逐条消费**的：每条 exemption 必须恰好匹配上一个真实的重复组，否则它自己
// 就进 stale。这样豁免不会随着代码演化变成一张无人核对的旧名单 —— 键被改名、被删、
// 两句文案哪天不再相同了、或者组里多进来一支新键，登记条目立刻失效，
// 逼着下一个人重新核对而不是留着当噪声。
//
// 同一张表既能用于「同父对象重复」（sameParentDuplicates）也能用于「译文分叉」
// （translationDriftGroups），因为两者的判据形状一样：一组键 + 一个整组键集匹配。
//
// 返回 { violations, stale }。
function partitionGroups(items, exemptions) {
    const remaining = (exemptions || []).map((ex) => ({
        keys: [...ex.keys].sort().join('\u0000'),
        reason: ex.reason,
        matched: false,
    }));
    const violations = [];
    for (const item of items) {
        const target = item.bases.slice().sort().join('\u0000');
        const hit = remaining.find((ex) => ex.keys === target && !ex.matched);
        if (hit) hit.matched = true;
        else violations.push(item);
    }
    const stale = remaining.filter((ex) => !ex.matched).map((ex) => ({
        keys: ex.keys.split('\u0000'),
        reason: ex.reason,
    }));
    return { violations, stale };
}

// 第二件事：同一句话的**译文**不许各自演化。
//
// 这是 L10 的另一半。上面那条管「一个对象里两个键同一句话」；但真正让界面变得不可推理的是
// 同句话在两处**长得不一样** —— 全仓 83 组同句键里，改判前 33 组的 en 已经分叉，
// 其中「编译失败」五支键里同时存在 "Compilation failed" 与 "Compilation Failed"，
// 「标准错误:」有 "Stderr:" 与 "Standard error:" 两种。到那时「这句上屏走哪个键」
// 就得靠 git 考古，而考古正是 L10 花了 5 次提交的地方。
//
// 口径：**忽略大小写**比较。大小写在本仓是按表面约定走的 —— menu./keybinding./sidebar.
// 是控件标签走 Title Case，main.*Title 是对话框标题走句首大写，同一个「另存为」两边
// 分别写 "Save As" 与 "Save as" 是对的，不该被当成漂移。要比的是**用词**。
//
// 只比**没有被复数化**的逻辑键：复数形态本来就一支一句（en 的 x_one "1 item" 与
// x_other "{count} items" 必须不同），形态级的一致性由 I2 与 pluralTokenIssues 负责。
//
// 返回 [{ value, bases, translations }]，bases 是 zh 侧同句的逻辑键，
// translations 是它们各自在 en 里的值。
function translationDriftGroups(zhFlat, enFlat) {
    const zhIndex = indexPack(zhFlat || {});
    const enIndex = indexPack(enFlat || {});
    const text = (index, base) => {
        if (index.values.has(base)) return String(index.values.get(base) ?? '').trim();
        for (const suffix of ['_other', '_one']) {
            if (index.values.has(base + suffix)) return String(index.values.get(base + suffix) ?? '').trim();
        }
        return '';
    };
    const groups = new Map();
    for (const base of zhIndex.logical.keys()) {
        // 复数化过的键整支跳过：形态之间的差异是设计，不是漂移
        if ([...zhIndex.logical.get(base)].some((f) => f !== '')) continue;
        if (!enIndex.logical.has(base)) continue;      // 缺键由 I2 报，这里不重复报
        const zhText = text(zhIndex, base);
        if (!zhText) continue;
        if (!groups.has(zhText)) groups.set(zhText, []);
        groups.get(zhText).push(base);
    }
    const out = [];
    for (const [value, keys] of groups) {
        if (keys.length < 2) continue;
        const translations = keys.map((k) => text(enIndex, k));
        // 空译文（缺形态）不参与分叉判定 —— 那是 I2 的缺键口径
        const nonEmpty = translations.filter((v) => v !== '');
        if (nonEmpty.length < 2) continue;
        if (new Set(nonEmpty.map((v) => v.toLowerCase())).size < 2) continue;
        out.push({ value, bases: keys.slice().sort(), translations });
    }
    out.sort((a, b) => a.bases.join().localeCompare(b.bases.join()));
    return out;
}


module.exports = {
    DUPLICATE_EXEMPTIONS,
    DRIFT_EXEMPTIONS,
    sameParentDuplicates,
    translationDriftGroups,
    partitionGroups,
};
