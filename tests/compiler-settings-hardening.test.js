'use strict';

// 覆盖编译器设置窗口批次：初始化失败链、保存阻断、重复绑定、平台归一化。
// 这批的核心风险是「收紧后把正常功能一起挡掉」与「失败路径静默降级」，
// 所以断言同时覆盖该拒的与该放的。

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { arrowExpr, classMethod } = require('./fixtures/source-extract');

let failures = 0;
const check = (name, cond, extra = '') => {
    console.log(`${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!cond) failures++;
};

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'settings', 'compiler.js'), 'utf8');
const zh = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lang', 'zh-cn.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'lang', 'en.json'), 'utf8'));

const methodBody = (name) => classMethod(src, name);

// ---------------------------------------------------------------------------
// init()：任一探测失败都不能让事件绑定被跳过
// ---------------------------------------------------------------------------

{
    const body = methodBody('init');
    check('init 存在', !!body);
    // 空白容忍：tsc printer 会把 `} catch (e) {` 拆成 `}` + 换行 + `catch`，
    // .ts 迁移后源码不再是同一排版。断言的语义是「独立 try/catch 存在」。
    check('loadSettings 有独立 try/catch', /await this\.loadSettings\(\);\s*\n\s*\}\s*catch/.test(body));
    check('detectMacPlatform 有独立 try/catch 且失败回落 false',
        /this\.isMacPlatform = await this\.detectMacPlatform\(\);\s*\n\s*\}\s*catch[\s\S]{0,200}?this\.isMacPlatform = false;/.test(body));
    check('detectIntegratedOnlyPlatform 有独立 try/catch 且失败回落 false',
        /this\.isIntegratedOnlyPlatform = await this\.detectIntegratedOnlyPlatform\(\);\s*\n\s*\}\s*catch[\s\S]{0,240}?this\.isIntegratedOnlyPlatform = false;/.test(body));
    check('applyCurrentTheme 有独立 try/catch',
        /await this\.applyCurrentTheme\(\);\s*\n\s*\}\s*catch/.test(body));

    // 结构验证：事件绑定排在全部探测之后，且不在任何 catch 块内
    const afterAllAwaits = body.indexOf('this.setupEventListeners();') >
        body.indexOf('this.isIntegratedOnlyPlatform = await');
    check('setupEventListeners 排在全部平台探测之后', afterAllAwaits);
    // 精确校验：setupEventListeners 出现的位置不在任何 catch 的花括号范围内
    const bindIdx = body.indexOf('this.setupEventListeners();');
    let inCatch = false;
    let depth = 0;
    for (let i = 0; i < bindIdx; i++) {
        const ch = body[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        if (/catch\s*\(/.test(body.slice(Math.max(0, i - 6), i + 1))) inCatch = true;
        // catch 块的闭合：回到进入该 catch 前的深度
        if (ch === '}' && depth <= 2) inCatch = false;
    }
    check('setupEventListeners 不在任何 catch 块内', !inCatch);
    check('updateUI 与 detectExistingCompiler 也在事件绑定之后（探测失败也要执行）',
        body.indexOf('this.updateUI();') > body.indexOf('this.setupEventListeners();') &&
        body.indexOf('this.detectExistingCompiler();') > body.indexOf('this.setupEventListeners();'));
}

// ---------------------------------------------------------------------------
// 保存阻断：加载失败时不能把默认值写回
// ---------------------------------------------------------------------------

{
    const load = methodBody('loadSettings');
    const save = methodBody('saveSettings');
    check('方法体抽取成功: loadSettings', load.length > 0);
    check('方法体抽取成功: saveSettings', save.length > 0);

    check('loadSettings 成功时置 _settingsLoaded = true', /this\._settingsLoaded = true;/.test(load));
    check('loadSettings 失败时置 _settingsLoaded = false',
        /catch[\s\S]{0,300}?this\._settingsLoaded = false;/.test(load));
    check('loadSettings 失败时提示用户', /compiler\.loadSettingsFailed/.test(load));

    check('saveSettings 开头检查 _settingsLoaded',
        /saveSettings\s*\(\s*\)\s*\{[\s\S]{0,200}?if \(this\._settingsLoaded === false\)/.test(save));
    check('阻断时直接 return，不执行 updateSettings',
        /if \(this\._settingsLoaded === false\) \{[\s\S]{0,300}?return;\s*\}/.test(save));
    check('阻断提示复用 i18n 键', /compiler\.saveBlockedLoadFailed/.test(save));

    check('构造函数默认 _settingsLoaded = true（未加载过不应误挡）',
        /this\._settingsLoaded = true;/.test(methodBody('constructor')),
        methodBody('constructor').replace(/\s+/g, ' ').slice(0, 60));

    check('zh-cn 存在两个新键',
        typeof zh.compiler?.loadSettingsFailed === 'string' &&
        typeof zh.compiler?.saveBlockedLoadFailed === 'string');
    check('en 存在两个新键',
        typeof en.compiler?.loadSettingsFailed === 'string' &&
        typeof en.compiler?.saveBlockedLoadFailed === 'string');
}

// ---------------------------------------------------------------------------
// 重复绑定
// ---------------------------------------------------------------------------

{
    const body = methodBody('setupEventListeners');
    check('方法体抽取成功: setupEventListeners', body.length > 0);
    const bindings = (body.match(/getElementById\('close-install-dialog'\)|elCtl\('close-install-dialog'\)/g) || []).length;
    const addListeners = (body.match(/closeBtn\.addEventListener|closeDialogBtn\.addEventListener/g) || []).length;
    check('#close-install-dialog 只查询一次', bindings === 1, `${bindings} 次`);
    check('#close-install-dialog 只绑定一次', addListeners === 1, `${addListeners} 处 addEventListener`);
}

// ---------------------------------------------------------------------------
// 平台归一化：win32/darwin 必须映射到 windows/macos
// ---------------------------------------------------------------------------

{
    const body = methodBody('getCurrentPlatform');
    check('方法体抽取成功: getCurrentPlatform', body.length > 0);
    check('getCurrentPlatform 内含归一化逻辑', /const normalize = \(value\)/.test(body));
    // \s* 容忍 tsc printer 把单行 `if (...) return 'x';` 拆成两行
    check('win32/windows 归一化', /v\.startsWith\('win'\)\)\s*return 'windows'/.test(body));
    check('darwin/mac 归一化', /v\.startsWith\('darwin'\)[\s\S]{0,80}?return 'macos'/.test(body));
    check('linux 归一化', /v\.startsWith\('linux'\)\)\s*return 'linux'/.test(body));
    check('getPlatform 的返回值经过归一化',
        /return normalize\(await window\.electronAPI\.getPlatform\(\)\)/.test(body));

    // 行为验证：抽出 normalize 实际跑。终点用配平取，不锁 `\n {8}\};` ——
    // 八个空格是 tsc printer 最容易改动的东西；形参名也不锁，交给箭头表达式配平。
    const normSrc = arrowExpr(body, /const normalize\s*=/);
    check('能抽出 normalize 用于行为验证', normSrc.startsWith('(') && normSrc.endsWith('}'),
        normSrc.replace(/\s+/g, ' ').slice(0, 60));
    {
        const normalize = vm.runInNewContext(`(${normSrc})`);
        const cases = [
            ['win32', 'windows'], ['windows', 'windows'], ['Win32', 'windows'],
            ['darwin', 'macos'], ['macos', 'macos'], ['mac', 'macos'],
            ['linux', 'linux'], ['Linux', 'linux']
        ];
        const wrong = cases.filter(([input, want]) => normalize(input) !== want);
        check('归一化映射正确（行为验证）', wrong.length === 0,
            wrong.map(([i, w]) => `${i}->${normalize(i)} 期望 ${w}`).join(', '));
    }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);