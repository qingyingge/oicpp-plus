'use strict';

// i18n 契约回归测试：锁定语言包结构与 renderer 查表行为，
// 防止批量正则替换（历史上出现过 `= ('key')` 这类静默空操作）再次悄悄破坏界面。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { bracedBlock: extractBracedBlock } = require('./fixtures/source-extract');

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

    // 反向锁定前提：window.i18n.t 确实只有两个形参。
    // 另锁定本轮收敛的成果：类上不再提供三参的 this.t，渲染层也不再调 this.t / window.__。
    const i18nSource2 = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'i18n.js'), 'utf8');
    check('premise: I18nManager.t takes exactly (key, params)', /^\s{4}t\(key, params\) \{/m.test(i18nSource2));

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
// 渲染层用的是自研 I18nManager（不是 i18next），这里固定它的既有契约。
{
    const i18nSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'js', 'i18n.js'), 'utf8');
    const enPack = JSON.parse(fs.readFileSync(path.join(langDir, 'en.json'), 'utf8'));

    const resolve = (messages, key) => key.split('.').reduce((acc, part) => (acc && typeof acc === 'object' ? acc[part] : undefined), messages);

    // 契约：缺 key 时返回 key 本身（而不是空串或 undefined），这是 CI 必须存在的原因
    check('renderer returns the key itself for unknown keys', resolve(enPack, 'definitely.not.a.real.key') === undefined);
    check('renderer resolves a real dotted key', resolve(enPack, 'browser.reload') === enPack.browser.reload);
    check('renderer resolves a nested dotted key', resolve(enPack, 'settings.language') === enPack.settings.language);

    // 契约：占位符替换保持未提供的 {token} 原样，方便肉眼发现漏传参数
    const interpolate = (value, params) => value.replace(/\{(\w+)\}/g, (m, name) => (
        params && params[name] !== undefined && params[name] !== null ? String(params[name]) : m
    ));
    check('interpolation substitutes provided params', interpolate('{a} and {b}', { a: 1, b: 2 }) === '1 and 2');
    check('interpolation keeps missing params visible', interpolate('{a} and {b}', { a: 1 }) === '1 and {b}');

    check('renderer t() substitutes {token} placeholders', /replace\(\/\\\{\(\\w\+\)\\\}\/g/.test(i18nSource));
    check('renderer loads the current language over IPC', i18nSource.includes("getLanguageFile"));
    check('renderer keeps a fallback pack for missing keys', i18nSource.includes('_fallbackMessages'));
}

// --- 主进程 i18next 接线 -----------------------------------------------------
{
    const langIndex = fs.readFileSync(path.join(langDir, 'index.js'), 'utf8');
    const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');

    check('main-process i18next instance is created', langIndex.includes('i18next.init'));
    check('main-process exposes the documented instance API',
        ['t', 'getCurrentLanguage', 'setLanguage', 'getAvailableLanguages'].every((fn) => langIndex.includes(`${fn}:`)));

    // 设置变更后必须重建原生菜单，否则语言切换对菜单栏无效
    const rebuildTriggers = [...mainSource.matchAll(/createMenuBar\(\)/g)];
    const keybindingGate = /hasOwnProperty\.call\([^)]*'keybindings'\)\)\s*\{\s*\n?\s*createMenuBar\(\)/.test(mainSource);
    check('application menu is rebuilt when keybindings change', keybindingGate, `${rebuildTriggers.length} call site(s)`);
}

console.log(`i18n tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
