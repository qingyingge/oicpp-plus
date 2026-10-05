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

const instance = {
    /** @type {(key: string, params?: any) => string} */
    t: (key, params) => /** @type {any} */ (i18next).t(key, params),
    getCurrentLanguage: () => /** @type {any} */ (i18next).language,
    setLanguage: (lang) => /** @type {any} */ (i18next).changeLanguage(lang),
    getAvailableLanguages: () => [
        { code: 'zh-cn', name: '中文（简体）', nameEn: 'Chinese (Simplified)' },
        { code: 'en', name: 'English', nameEn: 'English' }
    ]
};

module.exports = instance;
