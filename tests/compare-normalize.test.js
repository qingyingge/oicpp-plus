'use strict';

/**
 * 判等快路的行为守卫：outputsEqual 里新加的那一趟字节级规范化，结论必须与
 * 「normalizeOutput(a) === normalizeOutput(b)」这唯一一套终裁**逐对相同**。
 *
 * 为什么值得单独一份测试：判等是对拍里最不能错的单一判据 —— 它写错的方向是
 * 「把 AC 判成 WA」或「把 WA 判成 AC」，两者都只体现在结论上，没有任何异常或日志。
 * 而快路的动机恰好是把慢路省掉，也就是说**一旦它自己错，被省掉的那条正确答案就再也不
 * 参与比对了**。security-regression 那三条是从真实循环里顺带覆盖的（各 3 组小数据），
 * 这里做的是判等原语本身的穷举。
 *
 * 参照物用的是生产源码里的 normalizeOutput 本体，不是测试里重抄的一份实现：重抄就会
 * 与真实现漂移，而这条守卫存在的理由正是「两个实现是否一致」。
 *
 * 三个已知的等价性支点，都有对应断言：
 *  1. 可剥的行尾空白只有空格/Tab，\r 只有在 \n 前面才丢（孤立 \r 是内容）；
 *  2. 结尾连续换行整体剥掉，但**中间**的空行必须留着；
 *  3. 非 ASCII 字节是字节视角与字符串视角唯一可能分叉的地方（非法 UTF-8 会被解码并成
 *     U+FFFD），所以那种情况下快路必须回 null、由终裁定论 —— 与 fastspawn.cc 的
 *     normalizeInPlace 用 anyHigh 拒绝下结论同一手法。
 *
 * 用法：node tests/compare-normalize.test.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { funcDecl } = require('./fixtures/source-extract');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
let ran = 0;
const check = (name, cond, extra = '') => {
    ran++;
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const workerSrc = fs.readFileSync(path.join(ROOT, 'src', 'main-process', 'compare-worker.js'), 'utf8');
const normSrc = funcDecl(workerSrc, 'normalizeOutput');
const equalSrc = funcDecl(workerSrc, 'outputsEqual');
const fastSrc = funcDecl(workerSrc, 'equalNormalizedBytes');
check('三个判等函数都从 emit 产物里抽到了',
    normSrc.length > 0 && equalSrc.length > 0 && fastSrc.length > 0,
    JSON.stringify([normSrc.length, equalSrc.length, fastSrc.length]));
if (!normSrc || !equalSrc || !fastSrc) {
    console.log('\n对比结果: ' + ran + ' 条, ' + failures + ' 个失败');
    process.exit(1);
}

const ctx = vm.createContext({ Buffer, String, Number, Math, Array, JSON, TypeError });
vm.runInContext(`${normSrc}\n${fastSrc}\n${equalSrc};`, ctx);
const run = (expr) => vm.runInContext(expr, ctx);
const B = (s) => `Buffer.from(${JSON.stringify(s)}, 'utf8')`;

// ---------------------------------------------------------------- 语料
// 每一条都处在某个等价类的边界上；顺序无所谓，交叉相乘才是重点。
const corpus = [
    '', '\n', '\n\n\n', ' ', '  ', ' \t ', '\t',
    'a', 'a\n', 'a\n\n', 'a  ', 'a\t', 'a \t', 'a  \n', 'a\t \n',
    'a\nb', 'a\nb\n', 'a\n  \nb\n', 'a\n\nb', 'a \n b',
    'a\r\n', 'a\r', '\r\n', '\r', 'a\r\r\n', 'a\r\r', 'a\r\nb\r\n',
    '1 2 3\n', '1 2 3  \n', '1  2  3\n', ' 1 2 3\n',
    '12345678901234567890\n',
    '中文输出\n', '中文  \n', '中文\t\n', '中文\n第二行\n', '日 text  \n',
    'a\n   \n\t\n  \n', 'x\n \n\n',
];
const fast = (x, y) => run(`equalNormalizedBytes(${B(x)}, ${B(y)})`);
const slow = (x, y) => run(`normalizeOutput(${B(x)}) === normalizeOutput(${B(y)})`);
const both = (x, y) => run(`outputsEqual(${B(x)}, ${B(y)})`);

// ------------------------------------------------- 1. 快路不得与终裁分叉
let asciiPairs = 0, asciiDiff = 0, highPairs = 0, highUndecided = 0, highOverruled = 0;
const bad = [];
for (let i = 0; i < corpus.length; i++) {
    for (let j = 0; j < corpus.length; j++) {
        const x = corpus[i], y = corpus[j];
        const f = fast(x, y), s = slow(x, y), o = both(x, y);
        const isAscii = !/[^\x00-\x7f]/.test(x) && !/[^\x00-\x7f]/.test(y);
        if (isAscii) {
            asciiPairs++;
            // 纯 ASCII 时两个视角逐字等价，快路必须自己定论（回 null 就是白跑一趟慢路）
            if (f === null) { asciiDiff++; bad.push(['null', x, y]); }
            else if (f !== s) { asciiDiff++; bad.push(['diff', x, y, f, s]); }
            if (o !== s) { asciiDiff++; bad.push(['out', x, y, o, s]); }
        } else {
            highPairs++;
            if (f === null) {
                highUndecided++;
                if (o !== s) bad.push(['override', x, y, o, s]);
            } else if (f !== s) {
                // 快路定了论就必须和终裁一致
                highOverruled++; bad.push(['high-diff', x, y, f, s]);
            }
            if (o !== s) { highOverruled++; bad.push(['high-out', x, y, o, s]); }
        }
    }
}
check('纯 ASCII 交叉相乘 ' + asciiPairs + ' 对：快路结论与终裁逐对相同，且不回 null',
    asciiDiff === 0, bad.slice(0, 4).map(String).join(' ; '));
check('含非 ASCII 的 ' + highPairs + ' 对：结论与终裁逐对相同（定得了论就一致，定不了就回落）',
    highOverruled === 0, bad.filter(b => b[0].startsWith('high')).slice(0, 4).map(String).join(' ; '));
check('非 ASCII 且规范后不同时确实走了回落（快路不许对高位字节硬下「不等」）',
    highUndecided > 0, '回落后定论 ' + highUndecided + ' 对');

// --------------------------------------- 1b. 非法 UTF-8：高位字节守卫的唯一真实触发面
// 这一组是被变异测试逼出来的：拿字符串造语料**永远造不出非法 UTF-8**（Buffer.from(…, 'utf8')
// 先把坏序列换成 U+FFFD），于是 `sawHighByte ? null : false` 那两行怎么改坏都不会红 ——
// M4「有高位字节也硬下不等」当场存活。只有直接用字节数组喂，才构造得出
// 「两个不同的坏字节 → 解码成同一个 U+FFFD → 字符串视角相等、字节视角不等」这一对。
// 那正是快路唯一会判错的方向，也是它必须回 null 的全部理由。
const byteCorpus = [
    [0xff, 0x41], [0xfe, 0x41], [0xff], [0xfe], [0xff, 0x20], [0xff, 0x0a],
    [0x41, 0xff, 0x0a], [0x41, 0xfe], [0x41, 0xff, 0x20, 0x0a], [0x41, 0xff],
    [0xc3], [0xc3, 0x41], [0xe4, 0xb8], [0xe4, 0xb8, 0xad], [0x0a, 0xff], [0xff, 0x0a],
];
const BB = (arr) => `Buffer.from(${JSON.stringify(arr)})`;
let bytePairs = 0, byteDiff = 0, byteUndecided = 0, byteProof = 0;
const byteBad = [];
for (const x of byteCorpus) {
    for (const y of byteCorpus) {
        bytePairs++;
        const f = run(`equalNormalizedBytes(${BB(x)}, ${BB(y)})`);
        const s = run(`normalizeOutput(${BB(x)}) === normalizeOutput(${BB(y)})`);
        const o = run(`outputsEqual(${BB(x)}, ${BB(y)})`);
        if (o !== s) { byteDiff++; byteBad.push([x.join(' '), y.join(' '), f, s].join(' | ')); }
        if (f === null) byteUndecided++;
        // 至少要有一对「字节不等但解码后相等」，否则这组只是在测回落存在，没测到守卫必要
        if (f === null && s === true) byteProof++;
    }
}
check('非法 UTF-8 交叉相乘 ' + bytePairs + ' 对：最终结论与终裁逐对相同',
    byteDiff === 0, byteBad.slice(0, 3).join(' ;; '));
check('高位字节守卫确实在起作用：存在「字节判不出、解码后其实相等」的对被回落接住',
    byteProof > 0 && byteUndecided > 0,
    '不定论 ' + byteUndecided + ' 对，其中终裁翻回相等 ' + byteProof + ' 对');
check('两串不同的坏字节确实解码成同一个字符（守卫必要性的正面证据）',
    run(`${BB([0xff, 0x41])}.toString('utf8')`) === run(`${BB([0xfe, 0x41])}.toString('utf8')`));

// ------------------------------------------- 2. 等价类必须判等（AC 不许变 WA）
const equivalent = [
    ['a', 'a\n'], ['a', 'a  '], ['a', 'a\t'], ['a', 'a \t\n\n'],
    ['a\nb', 'a  \nb'], ['a\nb', 'a\r\nb'], ['a\nb', 'a\nb\n\n\n'],
    ['中文', '中文  \n'], ['a\n\nb', 'a  \n\nb  \n'],
    // 只含空格的行规范化后是**空行**。处在结尾时会被 \n+$ 连着剥掉，所以这几对等价；
    // 处在中间时那个空行必须留着（见 different 里那条反向用例）。
    ['', ' '], [' ', '\n'], ['a\nb', 'a\nb  \n \n'],
    ['1 2 3', '1 2 3  \n\n'],
];
equivalent.forEach(([x, y]) => {
    check(`等价类判等：${JSON.stringify(x)} vs ${JSON.stringify(y)}`,
        both(x, y) === true && slow(x, y) === true);
    // 双向：短路那一趟是无序的，但字节版里左右谁先写会影响 scratch 尺寸，也要对上
    check(`  反向同样判等：${JSON.stringify(y)} vs ${JSON.stringify(x)}`, both(y, x) === true);
});

// ------------------------------------------- 3. 真差异必须判不等（别把判据松开）
const different = [
    ['a', 'b'], ['a', 'ab'], ['a\nb', 'a\nbc'], ['a', 'a\nb'], ['a\r', 'a'],
    ['a\r\n', 'a\r\r\n'], ['a\n\nb', 'a\nb'], ['中文', '中'],
    // 中间位置的空白行是一个**保留的空行**，所以它和少这一行不等价。
    ['a\nb', 'a\n \nb'], ['a\n\nb', 'a\nb\n'],
];
different.forEach(([x, y]) => {
    check(`真差异判不等：${JSON.stringify(x)} vs ${JSON.stringify(y)}`,
        both(x, y) === false && slow(x, y) === false);
});
check('中间空行不被当成结尾空行剥掉（\n+$ 只作用在结尾）',
    run(`normalizeOutput(${B('a\n\nb')})`) === 'a\n\nb');
check('孤立 \\r 是内容而不是行尾空白（慢版只替换 \\r\\n、只剥空格与 Tab）',
    run(`normalizeOutput(${B('a\r')})`) === 'a\r' && both('a\r', 'a') === false);

// ------------------------------------------- 4. 快路的适用边界
check('非 Buffer 入参不参与快路，仍由终裁定论',
    run(`outputsEqual(${B('a  ')}, 'a')`) === true
    && run(`outputsEqual('a', ${B('a\n')})`) === true);
check('null / undefined 不抛且与终裁一致',
    run('[outputsEqual(null, Buffer.from("a"))].join()') === String(slow('', 'a')));
check('空 Buffer 对空 Buffer 判等（allocUnsafe 那一趟不许读到未初始化内存）',
    both('', '') === true && fast('', '') === true);
// 这是字节版最容易写的错：把「未初始化尾部」读进结论。两侧长度差 1 时最容易暴露。
check('长度不同且一侧是空内容时结论仍与终裁一致',
    both('', '  ') === slow('', '  ') && both('  ', '') === slow('  ', ''));

// ------------------------------------------- 5. 大输入的结论稳定性（不是性能断言）
// MB 级才走得到的分支：n1 !== n2 的早退、以及 compare 的区间边界。
const bigBase = '123456789\n'.repeat(20000);
const bigWs = '123456789  \n'.repeat(20000);
check('20 万行等价输入：快路判等且与终裁一致',
    fast(bigBase, bigWs) === true && both(bigBase, bigWs) === true);
const bigTail = bigBase + '\n\n\n\n';
check('20 万行 + 结尾空行：判等', both(bigBase, bigTail) === true);
check('20 万行 + 多一行真内容：判不等',
    both(bigBase, bigBase + '9\n') === false && fast(bigBase, bigBase + '9\n') === false);

console.log(`\n覆盖：字符串语料 ${corpus.length}×${corpus.length} = ${corpus.length * corpus.length} 对`
    + `（ASCII ${asciiPairs} / 非 ASCII ${highPairs}）+ 字节语料 ${byteCorpus.length}×${byteCorpus.length}`
    + ` = ${bytePairs} 对`);
console.log(`对比结果: ${ran} 条, ${failures} 个失败`);
process.exit(failures ? 1 : 0);
