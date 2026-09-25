class LspClientBridge {
    constructor() {
        this._ready = false;
        this._readyPromise = null;
        this._serverCapabilities = null;
        this._semanticTokensLegend = null;
        this._nextRequestId = 1;
        this._readyListeners = new Set();
        this._diagnosticListeners = new Set();
        this._notificationListeners = new Set();
        this._applyEditListeners = new Set();
        this._bindNotifications();
    }

    _bindNotifications() {
        if (typeof window.electronAPI?.onLspApplyEdit === 'function') {
            window.electronAPI.onLspApplyEdit(async (payload) => {
                if (!payload?.requestId) return;
                let applied = false;
                for (const listener of this._applyEditListeners) {
                    try {
                        const result = await listener(payload.edit);
                        if (result?.applied !== false) applied = true;
                    } catch (_) {}
                }
                try {
                    await window.electronAPI.lspApplyEditResult?.(payload.requestId, { applied });
                } catch (_) {}
            });
        }
        if (!window.electronAPI || typeof window.electronAPI.onLspNotification !== 'function') {
            return;
        }
        window.electronAPI.onLspNotification((payload) => {
            if (!payload || typeof payload.method !== 'string') {
                return;
            }
            if (payload.method === 'textDocument/publishDiagnostics') {
                const params = payload.params || {};
                const uri = params.uri || '';
                const diagnostics = Array.isArray(params.diagnostics) ? params.diagnostics : [];
                this._diagnosticListeners.forEach((listener) => {
                    try { listener(uri, diagnostics); } catch (_) {}
                });
            }
            this._notificationListeners.forEach((listener) => {
                try { listener(payload); } catch (_) {}
            });
        });
    }

    async start(options = {}) {
        if (this._readyPromise) {
            return this._readyPromise;
        }
        this._readyPromise = this._startInternal(options);
        return this._readyPromise;
    }

    async restart(options = {}) {
        this._ready = false;
        this._readyPromise = null;
        this._readyPromise = this._restartInternal(options).catch((err) => {
            this._readyPromise = null;
            throw err;
        });
        return this._readyPromise;
    }

    async _restartInternal(options = {}) {
        const api = window.electronAPI;
        if (!api) {
            throw new Error('LSP API unavailable');
        }

        if (typeof api.lspRestart === 'function') {
            const startResult = await api.lspRestart({
                workspaceRoot: options.workspaceRoot || '',
                clangdArgs: Array.isArray(options.clangdArgs) ? options.clangdArgs : [],
                fallbackFlags: Array.isArray(options.fallbackFlags) ? options.fallbackFlags : [],
                compilerPath: options.compilerPath || '',
                rootUri: options.rootUri || ''
            });

            if (!startResult || startResult.ok !== true) {
                const errMsg = startResult?.error || (('lsp.restartFailUnknown'));
                logError('[LSP] clangd 重启失败:', errMsg);
                throw new Error('clangd restart failed: ' + errMsg);
            }

            if (startResult.alreadyRunning) {
                logInfo('[LSP] clangd 已在运行中，复用现有进程');
            } else {
                logInfo('[LSP] clangd 进程已启动:', startResult.clangdPath || '');
            }

            return await this._finishStartup(startResult, options);
        }

        if (typeof api.lspStop === 'function') {
            await api.lspStop();
        }
        return await this._startInternal(options);
    }

    async _startInternal(options = {}) {
        const api = window.electronAPI;
        if (!api || typeof api.lspStart !== 'function') {
            logError('[LSP] LSP API 不可用，无法启动');
            throw new Error('LSP API unavailable');
        }

        const rootUri = options.rootUri || '';
        const workspaceFolders = rootUri
            ? [{ uri: rootUri, name: options.workspaceName || 'workspace' }]
            : [];

        logInfo('[LSP] 正在启动 clangd LSP 客户端...');
        logInfo('[LSP] 工作区根目录:', options.workspaceRoot || '(无)');
        logInfo('[LSP] rootUri:', rootUri || '(无)');
        if (Array.isArray(options.fallbackFlags) && options.fallbackFlags.length > 0) {
            logInfo('[LSP] 回退编译参数:', options.fallbackFlags.join(' '));
        }
        if (options.compilerPath) {
            logInfo('[LSP] 编译器路径:', options.compilerPath);
        }

        const startResult = await api.lspStart({
            workspaceRoot: options.workspaceRoot || '',
            clangdArgs: Array.isArray(options.clangdArgs) ? options.clangdArgs : [],
            fallbackFlags: Array.isArray(options.fallbackFlags) ? options.fallbackFlags : [],
            compilerPath: options.compilerPath || '',
            rootUri
        });

        // 检查 clangd 启动结果
        if (!startResult || startResult.ok !== true) {
            const errMsg = startResult?.error || (('lsp.startFailUnknown'));
            logError('[LSP] clangd 启动失败:', errMsg);
            throw new Error('clangd start failed: ' + errMsg);
        }

        if (startResult.alreadyRunning) {
            logInfo('[LSP] clangd 已在运行中，复用现有进程');
        } else {
            logInfo('[LSP] clangd 进程已启动:', startResult.clangdPath || '');
        }

        // 使用主进程返回的 fallbackFlags（已包含编译器 include 路径）
        const effectiveFallbackFlags = Array.isArray(startResult.fallbackFlags)
            ? startResult.fallbackFlags
            : (Array.isArray(options.fallbackFlags) ? options.fallbackFlags : []);

        return await this._finishStartup(startResult, options, api, effectiveFallbackFlags);
    }

    async _finishStartup(startResult, options = {}, api = window.electronAPI, effectiveFallbackFlags = null) {
        const rootUri = options.rootUri || '';
        const workspaceFolders = rootUri
            ? [{ uri: rootUri, name: options.workspaceName || 'workspace' }]
            : [];

        const fallbackFlags = Array.isArray(effectiveFallbackFlags)
            ? effectiveFallbackFlags
            : (Array.isArray(startResult?.fallbackFlags)
                ? startResult.fallbackFlags
                : (Array.isArray(options.fallbackFlags) ? options.fallbackFlags : []));

        logInfo('[LSP] 发送 initialize 请求...');

        const initializeParams = {
            processId: null,
            rootUri: rootUri || null,
            workspaceFolders,
            capabilities: {
                textDocument: {
                    synchronization: {
                        openClose: true,
                        change: 1,
                        didSave: true,
                        willSave: false,
                        willSaveWaitUntil: false
                    },
                    completion: {
                        completionItem: {
                            snippetSupport: true,
                            insertReplaceSupport: true,
                            resolveSupport: {
                                properties: ['detail', 'documentation', 'additionalTextEdits']
                            }
                        },
                        contextSupport: true,
                        dynamicRegistration: false
                    },
                    hover: {
                        contentFormat: ['markdown', 'plaintext']
                    },
                    signatureHelp: {
                        signatureInformation: {
                            documentationFormat: ['markdown', 'plaintext'],
                            parameterInformation: {
                                labelOffsetSupport: true
                            }
                        }
                    },
                    definition: {
                        linkSupport: true
                    },
                    declaration: {
                        linkSupport: true
                    },
                    typeDefinition: {
                        linkSupport: true,
                        dynamicRegistration: false
                    },
                    implementation: {
                        linkSupport: true,
                        dynamicRegistration: false
                    },
                    documentHighlight: {
                        dynamicRegistration: false
                    },
                    documentSymbol: {
                        hierarchicalDocumentSymbolSupport: true,
                        symbolKind: {
                            valueSet: [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26]
                        }
                    },
                    references: {},
                    rename: {
                        prepareSupport: true
                    },
                    formatting: {
                        dynamicRegistration: false
                    },
                    rangeFormatting: {
                        dynamicRegistration: false
                    },
                    inlayHint: {
                        dynamicRegistration: false,
                        resolveSupport: {
                            properties: ['tooltip', 'textEdits', 'label.tooltip']
                        }
                    },
                    selectionRange: {
                        dynamicRegistration: false
                    },
                    documentLink: {
                        dynamicRegistration: false
                    },
                    codeAction: {
                        codeActionLiteralSupport: {
                            codeActionKind: {
                                valueSet: ['quickfix', 'refactor', 'refactor.rewrite', 'source']
                            }
                        },
                        isPreferredSupport: true
                    },
                    foldingRange: {},
                    codeLens: {
                        dynamicRegistration: false,
                        resolveSupport: {
                            properties: ['command']
                        }
                    },
                    semanticTokens: {
                        requests: {
                            full: { delta: true }
                        },
                        tokenTypes: [
                            'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter',
                            'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method',
                            'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp',
                            'operator', 'decorator'
                        ],
                        tokenModifiers: [
                            'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract',
                            'async', 'modification', 'documentation', 'defaultLibrary'
                        ],
                        formats: ['relative'],
                        staticSupport: true,
                        dynamicSupport: false,
                        overlappingTokenSupport: false,
                        multilineTokenSupport: false,
                        serverCancelSupport: true,
                        augmentsSyntaxTokens: true
                    }
                },
                workspace: {
                    workspaceFolders: true,
                    symbol: {
                        dynamicRegistration: false
                    },
                    executeCommand: {
                        dynamicRegistration: false
                    }
                }
            },
            initializationOptions: {
                fallbackFlags
            }
        };

        const initResult = await api.lspRequest('initialize', initializeParams);
        this._serverCapabilities = initResult && initResult.capabilities ? initResult.capabilities : null;
        this._semanticTokensLegend = this._serverCapabilities?.semanticTokensProvider?.legend || null;

        const serverInfo = initResult?.serverInfo || {};
        logInfo('[LSP] 初始化完成, 服务器:', serverInfo.name || 'clangd', '版本:', serverInfo.version || '?');
        if (this._semanticTokensLegend) {
            logInfo('[LSP] 语义令牌支持: ' + (this._semanticTokensLegend.tokenTypes?.length || 0) + ' 种类型, ' + (this._semanticTokensLegend.tokenModifiers?.length || 0) + ' 种修饰符');
        }

        await api.lspNotify('initialized', {});
        this._ready = true;
        logInfo('[LSP] clangd LSP 客户端就绪');

        this._readyListeners.forEach((listener) => {
            try { listener(this); } catch (_) {}
        });
        return initResult;
    }

    async request(method, params, cancellationToken = null) {
        const api = window.electronAPI;
        if (!api || typeof api.lspRequest !== 'function') {
            throw new Error('LSP request API unavailable');
        }
        if (cancellationToken?.isCancellationRequested) {
            throw new Error('LSP request cancelled');
        }

        const requestId = `oicpp-renderer-${this._nextRequestId++}`;
        const requestPromise = api.lspRequest(method, params, requestId);
        if (!cancellationToken || typeof cancellationToken.onCancellationRequested !== 'function') {
            return await requestPromise;
        }

        return await new Promise((resolve, reject) => {
            let settled = false;
            const listener = cancellationToken.onCancellationRequested(() => {
                if (settled) return;
                settled = true;
                try { Promise.resolve(api.lspCancel?.(requestId)).catch(() => {}); } catch (_) {}
                reject(new Error('LSP request cancelled'));
            });
            const finish = (callback) => (value) => {
                if (settled) return;
                settled = true;
                listener?.dispose?.();
                callback(value);
            };
            requestPromise.then(finish(resolve), finish(reject));
            if (cancellationToken.isCancellationRequested && !settled) {
                settled = true;
                listener?.dispose?.();
                try { Promise.resolve(api.lspCancel?.(requestId)).catch(() => {}); } catch (_) {}
                reject(new Error('LSP request cancelled'));
            }
        });
    }

    async notify(method, params) {
        const api = window.electronAPI;
        if (!api || typeof api.lspNotify !== 'function') {
            throw new Error('LSP notify API unavailable');
        }
        const result = await api.lspNotify(method, params);
        // 检查通知是否发送成功（进程可能已停止）
        if (result && result.ok === false) {
            logWarn('[LSP] 通知发送失败 (' + method + '):', result.error || '未知错误');
        }
        return result;
    }

    onReady(listener) {
        if (typeof listener !== 'function') return () => {};
        this._readyListeners.add(listener);
        if (this._ready) {
            try { listener(this); } catch (_) {}
        }
        return () => this._readyListeners.delete(listener);
    }

    onDiagnostics(listener) {
        if (typeof listener !== 'function') return () => {};
        this._diagnosticListeners.add(listener);
        return () => this._diagnosticListeners.delete(listener);
    }

    onApplyEdit(listener) {
        if (typeof listener !== 'function') return () => {};
        this._applyEditListeners.add(listener);
        return () => this._applyEditListeners.delete(listener);
    }

    onNotification(listener) {
        if (typeof listener !== 'function') return () => {};
        this._notificationListeners.add(listener);
        return () => this._notificationListeners.delete(listener);
    }

    getSemanticTokensLegend() {
        return this._semanticTokensLegend;
    }

    getServerCapabilities() {
        return this._serverCapabilities;
    }

    supportsCapability(path, fallback = true) {
        if (!path) return fallback;
        let value = this._serverCapabilities;
        for (const key of String(path).split('.')) {
            if (value === null || value === undefined) return fallback;
            value = value[key];
        }
        return value === undefined ? fallback : !!value;
    }
}

window.LspClientBridge = LspClientBridge;
window.lspClient = window.lspClient || new LspClientBridge();
