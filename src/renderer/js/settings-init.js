"use strict";
document.addEventListener('DOMContentLoaded', async function () {
    try {
        if (window.i18n && typeof window.i18n.init === 'function') {
            await window.i18n.init();
        }
        if (window.electronAPI && window.electronAPI.getAllSettings) {
            const settings = await window.electronAPI.getAllSettings();
            logInfo('启动时加载的设置:', settings);
            applySettingsToUI(settings);
            if (window.electronIPC && window.electronIPC.on) {
                window.electronIPC.on('settings-changed', (_event, _settingsType, newSettings) => {
                    logInfo('收到设置变化通知:', newSettings);
                    applySettingsToUI(newSettings);
                });
                window.electronIPC.on('settings-loaded', (_event, allSettings) => {
                    logInfo('收到设置加载完成通知:', allSettings);
                    applySettingsToUI(allSettings);
                });
                window.electronIPC.on('settings-reset', (_event, allSettings) => {
                    logInfo('收到设置重置通知:', allSettings);
                    applySettingsToUI(allSettings);
                });
                window.electronIPC.on('settings-imported', (_event, allSettings) => {
                    logInfo('收到设置导入通知:', allSettings);
                    applySettingsToUI(allSettings);
                });
            }
        }
    }
    catch (error) {
        logError('设置初始化失败:', error);
    }
});
function applySettingsToUI(settings) {
    if (!settings)
        return;
    // 索引签名对象先读一次收窄成局部量，后续分支就不再触发 noPropertyAccessFromIndexSignature
    const theme = typeof settings['theme'] === 'string' ? settings['theme'] : undefined;
    const font = typeof settings['font'] === 'string' ? settings['font'] : undefined;
    const fontSizeRaw = typeof settings['fontSize'] === 'number' ? settings['fontSize'] : undefined;
    const backgroundImage = settings['backgroundImage'];
    if (theme) {
        logInfo('应用主题到设置页面:', theme);
        document.body.setAttribute('data-theme', theme);
        document.documentElement.setAttribute('data-theme', theme);
        const normalizedTheme = theme.toLowerCase();
        const tone = normalizedTheme.includes('light') ? 'light' : 'dark';
        document.body.setAttribute('data-editor-theme', tone);
        document.documentElement.setAttribute('data-editor-theme', tone);
        document.body.classList.remove('theme-light', 'theme-dark', 'light-theme', 'dark-theme');
        document.documentElement.classList.remove('theme-light', 'theme-dark', 'light-theme', 'dark-theme');
        if (tone === 'light') {
            document.body.classList.add('theme-light', 'light-theme');
            document.documentElement.classList.add('theme-light', 'light-theme');
        }
        else {
            document.body.classList.add('theme-dark', 'dark-theme');
            document.documentElement.classList.add('theme-dark', 'dark-theme');
        }
    }
    if (typeof settings['language'] === 'string') {
        if (window.i18n && typeof window.i18n.t === 'function') {
            if (typeof window.i18n._applyToDOM === 'function') {
                window.i18n._applyToDOM();
            }
        }
    }
    if (font || fontSizeRaw) {
        let fontFamily = font || 'Consolas';
        const fontSize = fontSizeRaw ?? 14;
        if (window.fontDetector && font !== undefined) {
            const validatedFont = window.fontDetector.validateFont(font);
            if (validatedFont !== font) {
                fontFamily = validatedFont;
            }
        }
        const editorElements = document.querySelectorAll('.monaco-editor, .monaco-editor-container');
        editorElements.forEach((element) => {
            if (!(element instanceof HTMLElement))
                return;
            if (font)
                element.style.fontFamily = fontFamily;
            if (fontSizeRaw)
                element.style.fontSize = fontSize + 'px';
        });
        const breadcrumbEls = document.querySelectorAll('.folder-picker-breadcrumb');
        breadcrumbEls.forEach((el) => {
            if (!(el instanceof HTMLElement))
                return;
            if (fontSizeRaw)
                el.style.fontSize = fontSize + 'px';
            if (font)
                el.style.fontFamily = fontFamily;
        });
        document.documentElement.style.setProperty('--editor-font-family', fontFamily);
        document.documentElement.style.setProperty('--editor-font-size', fontSize + 'px');
    }
    if (backgroundImage !== undefined) {
        if (backgroundImage) {
            let bgPath = String(backgroundImage).replace(/\\/g, '/');
            if (!bgPath.startsWith('http') && !bgPath.startsWith('file://')) {
                if (bgPath.startsWith('/')) {
                    bgPath = 'file://' + bgPath;
                }
                else {
                    bgPath = 'file:///' + bgPath;
                }
            }
            document.body.style.backgroundImage = `url('${bgPath}')`;
            document.body.style.backgroundSize = 'cover';
            document.body.style.backgroundRepeat = 'no-repeat';
            document.body.style.backgroundPosition = 'center';
            document.body.classList.add('has-custom-bg');
            let styleEl = document.getElementById('custom-bg-style');
            if (!styleEl) {
                styleEl = document.createElement('style');
                styleEl.id = 'custom-bg-style';
                document.head.appendChild(styleEl);
            }
            styleEl.textContent = `
                body.has-custom-bg .main-container,
                body.has-custom-bg .editor-container,
                body.has-custom-bg .monaco-editor-container,
                body.has-custom-bg .editor-group,
                body.has-custom-bg .editor-area,
                body.has-custom-bg .monaco-editor,
                body.has-custom-bg .monaco-editor-background,
                body.has-custom-bg .monaco-editor .margin {
                    background-color: transparent !important;
                }

                body.has-custom-bg .main-container {
                    background-color: transparent !important;
                }
                body.has-custom-bg[data-editor-theme="light"] .main-container {
                    background-color: transparent !important;
                }

                body.has-custom-bg .editor-container {
                    background-color: rgba(30, 30, 30, 0.62) !important;
                }
                body.has-custom-bg[data-editor-theme="light"] .editor-container {
                    background-color: rgba(255, 255, 255, 0.78) !important;
                }

                body.has-custom-bg.glass-effect-enabled .editor-container {
                    background-color: var(--glass-surface, rgba(16, 19, 27, 0.42)) !important;
                }
                body.has-custom-bg.glass-effect-enabled[data-editor-theme="light"] .editor-container {
                    background-color: rgba(255, 255, 255, 0.56) !important;
                }

                body.has-custom-bg .sidebar {
                    background-color: rgba(37, 37, 38, 0.4) !important;
                }
                body.has-custom-bg[data-editor-theme="light"] .sidebar {
                    background-color: rgba(243, 243, 243, 0.4) !important;
                }

                body.has-custom-bg .sidebar-icons,
                body.has-custom-bg .sidebar-panel,
                body.has-custom-bg .panel-content,
                body.has-custom-bg .panel-header,
                body.has-custom-bg .file-tree,
                body.has-custom-bg .sidebar-resizer {
                    background-color: transparent !important;
                    background: transparent !important;
                }

                body.has-custom-bg .samples-content,
                body.has-custom-bg .compare-content,
                body.has-custom-bg .debug-content {
                    background-color: transparent !important;
                    background: transparent !important;
                }

                body.has-custom-bg .debug-sidebar,
                body.has-custom-bg .debug-header,
                body.has-custom-bg .debug-toolbar,
                body.has-custom-bg .debug-section,
                body.has-custom-bg .debug-section h4,
                body.has-custom-bg .debug-mini-wrap,
                body.has-custom-bg .variables-panel,
                body.has-custom-bg .variable-item:hover {
                    background-color: transparent !important;
                    background: transparent !important;
                }

                body.has-custom-bg .markdown-preview-container,
                body.has-custom-bg .markdown-body {
                    background-color: transparent !important;
                    background: transparent !important;
                }

                body.has-custom-bg .titlebar {
                    background-color: rgba(50, 50, 51, 0.8) !important;
                }
                body.has-custom-bg[data-editor-theme="light"] .titlebar {
                    background-color: rgba(243, 243, 243, 0.8) !important;
                }
            `;
        }
        else {
            document.body.style.backgroundImage = '';
            document.body.classList.remove('has-custom-bg');
            const styleEl = document.getElementById('custom-bg-style');
            if (styleEl)
                styleEl.remove();
        }
    }
    const event = new CustomEvent('settings-applied', {
        detail: settings
    });
    document.dispatchEvent(event);
}
window.applySettings = applySettingsToUI;
window.getCurrentSettings = async function () {
    try {
        if (window.electronAPI && window.electronAPI.getAllSettings) {
            return await window.electronAPI.getAllSettings();
        }
        return {};
    }
    catch (error) {
        logError('获取当前设置失败:', error);
        return {};
    }
};
window.updateSettings = async function (newSettings) {
    try {
        if (window.electronAPI && window.electronAPI.updateSettings) {
            const result = await window.electronAPI.updateSettings(newSettings);
            if (result?.success) {
                logInfo('设置更新成功');
                return true;
            }
            else {
                logError('设置更新失败:', result?.error);
                return false;
            }
        }
        return false;
    }
    catch (error) {
        logError('更新设置失败:', error);
        return false;
    }
};
logInfo('设置初始化脚本已加载');
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { applySettingsToUI };
}
