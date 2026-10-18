'use strict';

// i18n 契约回归测试：锁定语言包结构与 renderer 查表行为，
// 防止批量正则替换（历史上出现过 `= ('key')` 这类静默空操作）再次悄悄破坏界面。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { bracedBlock: extractBracedBlock, ifStatement } = require('./fixtures/source-extract');

const root = path.resolve(__dirname, '..');
const langDir = path.join(root, 'src', 'lang');
const REQUIRED_LOCALES = ['zh-cn', 'en'];

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const flatten = (obj, prefix = '', out = {}) => {
    for (const [k, v] of Object.entries(obj || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
        else out[key] = v;
    }
    return out;
};
const placeholdersOf = (value) => (String(value).match(/\{\w+\}/g) || []).sort();

// --- 语言包可解析 -----------------------------------------------------------
// 曾经因为 zh-cn.json 里一个未转义引号导致 JSON.parse 失败，整站退化成裸键名。
const packs = {};
for (const code of REQUIRED_LOCALES) {
    const file = path.join(langDir, `${code}.json`);
    check(`${code}.json exists`, fs.existsSync(file), file);
    let parsed = null;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        check(`${code}.json parses as JSON`, false, error.message);
    }
    if (parsed) {
        check(`${code}.json parses as JSON`, true);
        packs[code] = flatten(parsed);
        check(`${code}.json meta.code matches filename`, parsed.meta?.code === code, parsed.meta?.code);
    }
}

if (packs['zh-cn'] && packs.en) {
    const enKeys = Object.keys(packs.en);
    const zhKeys = new Set(Object.keys(packs['zh-cn']));

    // --- key 对齐 ------------------------------------------------------------
    const missingInZh = enKeys.filter((k) => !zhKeys.has(k));
    const missingInEn = [...zhKeys].filter((k) => packs.en[k] === undefined);
    check('en.json and zh-cn.json have identical key sets', missingInZh.length === 0 && missingInEn.length === 0,
        missingInZh.length + missingInEn.length ? `missing zh: ${missingInZh.slice(0, 5)} | missing en: ${missingInEn.slice(0, 5)}` : `${enKeys.length} keys`);

    // --- placeholder 对齐 ----------------------------------------------------
    const phMismatch = enKeys.filter((k) => {
        if (packs['zh-cn'][k] === undefined) return false;
        return placeholdersOf(packs.en[k]).join('|') !== placeholdersOf(packs['zh-cn'][k]).join('|');
    });
    check('every key interpolates the same placeholders in both locales', phMismatch.length === 0,
        phMismatch.length ? phMismatch.slice(0, 5).map((k) => `${k}: en[${placeholdersOf(packs.en[k])}] zh[${placeholdersOf(packs['zh-cn'][k])}]`).join(' | ') : '');

    // --- 英文包不含 CJK 文字 -------------------------------------------------
    const enCjk = enKeys.filter((k) => /[\u4e00-\u9fff]/.test(String(packs.en[k])));
    check('en.json carries no untranslated CJK text', enCjk.length === 0, enCjk.slice(0, 5).join(', '));

    // --- 译文非空 ------------------------------------------------------------
    const empty = enKeys.filter((k) => typeof packs.en[k] === 'string' && packs.en[k].trim() === '');
    check('no translation is an empty string', empty.length === 0, empty.slice(0, 5).join(', '));
}

// --- 源码中不存在 t() 空操作残留 ---------------------------------------------
// `window.i18n ? window.i18n.t('key') : 'fallback'` 被批量替换后可能退化成
// `= ('key')`，界面直接显示裸键名且不会有任何报错。
{
    const allKeys = new Set();
    for (const pack of Object.values(packs)) for (const k of Object.keys(pack)) allKeys.add(k);

    const walk = (dir, out = []) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, out);
            else if (/\.(js|html)$/.test(entry.name)) out.push(full);
        }
        return out;
    };

    const residueRe = /(?<![=!<>+\-*/&|%?:])\s=\s*\(\s*['"]([a-z][\w]*(?:\.[a-zA-Z][\w]*)+)['"]\s*\)\s*;?\s*$/gm;
    const residue = [];
    for (const f of walk(path.join(root, 'src'))) {
        if (f.startsWith(langDir)) continue;
        const content = fs.readFileSync(f, 'utf8');
        for (const m of content.matchAll(residueRe)) {
            const line = content.slice(0, m.index).split('\n').length;
            residue.push(`${path.relative(root, f)}:${line} -> ${m[1]}${allKeys.has(m[1]) ? '' : ' (key not in any pack)'}`);
        }
    }
    check('no no-op t() residue in src/', residue.length === 0, residue.slice(0, 5).join(' | '));
}

// --- CI I8 的豁免规则本身也要被锁定 -------------------------------------------
// I8 的豁免有四条：带 data-i18n-* 的行、日志行、注释行，以及「中文只出现在 t() 兜底参数里」
// （本项目 renderer/main.js:52 与 compile-manager.js:3 都定义了 t(key, params, fallback)，
// 中文兜底是有意设计）。规则一旦被无意放宽，硬编码就重新混进主干。
// 原来这里是把 ci-check 的实现抄一份、再拿正则比源码长相：
//   /alreadyMigratedRe\.test\(line\)/、/const missingKeys = \[\]/、
//   /tKeysOnLine\(line\)\.filter\(\(k\) => !packKeys\.has\(k\)\)/、/missingKeys\.length > 0/，
//   还有 /const stripTFallback = \(line\) => line\r?\n([\s\S]*?)\r?\n  let count = 0;/ —— 连八个空格一起锁。
// 抄的副本会跟着源码各自漂移，比字面量只看得见「这行字还在」：skip 挪个位置、filter 条件写反、
// htmlFiles 不再进循环、ratchet 的比较号反过来，全都照样绿。
// 现在把 I8 整块抽出来在 vm 里真跑：喂进去的是合成源码，读出来的是 fail()/ok() 的原文。
{
    const ciSource = fs.readFileSync(path.join(root, 'scripts', 'ci-check.js'), 'utf8');
    const i8Block = extractBracedBlock(ciSource, /I8\] Hardcoded CJK ratchet/);
    check('I8 整块抽取成功（锚点失配就别再往下断言）',
        i8Block.startsWith('{') && i8Block.endsWith('}')
        && i8Block.includes('stripTFallback') && i8Block.includes('alreadyMigratedRe'),
        `${i8Block.length} chars`);

    // locales 在 ci-check 里已经摊平：键就是 'a.b' 这种点分串，值随便给个占位。
    const runI8 = (text, { keys = [], baseline = 0, html = false } = {}) => {
        const out = { fails: [], oks: [] };
        const file = `/virtual/src/probe${html ? '.html' : '.js'}`;
        vm.runInNewContext(i8Block, {
            console: { log: () => { } },
            path,
            root: '/virtual',
            verbose: false,
            info: () => { },
            locales: { 'zh-cn': Object.fromEntries(keys.map((k) => [k, 'x'])) },
            jsFiles: html ? [] : [file],
            htmlFiles: html ? [file] : [],
            readFile: () => text,
            I18N_HARDCODED_CJK_BASELINE: baseline,
            ok: (msg) => out.oks.push(String(msg)),
            fail: (msg) => out.fails.push(String(msg))
        });
        return out;
    };
    const silent = (r) => r.fails.length === 0 && r.oks.join(' ').includes('no user-visible hardcoded CJK');
    const hasSink = (line) => /textContent|innerHTML|innerText|\.title\s*=|placeholder|label:|message\s*:|alert\(|confirm\(|new Error\(|throw Error|show(Error|Warning|Message|Info|Confirm)\(/.test(line);

    check('I8 对没有中文的源码不报（下面每条豁免断言的阴性对照，抽取失败时它也会过 —— 所以阳性断言一条都不能省）',
        silent(runI8('const x = 1;\nconsole.log("ascii only");\n')));

    // 每条豁免都要配一条「同一行去掉豁免就该被计入」的阳性对照：
    // 否则样本行本身没踩到出口清单，把 skip 整行删掉测试也不会红（变异实测如此）。
    const hooked = runI8('<input placeholder="搜索" data-i18n-placeholder="k">', { keys: ['k'], html: true });
    check('I8 跳过带 data-i18n-* 钩子的行（行内中文只是 JS 加载前的默认值，_applyToDOM 会覆盖）',
        silent(hooked), JSON.stringify(hooked.fails));
    const htmlPlain = runI8('<input placeholder="搜索">', { html: true });
    check('I8 真的在扫 html：没有钩子的 placeholder 照样算硬编码（htmlFiles 掉出循环立刻见光）',
        htmlPlain.fails.length === 1, JSON.stringify(htmlPlain));

    // [带豁免的行, 去掉豁免标记的同一行]
    const skipRows = [
        ["logError('[编译] 路径不存在'); el.textContent = '编译失败';", "el.textContent = '编译失败';"],
        ["logWarn('正在写入配置'); panel.innerHTML = '<b>已保存</b>';", "panel.innerHTML = '<b>已保存</b>';"],
        ["// 中文说明：el.textContent = '编译失败';", "el.textContent = '编译失败';"],
        ["/* 中文块注释 */ el.textContent = '编译失败';", "el.textContent = '编译失败';"],
        ["   * 列表注释里的中文 el.textContent = '编译失败';", "el.textContent = '编译失败';"],
        ["const internalHint = '只是内部变量，没有任何用户可见出口';", "el.textContent = '只是内部变量，没有任何用户可见出口';"]
    ];
    const wronglyCounted = skipRows.filter(([line]) => runI8(line).fails.length > 0);
    check('四条豁免逐个真在生效：日志、三种注释、非用户可见出口都不计入',
        wronglyCounted.length === 0, wronglyCounted.map(([l]) => l).join(' | '));
    const blindSpot = skipRows.filter(([, bare]) => runI8(bare).fails.length === 0);
    check('每条豁免挡住的都是真会被判定的行（样本行本身不踩出口清单，删掉豁免也不会红）',
        blindSpot.length === 0, blindSpot.map(([, b]) => b).join(' | '));

    // 出口清单是 I8 的保护面：少认一个出口，就等于给那条通道开了硬编码的后门。
    const sinkRows = [
        "panel.textContent = '编译失败';",
        "el.innerHTML = '<b>加载中</b>';",
        "el.innerText = '已复制';",
        "dialogManager.show({ message: '保存失败' });",
        "throw new Error('无效的路径');",
        "alert('请先保存文件');",
        "item.title = '新建文件';",
        "confirm({ label: '确定' });",
        "showError({ detail: '磁盘已满' });"
    ];
    const notCounted = sinkRows.filter((line) => runI8(line).fails.length === 0);
    check('每个用户可见出口都真的被计入', notCounted.length === 0, notCounted.join(' | '));

    // 兜底豁免：可选链、裸 t()、带嵌套括号的实参三种形态都要认，
    // 少认一种就有一批已迁移的调用点被当成新回归，ratchet 就永远降不下来。
    // 每行都得踩在用户可见出口上：没有出口的行本来就被 userVisibleRe 放过了，
    // 把剥离逻辑写坏也照样「豁免成功」，这种样本只能证明 vm 跑起来了。
    const exemptRows = [
        ["if (label) label.textContent = this.t('lsp.disabledLabel', null, 'LSP 已禁用');", ['lsp.disabledLabel']],
        ["lspItem.title = this.t('k', null, '兜底文案');", ['k']],
        ["panel.textContent = window.i18n.t('monaco.contextMenuPaste', null, '粘贴');", ['monaco.contextMenuPaste']],
        ["panel.innerHTML = t('message.newFile', null, '新文件');", ['message.newFile']],
        ["label.textContent = this.t('cloud.download', { feature: f(1) }, '请先下载 {feature}');", ['cloud.download']],
        ["label.textContent = window.i18n?.t?.('lsp.disabledLabel', null) || 'LSP 已禁用';", ['lsp.disabledLabel']],
        ["loader.innerHTML = '<div>' + (window.i18n?.t?.('pdfViewer.loading') || 'PDF 加载中…') + '</div>';", ['pdfViewer.loading']],
        ["alert(i18n?.t?.('a.b', null) || '中文兜底');", ['a.b']],
        ["this.showMessage(window.i18n?.t?.('k', null) || '兜底', 'info');", ['k']]
    ];
    const notExempted = exemptRows.filter(([line, keys]) => runI8(line, { keys }).fails.length > 0);
    check('中文只活在 t() 兜底里时确实被豁免', notExempted.length === 0, notExempted.map(([l]) => l).join(' | '));
    const sinkless = [...sinkRows, ...exemptRows.map(([l]) => l)].filter((line) => !hasSink(line));
    check('样本行自己先过一遍筛：出口清单与兜底清单里每行都真带用户可见出口',
        sinkless.length === 0,
        '不带出口的行本来就被放过，把剥离或清单写坏也照样「通过」：' + sinkless.join(' | '));

    // 反向：剥 t() 调用不能顺手把整行放过。
    const stillCounted = [
        ["el.textContent = '编译成功';", []],
        ["el.textContent = '编译中'; el.title = this.t('k', null, '兜底');", ['k']],
        ["this.showMessage(this.t('k', null, '兜底') + '附加中文', 'info');", ['k']],
        ["el.title = window.i18n?.t?.('a.b') + '后缀中文';", ['a.b']],
        ["this.showMessage(window.i18n?.t?.('k', null) || '兜底', '硬编码提示');", ['k']]
    ];
    const slipped = stillCounted.filter(([line, keys]) => runI8(line, { keys }).fails.length === 0);
    check('兜底之外仍有中文时照计（豁免不能扩到整行）', slipped.length === 0, slipped.map(([l]) => l).join(' | '));

    // 豁免收紧：t() 查不到键时返回键名本身（非空 truthy），`|| 兜底` 永远不触发，
    // 屏幕上出现的是裸 key。所以只有键确实存在于语言包时才允许豁免。
    const typo = runI8("label.textContent = window.i18n?.t?.('lsp.disabledLable', null) || 'LSP 已禁用';", { keys: ['lsp.disabledLabel'] });
    check('键写错的中文兜底单独报缺陷：兜底永远不渲染，屏幕上是裸 key',
        typo.fails.some((m) => /not in any language pack/.test(m) && /lsp\.disabledLable/.test(m)),
        JSON.stringify(typo.fails));
    check('这条缺陷不算成硬编码（两种病灶修法不同，混在一起就没法分别收敛）',
        silent({ fails: typo.fails.filter((m) => !/not in any language pack/.test(m)), oks: typo.oks }),
        JSON.stringify(typo.oks));
    const typoBare = runI8("const tip = t('message.newFil', null, '新文件');", { keys: ['message.newFile'] });
    check('主进程的裸 t() 也查表（只认 window.i18n 形式会漏掉一半调用点）',
        typoBare.fails.some((m) => /message\.newFil\b/.test(m)), JSON.stringify(typoBare.fails));

    const twoLines = "el.textContent = '第一句';\nspan.textContent = '第二句';";
    const atBaseline = runI8(twoLines, { baseline: 2 });
    check('ratchet 到线不报（比较号写成 >= 就永远红）', atBaseline.fails.length === 0, JSON.stringify(atBaseline));
    const overBaseline = runI8(twoLines, { baseline: 1 });
    check('ratchet 超线就报，且报出超出量',
        overBaseline.fails.some((m) => /\(baseline 1, \+1\)/.test(m)), JSON.stringify(overBaseline.fails));
}

// --- window.i18n.t() / window.__ 只接受两个参数 -------------------------------
// i18n.js:103 的 t(key, params) 和 i18n.js:318 的 window.__ 都没有第三个形参，
// 而 renderer/main.js:52 与 compile-manager.js:3 自己包的 t(key, params, fallback)
// 有。照着 this.t 的习惯给 window.i18n.t 多传一个兜底文案，不会报错、也不会生效，
// 只是让"i18n 不可用时显示中文"这个保险静默失效。历史上已经犯过一次。
{
    const getAllJs = (dir, out = []) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) getAllJs(full, out);
            else if (entry.name.endsWith('.js')) out.push(full);
        }
        return out;
    };
    const scanFiles = getAllJs(path.join(root, 'src')).filter((f) => !f.startsWith(langDir));

    // 数出一次调用的顶层实参个数
    const countArgs = (args) => {
        let depth = 0, count = 1, inStr = null;
        for (let i = 0; i < args.length; i++) {
            const c = args[i];
            if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
            if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
            if ('([{'.includes(c)) depth++;
            else if (')]}'.includes(c)) { if (depth === 0) return count; depth--; }
            else if (c === ',' && depth === 0) count++;
        }
        return count;
    };

    const twoParamCallRe = /\bwindow\s*\.\s*(?:i18n\s*\.\s*t|__)\s*\(/g;
    const overlong = [];
    for (const f of scanFiles) {
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
            for (const m of line.matchAll(twoParamCallRe)) {
                if (countArgs(line.slice(m.index + m[0].length)) > 2) {
                    overlong.push(`${path.relative(root, f)}:${i + 1} -> ${line.trim().slice(0, 90)}`);
                }
            }
        });
    }
    check('no window.i18n.t()/window.__() call passes a third argument', overlong.length === 0,
        overlong.slice(0, 5).join(' | '));

    // 反向锁定前提：window.i18n.t 确实只有两个形参 —— 放在末尾的行为块里真调一次
    // （原先是 /^\s{4}t\(key, params\) \{/m.test(源码)：把形参改成 params = {} 或加个
    // 默认值，长相一变守卫就红，而第三参数到底会不会被吃只能靠人肉推断）。
    // 另锁定本轮收敛的成果：类上不再提供三参的 this.t，渲染层也不再调 this.t / window.__。

    const legacyThisT = [];
    for (const f of scanFiles) {
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
            if (/\bthis\s*\.\s*t\s*\(/.test(line) && !f.endsWith(path.join('renderer', 'js', 'i18n.js'))) {
                legacyThisT.push(`${path.relative(root, f)}:${i + 1}`);
            }
            if (/\bwindow\s*\.\s*__\s*\(/.test(line)) legacyThisT.push(`${path.relative(root, f)}:${i + 1} (window.__)`);
        });
    }
    check('no this.t() / window.__() call sites remain in the renderer', legacyThisT.length === 0,
        legacyThisT.slice(0, 5).join(' | '));

    // 局部 const t 别名是允许的（模板字符串里写全路径太啰嗦），但必须包 window.i18n
    const badAlias = [];
    for (const f of scanFiles) {
        fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
            const m = /^\s*const t = (.+);$/.exec(line);
            if (!m) return;
            if (!/window\.i18n\?\.t\?\./.test(m[1])) badAlias.push(`${path.relative(root, f)}:${i + 1} -> ${m[1].slice(0, 60)}`);
        });
    }
    check('every local "const t =" alias wraps window.i18n.t', badAlias.length === 0, badAlias.slice(0, 4).join(' | '));
}

// --- 孤儿键 ratchet ------------------------------------------------------------
// 语言包里有、源码里查不到任何引用的键。只锁死不许增长，存量暂留（人工清理时
// 每清掉一批就把 ci-check 里的 I18N_ORPHAN_KEY_BASELINE 调低一档）。
// 口径用"源码任意位置出现过的 dotted 字面量"而非 t('key')，后者认不出
// t(c ? 'a' : 'b') / _t(key, fb) / t(el.dataset.i18n) 这类动态查表。
{
    const getAllJs2 = (dir, out = []) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) getAllJs2(full, out);
            else if (/\.(js|html)$/.test(entry.name)) out.push(full);
        }
        return out;
    };
    const corpus = getAllJs2(path.join(root, 'src'))
        .filter((f) => !f.startsWith(langDir))
        .map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    const mentioned = new Set();
    for (const m of corpus.matchAll(/['"]([a-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)['"]/g)) mentioned.add(m[1]);
    // 属性访问同样算引用（main.js:3617 用 content.meta.code 读语言列表）
    for (const m of corpus.matchAll(/\.([a-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)/g)) mentioned.add(m[1]);

    const zhFlat2 = packs['zh-cn'];
    const orphans = Object.keys(zhFlat2).filter((k) => !mentioned.has(k));

    const ciSource2 = fs.readFileSync(path.join(root, 'scripts', 'ci-check.js'), 'utf8');
    const baselineMatch = /const I18N_ORPHAN_KEY_BASELINE = (\d+);/.exec(ciSource2);
    check('ci-check defines the orphan-key ratchet baseline', !!baselineMatch);
    if (baselineMatch) {
        const baseline = Number(baselineMatch[1]);
        check(`orphaned i18n keys do not exceed the ratchet baseline (${orphans.length} <= ${baseline})`,
            orphans.length <= baseline, orphans.length > baseline ? orphans.slice(0, 8).join(', ') : '');
    }
    // 防呆：口径写错（比如正则退化成匹配不到任何东西）会静默变成 0 < baseline 而恒绿
    check('the orphan detector actually finds dotted literals', mentioned.size > 500, `${mentioned.size} literals`);
}

// --- 所有静态引用的 key 都能解析 ---------------------------------------------
{
    const walk = (dir, out = []) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name === '.git') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full, out);
            else if (/\.(js|html)$/.test(entry.name)) out.push(full);
        }
        return out;
    };

    const callRe = /\b(?:i18n|i18next|__|this)\s*\.\s*t\s*\(\s*['"]([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)['"]/g;
    const bareCallRe = /(?<![.\w])t\s*\(\s*['"]([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)['"]/g;
    const attrRe = /data-i18n(?:-[a-z]+)?\s*=\s*['"]([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)['"]/g;

    const referenced = new Set();
    for (const f of walk(path.join(root, 'src'))) {
        if (f.startsWith(langDir)) continue;
        const content = fs.readFileSync(f, 'utf8');
        for (const re of [callRe, bareCallRe, attrRe]) {
            for (const m of content.matchAll(re)) referenced.add(m[1]);
        }
    }
    check('the source tree actually references translation keys', referenced.size > 0, `${referenced.size} keys`);

    for (const [code, pack] of Object.entries(packs)) {
        const missing = [...referenced].filter((k) => pack[k] === undefined);
        check(`all ${referenced.size} referenced keys resolve in ${code}.json`, missing.length === 0, missing.slice(0, 8).join(', '));
    }
}

// --- renderer 查表实现行为 ---------------------------------------------------
// 渲染层用的是自研 I18nManager（不是 i18next）。
// 这块原来有七条断言，一条都碰不到 i18n.js：
//   三条是「测试自己重写一遍 key.split('.').reduce(...)，再拿重写版和重写版比」的自证；
//   两条同样是把 interpolate 自己实现一遍再自比；
//   剩下三条比源码长相：/replace\(\/\\\{\(\\w\+\)\\\}\/g/、includes("getLanguageFile")、
//   includes('_fallbackMessages')。
// 自证断言最坏：i18n.js 的 t() 整段删掉它们照样绿。比长相的三条也一样 ——
// 把兜底查表改成查不到就返回空串，_fallbackMessages 这个变量名还在，守卫还是过。
// 现在把整个 i18n.js 在 vm 里真跑（连同 window.i18n / window.__ 的接线），
// 断言只看这个实例的返回值，以及它向主进程要了哪几份语言包。
const rendererContract = (async () => {
    const i18nSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'i18n.js'), 'utf8');
    const enPack = JSON.parse(fs.readFileSync(path.join(langDir, 'en.json'), 'utf8'));
    const zhPack = JSON.parse(fs.readFileSync(path.join(langDir, 'zh-cn.json'), 'utf8'));

    // files 就是「主进程那边有哪些语言包可给」，fail 用来模拟 IPC 抛错。
    const boot = ({ currentLang = 'en', files = {}, fail = false } = {}) => {
        const loaded = [];
        const errs = [];
        const infos = [];
        const win = {};
        win.electronAPI = {
            getLanguage: async () => currentLang,
            getLanguageFile: async (code) => {
                loaded.push(code);
                if (fail) throw new Error('ipc exploded');
                return files[code] === undefined ? null : files[code];
            }
        };
        const sandbox = {
            window: win,
            document: { body: {}, querySelectorAll: () => [], addEventListener: () => { } },
            module: { exports: {} },
            exports: {},
            console: { log: () => { } },
            logInfo: (...a) => infos.push(a.map(String).join(' ')),
            logError: (...a) => errs.push(a.map(String).join(' ')),
            MutationObserver: class { observe() { } disconnect() { } },
            setTimeout,
            clearTimeout
        };
        vm.createContext(sandbox);
        vm.runInContext(i18nSource, sandbox, { filename: 'renderer/js/i18n.js' });
        return { i: sandbox.module.exports, win, loaded, errs, infos };
    };

    const en = boot({ currentLang: 'en', files: { en: enPack, 'zh-cn': zhPack } });
    await en.i.init();
    check('i18n.js 整文件在 vm 里跑通并接上 window.i18n',
        !!en.i && en.i === en.win.i18n, `typeof window.i18n = ${typeof en.win.i18n}`);
    check('window.__ 是同一个 t 的绑定（换成独立实现就会绕过当前语言）',
        typeof en.win.__ === 'function' && en.win.__('browser.reload') === en.i.t('browser.reload'),
        `typeof window.__ = ${typeof en.win.__}`);
    check('按当前语言取包，非 zh-cn 时再取一份 zh-cn 兜底（少取一次就有一半键裸奔）',
        en.loaded.join(',') === 'en,zh-cn', en.loaded.join(','));
    const zhBoot = boot({ currentLang: 'zh-cn', files: { 'zh-cn': zhPack } });
    await zhBoot.i.init();
    check('zh-cn 只取自己一份', zhBoot.loaded.join(',') === 'zh-cn', zhBoot.loaded.join(','));

    // 上面那条「没有调用点给 window.i18n.t 传第三个参数」的前提，在这里用行为锁死：
    // 多传的那参数既不报错也不生效。将来谁给 t() 加了兜底形参，这条先红，
    // 那条静态检查才有意义（否则「静默丢弃」这件事本身就没人保证了）。
    check('t() 只收两个形参，第三个参数被静默丢弃',
        en.i.t.length === 2 && en.i.t('browser.reload', null, '中文兜底') === en.i.t('browser.reload'),
        `t.length=${en.i.t.length} 三参返回=${JSON.stringify(en.i.t('no.such.key', null, '中文兜底'))}`);

    // 契约：缺 key 时返回 key 本身（而不是空串或 undefined）—— CI 的孤儿键检查依赖这一点。
    check('真实点分键解析到译文（拿 en.json 的 browser.reload 喂真表）',
        en.i.t('browser.reload') === enPack.browser.reload, JSON.stringify(en.i.t('browser.reload')));
    check('多层嵌套键解析到译文',
        en.i.t('settings.language') === enPack.settings.language, JSON.stringify(en.i.t('settings.language')));
    check('缺 key 返回 key 本身',
        en.i.t('definitely.not.a.real.key') === 'definitely.not.a.real.key',
        JSON.stringify(en.i.t('definitely.not.a.real.key')));
    check('键路径中途不是对象时返回 key 本身而不是抛错',
        en.i.t('browser.reload.x') === 'browser.reload.x', JSON.stringify(en.i.t('browser.reload.x')));

    // 契约：占位符替换保持未提供的 {token} 原样，方便肉眼发现漏传参数。
    const FONT_KEY = 'settings.fontUnavailableMessage';
    const fontTemplate = enPack.settings.fontUnavailableMessage;
    check('不给实参时占位符原样留在文案里',
        en.i.t(FONT_KEY) === fontTemplate, JSON.stringify(en.i.t(FONT_KEY)));
    check('{token} 用实参逐个替换',
        en.i.t(FONT_KEY, { font: 'KaiTi', fallback: 'SimSun' }) ===
        fontTemplate.replace('{font}', 'KaiTi').replace('{fallback}', 'SimSun'),
        JSON.stringify(en.i.t(FONT_KEY, { font: 'KaiTi', fallback: 'SimSun' })));
    check('漏传的 {token} 原样留着（静默吃掉就没人发现少传了参数）',
        en.i.t(FONT_KEY, { font: 'KaiTi' }).includes('{fallback}'),
        JSON.stringify(en.i.t(FONT_KEY, { font: 'KaiTi' })));
    check('实参是 0 也要替换（判空写成 || 就会把 0 当成没传）',
        en.i.t(FONT_KEY, { font: 0, fallback: 0 }) ===
        fontTemplate.replace('{font}', '0').replace('{fallback}', '0'),
        JSON.stringify(en.i.t(FONT_KEY, { font: 0, fallback: 0 })));
    check('实参是 null 视为没传，保留占位符',
        en.i.t(FONT_KEY, { font: null }).includes('{font}'),
        JSON.stringify(en.i.t(FONT_KEY, { font: null })));

    const fb = boot({ currentLang: 'en', files: { en: { only: { present: 'EN' } }, 'zh-cn': { only: { other: '兜底值' } } } });
    await fb.i.init();
    check('当前语言包缺键时落到 zh-cn 兜底（不查兜底就有半数键在英界面显示成裸 key）',
        fb.i.t('only.other') === '兜底值' && fb.i.t('only.present') === 'EN',
        JSON.stringify([fb.i.t('only.other'), fb.i.t('only.present')]));
    check('兜底里也没有时仍返回 key 本身',
        fb.i.t('only.nope') === 'only.nope', JSON.stringify(fb.i.t('only.nope')));

    const missingFb = boot({ currentLang: 'en', files: { en: { a: { b: 'AB' } } } });
    await missingFb.i.init();
    check('兜底包取不到（null）时不抛错，只是没有兜底',
        missingFb.i.t('a.b') === 'AB' && missingFb.i.t('nope') === 'nope',
        JSON.stringify(missingFb.loaded));

    const num = boot({ currentLang: 'en', files: { en: { n: { v: 7 } }, 'zh-cn': {} } });
    await num.i.init();
    check('译文值不是字符串时转成字符串（渲染层拿到数字拼进 innerHTML 会变形）',
        num.i.t('n.v') === '7', JSON.stringify(num.i.t('n.v')));

    check('空 key / 非字符串 key 返回空串而不是抛错',
        en.i.t('') === '' && en.i.t(null) === '' && en.i.t(undefined) === '' && en.i.t(0) === '',
        JSON.stringify([en.i.t(''), en.i.t(null), en.i.t(undefined), en.i.t(0)]));
    check('translate() 与 t() 同义（老调用点还在用 translate）',
        en.i.translate('browser.reload') === en.i.t('browser.reload'));

    const boom = boot({ currentLang: 'en', files: {}, fail: true });
    await boom.i.init();
    check('语言包 IPC 抛错不掀掉初始化：记一条日志，查表退回裸 key',
        boom.errs.length > 0 && boom.i.t('browser.reload') === 'browser.reload',
        JSON.stringify(boom.errs[0] || null));
    // 只数 logError 不够：把 _loadCurrentLanguage 的 catch 改成往上抛，_doInit 的 catch
    // 也会记一条同样的日志、查表照样退回裸 key，上面那条还是绿的 ——
    // 但 _applyToDOM 和「初始化完成」这条收尾日志被一起跳过了，界面停在默认语言上。
    check('语言包 IPC 抛错后 init 照常走完结尾（不是被外层 catch 半路截走）',
        boom.infos.some((s) => /语言初始化完成/.test(s)),
        JSON.stringify({ infos: boom.infos, errs: boom.errs }));
    check('阴性对照：正常启动也是这条收尾日志（上面那条不是恒真）',
        en.infos.some((s) => /语言初始化完成/.test(s)) && en.errs.length === 0,
        JSON.stringify(en.infos));
})();

// --- 主进程 i18next 接线 -----------------------------------------------------
{
    const langIndex = fs.readFileSync(path.join(langDir, 'index.js'), 'utf8');
    const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    check('main-process i18next instance is created', langIndex.includes('i18next.init'));
    check('main-process exposes the documented instance API',
        ['t', 'getCurrentLanguage', 'setLanguage', 'getAvailableLanguages'].every((fn) => langIndex.includes(`${fn}:`)));

    // 设置变更后必须重建原生菜单，否则语言切换对菜单栏无效。
    // 原来这条比的是 /hasOwnProperty\.call\([^)]*'keybindings'\)\)\s*\{\s*\n?\s*createMenuBar\(\)/ ——
    // 把门写成 `'keybindings' in patch`（继承属性也算）或把 createMenuBar() 换个调用形式，正则就看不见；
    // 反过来两处门任何一处被删掉、但另一处还留着符合形状的代码，正则照样过。
    // 现在把两处门各自抽出来真跑：喂进 patch，看 createMenuBar 被叫了几次。
    // 各档自己防不防 null 是另一回事，不在这里锁：
    // update-settings 的门自带 `incomingSettings &&`，update-top-level-settings 的门没有
    // （它上面有 `for (const key in patch)`，null 走到这里不会先炸，会在本行炸），
    // 后者记入待修的健壮性问题，锁成「必须抛」就是把 bug 当契约。
    const gates = [
        ['update-settings（渲染层整包回传）',
            ifStatement(mainSource, /^\s*if \(incomingSettings && Object\.prototype\.hasOwnProperty\.call\(incomingSettings, 'keybindings'\)/m),
            'incomingSettings', true],
        ['update-top-level-settings（按键打补丁）',
            ifStatement(mainSource, /^\s*if \(Object\.prototype\.hasOwnProperty\.call\(patch, 'keybindings'\)/m),
            'patch', false]
    ];
    for (const [where, src, paramName, nullSafe] of gates) {
        check(`菜单重建门抽取成功：${where}`, src.startsWith('if ('), `${src.length} chars`);
        const calls = [];
        const sandbox = { createMenuBar: () => calls.push('menu') };
        vm.createContext(sandbox);
        vm.runInContext(`this.__gate = (${paramName}) => { ${src} };`, sandbox);
        const gate = sandbox.__gate;
        // 源码里门一旦被改成对 null 直接取值，抽出来的语句会抛。抛在这儿必须是
        // 一条可读的 FAIL，而不是让整份测试带着 stack trace 崩掉（后半段断言就没了）。
        const run = (input) => {
            calls.length = 0;
            try { gate(input); }
            catch (e) { return 'throw: ' + e.message; }
            return calls.length;
        };
        check(`${where}：改动里带了 keybindings 就重建菜单`,
            run({ keybindings: {} }) === 1, `calls=${run({ keybindings: {} })}`);
        check(`${where}：没带 keybindings 就不白重建一次`,
            run({ font: 'Consolas' }) === 0 && run({}) === 0, `calls=${run({ font: 'Consolas' })}`);
        check(`${where}：值为 undefined 也算改过（清空键位同样得重画菜单）`,
            run({ keybindings: undefined }) === 1, `calls=${run({ keybindings: undefined })}`);
        check(`${where}：只认自有属性（写成 in 会把继承来的 keybindings 也算成改动）`,
            run(Object.create({ keybindings: {} })) === 0, `calls=${run(Object.create({ keybindings: {} }))}`);
        if (nullSafe) {
            check(`${where}：整包是 null/undefined 时门自己兜住，不抛错`,
                run(null) === 0 && run(undefined) === 0, `run(null)=${run(null)} run(undefined)=${run(undefined)}`);
        }
    }

    // 语言切换那一档：setLanguage 与 createMenuBar 必须成对，缺一个就是「切了语言菜单还是旧语言」。
    const langGateSrc = ifStatement(mainSource, /^\s*if \(typeof patch\['language'\] === 'string'\)/m);
    check('语言切换门抽取成功', langGateSrc.startsWith('if ('), `${langGateSrc.length} chars`);
    {
        const seen = [];
        const sandbox = {
            setLanguage: (code) => seen.push(['setLanguage', code]),
            createMenuBar: () => seen.push(['createMenuBar'])
        };
        vm.createContext(sandbox);
        vm.runInContext(`this.__gate = (patch) => { ${langGateSrc} };`, sandbox);
        const call = (input) => { try { sandbox.__gate(input); } catch (e) { seen.push(['throw', e.message]); } };
        call({ language: 'en' });
        check('切语言时 setLanguage 与 createMenuBar 成对发生（只切不重建就是旧菜单）',
            JSON.stringify(seen) === JSON.stringify([['setLanguage', 'en'], ['createMenuBar']]),
            JSON.stringify(seen));
        seen.length = 0;
        call({ language: 42 });
        call({});
        check('非字符串/缺失的 language 不动语言也不重建菜单',
            seen.length === 0, JSON.stringify(seen));
    }
}

// 本文件末尾有 async 块：某一环的 promise 永不结算时，事件循环会直接排空、
// 进程以 0 退出，runner 数到前半截的 [PASS] 就判过 —— 尾巴上整段断言静默蒸发。
// （exit 监听里改不了退出码，所以用一条不 unref 的定时器把「跑不完」顶成失败。）
const watchdog = setTimeout(() => {
    console.log('[FAIL] i18n 测试 20s 没跑到收尾（renderer 契约块里有 promise 永不结算）');
    process.exit(1);
}, 20000);

rendererContract
    .catch((e) => {
        failures++;
        console.log(`[FAIL] renderer i18n 契约块抛错 | ${(e && e.stack) || (e && e.message) || e}`);
    })
    .then(() => {
        clearTimeout(watchdog);
        console.log(`i18n tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
        process.exitCode = failures ? 1 : 0;
    });
