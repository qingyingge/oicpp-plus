// 云编译/结果拉取依赖上游服务 oicpp.mywwzh.top，fork 需自建后端
class CompilerManager {
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
        this._outputHideTimer = null;
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
        let existingWindow = /** @type {any} */ (document.querySelector('.compile-output-window'));
        if (existingWindow) {
            existingWindow.remove();
        }

        this.compileOutput = document.createElement('div');
        this.compileOutput.className = 'compile-output-window hidden';
        this.compileOutput.id = 'compile-output-panel';
        this.compileOutput.innerHTML = `
            <div class="compile-output-header">
                <div class="compile-output-title">
                    <span class="compile-status" id="compile-status-text" data-i18n="compileOutput.title">Compile Output</span>
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
                    <div class="compile-output-tabs" role="tablist" aria-label="${window.i18n?.t?.('panel.compileOutputView', null) || 'Toggle compile output view'}">
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
                        <div class="analysis-empty" id="compile-analysis-empty">${window.i18n?.t?.('panel.noParseContent')}</div>
                        <div class="analysis-list" id="compile-analysis-list"></div>
                    </div>
                </div>
            </div>
            <div class="compile-output-resizer" data-i18n-title="panel.dragResize" title="拖拽调整高度"></div>
        `;

        const editorContainer = /** @type {any} */ (document.querySelector('.editor-container'));
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

        if (this._onWindowResize) {
            window.removeEventListener('resize', this._onWindowResize);
        }
        this._onWindowResize = () => {
            if (!this.compileOutput) return;
            const currentHeight = Number.parseFloat(this.compileOutput.style.height) || 300;
            this.setCompileOutputHeight(currentHeight, true);
        };
        window.addEventListener('resize', this._onWindowResize);

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

            // 注：compile-result / compile-error / run-result / run-error 四个 IPC 通道已无任何发送方
            // （编译走 invoke('compile-file')，运行走 invoke('run-program')，结果经 window CustomEvent 分发），
            // 监听它们恒不触发，已随死代码一并移除。
            this._ipcListeners = {
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
                this.showMessage(window.i18n?.t?.('message.setCompilerFirst', null) || 'Please configure the compiler first', 'error');
                this.openCompilerSettings();
                return;
            }

            logInfo('使用编译器路径:', this.settings.compilerPath);

            const currentEditor = window.editorManager?.getCurrentEditor();
            if (!currentEditor) {
                this.showMessage(window.i18n?.t?.('message.noOpenFile', null) || 'No file is open', 'error');
                return;
            }

            let filePath = currentEditor.filePath || (currentEditor.getFilePath && currentEditor.getFilePath());
            // 原先在这里取一次 getValue() 赋给 content 却从不使用：非 monaco 编辑器
            // 缺该方法时抛错，被外层 catch 吞成「编译失败」，把「取内容失败」
            // 误报成「编译失败」

            logInfo('[编译管理器] 获取到的文件路径:', filePath);
            logInfo('[编译管理器] 文件路径类型:', typeof filePath);
            logInfo('[编译管理器] currentEditor.filePath:', currentEditor.filePath);
            if (!filePath || filePath === 'null' || filePath === 'undefined' || filePath.toString().startsWith('untitled')) {
                logInfo('[编译管理器] 文件路径无效，提示保存文件');
                this.showMessage(window.i18n?.t?.('message.saveFileFirst', null) || 'Please save the file first', 'error');
                return;
            }

            if (filePath && typeof filePath === 'string') {
                 const isWin = (typeof window !== 'undefined' && window.process && window.process.platform === 'win32');
                 if (isWin) {
                     filePath = filePath.replace(/\//g, '\\');
                 }
            }

            // 重入保护：原先 isCompiling 只写不读，连按两次 F9 会让两个编译器并发写
            // 同一个 outputFile（Windows 下后一个直接失败），
            // 且状态栏先显示「成功」再被后到的失败覆盖
            if (this.isCompiling) {
                this.appendOutput((window.i18n?.t?.('compileOutput.alreadyRunning', null) || 'A compilation is already in progress.') + '\n', 'warning');
                // 显式告知调用方本次被拒：否则 compileAndRun 里的
                // `if (!this.isCompiling)` 因 isCompiling 恰为 true 而不成立，
                // shouldRunAfterCompile 残留到下一次编译完成，把「编译」
                // 意外变成「编译并运行」
                return false;
            }
            this.isCompiling = true;
            this.showOutput();
            this.setStatus(window.i18n?.t?.('compileOutput.compiling', null) || 'Compiling...');
            this.clearOutput();

            const inputFile = filePath;
            const outputFile = this.getExecutablePath(filePath);

            let compilerArgs = this.settings.compilerArgs;
            const isMacPlatform = !!(typeof window !== 'undefined' && window.process && window.process.platform === 'darwin');
            if (isMacPlatform && /\s-static\b/.test(` ${compilerArgs}`)) {
                compilerArgs = compilerArgs.replace(/\s-static\b/g, ' ').replace(/\s+/g, ' ').trim();
                this.appendOutput(window.i18n?.t?.('cloudCompile.detectMacOS') + '\n', 'warning');
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
                this.appendOutput((window.i18n?.t?.('compileOutput.modeDebug', null) || 'Compilation mode: Debug (debug info, optimizations disabled)') + '\n', 'info');
            } else {
                if (!compilerArgs.includes('-g')) {
                    compilerArgs = compilerArgs + ' -g';
                    this.appendOutput((window.i18n?.t?.('compileOutput.modeNormal', null) || 'Compilation mode: Normal (with debug info)') + '\n', 'info');
                }
            }

            const compileCommand = this.buildCompileCommand(inputFile, outputFile, compilerArgs);

            logInfo(`源文件: ${inputFile}`);
            logInfo(`目标文件: ${outputFile}`);
            logInfo(`编译命令: ${compileCommand}`);

            // 换行必须无条件生效：写成 `t(...) || 'fallback' + '\n'` 时，
            // '+' 只作用于 fallback 分支，i18n 一旦就绪相邻行就会黏成一行
            this.appendOutput((window.i18n?.t?.('compileOutput.command', { command: compileCommand }) || `Compilation command: ${compileCommand}`) + '\n', 'command');
            this.appendOutput((window.i18n?.t?.('compileOutput.targetFile', { file: outputFile }) || `Output file: ${outputFile}`) + '\n', 'info');
            this.appendOutput((window.i18n?.t?.('compileOutput.compiling', null) || 'Compiling...') + '\n', 'info');

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
                    this.handleCompileError(window.i18n?.t?.('cloudCompile.ipcFailed') + ': ' + error.message);
                }
            } else {
                this.handleCompileError(window.i18n?.t?.('cloudCompile.electronUnavailable'));
            }

        } catch (error) {
            logError('编译失败:', error);
            this.handleCompileError(error.message);
        }
        return true;   // 本次确实启动��编译
    }

    async cloudCompileCurrentFile() {
        this.showMessage(window.i18n?.t?.('cloudCompile.disabled'), 'warning');
    }

    async runCurrentFile() {
        try {
            await this.autoSaveCurrentFile();

            const currentEditor = window.editorManager?.getCurrentEditor();
            if (!currentEditor) {
                this.showMessage(window.i18n?.t?.('message.noOpenFile', null) || 'No file is open', 'error');
                return;
            }

            const filePath = currentEditor.filePath || (currentEditor.getFilePath && currentEditor.getFilePath());
            if (!filePath || filePath.startsWith('untitled')) {
                this.showMessage(window.i18n?.t?.('message.saveFileFirst', null) || 'Please save the file first', 'error');
                return;
            }

            const executablePath = this.getExecutablePath(filePath);
            logInfo(`检查可执行文件路径: ${executablePath}`);
            
            const exists = await this.checkFileExists(executablePath);
            logInfo(`可执行文件存在性检查结果: ${exists}`);
            
            if (!exists) {
                this.showMessage(window.i18n?.t?.('message.compileBeforeRun', { file: executablePath }) || `Please compile the program first (not found: ${executablePath})`, 'error');
                return;
            }

            this.isRunning = true;
            this.showOutput();
            this.appendOutput((window.i18n?.t?.('compileOutput.startingProgram', { file: executablePath }) || `Starting program: ${executablePath}`) + '\n', 'info');
            this.runExecutable(executablePath);

        } catch (error) {
            logError('运行失败:', error);
            this.showMessage(window.i18n?.t?.('message.runFailed', { error: error.message }) || `Failed to run: ${error.message}`, 'error');
        }
    }

    async compileAndRun() {
        try {
            this.shouldRunAfterCompile = true;
            // compileCurrentFile 返回 false = 命中重入守卫、本次没启动编译。
            // 此时 isCompiling 恰为 true，不能用 `if (!this.isCompiling)` 判断，
            // 也不该让标志位残留（否则下一次编译完成会凭空多跑一次程序）。
            const started = await this.compileCurrentFile();
            if (started === false) this.shouldRunAfterCompile = false;
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

            // 「查不到」不等于「存在」：原先在无法检查时返回 true，
            // 用户点运行后看到的是「运行失败」，而不是「请先编译」
            logWarn('无法检查文件存在性，按不存在处理:', filePath);
            return false;
        } catch (error) {
            logError('检查文件存在性失败:', error);
            return false;
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
                this.handleRunError(window.i18n?.t?.('cloudCompile.ipcFailed') + ': ' + error.message);
            }
        } else {
            this.handleRunError(window.i18n?.t?.('cloudCompile.electronUnavailable'));
        }
    }

    async pollCloudCompilationResult(taskId, attempt = 0) {
        if (!taskId || !this.isCloudCompiling) return;
        if (attempt >= 300) {
            this.setStatus(window.i18n?.t?.('cloudCompile.timedOut'));
            this.setCloudProgressMessage(window.i18n?.t?.('cloudCompile.timedOutMsg'), 'error');
            this.appendOutput(window.i18n?.t?.('cloudCompile.timedOutRetry'), 'error');
            this.showMessage(window.i18n?.t?.('message.cloudCompileTimeout', null) || 'Cloud compilation timed out. Please try again later.', 'error');
            this.resetCloudCompileState();
            return;
        }

        try {
            const response = await window.electronIPC.invoke('fetch-remote-json', {
                path: '/api/getCloudCompilationResult?task_id=' + encodeURIComponent(taskId),
                method: 'GET'
            });

            let data = null;
            try {
                data = response.data;
            } catch (error) {
                logWarn('解析云编译结果失败:', error);
            }

            if (!data) {
                throw new Error(window.i18n?.t?.('cloudCompile.serviceError', { status: response.status }));
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
                    throw new Error(data.msg || window.i18n?.t?.('cloudCompile.unknownStatus', { code: data.code }));
            }
        } catch (error) {
            if (attempt + 1 >= 300) {
                const message = window.i18n?.t?.('cloudCompile.statusQueryFailed', { error: error?.message || error });
                this.setStatus(window.i18n?.t?.('cloudCompile.failed'));
                this.setCloudProgressMessage(window.i18n?.t?.('cloudCompile.statusQueryFailedRetry'), 'error');
                this.appendOutput(message, 'error');
                this.showMessage(window.i18n?.t?.('message.cloudCompileStatusFailed', null) || 'Failed to retrieve cloud compilation status. Please try again later.', 'error');
                this.resetCloudCompileState();
                return;
            }

            this.appendOutput(window.i18n?.t?.('cloudCompile.statusQueryFailedAttempt', { attempt: attempt + 1, error: error?.message || error }), 'warning');
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
            this.setStatus(window.i18n?.t?.('cloudCompile.queuing', { count: queueFrontCnt }));
            if (this.cloudQueueLastCount !== queueFrontCnt) {
                this.setCloudProgressMessage(window.i18n?.t?.('cloudCompile.queuingAhead', { count: queueFrontCnt }), 'info');
                this.cloudQueueLastCount = queueFrontCnt;
            }
        } else {
            this.setStatus(window.i18n?.t?.('cloudCompile.queuingWait'));
            this.setCloudProgressMessage(window.i18n?.t?.('cloudCompile.queuingPlease'), 'info');
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
        const status = duration ? window.i18n?.t?.('cloudCompile.successWithTime', { time: duration }) : window.i18n?.t?.('cloudCompile.success');
        this.setStatus(status);
        this.setCloudProgressMessage(window.i18n?.t?.('cloudCompile.passResult'), 'success');
        this.appendOutput(window.i18n?.t?.('cloudCompile.passed'), 'success');
        if (data.msg) {
            this.appendOutput(window.i18n?.t?.('cloudCompile.compilerOutput'), 'info');
            this.appendMultilineOutput(data.msg, 'info');
        }
        this.resetCloudCompileState();
    }

    handleCloudCompilationFailure(data) {
        const duration = this.cloudCompileStartTime ? ((Date.now() - this.cloudCompileStartTime) / 1000).toFixed(2) : null;
        const status = duration ? window.i18n?.t?.('cloudCompile.failWithTime', { time: duration }) : window.i18n?.t?.('cloudCompile.failed');
        this.setStatus(status);
        this.setCloudProgressMessage(window.i18n?.t?.('cloudCompile.failCheckError'), 'error');
        this.appendOutput(window.i18n?.t?.('cloudCompile.failedSimple'), 'error');
        if (data.msg) {
            this.appendOutput(window.i18n?.t?.('cloudCompile.compilerErrors'), 'error');
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
        if (bytes < 1024) return window.i18n?.t?.('cloudCompile.formatBytes', { bytes });
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
            badge.textContent = item.severity === 'warning' ? window.i18n?.t?.('cloudCompile.warning') : (item.severity === 'error' ? window.i18n?.t?.('cloudCompile.error') : window.i18n?.t?.('cloudCompile.hint'));

            const location = document.createElement('span');
            location.className = 'analysis-location';
            location.textContent = item.location || window.i18n?.t?.('cloudCompile.locationUnknown');

            header.appendChild(badge);
            header.appendChild(location);

            const message = document.createElement('div');
            message.className = 'analysis-message';
            message.textContent = item.message || '';

            const hint = document.createElement('div');
            hint.className = 'analysis-hint';
            hint.textContent = item.hint || window.i18n?.t?.('cloudCompile.noHint');

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
                locationParts.push(window.i18n?.t?.('cloudCompile.line', { line: diag.line }));
            }
            if (diag.column) {
                locationParts.push(window.i18n?.t?.('cloudCompile.column', { col: diag.column }));
            }
            const location = locationParts.join(' · ') || window.i18n?.t?.('cloudCompile.locationUnknown');
            const key = `${location}|${diag.message || diag.raw}|${diag.severity}`;
            if (seen.has(key)) return;
            seen.add(key);
            items.push({
                severity: diag.severity === 'warning' ? 'warning' : (diag.severity === 'error' ? 'error' : 'info'),
                location,
                message: rawMsg || window.i18n?.t?.('cloudCompile.unknownInfo'),
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
                location: diag.location || window.i18n?.t?.('cloudCompile.locationUnknown'),
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
                    location: window.i18n?.t?.('cloudCompile.locationUnknown'),
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
                title: window.i18n?.t?.('cloudCompile.missingSemicolon'),
                suggestion: window.i18n?.t?.('cloudCompile.missingSemicolonHint')
            };
        }

        if (/expected\s+['"`]?\)/i.test(message) || /expected\s+['"`]?\}/i.test(message) || /expected\s+['"`]?\]/i.test(message)) {
            return {
                title: window.i18n?.t?.('cloudCompile.missingBrace'),
                suggestion: window.i18n?.t?.('cloudCompile.missingBraceHint')
            };
        }

        if (/no such file or directory/.test(lower)) {
            const compilerPath = typeof this.settings?.compilerPath === 'string' ? this.settings.compilerPath.trim() : '';
            return {
                title: compilerPath ? window.i18n?.t?.('cloudCompile.fileNotFound') : window.i18n?.t?.('cloudCompile.fileNotFoundSetCompiler'),
                suggestion: compilerPath
                    ? window.i18n?.t?.('cloudCompile.fileNotFoundHint')
                    : window.i18n?.t?.('cloudCompile.fileNotFoundSetHint')
            };
        }

        if (/was not declared in this scope/.test(lower)) {
            return {
                title: window.i18n?.t?.('cloudCompile.undeclared'),
                suggestion: window.i18n?.t?.('cloudCompile.undeclaredHint')
            };
        }

        if (/redefinition of/.test(lower) || /has a previous declaration/.test(lower)) {
            return {
                title: window.i18n?.t?.('cloudCompile.redefined'),
                suggestion: window.i18n?.t?.('cloudCompile.redefinedHint')
            };
        }

        if (/cannot open output file/.test(lower) && (/permission denied/.test(lower) || /access is denied/.test(lower))) {
            return {
                title: window.i18n?.t?.('cloudCompile.linkerError'),
                suggestion: window.i18n?.t?.('cloudCompile.linkerErrorHint')
            };
        }

        if (/undefined reference to [`'"]?main/.test(lower)) {
            return {
                title: window.i18n?.t?.('cloudCompile.missingMain'),
                suggestion: window.i18n?.t?.('cloudCompile.missingMainHint')
            };
        }

        if (/undefined reference/.test(lower)) {
            return {
                title: window.i18n?.t?.('cloudCompile.undefinedRef'),
                suggestion: window.i18n?.t?.('cloudCompile.undefinedRefHint')
            };
        }

        if (/expected (class|struct|union)/i.test(lower)) {
            return {
                title: window.i18n?.t?.('cloudCompile.incompleteType'),
                suggestion: window.i18n?.t?.('cloudCompile.incompleteTypeHint')
            };
        }

        if (/control reaches end of non-void function/i.test(lower)) {
            return {
                title: window.i18n?.t?.('cloudCompile.nonVoidReturn'),
                suggestion: window.i18n?.t?.('cloudCompile.nonVoidReturnHint')
            };
        }

        if (/maybe uninitialized/i.test(lower)) {
            return {
                title: window.i18n?.t?.('cloudCompile.uninitialized'),
                suggestion: window.i18n?.t?.('cloudCompile.uninitializedHint')
            };
        }

        return {
            title: window.i18n?.t?.('cloudCompile.checkRawOutput'),
            suggestion: window.i18n?.t?.('cloudCompile.checkRawOutputHint')
        };
    }

    translateMessage(message = '') {
        const text = String(message);
        if (/no such file or directory/.test(text)) {
            const compilerPath = typeof this.settings?.compilerPath === 'string' ? this.settings.compilerPath.trim() : '';
            return compilerPath
                ? window.i18n?.t?.('cloudCompile.translatedFileNotFound')
                : window.i18n?.t?.('cloudCompile.translatedFileNotFoundSet');
        }
        if (/expected\s+['"`]?;/.test(text) || /expected\s+['"`]?;\s+or/.test(text)) {
            return window.i18n?.t?.('cloudCompile.translatedMissingSemicolon');
        }
        const expectedBefore = text.match(/expected\s+(.+?)\s+before\s+(.+)/i);
        if (expectedBefore) {
            return window.i18n?.t?.('cloudCompile.translatedExpectedBefore', { token: expectedBefore[1], before: expectedBefore[2] });
        }
        const notDeclared = text.match(/(.+?)\s+was not declared in this scope/i);
        if (notDeclared) {
            const name = notDeclared[1].replace(/[`'"\s]/g, '').trim();
            const suggest = (text.match(/did you mean\s+['"`]?(\w+)/i) || [])[1];
            if (name) {
                const suffix = suggest ? `, did you mean ${suggest}` : '';
                return window.i18n?.t?.('cloudCompile.translatedUndeclared', { name, suffix });
            }
            return window.i18n?.t?.('cloudCompile.translatedUndeclaredSimple');
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
            if (lineNum) locationParts.push(window.i18n?.t?.('cloudCompile.line', { line: parseInt(lineNum, 10) }));
            if (colNum) locationParts.push(window.i18n?.t?.('cloudCompile.column', { col: parseInt(colNum, 10) }));
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
            this.setStatus(window.i18n?.t?.('compileOutput.successSimple', null) || 'Compilation successful');
            this.appendOutput((window.i18n?.t?.('compileOutput.successSimple', null) || 'Compilation successful') + '!\n', 'success');
            
            if (result.warnings && result.warnings.length > 0) {
                this.appendOutput((window.i18n?.t?.('compileOutput.warningCount', { count: result.warnings.length }) || `Found ${result.warnings.length} warnings:`) + '\n', 'warning');
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
            this.setStatus(window.i18n?.t?.('compileOutput.failSimple', null) || 'Compilation failed');
            this.appendOutput((window.i18n?.t?.('compileOutput.failSimple', null) || 'Compilation failed') + '!\n', 'error');
            this.shouldRunAfterCompile = false;
            
            if (result.errors && result.errors.length > 0) {
                this.appendOutput((window.i18n?.t?.('compileOutput.errorInfo', null) || 'Error information:') + '\n', 'error');
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
        this.shouldRunAfterCompile = false;
        this.setStatus(window.i18n?.t?.('compileOutput.failSimple', null) || 'Compilation failed');
        const msg = this._stringifyError(error);
        this.appendOutput(`${window.i18n?.t?.('compileOutput.failSimple', null) || 'Compilation failed'}: ${msg}\n`, 'error');

        this.renderSmartAnalysis({ errors: [msg] });
        if (this.analysisHasContent && this.analysisAvailable) {
            this.switchOutputPane('analysis');
        }
        
        window.dispatchEvent(new CustomEvent('compile-error', {
            detail: { error }
        }));
    }

    showExternalCompileResult(result = {}, options = {}) {
        const title = options.title || window.i18n?.t?.('cloudCompile.sampleCompile');
        this.showOutput();
        this.clearOutput();

        const success = !!result.success;
        this.setStatus(success ? `${title} ${window.i18n?.t?.('compileOutput.successSimple')}` : `${title} ${window.i18n?.t?.('compileOutput.failSimple')}`);

        if (result.stdout) {
            this.appendOutput((window.i18n?.t?.('compileOutput.standardOutput', null) || 'Standard output:') + '\n', 'info');
            this.appendOutput(`${result.stdout}\n`, 'info');
        }

        if (result.stderr) {
            this.appendOutput((window.i18n?.t?.('compileOutput.standardError', null) || 'Standard error:') + '\n', 'error');
            this.appendOutput(`${result.stderr}\n`, 'error');
        }

        if (result.errors && result.errors.length > 0) {
            this.appendOutput((window.i18n?.t?.('compileOutput.errorInfo', null) || 'Error information:') + '\n', 'error');
            result.errors.forEach((err) => {
                this.appendOutput(`${this._stringifyError(err)}\n`, 'error');
            });
        }

        if (result.warnings && result.warnings.length > 0) {
            this.appendOutput((window.i18n?.t?.('compileOutput.warningCount', { count: result.warnings.length }) || `Found ${result.warnings.length} warnings:`) + '\n', 'warning');
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
            const message = window.i18n?.t?.('compileOutput.programStartedNewWindow', null) || 'Program started in a new window';
            this.appendOutput(message + '\n', 'success');
            this.showMessage(message, 'success');
        }
        logInfo('程序运行完成:', result);
    }

    async runInIntegratedTerminal(result) {
        try {
            const executablePath = String(result?.executablePath || '').trim();
            if (!executablePath) {
                throw new Error(window.i18n?.t?.('panel.terminalExePathEmpty'));
            }

            const app = window.oicppApp;
            if (!app || typeof app.openIntegratedTerminalAndRunExecutable !== 'function') {
                throw new Error(window.i18n?.t?.('message.terminalUninitialized'));
            }

            await app.openIntegratedTerminalAndRunExecutable(executablePath, {
                workingDirectory: result?.workingDirectory || undefined
            });

            this.hideOutput();
            const message = window.i18n?.t?.('compileOutput.programStartedIntegratedTerminal', null) || 'Program started in the integrated terminal';
            this.appendOutput(message + '\n', 'success');
            this.showMessage(message, 'success');
            logInfo('程序运行完成(内置终端):', result);
        } catch (error) {
            this.handleRunError(error?.message || error);
        }
    }

    handleRunError(error) {
        this.isRunning = false;
        this.appendOutput(`${window.i18n?.t?.('message.runError', { error })}\n`, 'error');
        this.showMessage(window.i18n?.t?.('message.runError', { error }) || `Run error: ${error}`, 'error');
    }

    showOutput() {
        if (!this.compileOutput) this.createCompileOutputWindow();
        if (!this.compileOutput) return;
        // 两个 setTimeout 必须互相取消：原先 hide 的 300ms 定时器与 show 的
        // 10ms 定时器各自独立，300ms 内按 F9 时旧的 hide 到期会补上 hidden，
        // 编译中的面板整块消失
        this._cancelOutputHideTimer();
        this.compileOutput.classList.remove('hidden');
        this.compileOutput.classList.add('show');

        this.updateAnalysisVisibility();
    }

    hideOutput() {
        if (!this.compileOutput) return;
        this._cancelOutputHideTimer();
        this.compileOutput.classList.remove('show');
        this._outputHideTimer = setTimeout(() => {
            this._outputHideTimer = null;
            if (!this.compileOutput) return;
            this.compileOutput.classList.add('hidden');
        }, 300);
    }

    _cancelOutputHideTimer() {
        if (this._outputHideTimer) {
            clearTimeout(this._outputHideTimer);
            this._outputHideTimer = null;
        }
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
            if (!err) return window.i18n?.t?.('panel.unknownError');
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
            try { return String(err); } catch { return window.i18n?.t?.('panel.unknownError'); }
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

