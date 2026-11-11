import i18next = require('i18next');
import * as fs from 'fs';
import * as path from 'path';

const zhCN = JSON.parse(fs.readFileSync(path.join(__dirname, 'zh-cn.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(__dirname, 'en.json'), 'utf8'));

// i18next v27 的 InitOptions 类型不直接暴露 strictInterpolationChecks（它在 TypeOptions 里，
// 只能通过模块增强添加）。运行时 i18next 会从顶层读取该选项；这里通过本地接口扩展
// 绕过类型检查，同时保持 v26 行为（缺少 params 时 {token} 不会原样渲染为 {{token}}）。
interface I18nInitOptions extends i18next.InitOptions {
    strictInterpolationChecks?: boolean;
}

const i18nInitOptions: I18nInitOptions = {
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
    // 与渲染层 i18n.ts 保持一致：关掉对插值的 HTML 转义。主进程 t() 的终点是原生对话框
    // （showMessageBox 的 title/message/detail/buttons）和菜单标签，不是 HTML，
    // 转义只会把路径变成 &#x2F; 残渣。唯一喂 HTML 的下载窗模板由调用点自行处理。
    interpolation: { prefix: '{', suffix: '}', escape: (value: unknown) => String(value) },
    // v27 默认 strictInterpolationChecks: true，缺少 params 时 {token} 会原样渲染为 {{token}}。
    strictInterpolationChecks: false,
    returnNull: false,
    returnEmptyString: false,
    parseMissingKeyHandler: (key: string) => key
};

i18next.init(i18nInitOptions);

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