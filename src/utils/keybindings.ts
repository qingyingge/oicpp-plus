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

    return {
        DEFS,
        currentPlatform,
        defaultKeybindings,
        editableKeybindingKeys,
        isMacPlatform,
        keybindingSchema,
        rawPlatform,
        resolvePlatform,
        setPlatformOverride
    };
});
