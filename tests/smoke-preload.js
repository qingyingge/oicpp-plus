// 无头 smoke 用的假 preload：只提供 i18n.js 真正依赖的那几个 API。
// 目的是在真实 Chromium + 真实 file:// + 真实 CSP 下验证渲染层 i18n。
const { contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');

const langDir = path.join(__dirname, '..', 'src', 'lang');
let current = 'zh-cn';
const cache = new Map();
const readPack = (code) => {
    if (!cache.has(code)) {
        cache.set(code, JSON.parse(fs.readFileSync(path.join(langDir, `${code}.json`), 'utf8')));
    }
    return cache.get(code);
};

contextBridge.exposeInMainWorld('logInfo', () => {});
contextBridge.exposeInMainWorld('logWarn', () => {});
contextBridge.exposeInMainWorld('logError', () => {});

const langChanged = [];
const settingsChanged = [];
contextBridge.exposeInMainWorld('electronIPC', {
    on: (evt, cb) => { if (evt === 'settings-changed') settingsChanged.push(cb); },
    send: () => {},
    invoke: async () => undefined,
});

contextBridge.exposeInMainWorld('electronAPI', {
    getLanguage: async () => current,
    getLanguageFile: async (code) => readPack(code || current),
    getAvailableLanguages: async () => [
        { code: 'zh-cn', name: '中文（简体）', nameEn: 'Chinese (Simplified)' },
        { code: 'en', name: 'English', nameEn: 'English' },
    ],
    getAllSettings: async () => ({ language: current }),
    onLanguageChanged: (cb) => { langChanged.push(cb); },
    updateSettings: async (s) => { if (s && s.language) current = s.language; },
    // 渲染层其它脚本在 DOMContentLoaded 早期会摸这些，缺了会抛 ReferenceError 掩盖真实问题
    getUserIconPath: async () => '',
    getPlatform: async () => 'linux',
    getVersion: async () => '1.5.4',
    getHomeDir: async () => '/tmp',
    getSettings: async () => ({}),
    pathJoin: async (...a) => path.join(...a),
    pathDirname: async (p) => path.dirname(p),
    readFileContent: async () => '',
    getResourcePath: () => '',
});

process.on('message', (m) => {
    if (m === 'switch-en' && langChanged.length) {
        current = 'en';
        for (const cb of langChanged) cb('en');
    }
    if (m === 'settings-en' && settingsChanged.length) {
        current = 'en';
        for (const cb of settingsChanged) cb({}, 'general', { language: 'en' });
    }
});
