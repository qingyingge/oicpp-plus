const { ipcRenderer } = require('electron');

class TemplatesSettings {
    constructor() {
        this.settings = {
            cppTemplate: ''
        };
        this.snippets = [];
    }

    async init() {
        logInfo('初始化模板设置页面');
        const urlParams = new URLSearchParams(window.location.search);
        const themeFromUrl = urlParams.get('theme');
        if (themeFromUrl) {
            this.applyTheme(themeFromUrl);
        }
        await this.loadSettings();
        this.setupEventListeners();
        this.setupSidebarNavigation();
        this.setupThemeListener();
        this.setupLanguageListener();
        await this.applyCurrentTheme();
        this.updateUI();
    }

    setupSidebarNavigation() {
        const sidebarItems = document.querySelectorAll('.sidebar-item');
        const sections = document.querySelectorAll('.settings-section');

        sidebarItems.forEach(item => {
            item.addEventListener('click', () => {
                sidebarItems.forEach(i => i.classList.remove('active'));
                item.classList.add('active');

                sections.forEach(section => section.classList.remove('active'));
                
                const targetId = item.getAttribute('data-target');
                const targetSection = document.getElementById(targetId);
                if (targetSection) {
                    targetSection.classList.add('active');
                }
            });
        });
    }

    setupThemeListener() {
        if (window.electronIPC && window.electronIPC.on) {
            window.electronIPC.on('theme-changed', (event, theme) => {
                logInfo('代码模板设置页面收到主题变更:', theme);
                this.applyTheme(theme);
            });
        }
    }

    setupLanguageListener() {
        if (!window.i18n || typeof window.i18n.onChange !== 'function') {
            return;
        }

        window.i18n.onChange(() => {
            this.renderSnippets();
            queueMicrotask(() => this.updateSnippetDialogLabels());
        });
    }

    async applyCurrentTheme() {
        try {
            if (window.electronAPI && window.electronAPI.getAllSettings) {
                const settings = await window.electronAPI.getAllSettings();
                if (settings && settings.theme) {
                    this.applyTheme(settings.theme);
                }
            }
        } catch (error) {
            logError('获取主题设置失败:', error);
        }
    }

    applyTheme(theme) {
        logInfo('应用主题到代码模板设置页面:', theme);
        
        document.body.setAttribute('data-theme', theme);
        document.documentElement.setAttribute('data-theme', theme);
    }

    setupEventListeners() {
        logInfo('设置事件监听器');
        
        const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '');
        const modKey = (e) => (isMac ? e.metaKey : e.ctrlKey);

        const saveBtn = document.getElementById('save-settings');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                this.saveSettings();
            });
        }
        
        const cancelBtn = document.getElementById('cancel-settings');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                this.closeWindow();
            });
        }
        
        const resetBtn = document.getElementById('reset-settings');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this.resetSettings();
            });
        }
        
        const previewBtn = document.getElementById('preview-template');
        if (previewBtn) {
            previewBtn.addEventListener('click', () => {
                this.showPreview();
            });
        }

        // 打开片段添加弹窗
        const addBtn = document.getElementById('add-snippet');
        if (addBtn) {
            addBtn.addEventListener('click', () => this.openSnippetDialog(-1));
        }

        // 关闭片段弹窗
        const closeSnippetDialogBtn = document.getElementById('close-snippet-dialog');
        if (closeSnippetDialogBtn) {
            closeSnippetDialogBtn.addEventListener('click', () => {
                this.closeSnippetDialog();
            });
        }

        const cancelSnippetBtn = document.getElementById('cancel-snippet-btn');
        if (cancelSnippetBtn) {
            cancelSnippetBtn.addEventListener('click', () => {
                this.closeSnippetDialog();
            });
        }

        const confirmSnippetBtn = document.getElementById('confirm-snippet-btn');
        if (confirmSnippetBtn) {
            confirmSnippetBtn.addEventListener('click', () => {
                this.confirmSnippetDialog();
            });
        }

        // 点击弹窗遮罩关闭
        const snippetDialog = document.getElementById('snippet-dialog');
        if (snippetDialog) {
            snippetDialog.addEventListener('click', (e) => {
                if (e.target === snippetDialog) {
                    this.closeSnippetDialog();
                }
            });
        }

        // 弹窗内 Ctrl/Cmd+Enter 确认
        const snippetDialogContent = document.getElementById('snippet-dialog-content');
        if (snippetDialogContent) {
            snippetDialogContent.addEventListener('keydown', (e) => {
                if (modKey(e) && e.key === 'Enter') {
                    e.preventDefault();
                    this.confirmSnippetDialog();
                }
            });
        }
        
        const closePreviewBtn = document.getElementById('close-preview');
        if (closePreviewBtn) {
            closePreviewBtn.addEventListener('click', () => {
                this.closePreview();
            });
        }
        
        const previewDialog = document.getElementById('preview-dialog');
        if (previewDialog) {
            previewDialog.addEventListener('click', (e) => {
                if (e.target === previewDialog) {
                    this.closePreview();
                }
            });
        }
        
        const cppTemplateTextarea = document.getElementById('cpp-template');
        if (cppTemplateTextarea) {
            cppTemplateTextarea.addEventListener('input', (e) => {
                this.settings.cppTemplate = e.target.value;
                logInfo('模板内容已更新');
            });
            
            cppTemplateTextarea.addEventListener('keydown', (e) => {
                // macOS 使用 Cmd+S，Windows/Linux 使用 Ctrl+S
                if (modKey(e) && e.key === 's') {
                    e.preventDefault();
                    this.saveSettings();
                }
                
                if (e.key === 'Tab') {
                    e.preventDefault();
                    const start = e.target.selectionStart;
                    const end = e.target.selectionEnd;
                    const value = e.target.value;
                    
                    e.target.value = value.substring(0, start) + '    ' + value.substring(end);
                    e.target.selectionStart = e.target.selectionEnd = start + 4;
                }
            });
        }

        // 监听全局键盘事件，支持 Cmd/Ctrl+S 在任意位置保存
        document.addEventListener('keydown', (e) => {
            if (modKey(e) && e.key === 's') {
                // 如果焦点在弹窗内的输入框，不触发全局保存
                const activeEl = document.activeElement;
                if (activeEl && activeEl.closest('#snippet-dialog')) {
                    return;
                }
                e.preventDefault();
                this.saveSettings();
            }
        });
    }


    async loadSettings() {
        try {
            logInfo('加载设置中...');
            
            if (window.electronAPI && window.electronAPI.getAllSettings) {
                const allSettings = await window.electronAPI.getAllSettings();
                if (allSettings) {
                    if (allSettings.cppTemplate) {
                        this.settings.cppTemplate = allSettings.cppTemplate;
                    }
                    if (Array.isArray(allSettings.codeSnippets)) {
                        this.snippets = allSettings.codeSnippets;
                    }
                    logInfo('从Electron API获取设置成功');
                }
            } else {
                logInfo('Electron API不可用，尝试使用ipcRenderer');
                
                const allSettings = await ipcRenderer.invoke('get-all-settings');
                if (allSettings) {
                    if (allSettings.cppTemplate) {
                        this.settings.cppTemplate = allSettings.cppTemplate;
                    }
                    if (Array.isArray(allSettings.codeSnippets)) {
                        this.snippets = allSettings.codeSnippets;
                    }
                    logInfo('从ipcRenderer获取设置成功');
                }
            }
            
            logInfo('模板设置加载完成:', this.settings);
        } catch (error) {
            logError('加载模板设置失败:', error);
            this.showMessage(window.i18n.t('templates.loadFail'), 'error');
        }
    }

    updateUI() {
        logInfo('更新UI界面');
        
        const cppTemplateTextarea = document.getElementById('cpp-template');
        if (cppTemplateTextarea) {
            cppTemplateTextarea.value = this.settings.cppTemplate;
            logInfo('模板内容已加载到编辑器');
        } else {
            logError('找不到模板编辑器元素');
        }
        this.renderSnippets();
    }

    async saveSettings() {
        try {
            logInfo('保存设置中...');
            
            const cppTemplateTextarea = document.getElementById('cpp-template');
            if (!cppTemplateTextarea) {
                throw new Error(window.i18n.t('templates.editorNotFound'));
            }
            
            const cppTemplate = cppTemplateTextarea.value.trim();
            
            // 允许文件模板为空，只要有关键词代码片段即可保存
            if (!cppTemplate && (!this.snippets || this.snippets.length === 0)) {
                this.showMessage(window.i18n.t('templates.saveTemplateFail'), 'error');
                return;
            }
            
            const newSettings = {
                cppTemplate: cppTemplate,
                codeSnippets: this.snippets
            };
            
            logInfo('准备保存的设置:', newSettings);
            
            let result;
            if (window.electronAPI && window.electronAPI.updateSettings) {
                result = await window.electronAPI.updateSettings(newSettings);
            } else {
                result = await ipcRenderer.invoke('update-settings', newSettings);
            }
            
            if (result && result.success) {
                this.showMessage(window.i18n.t('templates.saveSuccess'), 'success');
                logInfo('设置保存成功');
            } else {
                const errorMsg = result?.error || window.i18n.t('templates.unknownError');
                this.showMessage(window.i18n.t('templates.saveFail', { error: errorMsg }), 'error');
                logError('保存设置失败:', errorMsg);
            }
            
        } catch (error) {
            logError('保存模板设置失败:', error);
            this.showMessage(window.i18n.t('templates.saveFail', { error: error.message }), 'error');
        }
    }

    async resetSettings() {
        try {
            logInfo('重置设置中...');
            
            if (window.confirm(window.i18n.t('templates.resetConfirm'))) {
                const defaultTemplate = '';
                this.settings.cppTemplate = defaultTemplate;
                this.snippets = [];
                this.renderSnippets();
                
                const cppTemplateTextarea = document.getElementById('cpp-template');
                if (cppTemplateTextarea) {
                    cppTemplateTextarea.value = defaultTemplate;
                }
                
                const newSettings = { cppTemplate: defaultTemplate, codeSnippets: [] };
                
                let result;
                if (window.electronAPI && window.electronAPI.updateSettings) {
                    result = await window.electronAPI.updateSettings(newSettings);
                } else {
                    result = await ipcRenderer.invoke('update-settings', newSettings);
                }
                
                if (result && result.success) {
                    this.showMessage(window.i18n.t('templates.resetSuccess'), 'success');
                    logInfo('设置重置成功');
                } else {
                    const errorMsg = result?.error || window.i18n.t('templates.unknownError');
                    this.showMessage(window.i18n.t('templates.resetFail', { error: errorMsg }), 'error');
                }
            }
        } catch (error) {
            logError('重置设置失败:', error);
            this.showMessage(window.i18n.t('templates.resetFail', { error: error.message }), 'error');
        }
    }

    // 打开片段添加/编辑弹窗
    openSnippetDialog(editIndex = -1) {
        const dialog = document.getElementById('snippet-dialog');
        if (!dialog) return;

        const kwEl = document.getElementById('snippet-dialog-keyword');
        const descEl = document.getElementById('snippet-dialog-desc');
        const contentEl = document.getElementById('snippet-dialog-content');

        // 如果是编辑模式，加载已有数据
        if (editIndex >= 0 && editIndex < this.snippets.length) {
            const item = this.snippets[editIndex];
            if (kwEl) kwEl.value = item.keyword || '';
            if (descEl) descEl.value = item.description || '';
            if (contentEl) contentEl.value = item.content || '';
            dialog.setAttribute('data-edit-index', editIndex);
        } else {
            if (kwEl) kwEl.value = '';
            if (descEl) descEl.value = '';
            if (contentEl) contentEl.value = '';
            dialog.removeAttribute('data-edit-index');
        }

        this.updateSnippetDialogLabels(editIndex);
        dialog.style.display = 'block';
        // 自动聚焦到关键词输入框
        setTimeout(() => {
            if (kwEl) kwEl.focus();
        }, 100);
    }

    updateSnippetDialogLabels(editIndex = null) {
        const dialog = document.getElementById('snippet-dialog');
        const resolvedEditIndex = editIndex === null && dialog
            ? parseInt(dialog.getAttribute('data-edit-index'), 10)
            : editIndex;
        const isEditing = Number.isFinite(resolvedEditIndex) && resolvedEditIndex >= 0;

        const titleEl = document.getElementById('snippet-dialog-title');
        const confirmBtn = document.getElementById('confirm-snippet-btn');
        if (titleEl) {
            titleEl.textContent = window.i18n.t(isEditing ? 'templates.snippetDialogEditTitle' : 'templates.snippetDialogTitle');
        }
        if (confirmBtn) {
            confirmBtn.textContent = window.i18n.t(isEditing ? 'templates.snippetConfirmEdit' : 'templates.snippetConfirm');
        }
    }

    closeSnippetDialog() {
        const dialog = document.getElementById('snippet-dialog');
        if (dialog) {
            dialog.style.display = 'none';
        }
    }

    confirmSnippetDialog() {
        const kwEl = document.getElementById('snippet-dialog-keyword');
        const descEl = document.getElementById('snippet-dialog-desc');
        const contentEl = document.getElementById('snippet-dialog-content');
        const keyword = (kwEl?.value || '').trim();
        const description = (descEl?.value || '').trim() || window.i18n.t('templates.defaultDesc');
        const content = (contentEl?.value || '').trim();

        if (!keyword) {
            this.showMessage(window.i18n.t('templates.needKeyword'), 'warning');
            if (kwEl) kwEl.focus();
            return;
        }
        if (!content) {
            this.showMessage(window.i18n.t('templates.needContent'), 'warning');
            if (contentEl) contentEl.focus();
            return;
        }

        const dialog = document.getElementById('snippet-dialog');
        const editIndex = dialog ? parseInt(dialog.getAttribute('data-edit-index'), 10) : -1;

        if (Number.isFinite(editIndex) && editIndex >= 0 && editIndex < this.snippets.length) {
            // 编辑模式：更新已有片段
            this.snippets[editIndex] = { keyword, description, content };
            this.showMessage(window.i18n.t('templates.snippetUpdated'), 'success');
        } else {
            // 添加模式：检查重复关键词
            const idx = this.snippets.findIndex(s => (s.keyword || '').toLowerCase() === keyword.toLowerCase());
            if (idx >= 0) {
                this.snippets[idx] = { keyword, description, content };
                this.showMessage(window.i18n.t('templates.snippetOverwritten'), 'success');
            } else {
                this.snippets.push({ keyword, description, content });
                this.showMessage(window.i18n.t('templates.snippetAdded'), 'success');
            }
        }

        this.closeSnippetDialog();
        this.renderSnippets();
    }

    renderSnippets() {
        const list = document.getElementById('snippets-list');
        if (!list) return;

        if (!this.snippets || this.snippets.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.style.cssText = 'opacity:.8; font-size:12px; padding:6px;';
            emptyState.textContent = window.i18n.t('templates.emptySnippetList');
            list.replaceChildren(emptyState);
            return;
        }

        const rows = this.snippets.map((snippet, index) => {
            const row = document.createElement('div');
            row.className = 'snippet-row';
            row.dataset.index = String(index);
            row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--settings-border);';

            const keyword = String(snippet.keyword || '');
            const keywordEl = document.createElement('div');
            keywordEl.style.cssText = 'flex:0 0 160px; font-weight:600;';
            keywordEl.textContent = keyword;

            const description = document.createElement('div');
            description.style.cssText = 'flex:1; opacity:.85;';
            description.textContent = String(snippet.description || '').trim() || window.i18n.t('templates.defaultDesc');

            const editButton = document.createElement('button');
            editButton.type = 'button';
            editButton.className = 'preview-btn';
            editButton.dataset.action = 'edit';
            editButton.style.background = '#6c757d';
            editButton.textContent = window.i18n.t('templates.edit');
            editButton.setAttribute('aria-label', `${window.i18n.t('templates.edit')}: ${keyword}`);

            const deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'preview-btn';
            deleteButton.dataset.action = 'delete';
            deleteButton.style.background = '#dc3545';
            deleteButton.textContent = window.i18n.t('templates.delete');
            deleteButton.setAttribute('aria-label', `${window.i18n.t('templates.delete')}: ${keyword}`);

            row.appendChild(keywordEl);
            row.appendChild(description);
            row.appendChild(editButton);
            row.appendChild(deleteButton);
            return row;
        });

        list.replaceChildren(...rows);
        list.querySelectorAll('button[data-action]').forEach((button) => {
            button.addEventListener('click', () => {
                const row = button.closest('.snippet-row');
                const index = parseInt(row?.dataset.index || '-1', 10);
                if (Number.isNaN(index) || index < 0) return;

                if (button.dataset.action === 'delete') {
                    this.snippets.splice(index, 1);
                    this.renderSnippets();
                } else if (button.dataset.action === 'edit') {
                    this.openSnippetDialog(index);
                }
            });
        });
    }

    showPreview() {
        logInfo('显示模板预览');
        
        const cppTemplateTextarea = document.getElementById('cpp-template');
        if (!cppTemplateTextarea) {
            this.showMessage(window.i18n.t('templates.templateNotFound'), 'error');
            return;
        }
        
        const templateContent = cppTemplateTextarea.value || window.i18n.t('templates.templateEmpty');
        
        const previewContent = document.getElementById('preview-content');
        if (previewContent) {
            previewContent.textContent = templateContent;
        }
        
        const previewDialog = document.getElementById('preview-dialog');
        if (previewDialog) {
            previewDialog.style.display = 'block';
        }
    }

    closePreview() {
        logInfo('关闭模板预览');
        
        const previewDialog = document.getElementById('preview-dialog');
        if (previewDialog) {
            previewDialog.style.display = 'none';
        }
    }

    showMessage(message, type = 'info') {
        logInfo(`显示消息: [${type}] ${message}`);
        
        const existingToast = document.querySelector('.message-toast');
        if (existingToast) {
            existingToast.remove();
        }
        
        const messageDiv = document.createElement('div');
        messageDiv.className = `message-toast ${type}`;
        messageDiv.textContent = message;
        try {
            if (type === 'error') {
                const errObj = message instanceof Error ? message : new Error(String(message));
                logError('[TemplateSettingsToastError]', { message: String(message), stack: errObj.stack });
            }
        } catch (_) {}

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

    closeWindow() {
        logInfo('关闭窗口');
        
        if (window.close) {
            window.close();
        } else {
            logWarn('window.close 不可用');
        }
    }
}

window.addEventListener('DOMContentLoaded', async () => {
    logInfo('DOM加载完成，初始化模板设置');
    
    try {
        if (window.i18n && typeof window.i18n.init === 'function') {
            await window.i18n.init();
        }
        const templatesSettings = new TemplatesSettings();
        await templatesSettings.init();
    } catch (error) {
        logError('初始化模板设置失败:', error);
    }
});

window.TemplatesSettings = TemplatesSettings;
