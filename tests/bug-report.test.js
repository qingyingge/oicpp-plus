'use strict';

// BUG_REPORT.json 契约回归测试：锁定审计报告结构与“已修复”条目的
// 代码落点，防止修复被回退或报告条目与代码状态脱节。

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

// --- 报告可解析且结构完整 ------------------------------------------------
const reportPath = path.join(root, 'docs', 'BUG_REPORT.json');
let report = null;
try {
    report = JSON.parse(read('docs/BUG_REPORT.json'));
} catch (error) {
    check('BUG_REPORT.json parses as JSON', false, error.message);
}

if (report) {
    check('BUG_REPORT.json is a non-empty array', Array.isArray(report) && report.length > 0, `${report.length} entries`);

    const ids = new Set();
    let structOk = true;
    let statusCounts = {};
    for (const item of report) {
        if (!item.id || ids.has(item.id)) { structOk = false; }
        if (item.id) ids.add(item.id);
        if (!item.severity || !item.title || !item.status || !item.file) { structOk = false; }
        statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;

        if (item.status === '已修复') {
            if (!item.fix || typeof item.fix.commit !== 'string' || !item.fix.commit || !item.fix.note) { structOk = false; }
        }
    }
    check('every entry has unique id, severity, title, status, file', structOk);
    check('all entries have a recognized status', Object.keys(statusCounts).every((s) => ['已修复', '无效', '待确认', '待修复'].includes(s)));
    check('fixed entries carry a fix.commit and fix.note', statusCounts['已修复'] > 0, `${statusCounts['已修复']} fixed`);
    const placeholders = report.filter((i) => i.status === '已修复' && i.fix && i.fix.commit === 'TBD');
    check('no placeholder commit remains in BUG_REPORT.json', placeholders.length === 0, placeholders.length ? placeholders.map((p) => p.id).join(',') : '');
}

// --- 本次会话修复条目的代码落点 ------------------------------------------
if (report) {
    const editorSource = read('src/renderer/settings/editor.js');
    const sidebarCss = read('src/renderer/css/sidebar.css');
    const templatesHtml = read('src/renderer/settings/templates.html');
    const enJson = read('src/lang/en.json');

    // H14: parseInt 均带 radix
    const h14 = report.find((i) => i.id === 'H14');
    if (h14) {
        const bad = (editorSource.match(/parseInt\(([^)]*\.value|e\.target\.value)\)/g) || []);
        check('H14 editor.js parseInt calls all pass radix 10', bad.length === 0, bad.length ? bad.join('; ') : '');
    }

    // L7: 删除被 min-width: 0 覆盖的死代码 min-width: 200px
    const l7 = report.find((i) => i.id === 'L7');
    if (l7) {
        const panel = /\.sidebar-panel\s*\{[\s\S]*?\}/.exec(sidebarCss);
        const body = panel ? panel[0] : '';
        const hasDeadMinWidth = (body.match(/min-width:\s*200px/g) || []).length > 0;
        const hasMinWidth0 = body.includes('min-width: 0');
        check('L7 .sidebar-panel keeps only min-width: 0', hasMinWidth0 && !hasDeadMinWidth);
    }

    // L8: .message-toast.warning 不再携带 textarea 专属样式
    const l8 = report.find((i) => i.id === 'L8');
    if (l8) {
        const toastBlock = /\.message-toast\.warning\s*\{[\s\S]*?\}/.exec(templatesHtml);
        const body = toastBlock ? toastBlock[0] : '';
        const leaked = /resize:\s*vertical|font-family:\s*'Consolas'|box-sizing:\s*border-box/.test(body);
        check('L8 .message-toast.warning has no textarea styles', !leaked && body.includes('background-color: #ffc107'));
    }

    // L10: en.json analysisEmpty 为英文
    const l10 = report.find((i) => i.id === 'L10');
    if (l10) {
        const enPack = JSON.parse(enJson);
        const value = enPack.compileOutput && enPack.compileOutput.analysisEmpty;
        check('L10 en.json compileOutput.analysisEmpty is English', typeof value === 'string' && !/[\u4e00-\u9fff]/.test(value), value || '');
    }

    // L25: editor.js 回退默认设置均含 fontLigaturesEnabled
    const l25 = report.find((i) => i.id === 'L25');
    if (l25) {
        const blocks = [];
        const needle = 'this.settings = {';
        let idx = 0;
        while ((idx = editorSource.indexOf(needle, idx)) !== -1) {
            const end = editorSource.indexOf('};', idx);
            blocks.push(editorSource.slice(idx, end === -1 ? idx + 600 : end));
            idx += needle.length;
        }
        const allHaveLigatures = blocks.every((blk) => blk.includes('fontLigaturesEnabled'));
        check('L25 every editor.js settings block has fontLigaturesEnabled', blocks.length >= 3 && allHaveLigatures, `${blocks.length} blocks`);
    }

    // --- 本轮安全/资源修复条目代码落点 -----------------------------------
    const tabsSource = read('src/renderer/js/tabs.js');
    const sidebarSource = read('src/renderer/js/sidebar.js');
    const sampleTesterSource = read('src/renderer/js/sidebar/sampleTester.js');
    const mainSource = read('src/main.js');
    const langIndex = read('src/lang/index.js');
    const compilerSource = read('src/renderer/settings/compiler.js');
    const indexHtml = read('src/renderer/index.html');

    // H10: PDF 消息处理校验 event.origin（拒绝跨源伪造）
    const h10 = report.find((i) => i.id === 'H10');
    if (h10) {
        check('H10 PDF message handler validates event.origin',
            tabsSource.includes('event.origin') && tabsSource.includes('window.location.origin'));
    }

    // H11: CSP frame-src 收窄为 self
    const h11 = report.find((i) => i.id === 'H11');
    if (h11) {
        const csp = /Content-Security-Policy" content="([^"]+)/.exec(indexHtml);
        const cspValue = csp ? csp[1] : '';
        check('H11 CSP frame-src narrowed to self', cspValue.includes('frame-src') && !cspValue.includes('frame-src *'));
    }

    // M22: sampleTester 提供 deactivate 清理 interval，且面板切换时调用
    const m22 = report.find((i) => i.id === 'M22');
    if (m22) {
        check('M22 SampleTester has deactivate clearing interval',
            sampleTesterSource.includes('deactivate()') && sampleTesterSource.includes('clearInterval(this.editorChangeInterval)'));
        check('M22 SidebarManager calls deactivate on panel switch', sidebarSource.includes('.deactivate()'));
    }

    // L1: 移除死代码 debugProcess/debugSession
    const l1 = report.find((i) => i.id === 'L1');
    if (l1) {
        check('L1 debugProcess/debugSession removed', !/let debugProcess\b|let debugSession\b/.test(mainSource));
    }

    // L9: 移除 templates.html 死代码 tab 切换脚本
    const l9 = report.find((i) => i.id === 'L9');
    if (l9) {
        check('L9 templates.html dead tab script removed', !templatesHtml.includes('.settings-tabs .tab-btn'));
    }

    // L15: 移除 lang/index.js 无效 reload()
    const l15 = report.find((i) => i.id === 'L15');
    if (l15) {
        check('L15 lang/index.js dead reload removed', !langIndex.includes('reload:') && !langIndex.includes('reloadResources'));
    }

    // L28: compiler.js testlib-path 元素空值保护
    const l28 = report.find((i) => i.id === 'L28');
    if (l28) {
        const testBlock = /async testTestlib\(\) \{[\s\S]*?if \(!testlibPathInput\)/.exec(compilerSource);
        const setBlock = /async setTestlibPath\(path\) \{[\s\S]*?if \(testlibPathInput\)/.exec(compilerSource);
        check('L28 testTestlib null-checks #testlib-path', !!(testBlock && testBlock[0].includes('if (!testlibPathInput)')));
        check('L28 setTestlibPath null-checks #testlib-path', !!(setBlock && setBlock[0].includes('if (testlibPathInput)')));
    }

    // L6: 报告称 monaco-editor.css 首个 :root 是死代码，实测两个 :root 变量集不同。
    // 锁定 invalid_reason 成立，防止后续误删仍在使用的变量。
    const l6 = report.find((i) => i.id === 'L6');
    if (l6) {
        check('L6 monaco-editor.css has two :root blocks', l6.status === '无效');
        const monacoCss = read('src/renderer/css/monaco-editor.css');
        const rootBlocks = [...monacoCss.matchAll(/(^|\})\s*:root\s*\{([^}]*)\}/gm)].map((m) => m[2]);
        const varsOf = (body) => [...new Set((body.match(/--[a-z0-9-]+(?=\s*:)/g) || []))];
        const firstVars = new Set(varsOf(rootBlocks[0] || ''));
        const secondVars = new Set(varsOf(rootBlocks[1] || ''));
        const firstOnly = [...firstVars].filter((v) => !secondVars.has(v));
        check('L6 the two :root blocks do not declare the same variables',
            rootBlocks.length === 2 && firstOnly.length > 0 && firstVars.size !== secondVars.size,
            `first=${firstVars.size} second=${secondVars.size} firstOnly=${firstOnly.length}`);
        const restOfMonacoCss = monacoCss.slice(monacoCss.indexOf(rootBlocks[1] || ''));
        // 变量可能只在其他 CSS、HTML 或渲染脚本里被引用（如 --editor-font-* 由
        // settings-init.js 设置、Monaco 消费），所以扫描整个渲染层源码。
        const corpus = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    walk(full);
                } else if (/\.(css|html|js)$/.test(entry.name) && full !== path.join(root, 'src', 'renderer', 'css', 'monaco-editor.css')) {
                    corpus.push(fs.readFileSync(full, 'utf8'));
                }
            }
        };
        walk(path.join(root, 'src', 'renderer'));
        const cssCorpus = corpus.join('\n') + '\n' + restOfMonacoCss;
        const unused = firstOnly.filter((v) => !cssCorpus.includes(v));
        check('L6 variables unique to the first :root are still used elsewhere',
            unused.length === 0,
            unused.join(',') || `${firstOnly.length}/${firstOnly.length} in use`);
    }
}

console.log(`bug-report regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;