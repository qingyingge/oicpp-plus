class BackupSettings {
    constructor() {
        this.settings = {
            autoBackupSettings: false,
            theme: 'dark'
        };
        this._saving = false;
        this._latestBackupState = { type: 'unavailable' };
    }

    async init() {
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

    setupThemeListener() {
        if (window.electronIPC && window.electronIPC.on) {
            window.electronIPC.on('theme-changed', (_event, theme) => {
                this.applyTheme(theme);
            });
        }

        if (window.electronIPC && window.electronIPC.on) {
            window.electronIPC.on('settings-imported', (_event, allSettings) => {
                if (allSettings && typeof allSettings.autoBackupSettings === 'boolean') {
                    this.settings.autoBackupSettings = allSettings.autoBackupSettings;
                    this.updateUI();
                }
            });
        }
    }

    setupLanguageListener() {
        if (!window.i18n || typeof window.i18n.onChange !== 'function') {
            return;
        }

        window.i18n.onChange(() => {
            this.renderLatestBackupInfo();
        });
    }

    applyTheme(theme) {
        this.settings.theme = theme || 'dark';
        document.body.setAttribute('data-theme', this.settings.theme);
        document.documentElement.setAttribute('data-theme', this.settings.theme);
    }

    setupEventListeners() {
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

    async loadSettings() {
        try {
            let allSettings = null;
            if (window.electronAPI && window.electronAPI.getAllSettings) {
                allSettings = await window.electronAPI.getAllSettings();
            } else if (typeof require !== 'undefined') {
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

    updateUI() {
        const autoBackupCheckbox = document.getElementById('auto-backup-settings');
        if (autoBackupCheckbox) {
            autoBackupCheckbox.checked = this.settings.autoBackupSettings === true;
        }
    }

    setLatestBackupState(type, params = {}) {
        this._latestBackupState = { type, params };
        this.renderLatestBackupInfo();
    }

    renderLatestBackupInfo() {
        if (!this.latestInfoEl) return;

        const { type, params } = this._latestBackupState;
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
                this.latestInfoEl.textContent = window.i18n.t('backup.latestInfo', {
                    timeLabel: params.timeLabel || window.i18n.t('backup.unknownTime'),
                    deviceName: params.deviceName || window.i18n.t('backup.unknownDevice')
                });
                break;
            default:
                this.latestInfoEl.textContent = window.i18n.t('backup.latestBackup');
        }
    }

    async refreshLatestBackupInfo() {
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

    collectSettings() {
        const autoBackupCheckbox = document.getElementById('auto-backup-settings');
        return {
            autoBackupSettings: !!autoBackupCheckbox?.checked
        };
    }

    async saveSettings() {
        if (this._saving) return;
        this._saving = true;
        try {
            const newSettings = this.collectSettings();
            let result = null;
            if (window.electronAPI && window.electronAPI.updateSettings) {
                result = await window.electronAPI.updateSettings(newSettings);
            } else if (typeof require !== 'undefined') {
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
            this.showMessage(window.i18n.t('backup.saveFailSimple', { error: error.message }), 'error');
        } finally {
            this._saving = false;
        }
    }

    async backupNow(silent = false) {
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

    async syncFromCloud() {
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

    escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    async confirmDialog(title, message) {
        if (window.dialogManager?.showConfirmDialog) {
            return await window.dialogManager.showConfirmDialog(title, message);
        }
        return window.confirm(message);
    }

    showMessage(message, type = 'info') {
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
