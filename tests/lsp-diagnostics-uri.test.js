'use strict';

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const monacoSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'js', 'monaco-editor-manager.js'), 'utf8');
const tabsSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'js', 'tabs.js'), 'utf8');

// ---------------------------------------------------------------------------
// _normalizeLspUri: 统一解码，而不是只认 %3A
// ---------------------------------------------------------------------------

const normStart = monacoSrc.indexOf('    _normalizeLspUri(uri) {');
const normEnd = monacoSrc.indexOf('\n    }', normStart);
if (normStart < 0 || normEnd < 0) throw new Error('_normalizeLspUri not found');
const normalizeSrc = monacoSrc.slice(normStart, normEnd);

const norm = new Function('uri', normalizeSrc.slice(normalizeSrc.indexOf('{') + 1));

check('%2B 被解码（clangd 按 RFC 编码 + 号）',
    norm('file:///D:/MX/U1904%2B%2B.cpp') === 'file:///D:/MX/U1904++.cpp',
    norm('file:///D:/MX/U1904%2B%2B.cpp'));
check('%3A 盘符冒号解码后补回 URI 形态',
    norm('file:///D%3A/Users/a.cpp') === 'file:///D:/Users/a.cpp',
    norm('file:///D%3A/Users/a.cpp'));
check('%20 空格解码',
    norm('file:///D:/my%20dir/a.cpp') === 'file:///D:/my dir/a.cpp');
check('无百分号时原样返回',
    norm('file:///D:/plain/a.cpp') === 'file:///D:/plain/a.cpp');
check('非法百分号序列不抛异常',
    norm('file:///D:/100%/a.cpp') === 'file:///D:/100%/a.cpp',
    norm('file:///D:/100%/a.cpp'));
check('非字符串输入不抛异常', norm(null) === null);

// ---------------------------------------------------------------------------
// 诊断匹配失败不再直接丢弃：走延迟重试
// ---------------------------------------------------------------------------

check('匹配失败时调度重试而非直接 return',
    /_scheduleLspDiagnosticsRetry\(uri, diagnostics\);/.test(monacoSrc) &&
    !/const model = this\.findModelByLspUri\(uri\);\s*\n\s*if \(!model\) \{\s*\n\s*logWarn[\s\S]{0,120}?return;/.test(monacoSrc));

check('重试实现存在且有分级延迟',
    /_scheduleLspDiagnosticsRetry\(uri, diagnostics, attempt = 1\)/.test(monacoSrc) &&
    /RETRY_DELAYS = \[200, 500\]/.test(monacoSrc));

check('同一 uri 只保留一条重试链（防连续保存叠出多条）',
    /_lspDiagnosticRetryTimers/.test(monacoSrc) &&
    /const pending = this\._lspDiagnosticRetryTimers\.get\(uri\); if \(pending\) clearTimeout\(pending\);/.test(monacoSrc)
        || /if \(pending\) clearTimeout\(pending\);/.test(monacoSrc));

check('重试命中后真正落一次诊断（避免只探测不应用）',
    /if \(this\.findModelByLspUri\(uri\)\) \{\s*\n\s*this\.applyLspDiagnostics\(uri, diagnostics\);/.test(monacoSrc));

// ---------------------------------------------------------------------------
// saveAllFiles: 按 filePath 去重，且标记覆盖同文件的所有 uniqueKey
// ---------------------------------------------------------------------------

const saveAllStart = tabsSrc.indexOf('    async saveAllFiles() {');
const saveAllEnd = tabsSrc.indexOf('\n    openFileDialog()', saveAllStart);
if (saveAllStart < 0 || saveAllEnd < 0) throw new Error('saveAllFiles not found');
const saveAllSrc = tabsSrc.slice(saveAllStart, saveAllEnd);

check('saveAllFiles 按 filePath 归并，不再按 uniqueKey 逐个直接保存',
    /byFilePath = new Map\(\)/.test(saveAllSrc) &&
    /for \(const \[filePath, \{ content, uniqueKeys \}\] of byFilePath\.entries\(\)\)/.test(saveAllSrc) &&
    // 旧的 bug 形态：tasks.push 在遍历 tabs 的循环体内按 filePath 逐个发起
    !/for \(const \[uniqueKey, tab\] of this\.tabs\.entries\(\)\)[\s\S]{0,900}?tasks\.push\(/.test(saveAllSrc));

check('每个 filePath 只发起一次 saveFile',
    (saveAllSrc.match(/window\.electronAPI\.saveFile\(/g) || []).length === 1);

check('去重时保留同文件的全部 uniqueKey',
    /uniqueKeys\.push\(uniqueKey\)/.test(saveAllSrc));

check('保存成功后标记覆盖全部关联 uniqueKey',
    /uniqueKeys\.forEach\(\(key\) => this\.markTabAsSavedByUniqueKey\(key\)\)/.test(saveAllSrc));

check('无 electronAPI.saveFile 时也标记全部 uniqueKey',
    (saveAllSrc.match(/uniqueKeys\.forEach\(\(key\) => this\.markTabAsSavedByUniqueKey\(key\)\)/g) || []).length === 2);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures ? 1 : 0);