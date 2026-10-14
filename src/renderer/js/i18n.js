/**
 * Renderer-side i18n module.
 *
 * Translation lookup, {token} interpolation and language switching are delegated to
 * i18next (loaded as a UMD global by index.html). The main process already runs
 * i18next in src/lang/index.js, so both sides now share one implementation.
 *
 * Resource bundles are still fetched over IPC (`get-language-file` returns the raw
 * language JSON, which is exactly an i18next `translation` bundle), so no main-process
 * IPC changes were required.
 *
 * The DOM layer (data-i18n / -placeholder / -title / -aria-label, plus the
 * MutationObserver in enableAutoTranslate) stays hand-written: it encodes project
 * specific attributes that i18next's DOM bindings do not cover.
 *
 * Usage:
 *   window.i18n.t('menu.file');
 *   window.i18n.t('message.updateDownloading', { version: ' v2.0', progress: 50 });
 */
class I18nManager {
    constructor() {
        this._currentLang = 'zh-cn';
        this._readyPromise = null;
        this._listeners = [];
        this._observer = null;
        this._boundLanguageChanged = null;
    }

    // i18next.init is async but resolves synchronously for an inline resource set,
    // so the first translation request is only made after init() has been awaited.
    _initI18next() {
        return i18next.init({
            lng: 'zh-cn',
            fallbackLng: 'zh-cn',
            resources: {},
            // i18next normalizes language codes to Title-Case ('zh-cn' -> 'zh-CN').
            // Bundles are added afterwards via addResourceBundle('zh-cn', ...), so
            // without this the lookup key would not match and t() would silently
            // return the key itself. Keep codes lowercase to match the file names
            // and the main process's lng.
            lowerCaseLng: true,
            // Keep the hand-written placeholder syntax: {token}, not {{token}}.
            interpolation: { prefix: '{', suffix: '}' },
            returnNull: false,
            returnEmptyString: false,
            parseMissingKeyHandler: (key) => key,
        });
    }

    /**
     * Initialize: resolve the current language, load its bundle, then subscribe to
     * language changes. Awaited by every entry point (init.js, settings-init.js and
     * the backup / editor / templates settings windows).
     */
    async init() {
        if (this._readyPromise) return this._readyPromise;

        this._readyPromise = this._doInit();
        return this._readyPromise;
    }

    async _doInit() {
        try {
            await this._initI18next();

            // Register once so repeated init() calls cannot stack subscriptions.
            if (!this._boundLanguageChanged) {
                this._boundLanguageChanged = () => {
                    this._notifyListeners();
                    this._applyToDOM();
                };
                i18next.on('languageChanged', this._boundLanguageChanged);
            }

            // Load current language from settings
            if (window.electronAPI && typeof window.electronAPI.getLanguage === 'function') {
                this._currentLang = await window.electronAPI.getLanguage();
            }

            // Load current language file
            await this._loadCurrentLanguage();

            // _initI18next hard-codes lng:'zh-cn'; i18next.init normalizes it and
            // changeLanguage was never called for the settings language. Without this
            // the store keeps serving Chinese while _currentLang and <html lang>
            // report the configured language. Bring i18next in line.
            if (i18next.language !== this._currentLang) {
                await i18next.changeLanguage(this._currentLang);
            }

            // Listen for language changes pushed by the main process
            if (window.electronAPI && typeof window.electronAPI.onLanguageChanged === 'function') {
                window.electronAPI.onLanguageChanged(async (langCode) => {
                    await this._applyLanguage(langCode || 'zh-cn');
                });
            }

            // Also listen for settings-changed (which includes language)
            if (window.electronIPC && window.electronIPC.on) {
                window.electronIPC.on('settings-changed', async (_event, _settingsType, newSettings) => {
                    if (newSettings && newSettings.language && newSettings.language !== this._currentLang) {
                        await this._applyLanguage(newSettings.language);
                    }
                });
            }

            // Apply to DOM after loading
            this._applyToDOM();

            logInfo('[i18n] 语言初始化完成:', this._currentLang);
        } catch (error) {
            logError('[i18n] 初始化失败:', error);
        }
    }

    /**
     * Load the bundle for a language and hand it to i18next.
     * `get-language-file` returns the raw zh-cn.json / en.json object, which matches
     * i18next's translation resource shape, so it can be added as-is.
     */
    async _loadCurrentLanguage() {
        try {
            if (!window.electronAPI || typeof window.electronAPI.getLanguageFile !== 'function') return;

            const messages = await window.electronAPI.getLanguageFile(this._currentLang);
            if (messages) {
                i18next.addResourceBundle(this._currentLang, 'translation', messages, true, true);

                // Also try to load fallback (Chinese)
                if (this._currentLang !== 'zh-cn') {
                    const fallback = await window.electronAPI.getLanguageFile('zh-cn');
                    if (fallback) {
                        i18next.addResourceBundle('zh-cn', 'translation', fallback, true, true);
                    }
                }
            }
        } catch (error) {
            logError('[i18n] 加载语言文件失败:', error);
        }
    }

    /**
     * Switch language in this renderer. The main process persists the choice and
     * echoes it back over the language-changed IPC, which is handled above.
     */
    async _applyLanguage(langCode) {
        this._currentLang = langCode;
        await this._loadCurrentLanguage();
        if (i18next.language !== langCode) {
            await i18next.changeLanguage(langCode);
        } else {
            // Same language but a fresh bundle: still need listeners + DOM re-applied.
            this._notifyListeners();
            this._applyToDOM();
        }
    }

    /**
     * Translate a key. Thin delegate: i18next handles dotted key lookup, {token}
     * interpolation (missing tokens are left visible on purpose) and returning the
     * key itself for unknown entries.
     */
    t(key, params) {
        if (!key || typeof key !== 'string') {
            return key || '';
        }
        // Before init() (or while the bundle is still loading) i18next has no language
        // set and returns undefined. Consumers assign this straight into textContent,
        // so degrade to the key rather than letting `undefined` reach the DOM.
        const translated = i18next.t(key, params);
        return (translated === undefined || translated === null || translated === '') ? key : translated;
    }

    /**
     * Get the current language code.
     */
    getCurrentLanguage() {
        return this._currentLang;
    }

    /**
     * Get available languages from main process.
     */
    async getAvailableLanguages() {
        try {
            if (window.electronAPI && typeof window.electronAPI.getAvailableLanguages === 'function') {
                return await window.electronAPI.getAvailableLanguages();
            }
        } catch (e) {
            logError('[i18n] 获取可用语言列表失败:', e);
        }
        return [];
    }

    /**
     * Set language and save to settings.
     */
    async setLanguage(langCode) {
        if (!langCode || langCode === this._currentLang) return;
        try {
            if (window.electronAPI && typeof window.electronAPI.updateSettings === 'function') {
                await window.electronAPI.updateSettings({ language: langCode });
            }
        } catch (error) {
            logError('[i18n] 设置语言失败:', error);
        }
    }

    /**
     * Register a listener for language changes.
     * @param {Function} callback - receives the language code
     * @returns {Function} Unsubscribe function
     */
    onChange(callback) {
        if (typeof callback !== 'function') return () => {};
        this._listeners.push(callback);
        return () => {
            const idx = this._listeners.indexOf(callback);
            if (idx >= 0) this._listeners.splice(idx, 1);
        };
    }

    _notifyListeners() {
        for (const listener of this._listeners) {
            try {
                listener(this._currentLang);
            } catch (_) {}
        }
        try {
            document.dispatchEvent(new CustomEvent('i18n-language-changed', {
                detail: { language: this._currentLang }
            }));
        } catch (_) {}
    }

    /**
     * Apply translation to DOM elements with data-i18n attributes.
     * Internal: apply translation to DOM elements with data-i18n attributes.
     * Kept hand-written (not an i18next DOM binding) because data-i18n-args and the
     * html lang attribute are project specific. Called externally by settings-init.js.
     */
    _applyToDOM() {
        try {
            // Translate text content
            document.querySelectorAll('[data-i18n]').forEach(el => {
                const key = el.getAttribute('data-i18n');
                if (key) {
                    let params;
                    const argsAttr = el.getAttribute('data-i18n-args');
                    if (argsAttr) {
                        try { params = JSON.parse(argsAttr); } catch (_) { params = undefined; }
                    }
                    el.textContent = this.t(key, params);
                }
            });

            // Translate placeholders
            document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
                const key = el.getAttribute('data-i18n-placeholder');
                if (key) {
                    el.placeholder = this.t(key);
                }
            });

            // Translate titles
            document.querySelectorAll('[data-i18n-title]').forEach(el => {
                const key = el.getAttribute('data-i18n-title');
                if (key) {
                    el.title = this.t(key);
                }
            });

            // Translate aria labels
            document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
                const key = el.getAttribute('data-i18n-aria-label');
                if (key) {
                    el.setAttribute('aria-label', this.t(key));
                }
            });

            // Update html lang attribute
            document.documentElement.lang = this._currentLang;
        } catch (_) {}
    }

    /**
     * Set up a MutationObserver to automatically translate
     * newly added elements with data-i18n attributes.
     * Call this after the app is ready.
     */
    enableAutoTranslate() {
        if (this._observer) return;
        try {
            this._observer = new MutationObserver((mutations) => {
                let needsTranslate = false;
                for (const mutation of mutations) {
                    if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType === 1) { // Element
                                if (node.hasAttribute && (
                                    node.hasAttribute('data-i18n') ||
                                    node.hasAttribute('data-i18n-placeholder') ||
                                    node.hasAttribute('data-i18n-title') ||
                                    node.hasAttribute('data-i18n-aria-label') ||
                                    node.querySelector('[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria-label]')
                                )) {
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
        } catch (_) {}
    }
}

// Create global singleton
const i18n = new I18nManager();

// Expose globally
window.i18n = i18n;