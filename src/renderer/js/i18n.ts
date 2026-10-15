export {};

declare function logInfo(...args: unknown[]): void;
declare function logError(...args: unknown[]): void;

class I18nManager {
    private _messages: Record<string, unknown> = {};
    private _fallbackMessages: Record<string, unknown> = {};
    private _currentLang = 'zh-cn';
    private _loaded = false;
    private _readyPromise: Promise<void> | null = null;
    private _listeners: Array<(lang: string) => void> = [];
    private _observer: MutationObserver | null = null;

    async init(): Promise<void> {
        if (this._readyPromise) return this._readyPromise;
        this._readyPromise = this._doInit();
        return this._readyPromise;
    }

    private async _doInit(): Promise<void> {
        try {
            if (window.electronAPI && typeof window.electronAPI.getLanguage === 'function') {
                this._currentLang = await window.electronAPI.getLanguage();
            }

            await this._loadCurrentLanguage();

            if (window.electronAPI && typeof window.electronAPI.onLanguageChanged === 'function') {
                window.electronAPI.onLanguageChanged(async (langCode: string) => {
                    this._currentLang = langCode || 'zh-cn';
                    await this._loadCurrentLanguage();
                    this._notifyListeners();
                    this._applyToDOM();
                });
            }

            if (window.electronIPC && window.electronIPC.on) {
                window.electronIPC.on('settings-changed', async (_event: unknown, _settingsType: unknown, newSettings: { language?: string }) => {
                    if (newSettings && newSettings.language && newSettings.language !== this._currentLang) {
                        this._currentLang = newSettings.language;
                        await this._loadCurrentLanguage();
                        this._notifyListeners();
                        this._applyToDOM();
                    }
                });
            }

            this._applyToDOM();

            logInfo('[i18n] 语言初始化完成:', this._currentLang);
        } catch (error) {
            logError('[i18n] 初始化失败:', error);
        }
    }

    private async _loadCurrentLanguage(): Promise<void> {
        try {
            if (window.electronAPI && typeof window.electronAPI.getLanguageFile === 'function') {
                const messages = await window.electronAPI.getLanguageFile(this._currentLang);
                if (messages) {
                    this._messages = messages as Record<string, unknown>;
                    this._loaded = true;

                    if (this._currentLang !== 'zh-cn') {
                        const fallback = await window.electronAPI.getLanguageFile('zh-cn');
                        if (fallback) {
                            this._fallbackMessages = fallback as Record<string, unknown>;
                        }
                    }
                }
            }
        } catch (error) {
            logError('[i18n] 加载语言文件失败:', error);
        }
    }

    t(key: string, params?: Record<string, unknown>): string {
        if (!key || typeof key !== 'string') {
            return key || '';
        }

        let value = this._getNested(this._messages, key);
        if (value === undefined || value === null) {
            value = this._getNested(this._fallbackMessages, key);
        }

        if (value === undefined || value === null) {
            return key;
        }

        if (typeof value !== 'string') {
            return String(value);
        }

        if (params && typeof params === 'object') {
            return value.replace(/\{(\w+)\}/g, (match, paramName) => {
                const paramValue = params[paramName];
                return paramValue !== undefined && paramValue !== null ? String(paramValue) : match;
            });
        }

        return value;
    }

    translate(key: string, params?: Record<string, unknown>): string {
        return this.t(key, params);
    }

    getCurrentLanguage(): string {
        return this._currentLang;
    }

    async getAvailableLanguages(): Promise<Array<{ code: string; name: string; nameEn: string }>> {
        try {
            if (window.electronAPI && typeof window.electronAPI.getAvailableLanguages === 'function') {
                return await window.electronAPI.getAvailableLanguages();
            }
        } catch (e) {
            logError('[i18n] 获取可用语言列表失败:', e);
        }
        return [];
    }

    async setLanguage(langCode: string): Promise<void> {
        if (!langCode || langCode === this._currentLang) return;
        try {
            if (window.electronAPI && typeof window.electronAPI.updateSettings === 'function') {
                await window.electronAPI.updateSettings({ language: langCode });
            }
        } catch (error) {
            logError('[i18n] 设置语言失败:', error);
        }
    }

    onChange(callback: (lang: string) => void): () => void {
        if (typeof callback !== 'function') return () => {};
        this._listeners.push(callback);
        return () => {
            const idx = this._listeners.indexOf(callback);
            if (idx >= 0) this._listeners.splice(idx, 1);
        };
    }

    private _notifyListeners(): void {
        for (const listener of this._listeners) {
            try {
                listener(this._currentLang);
            } catch (_) { }
        }
        try {
            document.dispatchEvent(new CustomEvent('i18n-language-changed', {
                detail: { language: this._currentLang }
            }));
        } catch (_) { }
    }

    applyTranslation(): void {
        this._applyToDOM();
    }

    _applyToDOM(): void {
        try {
            document.querySelectorAll('[data-i18n]').forEach((el) => {
                const key = el.getAttribute('data-i18n');
                if (key) {
                    let params: Record<string, unknown> | undefined;
                    const argsAttr = el.getAttribute('data-i18n-args');
                    if (argsAttr) {
                        try { params = JSON.parse(argsAttr); } catch (_) { params = undefined; }
                    }
                    el.textContent = this.t(key, params);
                }
            });

            document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
                const key = el.getAttribute('data-i18n-placeholder');
                if (key && el instanceof HTMLInputElement) {
                    el.placeholder = this.t(key);
                }
            });

            document.querySelectorAll('[data-i18n-title]').forEach((el) => {
                const key = el.getAttribute('data-i18n-title');
                if (key && el instanceof HTMLElement) {
                    el.title = this.t(key);
                }
            });

            document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
                const key = el.getAttribute('data-i18n-aria-label');
                if (key) {
                    el.setAttribute('aria-label', this.t(key));
                }
            });

            document.documentElement.lang = this._currentLang;
        } catch (_) { }
    }

    enableAutoTranslate(): void {
        if (this._observer) return;
        try {
            this._observer = new MutationObserver((mutations: MutationRecord[]) => {
                let needsTranslate = false;
                for (const mutation of mutations) {
                    if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                        for (const node of mutation.addedNodes) {
                            if (node instanceof Element) {
                                const elem = node;
                                if (
                                    elem.hasAttribute('data-i18n') ||
                                    elem.hasAttribute('data-i18n-placeholder') ||
                                    elem.hasAttribute('data-i18n-title') ||
                                    elem.hasAttribute('data-i18n-aria-label') ||
                                    elem.querySelector('[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria-label]')
                                ) {
                                    needsTranslate = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (needsTranslate) break;
                }
                if (needsTranslate) {
                    this._applyToDOM();
                }
            });
            this._observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        } catch (_) { }
    }

    private _getNested(obj: Record<string, unknown>, key: string): unknown {
        if (!obj || !key) return undefined;
        const keys = key.split('.');
        let current: unknown = obj;
        for (const k of keys) {
            if (current === null || current === undefined || typeof current !== 'object') {
                return undefined;
            }
            current = (current as Record<string, unknown>)[k];
        }
        return current;
    }
}

const i18n = new I18nManager();

window.i18n = i18n;
window.__ = i18n.t.bind(i18n) as (key: string, params?: unknown) => string;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = i18n;
}