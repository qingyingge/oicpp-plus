'use strict';

// 1.6.0-beta1 tag 之后那批上游修复（d872ba1 / 9ee5ef1 / accdd71）落地到 fork 后的守卫。
//
// 与既有 *-ports 测试同一口径：能跑的跑起来断言，不能跑的至少锁住「修复确实接在调用点上」。
// 上游一律改 .js 产物，fork 的 .js 是 tsc 从 .ts emit 的，所以这里读的是产物、
// 断言的是行为 —— 真源改动永远写在 .ts。

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const read = (relative) => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
const mainSource = read('src/main.js');

// ------------------------------------------------------------------ #512 安装包文件名判定
// 上游原版只认 \d+\.\d+\.\d+-Setup，本 fork 自己产出的包带预发布后缀
// （installer.nsi: APP_VERSION='1.6.0-beta1-plus1'），于是「刚下载好的待装更新」被判成非法文件名
// 静默丢弃、旧包也永远不被回收。修复是把两段判定都放开，且两处口径必须一致。
{
    const pick = (decl) => {
        const m = new RegExp(`const ${decl} = /((?:[^\\\\/]|\\\\.)+)/([a-z]*)(?:\\.test|;)`).exec(mainSource);
        return m ? { source: m[1], flags: m[2] } : null;
    };
    const resolveSrc = /function resolveValidatedInstallerPath\([\s\S]*?\n\}/.exec(mainSource);
    check('抽取到 resolveValidatedInstallerPath 正文', !!resolveSrc, String(resolveSrc && resolveSrc[0].length));

    const validateLit = pick('looksLikeInstaller');
    const cleanupLit = pick('installerPattern');
    check('两处判定都还写成正则字面量', !!validateLit && !!cleanupLit, JSON.stringify({ validateLit, cleanupLit }));
    if (!validateLit || !cleanupLit) {
        console.log('upstream 1.6.0-beta1 tag 批移植 tests completed: ' + (failures === 0 ? 'all checks passed' : failures + ' FAILED'));
        process.exitCode = failures === 0 ? 0 : 1;
    } else {
        // 用 RegExp(source, flags) 复刻字面量，而不是把源码里的字面量丢给 eval 编译
        const validate = new RegExp(validateLit.source, validateLit.flags);
        const cleanup = new RegExp(cleanupLit.source, cleanupLit.flags);

        const mustAccept = [
            'OICPP-Plus-1.6.0-beta1-plus.1-Setup.exe',
            'OICPP-Plus-1.6.0-beta1-plus1-Setup.exe',
            'OICPP-1.5.4-Setup.exe',
            'OICPP-Plus-1.6.0-Setup.exe',
            'OICPP-1.6.0-beta.1-Setup.deb',
            'OICPP-Plus-1.6.0-Setup.rpm',
            'oicpp-plus-1.6.0-beta1-plus1-setup.exe'
        ];
        const mustReject = [
            'notepad-1.0.0-Setup.exe',
            'OICPP-Plus-1.6.0-Setup.msi',
            'OICPP-Plus-1.6-snapshot-Setup.exe',
            'OICPP-Plus-1.6.0-Setup.exe.bak',
            'OICPP-Plus-1.6.0-Setup.exe.old',
            'electron.exe'
        ];
        check('fork 自己的带预发布后缀安装包被认成合法（上游原版在这里判 false）',
            validate.test('OICPP-Plus-1.6.0-beta1-plus1-Setup.exe'), validateLit.source);
        check('合法名全部放行 · resolveValidatedInstallerPath', mustAccept.every((n) => validate.test(n)),
            JSON.stringify(mustAccept.filter((n) => !validate.test(n))));
        check('伪装的合法名一律拦下 · resolveValidatedInstallerPath', mustReject.every((n) => !validate.test(n)),
            JSON.stringify(mustReject.filter((n) => validate.test(n))));
        check('合法名全部放行 · cleanupOldInstallers', mustAccept.every((n) => cleanup.test(n)),
            JSON.stringify(mustAccept.filter((n) => !cleanup.test(n))));
        check('伪装的合法名一律拦下 · cleanupOldInstallers', mustReject.every((n) => !cleanup.test(n)),
            JSON.stringify(mustReject.filter((n) => cleanup.test(n))));
        // 两处口径不一致 = 一处认得、另一处不认，beta 包会留在磁盘上永远回收不掉
        check('两处判定对同一批文件名的结论完全一致',
            mustAccept.concat(mustReject).every((n) => validate.test(n) === cleanup.test(n)),
            JSON.stringify(mustAccept.concat(mustReject).filter((n) => validate.test(n) !== cleanup.test(n))));

        check('判定仍与目录约束并联（放开文件名不等于放开路径）',
            /isPathInsideDir\(installerPath, installerDir\)\s*&&\s*looksLikeInstaller/.test(resolveSrc[0]),
            resolveSrc[0].split('\n').filter((l) => /return|isPathInsideDir/.test(l)).join(' | ').slice(0, 300));
        check('清理只删判定的匹配项，keepFile 保护仍在',
            /if \(installerPattern\.test\(file\)\)/.test(mainSource)
            && /if \(keepFile && filePath === keepFile\)/.test(mainSource));
    }
}

// ------------------------------------------------------------------ #517 调试面板滚动容器
// fork 的标记（sidebar/debugPanel.ts）一直写着 <div class="debug-split"><div class="left">，
// 但 debug.css 里 .debug-split 一条规则都没有 → 它是 display:block 的默认 div，
// .sidebar-panel .variables-panel { flex: 1 1 auto; overflow-y: auto } 那条永远不生效，
// 变量多了不出滚动条。守卫锁「CSS 里有规则」且「规则挂的类名确实是标记里的类名」。
{
    const css = read('src/renderer/css/debug.css');
    const panelMarkup = read('src/renderer/js/sidebar/debugPanel.js');

    const splitRule = /\.debug-split\s*\{[^}]*\}/.exec(css);
    check('.debug-split 规则已存在（上游原版一条都没有）', !!splitRule, String(splitRule && splitRule[0]).replace(/\s+/g, ' '));
    const leftRule = /\.debug-split\s*>\s*\.left\s*\{[^}]*\}/.exec(css);
    check('.debug-split > .left 规则已存在', !!leftRule, String(leftRule && leftRule[0]).replace(/\s+/g, ' '));
    check('.debug-split 是 flex 且允许收缩',
        !!splitRule && /display:\s*flex/.test(splitRule[0]) && /flex:\s*1 1 auto/.test(splitRule[0]));
    check('.left 自己承担溢出滚动', !!leftRule && /overflow:\s*auto/.test(leftRule[0]));
    check('min-height:0 补上（flex 子项不写就撑不破容器）',
        !!splitRule && /min-height:\s*0/.test(splitRule[0]) && !!leftRule && /min-width:\s*0/.test(leftRule[0]));

    check('CSS 挂的类名与调试面板实际标记一致',
        /class="debug-split"/.test(panelMarkup) && /class="left"/.test(panelMarkup),
        'debugPanel.js 里的 class 名');
    check('变量面板的 flex 规则仍在（被 .debug-split 顶起来的那条）',
        /\.sidebar-panel \.variables-panel\s*\{[^}]*flex:\s*1 1 auto[^}]*overflow-y:\s*auto/s.test(css));
}

// ------------------------------------------------------------------ #521 关闭前保存不再静默失败
// accdd71 修的是「点保存并关闭、什么都没发生」：proceedSave 里五条死路全是裸 return，
// 用户看不到任何提示，标签也关不掉。fork 这边改成每条走不通的路都抛（带 i18n 文案），
// 由 catch 统一弹窗。这里锁的是「静默 return 已换成 throw」以及「提示文案来自语言包」。
{
    const tabsSource = read('src/renderer/js/tabs.js');
    const body = /const proceedSave = async \(\) => \{[\s\S]*?\n            \};/.exec(tabsSource);
    check('抽取到 proceedSave 正文', !!body, String(body && body[0].length));
    if (body) {
        const text = body[0];
        const throws = (text.match(/throw new Error\(window\.i18n\.t\(/g) || []).length;
        check('四条走不通的路都改成抛错（原来全是静默 return）', throws >= 4, `throw i18n 文案 ${throws} 处`);
        check('抛出的文案一律取语言包，没有硬编码中文',
            !/throw new Error\(['"][\u4e00-\u9fa5]/.test(text), text.split('\n').filter((l) => /throw new Error/.test(l)).join(' | ').slice(0, 240));
        check('catch 里把原因显示给用户而不是只写日志',
            /const title = window\.i18n\.t\('message\.saveFailed'\)/.test(text)
            && /showConfirmDialog\(title, `\$\{title\}: \$\{errorText\}`\)/.test(text),
            text.split('\n').filter((l) => /showConfirmDialog|const title|logWarn/.test(l)).join(' | ').slice(0, 300));
        check('日志仍然照写（弹窗不是替代品）', /logWarn\(/.test(text));
        // 唯一保留的静默退出：用户在系统保存框里主动取消，那不该弹「保存失败」
        check('主动取消另存仍是静默返回（不误报成失败）',
            /const savedPath = await window\.electronAPI\.saveAsFile\(content\);\s*if \(!savedPath\)\s*return;/.test(text)
            || /if \(!savedPath\)\s*\{\s*return;/.test(text),
            text.split('\n').filter((l) => /savedPath/.test(l)).join(' | ').slice(0, 260));
        check('保存成功才继续关闭（失败路径不会把标签关掉）',
            text.indexOf('this.closeTab(fileName') > text.indexOf('catch'));
    }
    const zh = JSON.parse(read('src/lang/zh-cn.json'));
    const en = JSON.parse(read('src/lang/en.json'));
    for (const key of ['dialog.saveApiUnavailable', 'dialog.cloudSaveFailed', 'dialog.saveNoContent', 'message.saveFailed', 'error.invalidFilePath']) {
        const get = (o) => key.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
        check(`${key} 双语齐备且正文非空`, !!get(zh) && !!get(en), JSON.stringify({ zh: get(zh), en: get(en) }));
    }
}

console.log('upstream 1.6.0-beta1 tag 批移植 tests completed: ' + (failures === 0 ? 'all checks passed' : failures + ' FAILED'));
process.exitCode = failures === 0 ? 0 : 1;
