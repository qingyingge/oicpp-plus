/**
 * 渲染层 备份/还原 设置管理。
 *
 * 全局脚本形态：由 backup.html 的 `<script src="backup.js">` 加载。文件内不得出现
 * import/export（含 `export {};`），否则 tsc 会 emit
 * `Object.defineProperty(exports, "__esModule", { value: true });`，而浏览器脚本标签下
 * `exports` 未定义 → 整页在加载期就抛错。本文件不挂 window，
 * 由文件尾的 DOMContentLoaded 监听自建实例。
 *
 * 所有对 window.i18n.t 的调用严格限定两参（key, params）。
 * 第三个参数会被静默丢弃，需兜底请用 `window.i18n?.t?.(key) || '文案'` 形式。
 */

/** 主进程下发的备份元信息 */
type BackupInfo = { displayTime?: string; timestampRaw?: string; deviceName?: string; timeLabel?: string };

/** IPC 通用成功/失败信封 */
type BackupIpcResult = { success?: boolean; error?: string };

/** 本页面实际从 getAllSettings 读到的字段 */
type BackupLoadedSettings = { autoBackupSettings?: unknown; theme?: string };

class BackupSettings {
    /** 当前设置项 */
    private declare settings: {
        autoBackupSettings: boolean;
        theme: string;
    };
    /** 正在保存标志 */
    private declare _saving: boolean;
    /** 最新备份状态 */
    private declare _latestBackupState: { type: string; params?: BackupInfo };

    constructor() {
        this.settings = {
            autoBackupSettings: false,
            theme: 'dark'
        };
        this._saving = false;
        this._latestBackupState = { type: 'unavailable' };
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
        this.refreshLatestBackupInfo();
    }

    /** 最近信息 DOM 元素缓存 */
    private declare latestInfoEl: HTMLElement | null;

    /** 设置主题监听器 */
    private setupThemeListener(): void {
        if (window.electronIPC && window.electronIPC.on) {
            window.electronIPC.on('theme-changed', (_event: unknown, theme: string) => {
                this.applyTheme(theme);
            });
        }

        if (window.electronIPC && window.electronIPC.on) {
            window.electronIPC.on('settings-imported', (_event: unknown, allSettings: { autoBackupSettings?: boolean }) => {
                if (allSettings && typeof allSettings.autoBackupSettings === 'boolean') {
                    this.settings.autoBackupSettings = allSettings.autoBackupSettings;
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
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                this.saveSettings();
            });
        }

        const cancelBtn = document.getElementById('cancel-settings');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                window.close();
            });
        }

        const backupBtn = document.getElementById('backup-now');
        if (backupBtn) {
            backupBtn.addEventListener('click', async () => {
                await this.backupNow();
            });
        }

        const syncBtn = document.getElementById('sync-settings');
        if (syncBtn) {
            syncBtn.addEventListener('click', async () => {
                await this.syncFromCloud();
            });
        }
    }

    /** 加载设置 */
    private async loadSettings(): Promise<void> {
        try {
            let allSettings: BackupLoadedSettings | null = null;
            if (window.electronAPI && window.electronAPI.getAllSettings) {
                allSettings = await window.electronAPI.getAllSettings();
            } else if (typeof require !== 'undefined') {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { ipcRenderer } = require('electron');
                allSettings = await ipcRenderer.invoke('get-all-settings');
            }

            if (allSettings) {
                this.settings.autoBackupSettings = allSettings.autoBackupSettings === true;
                if (allSettings.theme) {
                    this.applyTheme(allSettings.theme);
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
    private setLatestBackupState(type: string, params: BackupInfo = {}): void {
        this._latestBackupState = { type, params };
        this.renderLatestBackupInfo();
    }

    /** 渲染最新备份信息 */
    private renderLatestBackupInfo(): void {
        if (!this.latestInfoEl) return;

        const { type, params } = this._latestBackupState as { type: string; params: BackupInfo };
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
                    deviceName: params.deviceName || window.i18n.t('backup.unknownDevice')
                });
                break;
            default:
                this.latestInfoEl.textContent = window.i18n.t('backup.latestBackup');
        }
    }

    private async refreshLatestBackupInfo(): Promise<void> {
        if (!this.latestInfoEl) return;
        if (!window.electronAPI?.getSettingsBackupInfo) {
            this.setLatestBackupState('unavailable');
            return;
        }

        try {
            const result = await window.electronAPI.getSettingsBackupInfo();
            if (!result || !result.success) {
                const error = result?.error || 'UNKNOWN';
                if (error === 'NOT_LOGGED_IN') {
                    this.setLatestBackupState('notLoggedIn');
                } else if (error === 'NO_BACKUP') {
                    this.setLatestBackupState('none');
                } else {
                    this.setLatestBackupState('failed');
                }
                return;
            }

            const info = result.info || {};
            this.setLatestBackupState('info', {
                timeLabel: info.displayTime || info.timestampRaw,
                deviceName: info.deviceName
            });
        } catch (error) {
            logError('获取最近备份信息失败:', error);
            this.setLatestBackupState('failed');
        }
    }

    /** 收集当前设置 */
    private collectSettings(): { autoBackupSettings: boolean } {
        const autoBackupCheckbox = document.getElementById('auto-backup-settings');
        return {
            autoBackupSettings: (autoBackupCheckbox instanceof HTMLInputElement) ? !!autoBackupCheckbox.checked : false
        };
    }

    /** 保存设置 */
    private async saveSettings(): Promise<void> {
        if (this._saving) return;
        this._saving = true;
        try {
            const newSettings = this.collectSettings();
            let result: BackupIpcResult | null = null;
            if (window.electronAPI && window.electronAPI.updateSettings) {
                result = await window.electronAPI.updateSettings(newSettings);
            } else if (typeof require !== 'undefined') {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const { ipcRenderer } = require('electron');
                result = await ipcRenderer.invoke('update-settings', newSettings);
            }

            if (result && result.success) {
                this.settings.autoBackupSettings = newSettings.autoBackupSettings;
                this.showMessage(window.i18n.t('backup.saveSuccess'), 'success');
                if (newSettings.autoBackupSettings) {
                    await this.backupNow(true);
                }
            } else {
                const errorMsg = result?.error || window.i18n.t('backup.unknownError');
                this.showMessage(window.i18n.t('backup.saveFail', { error: errorMsg }), 'error');
            }
        } catch (error) {
            logError('保存备份设置失败:', error);
            this.showMessage(window.i18n.t('backup.saveFailSimple', { error: (error as Error).message }), 'error');
        } finally {
            this._saving = false;
        }
    }

    /** 立即备份 */
    private async backupNow(silent: boolean = false): Promise<boolean> {
        if (!window.electronAPI?.backupSettingsToCloud) {
            if (!silent) this.showMessage(window.i18n.t('backup.backupUnavailable'), 'error');
            return false;
        }

        const result = await window.electronAPI.backupSettingsToCloud();
        if (!result || !result.success) {
            const error = result?.error;
            if (error === 'NOT_LOGGED_IN') {
                this.showMessage(window.i18n.t('backup.loginFirst'), 'warning');
            } else if (error === 'NO_SETTINGS') {
                if (!silent) this.showMessage(window.i18n.t('backup.nothingToBackup'), 'warning');
            } else {
                const errorMsg = error || window.i18n.t('backup.unknownError');
                if (!silent) this.showMessage(window.i18n.t('backup.backupFailSimple', { error: errorMsg }), 'error');
            }
            return false;
        }

        if (!silent) {
            this.showMessage(window.i18n.t('backup.backupSuccess'), 'success');
        }
        this.refreshLatestBackupInfo();
        return true;
    }

    /** 从云端同步 */
    private async syncFromCloud(): Promise<boolean> {
        if (!window.electronAPI?.getSettingsBackupInfo || !window.electronAPI?.syncSettingsFromCloud) {
            this.showMessage(window.i18n.t('backup.syncUnavailable'), 'error');
            return false;
        }

        const infoResult = await window.electronAPI.getSettingsBackupInfo();
        if (!infoResult || !infoResult.success) {
            logInfo('获取云端备份信息失败:', infoResult);
            const error = infoResult?.error;
            if (error === 'NOT_LOGGED_IN') {
                this.showMessage(window.i18n.t('backup.loginFirst'), 'warning');
            } else if (error === 'NO_BACKUP') {
                this.showMessage(window.i18n.t('backup.noBackupFound'), 'warning');
            } else {
                this.showMessage(window.i18n.t('backup.fetchBackupFail'), 'error');
            }
            return false;
        }

        const info = infoResult.info || {};
        const timeLabel = info.displayTime || info.timestampRaw || window.i18n.t('backup.unknownTime');
        const deviceName = info.deviceName || window.i18n.t('backup.unknownDevice');
        // 必须两参：key + params 对象，严禁第三实参
        const confirmText = window.i18n.t('backup.syncConfirm', {
            time: this.escapeHtml(timeLabel),
            device: this.escapeHtml(deviceName)
        });
        const confirmed = await this.confirmDialog(window.i18n.t('backup.syncConfirmTitle'), confirmText);
        if (!confirmed) {
            return false;
        }

        const syncResult = await window.electronAPI.syncSettingsFromCloud();
        if (!syncResult || !syncResult.success) {
            const error = syncResult?.error;
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
        this.refreshLatestBackupInfo();
        return true;
    }

    /** HTML 转义 */
    private escapeHtml(value: unknown): string {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** 确认对话框 */
    private async confirmDialog(title: string, message: string): Promise<boolean> {
        if (window.dialogManager?.showConfirmDialog) {
            return await window.dialogManager.showConfirmDialog(title, message) ?? false;
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

window.addEventListener('DOMContentLoaded', async () => {
    if (window.i18n && typeof window.i18n.init === 'function') {
        await window.i18n.init();
    }
    const backupSettings = new BackupSettings();
    await backupSettings.init();
});
