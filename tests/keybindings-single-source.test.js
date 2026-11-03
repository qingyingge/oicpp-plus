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

    // span 的静态文字只是 JS 起来前的默认值，但它必须等于「格式化之后的非 mac 显示」——
    // 否则 JS 没跑成时用户看到的就是一条错的键（这正是以前 6 个冻结 span 的处境）。
    // 一份静态 HTML 不认得自己的 OS，所以 mac 用户在 JS 跑起来前会短暂看到 Ctrl 写法：
    // 这是有意接受的取舍，比 JS 挂掉时满屏假键好，而 JS 起来之后由上面那条 13/13 有来源兜住。
    const wrongDefault = [];
    for (const m of spans) {
        const attrs = m[1];
        const shown = m[2].trim();
        const kbKey = (/data-keybinding="([^"]+)"/.exec(attrs) || [])[1];
        const accel = (/data-accel="([^"]+)"/.exec(attrs) || [])[1];
        const raw = kbKey ? defaults[kbKey] : kb.menuAccelerator(accel);
        const want = kb.formatShortcutLabel(String(raw), 'linux');
        if (shown !== want) wrongDefault.push(`${shown} ≠ ${want}`);
    }
    check('span 的静态默认值等于格式化后的非 mac 显示（JS 没跑时也不撒谎）',
        wrongDefault.length === 0, wrongDefault.join(' | '));
}

// ---------------------------------------------------------------------------
// 7. 平台化显示（Apple HIG 顺序 ⌃⌥⇧⌘，Command 在最后）
// ---------------------------------------------------------------------------
{
    const f = kb.formatShortcutLabel;
    // 这条顺序是**有意选 Apple 而不是选 VS Code**：上游按 ctrl→shift→alt→meta 会拼出 ⌘⇧S，
    // HIG 是 ⌃⌥⇧⌘ 即 ⇧⌘S。断言写成整串而不是「包含」，哪天有人顺手改回上游形状就会红。
    check('mac 按 HIG 顺序：CmdOrCtrl+Shift+S → ⇧⌘S（不是 VS Code 的 ⌘⇧S）',
        f('CmdOrCtrl+Shift+S', 'mac') === '⇧⌘S', f('CmdOrCtrl+Shift+S', 'mac'));
    check('mac 上 ⌥ 排在 ⇧ 前：Alt+Shift+S → ⌥⇧S', f('Alt+Shift+S', 'mac') === '⌥⇧S', f('Alt+Shift+S', 'mac'));
    check('非 mac 保持原写法：CmdOrCtrl+Shift+S → Ctrl+Shift+S',
        f('CmdOrCtrl+Shift+S', 'windows') === 'Ctrl+Shift+S' && f('CmdOrCtrl+Shift+S', 'linux') === 'Ctrl+Shift+S');
    check('mac 的 label 里没有 \'+\' 连接符，非 mac 有',
        !f('CmdOrCtrl+Shift+S', 'mac').includes('+') && f('CmdOrCtrl+Shift+S', 'windows').includes('+'));
    check('主修饰键在 mac 落 ⌘：Ctrl+F11 → ⌘F11（本仓 Ctrl 的语义就是主修饰键）',
        f('Ctrl+F11', 'mac') === '⌘F11', f('Ctrl+F11', 'mac'));
    check('方向键只在 mac 用符号，非 mac 不许无故改文字：Ctrl+Shift+Up',
        f('Ctrl+Shift+Up', 'mac') === '⇧⌘↑' && f('Ctrl+Shift+Up', 'windows') === 'Ctrl+Shift+Up',
        `${f('Ctrl+Shift+Up', 'mac')} / ${f('Ctrl+Shift+Up', 'windows')}`);
    check('裸功能键各平台原样：F11 / Shift+F8',
        f('F11', 'mac') === 'F11' && f('Shift+F8', 'mac') === '⇧F8' && f('Shift+F8', 'windows') === 'Shift+F8');
    check('未知键名透传，不猜：CmdOrCtrl+PrintScreen',
        f('CmdOrCtrl+PrintScreen', 'mac') === '⌘PrintScreen', f('CmdOrCtrl+PrintScreen', 'mac'));
    check('空串进空串出', f('', 'mac') === '' && f('   ', 'windows') === '');

    // 通用不变量：表里每一个值，mac 显示里都不许出现 "Ctrl" ——
    // 出现就说明那条被当成了物理 Control，而本仓的匹配层其实接受 ⌘，显示就是谎话。
    const allCombos = Object.values(kb.MENU_ACCELERATORS)
        .concat(Object.values(kb.defaultKeybindings('mac')))
        .concat(Object.values(kb.defaultKeybindings('windows')));
    const lyingMac = allCombos.filter((c) => /Ctrl/.test(f(c, 'mac')));
    check(`${allCombos.length} 个组合键在 mac 显示里都不含 "Ctrl"`,
        lyingMac.length === 0, lyingMac.join(' | '));
    // 反向不变量：非 mac 都不该出现符号（Windows 用户看到 ⌘ 才是真出错）
    const lyingOther = allCombos.filter((c) => /[⌘⌥⇧⌃]/.test(f(c, 'windows')));
    check('非 mac 显示里不含任何 mac 符号', lyingOther.length === 0, lyingOther.join(' | '));

    // 不传 platform 时走 currentPlatform（注入点让这条在 linux CI 上也能真跑）
    const before = kb.currentPlatform();
    kb.setPlatformOverride('mac');
    check('缺省 platform 参数时用 currentPlatform()（注入 mac → ⌘N）',
        f('CmdOrCtrl+N') === '⌘N', f('CmdOrCtrl+N'));
    kb.setPlatformOverride(null);
    check('还原注入后回到宿主平台显示', f('CmdOrCtrl+N') !== '⌘N' || before === 'mac', String(kb.currentPlatform()));
}

// ---------------------------------------------------------------------------
// 8. 键名的来源引用，以及「语言包里不许再焊组合键」
// ---------------------------------------------------------------------------
{
    check('builtin:quickOpen 取到值并格式化',
        kb.rawComboFor('builtin:quickOpen') === 'Ctrl+P'
            && kb.formattedComboFor('builtin:quickOpen', 'mac') === '⌘P'
            && kb.formattedComboFor('builtin:quickOpen', 'windows') === 'Ctrl+P',
        kb.formattedComboFor('builtin:quickOpen', 'mac'));
    check('来源写法非法时返回空串，不把猜测值印上界面',
        kb.rawComboFor('nope:x') === '' && kb.rawComboFor('') === '' && kb.rawComboFor('builtin:不存在') === '',
        JSON.stringify([kb.rawComboFor('nope:x'), kb.rawComboFor('')]));
    // accel / keybinding 两种来源也要能过同一个入口（HTML 的 @shortcut: 靠它）
    check('accel: 与 keybinding: 来源都解析得到',
        kb.rawComboFor('accel:save-file') === 'CmdOrCtrl+S' && kb.rawComboFor('keybinding:openTerminal') === 'Ctrl+`',
        `${kb.rawComboFor('accel:save-file')} / ${kb.rawComboFor('keybinding:openTerminal')}`);

    // quick-open.ts 的监听就是 Ctrl+P 的事实本体，表必须和它说同一件事
    {
        const qo = read(path.join('src', 'renderer', 'js', 'quick-open.ts'));
        const listener = /\(e\.ctrlKey \|\| e\.metaKey\)\s*&&\s*\(e\.key === 'p' \|\| e\.key === 'P'\)/.test(qo);
        check('quick-open.ts 的主修饰键 + P 监听仍在，与 BUILTIN_ACCELERATORS.quickOpen 一致',
            listener && kb.BUILTIN_ACCELERATORS.quickOpen === 'Ctrl+P', String(listener));
    }

    // 用户改过键之后显示必须跟着变（宿主注入的取值函数），且清空后回落到默认表
    {
        const before = kb.rawComboFor('keybinding:compileAndRun');
        kb.setUserComboSource((key) => (key === 'compileAndRun' ? 'Ctrl+Shift+F12' : ''));
        const injected = kb.rawComboFor('keybinding:compileAndRun');
        kb.setUserComboSource(null);
        const after = kb.rawComboFor('keybinding:compileAndRun');
        check('注入的用户改键优先，撤掉后回落到默认表',
            injected === 'Ctrl+Shift+F12' && after === before, `${injected} → ${after}`);
    }

    // 语言包 ratchet：文案里不许再出现焊死的组合键 —— 显示要随平台/改键变，就只能走 {keys}。
    // 这条一上线就抓到 10 处（5 处在我原本的清单里，另外 5 处是调试工具条那批没人数的）。
    const MODIFIER_RE = /(?:Ctrl|Cmd|Command|Alt|Option|Shift|Super)\s*\+/;
    const BARE_F_RE = /\(\s*(?:[A-Za-z]+\+)?F(?:[1-9]|1[0-2])\s*\)/;
    for (const code of ['zh-cn', 'en']) {
        const pack = JSON.parse(read(path.join('src', 'lang', `${code}.json`)));
        const flat = {};
        (function walk(obj, prefix) {
            for (const [k, v] of Object.entries(obj)) {
                const key = prefix ? `${prefix}.${k}` : k;
                if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, key); else flat[key] = String(v);
            }
        })(pack, '');
        const welded = Object.entries(flat).filter(([, v]) => MODIFIER_RE.test(v) || BARE_F_RE.test(v));
        check(`${code}.json 里没有焊死的组合键（要显示键名就走 {keys} + @shortcut: 引用）`,
            welded.length === 0, welded.map(([k, v]) => `${k}=${v.slice(0, 40)}`).join(' | '));
    }
    // 自证：上面那条不是恒真 —— 把 F6 焊回文案必须被抓出来
    check('自证：焊死键名的正则抓得住「继续执行 (F6)」和「按 Ctrl+Shift+I」',
        BARE_F_RE.test('继续执行 (F6)') && MODIFIER_RE.test('按 Ctrl+Shift+I 打开开发者工具'));
}

console.log(`keybindings-single-source tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
