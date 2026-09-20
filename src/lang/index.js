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
    t: (key, params) => i18next.t(key, params),
    getCurrentLanguage: () => i18next.language,
    setLanguage: (lang) => i18next.changeLanguage(lang),
    getAvailableLanguages: () => [
        { code: 'zh-cn', name: '中文（简体）', nameEn: 'Chinese (Simplified)' },
        { code: 'en', name: 'English', nameEn: 'English' }
    ],
    reload: () => {
        i18next.reloadResources(['zh-cn', 'en']);
    }
};

module.exports = instance;
