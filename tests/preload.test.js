'use strict';
// 用桩替换 electron 模块，加载真实 preload.js，验证 IPC 白名单与事件解包
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const PRELOAD = path.join(ROOT, 'src', 'preload.js');

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const exposed = {};
const sent = [];
const invoked = [];
const listeners = new Map();
const removedChannels = [];
let removeAllCalls = 0;
const warns = [];

const electronStub = {
    contextBridge: {
        exposeInMainWorld: (name, api) => { exposed[name] = api; }
    },
    ipcRenderer: {
        send: (ch, ...args) => { sent.push({ ch, args }); },
        invoke: (ch, ...args) => { invoked.push({ ch, args }); return Promise.resolve({ ok: true }); },
        on: (ch, l) => {
            if (!listeners.has(ch)) listeners.set(ch, []);
            listeners.get(ch).push(l);
            return electronStub.ipcRenderer;
        },
        once: () => { },
        removeListener: (ch) => { removedChannels.push(ch); },
        removeAllListeners: () => { removeAllCalls++; }
    },
    shell: { openExternal: async () => { }, showItemInFolder: () => { }, openPath: async () => '' },
    clipboard: { writeText: () => { }, readText: () => '' }
};

const origLoad = Module._load;
Module._load = function (request) {
    if (request === 'electron') return electronStub;
    return origLoad.apply(this, arguments);
};

console.warn = (...a) => { warns.push(a.join(' ')); };

global.window = { addEventListener: () => { }, location: { href: 'http://localhost/' } };
global.document = {
    readyState: 'complete',
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute() { }, appendChild() { } }),
    addEventListener: () => { },
    body: { appendChild: () => { } }
};

require(PRELOAD);

check('preload exposes electronIPC', !!exposed.electronIPC);
check('preload exposes electronAPI', !!exposed.electronAPI);
check('preload exposes markdownAPI', !!exposed.markdownAPI);

// 扫描 renderer 实际使用的所有 send/invoke 通道
const scanFiles = [];
(function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|html)$/.test(e.name)) scanFiles.push(p);
    }
})(path.join(ROOT, 'src', 'renderer'));

const sendChannels = new Set();
const invokeChannels = new Set();
for (const f of scanFiles) {
    const c = fs.readFileSync(f, 'utf8');
    for (const m of c.matchAll(/(?:electronIPC|ipcRenderer)\.send\(\s*['"`]([^'"`]+)['"`]/g)) sendChannels.add(m[1]);
    for (const m of c.matchAll(/(?:electronIPC|ipcRenderer)\.invoke\(\s*['"`]([^'"`]+)['"`]/g)) invokeChannels.add(m[1]);
}
console.log(`扫描到 renderer send 通道 ${sendChannels.size} 个, invoke 通道 ${invokeChannels.size} 个`);

warns.length = 0;
const blockedSends = [];
for (const ch of sendChannels) {
    const before = sent.length;
    exposed.electronIPC.send(ch, 'x');
    if (sent.length === before) blockedSends.push(ch);
}
check('renderer 所有 send 通道通过白名单', blockedSends.length === 0, blockedSends.join(','));
check('无 IPC send blocked 警告', !warns.some(w => w.includes('IPC send blocked')), warns.join(' | '));

(async () => {
    const blockedInvokes = [];
    for (const ch of invokeChannels) {
        try {
            await exposed.electronIPC.invoke(ch);
        } catch (e) {
            if (String(e && e.message).includes('blocked')) blockedInvokes.push(ch);
        }
    }
    check('renderer 所有 invoke 通道通过白名单', blockedInvokes.length === 0, blockedInvokes.join(','));

    // 事件解包：三个修复通道拿到 payload，未修通道保持原签名
    let got = null;
    exposed.electronAPI.onSettingsReset(v => { got = v; });
    (listeners.get('settings-reset') || [])[0]?.({ sender: 'fake' }, { theme: 'dark' });
    check('settings-reset 解包出 payload', got && got.theme === 'dark', JSON.stringify(got));

    got = null;
    exposed.electronAPI.onSettingsImported(v => { got = v; });
    (listeners.get('settings-imported') || [])[0]?.({ sender: 'fake' }, { editor: { fontSize: 14 } });
    check('settings-imported 解包出 payload', got && got.editor.fontSize === 14);

    got = null;
    exposed.electronAPI.onThemeChanged(v => { got = v; });
    (listeners.get('theme-changed') || [])[0]?.({ sender: 'fake' }, 'solarized');
    check('theme-changed 解包出 payload', got === 'solarized', String(got));

    let args = null;
    exposed.electronAPI.onSettingsChanged((...a) => { args = a; });
    const ev = { sender: 'fake' };
    (listeners.get('settings-changed') || [])[0]?.(ev, 'editor', { x: 1 });
    check('settings-changed 保持 (event,type,settings) 签名', args && args[0] === ev && args[1] === 'editor' && args[2].x === 1);

    // compare 监听器清理只移除自己的通道
    const off = exposed.electronAPI.onCompareProgress(() => { });
    off();
    check('onCompareProgress 用 removeListener 而非 removeAllListeners',
        removedChannels.includes('compare-progress') && removeAllCalls === 0,
        `removed=[${removedChannels}] removeAll=${removeAllCalls}`);

    // markdown 本地图片 + 多次渲染输出一致
    const out1 = exposed.markdownAPI.render('![img](img.png)', 'D:/docs/readme.md');
    const out2 = exposed.markdownAPI.render('![img](img.png)', 'D:/docs/readme.md');
    check('相对图片路径解析为 file://', out1.includes('file:///D:/docs/img.png'), out1.slice(0, 300));
    check('重复渲染输出一致（规则未叠加）', out1 === out2);
    const out3 = exposed.markdownAPI.render('![img](img.png)');
    check('无 filePath 时保持原相对路径', out3.includes('img.png') && !out3.includes('file://'));

    console.log(failures === 0 ? '\nPRELOAD TESTS: ALL PASSED' : `\nPRELOAD TESTS: ${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
})();
