// 渲染层：编译输出面板管理器（script 标签加载，窗口单例在文件尾注入）。
// 运行时 logger 由 main.js 挂载为全局函数；模块级声明供类型检查（模块内遮蔽全局，无冲突）。
declare function logInfo(...args: unknown[]): void;
declare function logWarn(...args: unknown[]): void;
declare function logError(...args: unknown[]): void;

declare global {
    interface Window {
        compileOutputManager: CompileOutputManager;
    }
}

export class CompileOutputManager {
    panel: HTMLElement | null;
    statusText: HTMLElement | null;
    commandText: HTMLElement | null;
    messagesContainer: HTMLElement | null;
    isVisible: boolean;
    currentCommand: string;
    startTime: number | null;
    _onGlobalKeydown: ((e: KeyboardEvent) => void) | null;

    constructor() {
        this.panel = null;
        this.statusText = null;
        this.commandText = null;
        this.messagesContainer = null;
        this.isVisible = false;
        this.currentCommand = '';
        this.startTime = null;
        this._onGlobalKeydown = null;

        this.init();
    }

    init(): void {
        this.panel = document.getElementById('compile-output-panel');
        this.statusText = document.getElementById('compile-status-text');
        this.commandText = document.getElementById('compile-command-text');
        this.messagesContainer = document.getElementById('compile-output-messages');

        if (!this.panel) {
            logError('编译输出面板元素未找到');
            return;
        }

        this.setupEventListeners();
        logInfo('编译输出管理器初始化完成');
    }

    setupEventListeners(): void {
        const closeBtn = document.getElementById('close-compile-output');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                this.hide();
            });
        }

        const clearBtn = document.getElementById('clear-compile-output');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this.clearMessages();
            });
        }

        this._onGlobalKeydown = (e) => {
            if (e.key === 'Escape' && this.isVisible) {
                e.preventDefault();
                e.stopPropagation();
                this.hide();
            }
        };
    }

    show(): void {
        if (!this.panel) return;

        this.panel.classList.add('show');
        this.isVisible = true;
        if (this._onGlobalKeydown) {
            document.addEventListener('keydown', this._onGlobalKeydown);
        }

        const editorArea = document.getElementById('editor-area');
        if (editorArea) {
            editorArea.classList.add('with-compile-output');
        }

        this.triggerEditorResize();
    }

    hide(): void {
        if (!this.panel) return;

        this.panel.classList.remove('show');
        this.isVisible = false;
        if (this._onGlobalKeydown) {
            document.removeEventListener('keydown', this._onGlobalKeydown);
        }

        const editorArea = document.getElementById('editor-area');
        if (editorArea) {
            editorArea.classList.remove('with-compile-output');
        }

        this.triggerEditorResize();
    }

    toggle(): void {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }

    triggerEditorResize(): void {
        setTimeout(() => {
            if (window.app && window.app.editorManager) {
                const currentEditor = window.app.editorManager.getCurrentEditor();
                if (currentEditor && typeof currentEditor.layout === 'function') {
                    currentEditor.layout();
                }
            }
        }, 350); // 等待动画完成
    }

    setStatus(status: string, command = ''): void {
        if (this.statusText) {
            const indicator = this.getStatusIndicator(status);
            this.statusText.innerHTML = `${indicator}${status}`;
        }

        if (this.commandText && command) {
            this.commandText.textContent = command;
            this.currentCommand = command;
        }
    }

    getStatusIndicator(status: string): string {
        let className = 'ready';

        const compilingHint = window.i18n.t('compileOutput.compiling');
        const successHint = window.i18n.t('compileOutput.successSimple');
        const failHint = window.i18n.t('compileOutput.failSimple');
        if (status.includes(compilingHint)) {
            className = 'compiling';
        } else if (status.includes(successHint) || status.includes('成功')) {
            className = 'success';
        } else if (status.includes(failHint) || status.includes('失败') || status.includes('错误')) {
            className = 'error';
        }

        return `<span class="compile-status-indicator ${className}"></span>`;
    }

    addMessage(message: string, type = 'info'): void {
        if (!this.messagesContainer) return;

        const timestamp = new Date().toLocaleTimeString();
        const messageDiv = document.createElement('div');
        messageDiv.className = `compile-message ${type}`;

        messageDiv.innerHTML = `
            <span class="timestamp">[${timestamp}]</span>
            <span class="message-content">${this.escapeHtml(message)}</span>
        `;

        this.messagesContainer.appendChild(messageDiv);

        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    clearMessages(): void {
        if (this.messagesContainer) {
            this.messagesContainer.innerHTML = '';
        }
    }

    escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    startCompile(command: string): void {
        this.show();
        this.clearMessages();
        this.setStatus(window.i18n.t('compileOutput.compiling'), command);
        this.startTime = Date.now();

        this.addMessage(window.i18n.t('compileOutput.startCompile', { command }), 'info');
    }

    onCompileSuccess(output = '', warnings: string[] = []): void {
        const endTime = Date.now();
        const duration = this.startTime ? ((endTime - this.startTime) / 1000).toFixed(2) : '0.00';

        this.setStatus(window.i18n.t('compileOutput.success', { time: duration }));

        if (output && output.trim()) {
            this.addMessage(window.i18n.t('compileOutput.successOutput'), 'info');
            this.addMessage(output, 'info');
        }

        if (warnings && warnings.length > 0) {
            this.addMessage(window.i18n.t('compileOutput.warningCount', { count: warnings.length }), 'warning');
            warnings.forEach(warning => {
                this.addMessage(warning, 'warning');
            });
        }

        this.addMessage(window.i18n.t('compileOutput.successDone', { time: duration }), 'success');
    }

    onCompileError(error: string, output = ''): void {
        const endTime = Date.now();
        const duration = this.startTime ? ((endTime - this.startTime) / 1000).toFixed(2) : '0.00';

        this.setStatus(window.i18n.t('compileOutput.fail', { time: duration }));

        this.addMessage(window.i18n.t('compileOutput.failSimple') + ':', 'error');

        if (output && output.trim()) {
            this.addMessage(window.i18n.t('compileOutput.failOutput'), 'info');
            this.addMessage(output, 'info');
        }

        if (error && error.trim()) {
            this.addMessage(window.i18n.t('compileOutput.errorInfo'), 'error');
            this.addMessage(error, 'error');
        }

        this.addMessage(window.i18n.t('compileOutput.failDone', { time: duration }), 'error');
    }

    onProgramStart(): void {
        this.addMessage(window.i18n.t('compileOutput.runningProgram'), 'info');
    }

    onProgramOutput(output: string, exitCode = 0): void {
        if (exitCode === 0) {
            this.addMessage(window.i18n.t('compileOutput.programComplete'), 'success');
            if (output && output.trim()) {
                this.addMessage(window.i18n.t('compileOutput.programOutput'), 'info');
                this.addMessage(output, 'info');
            }
        } else {
            this.addMessage(window.i18n.t('compileOutput.programExited', { code: exitCode }), 'error');
            if (output && output.trim()) {
                this.addMessage(window.i18n.t('compileOutput.programOutput'), 'info');
                this.addMessage(output, 'error');
            }
        }
    }

    onProgramError(error: string): void {
        this.addMessage(window.i18n.t('compileOutput.programOutput'), 'error');
        this.addMessage(error, 'error');
    }

    getStatus(): { isVisible: boolean; currentCommand: string; hasMessages: boolean } {
        return {
            isVisible: this.isVisible,
            currentCommand: this.currentCommand,
            hasMessages: this.messagesContainer ? this.messagesContainer.children.length > 0 : false
        };
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CompileOutputManager;
} else {
    window.compileOutputManager = new CompileOutputManager();
}
