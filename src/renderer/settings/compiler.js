const elCtl = (id) => {
    const el = document.getElementById(id);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el instanceof HTMLButtonElement) return el;
    return null;
};
const elCheckbox = (id) => {
    const el = document.getElementById(id);
    return el instanceof HTMLInputElement && el.type === 'checkbox' ? el : null;
};
const setElValue = (id, v) => {
    const el = elCtl(id);
    if (el) el.value = v;
};
const elById = (id) => {
    const el = document.getElementById(id);
    return el instanceof HTMLElement ? el : null;
};
const evtValue = (e) => {
    const target = e && e.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return target.value;
    return '';
};
// 编译器/Testlib 列表下载依赖上游服务 oicpp.mywwzh.top，fork 需自建列表源
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 超时判定只看错误码，不匹配 message 文案（AGENTS.md 登记的反模式：
// 文案一改判定就静默失配）。axios 超时给 ECONNABORTED，Node 层给 ETIMEDOUT，
// fetch/axios 取消给 AbortError。
function isTimeoutError(error) {
    if (!error) return false;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    return error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
}

class CompilerSettings {
    constructor() {
        this.settings = {
            compilerPath: '',
            pythonInterpreterPath: '',
            compilerArgs: '-std=c++14 -O2 -static',
            runMode: 'popup'
        }
        this.isMacPlatform = false;
        this.isIntegratedOnlyPlatform = false;
        this._compilerListAbort = null;
        this._testlibListAbort = null;
        // loadSettings 成功后才为 true；false 表示加载失败，保存被阻断
        this._settingsLoaded = true;
        
        this.init();
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
                const targetSection = elCtl(targetId);
                if (targetSection) {
                    targetSection.classList.add('active');
                }
            });
        });
    }

    async init() {
        const urlParams = new URLSearchParams(window.location.search);
        const themeFromUrl = urlParams.get('theme');
        if (themeFromUrl) {
            this.applyTheme(themeFromUrl);
        }

        // 平台探测各走一次 IPC，任何一个 reject 都会让整条链断在这里，
        // setupEventListeners() 不执行 —— 表现是「设置窗口所有按钮都没反应」。
        // 因此逐项兜底：探测失败用 false，事件绑定无论如何都要跑。
        try {
            await this.loadSettings();
        } catch (error) {
            logError('[编译器设置] 加载设置失败，使用默认值:', error);
        }
        try {
            this.isMacPlatform = await this.detectMacPlatform();
        } catch (error) {
            logError('[编译器设置] 平台探测失败，按非 macOS 处理:', error);
            this.isMacPlatform = false;
        }
        try {
            this.isIntegratedOnlyPlatform = await this.detectIntegratedOnlyPlatform();
        } catch (error) {
            logError('[编译器设置] 集成终端平台探测失败:', error);
            this.isIntegratedOnlyPlatform = false;
        }
        if (this.isIntegratedOnlyPlatform) {
            this.settings.runMode = 'integrated-terminal';
        }

        // 事件绑定放在最后且不参与上面的失败链
        this.setupEventListeners();
        this.setupThemeListener();
        try {
            await this.applyCurrentTheme();
        } catch (error) {
            logError('[编译器设置] 应用主题失败:', error);
        }
        this.updateUI();
        this.detectExistingCompiler();
    }

    setupThemeListener() {
        if (window.electronIPC && window.electronIPC.on) {
            window.electronIPC.on('theme-changed', (event, theme) => {
                logInfo('编译器设置页面收到主题变更:', theme);
                this.applyTheme(theme);
            });
        }
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
        logInfo('应用主题到编译器设置页面:', theme);
        document.body.setAttribute('data-theme', theme);
        document.documentElement.setAttribute('data-theme', theme);
    }

    setupEventListeners() {
        if (this._eventListenersBound) return;
        this._eventListenersBound = true;
        logInfo('[编译器设置] 开始设置事件监听器');
        
        this.setupSidebarNavigation();
        
        const browseBtn = elCtl('browse-compiler');
        if (browseBtn) {
            logInfo('[编译器设置] 浏览编译器按钮事件已绑定');
            browseBtn.addEventListener('click', (e) => {
                logInfo('[编译器设置] 浏览编译器按钮被点击');
                e.preventDefault();
                this.browseCompiler();
            });
        } else {
            logError('[编译器设置] 未找到浏览编译器按钮');
        }

        const browsePythonBtn = elCtl('browse-python-interpreter');
        if (browsePythonBtn) {
            browsePythonBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.browsePythonInterpreter();
            });
        }

        const browseTestlibBtn = elCtl('browse-testlib');
        if (browseTestlibBtn) {
            browseTestlibBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.browseTestlib();
            });
        }
        
        const installBtn = elCtl('install-compiler');
        if (installBtn) {
            this.getCurrentPlatform().then(p => {
                if (p !== 'windows') {
                    installBtn.disabled = true;
                    installBtn.title = window.i18n.t('compiler.nonWindowsHint');
                    installBtn.textContent = window.i18n.t('compiler.downloadDisabled');
                } else {
                    logInfo('[编译器设置] 安装编译器按钮事件已绑定');
                    installBtn.addEventListener('click', (e) => {
                        logInfo('[编译器设置] 安装编译器按钮被点击');
                        e.preventDefault();
                        this.showInstallDialog();
                    });
                }
            });
        }
        
        const installTestlibBtn = elCtl('install-testlib');
        if (installTestlibBtn) {       
          installTestlibBtn.addEventListener('click', (e) => {
              e.preventDefault();
              this.showTestlibInstallDialog();
          });
        }
        
        const closeBtn = elCtl('close-install-dialog');
        if (closeBtn) {
            logInfo('[编译器设置] 关闭安装对话框按钮事件已绑定');
            closeBtn.addEventListener('click', (e) => {
                logInfo('[编译器设置] 关闭安装对话框按钮被点击');
                e.preventDefault();
                this.closeInstallDialog();
            });
        }
        
        const closeTestlibBtn = elCtl('close-testlib-install-dialog');
        if (closeTestlibBtn) {
            closeTestlibBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.closeTestlibInstallDialog();
            });
        }
        
        const installDialog = elCtl('install-dialog');
        if (installDialog) {
            installDialog.addEventListener('click', (e) => {
                if (e.target === installDialog) {
                    logInfo('[编译器设置] 点击对话框背景关闭');
                    this.closeInstallDialog();
                }
            });
        }
        
        const saveBtn = elCtl('save-settings');
        if (saveBtn) {
            logInfo('[编译器设置] 保存设置按钮事件已绑定');
            saveBtn.addEventListener('click', (e) => {
                logInfo('[编译器设置] 保存设置按钮被点击');
                e.preventDefault();
                this.saveSettings();
            });
        } else {
            logError('[编译器设置] 未找到保存设置按钮');
        }
        
        const cancelBtn = elCtl('cancel-settings');
        if (cancelBtn) {
            logInfo('[编译器设置] 取消按钮事件已绑定');
            cancelBtn.addEventListener('click', (e) => {
                logInfo('[编译器设置] 取消按钮被点击');
                e.preventDefault();
                this.closeWindow();
            });
        } else {
            logError('[编译器设置] 未找到取消按钮');
        }
        
        const resetBtn = elCtl('reset-settings');
        if (resetBtn) {
            logInfo('[编译器设置] 重置按钮事件已绑定');
            resetBtn.addEventListener('click', (e) => {
                logInfo('[编译器设置] 重置按钮被点击');
                e.preventDefault();
                this.resetSettings();
            });
        }
        
        const compilerOptions = elCtl('compiler-options');
        if (compilerOptions) {
            compilerOptions.addEventListener('input', (e) => {
                logInfo('[编译器设置] 编译器选项发生变化:', evtValue(e));
                this.settings.compilerArgs = evtValue(e);
            });
            logInfo('[编译器设置] 编译器选项变化监听已绑定');
        } else {
            logError('[编译器设置] 未找到编译器选项元素');
        }
        
        const compilerPath = elCtl('compiler-path');
        if (compilerPath) {
            compilerPath.addEventListener('input', (e) => {
                logInfo('[编译器设置] 编译器路径发生变化:', evtValue(e));
                this.settings.compilerPath = evtValue(e);
            });
            logInfo('[编译器设置] 编译器路径变化监听已绑定');
        } else {
            logError('[编译器设置] 未找到编译器路径元素');
        }

        const pythonInterpreterPath = elCtl('python-interpreter-path');
        if (pythonInterpreterPath) {
            pythonInterpreterPath.addEventListener('input', (e) => {
                this.settings.pythonInterpreterPath = evtValue(e);
            });
        }

        const testTestlibBtn = elCtl('test-testlib');
        if (testTestlibBtn) {
            testTestlibBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.testTestlib();
            });
        }

        const runModeSelect = elCtl('run-mode');
        if (runModeSelect) {
            runModeSelect.addEventListener('change', (e) => {
                if (this.isIntegratedOnlyPlatform) {
                    if (e.target instanceof HTMLSelectElement) e.target.value = 'integrated-terminal';
                    this.settings.runMode = 'integrated-terminal';
                    return;
                }
                this.settings.runMode = evtValue(e) === 'integrated-terminal'
                    ? 'integrated-terminal'
                    : 'popup';
            });
        }
        
        // #close-install-dialog 的绑定已在上方完成：
        // 原先同一函数内对同一按钮绑了两次（当前幂等，后续加动画/埋点即双触发）
    }

    async loadSettings() {
        try {
            const platform = await this.getCurrentPlatform();
            const isMacPlatform = platform === 'macos' || platform === 'darwin' || platform === 'mac';
            const isIntegratedOnlyPlatform = isMacPlatform || platform === 'linux';
            this.isMacPlatform = isMacPlatform;
            this.isIntegratedOnlyPlatform = isIntegratedOnlyPlatform;
            const allSettings = await window.electronAPI.getAllSettings();
            // 空结果与「加载失败」同等对待：this.settings 仍是构造默认值，
            // 若继续按成功处理，用户点「保存」就把默认值整体写回。
            // 原先写成 `if (allSettings)`，null/undefined 会静默跳到下面置
            // _settingsLoaded = true，恰好放过了要阻断的那种回写。
            if (!allSettings || typeof allSettings !== 'object') {
                throw new Error('getAllSettings returned no settings object');
            }
            if (allSettings.compilerPath === undefined && allSettings.compilerArgs === undefined) {
                throw new Error('getAllSettings result has no compiler fields');
            }
            const loadedCompilerArgs = allSettings.compilerArgs || (isMacPlatform ? '-std=c++14 -O2' : '-std=c++14 -O2 -static');
            this.settings = {
                compilerPath: allSettings.compilerPath || '',
                pythonInterpreterPath: allSettings.pythonInterpreterPath || '',
                compilerArgs: isMacPlatform
                    ? loadedCompilerArgs.replace(/\s-static\b/g, ' ').replace(/\s+/g, ' ').trim()
                    : loadedCompilerArgs,
                runMode: isIntegratedOnlyPlatform ? 'integrated-terminal' : (allSettings.runMode || 'popup'),
                testlibPath: allSettings.testlibPath || ''
            };
            logInfo('编译器设置加载完成:', this.settings);
            this._settingsLoaded = true;
        } catch (error) {
            // 加载失败时 this.settings 仍是构造默认值。若继续让 updateUI 把默认值
            // 写进 input，用户点「保存」就会把默认值整体写回，
            // 静默改回 -std=c++14 -O2 -static，丢掉 TA 自定义的编译选项。
            this._settingsLoaded = false;
            logError('加载编译器设置失败:', error);
            this.showMessage(window.i18n.t('compiler.loadSettingsFailed'), 'error');
        }
    }

    updateUI() {
        const compilerPathInput = elCtl('compiler-path');
        const pythonInterpreterPathInput = elCtl('python-interpreter-path');
        const compilerOptionsInput = elCtl('compiler-options');
        const runModeSelect = elCtl('run-mode');
        const testlibPathInput = elCtl('testlib-path');
        
        if (compilerPathInput) compilerPathInput.value = this.settings.compilerPath || '';
        if (pythonInterpreterPathInput) pythonInterpreterPathInput.value = this.settings.pythonInterpreterPath || '';
        if (compilerOptionsInput) compilerOptionsInput.value = this.settings.compilerArgs || '-std=c++14 -O2 -static';
        if (runModeSelect) {
            const rawOption = runModeSelect.querySelector('option[value="popup"]');
            const popupOption = rawOption instanceof HTMLOptionElement ? rawOption : null;
            const runModeHint = runModeSelect.parentElement ? runModeSelect.parentElement.querySelector('.hint') : null;
            if (this.isIntegratedOnlyPlatform) {
                if (popupOption) popupOption.disabled = true;
                runModeSelect.value = 'integrated-terminal';
                if (runModeHint) {
                    runModeHint.textContent = window.i18n.t('compiler.integratedOnlyHint');
                }
            } else {
                if (popupOption) popupOption.disabled = false;
                runModeSelect.value = this.settings.runMode || 'popup';
                if (runModeHint) {
                    runModeHint.textContent = window.i18n.t('compiler.runModeDesc');
                }
            }
        }
        if (testlibPathInput) testlibPathInput.value = this.settings.testlibPath || '';
    }

    async browsePythonInterpreter() {
        try {
            const platform = await this.getCurrentPlatform();
            let title = window.i18n.t('compiler.selectPythonDialog');
            let filters = [{ name: window.i18n.t('compiler.allFiles'), extensions: ['*'] }];

            if (platform === 'windows') {
                title = window.i18n.t('compiler.selectPythonWindowsDialog');
                filters = [
                    { name: window.i18n.t('compiler.executableFiles'), extensions: ['exe'] },
                    { name: window.i18n.t('compiler.allFiles'), extensions: ['*'] }
                ];
            }

            const result = await window.electronAPI.showOpenDialog({
                title,
                filters,
                properties: ['openFile']
            });

            if (!result.canceled && result.filePaths.length > 0) {
                const selectedPath = result.filePaths[0];
                this.settings.pythonInterpreterPath = selectedPath;
                const input = elCtl('python-interpreter-path');
                if (input) {
                    input.value = selectedPath;
                }
                if (window.electronAPI && window.electronAPI.saveSetting) {
                    await window.electronAPI.saveSetting('pythonInterpreterPath', selectedPath);
                }
                this.showMessage(window.i18n.t('compiler.pythonPathSaved'), 'success');
            }
        } catch (error) {
            logError('浏览 Python 解释器失败:', error);
            this.showMessage((window.i18n.t('compiler.browsePythonFailed', {error: error.message})), 'error');
        }
    }

    async browseCompiler() {
        try {
            const platform = await this.getCurrentPlatform();
            let title = window.i18n.t('compiler.selectCompilerDialog');
            let filters = [];
            let defaultPath = '';

            if (platform === 'windows') {
                title = window.i18n.t('compiler.selectCompilerWindowsDialog');
                filters = [
                    { name: window.i18n.t('compiler.executableFiles'), extensions: ['exe'] },
                    { name: window.i18n.t('compiler.allFiles'), extensions: ['*'] }
                ];
                defaultPath = '';
            } else {
                title = window.i18n.t('compiler.selectCompilerUnixDialog');
                filters = [
                    { name: window.i18n.t('compiler.allFiles'), extensions: ['*'] }
                ];
            }

            const result = await window.electronAPI.showOpenDialog({
                title,
                defaultPath,
                filters,
                properties: ['openFile']
            });
            if (platform !== 'windows') {
                logInfo('[编译器设置] 非 Windows 平台选择结果:', result);
            }
            
            if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        const fileName = selectedPath.split(/[\\\/]/).pop().toLowerCase();
        const isWin = platform === 'windows';
        const looksLikeCompiler = fileName.includes('g++') || fileName.includes('gcc') || fileName.includes('clang++') || (!isWin && fileName.includes('clang'));

        if (!looksLikeCompiler) {
                    const confirmed = await this.showConfirmDialog(
                        window.i18n.t('compiler.selectCompilerConfirmTitle'),
                        window.i18n.t('compiler.selectCompilerConfirm', { name: escapeHtml(fileName) }),
                        window.i18n.t('compiler.continueUse'),
                        window.i18n.t('compiler.reselect')
                    );
                    
                    if (!confirmed) {
                        return this.browseCompiler();
                    }
                }
                
                this.settings.compilerPath = selectedPath;
                setElValue('compiler-path', this.settings.compilerPath);
                
                this.showMessage(window.i18n.t('compiler.selectedCompiler', { name: fileName }), 'success');
                
            } else if (platform !== 'windows' && !result.canceled) {
                this.showMessage((window.i18n.t('compiler.noFileSelected')), 'error');
            }
        } catch (error) {
            logError('浏览编译器失败:', error);
            this.showMessage((window.i18n.t('compiler.browseFailed', {error: error.message})), 'error');
        }
    }



    showInstallDialog() {
        const dialog = elCtl('install-dialog');
        if (dialog) {
            dialog.style.display = 'block';
        }
        
        this.loadAvailableCompilers();
    }

    closeInstallDialog() {
        const dialog = elCtl('install-dialog');
        if (dialog) {
            dialog.style.display = 'none';
        }
    }

    async loadAvailableCompilers() {
        const compilerList = elCtl('compiler-list');
        if (!compilerList) return;
        if (this._compilerListAbort) {
            this._compilerListAbort.abort();
        }
        const controller = new AbortController();
        this._compilerListAbort = controller;
        const timeoutTimer = setTimeout(() => controller.abort(), 15000);
        
        compilerList.innerHTML = '<div class="loading">' + (window.i18n.t('compiler.fetchingList')) + '</div>';
        
        try {
            const response = await window.electronIPC.invoke('fetch-remote-json', { path: '/api/getAvailableCompilerList', method: 'GET' });
            
            if (!response.ok) {
                throw new Error(window.i18n.t('compiler.networkRequestFailed', {
                    status: response.status,
                    statusText: response.statusText || ''
                }));
            }
            
            const compilers = response.data;
            
            logInfo('[编译器设置] 服务器返回的编译器数据:', compilers);
            if (compilers && compilers.length > 0) {
                logInfo('[编译器设置] 第一个编译器对象结构:', compilers[0]);
            }
            
            compilerList.innerHTML = '';
            
            if (!compilers || compilers.length === 0) {
                compilerList.innerHTML = `<div class="no-compilers">${window.i18n.t('compiler.noCompilerAvailable')}</div>`;
                return;
            }
            
            const platform = await this.getCurrentPlatform();
            
            const platformCompilers = compilers.filter(compiler => 
                compiler.platform && compiler.platform.toLowerCase() === platform.toLowerCase()
            );
            
            if (platformCompilers.length === 0) {
                compilerList.innerHTML = `<div class="no-compilers">${window.i18n.t('compiler.noCompilerForPlatform', { platform: escapeHtml(platform) })}</div>`;
                return;
            }
            
            const downloadedVersions = await this.getDownloadedVersions();
            
            for (const compiler of platformCompilers) {
                const isDownloaded = downloadedVersions.includes(compiler.version);
                const isSelected = await this.isCompilerSelected(compiler.version);
                
                const compilerDiv = document.createElement('div');
                compilerDiv.className = `compiler-item ${isDownloaded ? 'downloaded' : ''} ${isSelected ? 'selected' : ''}`;
                compilerDiv.dataset.version = compiler.version;
                
                compilerDiv.innerHTML = `
                    <div class="compiler-info">
                        <h4>${escapeHtml(compiler.name)}</h4>
                        <p><span>${window.i18n.t('compiler.versionSelectedPrefix')}</span> ${escapeHtml(compiler.version)}</p>
                        <span class="platform"><span>${window.i18n.t('compiler.platformPrefix')}</span> ${escapeHtml(compiler.platform)}</span>
                    </div>
                    <div class="compiler-actions">
                        ${isSelected ? 
                            '<span class="status selected-status">' + (window.i18n.t('compiler.selected')) + '</span>' :
                            isDownloaded ? 
                                '<button class="select-btn" data-version="' + escapeHtml(compiler.version) + '">' + (window.i18n.t('compiler.select')) + '</button>' :
                                '<button class="download-btn" data-url="' + escapeHtml(compiler.download_url) + '" data-version="' + escapeHtml(compiler.version) + '" data-name="' + escapeHtml(compiler.name) + '">' + (window.i18n.t('compiler.download')) + '</button>'
                        }
                        ${isDownloaded ? '<span class="status downloaded-status">' + (window.i18n.t('compiler.downloaded')) + '</span>' : ''}
                    </div>
                `;

                
                this.addCompilerItemListeners(compilerDiv, compiler);
                
                compilerList.appendChild(compilerDiv);
            }
            
        } catch (error) {
            if (controller !== this._compilerListAbort) {
                return;
            }
            if (isTimeoutError(error)) {
                logError('获取编译器列表超时:', error);
                compilerList.innerHTML = `
                    <div class="error-message">
                        <p>${window.i18n.t('compiler.requestTimeout')}</p>
                        <button class="retry-btn">${window.i18n.t('compiler.retry')}</button>
                    </div>
                `;
                const timeoutRetryBtn = compilerList.querySelector('.retry-btn');
                if (timeoutRetryBtn) {
                    timeoutRetryBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        this.loadAvailableCompilers();
                    });
                }
                return;
            }
            logError('获取编译器列表失败:', error);
            compilerList.innerHTML = `
                <div class="error-message">
                    <p>${window.i18n.t('compiler.networkError')}</p>
                    <p class="error-detail">${escapeHtml(error.message)}</p>
                    <button class="retry-btn" data-i18n="compiler.retry">Retry</button>
                </div>
            `;
            const retryBtn = compilerList.querySelector('.retry-btn');
            if (retryBtn) {
                retryBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.loadAvailableCompilers();
                });
            }
        } finally {
            clearTimeout(timeoutTimer);
            if (controller === this._compilerListAbort) {
                this._compilerListAbort = null;
            }
        }
    }

    async saveSettings() {
        try {
            // 设置没加载成功时，input 里显示的是构造默认值而不是用户的真实配置。
            // 此时保存 = 把默认值整体写回，静默改掉用户的编译选项。必须阻断。
            if (this._settingsLoaded === false) {
                this.showMessage(window.i18n.t('compiler.saveBlockedLoadFailed'), 'error');
                logError('[编译器设置] 设置未成功加载，拒绝保存以免覆盖用户配置');
                return;
            }

            const compilerPath = elCtl('compiler-path')?.value;
            const pythonInterpreterPath = elCtl('python-interpreter-path')?.value;
            let compilerArgs = elCtl('compiler-options')?.value;
            const runModeSelect = elCtl('run-mode');
            const runMode = this.isIntegratedOnlyPlatform
                ? 'integrated-terminal'
                : (runModeSelect && runModeSelect.value === 'integrated-terminal'
                ? 'integrated-terminal'
                : 'popup');

            if (this.isMacPlatform && typeof compilerArgs === 'string') {
                compilerArgs = compilerArgs.replace(/\s-static\b/g, ' ').replace(/\s+/g, ' ').trim();
            }
            
            const newSettings = {
                compilerPath: compilerPath,
                pythonInterpreterPath: pythonInterpreterPath,
                compilerArgs: compilerArgs,
                runMode: runMode
            };
            
            logInfo('准备保存编译器设置:', newSettings);
            
            if (window.electronAPI && window.electronAPI.updateSettings) {
                const result = await window.electronAPI.updateSettings(newSettings);
                logInfo('保存设置结果:', result);
                if (result.success) {
                    this.showMessage((window.i18n.t('compiler.saveSuccess')), 'success');
                } else {
                    const errorMessage = result.error || window.i18n.t('compiler.unknownError');
                    this.showMessage(window.i18n.t('compiler.saveFail', { error: errorMessage }), 'error');
                }
            } else {
                this.showMessage((window.i18n.t('compiler.apiUnavailable')), 'error');
            }
            
        } catch (error) {
            logError('保存编译器设置失败:', error);
            this.showMessage(window.i18n.t('compiler.saveFail', { error: error.message }), 'error');
        }
    }

    async resetSettings() {
        try {
            if (window.electronAPI && window.electronAPI.resetSettings) {
                const result = await window.electronAPI.resetSettings();
                if (result.success) {
                    await this.loadSettings();
                    this.updateUI();
                    this.showMessage((window.i18n.t('compiler.resetSuccess')), 'success');
                } else {
                    const errorMessage = result.error || window.i18n.t('compiler.unknownError');
                    this.showMessage(window.i18n.t('compiler.resetFail', { error: errorMessage }), 'error');
                }
            } else {
                this.showMessage(window.i18n.t('compiler.apiUnavailable'), 'error');
            }
        } catch (error) {
            logError('重置设置失败:', error);
            this.showMessage(window.i18n.t('compiler.resetFail', { error: error.message }), 'error');
        }
    }

    detectExistingCompiler() {
        logInfo('编译器自动检测功能在当前安全配置下不可用，请手动选择编译器路径');
    }

    async getCurrentPlatform() {
        // 归一化到 'windows' | 'macos' | 'linux'：主进程 get-platform 直接透传
        // process.platform（win32 / darwin），而各处过滤是按 windows/macos/linux
        // 比较的。不归一化的话过滤结果恒为空，只显示「该平台无可用编译器」，
        // 且没有任何报错。
        const normalize = (value) => {
            const v = String(value || '').toLowerCase();
            if (v.startsWith('win')) return 'windows';
            if (v.startsWith('darwin') || v.startsWith('mac') || v === 'osx') return 'macos';
            if (v.startsWith('linux')) return 'linux';
            return v;
        };

        if (window.electronAPI && window.electronAPI.getPlatform) {
            return normalize(await window.electronAPI.getPlatform());
        }

        const userAgent = navigator.userAgent.toLowerCase();
        if (userAgent.includes('win')) return 'windows';
        if (userAgent.includes('mac')) return 'macos';
        if (userAgent.includes('linux')) return 'linux';
        return 'windows'; // 默认
    }

    async detectMacPlatform() {
        const platform = await this.getCurrentPlatform();
        return platform === 'macos' || platform === 'darwin' || platform === 'mac';
    }

    async detectIntegratedOnlyPlatform() {
        const platform = await this.getCurrentPlatform();
        return platform === 'linux' || platform === 'macos' || platform === 'darwin' || platform === 'mac';
    }

    async getDownloadedVersions() {
        try {
            if (window.electronAPI && window.electronAPI.getDownloadedCompilers) {
                return await window.electronAPI.getDownloadedCompilers();
            }
        } catch (error) {
            logError('获取已下载编译器失败:', error);
        }
        return [];
    }

    async isCompilerSelected(version) {
        try {
            if (window.electronAPI && window.electronAPI.getAllSettings) {
                const settings = await window.electronAPI.getAllSettings();
                const userHome = await window.electronAPI.getUserHome();
                
                if (!settings.compilerPath) {
                    return false;
                }
                
                const normalizePathPath = (path) => {
                    return path.replace(/\\/g, '/').replace(/\/+/g, '/');
                };
                
                const currentPath = normalizePathPath(settings.compilerPath);
                const expectedPath = normalizePathPath(`${userHome}/.oicpp-plus/Compilers/${version}`);
                
                const isMatch = currentPath.includes(expectedPath);
                
                logInfo(`检查编译器选中状态 - 版本: ${version}`);
                logInfo(`当前编译器路径: ${currentPath}`);
                logInfo(`期望路径包含: ${expectedPath}`);
                logInfo(`匹配结果: ${isMatch}`);
                
                return isMatch;
            }
        } catch (error) {
            logError('检查编译器选中状态失败:', error);
        }
        return false;
    }

    addCompilerItemListeners(compilerDiv, compiler) {
        const rawBtn = compilerDiv.querySelector('.download-btn');
        const downloadBtn = rawBtn instanceof HTMLButtonElement ? rawBtn : null;
        if (downloadBtn) {
            logInfo('绑定下载按钮事件，编译器:', compiler.name, compiler.version);
            downloadBtn.addEventListener('click', (e) => {
                logInfo('下载按钮被点击，编译器:', compiler);
                e.preventDefault();
                this.downloadCompiler(compiler);
            });
        }

        const selectBtn = compilerDiv.querySelector('.select-btn');
        if (selectBtn) {
            logInfo('绑定选择按钮事件，版本:', compiler.version);
            selectBtn.addEventListener('click', (e) => {
                logInfo('选择按钮被点击，版本:', compiler.version);
                e.preventDefault();
                this.selectCompiler(compiler.version);
            });
        }

        const retryBtn = compilerDiv.querySelector('.retry-btn');
        if (retryBtn) {
            retryBtn.addEventListener('click', (e) => {
                logInfo('重试按钮被点击');
                e.preventDefault();
                this.loadAvailableCompilers();
            });
        }
    }

    async downloadCompiler(compiler) {
        logInfo('[编译器设置] 开始下载编译器流程:', compiler);

        const rawBtn = this.findListItem('compiler', compiler.version)?.querySelector('button.download-btn') || null;
        const downloadBtn = rawBtn instanceof HTMLButtonElement ? rawBtn : null;
        if (!downloadBtn) {
            logError('[编译器设置] 未找到下载按钮，compiler.version:', compiler.version);
            return;
        }

        try {
            downloadBtn.disabled = true;
            downloadBtn.textContent = window.i18n.t('compiler.downloading');
            logInfo('[编译器设置] 按钮状态已更新为下载中');

            this.showMessage(window.i18n.t('compiler.startDownload', {
                name: compiler.name,
                version: compiler.version
            }), 'info');

            logInfo('[编译器设置] 准备调用下载API，参数:', {
                url: compiler.download_url,
                version: compiler.version,
                name: compiler.name
            });

            if (window.electronAPI && window.electronAPI.downloadCompiler) {
                logInfo('[编译器设置] 调用electronAPI.downloadCompiler');
                const result = await window.electronAPI.downloadCompiler({
                    url: compiler.download_url,
                    version: compiler.version,
                    name: compiler.name
                });

                logInfo('[编译器设置] downloadCompiler返回结果:', result);

                if (result.success) {
                    logInfo('[编译器设置] 下载成功，准备更新UI状态');
                    this.showMessage(window.i18n.t('compiler.downloadSuccess', {
                        name: compiler.name,
                        version: compiler.version
                    }), 'success');
                    
                    downloadBtn.textContent = window.i18n.t('compiler.downloaded');
                    downloadBtn.disabled = false;
                    downloadBtn.classList.remove('download-btn');
                    downloadBtn.classList.add('downloaded-btn');
                    logInfo('[编译器设置] 按钮状态已更新为已下载');
                    
                    if (result.compilerPath) {
                        logInfo('[编译器设置] 设置编译器路径:', result.compilerPath);
                        await this.setCompilerPath(result.compilerPath);
                        
                        logInfo('[编译器设置] 自动选择刚下载的编译器');
                        await this.selectCompiler(compiler.version);
                    } else {
                        this.refreshCompilerItemState(compiler.version, 'downloaded');
                    }
                } else {
                    logError('[编译器设置] 下载失败，result.success为false:', result);
                    throw new Error(result.error || window.i18n.t('compiler.unknownError'));
                }
            } else {
                logError('[编译器设置] 下载 API 不可用');
                throw new Error(window.i18n.t('compiler.downloadApiUnavailable'));
            }

        } catch (error) {
            logError('[编译器设置] 下载编译器失败:', error);
            this.showMessage(window.i18n.t('compiler.downloadFail', { error: error.message }), 'error');
            
            if (downloadBtn) {
                downloadBtn.disabled = false;
                downloadBtn.textContent = window.i18n.t('compiler.download');
                logInfo('[编译器设置] 按钮状态已恢复为下载');
            }
        }
    }

    async selectCompiler(version) {
        try {
            if (window.electronAPI && window.electronAPI.selectCompiler) {
                const result = await window.electronAPI.selectCompiler(version);
                
                if (result.success) {
                    await this.setCompilerPath(result.compilerPath);
                    
                    logInfo(`开始重置所有编译器状态，当前选择版本: ${version}`);
                    
                    const allCompilerItems = this.getListItems('compiler');
                    logInfo(`找到 ${allCompilerItems.length} 个编译器项`);

                    allCompilerItems.forEach(item => {
                        const itemVersion = this.getItemVersion(item);

                        logInfo(`编译器项版本: ${itemVersion}，当前选择: ${version}`);

                        if (itemVersion) {
                            if (itemVersion !== version) {
                                if (item.classList.contains('selected') || item.querySelector('.selected-status')) {
                                    logInfo(`重置编译器 ${itemVersion} 为已下载状态`);
                                    this.refreshCompilerItemState(itemVersion, 'downloaded');
                                }
                            }
                        }
                    });
                    
                    logInfo(`设置编译器 ${version} 为选中状态`);
                    this.refreshCompilerItemState(version, 'selected');
                    
                    this.showMessage(window.i18n.t('compiler.versionSelected', { version }), 'success');
                    
                } else {
                    throw new Error(result.error || window.i18n.t('compiler.unknownError'));
                }
            } else {
                throw new Error(window.i18n.t('compiler.selectApiUnavailable'));
            }
        } catch (error) {
            logError('选择编译器失败:', error);
            this.showMessage(window.i18n.t('compiler.selectFail', { error: error.message }), 'error');
        }
    }

    async setCompilerPath(path) {
        this.settings.compilerPath = path;
        const compilerPathInput = elCtl('compiler-path');
        if (compilerPathInput) {
            compilerPathInput.value = path;
        }
        
        try {
            // 加载失败时 this.settings.compilerArgs 还是构造默认值，
            // 这里落盘等于绕过 saveSettings 的阻断把默认值写回去。
            // 只更新用户明确改动的 compilerPath，不碰其它字段。
            if (this._settingsLoaded === false) {
                logWarn('设置未成功加载，仅更新编译器路径，不回写其它字段');
                if (window.electronAPI && window.electronAPI.updateSettings) {
                    await window.electronAPI.updateSettings({ compilerPath: path });
                }
                return;
            }

            const newSettings = {
                compilerPath: path,
                compilerArgs: this.settings.compilerArgs
            };
            
            logInfo('自动保存编译器路径设置:', newSettings);
            
            if (window.electronAPI && window.electronAPI.updateSettings) {
                const result = await window.electronAPI.updateSettings(newSettings);
                if (result.success) {
                    logInfo('编译器路径设置已自动保存');
                } else {
                    logError('自动保存编译器路径失败:', result.error);
                }
            }
        } catch (error) {
            logError('自动保存编译器路径时出错:', error);
        }
    }

    showMessage(message, type = 'info') {
        const existingToast = (document.querySelector('.message-toast'));
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
        
        try {
            if (type === 'error') {
                const errObj = message instanceof Error ? message : new Error(String(message));
                logError('[CompilerSettingsToastError]', { message: String(message), stack: errObj.stack });
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

    showConfirmDialog(title, message, confirmText = window.i18n.t('dialog.confirm'), cancelText = window.i18n.t('dialog.cancel')) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'dialog-overlay';
            overlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background-color: rgba(0, 0, 0, 0.5);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 10000;
            `;
            
            const dialog = document.createElement('div');
            dialog.className = 'confirm-dialog';
            dialog.style.cssText = `
                background: white;
                border-radius: 8px;
                padding: 20px;
                min-width: 300px;
                max-width: 500px;
                box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
            `;
            
            dialog.innerHTML = `
                <div style="margin-bottom: 15px;">
                    <h3 style="margin: 0; color: #333; font-size: 16px;">${title}</h3>
                </div>
                <div style="margin-bottom: 20px; line-height: 1.5; white-space: pre-line;">
                    ${message}
                </div>
                <div style="text-align: right;">
                    <button class="cancel-btn" style="
                        margin-right: 10px;
                        padding: 8px 16px;
                        border: 1px solid #ddd;
                        background: #f5f5f5;
                        border-radius: 4px;
                        cursor: pointer;
                    ">${cancelText}</button>
                    <button class="confirm-btn" style="
                        padding: 8px 16px;
                        border: none;
                        background: #007acc;
                        color: white;
                        border-radius: 4px;
                        cursor: pointer;
                    ">${confirmText}</button>
                </div>
            `;
            
            overlay.appendChild(dialog);
            document.body.appendChild(overlay);
            
            const confirmBtn = dialog.querySelector('.confirm-btn');
            const cancelBtn = dialog.querySelector('.cancel-btn');
            
            const cleanup = () => {
                document.body.removeChild(overlay);
            };
            
            confirmBtn.addEventListener('click', () => {
                cleanup();
                resolve(true);
            });
            
            cancelBtn.addEventListener('click', () => {
                cleanup();
                resolve(false);
            });
            
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    cleanup();
                    resolve(false);
                }
            });
        });
    }

    // 编译器列表与 testlib 列表共用 .compiler-item class，且同处一个设置窗口，
    // 任何 document 级查询都会把另一类列表的行一起改写（按钮被清掉且需重开弹窗才恢复），
    // 因此查找一律按容器作用域。
    getListContainer(kind) {
        return (document.getElementById(kind === 'testlib' ? 'testlib-list' : 'compiler-list'));
    }

    getListItems(kind) {
        const container = this.getListContainer(kind);
        return container ? [...container.querySelectorAll('.compiler-item')] : [];
    }

    getItemVersion(item) {
        if (!item) return null;
        if (item.dataset && item.dataset.version) return item.dataset.version;
        const versionEl = item.querySelector('[data-version]');
        return versionEl ? versionEl.getAttribute('data-version') : null;
    }

    findListItem(kind, version) {
        if (!version) return null;
        return this.getListItems(kind).find((item) => this.getItemVersion(item) === version) || null;
    }

    refreshCompilerItemState(version, newState) {
        logInfo(`刷新编译器项状态: ${version} -> ${newState}`);

        const compilerItem = this.findListItem('compiler', version);

        if (!compilerItem) {
            logWarn(`未找到编译器项: ${version}`);
            return;
        }
        
        const actionsDiv = compilerItem.querySelector('.compiler-actions');
        if (!actionsDiv) {
            logWarn(`未找到编译器动作区域: ${version}`);
            return;
        }
        
        logInfo(`找到编译器项，当前类: ${compilerItem.className}`);
        
        actionsDiv.innerHTML = '';
        
        switch (newState) {
            case 'downloaded':
                logInfo(`设置编译器为已下载状态: ${version}`);
                compilerItem.classList.add('downloaded');
                compilerItem.classList.remove('selected');
                actionsDiv.innerHTML = `
                    <button class="select-btn" data-version="${escapeHtml(version)}">${window.i18n.t('compiler.select')}</button>
                    <span class="status downloaded-status">${window.i18n.t('compiler.downloaded')}</span>
                `;
                const selectBtn = actionsDiv.querySelector('.select-btn');
                if (selectBtn) {
                    logInfo(`重新绑定选择按钮事件: ${version}`);
                    selectBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        logInfo(`选择按钮被点击: ${version}`);
                        this.selectCompiler(version);
                    });
                }
                break;
                
            case 'selected':
                logInfo(`设置编译器为已选中状态: ${version}`);
                compilerItem.classList.add('downloaded', 'selected');
                actionsDiv.innerHTML = `
                    <span class="status selected-status">${window.i18n.t('compiler.selected')}</span>
                    <span class="status downloaded-status">${window.i18n.t('compiler.downloaded')}</span>
                `;
                break;
                
            case 'not-downloaded':
                logInfo(`设置编译器为未下载状态: ${version}`);
                compilerItem.classList.remove('downloaded', 'selected');
                break;
        }
        
        logInfo(`编译器项状态已更新: ${version} -> ${newState}，新类: ${compilerItem.className}`);
    }

    async browseTestlib() {
        try {
            if (window.electronAPI && window.electronAPI.showOpenDialog) {
                const result = await window.electronAPI.showOpenDialog({
                    title: window.i18n.t('compiler.selectTestlibDialog'),
                    properties: ['openFile'],
                    filters: [
                        { name: window.i18n.t('compiler.testlibHeaderFilter'), extensions: ['h'] },
                        { name: window.i18n.t('compiler.allFiles'), extensions: ['*'] }
                    ]
                });
                
                if (!result.canceled && result.filePaths.length > 0) {
                    const testlibPath = result.filePaths[0];
                    
                    const fileName = testlibPath.split(/[\\\/]/).pop().toLowerCase();
                    if (fileName !== 'testlib.h') {
                        this.showMessage((window.i18n.t('compiler.selectTestlibFile')), 'error');
                        return;
                    }
                    
                    setElValue('testlib-path', testlibPath);
                    
                    if (window.electronAPI && window.electronAPI.saveSetting) {
                        await window.electronAPI.saveSetting('testlibPath', testlibPath);
                        this.showMessage((window.i18n.t('compiler.testlibPathSaved')), 'success');
                    }
                }
            }
        } catch (error) {
            logError('选择testlib.h文件失败:', error);
            this.showMessage((window.i18n.t('compiler.selectTestlibFail', {error: error.message})), 'error');
        }
    }
    
    async testTestlib() {
        const testlibPathInput = elCtl('testlib-path');
        if (!testlibPathInput) {
            return;
        }
        const testlibPath = testlibPathInput.value;
        const resultDiv = elCtl('testlib-test-result');

        const renderTestResult = (type, message) => {
            if (!resultDiv) return;
            resultDiv.classList.remove('is-success', 'is-error', 'is-testing');
            if (type === 'success') {
                resultDiv.classList.add('is-success');
            } else if (type === 'error') {
                resultDiv.classList.add('is-error');
            } else {
                resultDiv.classList.add('is-testing');
            }
            resultDiv.textContent = message;
        };
        
        if (!testlibPath) {
            renderTestResult('error', window.i18n.t('compiler.setTestlibPathFirst'));
            return;
        }
        
        renderTestResult('testing', window.i18n.t('compiler.testingTestlib'));
        
        try {
            if (window.electronAPI && window.electronAPI.testTestlib) {
                const result = await window.electronAPI.testTestlib(testlibPath);
                
                if (result.success) {
                    renderTestResult('success', window.i18n.t('compiler.testlibSuccess'));
                } else {
                    const errorMessage = result.error || window.i18n.t('compiler.unknownError');
                    renderTestResult('error', window.i18n.t('compiler.testlibFail', { error: errorMessage }));
                }
            } else {
                renderTestResult('error', window.i18n.t('compiler.testApiUnavailable'));
            }
        } catch (error) {
            logError('测试Testlib失败:', error);
            renderTestResult('error', window.i18n.t('compiler.testFail', { error: error.message }));
        }
    }
    
    showTestlibInstallDialog() {
        const dialog = elCtl('testlib-install-dialog');
        if (dialog) {
            dialog.style.display = 'flex';
            this.loadAvailableTestlibs();
        }
    }
    
    closeTestlibInstallDialog() {
        const dialog = elCtl('testlib-install-dialog');
        if (dialog) {
            dialog.style.display = 'none';
        }
    }
    
    async loadAvailableTestlibs() {
        const testlibList = elCtl('testlib-list');
        if (!testlibList) return;
        if (this._testlibListAbort) {
            this._testlibListAbort.abort();
        }
        const controller = new AbortController();
        this._testlibListAbort = controller;
        const timeoutTimer = setTimeout(() => controller.abort(), 15000);
        
        testlibList.innerHTML = `<div class="loading">${window.i18n.t('compiler.fetchingTestlibList')}</div>`;
        
        try {
            const response = await window.electronIPC.invoke('fetch-remote-json', { path: '/api/getAvailableTestlibList', method: 'GET' });
            
            if (!response.ok) {
                throw new Error(window.i18n.t('compiler.networkRequestFailed', {
                    status: response.status,
                    statusText: response.statusText || ''
                }));
            }
            
            const testlibs = response.data;
            
            testlibList.innerHTML = '';
            
            if (!testlibs || testlibs.length === 0) {
                testlibList.innerHTML = `<div class="no-compilers">${window.i18n.t('compiler.noTestlibAvailable')}</div>`;
                return;
            }
            
            const downloadedVersions = await this.getDownloadedTestlibVersions();
            
            for (const testlib of testlibs) {
                const isDownloaded = downloadedVersions.includes(testlib.version);
                const isSelected = await this.isTestlibSelected(testlib.version);
                
                const testlibDiv = document.createElement('div');
                testlibDiv.className = `compiler-item ${isDownloaded ? 'downloaded' : ''} ${isSelected ? 'selected' : ''}`;
                
                // 远端字段名不统一（编译器用 download_url，testlib 用 downloadUrl），两种都认；
                // 可选链兜住缺字段，避免单个字段缺失把整个面板变成「网络错误」
                const rawUrl = testlib?.downloadUrl || testlib?.download_url || '';
                const downloadUrl = rawUrl.startsWith('http')
                    ? rawUrl
                    : `https://oicpp.mywwzh.top${rawUrl}`;

                const versionLabel = window.i18n.t('compiler.versionSelectedPrefix');
                const sizeLabel = window.i18n.t('compiler.testlibSize', { size: testlib.file_size_mb ?? '-' });
                testlibDiv.dataset.version = testlib.version;
                testlibDiv.innerHTML = `
                    <div class="compiler-info">
                        <h4>${escapeHtml(testlib.name)}</h4>
                        <p>${versionLabel} ${escapeHtml(testlib.version)}</p>
                        <p>${escapeHtml(testlib.description)}</p>
                        <span class="platform">${sizeLabel}</span>
                    </div>
                    <div class="compiler-actions">
                        ${isSelected ?
                            '<span class="status selected-status">' + (window.i18n.t('compiler.selected')) + '</span>' :
                            isDownloaded ?
                                '<button class="select-btn" data-version="' + escapeHtml(testlib.version) + '">' + (window.i18n.t('compiler.select')) + '</button>' :
                                '<button class="download-btn" data-url="' + escapeHtml(downloadUrl) + '" data-version="' + escapeHtml(testlib.version) + '" data-name="' + escapeHtml(testlib.name) + '">' + (window.i18n.t('compiler.download')) + '</button>'
                        }
                        ${isDownloaded ? '<span class="status downloaded-status">' + (window.i18n.t('compiler.downloaded')) + '</span>' : ''}
                    </div>
                `;

                
                this.addTestlibItemListeners(testlibDiv, testlib);
                testlibList.appendChild(testlibDiv);
            }
            
        } catch (error) {
            if (controller !== this._testlibListAbort) {
                return;
            }
            if (isTimeoutError(error)) {
                logError('获取Testlib列表超时:', error);
                testlibList.innerHTML = `
                    <div class="error-message">
                        <p>${window.i18n.t('compiler.requestTimeout')}</p>
                        <button class="retry-btn">${window.i18n.t('compiler.retry')}</button>
                    </div>
                `;
                const timeoutRetryBtn = testlibList.querySelector('.retry-btn');
                if (timeoutRetryBtn) {
                    timeoutRetryBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        this.loadAvailableTestlibs();
                    });
                }
                return;
            }
            logError('获取Testlib列表失败:', error);
            testlibList.innerHTML = `
                <div class="error-message">
                    <p>${window.i18n.t('compiler.networkError')}</p>
                    <p class="error-detail">${escapeHtml(error.message)}</p>
                    <button class="retry-btn" data-i18n="compiler.retry">Retry</button>
                </div>
            `;
            const retryBtn = testlibList.querySelector('.retry-btn');
            if (retryBtn) {
                retryBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.loadAvailableTestlibs();
                });
            }
        } finally {
            clearTimeout(timeoutTimer);
            if (controller === this._testlibListAbort) {
                this._testlibListAbort = null;
            }
        }
    }
    
    addTestlibItemListeners(testlibDiv, testlib) {
        const rawBtn = testlibDiv.querySelector('.download-btn');
        const downloadBtn = rawBtn instanceof HTMLButtonElement ? rawBtn : null;
        if (downloadBtn) {
            downloadBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.downloadTestlib(testlib);
            });
        }
        
        const selectBtn = testlibDiv.querySelector('.select-btn');
        if (selectBtn) {
            selectBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.selectTestlib(testlib.version);
            });
        }
    }
    
    async downloadTestlib(testlib) {
        const rawBtn = this.findListItem('testlib', testlib.version)?.querySelector('button.download-btn') || null;
        const downloadBtn = rawBtn instanceof HTMLButtonElement ? rawBtn : null;
        if (!downloadBtn) return;
        
        try {
            downloadBtn.disabled = true;
            downloadBtn.textContent = window.i18n.t('compiler.downloading');
            
            this.showMessage(window.i18n.t('compiler.startDownload', {
                name: testlib.name,
                version: testlib.version
            }), 'info');
            
            if (window.electronAPI && window.electronAPI.downloadTestlib) {
                const testlibUrl = testlib?.downloadUrl || testlib?.download_url || '';
                const fullUrl = testlibUrl.startsWith('http')
                    ? testlibUrl
                    : `https://oicpp.mywwzh.top${testlibUrl}`;
                
                const result = await window.electronAPI.downloadTestlib({
                    url: fullUrl,
                    version: testlib.version,
                    name: testlib.name
                });
                
                if (result.success) {
                    this.showMessage(window.i18n.t('compiler.downloadSuccess', {
                        name: testlib.name,
                        version: testlib.version
                    }), 'success');
                    
                    downloadBtn.textContent = window.i18n.t('compiler.downloaded');
                    downloadBtn.disabled = false;
                    downloadBtn.classList.remove('download-btn');
                    downloadBtn.classList.add('downloaded-btn');
                    
                    if (result.testlibPath) {
                        await this.setTestlibPath(result.testlibPath);
                        await this.selectTestlib(testlib.version);
                    }
                } else {
                    throw new Error(result.error || window.i18n.t('compiler.unknownError'));
                }
            } else {
                throw new Error(window.i18n.t('compiler.downloadApiUnavailable'));
            }
        } catch (error) {
            logError('下载Testlib失败:', error);
            this.showMessage(window.i18n.t('compiler.downloadFail', { error: error.message }), 'error');
            
            if (downloadBtn) {
                downloadBtn.disabled = false;
                downloadBtn.textContent = window.i18n.t('compiler.download');
            }
        }
    }
    
    async selectTestlib(version) {
        try {
            if (window.electronAPI && window.electronAPI.selectTestlib) {
                const result = await window.electronAPI.selectTestlib(version);
                
                if (result.success) {
                    this.showMessage(window.i18n.t('compiler.testlibSelected', { version }), 'success');
                    
                    if (result.testlibPath) {
                        await this.setTestlibPath(result.testlibPath);
                    }
                    
                    const testlibItems = this.getListItems('testlib');
                    testlibItems.forEach(item => {
                        const selectBtn = item.querySelector('.select-btn');
                        if (selectBtn) {
                            const itemVersion = selectBtn.getAttribute('data-version');
                            if (itemVersion === version) {
                                item.classList.add('selected');
                                const actionsDiv = item.querySelector('.compiler-actions');
                                actionsDiv.innerHTML = `
                                    <span class="status selected-status">${window.i18n.t('compiler.selected')}</span>
                                    <span class="status downloaded-status">${window.i18n.t('compiler.downloaded')}</span>
                                `;
                            } else {
                                item.classList.remove('selected');
                                if (item.classList.contains('downloaded')) {
                                    const actionsDiv = item.querySelector('.compiler-actions');
                                    actionsDiv.innerHTML = `
                                        <button class="select-btn" data-version="${escapeHtml(itemVersion)}">${window.i18n.t('compiler.select')}</button>
                                        <span class="status downloaded-status">${window.i18n.t('compiler.downloaded')}</span>
                                    `;
                                    const newSelectBtn = actionsDiv.querySelector('.select-btn');
                                    if (newSelectBtn) {
                                        newSelectBtn.addEventListener('click', (e) => {
                                            e.preventDefault();
                                            this.selectTestlib(itemVersion);
                                        });
                                    }
                                }
                            }
                        }
                    });
                } else {
                    throw new Error(result.error || window.i18n.t('compiler.unknownError'));
                }
            }
        } catch (error) {
            logError('选择Testlib失败:', error);
            this.showMessage(window.i18n.t('compiler.testlibSelectFail', { error: error.message }), 'error');
        }
    }
    
    async setTestlibPath(path) {
        const testlibPathInput = elCtl('testlib-path');
        if (testlibPathInput) {
            testlibPathInput.value = path;
        }

        if (window.electronAPI && window.electronAPI.saveSetting) {
            await window.electronAPI.saveSetting('testlibPath', path);
        }
    }
    
    async getDownloadedTestlibVersions() {
        try {
            if (window.electronAPI && window.electronAPI.getDownloadedTestlibs) {
                return await window.electronAPI.getDownloadedTestlibs();
            }
        } catch (error) {
            logError('获取已下载Testlib失败:', error);
        }
        return [];
    }
    
    async isTestlibSelected(version) {
        try {
            if (window.electronAPI && window.electronAPI.isTestlibSelected) {
                return await window.electronAPI.isTestlibSelected(version);
            }
        } catch (error) {
            logError('检查Testlib选择状态失败:', error);
        }
        return false;
    }

    closeWindow() {
        window.close();
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new CompilerSettings();
});
