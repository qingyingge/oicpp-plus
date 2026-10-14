import i18next = require('i18next');
import * as fs from 'fs';
import * as path from 'path';

const zhCN = JSON.parse(fs.readFileSync(path.join(__dirname, 'zh-cn.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(__dirname, 'en.json'), 'utf8'));

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
    parseMissingKeyHandler: (key: string) => key
});

interface I18nInstance {
    t: (key: string, params?: Record<string, unknown>) => string;
    language: string;
    changeLanguage: (lang: string) => Promise<unknown>;
}

const i18nextInstance: I18nInstance = i18next as unknown as I18nInstance;

const instance = {
    t: (key: string, params?: Record<string, unknown>): string => i18nextInstance.t(key, params),
    getCurrentLanguage: (): string => i18nextInstance.language,
    setLanguage: (lang: string): Promise<unknown> => i18nextInstance.changeLanguage(lang),
    getAvailableLanguages: (): Array<{ code: string; name: string; nameEn: string }> => [
        { code: 'zh-cn', name: '中文（简体）', nameEn: 'Chinese (Simplified)' },
        { code: 'en', name: 'English', nameEn: 'English' }
    ]
};

export = instance;