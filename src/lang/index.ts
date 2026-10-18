import i18next = require('i18next');
import * as fs from 'fs';
import * as path from 'path';

const zhCN = JSON.parse(fs.readFileSync(path.join(__dirname, 'zh-cn.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(__dirname, 'en.json'), 'utf8'));

i18next.init({
    lng: 'zh-cn',
    fallbackLng: 'zh-cn',
    // i18next 对带连字符的语言码走 Intl.getCanonicalLocales 规范化（zh-cn → zh-CN），
    // 而下面 resources 的键按设置里的字面值写成 zh-cn，两边对不上时中文每条 t() 都掉进
    // parseMissingKeyHandler，界面直接显示裸键名。开这个选项把规范化结果拉回小写对齐。
    lowerCaseLng: true,
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