/**
 * 渲染层 备份/还原 设置管理。
 *
 * 以「脚本」形式参与构建（无 import/export）——在渲染层经 script 标签加载后挂到
 * window.BackupSettings；同时 tests/backup.test.js 用 require() 直接加载本文件
 * （Node 下 module 存在），因此文件尾用 guarded if/else 同时兼容两种宿主：
 * 有 module.exports 时走 CommonJS 导出，否则挂到 window。
 *
 * 所有对 window.i18n.t 的调用严格限定两参（key, params）。
 * 第三个参数会被静默丢弃，需兜底请用 `window.i18n?.t?.(key) || '文案'` 形式。
 */

class BackupSettings {
    /** 当前设置项 */
    private settings: {
        autoBackupSettings: boolean;
        theme: string;
    };
    /** 正在保存标志 */
    private _saving: boolean;
    /** 最新备份状态 */
    private _latestBackupState: { type: string; params: Record<string, unknown> };

    constructor() {
        this.settings = {
            autoBackupSettings: false,
            theme: 'dark',
        };
        this._saving = false;
        this._latestBackupState = { type: 'unavailable', params: {} };
    }

    /**
     * 初始化：加载设置、监听器、主题、语言。
     * 必须在 DOMContentLoaded 后调用。
     */
    async init(): Promise<void> {
        const urlParams = new URLSearchParams(window.location.search);
        const themeFromUrl = urlParams.get('theme');
        if (themeFromUrl) {
            this.applyTheme(themeFromUrl);
        }
        await this.loadSettings();
        this.latestInfoEl = document.getElementById('latest-backup-info');
        this.latestInfoEl?.removeAttribute('data-i18n');
        this.setupEventListeners();
        this.setupThemeListener();
        this.setupLanguageListener();
        this.updateUI();
        this.renderLatestBackupInfo();
    }

    /** 最近信息 DOM 元素缓存 */
    private latestInfoEl: HTMLElement | null = null;

    /** 设置主题监听器 */
    private setupThemeListener(): void {
        if (window.electronIPC && typeof window.electronIPC.on === 'function') {
            window.electronIPC.on('theme-changed', (_event: unknown, theme: string) => {
                this.applyTheme(theme);
            });
        }

        if (window.electronIPC && typeof window.electronIPC.on === 'function') {
            window.electronIPC.on('settings-imported', (_event: unknown, allSettings: unknown) => {
                if (allSettings && typeof allSettings === 'object' && 'autoBackupSettings' in allSettings && typeof (allSettings as { autoBackupSettings: unknown }).autoBackupSettings === 'boolean') {
                    this.settings.autoBackupSettings = (allSettings as { autoBackupSettings: boolean }).autoBackupSettings;
                    this.updateUI();
                }
            });
        }
    }

    /** 设置语言监听器 */
    private setupLanguageListener(): void {
        if (!window.i18n || typeof window.i18n.onChange !== 'function') {
            return;
        }

        window.i18n.onChange(() => {
            this.renderLatestBackupInfo();
        });
    }

    /** 应用主题 */
    private applyTheme(theme: string): void {
        this.settings.theme = theme || 'dark';
        document.body.setAttribute('data-theme', this.settings.theme);
        document.documentElement.setAttribute('data-theme', this.settings.theme);
    }

    /** 设置事件监听器 */
    private setupEventListeners(): void {
        const saveBtn = document.getElementById('save-settings');
        if (saveBtn instanceof HTMLButtonElement) {
            saveBtn.addEventListener('click', () => {
                this.saveSettings();
            });
        }

        const cancelBtn = document.getElementById('cancel-settings');
        if (cancelBtn instanceof HTMLButtonElement) {
            cancelBtn.addEventListener('click', () => {
                window.close();
            });
        }

        const backupBtn = document.getElementById('backup-now');
        if (backupBtn instanceof HTMLButtonElement) {
            backupBtn.addEventListener('click', async () => {
                await this.backupNow();
            });
        }

        const syncBtn = document.getElementById('sync-settings');
        if (syncBtn instanceof HTMLButtonElement) {
            syncBtn.addEventListener('click', async () => {
                await this.syncFromCloud();
            });
        }
    }

    /** 加载设置 */
    private async loadSettings(): Promise<void> {
        try {
            let allSettings: unknown = null;
            if (window.electronAPI && typeof window.electronAPI.getAllSettings === 'function') {
                allSettings = await window.electronAPI.getAllSettings();
            } else if (typeof require !== 'undefined') {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { ipcRenderer } = require('electron');
                allSettings = await ipcRenderer.invoke('get-all-settings');
            }

            if (allSettings && typeof allSettings === 'object') {
                const settingsObj = allSettings as { autoBackupSettings?: unknown; theme?: unknown };
                this.settings.autoBackupSettings = settingsObj.autoBackupSettings === true;
                if (typeof settingsObj.theme === 'string') {
                    this.applyTheme(settingsObj.theme);
                }
            }
        } catch (error) {
            logError('加载设置备份配置失败:', error);
        }
    }

    /** 更新 UI */
    private updateUI(): void {
        const autoBackupCheckbox = document.getElementById('auto-backup-settings');
        if (autoBackupCheckbox instanceof HTMLInputElement) {
            autoBackupCheckbox.checked = this.settings.autoBackupSettings === true;
        }
    }

    /** 设置最新备份状态 */
    private setLatestBackupState(type: string, params: Record<string, unknown> = {}): void {
        this._latestBackupState = { type, params };
        this.renderLatestBackupInfo();
    }

    /** 渲染最新备份信息 */
    private renderLatestBackupInfo(): void {
        if (!this.latestInfoEl) return;

        const { type, params } = this._latestBackupState;
        // 严禁给 window.i18n.t 传第三个参数，见项目 i18n 规则
        switch (type) {
            case 'notLoggedIn':
                this.latestInfoEl.textContent = window.i18n.t('backup.latestNotLoggedIn');
                break;
            case 'none':
                this.latestInfoEl.textContent = window.i18n.t('backup.latestNone');
                break;
            case 'failed':
                this.latestInfoEl.textContent = window.i18n.t('backup.latestFetchFailed');
                break;
            case 'info':
                // params 参数必须精确匹配 t() 定义，不得多传/少传
                this.latestInfoEl.textContent = window.i18n.t('backup.latestInfo', {
                    timeLabel: params.timeLabel || window.i18n.t('backup.unknownTime'),
                    deviceName: params.deviceName || window.i18n.t('backup.unknownDevice'),
                });
                break;
            default:
                this.latestInfoEl.textContent = window.i18n.t('backup.latestBackup');
        }
    }

    /** 收集当前设置 */
    private collectSettings(): { autoBackupSettings: boolean } {
        const autoBackupCheckbox = document.getElementById('auto-backup-settings');
        return {
            autoBackupSettings: (autoBackupCheckbox instanceof HTMLInputElement) ? !!autoBackupCheckbox.checked : false,
        };
    }

    /** 保存设置 */
    private async saveSettings(): Promise<void> {
        if (this._saving) return;
        this._saving = true;
        try {
            const newSettings = this.collectSettings();
            let result: unknown = null;
            if (window.electronAPI && typeof window.electronAPI.updateSettings === 'function') {
                result = await window.electronAPI.updateSettings(newSettings);
            } else if (typeof require !== 'undefined') {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { ipcRenderer } = require('electron');
                result = await ipcRenderer.invoke('update-settings', newSettings);
            }

            if (result && typeof result === 'object' && 'success' in result) {
                const success = (result as { success: unknown }).success;
                if (success) {
                    this.settings.autoBackupSettings = newSettings.autoBackupSettings;
                    this.showMessage(window.i18n.t('backup.saveSuccess'), 'success');
                    if (newSettings.autoBackupSettings) {
                        await this.backupNow(true);
                    }
                } else {
                    const errorMsg: string = typeof result === 'object' && 'error' in result
                        ? String((result as { error?: unknown }).error || '')
                        : window.i18n.t('backup.unknownError');
                    this.showMessage(window.i18n.t('backup.saveFail', { error: errorMsg }), 'error');
                }
            }
        } catch (error) {
            logError('保存备份设置失败:', error);
            this.showMessage(window.i18n.t('backup.saveFailSimple', { error: String(error) }), 'error');
        } finally {
            this._saving = false;
        }
    }

    /** 立即备份 */
    private async backupNow(silent: boolean = false): Promise<boolean> {
        if (!window.electronAPI?.backupSettingsToCloud) {
            if (!silent) this.showMessage(window.i18n.t('backup.backupUnavailable'), 'error');
            return;
        }

        const result = await window.electronAPI.backupSettingsToCloud();
        if (!result || typeof result !== 'object' || !('success' in result) || !(result as { success: boolean }).success) {
            const error: string = result?.error || 'UNKNOWN';
            if (error === 'NOT_LOGGED_IN') {
                this.showMessage(window.i18n.t('backup.loginFirst'), 'warning');
            } else if (error === 'NO_SETTINGS') {
                if (!silent) this.showMessage(window.i18n.t('backup.nothingToBackup'), 'warning');
            } else {
                const errorMsg: string = error || window.i18n.t('backup.unknownError');
                if (!silent) this.showMessage(window.i18n.t('backup.backupFailSimple', { error: errorMsg }), 'error');
            }
            return;
        }

        if (!silent) {
            this.showMessage(window.i18n.t('backup.backupSuccess'), 'success');
        }
        this.renderLatestBackupInfo();
        return true;
    }

    /** 从云端同步 */
    private async syncFromCloud(): Promise<boolean> {
        if (!window.electronAPI?.getSettingsBackupInfo || !window.electronAPI?.syncSettingsFromCloud) {
            this.showMessage(window.i18n.t('backup.syncUnavailable'), 'error');
            return false;
        }

        const infoResult = await window.electronAPI.getSettingsBackupInfo();
        if (!infoResult || typeof infoResult !== 'object' || !('success' in infoResult) || !(infoResult as { success: boolean }).success) {
            logInfo('获取云端备份信息失败:', infoResult);
            const error: string = typeof infoResult === 'object' && infoResult !== null && 'error' in infoResult
                ? String((infoResult as { error?: unknown }).error || 'UNKNOWN')
                : 'UNKNOWN';
            if (error === 'NOT_LOGGED_IN') {
                this.showMessage(window.i18n.t('backup.loginFirst'), 'warning');
            } else if (error === 'NO_BACKUP') {
                this.showMessage(window.i18n.t('backup.noBackupFound'), 'warning');
            } else {
                this.showMessage(window.i18n.t('backup.fetchBackupFail'), 'error');
            }
            return false;
        }

        const info = (infoResult as { info?: Record<string, unknown> }).info || {};
        const timeLabel: string = String(info.displayTime || info.timestampRaw || window.i18n.t('backup.unknownTime'));
        const deviceName: string = String(info.deviceName || window.i18n.t('backup.unknownDevice'));
        // 必须两参：key + params 对象，严禁第三实参
        const confirmText: string = window.i18n.t('backup.syncConfirm', {
            time: this.escapeHtml(timeLabel),
            device: this.escapeHtml(deviceName),
        });
        const confirmed = await this.confirmDialog(window.i18n.t('backup.syncConfirmTitle'), confirmText);
        if (!confirmed) {
            return false;
        }

        const syncResult = await window.electronAPI.syncSettingsFromCloud();
        if (!syncResult || typeof syncResult !== 'object' || !('success' in syncResult) || !(syncResult as { success: boolean }).success) {
            const error: string = typeof syncResult === 'object' && syncResult !== null && 'error' in syncResult
                ? String((syncResult as { error?: unknown }).error || '')
                : '';
            if (error === 'NOT_LOGGED_IN') {
                this.showMessage(window.i18n.t('backup.loginFirst'), 'warning');
            } else if (error === 'NO_BACKUP') {
                this.showMessage(window.i18n.t('backup.noBackupFound'), 'warning');
            } else if (error === 'EMPTY_BACKUP') {
                this.showMessage(window.i18n.t('backup.restoreFailEmpty'), 'error');
            } else if (error === 'INVALID_BACKUP') {
                this.showMessage(window.i18n.t('backup.restoreFailInvalid'), 'error');
            } else if (error) {
                this.showMessage(window.i18n.t('backup.syncFail', { error }), 'error');
            } else {
                this.showMessage(window.i18n.t('backup.syncFailSimple'), 'error');
            }
            return false;
        }

        await this.loadSettings();
        this.updateUI();
        this.showMessage(window.i18n.t('backup.syncSuccess'), 'success');
        this.renderLatestBackupInfo();
        return true;
    }

    /** HTML 转义 */
    private escapeHtml(value: unknown): string {
        return String(value)
            .replace(/&/g, '&')
            .replace(/</g, '<')
            .replace(/>/g, '>')
            .replace(/"/g, '"')
    }

    /** 确认对话框 */
    private async confirmDialog(title: string, message: string): Promise<boolean> {
        if (window.dialogManager?.showConfirmDialog) {
            return await window.dialogManager.showConfirmDialog(title, message);
        }
        return window.confirm(message);
    }

    /** 显示消息 toast */
    private showMessage(message: string, type: string = 'info'): void {
        const existingToast = document.querySelector('.message-toast');
        if (existingToast) {
            existingToast.remove();
        }
        const messageDiv = document.createElement('div');
        messageDiv.className = `message-toast ${type}`;
        messageDiv.textContent = message;
        messageDiv.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            border-radius: 4px;
            color: white;
            font-weight: bold;
            z-index: 9999;
            opacity: 0;
            transition: opacity 0.3s;
        `;

        switch (type) {
            case 'success':
                messageDiv.style.backgroundColor = '#4CAF50';
                break;
            case 'error':
                messageDiv.style.backgroundColor = '#f44336';
                break;
            default:
                messageDiv.style.backgroundColor = '#2196F3';
        }

        document.body.appendChild(messageDiv);

        requestAnimationFrame(() => {
            messageDiv.style.opacity = '1';
        });

        setTimeout(() => {
            messageDiv.style.opacity = '0';
            setTimeout(() => {
                if (messageDiv.parentNode) {
                    messageDiv.parentNode.removeChild(messageDiv);
                }
            }, 300);
        }, 3000);
    }
}

// 导出 API
const api = {
    BackupSettings,
};

// 双模导出：Node/CJS 与 浏览器/ESM 兼容
if (typeof module !== 'undefined' && (module as { exports?: unknown }).exports) {
    (module as { exports: unknown }).exports = api;
} else if (typeof window !== 'undefined') {
    (window as unknown as { BackupSettings?: typeof BackupSettings }).BackupSettings = api.BackupSettings;
}

export {};