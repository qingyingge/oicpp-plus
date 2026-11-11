'use strict';

// 「同一个元素的同一个属性被两套机制争抢」守卫 —— #9 的一般化。
//
// 成因：i18n 的 _applyToDOM() 在语言切换时把所有 [data-i18n] 元素重刷成**静态键值**。
// 而有一批元素的某个属性是 JS 按运行态覆写的（平台专属提示、状态栏 tooltip、
// 最大化/还原按钮）。两边写同一个属性时，JS 那条会在下次切语言被静默冲回静态文案，
// 直到重开窗口 —— #9 就是编译器设置窗的「运行方式提示」中招。
//
// 判定必须按「同一个属性」：data-i18n 管 textContent、JS 管 .title 是正常分工，
// 混起来判会把 7 处里的 6 处误报成冲突。属性映射：
//   data-i18n → textContent（textContent / innerText / innerHTML 视为同一个属性）
//   data-i18n-title → title，data-i18n-placeholder → placeholder，
//   data-i18n-aria-label → aria-label
//
// 已知盲区（如实登记，别当成全查了）：只认 `document.getElementById('x')` 形状的句柄。
// 像 `select.parentElement.querySelector('.hint')` 这样按结构取的元素对不回具体 HTML，
// 静态查不了 —— 所以 compiler.ts 那两处另有下面的「定点锁」。

const fs = require('fs');
const os = require('os');
const path = require('path');

const watchdog = setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾');
    process.exit(1);
}, 60000);

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'src');

const PROP_OF_ATTR = {
    'data-i18n': 'textContent',
    'data-i18n-title': 'title',
    'data-i18n-placeholder': 'placeholder',
    'data-i18n-aria-label': 'aria-label',
};
const TEXT_PROPS = new Set(['textContent', 'innerText', 'innerHTML']);
const normProp = (p) => (TEXT_PROPS.has(p) ? 'textContent' : p);

const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f, out);
        else if (/\.(ts|html)$/.test(e.name)) out.push(f);
    }
    return out;
};

/**
 * 扫 HTML 与 TS，找出「JS 覆写了某元素的某属性，而该元素该属性挂着别的 i18n 键」。
 * 参数化（而不是写死 src）是为了让自证探针能把合成的 HTML/TS 喂进同一个函数 ——
 * 否则「冲突 0 处」可能只是解析器什么都没查到。
 */
function audit(htmlFiles, tsFiles) {
    const wired = new Map();
    for (const f of htmlFiles) {
        fs.readFileSync(f, 'utf8').split('\n').forEach((ln, i) => {
            const idm = /\bid="([^"]+)"/.exec(ln);
            if (!idm) return;
            const found = [...ln.matchAll(/(data-i18n(?:-[a-z-]+)?)="([^"]+)"/g)]
                .filter((m) => PROP_OF_ATTR[m[1]]);
            if (!found.length) return;
            const id = idm[1];
            if (!wired.has(id)) wired.set(id, { props: new Map(), file: path.relative(root, f), line: i + 1 });
            const rec = wired.get(id);
            for (const m of found) {
                const prop = PROP_OF_ATTR[m[1]];
                if (!rec.props.has(prop)) rec.props.set(prop, new Set());
                rec.props.get(prop).add(m[2]);
            }
        });
    }

    const writes = [];
    for (const f of tsFiles) {
        const lines = fs.readFileSync(f, 'utf8').split('\n');
        const idOfVar = new Map();
        lines.forEach((ln) => {
            const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*document\.getElementById\(\s*'([^']+)'/.exec(ln);
            if (m) idOfVar.set(m[1], m[2]);
        });
        lines.forEach((ln, i) => {
            const w = /^\s*([A-Za-z_$][\w$]*)\.(textContent|innerText|innerHTML|title|placeholder)\s*=\s*(.*)$/.exec(ln);
            if (!w) return;
            const id = idOfVar.get(w[1]);
            if (!id) return;
            const keys = [...w[3].matchAll(/t\(\s*'([^']+)'/g)].map((m) => m[1]);
            if (!keys.length) return;
            writes.push({ id, prop: normProp(w[2]), keys, file: path.relative(root, f), line: i + 1 });
        });
    }

    const conflicts = [];
    let sameKey = 0;
    for (const j of writes) {
        const rec = wired.get(j.id);
        const bucket = rec && rec.props.get(j.prop);
        if (!bucket) continue;
        if (j.keys.every((k) => bucket.has(k))) { sameKey++; continue; }
        conflicts.push({
            id: j.id,
            prop: j.prop,
            htmlKeys: [...bucket],
            jsKeys: j.keys.filter((k) => !bucket.has(k)),
            htmlFile: rec.file,
            htmlLine: rec.line,
            jsFile: j.file,
            jsLine: j.line,
        });
    }
    return { wired, writes, conflicts, sameKey };
}

const describe = (c) => `#${c.id} .${c.prop} — html ${c.htmlFile}:${c.htmlLine} 管着 ${c.htmlKeys.join('/')}`
    + `，但 js ${c.jsFile}:${c.jsLine} 写 ${c.jsKeys.join('/')}`;

// 已登记的补偿点：这些元素确实被两套机制写，但所在文件订阅了 i18n-language-changed 且
// 延后一拍重放，所以语言切换后最终值仍由 JS 决定。豁免必须可腐烂 —— 既查「它还在冲突
// 清单里」（不在了就删掉这条，别留悬空豁免），也查「补偿订阅还在不在」。
const COMPENSATED = [
    { id: 'lsp-status-item', file: 'src/renderer/js/main.ts' },
    { id: 'marker-summary-item', file: 'src/renderer/js/main.ts' },
    { id: 'maximize-btn', file: 'src/renderer/js/titlebar.ts' },
    { id: 'install-compiler', file: 'src/renderer/settings/compiler.ts' },
];

const all = walk(srcDir);
const result = audit(
    all.filter((f) => f.endsWith('.html')),
    all.filter((f) => f.endsWith('.ts'))
);

check('扫描器可读（不是空集）',
    result.wired.size >= 100 && result.writes.length >= 10,
    `带 data-i18n 的 id 元素 ${result.wired.size}，JS 按 id 写文案 ${result.writes.length}，同键幂等重写 ${result.sameKey}`);

const unexpected = result.conflicts.filter((c) =>
    !COMPENSATED.some((e) => e.id === c.id && e.file === c.jsFile));
check('没有新增的「同元素同属性被写不同键」争抢点',
    unexpected.length === 0,
    unexpected.map(describe).join(' | '));

for (const e of COMPENSATED) {
    check(`豁免项 #${e.id} 仍在冲突清单里（不在了就从表里删掉）`,
        result.conflicts.some((c) => c.id === e.id && c.jsFile === e.file));
    const body = fs.readFileSync(path.join(root, e.file), 'utf8');
    check(`豁免项 #${e.id} 的补偿仍然有效：${e.file} 订阅语言事件且延后一拍重放`,
        /i18n-language-changed[\s\S]{0,400}setTimeout\(/.test(body));
}

// ---- 定点锁：静态扫描够不着的那两处（#9 本体）------------------------------
// 它们的元素一个要靠 parentElement.querySelector('.hint') 拿、一个要在异步平台探测的
// 回调里拿，id 扫描对不上号。所以钉「该键在文件里只出现一次，且唯一那次落在幂等方法体内」：
// 谁再把覆写文案塞回一次性回调，这个键就会出现两次 → 立刻变红。
const compilerFile = path.join(root, 'src', 'renderer', 'settings', 'compiler.ts');
const compilerSrc = fs.readFileSync(compilerFile, 'utf8');
const methodRange = (name) => {
    const from = compilerSrc.indexOf(`${name}(): void {`);
    if (from < 0) return { from: -1, to: -1, text: '' };
    let depth = 0;
    for (let i = compilerSrc.indexOf('{', from); i < compilerSrc.length; i++) {
        if (compilerSrc[i] === '{') depth++;
        else if (compilerSrc[i] === '}') {
            depth--;
            if (depth === 0) return { from, to: i + 1, text: compilerSrc.slice(from, i + 1) };
        }
    }
    return { from: -1, to: -1, text: '' };
};
const onlyInside = (name, keys) => {
    const range = methodRange(name);
    if (!range.text) return { ok: false, why: `找不到 ${name}() 方法体` };
    for (const k of keys) {
        const hits = [...compilerSrc.matchAll(new RegExp(`'${k.split('.').join('\\.')}'`, 'g'))];
        if (hits.length !== 1) return { ok: false, why: `'${k}' 出现 ${hits.length} 次（应恰好 1 次）` };
        if (hits[0].index < range.from || hits[0].index > range.to) return { ok: false, why: `'${k}' 不在 ${name}() 内` };
    }
    return { ok: true, why: `${name}() ${range.text.length}B，${keys.length} 个键各出现 1 次` };
};
const hintProbe = onlyInside('refreshRunModeHint', ['compiler.integratedOnlyHint', 'compiler.runModeDesc']);
check('运行方式提示只在幂等方法里取文案（没有第二处散写）', hintProbe.ok, hintProbe.why);
const installProbe = onlyInside('refreshInstallButton', ['compiler.nonWindowsHint', 'compiler.downloadDisabled']);
check('安装按钮的平台文案只在幂等方法里取（没有第二处散写）', installProbe.ok, installProbe.why);

const replay = /i18n-language-changed[\s\S]{0,400}setTimeout\(\(\)\s*=>\s*\{([\s\S]{0,200})\}/.exec(compilerSrc);
check('语言切换后两个方法都被重放（漏一个就是 #9 复发）',
    !!replay && replay[1].includes('refreshRunModeHint()') && replay[1].includes('refreshInstallButton()'),
    replay ? replay[1].replace(/\s+/g, ' ').trim() : '没找到重放语句');

// ---- 自证：扫描器必须真能咬，否则上面的「0 处新增」只是空集 PASS ----------
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-owner-'));
const probeHtml = path.join(probeDir, 'p.html');
const probeTs = path.join(probeDir, 'p.ts');
fs.writeFileSync(probeHtml, [
    '<html><body>',
    '<button id="clash" data-i18n="k.static">静态</button>',
    '<button id="same" data-i18n="k.shared">共享</button>',
    '<button id="other-prop" data-i18n="k.body">文字</button>',
    '</body></html>',
].join('\n'));
fs.writeFileSync(probeTs, [
    "const a = document.getElementById('clash');",
    "a.textContent = window.i18n.t('k.runtime');",     // 应命中：同元素同属性换了键
    "const b = document.getElementById('same');",
    "b.textContent = window.i18n.t('k.shared');",      // 不该命中：同键，幂等重写
    "const c = document.getElementById('other-prop');",
    "c.title = window.i18n.t('k.tip');",               // 不该命中：data-i18n 管文字，这里管 title
].join('\n'));

const probe = audit([probeHtml], [probeTs]);
const ids = probe.conflicts.map((c) => c.id);
check('探针：抓得到「同元素同属性换了个键」（守卫不空转）',
    probe.conflicts.length === 1 && ids[0] === 'clash', JSON.stringify(ids));
check('探针：同键幂等重写不误报', !ids.includes('same'), JSON.stringify(ids));
check('探针：data-i18n 管文字 / JS 管 title 的分工不误报', !ids.includes('other-prop'), JSON.stringify(ids));
check('探针：报告带上两边的键与两边位置（否则没法定位）',
    probe.conflicts.length === 1
        && probe.conflicts[0].htmlKeys.join() === 'k.static'
        && probe.conflicts[0].jsKeys.join() === 'k.runtime'
        && probe.conflicts[0].htmlLine === 2 && probe.conflicts[0].jsLine === 2,
    JSON.stringify(probe.conflicts[0] || null));

fs.rmSync(probeDir, { recursive: true, force: true });

console.log(`\n共 ${result.wired.size} 个带 data-i18n 的 id 元素、${result.writes.length} 条 JS 按 id 写文案、`
    + `${result.conflicts.length} 处争抢（已登记补偿 ${COMPENSATED.length} 处）。`);
clearTimeout(watchdog);
console.log(`i18n-dom-owner-conflict tests completed: ${failures} failure(s)`);
process.exitCode = failures > 0 ? 1 : 0;
