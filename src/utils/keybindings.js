'use strict';
/**
 * 快捷键的单一来源：平台判定 + 默认组合键表 + 可改键 schema。
 *
 * 为什么要有这个文件（都从 git 历史里来）：
 *   · 默认组合键表曾被抄成 **4 份**：renderer/js/main.ts（0291982 #235 那次修 bug 时新增）、
 *     renderer/js/monaco-editor-manager.ts 与 renderer/settings/editor.ts（8054ef5「新增自定义快捷键」）、
 *     以及 src/main.ts 里那份内联的默认 settings。逐字段比过，22 个键里只有
 *     compileAndRun / runAllSamples 按平台分叉，其余 20 个四处完全相同 —— 即纯冗余。
 *   · 平台判定在 48b2065「适配 macOS」这一笔里一次长出 4 份写法（IIFE、缓存方法、
 *     detectMacPlatform、主进程 process.platform），此后渲染层里 `window.process.platform`
 *     的散装嗅探累积到 20+ 处。
 *   · 全历史 `git log -G'⌘'` **零命中**：mac 适配只走到「哪个键生效」，从来没走到「屏幕怎么写」。
 *     于是 mac 用户看到「Ctrl+F11」而实际按 ⌘F11 才触发 —— 组合键匹配用的是
 *     `ctrlOrCmd`（monaco-editor-manager.ts:4302 `!!(event.ctrlKey || event.metaKey)`），
 *     存的 `Ctrl` 语义是「主修饰键」，等价于 Electron accelerator 的 `CmdOrCtrl`。
 *
 * 本模块只放**事实**（平台、默认值、schema），不放显示格式化 —— accelerator→label 的
 * 跨平台写法是规范知识（mac 的修饰键顺序 ⌃⌥⇧⌘、符号间不加 `+`），该复用上游实现而不是
 * 在这里另立一套，那一步单独做。
 *
 * ⚠️ 本文件必须保持「双环境全局 script」形态（同 src/utils/clang-format-options.ts）：
 * 不能出现 import/export，否则 module: commonjs 会编成带 exports 引用的模块，
 * <script> 标签下直接炸。类型标注只写在完全擦除的位置。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    }
    else {
        root.oicppKeybindings = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const DEFS = [
        { key: 'formatCode', labelKey: 'keybinding.formatCode', combo: 'Alt+Shift+S' },
        { key: 'showFunctionPicker', labelKey: 'keybinding.showFunctionPicker', combo: 'Ctrl+Shift+G' },
        { key: 'markdownPreview', labelKey: 'keybinding.markdownPreview', combo: 'Ctrl+Shift+V' },
        { key: 'renameSymbol', labelKey: 'keybinding.renameSymbol', combo: 'F2' },
        { key: 'deleteLine', labelKey: 'keybinding.deleteLine', combo: 'Ctrl+D' },
        { key: 'duplicateLine', labelKey: 'keybinding.duplicateLine', combo: 'Ctrl+E' },
        { key: 'moveLineUp', labelKey: 'keybinding.moveLineUp', combo: 'Ctrl+Shift+Up' },
        { key: 'moveLineDown', labelKey: 'keybinding.moveLineDown', combo: 'Ctrl+Shift+Down' },
        { key: 'compileCode', labelKey: 'keybinding.compileCode', combo: 'F9' },
        { key: 'runCode', labelKey: 'keybinding.runCode', combo: 'F10' },
        // mac 的 F11 是全屏，所以这两个键在 mac 上让路；其余平台 F11 直接可用。
        { key: 'compileAndRun', labelKey: 'keybinding.compileAndRun', combo: 'F11', macCombo: 'Ctrl+F11' },
        { key: 'toggleDebug', labelKey: 'keybinding.toggleDebug', combo: 'F5' },
        { key: 'debugContinue', labelKey: 'keybinding.debugContinue', combo: 'F6' },
        { key: 'debugStepOver', labelKey: 'keybinding.debugStepOver', combo: 'F7' },
        { key: 'debugStepInto', labelKey: 'keybinding.debugStepInto', combo: 'F8' },
        { key: 'debugStepOut', labelKey: 'keybinding.debugStepOut', combo: 'Shift+F8' },
        { key: 'cloudCompile', labelKey: 'keybinding.cloudCompile', combo: 'F12' },
        { key: 'openTerminal', labelKey: 'keybinding.openTerminal', combo: 'Ctrl+`' },
        { key: 'runAllSamples', labelKey: 'keybinding.runAllSamples', combo: 'Ctrl+F11', macCombo: 'Ctrl+Shift+F11' },
        // 这三条只是被设置页的默认对象兜着（历史上一直没人读它们），所以没有 labelKey。
        { key: 'copy', labelKey: null, combo: 'Ctrl+C' },
        { key: 'paste', labelKey: null, combo: 'Ctrl+V' },
        { key: 'cut', labelKey: null, combo: 'Ctrl+X' }
    ];
    // 一个平台一条默认值，别再写第四遍 isMac ? ... : ...
    function defaultKeybindings(platform) {
        const onMac = isMacPlatform(platform);
        const out = {};
        for (const def of DEFS) {
            out[def.key] = onMac && def.macCombo !== undefined ? def.macCombo : def.combo;
        }
        return out;
    }
    // 设置页的 schema 与「可改键列表」以前是两份 19 项的清单（内容完全一致，
    // 加一个键要改两处，漏一处就是设置页能改而菜单提示不跟着变的又一个 #235）。
    // 现在都由 labelKey 派生。
    function keybindingSchema() {
        return DEFS.filter((def) => def.labelKey !== null)
            .map((def) => ({ key: def.key, labelKey: def.labelKey }));
    }
    function editableKeybindingKeys() {
        return keybindingSchema().map((entry) => entry.key);
    }
    function resolvePlatform(raw) {
        const p = String(raw === undefined || raw === null ? '' : raw).toLowerCase();
        if (p.includes('darwin') || p.includes('mac'))
            return 'mac';
        if (p.includes('win'))
            return 'windows';
        if (p.includes('linux'))
            return 'linux';
        return 'other';
    }
    // 测试注入点：本仓的 CI 跑在 linux，mac 分支只能靠显式注入才能被真跑覆盖
    // （否则「mac 上显示什么」这类断言在这里永远只是字面量比较）。
    let overridePlatform = null;
    function setPlatformOverride(platform) {
        overridePlatform = platform;
    }
    function rawPlatform() {
        if (overridePlatform !== null)
            return overridePlatform;
        try {
            const injected = (typeof self !== 'undefined'
                ? self.process
                : undefined);
            if (injected && typeof injected.platform === 'string')
                return injected.platform;
        }
        catch (_) { /* 渲染层没挂 process 时退回下面的 Node 读法 */ }
        try {
            // Node（主进程/preload）里 process.platform 是权威值；渲染层由 preload 挂到 window.process
            return process.platform;
        }
        catch (_) {
            return '';
        }
    }
    function currentPlatform() {
        return resolvePlatform(rawPlatform());
    }
    function isMacPlatform(platform) {
        return (platform === undefined ? currentPlatform() : platform) === 'mac';
    }
    // 固定快捷键：这些动作**不在设置页里**（不可改键），所以它们不属于 DEFS。
    // 但它们的组合键以前只写在主进程的菜单模板里（accelerator: 'CmdOrCtrl+N' 这类内联字面量），
    // 于是自绘菜单无处取值 —— 只能在 index.html 里手抄成
    // <span class="menu-shortcut">Ctrl+N</span>，那 6 个永远不跟平台也不跟设置走的 span 就是这么来的。
    // id 用 data-action 那套 kebab 命名，让 HTML 与主进程共用一个词表（两套 id 词汇本身就是漂移点）。
    const MENU_ACCELERATORS = {
        'new-file': 'CmdOrCtrl+N',
        'new-temp-file': 'CmdOrCtrl+Shift+N',
        'open-file': 'CmdOrCtrl+O',
        'open-folder': 'CmdOrCtrl+K',
        'save-file': 'CmdOrCtrl+S',
        'save-as': 'CmdOrCtrl+Shift+S',
        'options': 'CmdOrCtrl+,',
        'template-settings': 'CmdOrCtrl+T',
        // 下面 6 条挂的是 role，Electron 本来也会给默认键；写出来是为了「一处说清」而不是留着各抄一遍。
        'undo': 'CmdOrCtrl+Z',
        'redo': 'CmdOrCtrl+Shift+Z',
        'cut': 'CmdOrCtrl+X',
        'copy': 'CmdOrCtrl+C',
        'paste': 'CmdOrCtrl+V',
        'select-all': 'CmdOrCtrl+A',
        'open-browser': 'CmdOrCtrl+Shift+I',
        'new-browser-tab': 'CmdOrCtrl+Shift+B'
    };
    function menuAccelerator(actionId) {
        return MENU_ACCELERATORS[actionId] ?? '';
    }
    // ---- accelerator → 按平台显示的 label ----------------------------------------
    //
    // 修饰键的**显示顺序按 Apple HIG**：⌃ ⌥ ⇧ ⌘（Control、Option、Shift、Command），
    // 符号之间不加连接符，所以 macOS 的 Cmd+Shift+S 写成 `⇧⌘S`（Command 在最后）。
    // 注意 VS Code 用的不是这个顺序（它按 ctrl→shift→alt→meta，会拼出 `⌘⇧S`）——
    // 这里有意选 HIG 而不是选上游，因为本项目显示的是系统菜单里的同一批键。
    //
    // 语义前提（本仓的事实，不是通用规则）：存的 `Ctrl` 是**主修饰键**，不是物理 Control ——
    // 匹配走 monaco-editor-manager.ts 的 ctrlOrCmd（`event.ctrlKey || event.metaKey`），
    // 等价于 Electron accelerator 的 `CmdOrCtrl`。所以 mac 上必须显示 ⌘，
    // 显示 `Ctrl+` 就是谎话：按 ⌘ 有效、按 ⌃ 也有效，但屏幕上写的是「按 Control」。
    // 物理 Control 目前**无法表达**（没有对应 token），因此 mac 侧的 ⌃ 槽实际永远不会出现，
    // 等改键支持录进「物理 Control」时再补，顺序位已经留好了。
    const MODIFIER_TOKENS = {
        ctrl: 'primary', control: 'primary',
        cmdorctrl: 'primary', commandorcontrol: 'primary',
        cmd: 'command', command: 'command', meta: 'command', super: 'command',
        shift: 'shift',
        alt: 'alt', option: 'alt'
    };
    const MAC_LABELS = { control: '⌃', alt: '⌥', shift: '⇧', command: '⌘' };
    // Windows 上 Super 是 Win 键，Linux 上是 Super；本机没有的这两个键位不参与本仓组合键。
    const WINDOWS_LABELS = { control: 'Ctrl', alt: 'Alt', shift: 'Shift', command: 'Win' };
    const LINUX_LABELS = { control: 'Ctrl', alt: 'Alt', shift: 'Shift', command: 'Super' };
    // Apple 的展示顺序；非 mac 沿用同一条（Ctrl+Alt+Shift 也是 Windows 应用里少争议那条）
    const MODIFIER_SLOTS = ['control', 'alt', 'shift', 'command'];
    // mac 上这几个键有公认符号；非 mac 保持原写法，免得把 `Ctrl+Shift+Up` 无缘无故改成 ↑
    const MAC_KEY_SYMBOLS = {
        up: '↑', down: '↓', left: '←', right: '→',
        enter: '↩', return: '↩', escape: '⎋', esc: '⎋',
        space: '␣', tab: '⇥', backspace: '⌫', delete: '⌦'
    };
    function formatShortcutLabel(combo, platform) {
        const source = String(combo || '').trim();
        if (!source)
            return '';
        const os = platform ?? currentPlatform();
        const onMac = os === 'mac';
        const labels = onMac ? MAC_LABELS : (os === 'windows' ? WINDOWS_LABELS : LINUX_LABELS);
        // 只有主键能含 '+' 以外的东西；分隔符就是 '+'，所以 'Plus' 这个键名要写全，
        // 表里目前没有它 —— 真加的时候这里要特判，不然 'CmdOrCtrl++' 会被切成空 token。
        const tokens = source.split('+').map((t) => t.trim()).filter((t) => t !== '');
        if (tokens.length === 0)
            return '';
        const taken = {};
        let keyToken = '';
        for (const token of tokens) {
            const kind = MODIFIER_TOKENS[token.toLowerCase()];
            if (kind === undefined) {
                keyToken = token;
                continue;
            }
            const slot = kind === 'primary' ? (onMac ? 'command' : 'control') : kind;
            taken[slot] = true;
        }
        const pieces = [];
        for (const slot of MODIFIER_SLOTS) {
            if (taken[slot])
                pieces.push(labels[slot]);
        }
        if (keyToken) {
            const key = onMac
                ? (MAC_KEY_SYMBOLS[keyToken.toLowerCase()] ?? keyToken)
                : keyToken;
            pieces.push(key);
        }
        return pieces.join(onMac ? '' : '+');
    }
    return {
        DEFS,
        MENU_ACCELERATORS,
        currentPlatform,
        defaultKeybindings,
        editableKeybindingKeys,
        formatShortcutLabel,
        isMacPlatform,
        keybindingSchema,
        menuAccelerator,
        rawPlatform,
        resolvePlatform,
        setPlatformOverride
    };
});
