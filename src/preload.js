const { contextBridge, ipcRenderer, shell, clipboard } = require('electron');
const path = require('path');

const htmlToPlainText = (html) => {
    const source = String(html || '');
    if (typeof DOMParser === 'function') {
        try {
            const documentNode = new DOMParser().parseFromString(source, 'text/html');
            documentNode.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach((node) => node.remove());
            documentNode.querySelectorAll('*').forEach((node) => {
                for (const attribute of Array.from(node.attributes || [])) {
                    if (/^on/i.test(attribute.name) || /^javascript:/i.test(attribute.value || '')) {
                        node.removeAttribute(attribute.name);
                    }
                }
            });
            return documentNode.body?.textContent || '';
        } catch (_) { }
    }
    return source
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

const showToast = (message, type = 'info', durationMs = 1200) => {
    try {
        const safeMsg = String(message ?? '');
        const safeType = ['info', 'success', 'error', 'warning'].includes(type) ? type : 'info';
        const dur = Number.isFinite(durationMs) ? durationMs : 1200;

        const ensure = () => {
            const existing = document.querySelector('.message-toast');
            if (existing) return existing;
            const div = document.createElement('div');
            div.className = 'message-toast info';
            div.style.pointerEvents = 'none';
            document.body.appendChild(div);
            return div;
        };

        const show = () => {
            const toast = ensure();
            toast.className = `message-toast ${safeType}`;
            toast.textContent = safeMsg;
            toast.style.display = 'block';
            clearTimeout(toast.__hideTimer);
            toast.__hideTimer = setTimeout(() => {
                try {
                    toast.style.display = 'none';
                } catch (_) { }
            }, dur);
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', show, { once: true });
        } else {
            show();
        }
    } catch (_) {
    }
};

let md = null;
let TurndownService = null;
let turndownInstance = null;

const normalizeMarkdownMath = (input) => {
    if (!input || typeof input !== 'string') return input;

    const normalizeInlineMathInLine = (line) => {
        let out = '';
        let inCode = false;
        let codeFence = '';
        let i = 0;

        while (i < line.length) {
            const ch = line[i];
            if (ch === '`') {
                let count = 1;
                while (i + count < line.length && line[i + count] === '`') {
                    count++;
                }
                const fence = '`'.repeat(count);
                if (!inCode) {
                    inCode = true;
                    codeFence = fence;
                } else if (fence === codeFence) {
                    inCode = false;
                    codeFence = '';
                }
                out += fence;
                i += count;
                continue;
            }

            if (!inCode && ch === '$') {
                const next = line[i + 1];
                if (next === '$' || (i > 0 && line[i - 1] === '\\')) {
                    out += ch;
                    i += 1;
                    continue;
                }
                let j = i + 1;
                while (j < line.length) {
                    if (line[j] === '$' && line[j - 1] !== '\\') {
                        break;
                    }
                    j += 1;
                }
                if (j < line.length && line[j] === '$') {
                    const content = line.slice(i + 1, j);
                    const trimmed = content.replace(/^\s+|\s+$/g, '');
                    out += `$${trimmed.length ? trimmed : content}$`;
                    i = j + 1;
                    continue;
                }
            }

            out += ch;
            i += 1;
        }

        return out;
    };

    const lines = input.split('\n');
    let inFence = false;
    let fenceMarker = '';
    let inMathBlock = false;

    for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        const fenceMatch = line.match(/^\s{0,3}(```+|~~~+)/);
        if (fenceMatch) {
            const marker = fenceMatch[1][0];
            if (!inFence) {
                inFence = true;
                fenceMarker = marker;
            } else if (marker === fenceMarker) {
                inFence = false;
                fenceMarker = '';
            }
            continue;
        }
        if (!inFence) {
            const mathFenceMatch = line.match(/^\s*\$\$\s*$/);
            if (mathFenceMatch) {
                inMathBlock = !inMathBlock;
                lines[idx] = '$$';
                continue;
            }
            if (inMathBlock) {
                let normalized = line.trim();
                normalized = normalized
                    .replace(/\\begin\{align\*?\}/g, '\\begin{aligned}')
                    .replace(/\\end\{align\*?\}/g, '\\end{aligned}');
                lines[idx] = normalized;
                continue;
            }
            lines[idx] = normalizeInlineMathInLine(line);
        }
    }

    return lines.join('\n');
};

try {
    TurndownService = require('turndown');
    turndownInstance = new TurndownService({
        headingStyle: 'atx',
        hr: '---',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        fence: '```',
        emDelimiter: '*',
        strongDelimiter: '**',
        linkStyle: 'inlined',
    });

    turndownInstance.addRule('taskListItem', {
        filter: function (node) {
            return node.nodeName === 'LI' && 
                   node.classList.contains('task-list-item');
        },
        replacement: function (content, node) {
            const checkbox = node.querySelector('input[type="checkbox"]');
            const checked = checkbox && checkbox.checked;
            const prefix = checked ? '- [x] ' : '- [ ] ';
            return prefix + content.trim().replace(/^\[[ x]\]\s*/i, '') + '\n';
        }
    });

    turndownInstance.addRule('fencedCodeBlock', {
        filter: function (node) {
            return (
                node.nodeName === 'PRE' &&
                node.firstChild &&
                node.firstChild.nodeName === 'CODE'
            );
        },
        replacement: function (content, node, options) {
            const code = node.firstChild;
            const className = code.getAttribute('class') || '';
            const langMatch = className.match(/language-(\S+)/);
            const lang = langMatch ? langMatch[1] : '';
            const fence = options.fence;
            
            return '\n\n' + fence + lang + '\n' + code.textContent + '\n' + fence + '\n\n';
        }
    });

    turndownInstance.addRule('hljsCodeBlock', {
        filter: function (node) {
            return (
                node.nodeName === 'PRE' &&
                node.classList.contains('hljs')
            );
        },
        replacement: function (content, node, options) {
            const codeText = node.textContent || '';
            return '\n\n```\n' + codeText + '\n```\n\n';
        }
    });
    turndownInstance.addRule('ignoreCopyButton', {
        filter: function (node) {
            return node.nodeName === 'BUTTON' && 
                   node.classList.contains('copy-code-btn');
        },
        replacement: function () {
            return '';
        }
    });

    turndownInstance.addRule('codeBlockWrapper', {
        filter: function (node) {
            return node.nodeName === 'DIV' && 
                   node.classList.contains('code-block-wrapper');
        },
        replacement: function (content, node, options) {
            const pre = node.querySelector('pre');
            if (pre) {
                const codeText = pre.textContent || '';
                return '\n\n```\n' + codeText + '\n```\n\n';
            }
            return content;
        }
    });

} catch (e) {
    console.error('Failed to initialize Turndown:', e);
}

try {
    const MarkdownIt = require('markdown-it');
    const mk = require('@iktakahiro/markdown-it-katex');
    const taskLists = require('markdown-it-task-lists');
    const imageFigures = require('markdown-it-image-figures');
    const hljs = require('highlight.js');

    md = new MarkdownIt({
        html: false,
        linkify: true,
        typographer: true,
        highlight: function (str, lang) {
            if (lang && hljs.getLanguage(lang)) {
                try {
                    return '<pre class="hljs"><code>' +
                           hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
                           '</code></pre>';
                } catch (__) {}
            }
            return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
        }
    })
    .use(mk, {
        throwOnError: false,
        strict: 'ignore'
    })
    .use(taskLists)
    .use(imageFigures, {
        figcaption: true
    });

    const defaultFence = md.renderer.rules.fence || function(tokens, idx, options, env, self) {
        return self.renderToken(tokens, idx, options);
    };

    md.renderer.rules.fence = function (tokens, idx, options, env, self) {
        const token = tokens[idx];
        const code = token.content;
        const lang = token.info.trim();
        
        let highlighted;
        try {
            if (lang && hljs.getLanguage(lang)) {
                highlighted = '<pre class="hljs"><code>' +
                              hljs.highlight(code, { language: lang, ignoreIllegals: true }).value +
                              '</code></pre>';
            } else {
                highlighted = '<pre class="hljs"><code>' +
                              hljs.highlightAuto(code).value +
                              '</code></pre>';
            }
        } catch (__) {
            highlighted = '<pre class="hljs"><code>' + md.utils.escapeHtml(code) + '</code></pre>';
        }
        const encodedCode = encodeURIComponent(code);

        return `<div class="code-block-wrapper" style="position: relative;">
            <button class="copy-code-btn" type="button" data-code="${encodedCode}"
                    style="position: absolute; top: 5px; right: 5px; z-index: 10; padding: 4px 8px; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; color: inherit; cursor: pointer; font-size: 12px;">
                Copy
            </button>
            ${highlighted}
        </div>`;
    };

} catch (e) {
    console.error('Failed to initialize markdown-it:', e);
}

if (md) {
    const defaultImageRender = md.renderer.rules.image || function (tokens, idx, options, env, self) {
        return self.renderToken(tokens, idx, options);
    };

    md.renderer.rules.image = function (tokens, idx, options, env, self) {
        const token = tokens[idx];
        const srcIndex = token.attrIndex('src');
        if (srcIndex >= 0) {
            let src = token.attrs[srcIndex][1];
            const filePath = env && env.filePath;
            if (src && !src.startsWith('http') && !src.startsWith('https:') && !src.startsWith('data:') && !src.startsWith('file:')) {
                if (filePath) {
                    if (path.isAbsolute(src)) {
                        token.attrs[srcIndex][1] = '';
                        return defaultImageRender(tokens, idx, options, env, self);
                    }
                    const dir = path.dirname(filePath);
                    if (!path.isAbsolute(src)) {
                        const resolved = path.resolve(dir, src);
                        const relative = path.relative(dir, resolved);
                        if (relative.startsWith('..') || path.isAbsolute(relative)) {
                            token.attrs[srcIndex][1] = '';
                            return defaultImageRender(tokens, idx, options, env, self);
                        }
                        src = resolved;
                    }
                    src = src.replace(/\\/g, '/');
                    if (!src.startsWith('/')) {
                        src = '/' + src;
                    }
                    token.attrs[srcIndex][1] = `file://${src}`;
                }
            }
        }
        return defaultImageRender(tokens, idx, options, env, self);
    };
}

contextBridge.exposeInMainWorld('markdownAPI', {
    render: (text, filePath) => {
        if (!md) return text;
        try {
            const normalizedText = normalizeMarkdownMath(text || '');
            return md.render(normalizedText, { filePath });
        } catch (err) {
            console.error('Markdown render error:', err);
            return text;
        }
    }
});

contextBridge.exposeInMainWorld('turndownAPI', {
    toMarkdown: (html) => {
        if (!turndownInstance) {
            console.warn('Turndown not initialized, returning plain text');
            return htmlToPlainText(html);
        }
        try {
            return turndownInstance.turndown(html);
        } catch (err) {
            console.error('Turndown error:', err);
            return htmlToPlainText(html);
        }
    }
});

if (globalThis.__oicppPreloadInitialized) {
    return;
}
globalThis.__oicppPreloadInitialized = true;

try {
    window.addEventListener('click', async (ev) => {
        const target = ev.target;
        if (!(target instanceof HTMLElement)) return;

        const anchor = target.closest('a[href]');
        if (anchor instanceof HTMLAnchorElement) {
            const href = anchor.getAttribute('href') || '';
            if (href && !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:') && (ev.ctrlKey || ev.metaKey)) {
                try {
                    const resolvedUrl = new URL(href, window.location.href);
                    if (!['http:', 'https:', 'mailto:', 'file:'].includes(resolvedUrl.protocol)) {
                        return;
                    }
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (typeof shell?.openExternal === 'function') {
                        await shell.openExternal(resolvedUrl.href);
                    }
                } catch (error) {
                    console.error('Failed to open external link:', error);
                }
                return;
            }
        }

        const btn = target.closest('.copy-code-btn');
        if (!(btn instanceof HTMLElement)) return;
        const encoded = btn.getAttribute('data-code');
        if (!encoded) return;

        ev.preventDefault();
        ev.stopPropagation();

        let text = '';
        try {
            text = decodeURIComponent(encoded);
        } catch (_) {
            text = encoded;
        }

        try {
            if (window.electronAPI && typeof window.electronAPI.clipboardWriteText === 'function') {
                await window.electronAPI.clipboardWriteText(text);
            } else {
                safeIpcRenderer.invoke('clipboard-write-text', text);
            }
            showToast('已复制到剪贴板', 'success', 1200);
        } catch (err) {
            showToast('复制失败', 'error', 1600);
            try { console.error('Copy code failed:', err); } catch (_) { }
        }
    }, true);
} catch (_) { }

const ALLOWED_SEND_CHANNELS = new Set([
    'open-file-dialog', 'open-folder-dialog', 'save-file-as',
    'toggle-devtools', 'toggle-always-on-top',
    'window-focus', 'window-blur',
    'window-minimize', 'window-maximize', 'window-unmaximize',
    'window-close', 'window-close-discard',
    'app-close-confirmed', 'app-close-discard', 'app-close-cancelled',
    'open-external-terminal', 'run-code', 'compile-and-run',
    'request-kill-process', 'save-binary-temp-file',
    'theme-changed', 'settings-changed',
    'file-renamed', 'file-deleted', 'file-created',
    'save-file', 'read-directory',
    'rename-file', 'delete-file', 'create-file', 'create-folder',
    'paste-file', 'move-file',
    'debug-send-input', 'start-debug', 'stop-debug',
    'debug-continue', 'debug-step-over', 'debug-step-into', 'debug-step-out',
    'debug-add-watch', 'debug-request-variables',
    'open-template-settings', 'check-updates-manual', 'logger-log'
]);

const ALLOWED_INVOKE_CHANNELS = new Set([
    'save-file', 'save-as-file', 'read-file-content', 'read-file-buffer',
    'read-zip-text-files', 'open-path', 'show-open-dialog', 'show-save-dialog',
    'save-temp-file', 'save-binary-temp-file', 'load-temp-file', 'delete-temp-file',
    'get-compiler-info', 'detect-compilers', 'get-compiler-include-paths',
    'validate-file-name', 'start-debug-session', 'stop-debug-session',
    'debug-continue', 'debug-pause', 'debug-step-over', 'debug-step-into',
    'debug-step-out', 'debug-restart', 'debug-set-breakpoint', 'debug-remove-breakpoint',
    'debug-get-threads', 'debug-switch-thread', 'debug-evaluate',
    'debug-expand-variable', 'debug-add-watch', 'debug-remove-watch',
    'test-compiler', 'get-language-file', 'get-workspace-info',
    'get-font-list', 'check-font-exists', 'get-installed-fonts',
    'get-global-settings', 'save-global-settings', 'get-user-data-path',
    'get-app-version', 'get-app-path', 'check-for-updates',
    'get-all-settings', 'update-settings', 'update-top-level-settings',
    'open-backup-settings', 'check-gdb-availability', 'fetch-remote-json',
    'open-editor-settings', 'open-compiler-settings',
    'compile-file', 'run-program', 'run-interactive', 'run-executable', 'check-file-exists', 'format-cpp-code',
    'get-settings', 'reset-settings', 'export-settings', 'import-settings', 'save-setting', 'get-platform', 'get-user-home', 'get-user-icon-path', 'get-build-info', 'get-downloaded-compilers', 'download-compiler', 'select-compiler', 'get-downloaded-testlibs', 'download-testlib', 'select-testlib', 'test-testlib', 'compare-start', 'compare-stop', 'read-directory', 'rename-file-invoke', 'delete-file-invoke', 'clear-directory-contents', 'write-file', 'create-file', 'create-folder', 'get-path-info', 'ensure-directory', 'watch-file', 'unwatch-file', 'path-join', 'path-dirname', 'get-home-dir', 'ensure-dir', 'terminal-feature-status', 'terminal-create', 'terminal-write', 'terminal-resize', 'terminal-kill', 'terminal-list', 'terminal-get-tty', 'get-update-download-status', 'consume-startup-workspace-to-open', 'get-cpu-threads', 'list-client-logs', 'upload-client-log', 'get-device-info', 'get-encoded-token', 'open-external', 'get-language', 'get-available-languages', 'ide-login-start', 'ide-login-status', 'ide-logout', 'cloud-sync-request', 'backup-settings-to-cloud', 'get-settings-backup-info', 'sync-settings-from-cloud', 'get-recent-files', 'open-recent-file', 'get-file-history', 'add-to-file-history', 'open-file-from-history', 'clear-file-history', 'save-last-open-tabs', 'get-last-open-tabs', 'relaunch-app', 'clipboard-write-text', 'clipboard-read-text', 'walk-directory', 'lsp-start', 'lsp-stop', 'lsp-restart', 'lsp-request', 'lsp-cancel', 'lsp-apply-edit-result', 'lsp-notify', 'browser-resolve-url', 'browser-get-page-title',
]);

// 事件通道白名单：渲染进程仅可监听以下通道，防 IPC 事件窃听（H8）
const ALLOWED_EVENT_CHANNELS = new Set([
    // 编译/运行结果
    'compile-result', 'compile-error', 'run-result', 'run-error',
    // 调试会话
    'debug-started', 'debug-stopped', 'debug-running', 'debug-program-exited',
    'debug-ready-waiting', 'debug-breakpoint-hit', 'debug-error',
    'debug-variables-updated', 'debug-callstack-updated', 'debug-terminal-output',
    'debug-variable-expanded', 'goto-source-location',
    // 设置与主题
    'settings-changed', 'settings-loaded', 'settings-reset', 'settings-imported',
    'theme-changed', 'language-changed',
    // 文件系统
    'file-saved', 'file-renamed', 'file-created', 'folder-created',
    'file-deleted', 'file-pasted', 'file-moved', 'file-move-error',
    'directory-read', 'directory-read-error',
    // 窗口/应用
    'window-maximized', 'window-unmaximized', 'app-close-requested',
    'lsp-apply-edit',
    'compare-progress', 'compare-error', 'compare-complete', 'menu-save-file', 'apply-settings-preview', 'settings-applied', 'menu-format-code', 'menu-find-replace', 'menu-compile', 'menu-compile-run', 'menu-debug', 'menu-new-temp-file', 'menu-open-file', 'menu-open-folder', 'menu-save-as', 'menu-open-terminal', 'menu-open-browser', 'menu-new-browser-tab', 'menu-about', 'menu-settings', 'menu-check-updates', 'update-download-status', 'app-toast', 'show-debug-developing-message', 'file-opened', 'folder-opened', 'file-opened-from-args', 'external-file-changed', 'sample-tester-create-problem', 'terminal-data', 'terminal-exit', 'ide-login-updated', 'ide-login-error', 'menu-open-file-history', 'lsp-notification', 'request-save-all', 'browser-open-new-tab',
]);

const safeIpcRenderer = {
    send: (channel, ...args) => {
        if (ALLOWED_SEND_CHANNELS.has(channel)) {
            return ipcRenderer.send(channel, ...args);
        }
        console.warn(`IPC send blocked: ${channel}`);
    },
    invoke: (channel, ...args) => {
        if (ALLOWED_INVOKE_CHANNELS.has(channel)) {
            return ipcRenderer.invoke(channel, ...args);
        }
        return Promise.reject(new Error(`IPC invoke blocked: ${channel}`));
    },
    on: (channel, listener) => {
        if (ALLOWED_EVENT_CHANNELS.has(channel)) return ipcRenderer.on(channel, listener);
        console.warn('IPC event blocked: ' + channel);
    },
    once: (channel, listener) => {
        if (ALLOWED_EVENT_CHANNELS.has(channel)) return ipcRenderer.once(channel, listener);
        console.warn('IPC event blocked: ' + channel);
    },
    removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener),
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
};


contextBridge.exposeInMainWorld('electron', {
    ipcRenderer: safeIpcRenderer,
    shell: {
        openExternal: (url) => shell.openExternal(url),
        showItemInFolder: (path) => shell.showItemInFolder(path),
        openPath: (targetPath) => shell.openPath(targetPath)
    }
});
contextBridge.exposeInMainWorld('__electronRequireAvailable', true);
contextBridge.exposeInMainWorld('getElectronModule', () => {
    return {
        ipcRenderer: safeIpcRenderer,
        shell: {
            openExternal: (url) => shell.openExternal(url),
            showItemInFolder: (path) => shell.showItemInFolder(path),
            openPath: (targetPath) => shell.openPath(targetPath)
        }
    };
});

const subscribeIpc = (channel, listener) => {
    safeIpcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('electronAPI', {
    openFile: () => safeIpcRenderer.send('open-file-dialog'),
    openFolder: () => safeIpcRenderer.send('open-folder-dialog'),
    saveFile: (filePath, content) => safeIpcRenderer.invoke('save-file', filePath, content),
    saveAsFile: (content) => safeIpcRenderer.invoke('save-as-file', content),
    readFileContent: (filePath) => safeIpcRenderer.invoke('read-file-content', filePath),
    readFileBuffer: (filePath) => safeIpcRenderer.invoke('read-file-buffer', filePath),
    readZipTextFiles: (zipPath) => safeIpcRenderer.invoke('read-zip-text-files', zipPath),
    showItemInFolder: (filePath) => safeIpcRenderer.invoke('open-path', filePath, { reveal: true }),
    openPath: (targetPath, options = {}) => safeIpcRenderer.invoke('open-path', targetPath, options),
    showOpenDialog: (options) => safeIpcRenderer.invoke('show-open-dialog', options),
    showSaveDialog: (options) => safeIpcRenderer.invoke('show-save-dialog', options),

    saveTempFile: (filePath, content) => safeIpcRenderer.invoke('save-temp-file', filePath, content),
    saveBinaryTempFile: (fileName, base64Data) => safeIpcRenderer.invoke('save-binary-temp-file', fileName, base64Data),
    loadTempFile: (filePath) => safeIpcRenderer.invoke('load-temp-file', filePath),
    deleteTempFile: (filePath) => safeIpcRenderer.invoke('delete-temp-file', filePath),

    getAllSettings: () => safeIpcRenderer.invoke('get-all-settings'),
    getSettings: () => safeIpcRenderer.invoke('get-settings'),
    sendSettingsPreview: (settings) => safeIpcRenderer.send('settings-preview', settings),
    updateSettings: (newSettings) => safeIpcRenderer.invoke('update-settings', newSettings),
    updateEditorSettings: () => {}, // deprecated, kept for backward compatibility
    resetSettings: () => safeIpcRenderer.invoke('reset-settings'),
    exportSettings: () => safeIpcRenderer.invoke('export-settings'),
    importSettings: () => safeIpcRenderer.invoke('import-settings'),
    saveSetting: (key, value) => safeIpcRenderer.invoke('save-setting', key, value),

    openCompilerSettings: () => safeIpcRenderer.invoke('open-compiler-settings'),
    openEditorSettings: () => safeIpcRenderer.invoke('open-editor-settings'),
    openTemplateSettings: () => safeIpcRenderer.send('open-template-settings'),
    openBackupSettings: () => safeIpcRenderer.invoke('open-backup-settings'),

    getPlatform: () => safeIpcRenderer.invoke('get-platform'),
    getUserHome: () => safeIpcRenderer.invoke('get-user-home'),
    getUserIconPath: () => safeIpcRenderer.invoke('get-user-icon-path'),
    getBuildInfo: () => safeIpcRenderer.invoke('get-build-info'),

    getDownloadedCompilers: () => safeIpcRenderer.invoke('get-downloaded-compilers'),
    downloadCompiler: (config) => safeIpcRenderer.invoke('download-compiler', config),
    selectCompiler: (version) => safeIpcRenderer.invoke('select-compiler', version),


    getDownloadedTestlibs: () => safeIpcRenderer.invoke('get-downloaded-testlibs'),
    downloadTestlib: (config) => safeIpcRenderer.invoke('download-testlib', config),
    selectTestlib: (version) => safeIpcRenderer.invoke('select-testlib', version),
    testTestlib: (testlibPath) => safeIpcRenderer.invoke('test-testlib', testlibPath),

    compileFile: (options) => safeIpcRenderer.invoke('compile-file', options),
    formatCppCode: (options) => safeIpcRenderer.invoke('format-cpp-code', options),
    runExecutable: (options) => safeIpcRenderer.invoke('run-executable', options),
    runProgram: (executablePath, input, timeLimit, memoryLimit) => safeIpcRenderer.invoke('run-program', executablePath, input, timeLimit, memoryLimit),
    runInteractive: (options) => safeIpcRenderer.invoke('run-interactive', options),

    startCompare: (config) => safeIpcRenderer.invoke('compare-start', config),
    stopCompare: () => safeIpcRenderer.invoke('compare-stop'),
    onCompareProgress: (cb) => { const l = (_, data) => cb(data); subscribeIpc('compare-progress', l); return () => ipcRenderer.removeListener('compare-progress', l); },
    onCompareError: (cb) => { const l = (_, data) => cb(data); subscribeIpc('compare-error', l); return () => ipcRenderer.removeListener('compare-error', l); },
    onCompareComplete: (cb) => { const l = (_, data) => cb(data); subscribeIpc('compare-complete', l); return () => ipcRenderer.removeListener('compare-complete', l); },

    readDirectory: (dirPath) => safeIpcRenderer.invoke('read-directory', dirPath),
    renameFile: (oldPath, newPath, options = {}) => safeIpcRenderer.invoke('rename-file-invoke', oldPath, newPath, options),
    deleteFile: (filePath, options = {}) => safeIpcRenderer.invoke('delete-file-invoke', filePath, options),
    clearDirectoryContents: (dirPath) => safeIpcRenderer.invoke('clear-directory-contents', dirPath),
    writeFile: (filePath, content) => safeIpcRenderer.invoke('write-file', filePath, content),
    createFile: (filePath, content) => safeIpcRenderer.invoke('create-file', filePath, content),
    createFolder: (folderPath) => safeIpcRenderer.invoke('create-folder', folderPath),
    checkFileExists: (filePath) => safeIpcRenderer.invoke('check-file-exists', filePath),
    getPathInfo: (filePath) => safeIpcRenderer.invoke('get-path-info', filePath),
    ensureDirectory: (dirPath) => safeIpcRenderer.invoke('ensure-directory', dirPath),
    watchFile: (filePath) => safeIpcRenderer.invoke('watch-file', filePath),
    unwatchFile: (filePath) => safeIpcRenderer.invoke('unwatch-file', filePath),

    pathJoin: (...paths) => safeIpcRenderer.invoke('path-join', ...paths),
    pathDirname: (filePath) => safeIpcRenderer.invoke('path-dirname', filePath),
    getHomeDir: () => safeIpcRenderer.invoke('get-home-dir'),
    ensureDir: (dirPath) => safeIpcRenderer.invoke('ensure-dir', dirPath),

    getTerminalFeatureStatus: () => safeIpcRenderer.invoke('terminal-feature-status'),
    createTerminal: (options) => safeIpcRenderer.invoke('terminal-create', options),
    writeTerminal: (terminalId, data) => safeIpcRenderer.invoke('terminal-write', terminalId, data),
    resizeTerminal: (terminalId, cols, rows) => safeIpcRenderer.invoke('terminal-resize', terminalId, cols, rows),
    killTerminal: (terminalId) => safeIpcRenderer.invoke('terminal-kill', terminalId),
    listTerminals: () => safeIpcRenderer.invoke('terminal-list'),
    getTerminalTTY: (terminalId) => safeIpcRenderer.invoke('terminal-get-tty', terminalId),

    onMenuSaveFile: (callback) => subscribeIpc('menu-save-file', callback),
    onApplySettingsPreview: (callback) => subscribeIpc('apply-settings-preview', (event, ...args) => callback(...args)),
    onSettingsApplied: (callback) => subscribeIpc('settings-applied', (event, ...args) => callback(...args)),
    onMenuFormatCode: (callback) => subscribeIpc('menu-format-code', callback),
    onMenuFindReplace: (callback) => subscribeIpc('menu-find-replace', callback),
    onMenuCompile: (callback) => subscribeIpc('menu-compile', callback),
    onMenuCompileRun: (callback) => subscribeIpc('menu-compile-run', callback),
    onMenuDebug: (callback) => subscribeIpc('menu-debug', callback),
    onMenuNewTempFile: (callback) => subscribeIpc('menu-new-temp-file', callback),
    onMenuOpenFile: (callback) => subscribeIpc('menu-open-file', callback),
    onMenuOpenFolder: (callback) => subscribeIpc('menu-open-folder', callback),
    onMenuSaveAs: (callback) => subscribeIpc('menu-save-as', callback),
    onMenuOpenTerminal: (callback) => subscribeIpc('menu-open-terminal', callback),
    onMenuOpenBrowser: (callback) => subscribeIpc('menu-open-browser', callback),
    onMenuNewBrowserTab: (callback) => subscribeIpc('menu-new-browser-tab', callback),
    onMenuAbout: (callback) => subscribeIpc('menu-about', callback),
    onMenuSettings: (callback) => subscribeIpc('menu-settings', callback),
    onMenuCheckUpdates: (callback) => subscribeIpc('menu-check-updates', callback),
    getUpdateDownloadStatus: () => safeIpcRenderer.invoke('get-update-download-status'),
    onUpdateDownloadStatus: (callback) => subscribeIpc('update-download-status', (_event, payload) => callback && callback(payload)),
    onAppToast: (callback) => subscribeIpc('app-toast', (_event, payload) => callback && callback(payload)),

    onShowDebugDevelopingMessage: (callback) => subscribeIpc('show-debug-developing-message', callback),
    onSettingsChanged: (callback) => subscribeIpc('settings-changed', callback),
    onSettingsReset: (callback) => subscribeIpc('settings-reset', (_e, payload) => callback(payload)),
    onSettingsImported: (callback) => subscribeIpc('settings-imported', (_e, payload) => callback(payload)),
    onThemeChanged: (callback) => subscribeIpc('theme-changed', (_e, payload) => callback(payload)),
    onFileOpened: (callback) => subscribeIpc('file-opened', callback),
    onFileSaved: (callback) => subscribeIpc('file-saved', (event, filePath, error) => callback(filePath, error)),
    onFolderOpened: (callback) => subscribeIpc('folder-opened', (event, folderPath) => callback(folderPath)),
    reportWorkspacePath: (folderPath) => safeIpcRenderer.send('workspace-path-report', folderPath),
    onFileOpenedFromArgs: (callback) => subscribeIpc('file-opened-from-args', (event, data) => callback(data)),
    consumeStartupWorkspaceToOpen: () => safeIpcRenderer.invoke('consume-startup-workspace-to-open'),
    onExternalFileChange: (callback) => {
        if (typeof callback !== 'function') return () => { };
        const listener = (_event, payload) => callback(payload);
        subscribeIpc('external-file-changed', listener);
        return () => ipcRenderer.removeListener('external-file-changed', listener);
    },
    onSampleTesterCreateProblem: (callback) => subscribeIpc('sample-tester-create-problem', (_e, data) => callback && callback(data)),
    onTerminalData: (callback) => subscribeIpc('terminal-data', (_event, payload) => callback && callback(payload)),
    onTerminalExit: (callback) => subscribeIpc('terminal-exit', (_event, payload) => callback && callback(payload)),

    getCpuThreads: () => safeIpcRenderer.invoke('get-cpu-threads'),

    sendFeedback: () => {}, // deprecated, kept for backward compatibility
    listClientLogs: () => safeIpcRenderer.invoke('list-client-logs'),
    uploadClientLog: (filePath) => safeIpcRenderer.invoke('upload-client-log', filePath),
    getDeviceInfo: () => safeIpcRenderer.invoke('get-device-info'),
    getEncodedToken: () => safeIpcRenderer.invoke('get-encoded-token'),

    openExternal: (url) => safeIpcRenderer.invoke('open-external', url),

    getLanguage: () => safeIpcRenderer.invoke('get-language'),
    getLanguageFile: (langCode) => safeIpcRenderer.invoke('get-language-file', langCode),
    getAvailableLanguages: () => safeIpcRenderer.invoke('get-available-languages'),
    onLanguageChanged: (callback) => subscribeIpc('language-changed', (_event, langCode) => callback && callback(langCode)),

    startIdeLogin: () => safeIpcRenderer.invoke('ide-login-start'),
    getIdeLoginStatus: () => safeIpcRenderer.invoke('ide-login-status'),
    logoutIdeAccount: () => safeIpcRenderer.invoke('ide-logout'),
    cloudSyncRequest: (payload) => safeIpcRenderer.invoke('cloud-sync-request', payload),
    backupSettingsToCloud: () => safeIpcRenderer.invoke('backup-settings-to-cloud'),
    getSettingsBackupInfo: () => safeIpcRenderer.invoke('get-settings-backup-info'),
    syncSettingsFromCloud: () => safeIpcRenderer.invoke('sync-settings-from-cloud'),
    onIdeLoginUpdated: (callback) => subscribeIpc('ide-login-updated', (_event, payload) => callback && callback(payload)),
    onIdeLoginError: (callback) => subscribeIpc('ide-login-error', (_event, payload) => callback && callback(payload)),

    getRecentFiles: () => safeIpcRenderer.invoke('get-recent-files'),
    openRecentFile: (filePath) => safeIpcRenderer.invoke('open-recent-file', filePath),

    getFileHistory: () => safeIpcRenderer.invoke('get-file-history'),
    addToFileHistory: (filePath) => safeIpcRenderer.invoke('add-to-file-history', filePath),
    openFileFromHistory: (filePath) => safeIpcRenderer.invoke('open-file-from-history', filePath),
    clearFileHistory: () => safeIpcRenderer.invoke('clear-file-history'),
    saveLastOpenTabs: (tabs) => safeIpcRenderer.invoke('save-last-open-tabs', tabs),
    getLastOpenTabs: () => safeIpcRenderer.invoke('get-last-open-tabs'),
    onMenuOpenFileHistory: (callback) => subscribeIpc('menu-open-file-history', callback),

    versions: process.versions,
    platform: process.platform,

    relaunchApp: () => safeIpcRenderer.invoke('relaunch-app'),

    clipboardWriteText: (text) => safeIpcRenderer.invoke('clipboard-write-text', text),
    clipboardReadText: () => safeIpcRenderer.invoke('clipboard-read-text'),

    walkDirectory: (dirPath, options) => safeIpcRenderer.invoke('walk-directory', dirPath, options),

    lspStart: (options) => safeIpcRenderer.invoke('lsp-start', options),
    lspStop: () => safeIpcRenderer.invoke('lsp-stop'),
    lspRestart: (options) => safeIpcRenderer.invoke('lsp-restart', options),
    lspRequest: (method, params, requestId) => safeIpcRenderer.invoke('lsp-request', method, params, requestId),
    lspCancel: (requestId) => safeIpcRenderer.invoke('lsp-cancel', requestId),
    lspApplyEditResult: (requestId, result) => safeIpcRenderer.invoke('lsp-apply-edit-result', requestId, result),
    lspNotify: (method, params) => safeIpcRenderer.invoke('lsp-notify', method, params),
    onLspNotification: (callback) => {
        if (typeof callback !== 'function') return () => {};
        const listener = (_event, payload) => callback(payload);
        subscribeIpc('lsp-notification', listener);
        return () => ipcRenderer.removeListener('lsp-notification', listener);
    },
    onLspApplyEdit: (callback) => {
        if (typeof callback !== 'function') return () => {};
        const listener = (_event, payload) => callback(payload);
        subscribeIpc('lsp-apply-edit', listener);
        return () => ipcRenderer.removeListener('lsp-apply-edit', listener);
    },

    onRequestSaveAll: (callback) => subscribeIpc('request-save-all', () => callback && callback()),
    notifySaveAllComplete: () => safeIpcRenderer.send('save-all-complete'),

    // === 内置浏览器 API ===
    browserResolveUrl: (url) => safeIpcRenderer.invoke('browser-resolve-url', url),
    browserGetPageTitle: (url) => safeIpcRenderer.invoke('browser-get-page-title', url),
    onBrowserOpenNewTab: (callback) => {
        if (typeof callback !== 'function') return () => {};
        const listener = (_event, payload) => callback(payload);
        subscribeIpc('browser-open-new-tab', listener);
        return () => ipcRenderer.removeListener('browser-open-new-tab', listener);
    }
});

contextBridge.exposeInMainWorld('electronIPC', {
    ...safeIpcRenderer,
    ipcRenderer: safeIpcRenderer,
    on: (channel, listener) => {
        if (!ALLOWED_EVENT_CHANNELS.has(channel)) {
            console.warn('IPC event blocked: ' + channel);
            return;
        }
        if (channel === 'file-saved') {
            return ipcRenderer.on('file-saved', (event, filePath, error) => listener(event, filePath, error));
        }
        return ipcRenderer.on(channel, listener);
    },
    once: (channel, listener) => {
        if (!ALLOWED_EVENT_CHANNELS.has(channel)) {
            console.warn('IPC event blocked: ' + channel);
            return;
        }
        if (channel === 'file-saved') {
            return ipcRenderer.once('file-saved', (event, filePath, error) => listener(event, filePath, error));
        }
        return ipcRenderer.once(channel, listener);
    }
});

contextBridge.exposeInMainWorld('process', {
    versions: process.versions,
    platform: process.platform,
    env: {
        NODE_ENV: process.env.NODE_ENV || 'development',
        CI: process.env.CI || false
    }
});

const safeSendLog = (level, args) => {
    try {
        let meta = undefined;
        if (level === 'warn' || level === 'error') {
            meta = {
                source: 'renderer',
                ts: Date.now(),
                userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
                stack: (() => { try { throw new Error('__trace__'); } catch (e) { return e.stack; } })(),
            };
        }
        safeIpcRenderer.send('logger-log', { level, args, meta });
    } catch (_) { }
    // 仅在开发模式或显式开启时输出到控制台
    if (process.env.NODE_ENV === 'development' || process.env.OICPP_CONSOLE_LOG === '1') {
        try {
            if (level === 'warn') console.warn(...args);
            else if (level === 'error') console.error(...args);
            else console.log(...args);
        } catch (_) { }
    }
};

contextBridge.exposeInMainWorld('logInfo', (...args) => safeSendLog('info', args));
contextBridge.exposeInMainWorld('logWarn', (...args) => safeSendLog('warn', args));
contextBridge.exposeInMainWorld('logError', (...args) => safeSendLog('error', args));
contextBridge.exposeInMainWorld('logwarn', (...args) => safeSendLog('warn', args));
contextBridge.exposeInMainWorld('logerror', (...args) => safeSendLog('error', args));
