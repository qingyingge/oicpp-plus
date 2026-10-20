interface TerminalStatus {
    available: boolean;
    reason: string;
    detail: string;
}

interface AppLike {
    settings?: { font?: string; terminalFontSize?: number; theme?: string; terminalStartupCommand?: string };
    getActiveFilePath?: () => string | null;
    isCloudFilePath?: (path: string) => boolean;
}

interface TerminalSession {
    terminalId: string;
    tab: HTMLButtonElement;
    pane: HTMLDivElement;
    mount: HTMLDivElement;
    terminal: XtermTerminal;
    fitAddon: XtermFitAddon;
    remoteId: string | null;
    cwd: string | null;
    shell: string | null;
    inputBridge: ((data: string) => void) | null;
    muteRemoteOutput: boolean;
}

type XtermTerminal = import('@xterm/xterm').Terminal;
type XtermBufferLine = import('@xterm/xterm').IBufferLine;
type XtermBufferRange = import('@xterm/xterm').IBufferRange;
type XtermLink = import('@xterm/xterm').ILink;

// @xterm/addon-fit declares FitAddon inside a module augmentation, so its
// instance type is not reachable through an import type reference. Mirror the
// members this panel relies on.
interface XtermFitAddon {
    activate(terminal: XtermTerminal): void;
    dispose(): void;
    fit(): void;
    proposeDimensions(): { rows: number; cols: number } | undefined;
}

interface TerminalCreateResult {
    ok?: boolean;
    terminalId?: string;
    cwd?: string;
    shell?: string;
    error?: string;
}

interface TerminalEventData {
    terminalId?: unknown;
    data?: unknown;
    exitCode?: unknown;
    signal?: unknown;
}

interface TerminalShieldHandlers {
    keydown: (event: KeyboardEvent) => void;
    wheel: (event: WheelEvent) => void;
}

interface HTMLElement {
    _terminalKeyShielded?: boolean;
    _terminalShieldHandlers?: TerminalShieldHandlers | null;
}

class IntegratedTerminalPanel {
    getApp: () => unknown;
    sessions: Map<string, TerminalSession>;
    activeId: string | null;
    visible: boolean;
    initialized: boolean;
    status: TerminalStatus;
    panel: HTMLElement | null;
    resizer: HTMLElement | null;
    tabs: HTMLElement | null;
    body: HTMLElement | null;
    empty: HTMLElement | null;
    statusNode: HTMLElement | null;
    newBtn: HTMLElement | null;
    hideBtn: HTMLElement | null;
    counter: number;
    panelHeight: number;
    _dragState: { startY: number; startHeight: number } | null;
    fixedTerminalFontSize: number;
    _resizeObserver: ResizeObserver | null;
    _windowResizeHandler: (() => void) | undefined;

    constructor(options: { getApp?: () => unknown } = {}) {
        this.getApp = typeof options.getApp === 'function' ? options.getApp : () => null;
        this.sessions = new Map();
        this.activeId = null;
        this.visible = false;
        this.initialized = false;
        this.status = { available: false, reason: '', detail: '' };

        this.panel = null;
        this.resizer = null;
        this.tabs = null;
        this.body = null;
        this.empty = null;
        this.statusNode = null;
        this.newBtn = null;
        this.hideBtn = null;
        this.counter = 0;
        this.panelHeight = 290;
        this._dragState = null;
        this.fixedTerminalFontSize = 14;

        this._resizeObserver = null;
    }

    async init() {
        if (this.initialized) {
            return;
        }

        this.panel = document.getElementById('integrated-terminal-panel');
        this.resizer = document.getElementById('integrated-terminal-resizer');
        this.tabs = document.getElementById('integrated-terminal-tabs');
        this.body = document.getElementById('integrated-terminal-body');
        this.empty = document.getElementById('integrated-terminal-empty');
        this.statusNode = document.getElementById('integrated-terminal-status');
        this.newBtn = document.getElementById('integrated-terminal-new');
        this.hideBtn = document.getElementById('integrated-terminal-hide');

        if (!this.panel || !this.resizer || !this.tabs || !this.body) {
            return;
        }

        this.bindEvents();
        await this.refreshFeatureStatus();
        // 标签文案与空状态是 JS 直接写的，data-i18n 覆盖不到。延后一拍执行，
        // 避开 i18n 的 _applyToDOM()（它在 _notifyListeners() 之后同步跑）。
        document.addEventListener('i18n-language-changed', () => {
            setTimeout(() => this.refreshTranslations(), 0);
        });
        this.initialized = true;
    }

    /**
     * 语言切换后重建 JS 写入的译文：终端标签页与空状态提示。
     * 终端回滚缓冲里的历史文本无法改写，属预期行为。
     */
    refreshTranslations(): void {
        try {
            if (this.tabs) {
                this.tabs.querySelectorAll('.integrated-terminal-tab').forEach((tab) => {
                    const counter = Number((tab as HTMLElement).dataset['terminalCounter']);
                    const label = tab.querySelector('.terminal-tab-label');
                    // t() 取不到键时返回键名本身，不需要再写 || 兜底（I5 会拦）
                    if (label && Number.isFinite(counter)) {
                        label.textContent = window.i18n.t('terminal.tabLabel', { counter });
                    }
                    const close = tab.querySelector('.terminal-tab-close');
                    if (close) {
                        close.setAttribute('aria-label', window.i18n.t('terminal.closeTerminal'));
                    }
                });
            }
            this.renderEmptyState();
        } catch (_) { }
    }

    bindEvents() {
        this.newBtn?.addEventListener('click', () => {
            this.open({ createIfNone: true, forceCreate: true });
        });

        this.hideBtn?.addEventListener('click', () => {
            this.setVisible(false);
        });

        this.resizer?.addEventListener('pointerdown', (event) => {
            this.startResizeDrag(event);
        });

        if (window.electronAPI?.onTerminalData) {
            window.electronAPI.onTerminalData((payload) => {
                this.handleTerminalData(payload);
            });
        }

        if (window.electronAPI?.onTerminalExit) {
            window.electronAPI.onTerminalExit((payload) => {
                this.handleTerminalExit(payload);
            });
        }

        this._resizeObserver = new ResizeObserver(() => {
            this.fitActiveTerminal();
        });
        if (this.panel) {
            this._resizeObserver.observe(this.panel);
        }

        this._windowResizeHandler = () => this.fitActiveTerminal();
        window.addEventListener('resize', this._windowResizeHandler);
    }

    startResizeDrag(event: PointerEvent) {
        const resizer = this.resizer;
        if (!this.panel || !this.visible || !resizer) {
            return;
        }

        this._dragState = {
            startY: event.clientY,
            startHeight: this.panel.getBoundingClientRect().height
        };

        resizer.classList.add('dragging');
        resizer.setPointerCapture(event.pointerId);

        const onMove = (moveEvent: PointerEvent) => {
            if (!this._dragState) {
                return;
            }
            const delta = this._dragState.startY - moveEvent.clientY;
            const nextHeight = this._dragState.startHeight + delta;
            this.setPanelHeight(nextHeight);
            this.fitActiveTerminal();
        };

        const stop = () => {
            this._dragState = null;
            resizer.classList.remove('dragging');
            resizer.removeEventListener('pointermove', onMove);
            resizer.removeEventListener('pointerup', stop);
            resizer.removeEventListener('pointercancel', stop);
        };

        resizer.addEventListener('pointermove', onMove);
        resizer.addEventListener('pointerup', stop);
        resizer.addEventListener('pointercancel', stop);
    }

    setPanelHeight(height: number) {
        if (!this.panel) {
            return;
        }
        const viewportHeight = window.innerHeight || 900;
        const minHeight = 160;
        const maxHeight = Math.max(minHeight + 40, Math.floor(viewportHeight * 0.72));
        const next = Math.max(minHeight, Math.min(maxHeight, Math.round(Number(height) || this.panelHeight)));
        this.panelHeight = next;
        this.panel.style.height = `${next}px`;
    }

    async refreshFeatureStatus() {
        if (!window.electronAPI?.getTerminalFeatureStatus) {
            this.status = {
                available: false,
                reason: window.i18n.t('panel.terminalUnavailable'),
                detail: window.i18n.t('panel.terminalPreloadNotExposed')
            };
            this.renderStatus();
            return this.status;
        }

        try {
            const status = await window.electronAPI.getTerminalFeatureStatus();
            this.status = status || { available: false, reason: window.i18n.t('panel.unknownError'), detail: '' };
        } catch (error) {
            this.status = {
                available: false,
                reason: window.i18n.t('panel.terminalStatusFailed'),
                detail: String((error as { message?: unknown })?.message || error)
            };
        }

        this.renderStatus();
        return this.status;
    }

    renderStatus() {
        // Status line intentionally removed from UI.
    }

    async open(options: { createIfNone?: boolean; forceCreate?: boolean } = {}) {
        await this.init();
        await this.refreshFeatureStatus();

        this.setVisible(true);

        if (!this.status.available) {
            this.renderEmptyState();
            return null;
        }

        const forceCreate = !!options.forceCreate;
        const createIfNone = options.createIfNone !== false;

        if (forceCreate || (createIfNone && this.sessions.size === 0)) {
            return await this.createTerminal();
        }

        this.renderEmptyState();
        this.fitActiveTerminal();
        return this.activeId || null;
    }

    setVisible(visible: boolean) {
        this.visible = !!visible;
        if (!this.panel) {
            return;
        }

        this.panel.classList.toggle('collapsed', !this.visible);
        if (this.visible) {
            this.setPanelHeight(this.panelHeight);
            this.fitActiveTerminal();
        }
    }

    resolveTerminalFontOptions() {
        const app = this.getApp ? (this.getApp() as AppLike | null) : null;
        const settings = app?.settings || {};
        const fontFamily = (typeof settings.font === 'string' && settings.font.trim())
            ? settings.font.trim()
            : 'Consolas';
        const configuredFontSize = Number(settings.terminalFontSize);
        const fontSize = Number.isFinite(configuredFontSize) && configuredFontSize > 0
            ? Math.round(configuredFontSize)
            : this.fixedTerminalFontSize;
        return { fontFamily, fontSize };
    }

    getCurrentThemeName() {
        const app = this.getApp ? (this.getApp() as AppLike | null) : null;
        const theme = app?.settings?.theme;
        return typeof theme === 'string' && theme.trim() ? theme.trim() : 'dark';
    }

    isLightThemeActive() {
        return this.getCurrentThemeName().toLowerCase().includes('light');
    }

    resolveTerminalTheme() {
        if (this.isLightThemeActive()) {
            return {
                background: 'rgba(0,0,0,0)',
                foreground: '#1f2328',
                cursor: '#0b57d0',
                cursorAccent: '#ffffff',
                selectionBackground: 'rgba(9, 105, 218, 0.45)',
                selectionForeground: '#ffffff'
            };
        }

        return {
            background: 'rgba(0,0,0,0)',
            foreground: '#d0d0d0',
            cursor: '#c8c8c8',
            cursorAccent: '#111111',
            selectionBackground: 'rgba(90, 170, 255, 0.35)',
            selectionForeground: '#ffffff'
        };
    }

    applyThemeSettings() {
        const lightTheme = this.isLightThemeActive();
        if (this.panel) {
            this.panel.classList.toggle('terminal-theme-light', lightTheme);
        }

        const xtermTheme = this.resolveTerminalTheme();
        for (const session of this.sessions.values()) {
            try {
                session.terminal.options.theme = xtermTheme;
                session.terminal.refresh(0, session.terminal.rows - 1);
            } catch (_) { }
        }
    }

    applyTerminalFontSettings() {
        const { fontFamily, fontSize } = this.resolveTerminalFontOptions();
        for (const session of this.sessions.values()) {
            try {
                session.terminal.options.fontFamily = fontFamily;
                session.terminal.options.fontSize = fontSize;
                session.fitAddon.fit();
                if (session.remoteId) {
                    window.electronAPI.resizeTerminal(session.remoteId, session.terminal.cols, session.terminal.rows);
                }
            } catch (_) { }
        }
    }

    // Keep backward compatibility with older call sites.
    applyEditorFontSettings() {
        this.applyTerminalFontSettings();
    }

    async createTerminal(options: { cwd?: string } = {}) {
        if (!this.status.available) {
            this.renderEmptyState();
            return;
        }

        if (typeof window.Terminal !== 'function') {
            this.status = {
                available: false,
                reason: window.i18n.t('terminal.xtermNotLoaded'),
                detail: window.i18n.t('terminal.xtermNotLoadedDetail')
            };
            this.renderStatus();
            this.renderEmptyState();
            return;
        }

        const fitAddonCtor = window.FitAddon?.FitAddon;
        if (typeof fitAddonCtor !== 'function') {
            this.status = {
                available: false,
                reason: window.i18n.t('terminal.fitAddonMissing'),
                detail: window.i18n.t('terminal.fitAddonMissingDetail')
            };
            this.renderStatus();
            this.renderEmptyState();
            return;
        }

        const unicode11AddonCtor = window.Unicode11Addon?.Unicode11Addon;
        if (typeof unicode11AddonCtor !== 'function') {
            this.status = {
                available: false,
                reason: window.i18n.t('terminal.unicodeAddonMissing'),
                detail: window.i18n.t('terminal.unicodeAddonDetail')
            };
            this.renderStatus();
            this.renderEmptyState();
            return;
        }

        this.counter += 1;
        const tabId = `terminal-local-${Date.now()}-${this.counter}`;

        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'integrated-terminal-tab pending';
        tab.dataset['terminalId'] = tabId;
        // 记录序号，供语言切换后重建标签（标签文案里带 counter）
        tab.dataset['terminalCounter'] = String(this.counter);
        const tabLabel = window.i18n?.t?.('terminal.tabLabel', { counter: this.counter });
        const closeLabel = window.i18n?.t?.('terminal.closeTerminal');
        tab.innerHTML = `<span class="terminal-tab-label">${tabLabel}</span><span class="terminal-tab-close" aria-label="${closeLabel}">×</span>`;

        const pane = document.createElement('div');
        pane.className = 'integrated-terminal-pane';
        pane.dataset['terminalId'] = tabId;

        const mount = document.createElement('div');
        mount.className = 'integrated-terminal-mount';
        pane.appendChild(mount);

        this.tabs?.appendChild(tab);
        this.body?.appendChild(pane);

        const fontOptions = this.resolveTerminalFontOptions();

        const terminal = new window.Terminal({
            cursorBlink: true,
            fontSize: fontOptions.fontSize,
            fontFamily: fontOptions.fontFamily,
            convertEol: true,
            scrollback: 8000,
            allowTransparency: true,
            allowProposedApi: true,
            theme: this.resolveTerminalTheme()
        });
        const fitAddon = new fitAddonCtor();
        const unicode11Addon = new unicode11AddonCtor();
        terminal.loadAddon(fitAddon);
        terminal.loadAddon(unicode11Addon);
        terminal.open(mount);
        try {
            terminal.unicode.activeVersion = '11';
        } catch (_) { }
        fitAddon.fit();

        const provisionalSession: TerminalSession = {
            terminalId: tabId,
            tab,
            pane,
            mount,
            terminal,
            fitAddon,
            remoteId: null,
            cwd: null,
            shell: null,
            inputBridge: null,
            muteRemoteOutput: false
        };

        this.sessions.set(tabId, provisionalSession);
        this.bindTabEvents(tabId);

        this.activateTerminal(tabId);

        const createPayload = {
            cols: terminal.cols,
            rows: terminal.rows,
            cwd: options.cwd || await this.getPreferredCwd()
        };

        let created;
        try {
            created = await window.electronAPI.createTerminal(createPayload) as TerminalCreateResult | null;
        } catch (error) {
            this.handleTerminalCreateFailure(tabId, window.i18n.t('terminal.createFailed', { error: String((error as { message?: unknown })?.message || error) }));
            return;
        }

        if (!created?.ok || !created?.terminalId) {
            this.handleTerminalCreateFailure(tabId, `\r\n[Error] ${created?.error || window.i18n.t('panel.terminalCreateFailed')}`);
            return;
        }

        const remoteId = created.terminalId;
        provisionalSession.remoteId = remoteId;
        provisionalSession.cwd = created.cwd || null;
        provisionalSession.shell = created.shell || null;

        tab.classList.remove('pending');
        tab.dataset['terminalId'] = remoteId;
        pane.dataset['terminalId'] = remoteId;

        this.sessions.delete(tabId);
        this.sessions.set(remoteId, provisionalSession);

        if (this.activeId === tabId) {
            this.activeId = remoteId;
        }

        terminal.onData((data) => {
            if (!provisionalSession.remoteId) {
                return;
            }
            if (typeof provisionalSession.inputBridge === 'function') {
                this.echoBridgedInput(provisionalSession, String(data || ''));
                try {
                    provisionalSession.inputBridge(String(data || ''));
                } catch (_) {
                }
                return;
            }
            window.electronAPI.writeTerminal(provisionalSession.remoteId, data);
        });

        this.setupTerminalClipboardShortcuts(terminal, provisionalSession);
        this.setupTerminalLinkProvider(terminal);
        this.shieldTerminalKeyEvents(mount, provisionalSession);

        await this.initializeSessionEncodingIfNeeded(provisionalSession);

        this.fitTerminal(remoteId);
        this.applyThemeSettings();
        this.renderEmptyState();
        return remoteId;
    }

    shieldTerminalKeyEvents(mountNode: HTMLElement | null, sessionRef: TerminalSession | null = null) {
        if (!mountNode || mountNode._terminalKeyShielded) {
            return;
        }

        const sendInput = async (text: string) => {
            const session = sessionRef;
            const remoteId = session?.remoteId;
            if (!remoteId || !text) {
                return;
            }

            const bridge = session?.inputBridge;
            if (typeof bridge === 'function') {
                this.echoBridgedInput(session, String(text));
                try {
                    bridge(String(text));
                } catch (_) {
                }
                return;
            }

            try {
                window.electronAPI?.writeTerminal?.(remoteId, String(text));
            } catch (_) {
            }
        };

        const onKeyShield = (event: KeyboardEvent) => {
            const key = String(event?.key || '').toLowerCase();
            const ctrl = !!event.ctrlKey;
            const meta = !!event.metaKey;
            const alt = !!event.altKey;
            const shift = !!event.shiftKey;
            const ctrlOrMeta = ctrl || meta;
            const shiftOnly = shift && !ctrl && !meta && !alt;

            // ---- 终端复制/粘贴快捷键（比 xterm attachCustomKeyEventHandler 更早拦截） ----
            const session = sessionRef;
            const term = session?.terminal;
            const hasSelection = term && typeof term.getSelection === 'function' && !!term.getSelection();
            const wantsCopy = (ctrlOrMeta && key === 'c' && (shift || hasSelection))
                || (ctrlOrMeta && key === 'insert');
            const wantsPaste = (ctrlOrMeta && key === 'v')
                || (shiftOnly && key === 'insert');

            if (wantsCopy) {
                event.preventDefault();
                event.stopPropagation();
                const sel = term && typeof term.getSelection === 'function' ? term.getSelection() : '';
                this.copyTextToClipboard(sel);
                return;
            }

            if (wantsPaste) {
                event.preventDefault();
                event.stopPropagation();
                const remoteId = session?.remoteId;
                if (remoteId) {
                    this.pasteClipboardToTerminal(remoteId);
                }
                return;
            }

            // Ensure terminal input is not stolen by focus traversal or global handlers.
            if (key === 'tab' && !ctrl && !meta && !alt) {
                event.preventDefault();
                event.stopPropagation();
                const seq = shift ? '\u001b[Z]' : '\t';
                sendInput(seq);
                return;
            }

            if (!ctrl && !meta && !alt && (key === 'arrowup' || key === 'arrowdown' || key === 'arrowleft' || key === 'arrowright')) {
                event.preventDefault();
                event.stopPropagation();
                const map: Record<string, string> = {
                    arrowup: '\u001b[A',
                    arrowdown: '\u001b[B',
                    arrowright: '\u001b[C',
                    arrowleft: '\u001b[D'
                };
                sendInput(map[key] || '');
                return;
            }
            // Let xterm handle all other keys (e.g. Backspace/Delete/Ctrl combinations).
        };
        mountNode.addEventListener('keydown', onKeyShield, true);

        const onWheelShield = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();

            const session = sessionRef;
            if (!session?.terminal || typeof session.terminal.scrollLines !== 'function') {
                return;
            }

            const deltaY = Number(event.deltaY) || 0;
            if (deltaY === 0) {
                return;
            }

            const lines = Math.max(1, Math.min(6, Math.round(Math.abs(deltaY) / 36)));
            session.terminal.scrollLines(deltaY > 0 ? lines : -lines);
        };
        mountNode.addEventListener('wheel', onWheelShield, true);

        mountNode._terminalKeyShielded = true;
        mountNode._terminalShieldHandlers = { keydown: onKeyShield, wheel: onWheelShield };
    }

    unshieldTerminalKeyEvents(mountNode: HTMLElement | null) {
        if (!mountNode || !mountNode._terminalShieldHandlers) {
            return;
        }
        const handlers = mountNode._terminalShieldHandlers;
        mountNode.removeEventListener('keydown', handlers.keydown, true);
        mountNode.removeEventListener('wheel', handlers.wheel, true);
        mountNode._terminalShieldHandlers = null;
        mountNode._terminalKeyShielded = false;
    }

    async initializeSessionEncodingIfNeeded(session: TerminalSession | null) {
        const terminalId = session?.remoteId;
        if (!terminalId || !window.electronAPI?.getPlatform || !window.electronAPI?.writeTerminal) {
            return;
        }

        let platform = '';
        try {
            platform = String(await window.electronAPI.getPlatform() || '').toLowerCase();
        } catch (_) {
            return;
        }

        if (platform === 'windows') {
            const shell = String(session?.shell || '').toLowerCase();
            let initCmd = 'chcp 65001 > nul\r';
            if (shell.includes('powershell') || shell.includes('pwsh')) {
                initCmd = '[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);chcp 65001 > $null\r';
            }
            try {
                window.electronAPI.writeTerminal(terminalId, initCmd);
            } catch (_) {
            }
        }

        // 执行用户自定义的终端启动命令（非强制，可由设置项配置）
        const startupCommand = this.resolveTerminalStartupCommand();
        if (startupCommand) {
            try {
                window.electronAPI.writeTerminal(terminalId, startupCommand + '\r');
            } catch (_) {
            }
        }
    }

    resolveTerminalStartupCommand() {
        const app = this.getApp ? (this.getApp() as AppLike | null) : null;
        const settings = app?.settings || {};
        const cmd = typeof settings.terminalStartupCommand === 'string'
            ? settings.terminalStartupCommand.trim()
            : '';
        return cmd || '';
    }

    setupTerminalLinkProvider(terminal: XtermTerminal) {
        if (!terminal || typeof terminal.registerLinkProvider !== 'function') {
            return;
        }

        const urlPattern = /\b(?:https?:\/\/|www\.)[^\s<>"'()\[\]{}]+/gi;

        terminal.registerLinkProvider({
            provideLinks: (bufferLineNumber, callback) => {
                const line = terminal.buffer?.active?.getLine?.(bufferLineNumber - 1);
                if (!line || typeof line.translateToString !== 'function') {
                    callback(undefined);
                    return;
                }

                const lineText = line.translateToString(true);
                if (!lineText) {
                    callback(undefined);
                    return;
                }

                const links: XtermLink[] = [];
                for (const match of lineText.matchAll(urlPattern)) {
                    const rawText = String(match[0] || '').replace(/[).,!?;:]+$/, '');
                    if (!rawText) {
                        continue;
                    }

                    const startIndex = match.index || 0;
                    const endIndex = startIndex + rawText.length;
                    const range = this.resolveTerminalLinkRange(line, startIndex, endIndex, bufferLineNumber);
                    if (!range) {
                        continue;
                    }

                    links.push({
                        text: rawText,
                        range,
                        activate: (event, text) => {
                            if (!(event?.ctrlKey || event?.metaKey)) {
                                return;
                            }
                            const resolvedUrl = this.normalizeTerminalUrl(text || rawText);
                            if (resolvedUrl) {
                                this.openExternalUrl(resolvedUrl);
                            }
                        }
                    });
                }

                callback(links.length > 0 ? links : undefined);
            }
        });
    }

    resolveTerminalLinkRange(line: XtermBufferLine | null | undefined, startIndex: number, endIndex: number, bufferLineNumber: number): XtermBufferRange | null {
        if (!line || typeof line.getCell !== 'function' || startIndex < 0 || endIndex <= startIndex) {
            return null;
        }

        let textOffset = 0;
        let columnOffset = 0;
        let startColumn: number | null = null;
        let endColumn: number | null = null;
        const lineLength = Number(line.length) || 0;

        for (let cellIndex = 0; cellIndex < lineLength; cellIndex++) {
            const cell = line.getCell(cellIndex);
            if (!cell || typeof cell.getChars !== 'function') {
                columnOffset += 1;
                continue;
            }

            const chars = String(cell.getChars() || '');
            const width = typeof cell.getWidth === 'function' ? Number(cell.getWidth()) : 1;
            const displayWidth = Number.isFinite(width) && width > 0 ? width : 0;

            if (startColumn === null && startIndex >= textOffset && startIndex < textOffset + chars.length) {
                startColumn = columnOffset;
            }

            if (endColumn === null && endIndex <= textOffset + chars.length) {
                endColumn = columnOffset + displayWidth;
            }

            textOffset += chars.length;
            columnOffset += displayWidth;

            if (startColumn !== null && endColumn !== null) {
                break;
            }
        }

        if (startColumn === null) {
            return null;
        }

        if (endColumn === null || endColumn < startColumn) {
            endColumn = startColumn + Math.max(1, endIndex - startIndex);
        }

        return {
            start: { x: startColumn + 1, y: bufferLineNumber },
            end: { x: endColumn, y: bufferLineNumber }
        };
    }

    normalizeTerminalUrl(text: unknown) {
        const value = String(text || '').trim();
        if (!value) {
            return '';
        }

        if (/^www\./i.test(value)) {
            try {
                return new URL(`https://${value}`).href;
            } catch (_) {
                return '';
            }
        }

        if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
            try {
                const parsedUrl = new URL(value);
                if (['http:', 'https:', 'mailto:', 'file:'].includes(parsedUrl.protocol)) {
                    return parsedUrl.href;
                }
            } catch (_) {
            }
            return '';
        }

        try {
            return new URL(value, window.location.href).href;
        } catch (_) {
            return '';
        }
    }

    async openExternalUrl(url: unknown) {
        const targetUrl = String(url || '').trim();
        if (!targetUrl) {
            return;
        }

        try {
            if (window.electronAPI && typeof window.electronAPI.openExternal === 'function') {
                await window.electronAPI.openExternal(targetUrl);
            } else if (window.electron && window.electron.shell && typeof window.electron.shell.openExternal === 'function') {
                window.electron.shell.openExternal(targetUrl);
            } else if (typeof window.open === 'function') {
                window.open(targetUrl, '_blank', 'noopener');
            }
        } catch (_) {
        }
    }

    setupTerminalClipboardShortcuts(terminal: XtermTerminal, sessionRef: TerminalSession | null) {
        if (!terminal || typeof terminal.attachCustomKeyEventHandler !== 'function') {
            return;
        }

        terminal.attachCustomKeyEventHandler((event) => {
            if (!event || event.type !== 'keydown') {
                return true;
            }

            const key = String(event.key || '').toLowerCase();
            const ctrlOrMeta = !!(event.ctrlKey || event.metaKey);
            const shiftOnly = !!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey;
            if (!ctrlOrMeta && !shiftOnly) {
                return true;
            }

            const hasSelection = typeof terminal.getSelection === 'function' && !!terminal.getSelection();
            const wantsCopy = (ctrlOrMeta && key === 'c' && (event.shiftKey || hasSelection))
                || (ctrlOrMeta && key === 'insert');
            const wantsPaste = (ctrlOrMeta && key === 'v')
                || (shiftOnly && key === 'insert');

            if (wantsCopy) {
                event.preventDefault();
                this.copyTextToClipboard(terminal.getSelection ? terminal.getSelection() : '');
                return false;
            }

            if (wantsPaste) {
                event.preventDefault();
                const terminalId = sessionRef?.remoteId;
                if (terminalId) {
                    this.pasteClipboardToTerminal(terminalId);
                }
                return false;
            }

            return true;
        });
    }

    async copyTextToClipboard(text: unknown) {
        const value = String(text || '');
        if (!value) {
            return;
        }
        try {
            await navigator.clipboard.writeText(value);
            return;
        } catch (_) { }

        try {
            const result = await window.electronAPI?.clipboardWriteText?.(value);
            if (result?.success) {
                return;
            }
        } catch (_) { }
    }

    async pasteClipboardToTerminal(terminalId: string) {
        let text = '';
        try {
            text = await navigator.clipboard.readText();
        } catch (_) { }

        if (!text) {
            try {
                const result = await window.electronAPI?.clipboardReadText?.();
                text = typeof result === 'string' ? result : '';
            } catch (_) { }
        }

        if (!text) {
            return;
        }

        // 调试输入桥接模式：通过 inputBridge 发送，确保粘贴内容到达被调试程序
        const session = this.sessions.get(terminalId);
        if (session && typeof session.inputBridge === 'function') {
            this.echoBridgedInput(session, text);
            try {
                session.inputBridge(text);
            } catch (_) { }
            return;
        }

        try {
            window.electronAPI.writeTerminal(terminalId, text);
        } catch (_) { }
    }

    quoteExecutableForShell(executablePath: unknown, platform: string) {
        const text = String(executablePath || '');
        if (platform === 'windows') {
            return `"${text.replace(/"/g, '""')}"`;
        }
        return `'${text.replace(/'/g, `'\\''`)}'`;
    }

    buildRunCommandForShell(executablePath: unknown, shellPath: unknown, platform: string) {
        const shell = String(shellPath || '').toLowerCase();
        const quoted = this.quoteExecutableForShell(executablePath, platform);
        if (platform === 'windows' && shell.includes('powershell')) {
            return `& ${quoted}\r`;
        }
        if (platform === 'macos' || platform === 'linux') {
            return `${quoted}; printf '\\n'\r`;
        }
        return `${quoted}\r`;
    }

    async runExecutableInNewTerminal(executablePath: string, options: { workingDirectory?: string } = {}) {
        if (!executablePath) {
            throw new Error(window.i18n.t('panel.terminalExePathEmpty'));
        }

        await this.init();
        await this.refreshFeatureStatus();
        this.setVisible(true);
        if (!this.status.available) {
            throw new Error(this.status.reason || window.i18n.t('panel.terminalFeatureUnavailable'));
        }

        const cwd = options.workingDirectory || await this.getPreferredCwd();
        const terminalId = await this.createTerminal({ cwd });
        if (!terminalId) {
            throw new Error(window.i18n.t('panel.terminalCreateFailed2'));
        }

        this.activateTerminal(terminalId);

        let platform = 'windows';
        try {
            if (window.electronAPI?.getPlatform) {
                platform = await window.electronAPI.getPlatform();
            }
        } catch (_) { }

        const session = this.sessions.get(terminalId);
        const command = this.buildRunCommandForShell(executablePath, session?.shell || '', platform);
        window.electronAPI.writeTerminal(terminalId, command);
        return terminalId;
    }

    bindTabEvents(terminalId: string) {
        const session = this.sessions.get(terminalId);
        if (!session) {
            return;
        }

        session.tab.addEventListener('click', (event) => {
            const closeBtn = (event.target as HTMLElement).closest('.terminal-tab-close');
            if (closeBtn) {
                event.preventDefault();
                event.stopPropagation();
                this.closeTerminal(session.remoteId || terminalId);
                return;
            }
            this.activateTerminal(session.remoteId || terminalId);
        });
    }

    activateTerminal(terminalId: string) {
        this.activeId = terminalId;

        for (const [id, session] of this.sessions.entries()) {
            const active = id === terminalId;
            session.tab.classList.toggle('active', active);
            session.pane.classList.toggle('active', active);
        }

        this.fitActiveTerminal();
        this.focusTerminal(terminalId);
    }

    focusTerminal(terminalId: string) {
        const session = this.sessions.get(terminalId);
        if (!session || !session.terminal) {
            return false;
        }
        try {
            session.terminal.focus();
            return true;
        } catch (_) {
            return false;
        }
    }

    echoBridgedInput(session: TerminalSession | null, data: unknown) {
        if (!session || !session.terminal || typeof data !== 'string' || !data) {
            return;
        }

        let out = '';
        for (const ch of data) {
            if (ch === '\r' || ch === '\n') {
                out += '\r\n';
                continue;
            }
            if (ch === '\u007f' || ch === '\b') {
                out += '\b \b';
                continue;
            }
            const code = ch.charCodeAt(0);
            if (code >= 0x20 || ch === '\t') {
                out += ch;
            }
        }

        if (!out) {
            return;
        }

        try {
            session.terminal.write(out);
        } catch (_) {
        }
    }

    handleTerminalData(payload: unknown) {
        const info = payload as TerminalEventData | null;
        const terminalId = typeof info?.terminalId === 'string' ? info.terminalId : '';
        const data = info?.data;
        if (!terminalId || typeof data !== 'string') {
            return;
        }

        const session = this.sessions.get(terminalId);
        if (!session) {
            return;
        }

        if (session.muteRemoteOutput) {
            return;
        }

        session.terminal.write(data);
    }

    setInputBridge(terminalId: string, bridgeHandler: ((data: string) => void) | null) {
        const session = this.sessions.get(terminalId);
        if (!session) {
            return false;
        }
        session.inputBridge = typeof bridgeHandler === 'function' ? bridgeHandler : null;
        return true;
    }

    clearInputBridge(terminalId: string) {
        return this.setInputBridge(terminalId, null);
    }

    setRemoteOutputMuted(terminalId: string, muted: boolean) {
        const session = this.sessions.get(terminalId);
        if (!session) {
            return false;
        }
        session.muteRemoteOutput = !!muted;
        return true;
    }

    writeTerminalOutput(terminalId: string, data: unknown) {
        const session = this.sessions.get(terminalId);
        if (!session) {
            return false;
        }
        try {
            session.terminal.write(String(data ?? ''));
            return true;
        } catch (_) {
            return false;
        }
    }

    handleTerminalExit(payload: unknown) {
        const info = payload as TerminalEventData | null;
        const terminalId = typeof info?.terminalId === 'string' ? info.terminalId : '';
        if (!terminalId) {
            return;
        }

        const session = this.sessions.get(terminalId);
        if (!session) {
            return;
        }

        const code = info?.exitCode;
        const signal = info?.signal;
        const suffix = Number.isFinite(code as number)
            ? window.i18n.t('terminal.exitCode', { code })
            : (signal ? window.i18n.t('terminal.exitSignal', { signal }) : window.i18n.t('terminal.exitedNoInfo'));
        session.terminal.writeln(window.i18n.t('terminal.exited', { info: suffix }));
        session.tab.classList.add('exited');
    }

    // 创建失败时必须把占位会话、标签页和面板一起清掉：只保留它们会让 sessions.size
    // 一直大于 0（影响 renderEmptyState 与 createIfNone 判断），并让后续终端编号错乱。
    handleTerminalCreateFailure(tabId: string, message: string): void {
        const session = this.sessions.get(tabId);
        if (session?.terminal) {
            try {
                session.terminal.writeln(message);
            } catch (_) { }
        }
        try {
            logError('[Terminal] 创建失败:', message);
        } catch (_) { }
        this.closeTerminal(tabId);
    }

    async closeTerminal(terminalId: string) {
        const session = this.sessions.get(terminalId);
        if (!session) {
            return;
        }

        if (session.remoteId) {
            try {
                await window.electronAPI.killTerminal(session.remoteId);
            } catch (_) {}
        }

        try {
            session.terminal.dispose();
        } catch (_) {}

        this.unshieldTerminalKeyEvents(session.mount);

        session.tab.remove();
        session.pane.remove();
        this.sessions.delete(terminalId);

        if (this.activeId === terminalId) {
            const first = this.sessions.keys().next();
            this.activeId = first.done ? null : first.value;
            if (this.activeId) {
                this.activateTerminal(this.activeId);
            }
        }

        this.renderEmptyState();
    }

    renderEmptyState() {
        if (!this.empty) {
            return;
        }

        if (!this.visible) {
            this.empty.style.display = 'none';
            return;
        }

        if (!this.status.available) {
            this.empty.style.display = 'flex';
            this.empty.textContent = this.formatUnavailableStatusText();
            return;
        }

        if (this.sessions.size === 0) {
            this.empty.style.display = 'flex';
            this.empty.textContent = window.i18n.t('terminal.emptyHint');
            return;
        }

        this.empty.style.display = 'none';
    }

    formatUnavailableStatusText() {
        const reason = String(this.status?.reason || window.i18n.t('panel.terminalFeatureUnavailable')).trim();
        const detailRaw = this.status?.detail == null ? '' : String(this.status.detail).trim();

        if (!detailRaw) {
            return reason;
        }

        let detail = detailRaw
            .replace(/\s*Require stack:\s*/i, '\nRequire stack:\n')
            .replace(/\s+-\s+/g, '\n- ');

        return `${reason}\n${detail}`;
    }

    fitActiveTerminal() {
        if (!this.activeId) {
            return;
        }
        this.fitTerminal(this.activeId);
    }

    fitTerminal(terminalId: string) {
        const session = this.sessions.get(terminalId);
        if (!session || !this.visible) {
            return;
        }

        try {
            session.fitAddon.fit();
            if (session.remoteId) {
                window.electronAPI.resizeTerminal(session.remoteId, session.terminal.cols, session.terminal.rows);
            }
        } catch (_) {}
    }

    async getPreferredCwd() {
        const app = this.getApp() as AppLike | null;
        const active = typeof app?.getActiveFilePath === 'function' ? app.getActiveFilePath() : null;
        if (active && !app?.isCloudFilePath?.(active) && typeof window.electronAPI?.pathDirname === 'function') {
            try {
                return await window.electronAPI.pathDirname(active);
            } catch (_) { }
        }

        // With no active local file, open the terminal in the selected workspace
        // instead of falling back to the application's temporary directory.
        const workspacePath = window.sidebarManager?.panels?.files?.workspacePath;
        return typeof workspacePath === 'string' && workspacePath.trim() ? workspacePath : undefined;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = IntegratedTerminalPanel;
} else {
    window.IntegratedTerminalPanel = IntegratedTerminalPanel;
}
