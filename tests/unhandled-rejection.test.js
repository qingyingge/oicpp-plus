'use strict';

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/renderer/js/init.js'), 'utf8');

// 取函数源码而不是复制判定逻辑：谓词写错时测试必须一起失败
const extractFunction = (name) => {
    const start = source.indexOf(`function ${name}(`);
    if (start < 0) return null;
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    return null;
};

const fnSource = extractFunction('isMonacoModelReferenceRejection');
check('predicate is extracted from init.js', !!fnSource, fnSource ? '' : 'isMonacoModelReferenceRejection not found');
const predicate = fnSource ? new Function(`return (${fnSource})`)() : null;

// 2026-10-12 日志中的真实栈（20:29:10.890 与 20:29:53.731 两次完全相同）
const REAL_STACK = [
    'Error: Model not found',
    '    at Te.executor (file:///D:/Users/admin/Desktop/oicpp-plus/node_modules/monaco-editor/min/vs/editor-BdtEMBbM.js:874:8362)',
    '    at get value (file:///D:/Users/admin/Desktop/oicpp-plus/node_modules/monaco-editor/min/vs/editorWorkerHost-B_VpI68A.js:7:108825)',
    '    at f0._acquire (file:///D:/Users/admin/Desktop/oicpp-plus/node_modules/monaco-editor/min/vs/editor-BdtEMBbM.js:874:8020)'
].join('\n');

check('real log stack is suppressed', predicate && predicate('Model not found', REAL_STACK));
check('other messages with the same stack are logged', predicate && !predicate('boom', REAL_STACK));
check('no-message rejections are logged', predicate && !predicate('', REAL_STACK));

// 项目源码路径里同样含 "monaco-editor"，不能被误判成 monaco 内部错误
const OWN_STACK = [
    'Error: Model not found',
    '    at provideDefinition (file:///D:/Users/admin/Desktop/oicpp-plus/src/renderer/js/monaco-editor-manager.js:1742:20)',
    '    at Object.f0._acquire (file:///D:/Users/admin/Desktop/oicpp-plus/src/renderer/js/monaco-editor-manager.js:1711:5)'
].join('\n');
check('project-owned failures still reach the log', predicate && !predicate('Model not found', OWN_STACK));

const OTHER_MONACO_STACK = [
    'Error: Model not found',
    '    at Yz (file:///D:/Users/admin/Desktop/oicpp-plus/node_modules/monaco-editor/min/vs/editor-BdtEMBbM.js:100:20)'
].join('\n');
check('unrelated monaco errors still reach the log', predicate && !predicate('Model not found', OTHER_MONACO_STACK));

// 抑制必须在落日志之前发生，否则仍会产生一条 ERROR 噪音
const handler = /window\.addEventListener\('unhandledrejection',[\s\S]*?\n\}\);/.exec(source);
check('unhandledrejection handler is located', !!handler);
if (handler) {
    const body = handler[0];
    const suppressedAt = body.indexOf('isMonacoModelReferenceRejection(message, stack)');
    const errorAt = body.indexOf("logError('[RendererUnhandledRejection]'");
    check('suppression runs before logError', suppressedAt >= 0 && errorAt >= 0 && suppressedAt < errorAt,
        `suppressedAt=${suppressedAt} errorAt=${errorAt}`);
    check('suppressed path never falls through to logError',
        /isMonacoModelReferenceRejection\(message, stack\)\)\s*\{[\s\S]*?return;[\s\S]*?\}\s*\n\s*const info/.test(body));
}

// 旧谓词匹配的是异步调用者，永远不在栈里，不能再参与判定
check('startFindDefinition is no longer part of the predicate', !source.includes("includes('startFindDefinition')"));

console.log(failures ? `\n${failures} assertion(s) failed` : '\nall assertions passed');
process.exit(failures ? 1 : 0);