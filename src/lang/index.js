"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
const i18next = require("i18next");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
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
    parseMissingKeyHandler: (key) => key
});
const i18nextInstance = i18next;
const instance = {
    t: (key, params) => i18nextInstance.t(key, params),
    getCurrentLanguage: () => i18nextInstance.language,
    setLanguage: (lang) => i18nextInstance.changeLanguage(lang),
    getAvailableLanguages: () => [
        { code: 'zh-cn', name: '中文（简体）', nameEn: 'Chinese (Simplified)' },
        { code: 'en', name: 'English', nameEn: 'English' }
    ]
};
module.exports = instance;
