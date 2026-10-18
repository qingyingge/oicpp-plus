'use strict';

// 覆盖 24e3365：I6/I8 检查器修正 + 主进程 75 条硬编码中文迁入 main.*。
// 重点是「守门」：这类迁移最容易在后续重构中被静默改回。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { funcDecl, ifStatement } = require('./fixtures/source-extract');
const { loadLocales } = require('./fixtures/ci-block-runner');

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

    // 代表性的调用点确实走 t()，并且**渲染得出来**。
    // 原来这 6 条是 mainSource.includes(`t('${key}'`)：只查「这行字面量还在」。
    // 而集成 i18next 那天起 src/lang 的 init 就是坏的 —— i18next 把带连字符的语言码
    // 规范化成 zh-CN（languageUtils.formatLanguageCode），resources 里的键却按设置值
    // 写成 zh-cn，两边对不上，中文模式下每条 t() 都掉进 parseMissingKeyHandler 原样
    // 吐裸键名，6 条字面量守卫一条都没红。改成把真模块起一个子进程跑一遍，
    // 期望值另从语言包 JSON 取：i18n 一坏，期望（真译文）和实际（裸键名）立刻分叉。
    const usedKeys = new Set([...mainSource.matchAll(/t\(\s*(['"])(main\.[A-Za-z]+)\1/g)].map((m) => m[2]));
    const RENDERED = ['main.loggedOut', 'main.debugStepOver', 'main.saveAsTitle',
        'main.backgroundDownloadTitle', 'main.updatedTo', 'main.exitCode'];
    for (const key of RENDERED) {
        check(`main.js 的调用点用到 ${key}（按引号风格/换行解析，不锁字面量）`,
            usedKeys.has(key), usedKeys.has(key) ? '' : `解析到的 ${usedKeys.size} 个键里没有它`);
    }
    {
        const langEntry = path.join(ROOT, 'src', 'lang');
        const probe = execFileSync(process.execPath, ['-e', `
            const L = require(${JSON.stringify(langEntry)});
            const out = { order: [] };
            (async () => {
                await L.setLanguage('zh-cn');
                out.order.push(L.getCurrentLanguage());
                out.zh = {};
                for (const k of ${JSON.stringify(RENDERED)}) {
                    out.zh[k] = L.t(k, { version: '9.9.9', status: '7' });
                }
                await L.setLanguage('en');
                out.order.push(L.getCurrentLanguage());
                out.en = {};
                for (const k of ${JSON.stringify(RENDERED)}) {
                    out.en[k] = L.t(k, { version: '9.9.9', status: '7' });
                }
                console.log(JSON.stringify(out));
            })();
        `], { encoding: 'utf8', timeout: 30000 });
        const rendered = JSON.parse(probe.trim().split('\n').pop());
        const keys = RENDERED;
        // 期望值自己按语言包模板插值，不走 i18next：两条独立来源对得上才算数
        const fill = (text) => String(text).replace(/\{version\}/g, '9.9.9').replace(/\{status\}/g, '7');
        const short = (k) => k.slice('main.'.length);
        check('zh-cn 下每条 main.* 都渲染成语言包里的译文，不是裸键名',
            keys.every((k) => rendered.zh[k] === fill(zhMain[short(k)])),
            JSON.stringify(rendered.zh));
        check('en 下同样命中 en.json（切语言真换了资源袋）',
            keys.every((k) => rendered.en[k] === fill(enMain[short(k)])),
            JSON.stringify(rendered.en));
        // 语言码对外仍必须是 'zh-cn'：设置页、getAvailableLanguages、渲染层都按这个字面量比
        check('setLanguage 之后 getCurrentLanguage 仍是小写 zh-cn（规范化不许改出去）',
            rendered.order.join('/') === 'zh-cn/en', rendered.order.join('/'));
        check('单花括号插值生效：{version} 被替换而不是留在文案里',
            /9\.9\.9/.test(rendered.zh['main.updatedTo'])
            && !/\{version\}/.test(rendered.zh['main.updatedTo']),
            rendered.zh['main.updatedTo']);
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
    // 原来四条全是文本守卫：`/function isTimeoutError\(/`、把 name/code 那两行逐字比对、
    // 数 `if (isTimeoutError(error))` 出现两次，最后一条 `/timeout\|timed out\|超时\|ECONNABORTED/i`
    // 里是**转义竖线**，实际只在查「旧正则的字面量没回来」。
    // 把 message 匹配换成任何别的写法（/timed\s*out/i、error.message.includes('超时')、判 HTTP 状态码），
    // 四条一条都不会红 —— 而这正是 M57 那类「改一次译文就静默失配」的入口。
    // 现在把助手本体和两处 catch 里的判定块抽出来真跑：谁能决定超时，是跑出来的。
    const guard = funcDecl(compilerSource, 'isTimeoutError');
    check('isTimeoutError 整段抽取成功（真跑的必须是源码那份，不是测试里重抄的判据）',
        guard.length > 80, JSON.stringify(guard.slice(0, 40)));

    const vmGlobals = { Object, String, Array, RegExp, Math, Error, JSON };
    const runGuard = (err) => {
        const ctx = vm.createContext(vmGlobals);
        try {
            vm.runInContext(`${guard}\nthis.__call = (e) => isTimeoutError(e);`, ctx);
            return { val: ctx.__call(err) };
        } catch (e) { return { threw: String((e && e.message) || e) }; }
    };

    // [输入, 期望, 这一条在防什么]
    const CASES = [
        [{ name: 'AbortError' }, true, 'abort 的错误名'],
        [{ name: 'TimeoutError' }, true, '超时的错误名'],
        [{ code: 'ECONNABORTED' }, true, '连接中止的错误码'],
        [{ code: 'ETIMEDOUT' }, true, '系统超时的错误码'],
        [{ __proto__: { name: 'TimeoutError' } }, true, '真 DOMException 的 name 在原型链上，也必须认'],
        [{ name: 'Error', message: 'timeout' }, false, 'message 里写着 timeout 不算'],
        [{ name: 'Error', message: 'request timed out after 30000ms' }, false, 'timed out 不算'],
        [{ name: 'Error', message: '获取编译器列表超时' }, false, '中文「超时」不算'],
        [{ name: 'Error', message: 'timeout|timed out|超时|ECONNABORTED' }, false,
            '把旧文案正则整串塞进 message 也不算（这条替掉那条转义竖线的文本守卫）'],
        [{ name: 'abortError' }, false, '大小写敏感：不是宽松匹配'],
        [{ name: 'NotTimeoutError' }, false, '子串不算命中：不是 includes'],
        [{ code: 'ECONNRESET' }, false, '连接重置不是超时'],
        [{ code: 'timeout' }, false, '把文案塞进 code 也不算：只认那两个码'],
        [new Error('timeout'), false, '真 Error 的 name 是 Error，不能因为 message 就判超时'],
        [null, false, 'null 直接挡（!cause 那半条真起作用）'],
        ['ECONNABORTED', false, '字符串形态的错误也要挡（typeof 那半条真起作用）']
    ];
    for (const [err, want, why] of CASES) {
        check(`助手判定 ${JSON.stringify(err)} === ${want} —— ${why}`,
            runGuard(err).val === want, JSON.stringify(runGuard(err)));
    }

    // 两处 catch：抽整块来跑，块后面补一句「走通用分支」的标记 —— 于是「进没进超时分支」
    // 不再是从源码数出来的，是执行出来的。
    const cLines = compilerSource.split('\n');
    const siteLines = cLines.map((l, i) => (/^\s*if \(isTimeoutError\(/.test(l) ? i : -1)).filter((i) => i >= 0);
    const blocks = siteLines.map((i) => ifStatement(cLines.slice(i).join('\n'), /^([ \t]*)if \(/m));
    check('两处 catch 里的超时判定各抽到一整块（是抽出来能跑，不是数出现两次）',
        blocks.length === 2 && blocks.every((b) => b.length > 300),
        JSON.stringify({ siteLines, lens: blocks.map((b) => b.length) }));

    const pack = loadLocales(['zh-cn'])['zh-cn'];
    const mkEl = () => {
        const el = {
            innerHTML: '', clicks: [],
            querySelector(sel) {
                return el.innerHTML.includes(`class="${sel.slice(1)}"`)
                    ? { addEventListener: (type, fn) => el.clicks.push([type, fn]) } : null;
            }
        };
        return el;
    };
    const runSite = (block, err) => {
        const els = { compilerList: mkEl(), testlibList: mkEl() };
        const logs = [];
        const tKeys = [];
        const reloads = [];
        const self = {
            __generic: false,
            loadAvailableCompilers: () => reloads.push('compilers'),
            loadAvailableTestlibs: () => reloads.push('testlibs')
        };
        const ctx = vm.createContext({
            ...vmGlobals,
            logError: (m) => logs.push(m),
            compilerList: els.compilerList,
            testlibList: els.testlibList,
            window: { i18n: { t: (k) => { tKeys.push(k); return pack[k]; } } }
        });
        try {
            vm.runInContext(`${guard}\nthis.__run = function (error) {\n${block}\n    this.__generic = true;\n};`, ctx);
            ctx.__run.call(self, err);
            return {
                generic: self.__generic === true, logs, tKeys, reloads,
                wrote: Object.keys(els).filter((k) => els[k].innerHTML !== ''),
                htmlBy: Object.fromEntries(Object.entries(els).map(([k, v]) => [k, v.innerHTML])),
                handlers: Object.fromEntries(Object.entries(els).map(([k, v]) => [k, v.clicks]))
            };
        } catch (e) { return { threw: String((e && e.message) || e) }; }
    };
    const SITES = [
        { block: blocks[0], list: 'compilerList', reload: 'compilers' },
        { block: blocks[1], list: 'testlibList', reload: 'testlibs' }
    ];
    const timeoutErr = { name: 'TimeoutError' };
    const legacyMsgErr = { name: 'Error', message: 'timeout|timed out|超时|ECONNABORTED' };
    for (const [n, site] of SITES.entries()) {
        const to = runSite(site.block, timeoutErr);
        check(`站点${n + 1} 超时错误走超时分支：只写自己那一个列表，且写的是真译文`,
            !to.threw && to.generic === false
                && JSON.stringify(to.wrote) === JSON.stringify([site.list])
                && to.htmlBy[site.list].includes(pack['compiler.requestTimeout'])
                && to.htmlBy[site.list].includes(pack['compiler.retry'])
                && !to.htmlBy[site.list].includes("'compiler.requestTimeout'")
                && !to.htmlBy[site.list].includes('undefined'),
            JSON.stringify({ threw: to.threw, generic: to.generic, wrote: to.wrote, html: to.htmlBy }));
        check(`站点${n + 1} 超时分支确实走 i18n 取文案（两个键、顺序固定），不是硬编码中文`,
            JSON.stringify(to.tKeys) === JSON.stringify(['compiler.requestTimeout', 'compiler.retry']),
            JSON.stringify(to.tKeys));

        // 重试按钮：innerHTML 里没有 retry-btn 这个类时 querySelector 返回 null，
        // 监听也就挂不上 —— 所以「注册了几次监听」是这段渲染的结果，不是前提。
        const other = site.list === 'compilerList' ? 'testlibList' : 'compilerList';
        check(`站点${n + 1} 重试按钮接得上：恰好注册一次 click，另一处列表一个监听都没被碰`,
            to.handlers[site.list].length === 1 && to.handlers[site.list][0][0] === 'click'
                && to.handlers[other].length === 0,
            JSON.stringify(to.handlers));
        const clicked = (() => {
            const r = runSite(site.block, timeoutErr);
            if (r.threw || !r.handlers[site.list][0]) return { err: JSON.stringify(r) };
            let pd = 0;
            r.handlers[site.list][0][1]({ preventDefault: () => { pd++; } });
            return { pd, reloads: r.reloads };
        })();
        check(`站点${n + 1} 点重试：preventDefault 生效并且真去重新拉列表（只拉自己那一种）`,
            clicked.pd === 1 && JSON.stringify(clicked.reloads) === JSON.stringify([site.reload]),
            JSON.stringify(clicked));

        const legacy = runSite(site.block, legacyMsgErr);
        check(`站点${n + 1} 满屏旧文案的普通错误走通用分支：超时分支一个字符都不写、i18n 一次都不调`,
            !legacy.threw && legacy.generic === true && legacy.wrote.length === 0
                && legacy.tKeys.length === 0
                && Object.values(legacy.handlers).every((h) => h.length === 0),
            JSON.stringify(legacy));
        check(`站点${n + 1} 走没走超时分支，与助手的判定逐个一致（分支不是另写一套条件）`,
            [timeoutErr, legacyMsgErr, { code: 'ETIMEDOUT' }, new Error('timeout'), null].every((e) =>
                runSite(site.block, e).generic === (runGuard(e).val !== true)),
            JSON.stringify([timeoutErr, legacyMsgErr].map((e) => ({
                guard: runGuard(e).val, generic: runSite(site.block, e).generic }))));
    }
    const pair = [timeoutErr, legacyMsgErr, { code: 'ECONNABORTED' }, { name: 'Error', message: 'boom' }]
        .map((e) => [runSite(SITES[0].block, e), runSite(SITES[1].block, e)]);
    check('两处站点对同一组错误走出同一个形状（只有目标元素与重载方法名不同）',
        pair.every(([a, b]) => !a.threw && !b.threw && a.generic === b.generic
            && a.tKeys.length === b.tKeys.length && a.wrote.length === b.wrote.length
            && a.logs.length === b.logs.length) && pair.length === 4,
        JSON.stringify(pair.map(([a, b]) => ({ a: a.threw || a.generic, b: b.threw || b.generic }))));
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);