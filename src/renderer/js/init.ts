
declare function logInfo(...args: unknown[]): void;
declare function logWarn(...args: unknown[]): void;
declare function logError(...args: unknown[]): void;

document.addEventListener('DOMContentLoaded', async function() {
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

            const dialogManager = (window as any).dialogManager;
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
        const userIconPath = await (window as any).electronAPI?.getUserIconPath?.();
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
        (window as any).titlebarManager = new ((window as any).titlebarManager as { new(): unknown })();

        logInfo('初始化侧边栏管理器...');
        (window as any).sidebarManager = new ((window as any).sidebarManager as { new(): unknown })();
        (window as any).sampleTester = (window as any).sidebarManager?.getPanelManager?.('samples');
        (window as any).codeComparer = (window as any).sidebarManager?.getPanelManager?.('compare');
        (window as any).cloudSyncPanel = (window as any).sidebarManager?.getPanelManager?.('cloud');

        setTimeout(() => {
            (window as any).sidebarManager?.updateFileExplorerButtons?.();
        }, 100);
        logInfo('侧边栏管理器已初始化');
        (window as any).checkSidebarResize = () => {
            const sidebarManager = (window as any).sidebarManager;
            if (sidebarManager && sidebarManager.checkResizeStatus) {
                return sidebarManager.checkResizeStatus();
            } else {
                logInfo('侧边栏管理器未找到');
                return null;
            }
        };

        logInfo('初始化标签页管理器...');
        if (!(window as any).tabManager) {
            (window as any).tabManager = new ((window as any).tabManager as { new(): unknown })();
        }

        logInfo('初始化主应用...');
        (window as any).oicppApp = new ((window as any).oicppApp as { new(): unknown })();
        logInfo('OICPPApp 实例已创建');
        await (window as any).oicppApp?.init?.();

        setupDefaultContent();

        logInfo('应用初始化完成！');
        try {
            if ((window as any).electronAPI && (window as any).electronAPI.onRequestSaveAll) {
                (window as any).electronAPI.onRequestSaveAll(async () => {
                    try {
                        const tabManager = (window as any).tabManager;
                        if (tabManager && typeof tabManager.saveAllFiles === 'function') {
                            await tabManager.saveAllFiles();
                        } else if ((window as any).oicppApp?.saveCurrentFile) {
                            (window as any).oicppApp.saveCurrentFile();
                        }
                    } finally {
                        (window as any).electronAPI.notifySaveAllComplete();
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
    setTimeout(function() {
        try {
            const sidebarManager = (window as any).sidebarManager;
            const fileExplorer = sidebarManager?.getPanelManager?.('files');
            const hasWorkspace = !!(fileExplorer && (fileExplorer as { hasWorkspace?: boolean }).hasWorkspace);
            if (hasWorkspace) {
                logInfo('检测到已打开工作区，跳过欢迎页面');
                return;
            }

            const tabManager = (window as any).tabManager;
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
            const tabManager = (window as any).tabManager;
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
    } catch (_) {}
}

window.addEventListener('error', function(e: ErrorEvent) {
    try {
        const info = {
            message: e?.error?.message || e?.message,
            filename: e?.filename,
            lineno: e?.lineno,
            colno: e?.colno,
            stack: e?.error?.stack
        };
        logError('[RendererGlobalError]', info);
    } catch (_) {}
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

window.addEventListener('unhandledrejection', function(e: PromiseRejectionEvent) {
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
    } catch (_) {}
});

(window as any).initializeApp = initializeApp;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initializeApp };
}