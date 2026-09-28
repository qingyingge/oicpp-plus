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
}

console.log(`bug-report regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;