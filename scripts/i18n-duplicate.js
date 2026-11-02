'use strict';

// 「同一个父对象里两个键写同一句话」的检测，唯一实现。
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
// **必须传源语言（zh-cn）的包进来**，别传 en：源语言里两个值不同就说明本来就是两个概念，
// 译文书面撞车只是翻译粗略。反例（在 en 上跑会误报，在 zh-cn 上跑一条都不报）：
//   settings.spaceBeforeParensAlways「始终」  vs settings.useTabAlways「始终使用 Tab」
//   —— 两个下拉框各自的选项，en 都塌成 "Always"，合并才是错。调用点的注释记着这件事。

const { splitPlural } = require('./i18n-plural');

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
// 就报错返回。这样豁免不会随着代码演化变成一张无人核对的旧名单 —— 键被改名、被删、
// 或者两句文案哪天不再相同了，登记条目立刻失效，逼着下一个人把它划掉而不是留着当噪声。
//
// 返回 { violations, stale }：violations 是未获豁免的重复组；stale 是没匹配上任何
// 重复组的豁免条目。
function partitionDuplicates(duplicates, exemptions) {
    const remaining = exemptions.map((ex) => ({
        keys: [...ex.keys].sort().join('\u0000'),
        reason: ex.reason,
        matched: false,
    }));
    const violations = [];
    for (const dup of duplicates) {
        const target = dup.bases.slice().sort().join('\u0000');
        const hit = remaining.find((ex) => ex.keys === target && !ex.matched);
        if (hit) hit.matched = true;
        else violations.push(dup);
    }
    const stale = remaining.filter((ex) => !ex.matched).map((ex) => ({
        keys: ex.keys.split('\u0000'),
        reason: ex.reason,
    }));
    return { violations, stale };
}

module.exports = { DUPLICATE_EXEMPTIONS, sameParentDuplicates, partitionDuplicates };
