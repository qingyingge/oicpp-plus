'use strict';

/**
 * 路径身份 / 边界判定 / 可移植性 的表驱动回归测试。
 *
 * 用例数据全部在 tests/fixtures/path-cases.js，这里只负责搭沙箱、按平台筛选用例、
 * 执行断言。用例本身按系统分了三类：
 *
 *   platforms: ['win32'] / ['posix']  该用例只在对应系统上有意义（如 UNC、8.3 短名）
 *   expect: { win32, posix }          结论由卷的大小写语义决定
 *   needs: 'symlink'                 沙箱建不出软链时跳过（win32 无开发者模式）
 *
 * 跳过一律打 [SKIP] 而不是判 FAIL：前提不成立不是回归。但必须留痕，
 * 否则「全是 SKIP」会被误读成全绿。
 *
 * 用法：node tests/path-identity.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { canon, samePath, isInside, toPosixRel } = require('../src/utils/path-identity');
const { CASES } = require('./fixtures/path-cases');

const ROOT = path.resolve(__dirname, '..');
process.chdir(ROOT);

const IS_WIN = process.platform === 'win32';
const IS_DARWIN = process.platform === 'darwin';

let failures = 0;
let passes = 0;
let skips = 0;

const check = (name, cond, extra = '') => {
    if (cond) {
        passes++;
        console.log(`[PASS] ${name}${extra ? ' | ' + extra : ''}`);
    } else {
        failures++;
        console.log(`[FAIL] ${name}${extra ? ' | ' + extra : ''}`);
    }
};
const skip = (name, why) => {
    skips++;
    console.log(`[SKIP] ${name} | ${why}`);
};

// ---- 沙箱 -----------------------------------------------------------------
// <sandbox>/root/a/b/c.txt   边界根（被测root）
// <sandbox>/root/real/       软链的内部目标
// <sandbox>/root/Case/       仅大小写不同的真实目录（供 posix 用例）
// <sandbox>/rootEvil|root2|root.bak|root backup|root_old/   同前缀兄弟目录
// <sandbox>/outside/         软链逃逸目标
// <sandbox>/root-link         -> root（root 自身是软链的形态）
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-path-'));
const ctx = {
    sandbox,
    root: path.join(sandbox, 'root'),
    outside: path.join(sandbox, 'outside'),
    rootLink: path.join(sandbox, 'root-link'),
    hasShortNames: IS_WIN && fs.existsSync('C:\\PROGRA~1'),
    tmpIsSymlink: IS_DARWIN && isSymlink('/tmp'),
    varIsSymlink: IS_DARWIN && isSymlink('/var'),
    canSymlink: false
};

function isSymlink(p) {
    try { return fs.lstatSync(p).isSymbolicLink(); } catch (_) { return false; }
}

try {
    for (const dir of [
        ctx.root,
        path.join(ctx.root, 'a', 'b'),
        path.join(ctx.root, 'Case'),
        path.join(ctx.root, 'real'),
        ctx.outside,
        path.join(sandbox, 'rootEvil'),
        path.join(sandbox, 'root2'),
        path.join(sandbox, 'root.bak'),
        path.join(sandbox, 'root backup'),
        path.join(sandbox, 'root_old')
    ]) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(path.join(ctx.root, 'a', 'b', 'c.txt'), 'x', 'utf8');

    // 软链：win32 上目录软链需要开发者模式/管理员权限，建不出来就整体跳过
    // 软链一族，不要让「权限不足」变成 CI 红。
    try {
        fs.symlinkSync(path.join(ctx.root, 'a', 'b'), path.join(ctx.root, 'link'), 'dir');
        ctx.canSymlink = true;
    } catch (_) { ctx.canSymlink = false; }
    if (ctx.canSymlink) {
        // 深一层：root/a/escapeOut 必须真的建成软链，否则 canon 会退化成
        // 「root/a/escapeOut」这个普通不存在的路径，判定成 in（假绿）
        const soft = [
            ['escape', ctx.outside],
            ['escapeOut', ctx.outside],
            [path.join('a', 'escapeOut'), ctx.outside],
            ['dangling', path.join(ctx.root, 'no-such-target')],
            ['loopB', path.join(ctx.root, 'loopA')],
            ['toEvil', path.join(sandbox, 'rootEvil')]
        ];
        for (const [name, target] of soft) {
            try { fs.symlinkSync(target, path.join(ctx.root, name), 'dir'); }
            catch (_) { ctx.canSymlink = false; break; }
        }
        try { fs.symlinkSync(ctx.root, path.join(ctx.root, 'loopA'), 'dir'); }
        catch (_) { ctx.canSymlink = false; }
        try { fs.symlinkSync(ctx.root, ctx.rootLink, 'dir'); }
        catch (_) { ctx.canSymlink = false; }
    }

    // ---- 执行用例 ---------------------------------------------------------
    const groups = new Map();
    for (const c of CASES) {
        const bucket = c.id.split('/')[0];
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket).push(c);
    }

    for (const [bucket, list] of groups) {
        console.log(`\n--- ${bucket} ---`);
        for (const c of list) {
            if (c.platforms && !c.platforms.includes(IS_WIN ? 'win32' : 'posix')) {
                skip(c.id, `仅在 ${c.platforms.join('/')} 有意义（当前 ${process.platform}）`);
                continue;
            }
            if (c.needs === 'symlink' && !ctx.canSymlink) {
                skip(c.id, '本机无法创建软链');
                continue;
            }
            if (c.skipIf && c.skipIf(ctx)) {
                skip(c.id, c.skip || '前提不成立');
                continue;
            }

            const target = c.target(ctx);
            const root = c.root ? c.root(ctx) : ctx.root;
            const expected = typeof c.expect === 'string'
                ? c.expect
                : (IS_WIN ? c.expect.win32 : c.expect.posix);

            let actual;
            let ok;
            let threw = null;
            try {
                if (expected === 'in') { actual = isInside(target, root); ok = actual === true; }
                else if (expected === 'out') { actual = isInside(target, root); ok = actual === false; }
                else if (expected === 'bool') { actual = typeof isInside(target, root); ok = actual === 'boolean'; }
                else if (expected === 'same') { actual = samePath(target, c.other(ctx)); ok = actual === true; }
                else if (expected === 'diff') { actual = !samePath(target, c.other(ctx)); ok = actual === true; }
                else if (expected.startsWith('rel:')) {
                    actual = toPosixRel(target, root);
                    ok = actual === expected.slice(4);
                } else {
                    throw new Error(`未知 expect: ${expected}`);
                }
            } catch (err) {
                threw = err;
            }

            if (threw) {
                check(c.id, false, `${c.desc} -> 抛异常 ${threw.message}`);
            } else {
                const shown = expected.startsWith('rel:')
                    ? `rel=${JSON.stringify(actual)}`
                    : String(actual);
                check(c.id, ok, `${c.desc} -> ${shown}（期望 ${expected}）`);
            }
        }
    }

    // ---- 结构性断言：实现层面的不变量 ------------------------------------
    console.log('\n--- invariants ---');
    check('canon 返回绝对路径', path.isAbsolute(canon(ctx.root)), canon(ctx.root));
    check('canon 幂等', canon(canon(ctx.root)) === canon(ctx.root));
    check('canon 解析软链', canon(path.join(ctx.root, 'link')) === path.join(ctx.root, 'a', 'b'),
        canon(path.join(ctx.root, 'link')));
    check('canon 对不存在的路径仍返回绝对路径',
        path.isAbsolute(canon(path.join(ctx.root, 'nope', 'x'))));
    check('canon 拒绝空串', (() => {
        try { canon(''); return false; } catch (_) { return true; }
    })());
    check('isInside(root, root) 为真（自反）', isInside(ctx.root, ctx.root) === true);
    check('isInside 对不存在的 root 不抛且返回布尔',
        typeof isInside(path.join(ctx.root, 'x'), path.join(sandbox, 'no-such-root')) === 'boolean');
    check('toPosixRel 结果不含反斜杠', !toPosixRel(path.join(ctx.root, 'a', 'b'), ctx.root).includes('\\'));
    check('toPosixRel 对 root 外返回空串', toPosixRel(path.join(sandbox, 'rootEvil'), ctx.root) === '');

    console.log('');
    console.log(`通过 ${passes} / 跳过 ${skips}${skips ? `（${process.platform} 上有 ${skips} 条不适用）` : ''}`);
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
    process.exitCode = failures ? 1 : 0;
} finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { }
}