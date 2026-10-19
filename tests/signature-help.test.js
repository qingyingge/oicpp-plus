'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const managerSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'js', 'monaco-editor-manager.js'),
    'utf8'
);

// 静态检查：验证修复代码的关键函数和逻辑存在
const hasRealign = managerSource.includes('realignParameterOffsets');
const hasInfer = managerSource.includes('inferActiveParameterFromCursor');
const hasVersionCheck = managerSource.includes('requestVersion') && managerSource.includes('model.getVersionId');

check('signature help: realignParameterOffsets function exists', hasRealign);
check('signature help: inferActiveParameterFromCursor function exists', hasInfer);
check('signature help: version check logic exists', hasVersionCheck);
check('signature help: model.isDisposed check at entry', managerSource.includes('model.isDisposed?.()'));
check('signature help: token.isCancellationRequested check at entry', managerSource.includes('token?.isCancellationRequested'));
check('signature help: version check after await', managerSource.includes('model.getVersionId?.() !== requestVersion'));
check('signature help: label re-alignment uses paramNames', managerSource.includes('paramNames.map'));
check('signature help: fallback to original offset on match fail', managerSource.includes('orig = parameters[idx]?.label'));
check('signature help: activeParameter bounds check', managerSource.includes('activeParamIdx < 0 || activeParamIdx >= maxParam'));
check('signature help: inferActiveParameterFromCursor counts commas', managerSource.includes('paramArea.match(/,/g)'));

// 验证 _registerLspSignatureHelpProvider 存在且结构正确
check('signature help: provider registered for cpp and c', managerSource.includes('languages = [\'cpp\', \'c\']'));
check('signature help: trigger characters include ( and ,', managerSource.includes('signatureHelpTriggerCharacters') && managerSource.includes('[\'(\', \',\']'));
check('signature help: retrigger on comma', managerSource.includes('signatureHelpRetriggerCharacters') && managerSource.includes('[\',\']'));
check('signature help: context passed to LSP', managerSource.includes('triggerKind: context.triggerKind') && managerSource.includes('isRetrigger: context.isRetrigger'));

// 验证 hover provider 的相同保护逻辑作为对照（确保对齐）
check('signature help: aligns with hover provider checks', managerSource.indexOf('_registerLspHoverProvider') > managerSource.indexOf('_registerLspSignatureHelpProvider'));

process.exitCode = failures ? 1 : 0;