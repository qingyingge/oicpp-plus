const i18next = require('i18next');
const fs = require('fs');
const path = require('path');

const zhCN = require('./zh-cn.json');
const en = require('./en.json');

i18next.init({
    lng: 'zh-cn',
    fallbackLng: 'zh-cn',
    resources: {
        'zh-cn': { translation: zhCN },
        'en': { translation: en }
    },
    interpolation: { prefix: '{', suffix: '}' },
    returnNull: false,
    returnEmptyString: false,
    parseMissingKeyHandler: (key) => key
});

const i18nextInstance = /** @type {{ t: (...args: unknown[]) => string, language: string, changeLanguage: (lang: string) => Promise<unknown> }} */ (/** @type {unknown} */ (i18next));

const instance = {
    /** @type {(key: string, params?: unknown) => string} */
    t: (key, params) => i18nextInstance.t(key, params),
    getCurrentLanguage: () => i18nextInstance.language,
    setLanguage: (lang) => i18nextInstance.changeLanguage(lang),
    getAvailableLanguages: () => [
        { code: 'zh-cn', name: '中文（简体）', nameEn: 'Chinese (Simplified)' },
        { code: 'en', name: 'English', nameEn: 'English' }
    ]
};

module.exports = instance;
