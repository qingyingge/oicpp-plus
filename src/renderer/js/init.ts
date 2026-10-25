declare function logInfo(...args: unknown[]): void;
declare function logWarn(...args: unknown[]): void;
declare function logError(...args: unknown[]): void;

document.addEventListener('DOMContentLoaded', async function () {
    logInfo('DOM 加载完成，开始初始化应用...');
    await setUserIconPath();
    if (window.i18n && typeof window.i18n.init === 'function') {
        try {
            await window.i18n.init();
            if (typeof window.i18n.enableAutoTranslate === 'function') {
                window.i18n.enableAutoTranslate();
            }
        } catch (err) {
            logError('i18n 初始化失败:', err);
        }
    }
    await initializeApp();
    setTimeout(() => {
        try {
            const now = new Date();
            const isNewYearDay = (now.getMonth() === 0 && now.getDate() === 1);
            const isSpringFestivalDay = (now.getMonth() === 1 && now.getDate() === 17);

            const dialogManager = window.dialogManager;
            if (!dialogManager) return;

            if (isNewYearDay && typeof dialogManager.showNewYearGreeting === 'function') {
                dialogManager.showNewYearGreeting(now);
                return;
            }

            if (isSpringFestivalDay && typeof dialogManager.showSpringFestivalGreeting === 'function') {
                dialogManager.showSpringFestivalGreeting(now);
            }
        } catch (e) {
            try { logWarn('新年弹窗触发失败:', e); } catch (_) { }
        }
    }, 350);
});

async function setUserIconPath(): Promise<void> {
    try {
        const userIconPath = await window.electronAPI?.getUserIconPath?.();
        const appIcon = document.getElementById('app-icon');
        if (appIcon instanceof HTMLImageElement && userIconPath) {
            appIcon.src = userIconPath;
        }
    } catch (error) {
        logWarn('无法加载用户目录中的图标，使用默认图标:', error);
    }
}

async function initializeApp(): Promise<void> {
    try {
        logInfo('初始化标题栏管理器...');
        window.titlebarManager = new TitlebarManager();

        logInfo('初始化侧边栏管理器...');
        window.sidebarManager = new SidebarManager();
        window.sampleTester = window.sidebarManager.getPanelManager('samples');
        window.codeComparer = window.sidebarManager.getPanelManager('compare');
        window.cloudSyncPanel = window.sidebarManager.getPanelManager('cloud');

        setTimeout(() => {
            window.sidebarManager?.updateFileExplorerButtons?.();
        }, 100);
        logInfo('侧边栏管理器已初始化');
        window.checkSidebarResize = () => {
            const sidebarManager = window.sidebarManager;
            if (sidebarManager && sidebarManager.checkResizeStatus) {
                return sidebarManager.checkResizeStatus();
            } else {
                logInfo('侧边栏管理器未找到');
                return null;
            }
        };

        logInfo('初始化标签页管理器...');
        // tabs.js 已在 DOMContentLoaded 时创建过实例并挂到 window.tabManager，
        // 这里复用，避免重复执行 initializeGroups/setupEventListeners
        if (!window.tabManager) {
            window.tabManager = new TabManager();
        }

        logInfo('初始化主应用...');
        window.oicppApp = new OICPPApp();
        logInfo('OICPPApp 实例已创建');
        await window.oicppApp?.init?.();

        setupDefaultContent();

        logInfo('应用初始化完成！');
        try {
            if (window.electronAPI && window.electronAPI.onRequestSaveAll) {
                window.electronAPI.onRequestSaveAll(async () => {
                    type SaveAllResult = { success?: boolean; failures?: Array<{ fileName?: string | null; error?: string }> };
                    const _t = (key: string, params?: Record<string, unknown>) => window.i18n?.t?.(key, params) || key;
                    let result: SaveAllResult = { success: true, failures: [] };
                    try {
                        const tabManager = window.tabManager;
                        if (tabManager && typeof (tabManager as { saveAllFiles?: () => Promise<SaveAllResult> }).saveAllFiles === 'function') {
                            result = (await (tabManager as { saveAllFiles: () => Promise<SaveAllResult> }).saveAllFiles()) || result;
                        } else if (window.oicppApp?.saveCurrentFile) {
                            await window.oicppApp.saveCurrentFile();
                        }
                    } catch (e) {
                        result = { success: false, failures: [{ fileName: '', error: (e as Error)?.message || String(e) }] };
                    }
                    if (result && result.success === false) {
                        // 落盘失败仍然 notifySaveAllComplete 的话，主进程会照常关窗，
                        // 用户选的「保存并退出」就变成了静默丢弃改动。
                        const failures = Array.isArray(result.failures) ? result.failures : [];
                        const detail = failures.slice(0, 8)
                            .map((f) => _t('dialog.saveFailedItem', {
                                name: f.fileName || _t('dialog.saveUnnamedFile'),
                                error: f.error || _t('dialog.saveUnknownError')
                            }))
                            .join('<br>');
                        const message = _t('dialog.saveFailedIntro', { detail: detail || _t('dialog.saveUnknownError') });
                        logError('[关闭前保存]', message);
                        try {
                            if (window.dialogManager?.showConfirmDialog) {
                                window.dialogManager.showConfirmDialog(_t('dialog.saveFailedTitle'), message).catch(() => { });
                            }
                        } catch (_) { }
                        try { window.electronAPI.notifySaveAllFailed({ failures }); } catch (_) { }
                    } else {
                        window.electronAPI.notifySaveAllComplete();
                    }
                });
            }
        } catch (e) { logWarn('注册关闭前保存监听失败:', e); }

    } catch (error) {
        logError('应用初始化失败:', error);
        const i18n = window.i18n;
        const msg = i18n && typeof i18n.t === 'function' ? i18n.t('app.appInitFailed', { msg: (error as Error).message }) : 'Application initialization failed';
        showErrorMessage(msg);
    }
}

function setupDefaultContent(): void {
    setTimeout(function () {
        try {
            const sidebarManager = window.sidebarManager;
            const fileExplorer = sidebarManager?.getPanelManager('files');
            const hasWorkspace = !!(fileExplorer && (fileExplorer as { hasWorkspace?: boolean }).hasWorkspace);
            if (hasWorkspace) {
                logInfo('检测到已打开工作区，跳过欢迎页面');
                return;
            }

            const tabManager = window.tabManager;
            if (tabManager && typeof tabManager.getTabCount === 'function' && tabManager.getTabCount() === 0) {
                logInfo('显示欢迎页面...');
                if (typeof tabManager.showWelcomePage === 'function') {
                    tabManager.showWelcomePage();
                } else {
                    logError('showWelcomePage 方法不存在');
                }
            }
        } catch (error) {
            logError('显示欢迎页面时出错:', error);
            const tabManager = window.tabManager;
            if (tabManager && typeof tabManager.createNewCppFile === 'function') {
                tabManager.createNewCppFile();
            }
        }
    }, 1000);
}

function showErrorMessage(message: string): void {
    const i18n = window.i18n;
    let fallback = 'Error';
    if (i18n && typeof i18n.t === 'function') {
        const translated = i18n.t('app.errorRetry');
        if (translated) fallback = translated;
    }
    const msg = String(message ?? '');
    const firstLine = msg.split(/\r?\n/)[0]?.trim() ?? '';
    const safeMessage = firstLine || fallback;
    try {
        logWarn('[RendererErrorToastSuppressed]', safeMessage);
    } catch (_) { }
}

window.addEventListener('error', function (e: ErrorEvent) {
    try {
        const info = {
            message: e?.error?.message || e?.message,
            filename: e?.filename,
            lineno: e?.lineno,
            colno: e?.colno,
            stack: e?.error?.stack
        };
        logError('[RendererGlobalError]', info);
    } catch (_) { }
});

// "Model not found" comes from monaco's text-model resolver
// (createModelReference -> _acquire -> modelService.getModel): it throws
// when a single definition target has no model in the editor, which is the
// normal case for Ctrl+hover previews of STL headers and other unopened
// files. Monaco's own .then() chain has no .catch(), so the rejection
// escapes. Its caller startFindDefinition is async and therefore never
// appears in the stack, so the stack has to be matched against the monaco
// bundle itself.
function isMonacoModelReferenceRejection(message: string, stack: string): boolean {
    if (message !== 'Model not found') {
        return false;
    }
    if (!/node_modules[\\/]monaco-editor/.test(stack)) {
        return false;
    }
    return /(_acquire|createModelReference|ReferenceCollection|editorWorkerHost)/.test(stack);
}

window.addEventListener('unhandledrejection', function (e: PromiseRejectionEvent) {
    try {
        const reason = e?.reason;
        const message = String(reason?.message || reason || '');
        const stack = String(reason?.stack || '');
        if (isMonacoModelReferenceRejection(message, stack)) {
            logWarn('[RendererUnhandledRejectionSuppressed]', { message });
            return;
        }
        const info = reason instanceof Error ? { message: reason.message, stack: reason.stack } : { reason };
        logError('[RendererUnhandledRejection]', info);
    } catch (_) { }
});

window.initializeApp = initializeApp;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initializeApp };
}
