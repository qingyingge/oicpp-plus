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
 * 本模块放**事实**（平台、默认值、schema、固定 accelerator）加上把它们**渲染成人看的写法**
 * 的那一层（formatShortcutLabel / formattedComboFor）。顺序按 Apple HIG（⌃⌥⇧⌘）而不是
 * VS Code（它按 ctrl→shift→alt→meta，会拼出 ⌘⇧S）—— 这条选择由测试用整串断言钉住，
 * 别把它当成随手写错。为什么不 vendor 上游实现：那个文件 184 行里含 4 个 provider
 * 与 3 个依赖（Modifiers / OperatingSystem / nls），而它的输入是「已解析的 modifiers」，
 * 我们的存储是 accelerator 字符串，仍要自己写一层适配。
 *
 * ⚠️ 本文件必须保持「双环境全局 script」形态（同 src/utils/clang-format-options.ts）：
 * 不能出现 import/export，否则 module: commonjs 会编成带 exports 引用的模块，
 * <script> 标签下直接炸。类型标注只写在完全擦除的位置。
 */

(function (root: object, factory: () => unknown) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        (root as { oicppKeybindings: unknown }).oicppKeybindings = factory();
    }
})(typeof self !== 'undefined' ? self : this as object, function () {
    'use strict';

    type OicppPlatform = 'mac' | 'windows' | 'linux' | 'other';

    interface KeybindingDef {
        key: string;
        /** 设置页那条的 i18n 键；null 表示这个键不在设置页出现（不可改）。 */
        labelKey: string | null;
        /** 非 mac 的默认组合键。 */
        combo: string;
        /** 只有 mac 与其余平台不同时才写。 */
        macCombo?: string;
    }

    const DEFS: KeybindingDef[] = [
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
    function defaultKeybindings(platform?: OicppPlatform): Record<string, string> {
        const onMac = isMacPlatform(platform);
        const out: Record<string, string> = {};
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
            .map((def) => ({ key: def.key, labelKey: def.labelKey as string }));
    }

    function editableKeybindingKeys(): string[] {
        return keybindingSchema().map((entry) => entry.key);
    }

    function resolvePlatform(raw: unknown): OicppPlatform {
        const p = String(raw === undefined || raw === null ? '' : raw).toLowerCase();
        if (p.includes('darwin') || p.includes('mac')) return 'mac';
        if (p.includes('win')) return 'windows';
        if (p.includes('linux')) return 'linux';
        return 'other';
    }

    // 测试注入点：本仓的 CI 跑在 linux，mac 分支只能靠显式注入才能被真跑覆盖
    // （否则「mac 上显示什么」这类断言在这里永远只是字面量比较）。
    let overridePlatform: OicppPlatform | null = null;
    function setPlatformOverride(platform: OicppPlatform | null): void {
        overridePlatform = platform;
    }

    function rawPlatform(): string {
        if (overridePlatform !== null) return overridePlatform;
        try {
            const injected = (typeof self !== 'undefined'
                ? (self as unknown as { process?: { platform?: string } }).process
                : undefined);
            if (injected && typeof injected.platform === 'string') return injected.platform;
        } catch (_) { /* 渲染层没挂 process 时退回下面的 Node 读法 */ }
        try {
            // Node（主进程/preload）里 process.platform 是权威值；渲染层由 preload 挂到 window.process
            return process.platform;
        } catch (_) {
            return '';
        }
    }

    function currentPlatform(): OicppPlatform {
        return resolvePlatform(rawPlatform());
    }

    function isMacPlatform(platform?: OicppPlatform): boolean {
        return (platform === undefined ? currentPlatform() : platform) === 'mac';
    }

    // 固定快捷键：这些动作**不在设置页里**（不可改键），所以它们不属于 DEFS。
    // 但它们的组合键以前只写在主进程的菜单模板里（accelerator: 'CmdOrCtrl+N' 这类内联字面量），
    // 于是自绘菜单无处取值 —— 只能在 index.html 里手抄成
    // <span class="menu-shortcut">Ctrl+N</span>，那 6 个永远不跟平台也不跟设置走的 span 就是这么来的。
    // id 用 data-action 那套 kebab 命名，让 HTML 与主进程共用一个词表（两套 id 词汇本身就是漂移点）。
    const MENU_ACCELERATORS: Record<string, string> = {
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

    function menuAccelerator(actionId: string): string {
        return MENU_ACCELERATORS[actionId] ?? '';
    }

    // 既不在菜单里、也不可改键的内置绑定。以前它只存在于 quick-open.ts 那句
    // `(e.ctrlKey || e.metaKey) && e.key === 'p'` 里，于是「搜索文件 (Ctrl+P)」这句文案
    // 是手抄的 —— 抄的代价正是这次要修的：mac 上它是 ⌘P，而文案永远写 Ctrl+P。
    // 现在显示与行为都从这一条走（quick-open.ts 的监听处有注释指回来）。
    const BUILTIN_ACCELERATORS: Record<string, string> = {
        quickOpen: 'Ctrl+P'
    };

    function builtinAccelerator(actionId: string): string {
        return BUILTIN_ACCELERATORS[actionId] ?? '';
    }

    // 用户在设置页改过的键，这个模块自己不知道 —— 由宿主（renderer/js/main.ts）注入一个取值函数。
    // 这样依赖方向是单向的：keybindings 不认得 settings 的形状，也不反向依赖 app 实例。
    let userComboSource: ((key: string) => string) | null = null;
    function setUserComboSource(resolver: ((key: string) => string) | null): void {
        userComboSource = resolver;
    }

    // 「这个 label 该显示哪个组合键」的来源描述，写在 HTML 的 data-i18n-args 里，
    // 形如 "keybinding:compileAndRun" / "accel:save-file" / "builtin:quickOpen"。
    // 用字符串而不是对象，是因为它要能原样待在 HTML 属性里；解析失败一律返回空串（宁可少显示）。
    function rawComboFor(source: string): string {
        const hit = /^([a-z]+):(.+)$/.exec(String(source || '').trim());
        if (!hit) return '';
        const kind = hit[1] as string;
        const id = hit[2] as string;
        if (kind === 'keybinding') {
            const fromUser = userComboSource ? String(userComboSource(id) || '').trim() : '';
            if (fromUser) return fromUser;
            return defaultKeybindings()[id] || '';
        }
        if (kind === 'accel') return menuAccelerator(id);
        if (kind === 'builtin') return builtinAccelerator(id);
        return '';
    }

    function formattedComboFor(source: string, platform?: OicppPlatform): string {
        return formatShortcutLabel(rawComboFor(source), platform);
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
    const MODIFIER_TOKENS: Record<string, 'primary' | 'command' | 'shift' | 'alt'> = {
        ctrl: 'primary', control: 'primary',
        cmdorctrl: 'primary', commandorcontrol: 'primary',
        cmd: 'command', command: 'command', meta: 'command', super: 'command',
        shift: 'shift',
        alt: 'alt', option: 'alt'
    };

    // 显式四个槽，不用 Record 查表 —— 索引签名在 noUncheckedIndexedAccess 下会给出
    // string | undefined，逼得这里到处 ?? ，反而看不出「槽一定是这四个」这个真事实。
    interface ShortcutModifierLabels {
        control: string;
        alt: string;
        shift: string;
        command: string;
    }

    const MAC_LABELS: ShortcutModifierLabels = { control: '⌃', alt: '⌥', shift: '⇧', command: '⌘' };
    // Windows 上 Super 是 Win 键，Linux 上是 Super；本机没有的这两个键位不参与本仓组合键。
    const WINDOWS_LABELS: ShortcutModifierLabels = { control: 'Ctrl', alt: 'Alt', shift: 'Shift', command: 'Win' };
    const LINUX_LABELS: ShortcutModifierLabels = { control: 'Ctrl', alt: 'Alt', shift: 'Shift', command: 'Super' };

    // Apple 的展示顺序；非 mac 沿用同一条（Ctrl+Alt+Shift 也是 Windows 应用里少争议那条）
    const MODIFIER_SLOTS: Array<keyof ShortcutModifierLabels> = ['control', 'alt', 'shift', 'command'];

    // mac 上这几个键有公认符号；非 mac 保持原写法，免得把 `Ctrl+Shift+Up` 无缘无故改成 ↑
    const MAC_KEY_SYMBOLS: Record<string, string> = {
        up: '↑', down: '↓', left: '←', right: '→',
        enter: '↩', return: '↩', escape: '⎋', esc: '⎋',
        space: '␣', tab: '⇥', backspace: '⌫', delete: '⌦'
    };

    function formatShortcutLabel(combo: string, platform?: OicppPlatform): string {
        const source = String(combo || '').trim();
        if (!source) return '';
        const os = platform ?? currentPlatform();
        const onMac = os === 'mac';
        const labels = onMac ? MAC_LABELS : (os === 'windows' ? WINDOWS_LABELS : LINUX_LABELS);

        // 只有主键能含 '+' 以外的东西；分隔符就是 '+'，所以 'Plus' 这个键名要写全，
        // 表里目前没有它 —— 真加的时候这里要特判，不然 'CmdOrCtrl++' 会被切成空 token。
        const tokens = source.split('+').map((t) => t.trim()).filter((t) => t !== '');
        if (tokens.length === 0) return '';

        const taken: Record<string, boolean> = {};
        let keyToken = '';
        for (const token of tokens) {
            const kind = MODIFIER_TOKENS[token.toLowerCase()];
            if (kind === undefined) { keyToken = token; continue; }
            const slot = kind === 'primary' ? (onMac ? 'command' : 'control') : kind;
            taken[slot] = true;
        }

        const pieces: string[] = [];
        for (const slot of MODIFIER_SLOTS) {
            if (taken[slot]) pieces.push(labels[slot]);
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
        BUILTIN_ACCELERATORS,
        builtinAccelerator,
        currentPlatform,
        defaultKeybindings,
        editableKeybindingKeys,
        formatShortcutLabel,
        formattedComboFor,
        isMacPlatform,
        keybindingSchema,
        menuAccelerator,
        rawComboFor,
        rawPlatform,
        resolvePlatform,
        setPlatformOverride,
        setUserComboSource
    };
});
