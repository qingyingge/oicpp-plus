'use strict';

// src/utils/keybindings.ts（默认组合键表 / 平台判定 / 可改键 schema 的单一来源）的守卫。
//
// 这个文件存在的全部理由写在它自己的头注释里，一句话版：
// 同一张默认表历史上被抄过 4 份（renderer/js/main.ts、monaco-editor-manager.ts、
// settings/editor.ts、src/main.ts 内联），平台判定被写过 4 份，而 `⌘` 在全部 git 历史里
// 出现 0 次 —— 每一步都只补自己那一层，代价都是「再抄一份」。
// 所以这里既测行为，也锁「不许再出现第二份表」这个形状。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { classMethod, compileMethod } = require('./fixtures/source-extract');

const root = path.resolve(__dirname, '..');
const SRC = path.join(root, 'src');
const kb = require('../src/utils/keybindings.js');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const tsFiles = [];
(function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) tsFiles.push(p);
    }
})(SRC);

// ---------------------------------------------------------------------------
// 1. 模块行为
// ---------------------------------------------------------------------------
{
    const cases = [
        ['darwin', 'mac'], ['Darwin', 'mac'], ['macos', 'mac'], ['Mac OS X', 'mac'],
        ['win32', 'windows'], ['windows', 'windows'], ['linux', 'linux'],
        ['freebsd', 'other'], ['', 'other'], [undefined, 'other'], [null, 'other']
    ];
    for (const [raw, want] of cases) {
        check(`resolvePlatform(${JSON.stringify(raw)}) = ${want}`, kb.resolvePlatform(raw) === want, kb.resolvePlatform(raw));
    }
    check('默认表 22 个键（以前四处抄的那张的键数）',
        Object.keys(kb.defaultKeybindings('windows')).length === 22,
        String(Object.keys(kb.defaultKeybindings('windows')).length));

    // 平台差异只有两个键，而且必须**只有**这两个 —— 多一个就是有人又加了第三种 isMac 分支
    const win = kb.defaultKeybindings('windows');
    const lin = kb.defaultKeybindings('linux');
    const mac = kb.defaultKeybindings('mac');
    const diffKeys = Object.keys(win).filter((k) => win[k] !== mac[k]).sort();
    check('mac 与非 mac 的默认值只差在 compileAndRun / runAllSamples',
        diffKeys.join() === 'compileAndRun,runAllSamples', diffKeys.join());
    check('windows 与 linux 的默认值完全一致（别把 linux 当第三态）',
        JSON.stringify(win) === JSON.stringify(lin), JSON.stringify(Object.keys(lin).filter((k) => lin[k] !== win[k])));
    check('mac 上 F11 让位给全屏：compileAndRun = Ctrl+F11', mac.compileAndRun === 'Ctrl+F11', mac.compileAndRun);
    check('非 mac 上 compileAndRun = F11', win.compileAndRun === 'F11', win.compileAndRun);
    check('mac 上 runAllSamples 让开 Ctrl+F11 → Ctrl+Shift+F11',
        mac.runAllSamples === 'Ctrl+Shift+F11', mac.runAllSamples);

    // currentPlatform/isMacPlatform 走的是同一份判定；注入点让 mac 分支在 linux CI 上也能真跑
    const before = kb.currentPlatform();
    kb.setPlatformOverride('mac');
    check('注入 mac 后 currentPlatform()=mac 且 isMacPlatform() 为真',
        kb.currentPlatform() === 'mac' && kb.isMacPlatform() === true, kb.currentPlatform());
    kb.setPlatformOverride(null);
    check('撤掉注入后回到宿主平台（注入点不是永久状态）', kb.currentPlatform() === before, String(before));
    check('isMacPlatform(显式传值) 不看宿主', kb.isMacPlatform('mac') === true && kb.isMacPlatform('windows') === false);
}

// ---------------------------------------------------------------------------
// 2. schema 与可改键清单是派生的，且顺序/键位没漂
// ---------------------------------------------------------------------------
{
    // 这个顺序就是设置页从上到下的顺序（用户可见），改它要有意的。
    const expectedOrder = [
        'formatCode', 'showFunctionPicker', 'markdownPreview', 'renameSymbol',
        'deleteLine', 'duplicateLine', 'moveLineUp', 'moveLineDown',
        'compileCode', 'runCode', 'compileAndRun', 'toggleDebug',
        'debugContinue', 'debugStepOver', 'debugStepInto', 'debugStepOut',
        'cloudCompile', 'openTerminal', 'runAllSamples'
    ];
    const schema = kb.keybindingSchema();
    check('schema 19 项、顺序与改造前那份手抄清单逐字一致',
        schema.length === 19 && schema.map((e) => e.key).join() === expectedOrder.join(),
        schema.map((e) => e.key).join());
    check('editableKeybindingKeys() 与 schema 同源（不是第二份清单）',
        kb.editableKeybindingKeys().join() === schema.map((e) => e.key).join());
    check('copy/paste/cut 在默认表里但不在设置页（历史上没人读它们）',
        ['copy', 'paste', 'cut'].every((k) => k in kb.defaultKeybindings('windows'))
            && ['copy', 'paste', 'cut'].every((k) => !schema.some((e) => e.key === k)));

    // labelKey 都是真键：改键设置页靠它们显示中文名，缺一个就是裸键上屏（I6/I7 之外再兜一层）
    const packs = {};
    for (const code of ['zh-cn', 'en']) {
        packs[code] = JSON.parse(read(path.join('src', 'lang', `${code}.json`)));
    }
    for (const entry of schema) {
        const [ns, leaf] = entry.labelKey.split('.');
        check(`schema 的 labelKey 在两份包里都存在：${entry.labelKey}`,
            typeof packs['zh-cn'][ns]?.[leaf] === 'string' && typeof packs.en[ns]?.[leaf] === 'string');
    }
}

// ---------------------------------------------------------------------------
// 3. 形状 ratchet：不许再有第二份表 / 第二份清单
// ---------------------------------------------------------------------------
{
    const TABLE_RE = /^\s*(formatCode|showFunctionPicker|markdownPreview|renameSymbol|deleteLine|duplicateLine|moveLineUp|moveLineDown|compileCode|runCode|compileAndRun|toggleDebug|debugContinue|debugStepOver|debugStepInto|debugStepOut|cloudCompile|openTerminal|runAllSamples|copy|paste|cut)\s*:\s*['"`]/gm;
    const LIST_RE = /^\s*'(formatCode|showFunctionPicker|markdownPreview|renameSymbol|deleteLine|duplicateLine|moveLineUp|moveLineDown|compileCode|runCode|compileAndRun|toggleDebug|debugContinue|debugStepOver|debugStepInto|debugStepOut|cloudCompile|openTerminal|runAllSamples)',$/gm;
    const keybindingsFile = path.join(SRC, 'utils', 'keybindings.ts');
    const offenders = [];
    const listOffenders = [];
    for (const f of tsFiles) {
        if (f === keybindingsFile) continue;
        const content = fs.readFileSync(f, 'utf8');
        const hits = content.match(TABLE_RE);
        if (hits) offenders.push(`${path.relative(root, f)}: ${hits.length} 处（如 ${hits[0].trim()}）`);
        const lists = content.match(LIST_RE);
        if (lists) listOffenders.push(`${path.relative(root, f)}: ${lists.length} 项`);
    }
    check('除 keybindings.ts 外没有任何 .ts 再写「键: 组合键」的默认表',
        offenders.length === 0, offenders.join(' | '));
    check('除 keybindings.ts 外没有任何 .ts 再手抄可改键清单',
        listOffenders.length === 0, listOffenders.join(' | '));
    // 不能失败的守卫等于没有守卫：这两条自证上面两个正则会真的抓住一份新抄的表
    check('自证：正则确实抓得住一份新抄的默认表',
        (TABLE_RE.exec("        formatCode: 'Alt+Shift+S',\n        runAllSamples: 'Ctrl+F11'\n") || [])[0] !== undefined);
    TABLE_RE.lastIndex = 0;
    check('自证：正则确实抓得住一份新抄的清单',
        LIST_RE.test("            'formatCode',\n            'runAllSamples',\n"));

    // 主进程那份内联的 keybindings: { ... } 也必须已经变成委托
    const mainSrc = read(path.join('src', 'main.ts'));
    check('src/main.ts 的默认设置里不再有内联键表',
        !/keybindings:\s*\{/.test(mainSrc) && /keybindings:\s*defaultKeybindings\(/.test(mainSrc));
}

// ---------------------------------------------------------------------------
// 4. 消费者确实委托，且退化方向是「没有默认键」而不是「自己猜一份」
// ---------------------------------------------------------------------------
{
    const rendererMainSrc = read(path.join('src', 'renderer', 'js', 'main.js'));
    const extracted = compileMethod(vm.createContext({
        window: { oicppKeybindings: kb },
        Object, String, Array, JSON, Map, Set
    }), classMethod(rendererMainSrc, 'getDefaultKeybindings'));
    check('renderer/js/main.js 的 getDefaultKeybindings 抽出来真跑得到 22 键',
        !!extracted && Object.keys(extracted()).length === 22,
        extracted ? String(Object.keys(extracted()).length) : '抽取失败');

    const emptyCtx = compileMethod(vm.createContext({
        window: {},
        Object, String, Array, JSON, Map, Set
    }), classMethod(rendererMainSrc, 'getDefaultKeybindings'));
    const degraded = emptyCtx ? emptyCtx() : null;
    check('模块缺席时退化成空表（宁可少显示，也不许在别处再猜一份）',
        !!degraded && Object.keys(degraded).length === 0, JSON.stringify(degraded));

    for (const rel of [
        path.join('src', 'renderer', 'js', 'main.ts'),
        path.join('src', 'renderer', 'js', 'monaco-editor-manager.ts'),
        path.join('src', 'renderer', 'settings', 'editor.ts')
    ]) {
        const src = read(rel);
        check(`消费者走 window.oicppKeybindings：${rel}`,
            /window\.oicppKeybindings\?\./.test(src));
    }
}

// ---------------------------------------------------------------------------
// 5. 接线与形态约束（AGENTS 里那条「浏览器 script 标签下不能有 import/export」）
// ---------------------------------------------------------------------------
{
    const moduleSrc = read(path.join('src', 'utils', 'keybindings.ts'));
    check('keybindings.ts 保持全局 script 形态（无顶层 import/export，否则 <script> 下直接炸）',
        !/^import\s/m.test(moduleSrc) && !/^export\s/m.test(moduleSrc)
            && /module\.exports = factory\(\)/.test(moduleSrc));

    const indexHtml = read(path.join('src', 'renderer', 'index.html'));
    const at = (needle) => indexHtml.indexOf(needle);
    check('index.html 在 monaco-editor-manager.js 之前加载 keybindings.js',
        at('utils/keybindings.js') > -1 && at('js/monaco-editor-manager.js') > at('utils/keybindings.js'),
        `${at('utils/keybindings.js')} / ${at('js/monaco-editor-manager.js')}`);
    check('index.html 在 js/main.js 之前加载 keybindings.js',
        at('src="js/main.js"') > at('utils/keybindings.js'),
        `${at('utils/keybindings.js')} / ${at('src="js/main.js"')}`);

    const editorHtml = read(path.join('src', 'renderer', 'settings', 'editor.html'));
    check('settings/editor.html 在 editor.js 之前加载 keybindings.js',
        editorHtml.indexOf('utils/keybindings.js') > -1
            && editorHtml.indexOf('utils/keybindings.js') < editorHtml.indexOf('<script src="editor.js">'));
}

// ---------------------------------------------------------------------------
// 6. 固定 accelerator（不可改键那批）也是单一来源
// ---------------------------------------------------------------------------
{
    check('menuAccelerator 取到值，未知 id 返回空串而不是 undefined',
        kb.menuAccelerator('new-file') === 'CmdOrCtrl+N' && kb.menuAccelerator('no-such-action') === '',
        kb.menuAccelerator('new-file'));

    const mainSrc = read(path.join('src', 'main.ts'));
    const inlineAccel = mainSrc.match(/accelerator:\s*'/g) || [];
    check('src/main.ts 的菜单模板里不再有内联 accelerator 字面量',
        inlineAccel.length === 0, `${inlineAccel.length} 处残留`);

    const usedIds = [...mainSrc.matchAll(/menuAccelerator\('([^']+)'\)/g)].map((m) => m[1]);
    const mapIds = Object.keys(kb.MENU_ACCELERATORS);
    const unknown = usedIds.filter((id) => !mapIds.includes(id));
    check(`主进程用到的 ${usedIds.length} 个 accelerator id 全在表里`,
        usedIds.length >= 16 && unknown.length === 0, `未知: ${unknown.join(',')}`);
    // 表里也不许有没人读的条目 —— 否则哪天它和主进程各自演化，又是一处隐性双写
    const dead = mapIds.filter((id) => !usedIds.includes(id));
    check('MENU_ACCELERATORS 没有没人读的条目', dead.length === 0, `死条目: ${dead.join(',')}`);

    // 自证：把内联字面量加回主进程，上面那条正则必须抓得住
    check('自证：残留 accelerator 字面量的正则确实抓得到',
        /accelerator:\s*'/.test("                    accelerator: 'CmdOrCtrl+N',"));

    // HTML 侧：每个 span 必须**自己声明**值的来源，且声明的东西存在
    const indexHtml = read(path.join('src', 'renderer', 'index.html'));
    const spans = [...indexHtml.matchAll(/<span class="menu-shortcut"([^>]*)>([^<]*)<\/span>/g)];
    check('13 个菜单提示 span 全都在（数量对得上才继续谈来源）',
        spans.length === 13, String(spans.length));
    const defaults = kb.defaultKeybindings('windows');
    const orphans = [];
    for (const m of spans) {
        const attrs = m[1];
        const kbKey = (/data-keybinding="([^"]+)"/.exec(attrs) || [])[1];
        const accel = (/data-accel="([^"]+)"/.exec(attrs) || [])[1];
        if (kbKey && accel) { orphans.push(`两个来源都声明: ${kbKey}/${accel}`); continue; }
        if (!kbKey && !accel) { orphans.push(`没声明来源（回到手抄字面量）: ${m[2]}`); continue; }
        if (kbKey && !(kbKey in defaults)) orphans.push(`data-keybinding 不在默认表里: ${kbKey}`);
        if (accel && !mapIds.includes(accel)) orphans.push(`data-accel 不在 accelerator 表里: ${accel}`);
    }
    check('每个 span 恰好声明一个来源，且该来源真的存在', orphans.length === 0, orphans.join(' | '));

    // span 的静态文字只是 JS 起来前的默认值，但它必须等于当前来源的值 ——
    // 否则「JS 没跑成」的时候用户看到的就是一条错的键（这条正是以前 6 个冻结 span 的处境）
    const wrongDefault = [];
    for (const m of spans) {
        const attrs = m[1];
        const shown = m[2].trim();
        const kbKey = (/data-keybinding="([^"]+)"/.exec(attrs) || [])[1];
        const accel = (/data-accel="([^"]+)"/.exec(attrs) || [])[1];
        const want = kbKey ? defaults[kbKey] : kb.menuAccelerator(accel);
        // accelerator 表用的是 CmdOrCtrl 写法，HTML 里抄的是 Ctrl 写法，这两者在本仓等价
        const normalized = String(want).replace(/^CmdOrCtrl\+/, 'Ctrl+');
        if (shown !== normalized) wrongDefault.push(`${shown} ≠ ${normalized}`);
    }
    check('span 的静态默认值与其声明来源一致（JS 没跑时也不撒谎）',
        wrongDefault.length === 0, wrongDefault.join(' | '));
}

console.log(`keybindings-single-source tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
