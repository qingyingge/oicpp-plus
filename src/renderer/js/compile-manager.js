// 云编译/结果拉取依赖上游服务 oicpp.mywwzh.top，fork 需自建后端
class CompilerManager {
    t(key, params, fallback) {
        return window.i18n?.t?.(key, params) || fallback || key;
    }

    constructor() {
        this.settings = {
            compilerPath: '',
            compilerArgs: '-std=c++14 -O2 -static',
            runMode: 'popup',
            workingDirectory: ''
        };
        
        this.isCompiling = false;
        this.isRunning = false;
        this.compileOutput = null;
        this.shouldRunAfterCompile = false;
        this.isCloudCompiling = false;
        this.cloudCompileTaskId = null;
        this.cloudCompilePollTimer = null;
        this.cloudCompileAbortController = null;
        this.cloudProgressLine = null;
        this.cloudQueueLastCount = null;
        this.cloudCompileStartTime = null;
        this.analysisList = null;
        this.analysisEmptyState = null;
        this.activePane = 'raw';
        this.analysisHasContent = false;
        this.tabButtons = [];
        this.analysisHint = null;
        this.analysisAvailable = false;

        if (window.i18n?.onChange) {
            window.i18n.onChange(() => {
                if (!this.compileOutput) return;
                this.updateAnalysisVisibility();
            });
        }
    }

    init() {
        logInfo('编译管理器初始化...');
        this.createCompileOutputWindow();
        this.setupEventListeners();
        this.loadSettings();
    }

    createCompileOutputWindow() {
        let existingWindow = document.querySelector('.compile-output-window');
        if (existingWindow) {
            existingWindow.remove();
        }

        this.compileOutput = document.createElement('div');
        this.compileOutput.className = 'compile-output-window hidden';
        this.compileOutput.id = 'compile-output-panel';
        this.compileOutput.innerHTML = `
            <div class="compile-output-header">
                <div class="compile-output-title">
                    <span class="compile-status" id="compile-status-text"data-i18n="compileOutput.title">Compile Output</span>
                </div>
                <div class="compile-output-controls">
                    <button class="compile-output-clear" id="clear-compile-output" data-i18n-title="panel.clearOutput" title="清空输出">
                        <i class="icon-clear">🗑️</i>
                    </button>
                    <button class="compile-output-close" id="close-compile-output" data-i18n-title="dialog.close" title="关闭">
                        <i class="icon-close">✕</i>
                    </button>
                </div>
            </div>
            <div class="compile-output-content">
                <div class="compile-output-toolbar">
                    <div class="compile-output-tabs" role="tablist" aria-label="${this.t('panel.compileOutputView', null, 'Toggle compile output view')}">
                        <button class="compile-tab-btn active" data-pane="raw" role="tab" aria-selected="true"><span data-i18n="panel.rawOutput">原始输出</span></button>
                        <button class="compile-tab-btn" data-pane="analysis" role="tab" aria-selected="false"><span data-i18n="panel.errorParsing">报错解析</span></button>
                    </div>
                    <div class="compile-output-hint" data-i18n="panel.autoSwitchInfo">Automatically switches to parse view when warnings/errors are detected</div>
                </div>
                <div class="compile-output-body">
                    <div class="compile-pane compile-pane-raw active" data-pane="raw">
                        <div class="compile-output-text" id="compile-output-messages">
                            <div id="compile-command-text" class="output-line output-command" style="display: none;"></div>
                        </div>
                    </div>
                    <div class="compile-pane compile-pane-analysis" data-pane="analysis">
                        <div class="analysis-empty" id="compile-analysis-empty">${this.t('panel.noParseContent')}</div>
                        <div class="analysis-list" id="compile-analysis-list"></div>
                    </div>
                </div>
            </div>
            <div class="compile-output-resizer" data-i18n-title="panel.dragResize" title="拖拽调整高度"></div>
        `;

        const editorContainer = document.querySelector('.editor-container');
        if (editorContainer) {
            editorContainer.appendChild(this.compileOutput);
        } else {
            document.body.appendChild(this.compileOutput);
        }

        this.compileOutput.querySelector('.compile-output-clear').addEventListener('click', () => {
            this.clearOutput();
        });

        this.compileOutput.querySelector('.compile-output-close').addEventListener('click', () => {
            this.hideOutput();
        });

        this.analysisList = this.compileOutput.querySelector('#compile-analysis-list');
        this.analysisEmptyState = this.compileOutput.querySelector('#compile-analysis-empty');
        this.analysisHint = this.compileOutput.querySelector('.compile-output-hint');
        this.tabButtons = Array.from(this.compileOutput.querySelectorAll('.compile-tab-btn'));
        this.tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const target = btn.dataset.pane === 'analysis' ? 'analysis' : 'raw';
                this.switchOutputPane(target);
            });
        });

        try {
            const savedH = localStorage.getItem('oicpp.compileOutput.height');
            this.setCompileOutputHeight(savedH || 300, Boolean(savedH));
        } catch {}

        const resizer = this.compileOutput.querySelector('.compile-output-resizer');
        if (resizer) {
            let startY = 0;
            let startH = 0;
            const onMove = (e) => {
                const dy = (e.touches ? e.touches[0].clientY : e.clientY) - startY;
                this.setCompileOutputHeight(startH - dy);
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                window.removeEventListener('touchmove', onMove);
                window.removeEventListener('touchend', onUp);
                this.persistCompileOutputHeight();
            };
            const onDown = (e) => {
                startY = e.touches ? e.touches[0].clientY : e.clientY;
                startH = this.compileOutput.getBoundingClientRect().height;
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
                window.addEventListener('touchmove', onMove);
                window.addEventListener('touchend', onUp);
            };
            resizer.addEventListener('mousedown', onDown);
            resizer.addEventListener('touchstart', onDown);
        }

        window.addEventListener('resize', () => {
            if (!this.compileOutput) return;
            const currentHeight = Number.parseFloat(this.compileOutput.style.height) || 300;
            this.setCompileOutputHeight(currentHeight, true);
        });

        this.switchOutputPane(this.activePane || 'raw');
        this.updateAnalysisVisibility();
    }

    getCompileOutputHeightBounds() {
        const hostHeight = this.compileOutput?.parentElement?.clientHeight || window.innerHeight || 300;
        const maxHeight = Math.max(1, Math.floor(hostHeight - 48));
        return {
            minHeight: Math.min(120, maxHeight),
            maxHeight
        };
    }

    setCompileOutputHeight(height, persist = false) {
        if (!this.compileOutput) return;

        const { minHeight, maxHeight } = this.getCompileOutputHeightBounds();
        const requestedHeight = Number.parseFloat(height);
        const fallbackHeight = Math.min(300, maxHeight);
        const nextHeight = Math.max(
            minHeight,
            Math.min(maxHeight, Number.isFinite(requestedHeight) ? Math.round(requestedHeight) : fallbackHeight)
        );
        this.compileOutput.style.height = `${nextHeight}px`;

        if (persist) this.persistCompileOutputHeight();
    }

    persistCompileOutputHeight() {
        if (!this.compileOutput) return;

        try {
            const inlineHeight = Number.parseFloat(this.compileOutput.style.height);
            const height = Math.round(
                Number.isFinite(inlineHeight)
                    ? inlineHeight
                    : this.compileOutput.getBoundingClientRect().height
            );
            localStorage.setItem('oicpp.compileOutput.height', String(height));
        } catch {}
    }

    setupEventListeners() {
        if (window.electron && window.electron.ipcRenderer) {
            const ipcRenderer = window.electron.ipcRenderer;

            this._ipcListeners = {
                'compile-result': (result) => this.handleCompileResult(result),
                'compile-error': (error) => this.handleCompileError(error),
                'run-result': (result) => this.handleRunResult(result),
                'run-error': (error) => this.handleRunError(error),
                'settings-changed': (_event, _settingsType, newSettings) => {
                    logInfo('编译管理器收到设置变化通知:', newSettings);
                    if (newSettings && (newSettings.compilerPath !== undefined || newSettings.compilerArgs !== undefined || newSettings.runMode !== undefined)) {
                        this.updateSettings({
                            compilerPath: newSettings.compilerPath !== undefined ? newSettings.compilerPath : this.settings.compilerPath,
                            compilerArgs: newSettings.compilerArgs !== undefined ? newSettings.compilerArgs : this.settings.compilerArgs,
                            runMode: newSettings.runMode !== undefined ? newSettings.runMode : this.settings.runMode
                        });
                        logInfo('编译管理器设置已更新:', this.settings);
                    }
                }
            };

            for (const [channel, handler] of Object.entries(this._ipcListeners)) {
                ipcRenderer.on(channel, handler);
            }

            logInfo('编译管理器 IPC 监听器已设置');
        } else {
            logWarn('Electron 环境不可用，跳过 IPC 监听器设置');
        }
    }

    removeEventListeners() {
        if (!this._ipcListeners || !window.electron || !window.electron.ipcRenderer) return;
        const ipcRenderer = window.electron.ipcRenderer;
        for (const [channel, handler] of Object.entries(this._ipcListeners)) {
            ipcRenderer.removeListener(channel, handler);
        }
        this._ipcListeners = null;
    }

    async loadSettings() {
        try {
            const isIntegratedOnlyPlatform = !!(typeof window !== 'undefined' && window.process && (window.process.platform === 'darwin' || window.process.platform === 'linux'));
            const isMacPlatform = !!(typeof window !== 'undefined' && window.process && window.process.platform === 'darwin');
            if (window.electronAPI && window.electronAPI.getAllSettings) {
                const allSettings = await window.electronAPI.getAllSettings();
                if (allSettings) {
                    const loadedCompilerArgs = allSettings.compilerArgs || (isMacPlatform ? '-std=c++14 -O2' : '-std=c++14 -O2 -static');
                    this.updateSettings({
                        compilerPath: allSettings.compilerPath || '',
                        compilerArgs: isMacPlatform
                            ? loadedCompilerArgs.replace(/\s-static\b/g, ' ').replace(/\s+/g, ' ').trim()
                            : loadedCompilerArgs,
                        runMode: isIntegratedOnlyPlatform ? 'integrated-terminal' : (allSettings.runMode || 'popup')
                    });
                    logInfo('编译器设置已加载:', this.settings);
                }
            } else {
                logInfo('window.electronAPI 不可用，使用默认编译器设置');
                const savedSettings = localStorage.getItem('oicpp-settings');
                if (savedSettings) {
                    const parsed = JSON.parse(savedSettings);
                    const loadedCompilerArgs = parsed.compilerArgs || (isMacPlatform ? '-std=c++14 -O2' : '-std=c++14 -O2 -static');
                    this.updateSettings({
                        compilerPath: parsed.compilerPath || '',
                        compilerArgs: isMacPlatform
                            ? loadedCompilerArgs.replace(/\s-static\b/g, ' ').replace(/\s+/g, ' ').trim()
                            : loadedCompilerArgs,
                        runMode: isIntegratedOnlyPlatform ? 'integrated-terminal' : (parsed.runMode || 'popup')
                    });
                    logInfo('从本地存储加载编译器设置:', this.settings);
                }
            }
        } catch (error) {
            logError('加载编译器设置失败:', error);
        }
    }

    updateSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
    }

    async compileCurrentFile(options = {}) {
        try {
            await this.autoSaveCurrentFile();
            logInfo('compileCurrentFile 被调用，自动保存当前文件');
            await this.loadSettings();
            logInfo('重新加载设置后的编译器设置:', this.settings);

            if (!this.settings.compilerPath) {
                logInfo('编译器路径为空，显示设置提示');
                this.showMessage(this.t('message.setCompilerFirst', null, 'Please configure the compiler first'), 'error');
                this.openCompilerSettings();
                return;
            }

            logInfo('使用编译器路径:', this.settings.compilerPath);

            const currentEditor = window.editorManager?.getCurrentEditor();
            if (!currentEditor) {
                this.showMessage(this.t('message.noOpenFile', null, 'No file is open'), 'error');
                return;
            }

            let filePath = currentEditor.filePath || (currentEditor.getFilePath && currentEditor.getFilePath());
            const content = currentEditor.getValue();

            logInfo('[编译管理器] 获取到的文件路径:', filePath);
            logInfo('[编译管理器] 文件路径类型:', typeof filePath);
            logInfo('[编译管理器] currentEditor.filePath:', currentEditor.filePath);
            if (!filePath || filePath === 'null' || filePath === 'undefined' || filePath.toString().startsWith('untitled')) {
                logInfo('[编译管理器] 文件路径无效，提示保存文件');
                this.showMessage(this.t('message.saveFileFirst', null, 'Please save the file first'), 'error');
                return;
            }

            if (filePath && typeof filePath === 'string') {
                 const isWin = (typeof window !== 'undefined' && window.process && window.process.platform === 'win32');
                 if (isWin) {
                     filePath = filePath.replace(/\//g, '\\');
                 }
            }

            this.isCompiling = true;
            this.showOutput();
            this.setStatus(this.t('compileOutput.compiling', null, 'Compiling...'));
            this.clearOutput();

            const inputFile = filePath;
            const outputFile = this.getExecutablePath(filePath);

            let compilerArgs = this.settings.compilerArgs;
            const isMacPlatform = !!(typeof window !== 'undefined' && window.process && window.process.platform === 'darwin');
            if (isMacPlatform && /\s-static\b/.test(` ${compilerArgs}`)) {
                compilerArgs = compilerArgs.replace(/\s-static\b/g, ' ').replace(/\s+/g, ' ').trim();
                this.appendOutput(this.t('cloudCompile.detectMacOS') + '\n', 'warning');
            }
            if (options.forDebug) {
                if (!compilerArgs.includes('-g')) {
                    compilerArgs = compilerArgs + ' -g';
                }
                compilerArgs = compilerArgs.replace(/\s*-O[^\s]*/gi, ' ');
                compilerArgs = compilerArgs.replace(/\s+/g, ' ').trim();
                if (!/\b-O0\b/.test(compilerArgs)) {
                    compilerArgs = `${compilerArgs} -O0`.trim();
                }
                compilerArgs = compilerArgs.replace(/-s\b/g, '');
                compilerArgs = compilerArgs.replace(/\s+/g, ' ').trim();
                this.appendOutput(this.t('compileOutput.modeDebug', null, 'Compilation mode: Debug (debug info, optimizations disabled)') + '\n', 'info');
            } else {
                if (!compilerArgs.includes('-g')) {
                    compilerArgs = compilerArgs + ' -g';
                    this.appendOutput(this.t('compileOutput.modeNormal', null, 'Compilation mode: Normal (with debug info)') + '\n', 'info');
                }
            }

            const compileCommand = this.buildCompileCommand(inputFile, outputFile, compilerArgs);

            logInfo(`源文件: ${inputFile}`);
            logInfo(`目标文件: ${outputFile}`);
            logInfo(`编译命令: ${compileCommand}`);

            this.appendOutput(this.t('compileOutput.command', { command: compileCommand }, `Compilation command: ${compileCommand}`) + '\n', 'command');
            this.appendOutput(this.t('compileOutput.targetFile', { file: outputFile }, `Output file: ${outputFile}`) + '\n', 'info');
            this.appendOutput(this.t('compileOutput.compiling', null, 'Compiling...') + '\n', 'info');

            if (typeof require !== 'undefined') {
                try {
                    const { ipcRenderer } = require('electron');
                    const result = await ipcRenderer.invoke('compile-file', {
                        inputFile,
                        outputFile,
                        compilerPath: this.settings.compilerPath,
                        compilerArgs: compilerArgs,
                        workingDirectory: this.getWorkingDirectory(filePath)
                    });
                    this.handleCompileResult(result);
                } catch (error) {
                    this.handleCompileError(this.t('cloudCompile.ipcFailed') + ': ' + error.message);
                }
            } else {
                this.handleCompileError(this.t('cloudCompile.electronUnavailable'));
            }

        } catch (error) {
            logError('编译失败:', error);
            this.handleCompileError(error.message);
        }
    }

    async cloudCompileCurrentFile() {
        try {
            if (!this.isWindowsPlatform()) {
                this.showMessage(this.t('message.cloudCompileWindowsOnly', null, 'Cloud compilation is currently available only on Windows'), 'warning');
                return;
            }

            const currentEditor = window.editorManager?.getCurrentEditor();
            if (!currentEditor) {
                this.showMessage(this.t('message.noOpenFile', null, 'No file is open'), 'error');
                return;
            }

            const filePath = currentEditor.filePath || (currentEditor.getFilePath && currentEditor.getFilePath());
            if (!filePath || filePath === 'null' || filePath === 'undefined' || filePath.toString().startsWith('untitled')) {
                this.showMessage(this.t('message.saveFileFirst', null, 'Please save the file first'), 'error');
                return;
            }

            if (!/\.cpp$/i.test(filePath)) {
                this.showMessage(this.t('message.cloudCompileCppOnly', null, 'Cloud compilation currently supports only .cpp files'), 'error');
                return;
            }

            this.shouldRunAfterCompile = false;

            await this.autoSaveCurrentFile();

            const codeContent = currentEditor.getValue() ?? '';
            const encoder = new TextEncoder();
            const byteLength = encoder.encode(codeContent).length;

            if (byteLength > 20 * 1024) {
                this.showOutput();
                this.clearOutput();
                this.setStatus(this.t('cloudCompile.failed'));
                const sizeText = this.formatByteSize(byteLength);
                this.appendOutput(this.t('cloudCompile.codeTooLong', { size: sizeText }), 'error');
                return;
            }

            this.cancelCloudCompilationPolling();
            if (this.cloudCompileAbortController) {
                try {
                    this.cloudCompileAbortController.abort();
                } catch (_) {}
            }
            this.cloudCompileAbortController = new AbortController();

            this.isCompiling = true;
            this.isCloudCompiling = true;
            this.cloudCompileTaskId = null;
            this.cloudQueueLastCount = null;
            this.cloudProgressLine = null;
            this.cloudCompileStartTime = Date.now();

            this.showOutput();
            this.clearOutput();
            this.setStatus(this.t('cloudCompile.compiling'));
            this.appendOutput(this.t('cloudCompile.sendingToService'), 'info');

            let token = '';
            let loginToken = '';
            try {
                if (window.electronAPI && window.electronAPI.getEncodedToken) {
                    token = await window.electronAPI.getEncodedToken();
                }
                if (window.electronAPI && window.electronAPI.getIdeLoginStatus) {
                    const status = await window.electronAPI.getIdeLoginStatus();
                    loginToken = status?.loginToken || '';
                }
            } catch (e) { logWarn('获取编码 token 失败:', e); }

            const payload = {
                cpp: codeContent,
                token: token || ''
            };

            if (loginToken) {
                payload.login_token = loginToken;
            }

            const response = await fetch(`https://oicpp.mywwzh.top/api/cloudCompilation`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: this.cloudCompileAbortController.signal
            });

            let data = null;
            try {
                data = await response.json();
            } catch (error) {
                logWarn('解析云编译响应失败:', error);
            }

            if (!data) {
                throw new Error(this.t('cloudCompile.serviceError', { status: response.status }));
            }

            if (data.code === 200 && data.task_id) {
                this.cloudCompileTaskId = data.task_id;
                this.appendOutput(this.t('cloudCompile.taskCreated', { taskId: data.task_id }), 'info');
                this.setCloudProgressMessage(this.t('cloudCompile.taskSubmitted'), 'info');
                this.pollCloudCompilationResult(data.task_id, 0);
                return;
            }

            if (data.code === 400) {
                this.setStatus(this.t('cloudCompile.failed'));
                if (data.msg) {
                    this.appendMultilineOutput(data.msg, 'error');
                }
                this.showMessage(data.msg || this.t('cloudCompile.codeTooLongLimit'), 'error');
                this.resetCloudCompileState();
                return;
            }

            if (data.code === 429) {
                this.setStatus(this.t('cloudCompile.restricted'));
                this.appendOutput(this.t('cloudCompile.rateLimited'), 'warning');
                if (data.msg) {
                    this.appendMultilineOutput(data.msg, 'warning');
                }
                this.showMessage(data.msg || this.t('cloudCompile.rateLimitedSimple'), 'warning');
                this.resetCloudCompileState();
                return;
            }

            const message = data.msg || this.t('cloudCompile.unknownStatus', { code: data.code });
            this.setStatus(this.t('cloudCompile.failed'));
            this.appendOutput(message, 'error');
            this.showMessage(message, 'error');
            this.resetCloudCompileState();
        } catch (error) {
            if (error?.name === 'AbortError') {
                this.appendOutput(this.t('cloudCompile.requestCancelled'), 'warning');
            } else {
                const message = error?.message || this.t('cloudCompile.requestFailed');
                this.setStatus(this.t('cloudCompile.failed'));
                this.appendOutput(message, 'error');
                this.showMessage(message, 'error');
            }
            this.resetCloudCompileState();
        }
    }

    async runCurrentFile() {
        try {
            await this.autoSaveCurrentFile();

            const currentEditor = window.editorManager?.getCurrentEditor();
            if (!currentEditor) {
                this.showMessage(this.t('message.noOpenFile', null, 'No file is open'), 'error');
                return;
            }

            const filePath = currentEditor.filePath || (currentEditor.getFilePath && currentEditor.getFilePath());
            if (!filePath || filePath.startsWith('untitled')) {
                this.showMessage(this.t('message.saveFileFirst', null, 'Please save the file first'), 'error');
                return;
            }

            const executablePath = this.getExecutablePath(filePath);
            logInfo(`检查可执行文件路径: ${executablePath}`);
            
            const exists = await this.checkFileExists(executablePath);
            logInfo(`可执行文件存在性检查结果: ${exists}`);
            
            if (!exists) {
                this.showMessage(this.t('message.compileBeforeRun', { file: executablePath }, `Please compile the program first (not found: ${executablePath})`), 'error');
                return;
            }

            this.isRunning = true;
            this.showOutput();
            this.appendOutput(this.t('compileOutput.startingProgram', { file: executablePath }, `Starting program: ${executablePath}`) + '\n', 'info');
            this.runExecutable(executablePath);

        } catch (error) {
            logError('运行失败:', error);
            this.showMessage(this.t('message.runFailed', { error: error.message }, `Failed to run: ${error.message}`), 'error');
        }
    }

    async compileAndRun() {
        try {
            this.shouldRunAfterCompile = true;
            await this.compileCurrentFile();
        } catch (error) {
            logError('编译并运行失败:', error);
            this.shouldRunAfterCompile = false;
        }
    }

    buildCompileCommand(inputFile, outputFile, customArgs = null) {
        const args = [
            `"${inputFile}"`,
            customArgs || this.settings.compilerArgs,
            `-o "${outputFile}"`
        ].filter(arg => arg.trim()).join(' ');
        
        return `"${this.settings.compilerPath}" ${args}`;
    }

    getExecutablePath(sourceFile) {
        const isWin = (typeof window !== 'undefined' && window.process && window.process.platform === 'win32');
        
        let normalizedPath = sourceFile;
        if (isWin) {
            normalizedPath = sourceFile.replace(/\//g, '\\');
        } else {
            normalizedPath = sourceFile.replace(/\\/g, '/');
        }

        const sep = isWin ? '\\' : '/';
        const lastSlash = normalizedPath.lastIndexOf(sep);
        const dir = lastSlash >= 0 ? normalizedPath.substring(0, lastSlash) : '';
        const fileName = lastSlash >= 0 ? normalizedPath.substring(lastSlash + 1) : normalizedPath;
        
        const dot = fileName.lastIndexOf('.');
        const nameWithoutExt = dot >= 0 ? fileName.substring(0, dot) : fileName;
        
        const base = (dir ? (dir + (dir.endsWith(sep) ? '' : sep)) : '') + nameWithoutExt;
        return isWin ? base + '.exe' : base;
    }

    getWorkingDirectory(filePath) {
        const lastSlash = filePath.lastIndexOf('/') > filePath.lastIndexOf('\\') ?
            filePath.lastIndexOf('/') : filePath.lastIndexOf('\\');
        return filePath.substring(0, lastSlash);
    }

    async checkFileExists(filePath) {
        try {
            if (window.electronAPI && window.electronAPI.checkFileExists) {
                return await window.electronAPI.checkFileExists(filePath);
            }

            logWarn('无法检查文件存在性，假设文件存在:', filePath);
            return true;
        } catch (error) {
            logError('检查文件存在性失败:', error);
            return true;
        }
    }

    runExecutable(executablePath) {
        if (typeof require !== 'undefined') {
            try {
                const { ipcRenderer } = require('electron');
                ipcRenderer.invoke('run-executable', {
                    executablePath,
                    workingDirectory: this.getWorkingDirectory(executablePath)
                }).then(result => {
                    this.handleRunResult(result);
                }).catch(error => {
                    this.handleRunError(error.message || error);
                });
            } catch (error) {
                this.handleRunError(this.t('cloudCompile.ipcFailed') + ': ' + error.message);
            }
        } else {
            this.handleRunError(this.t('cloudCompile.electronUnavailable'));
        }
    }

    async pollCloudCompilationResult(taskId, attempt = 0) {
        if (!taskId || !this.isCloudCompiling) return;
        if (attempt >= 300) {
            this.setStatus(this.t('cloudCompile.timedOut'));
            this.setCloudProgressMessage(this.t('cloudCompile.timedOutMsg'), 'error');
            this.appendOutput(this.t('cloudCompile.timedOutRetry'), 'error');
            this.showMessage(this.t('message.cloudCompileTimeout', null, 'Cloud compilation timed out. Please try again later.'), 'error');
            this.resetCloudCompileState();
            return;
        }

        try {
            const response = await fetch(`https://oicpp.mywwzh.top/api/getCloudCompilationResult?task_id=${encodeURIComponent(taskId)}`, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json'
                }
            });

            let data = null;
            try {
                data = await response.json();
            } catch (error) {
                logWarn('解析云编译结果失败:', error);
            }

            if (!data) {
                throw new Error(this.t('cloudCompile.serviceError', { status: response.status }));
            }

            switch (data.code) {
                case 200:
                    this.updateCloudQueueStatus(data.queueFrontCnt);
                    this.scheduleCloudCompilationPoll(taskId, attempt + 1);
                    break;
                case 201:
                    this.handleCloudCompilationSuccess(data);
                    break;
                case 202:
                    this.handleCloudCompilationFailure(data);
                    break;
                default:
                    throw new Error(data.msg || this.t('cloudCompile.unknownStatus', { code: data.code }));
            }
        } catch (error) {
            if (attempt + 1 >= 300) {
                const message = this.t('cloudCompile.statusQueryFailed', { error: error?.message || error });
                this.setStatus(this.t('cloudCompile.failed'));
                this.setCloudProgressMessage(this.t('cloudCompile.statusQueryFailedRetry'), 'error');
                this.appendOutput(message, 'error');
                this.showMessage(this.t('message.cloudCompileStatusFailed', null, 'Failed to retrieve cloud compilation status. Please try again later.'), 'error');
                this.resetCloudCompileState();
                return;
            }

            this.appendOutput(this.t('cloudCompile.statusQueryFailedAttempt', { attempt: attempt + 1, error: error?.message || error }), 'warning');
            this.scheduleCloudCompilationPoll(taskId, attempt + 1);
        }
    }

    scheduleCloudCompilationPoll(taskId, nextAttempt) {
        this.cancelCloudCompilationPolling();
        this.cloudCompilePollTimer = setTimeout(() => {
            this.pollCloudCompilationResult(taskId, nextAttempt);
        }, 2000);
    }

    updateCloudQueueStatus(queueFrontCnt) {
        if (!this.isCloudCompiling) return;
        if (typeof queueFrontCnt === 'number' && queueFrontCnt >= 0) {
            this.setStatus(this.t('cloudCompile.queuing', { count: queueFrontCnt }));
            if (this.cloudQueueLastCount !== queueFrontCnt) {
                this.setCloudProgressMessage(this.t('cloudCompile.queuingAhead', { count: queueFrontCnt }), 'info');
                this.cloudQueueLastCount = queueFrontCnt;
            }
        } else {
            this.setStatus(this.t('cloudCompile.queuingWait'));
            this.setCloudProgressMessage(this.t('cloudCompile.queuingPlease'), 'info');
            this.cloudQueueLastCount = null;
        }
    }

    setCloudProgressMessage(text, type = 'info') {
        if (!text) return;
        if (!this.compileOutput) this.createCompileOutputWindow();
        if (!this.compileOutput) return;
        if (!this.cloudProgressLine || !this.cloudProgressLine.parentElement) {
            this.cloudProgressLine = this.appendOutput(text, type);
        } else {
            this.cloudProgressLine.className = `output-line output-${type}`;
            this.cloudProgressLine.textContent = text;
        }
    }

    handleCloudCompilationSuccess(data) {
        const duration = this.cloudCompileStartTime ? ((Date.now() - this.cloudCompileStartTime) / 1000).toFixed(2) : null;
        const status = duration ? this.t('cloudCompile.successWithTime', { time: duration }) : this.t('cloudCompile.success');
        this.setStatus(status);
        this.setCloudProgressMessage(this.t('cloudCompile.passResult'), 'success');
        this.appendOutput(this.t('cloudCompile.passed'), 'success');
        if (data.msg) {
            this.appendOutput(this.t('cloudCompile.compilerOutput'), 'info');
            this.appendMultilineOutput(data.msg, 'info');
        }
        this.resetCloudCompileState();
    }

    handleCloudCompilationFailure(data) {
        const duration = this.cloudCompileStartTime ? ((Date.now() - this.cloudCompileStartTime) / 1000).toFixed(2) : null;
        const status = duration ? this.t('cloudCompile.failWithTime', { time: duration }) : this.t('cloudCompile.failed');
        this.setStatus(status);
        this.setCloudProgressMessage(this.t('cloudCompile.failCheckError'), 'error');
        this.appendOutput(this.t('cloudCompile.failedSimple'), 'error');
        if (data.msg) {
            this.appendOutput(this.t('cloudCompile.compilerErrors'), 'error');
            this.appendMultilineOutput(data.msg, 'error');
        }
        this.resetCloudCompileState();
    }

    appendMultilineOutput(message, type = 'info') {
        if (!message) return;
        const lines = String(message).split(/\r?\n/);
        lines.forEach(line => {
            if (line.trim().length > 0) {
                this.appendOutput(line, type);
            }
        });
    }

    cancelCloudCompilationPolling() {
        if (this.cloudCompilePollTimer) {
            clearTimeout(this.cloudCompilePollTimer);
            this.cloudCompilePollTimer = null;
        }
    }

    resetCloudCompileState() {
        this.cancelCloudCompilationPolling();
        this.isCompiling = false;
        this.isCloudCompiling = false;
        this.cloudCompileTaskId = null;
        this.cloudCompileAbortController = null;
        this.cloudQueueLastCount = null;
        this.cloudCompileStartTime = null;
    }

    formatByteSize(bytes) {
        if (bytes < 1024) return this.t('cloudCompile.formatBytes', { bytes });
        const kb = bytes / 1024;
        if (kb < 1024) {
            return kb >= 100 ? `${Math.round(kb)} KB` : `${kb.toFixed(2)} KB`;
        }
        const mb = kb / 1024;
        return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(2)} MB`;
    }

    extractFileName(filePath) {
        if (!filePath) return '';
        const segments = filePath.split(/[\\/]/);
        return segments.pop() || '';
    }

    isWindowsPlatform() {
        try {
            return !!(window.process && window.process.platform === 'win32');
        } catch (_) {
            return false;
        }
    }

    switchOutputPane(pane) {
        if (!this.compileOutput) this.createCompileOutputWindow();
        if (!this.compileOutput) return;
        let target = pane === 'analysis' ? 'analysis' : 'raw';
        if (target === 'analysis' && (!this.analysisAvailable || !this.isSmartAnalysisEnabled())) {
            target = 'raw';
        }
        this.activePane = target;

        const panes = this.compileOutput.querySelectorAll('.compile-pane');
        panes.forEach((p) => {
            const isActive = p.dataset.pane === target;
            p.classList.toggle('active', isActive);
            if (isActive) {
                p.removeAttribute('aria-hidden');
            } else {
                p.setAttribute('aria-hidden', 'true');
            }
        });

        this.tabButtons.forEach((btn) => {
            const isActive = btn.dataset.pane === target;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        if (target === 'analysis' && this.analysisList) {
            this.analysisList.scrollTop = 0;
        }
    }

    updateAnalysisVisibility() {
        const analysisEnabled = this.isSmartAnalysisEnabled();
        const shouldShowAnalysis = analysisEnabled && this.analysisAvailable;
        const toolbar = this.compileOutput?.querySelector('.compile-output-toolbar');
        if (toolbar) {
            toolbar.style.display = analysisEnabled ? '' : 'none';
        }
        const analysisBtn = this.tabButtons.find((btn) => btn.dataset.pane === 'analysis');
        if (analysisBtn) {
            analysisBtn.style.display = shouldShowAnalysis ? '' : 'none';
        }
        if (this.analysisHint) {
            this.analysisHint.style.display = shouldShowAnalysis ? '' : 'none';
        }

        if (!shouldShowAnalysis && this.activePane === 'analysis') {
            this.switchOutputPane('raw');
        }
    }

    isSmartAnalysisEnabled() {
        const language = window.i18n?.getCurrentLanguage?.() || document.documentElement.lang || 'zh-cn';
        return String(language).toLowerCase().startsWith('zh');
    }

    setAnalysisEmptyState(isEmpty) {
        if (this.analysisEmptyState) {
            this.analysisEmptyState.style.display = isEmpty ? '' : 'none';
        }
        if (this.analysisList) {
            this.analysisList.style.display = isEmpty ? 'none' : 'block';
        }
        this.analysisHasContent = !isEmpty;
        this.analysisAvailable = !isEmpty;
        this.updateAnalysisVisibility();
    }

    renderSmartAnalysis(payload = {}) {
        if (!this.analysisList) this.createCompileOutputWindow();
        if (!this.analysisList) return false;

        if (!this.isSmartAnalysisEnabled()) {
            this.analysisList.innerHTML = '';
            this.setAnalysisEmptyState(true);
            return false;
        }

        this.analysisList.innerHTML = '';
        const items = this.buildAnalysisItems(payload);

        if (!items.length) {
            this.setAnalysisEmptyState(true);
            this.analysisAvailable = false;
            this.updateAnalysisVisibility();
            return false;
        }

        this.setAnalysisEmptyState(false);
        this.analysisAvailable = true;
        this.updateAnalysisVisibility();

        items.forEach((item) => {
            const card = document.createElement('div');
            card.className = `analysis-card severity-${item.severity || 'info'}`;

            const header = document.createElement('div');
            header.className = 'analysis-card-header';

            const badge = document.createElement('span');
            badge.className = `analysis-badge severity-${item.severity || 'info'}`;
            badge.textContent = item.severity === 'warning' ? this.t('cloudCompile.warning') : (item.severity === 'error' ? this.t('cloudCompile.error') : this.t('cloudCompile.hint'));

            const location = document.createElement('span');
            location.className = 'analysis-location';
            location.textContent = item.location || this.t('cloudCompile.locationUnknown');

            header.appendChild(badge);
            header.appendChild(location);

            const message = document.createElement('div');
            message.className = 'analysis-message';
            message.textContent = item.message || '';

            const hint = document.createElement('div');
            hint.className = 'analysis-hint';
            hint.textContent = item.hint || this.t('cloudCompile.noHint');

            card.appendChild(header);
            card.appendChild(message);
            card.appendChild(hint);

            if (item.suggestion) {
                const suggestion = document.createElement('div');
                suggestion.className = 'analysis-suggestion';
                suggestion.textContent = item.suggestion;
                card.appendChild(suggestion);
            }

            this.analysisList.appendChild(card);
        });

        return true;
    }

    showCurrentEditorProblems() {
        try {
            if (typeof monaco === 'undefined' || !monaco.editor) return false;
            const editor = window.editorManager?.getCurrentEditor?.();
            const model = editor?.getModel ? editor.getModel() : null;
            if (!model) return false;

            const markers = monaco.editor.getModelMarkers
                ? monaco.editor.getModelMarkers({ resource: model.uri })
                : [];

            const diagnostics = markers.map((marker) => ({
                severity: marker.severity === monaco.MarkerSeverity.Warning
                    ? 'warning'
                    : (marker.severity === monaco.MarkerSeverity.Info ? 'note' : 'error'),
                message: marker.message || '',
                raw: marker.message || '',
                file: editor?.filePath || model.uri?.fsPath || model.uri?.path || '',
                line: marker.startLineNumber || 1,
                column: marker.startColumn || 1
            }));

            const rendered = this.renderSmartAnalysis({ diagnostics });

            // 确保编译面板可见
            if (!this.compileOutput) {
                this.createCompileOutputWindow();
            }
            this.showOutput();
            this.analysisAvailable = rendered;
            this.updateAnalysisVisibility();
            this.switchOutputPane(rendered ? 'analysis' : 'raw');

            return rendered;
        } catch (err) {
            logWarn('显示当前编辑器问题失败:', err);
            return false;
        }
    }

    buildAnalysisItems(payload = {}) {
        const items = [];
        const seen = new Set();

        const diagnostics = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
        diagnostics.forEach((diag) => {
            const rawMsg = diag.raw || diag.message || '';
            const hint = this.buildHintFromMessage(rawMsg);
            const translated = this.translateMessage(rawMsg);
            const locationParts = [];
            if (diag.file) {
                locationParts.push(this.extractFileName(diag.file));
            }
            if (diag.line) {
                locationParts.push(this.t('cloudCompile.line', { line: diag.line }));
            }
            if (diag.column) {
                locationParts.push(this.t('cloudCompile.column', { col: diag.column }));
            }
            const location = locationParts.join(' · ') || this.t('cloudCompile.locationUnknown');
            const key = `${location}|${diag.message || diag.raw}|${diag.severity}`;
            if (seen.has(key)) return;
            seen.add(key);
            items.push({
                severity: diag.severity === 'warning' ? 'warning' : (diag.severity === 'error' ? 'error' : 'info'),
                location,
                message: rawMsg || this.t('cloudCompile.unknownInfo'),
                hint: translated || hint.title,
                suggestion: hint.suggestion
            });
        });

        const rawLines = [...(payload.errors || []), ...(payload.warnings || [])];
        rawLines.forEach((line) => {
            const diag = this.parseLineToDiagnostic(line);
            const hint = this.buildHintFromMessage(diag.message);
            const translated = this.translateMessage(diag.message);
            const key = `${diag.location}|${diag.message}|${diag.severity}`;
            if (seen.has(key)) return;
            seen.add(key);
            items.push({
                severity: diag.severity,
                location: diag.location || (('compileOutput.title')),
                message: diag.message,
                hint: translated || hint.title,
                suggestion: hint.suggestion
            });
        });

        if (!items.length && (payload.stderr || payload.stdout)) {
            const text = (payload.stderr || payload.stdout || '').trim();
            if (text) {
                const hint = this.buildHintFromMessage(text);
                items.push({
                    severity: 'error',
                    location: ('compileOutput.title'),
                    message: this.translateMessage(text),
                    hint: hint.title,
                    suggestion: hint.suggestion
                });
            }
        }

        return items.slice(0, 50);
    }

    buildHintFromMessage(message = '') {
        const lower = String(message).toLowerCase();

        if (/expected\s+'?;/.test(message)) {
            return {
                title: this.t('cloudCompile.missingSemicolon'),
                suggestion: this.t('cloudCompile.missingSemicolonHint')
            };
        }

        if (/expected\s+['"`]?\)/i.test(message) || /expected\s+['"`]?\}/i.test(message) || /expected\s+['"`]?\]/i.test(message)) {
            return {
                title: this.t('cloudCompile.missingBrace'),
                suggestion: this.t('cloudCompile.missingBraceHint')
            };
        }

        if (/no such file or directory/.test(lower)) {
            const compilerPath = typeof this.settings?.compilerPath === 'string' ? this.settings.compilerPath.trim() : '';
            return {
                title: compilerPath ? this.t('cloudCompile.fileNotFound') : this.t('cloudCompile.fileNotFoundSetCompiler'),
                suggestion: compilerPath
                    ? this.t('cloudCompile.fileNotFoundHint')
                    : this.t('cloudCompile.fileNotFoundSetHint')
            };
        }

        if (/was not declared in this scope/.test(lower)) {
            return {
                title: this.t('cloudCompile.undeclared'),
                suggestion: this.t('cloudCompile.undeclaredHint')
            };
        }

        if (/redefinition of/.test(lower) || /has a previous declaration/.test(lower)) {
            return {
                title: this.t('cloudCompile.redefined'),
                suggestion: this.t('cloudCompile.redefinedHint')
            };
        }

        if (/cannot open output file/.test(lower) && (/permission denied/.test(lower) || /access is denied/.test(lower))) {
            return {
                title: this.t('cloudCompile.linkerError'),
                suggestion: this.t('cloudCompile.linkerErrorHint')
            };
        }

        if (/undefined reference to [`'"]?main/.test(lower)) {
            return {
                title: this.t('cloudCompile.missingMain'),
                suggestion: this.t('cloudCompile.missingMainHint')
            };
        }

        if (/undefined reference/.test(lower)) {
            return {
                title: this.t('cloudCompile.undefinedRef'),
                suggestion: this.t('cloudCompile.undefinedRefHint')
            };
        }

        if (/expected (class|struct|union)/i.test(lower)) {
            return {
                title: this.t('cloudCompile.incompleteType'),
                suggestion: this.t('cloudCompile.incompleteTypeHint')
            };
        }

        if (/control reaches end of non-void function/i.test(lower)) {
            return {
                title: this.t('cloudCompile.nonVoidReturn'),
                suggestion: this.t('cloudCompile.nonVoidReturnHint')
            };
        }

        if (/maybe uninitialized/i.test(lower)) {
            return {
                title: this.t('cloudCompile.uninitialized'),
                suggestion: this.t('cloudCompile.uninitializedHint')
            };
        }

        return {
            title: this.t('cloudCompile.checkRawOutput'),
            suggestion: this.t('cloudCompile.checkRawOutputHint')
        };
    }

    translateMessage(message = '') {
        const text = String(message);
        if (/no such file or directory/.test(text)) {
            const compilerPath = typeof this.settings?.compilerPath === 'string' ? this.settings.compilerPath.trim() : '';
            return compilerPath
                ? this.t('cloudCompile.translatedFileNotFound')
                : this.t('cloudCompile.translatedFileNotFoundSet');
        }
        if (/expected\s+['"`]?;/.test(text) || /expected\s+['"`]?;\s+or/.test(text)) {
            return this.t('cloudCompile.translatedMissingSemicolon');
        }
        const expectedBefore = text.match(/expected\s+(.+?)\s+before\s+(.+)/i);
        if (expectedBefore) {
            return this.t('cloudCompile.translatedExpectedBefore', { token: expectedBefore[1], before: expectedBefore[2] });
        }
        const notDeclared = text.match(/(.+?)\s+was not declared in this scope/i);
        if (notDeclared) {
            const name = notDeclared[1].replace(/[`'"\s]/g, '').trim();
            const suggest = (text.match(/did you mean\s+['"`]?(\w+)/i) || [])[1];
            if (name) {
                const suffix = suggest ? `, did you mean ${suggest}` : '';
                return this.t('cloudCompile.translatedUndeclared', { name, suffix });
            }
            return this.t('cloudCompile.translatedUndeclaredSimple');
        }
        return text;
    }

    parseLineToDiagnostic(line) {
        const raw = typeof line === 'string' ? line : this._stringifyError(line);
        if (!raw) {
            return { severity: 'info', location: '', message: '' };
        }

        const m = String(raw).match(/^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.+)$/i);
        if (m) {
            const [, file, lineNum, colNum, sevRaw, msg] = m;
            const severity = /warning/i.test(sevRaw) ? 'warning' : (/error/i.test(sevRaw) || /fatal/i.test(sevRaw) ? 'error' : 'info');
            const locationParts = [];
            if (file) locationParts.push(this.extractFileName(file));
            if (lineNum) locationParts.push(this.t('cloudCompile.line', { line: parseInt(lineNum, 10) }));
            if (colNum) locationParts.push(this.t('cloudCompile.column', { col: parseInt(colNum, 10) }));
            return {
                severity,
                location: locationParts.join(' · '),
                message: msg?.trim() || raw,
                file,
                line: lineNum ? parseInt(lineNum, 10) : undefined,
                column: colNum ? parseInt(colNum, 10) : undefined
            };
        }

        const severity = /warning/i.test(raw) ? 'warning' : (/error|fatal/i.test(raw) ? 'error' : 'info');
        return {
            severity,
            location: '',
            message: raw
        };
    }

    handleCompileResult(result) {
        this.isCompiling = false;
        
            if (result.success) {
            this.setStatus(this.t('compileOutput.successSimple', null, 'Compilation successful'));
            this.appendOutput(this.t('compileOutput.successSimple', null, 'Compilation successful') + '!\n', 'success');
            
            if (result.warnings && result.warnings.length > 0) {
                this.appendOutput(this.t('compileOutput.warningCount', { count: result.warnings.length }, `Found ${result.warnings.length} warnings:`) + '\n', 'warning');
                    result.warnings.forEach(warning => {
                        this.appendOutput(`${warning}\n`, 'warning');
                    });
            }

                if (window.editorManager && window.editorManager.clearDiagnostics) {
                    window.editorManager.clearDiagnostics();
                }

            window.dispatchEvent(new CustomEvent('compile-success', {
                detail: { result }
            }));

            if (this.shouldRunAfterCompile) {
                this.shouldRunAfterCompile = false;
                this.runCurrentFile();
            }
            } else {
            this.setStatus(this.t('compileOutput.failSimple', null, 'Compilation failed'));
            this.appendOutput(this.t('compileOutput.failSimple', null, 'Compilation failed') + '!\n', 'error');
            this.shouldRunAfterCompile = false;
            
            if (result.errors && result.errors.length > 0) {
                this.appendOutput(this.t('compileOutput.errorInfo', null, 'Error information:') + '\n', 'error');
                result.errors.forEach(error => {
                    this.appendOutput(`${this._stringifyError(error)}\n`, 'error');
                });
            }

                if (result.diagnostics && window.editorManager && window.editorManager.applyDiagnostics) {
                    window.editorManager.applyDiagnostics(result.diagnostics);
                }

            window.dispatchEvent(new CustomEvent('compile-error', {
                detail: { result }
            }));
        }

        const hasIssues = (result.errors && result.errors.length > 0) || (result.warnings && result.warnings.length > 0);
        const analysisRendered = this.renderSmartAnalysis({
            diagnostics: result.diagnostics,
            errors: result.errors,
            warnings: result.warnings,
            stderr: result.stderr,
            stdout: result.stdout
        });

        if (hasIssues && analysisRendered && this.analysisAvailable) {
            this.switchOutputPane('analysis');
        } else {
            this.switchOutputPane('raw');
        }
    }

    handleCompileError(error) {
        this.isCompiling = false;
        this.setStatus(this.t('compileOutput.failSimple', null, 'Compilation failed'));
        const msg = this._stringifyError(error);
        this.appendOutput(`${this.t('compileOutput.failSimple', null, 'Compilation failed')}: ${msg}\n`, 'error');

        this.renderSmartAnalysis({ errors: [msg] });
        if (this.analysisHasContent && this.analysisAvailable) {
            this.switchOutputPane('analysis');
        }
        
        window.dispatchEvent(new CustomEvent('compile-error', {
            detail: { error }
        }));
    }

    showExternalCompileResult(result = {}, options = {}) {
        const title = options.title || this.t('cloudCompile.sampleCompile');
        this.showOutput();
        this.clearOutput();

        const success = !!result.success;
        this.setStatus(success ? `${title} ${this.t('compileOutput.successSimple')}` : `${title} ${this.t('compileOutput.failSimple')}`);

        if (result.stdout) {
            this.appendOutput(this.t('compileOutput.standardOutput', null, 'Standard output:') + '\n', 'info');
            this.appendOutput(`${result.stdout}\n`, 'info');
        }

        if (result.stderr) {
            this.appendOutput(this.t('compileOutput.standardError', null, 'Standard error:') + '\n', 'error');
            this.appendOutput(`${result.stderr}\n`, 'error');
        }

        if (result.errors && result.errors.length > 0) {
            this.appendOutput(this.t('compileOutput.errorInfo', null, 'Error information:') + '\n', 'error');
            result.errors.forEach((err) => {
                this.appendOutput(`${this._stringifyError(err)}\n`, 'error');
            });
        }

        if (result.warnings && result.warnings.length > 0) {
            this.appendOutput(this.t('compileOutput.warningCount', { count: result.warnings.length }, `Found ${result.warnings.length} warnings:`) + '\n', 'warning');
            result.warnings.forEach((warning) => {
                this.appendOutput(`${warning}\n`, 'warning');
            });
        }

        const analysisRendered = this.renderSmartAnalysis({
            diagnostics: result.diagnostics,
            errors: result.errors,
            warnings: result.warnings,
            stderr: result.stderr,
            stdout: result.stdout
        });

        if (!success && analysisRendered && this.analysisAvailable) {
            this.switchOutputPane('analysis');
        } else {
            this.switchOutputPane('raw');
        }
    }

    handleRunResult(result) {
        this.isRunning = false;
        if (result && result.mode === 'integrated-terminal') {
            this.runInIntegratedTerminal(result);
            return;
        }
        if (result.success) {
            const message = this.t('compileOutput.programStartedNewWindow', null, 'Program started in a new window');
            this.appendOutput(message + '\n', 'success');
            this.showMessage(message, 'success');
        }
        logInfo('程序运行完成:', result);
    }

    async runInIntegratedTerminal(result) {
        try {
            const executablePath = String(result?.executablePath || '').trim();
            if (!executablePath) {
                throw new Error(this.t('panel.terminalExePathEmpty'));
            }

            const app = window.oicppApp;
            if (!app || typeof app.openIntegratedTerminalAndRunExecutable !== 'function') {
                throw new Error(this.t('message.terminalUninitialized'));
            }

            await app.openIntegratedTerminalAndRunExecutable(executablePath, {
                workingDirectory: result?.workingDirectory || undefined
            });

            this.hideOutput();
            const message = this.t('compileOutput.programStartedIntegratedTerminal', null, 'Program started in the integrated terminal');
            this.appendOutput(message + '\n', 'success');
            this.showMessage(message, 'success');
            logInfo('程序运行完成(内置终端):', result);
        } catch (error) {
            this.handleRunError(error?.message || error);
        }
    }

    handleRunError(error) {
        this.isRunning = false;
        this.appendOutput(`${this.t('message.runError', { error })}\n`, 'error');
        this.showMessage(this.t('message.runError', { error }, `Run error: ${error}`), 'error');
    }

    showOutput() {
        if (!this.compileOutput) this.createCompileOutputWindow();
        if (!this.compileOutput) return;
        this.compileOutput.classList.remove('hidden');
        setTimeout(() => {
            if (!this.compileOutput) return;
            this.compileOutput.classList.add('show');
        }, 10);

        this.updateAnalysisVisibility();
    }

    hideOutput() {
        if (!this.compileOutput) return;
        this.compileOutput.classList.remove('show');
        setTimeout(() => {
            if (!this.compileOutput) return;
            this.compileOutput.classList.add('hidden');
        }, 300);
    }

    clearOutput() {
        if (!this.compileOutput) this.createCompileOutputWindow();
        if (!this.compileOutput) return;
        const outputText = this.compileOutput.querySelector('.compile-output-text');
        if (outputText) {
            outputText.innerHTML = '';
        }
        if (this.analysisList) {
            this.analysisList.innerHTML = '';
        }
        this.setAnalysisEmptyState(true);
        this.analysisAvailable = false;
        this.updateAnalysisVisibility();
        this.switchOutputPane('raw');
        this.cloudProgressLine = null;
        this.cloudQueueLastCount = null;
    }

    appendOutput(text, type = 'info') {
        if (!this.compileOutput) this.createCompileOutputWindow();
        if (!this.compileOutput) return null;
        const outputText = this.compileOutput.querySelector('.compile-output-text');
        let line = null;
        if (outputText) {
            line = document.createElement('div');
            line.className = `output-line output-${type}`;
            line.textContent = text;
            try {
                const m = String(text).match(/^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning|note):\s*(.+)$/i);
                if (m) {
                    line.classList.add('output-link');
                    line.style.cursor = 'pointer';
                    line.addEventListener('click', () => {
                        const [, file, lineNum, colNum] = m;
                        const editor = window.editorManager?.getCurrentEditor?.();
                        if (editor && editor.revealLineInCenter) {
                            const ln = parseInt(lineNum, 10) || 1;
                            const cn = colNum ? parseInt(colNum, 10) : 1;
                            try { editor.revealLineInCenter(ln); } catch {}
                            try { editor.setPosition({ lineNumber: ln, column: cn }); } catch {}
                        }
                    });
                }
            } catch {}
            outputText.appendChild(line);
            outputText.scrollTop = outputText.scrollHeight;
        }

        return line;
    }

    setStatus(status) {
        if (!this.compileOutput) this.createCompileOutputWindow();
        if (!this.compileOutput) return;

        const statusElement = this.compileOutput.querySelector('.compile-status');
        if (statusElement) {
            statusElement.textContent = status;
        }
    }

    showMessage(message, type = 'info') {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message-popup message-${type}`;
        messageDiv.textContent = message;
        
        document.body.appendChild(messageDiv);
        
        setTimeout(() => {
            messageDiv.classList.add('show');
        }, 10);
        
        setTimeout(() => {
            messageDiv.classList.remove('show');
            setTimeout(() => {
                if (messageDiv.parentElement) {
                    messageDiv.parentElement.removeChild(messageDiv);
                }
            }, 300);
        }, 3000);
    }

    _stringifyError(err) {
        try {
            if (!err) return this.t('panel.unknownError');
            if (typeof err === 'string') return err;
            if (err instanceof Error) return err.message || err.toString();
            if (err.detail) return this._stringifyError(err.detail);
            if (err.result) {
                const r = err.result;
                if (Array.isArray(r.errors) && r.errors.length) return r.errors.join('\n');
                if (typeof r.stderr === 'string' && r.stderr.trim()) return r.stderr;
                if (typeof r.stdout === 'string' && r.stdout.trim()) return r.stdout;
                if (typeof r.message === 'string') return r.message;
            }
            if (typeof err.error === 'string') return err.error;
            if (err.error) return this._stringifyError(err.error);
            if (typeof err.message === 'string') return err.message;
            return JSON.stringify(err);
        } catch (_) {
            try { return String(err); } catch { return this.t('panel.unknownError'); }
        }
    }

    async autoSaveCurrentFile() {
        try {
            const currentEditor = window.editorManager?.getCurrentEditor();
            if (!currentEditor) {
                logInfo('[自动保存] 没有当前编辑器');
                return;
            }

            const filePath = currentEditor.filePath || (currentEditor.getFilePath && currentEditor.getFilePath());
            if (!filePath || filePath.startsWith('untitled')) {
                logInfo('[自动保存] 文件未保存或为临时文件，跳过自动保存');
                return;
            }

            const content = currentEditor.getValue();
            if (content === null || content === undefined) {
                logInfo('[自动保存] 无法获取文件内容');
                return;
            }

            if (window.tabManager) {
                const fileName = filePath.split(/[\\/]/).pop();
                const tab = window.tabManager.getTabByFileName && window.tabManager.getTabByFileName(fileName);
                if (tab && !tab.modified) {
                    logInfo('[自动保存] 文件未修改，跳过保存');
                    return;
                }
            }

            logInfo('[自动保存] 开始保存文件:', filePath);
            
            if (window.electronAPI && window.electronAPI.saveFile) {
                await window.electronAPI.saveFile(filePath, content);
                logInfo('[自动保存] 文件保存成功');
                
                if (window.tabManager) {
                    const fileName = filePath.split(/[\\/]/).pop();
                    if (window.tabManager.markTabAsSaved) {
                        window.tabManager.markTabAsSaved(fileName);
                    }
                    if (window.tabManager.markTabAsSavedByUniqueKey) {
                        window.tabManager.markTabAsSavedByUniqueKey(filePath);
                    }
                }
            } else {
                logWarn('[自动保存] electronAPI 不可用');
            }
        } catch (error) {
            logError('[自动保存] 保存文件失败:', error);
        }
    }

    openCompilerSettings() {
        if (typeof require !== 'undefined') {
            try {
                const { ipcRenderer } = require('electron');
                ipcRenderer.invoke('open-compiler-settings').catch(error => {
                    logError('打开编译器设置失败:', error);
                });
            } catch (error) {
                logError('IPC 调用失败:', error);
            }
        } else {
            logWarn('Electron API 不可用，无法打开编译器设置');
        }
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CompilerManager;
} else {
    window.CompilerManager = CompilerManager;
}

