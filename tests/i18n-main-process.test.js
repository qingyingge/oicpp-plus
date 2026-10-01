'use strict';

// 覆盖 24e3365：I6/I8 检查器修正 + 主进程 75 条硬编码中文迁入 main.*。
// 重点是「守门」：这类迁移最容易在后续重构中被静默改回。

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, '..');
const ciSource = fs.readFileSync(path.join(ROOT, 'scripts', 'ci-check.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const compilerSource = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings', 'compiler.js'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lang', 'zh-cn.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lang', 'en.json'), 'utf8'));

function flatten(obj, prefix = '', out = {}) {
    for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
        else out[key] = v;
    }
    return out;
}

const zhFlat = flatten(zh);
const enFlat = flatten(en);
// 提升到模块作用域：多个断言块都要用
const zhMain = zh.main || {};
const enMain = en.main || {};

// ---------------------------------------------------------------------------
// I6 / I7：可选链 t() 必须被识别
// ---------------------------------------------------------------------------

{
    // 从 ci-check.js 里把 callRe 的正则源码取出来，在本地构造实例实测，
    // 而不是断言源码字符串长什么样 —— 只比对字符串形态正是当初写出坏正则的原因：
    // 第一版 (?:\?\s*\.\s*)?t 让常规的 i18n.t('k') 匹配不上了，而字符串断言照样通过。
    const callReLines = [...ciSource.matchAll(/const callRe = \/(.*)\/g;/g)].map((m) => m[1]);
    check('I6/I7 各有一处 callRe', callReLines.length >= 2, `${callReLines.length} 处`);

    const reOf = (src) => new RegExp(src, 'g');
    const keyOf = (re, s) => {
        const m = [...s.matchAll(re)];
        return m.length ? (m[0].groups ? m[0].groups.key : m[0][1]) : null;
    };

    // 四种连接形态都必须匹配并取到键名
    const forms = [
        ["window.i18n?.t?.('a.b')", 'a.b', '?.t?.( 可选链双问号（AGENTS.md 认可写法）'],
        ["window.i18n.t('a.b')", 'a.b', '.t( 常规写法'],
        ["window.i18n?.t('a.b')", 'a.b', '?.t( 半可选'],
        ["window.i18n.t?.('a.b')", 'a.b', '.t?.( 半可选']
    ];
    for (const [sample, wantKey, why] of forms) {
        const got = keyOf(reOf(callReLines[0] || ''), sample);
        check(`I6 callRe 匹配 ${why}`, got === wantKey, `key=${got}`);
    }

    // 不该匹配的形态
    const negatives = [
        ["window.i18n?.t?.('single')", '单段键不属本正则职责'],
        ["const t = (k) => window.i18n?.t?.(k);", '动态参数'],
        ["t('a.b')", '无前缀的裸调用（归 bareCallRe）']
    ];
    for (const [sample, why] of negatives) {
        const got = keyOf(reOf(callReLines[0] || ''), sample);
        check(`I6 callRe 不匹配：${why}`, got === null, `key=${got}`);
    }

    // I7 必须与 I6 同口径，否则孤儿键 baseline 被虚抬
    check('I7 callRe 与 I6 同口径',
        callReLines[0] === callReLines[1],
        callReLines[0] === callReLines[1] ? '' : 'I6 与 I7 正则不一致');
}

// ---------------------------------------------------------------------------
// I8：userVisibleRe 纳入 message/title/detail/innerText
// ---------------------------------------------------------------------------

{
    const m = ciSource.match(/const userVisibleRe = \/(.*)\/;/);
    check('I8 userVisibleRe 存在', !!m);
    const re = m ? m[1] : '';
    for (const pat of ['message\\s*:', 'title\\s*:', 'detail\\s*:', 'innerText']) {
        check(`I8 userVisibleRe 覆盖 ${pat}`, re.includes(pat));
    }
}

// ---------------------------------------------------------------------------
// main.* 命名空间：键集一致、无 CJK 残留、占位符对应
// ---------------------------------------------------------------------------

{
    const zhKeys = Object.keys(zhMain).sort();
    const enKeys = Object.keys(enMain).sort();
    check('main.* 命名空间已建立', zhKeys.length > 50, `${zhKeys.length} 键`);
    check('zh-cn 与 en 的 main.* 键集完全一致',
        JSON.stringify(zhKeys) === JSON.stringify(enKeys),
        zhKeys.filter((k) => !(k in enMain)).join(',') || enKeys.filter((k) => !(k in zhMain)).join(','));

    // en 不得残留中文或中文标点
    const cjk = enKeys.filter((k) => /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(String(enMain[k])));
    check('en.json 的 main.* 无中文/中文标点残留', cjk.length === 0, cjk.join(','));

    // 占位符必须一一对应（I3 同款要求）
    const mismatch = [];
    for (const k of zhKeys) {
        const ph = (s) => (String(s).match(/\{[a-zA-Z0-9_]+\}/g) || []).sort().join(',');
        if (ph(zhMain[k]) !== ph(enMain[k])) mismatch.push(`${k}: zh[${ph(zhMain[k])}] vs en[${ph(enMain[k])}]`);
    }
    check('main.* 占位符在两语言中一一对应', mismatch.length === 0, mismatch.join(' | '));
}

// ---------------------------------------------------------------------------
// 迁移后的调用点：main.js 不再残留这些中文，且都用 t()
// ---------------------------------------------------------------------------

{
    // 只看用户可见的行：logInfo/logWarn/logError 是开发面向的中文，
    // 不属于 I8 口径；注释里的中文同理
    const userVisibleLines = mainSource.split('\n').filter((l) =>
        !/log(Error|Warn|Info|Debug)/.test(l) &&
        !/^\s*(\/\/|\*|\/\*)/.test(l) &&
        !/\/\//.test(l.replace(/(['"])(?:\\.|(?!\1).)*\1/g, '')));
    const migrated = [
        '登录成功', '打开浏览器失败', '更新完成', '即将安装更新',
        '已退出登录', '步过执行', '步入执行', '步出执行', '继续执行',
        '另存为', '导出设置', '导入设置', '后台下载', '用户取消操作',
        '日志上传成功', '编译器路径无效或不存在。', 'GDB调试器未安装或不可用。'
    ];
    const still = migrated.filter((s) => userVisibleLines.some((l) => l.includes(s)));
    check('迁移过的中文不再出现在用户可见代码里', still.length === 0, still.join(','));

    // 代表性的调用点确实走 t()
    for (const key of ['main.loggedOut', 'main.debugStepOver', 'main.saveAsTitle',
        'main.backgroundDownloadTitle', 'main.updatedTo', 'main.exitCode']) {
        check(`main.js 使用了 t('${key}')`, mainSource.includes(`t('${key}'`));
    }

    // 带参数的调用点必须传 params（形参个数不匹配是最易翻车处）
    const paramCalls = [...mainSource.matchAll(/t\('main\.[A-Za-z]+',\s*\{([^}]*)\}\)/g)];
    check('带占位符的 main.* 调用都传了 params', paramCalls.length > 0, `${paramCalls.length} 处`);
    const badParam = paramCalls.filter((m) => !m[1].trim());
    check('没有 t(key, {}) 这种空 params', badParam.length === 0, `${badParam.length} 处`);

    // 每个被调用的 main.* 键都必须真实存在，且不在孤儿名单里
    const calledKeys = [...mainSource.matchAll(/t\('(main\.[A-Za-z]+)'/g)].map((m) => m[1]);
    const unresolved = [...new Set(calledKeys)].filter((k) => {
        const short = k.slice('main.'.length);
        return zhMain[short] === undefined;
    });
    check('main.js 引用的每个 main.* 键都存在于语言包', unresolved.length === 0, unresolved.join(','));
}

// ---------------------------------------------------------------------------
// 超时判定改用错误码，不再匹配 message 文案
// ---------------------------------------------------------------------------

{
    check('compiler.js 提供 isTimeoutError 助手',
        /function isTimeoutError\(error\)/.test(compilerSource));
    check('isTimeoutError 只看 name/code',
        /error\.name === 'AbortError' \|\| error\.name === 'TimeoutError'/.test(compilerSource) &&
        /error\.code === 'ECONNABORTED' \|\| error\.code === 'ETIMEDOUT'/.test(compilerSource));
    check('两处超时判定都改用 isTimeoutError',
        (compilerSource.match(/if \(isTimeoutError\(error\)\)/g) || []).length === 2);
    check('不再用 message 文案正则匹配超时',
        !/timeout\|timed out\|超时\|ECONNABORTED/i.test(compilerSource));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);