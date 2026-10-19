'use strict';

// Competitive Companion 空间限制契约回归：
// CC 的 memoryLimit 单位是 MB（TaskBuilder.setMemoryLimit 取整，默认 1024），
// 归一化时只接受 (0, 65536] 的有限数，其余一律丢弃该键，交由渲染端回退全局默认；
// 校验器允许 0 与小数（oj-api --compatibility 明确会产生非整数），拒绝负数与非有限数。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

function sliceBetween(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    if (start < 0 || end < 0) {
        console.log(`[FAIL] main.js section not found: ${startMarker}`);
        process.exit(1);
    }
    return source.slice(start, end);
}

const sections = [
    sliceBetween('function normalizeCompetitiveCompanionPayload(', 'function createCompetitiveCompanionServer('),
    sliceBetween('function validateSampleTesterPayload(', "app.on('before-quit'")
].join('\n');

const context = vm.createContext({ URL, console });
vm.runInContext(`${sections}\nthis.__normalize = normalizeCompetitiveCompanionPayload;\nthis.__validate = validateSampleTesterPayload;`, context);
const normalize = context.__normalize;
const validate = context.__validate;

const basePayload = (overrides = {}) => ({
    name: 'A. Equal Cut',
    group: 'AtCoder Regular Contest 100',
    tests: [{ input: '5\n', output: '2\n' }, { input: '10\n', output: '36\n' }],
    ...overrides
});

// --- 归一化：合法值写入每条样例 ---
const withLimit = normalize(basePayload({ memoryLimit: 256 }));
check('memoryLimit=256 时每条样例都带上 256',
    withLimit.ok === true
    && withLimit.payload.samples.length === 2
    && withLimit.payload.samples.every((s) => s.memoryLimit === 256),
    JSON.stringify(withLimit.ok ? withLimit.payload.samples[0] : withLimit));

check('memoryLimit=31.5 保留为非整数（兼容 oj-api --compatibility）',
    normalize(basePayload({ memoryLimit: 31.5 })).payload.samples[0].memoryLimit === 31.5);

check('memoryLimit=65536 上限接受',
    normalize(basePayload({ memoryLimit: 65536 })).payload.samples[0].memoryLimit === 65536);

// --- 归一化：脏值一律丢弃，退回渲染端默认 ---
const dropped = [
    ['缺省', {}],
    ['null（CC 解析失败序列化）', { memoryLimit: null }],
    ['0（解析失败的 fallback）', { memoryLimit: 0 }],
    ['负数', { memoryLimit: -1 }],
    ['字节量级 268435456', { memoryLimit: 268435456 }],
    ['字符串 "512"', { memoryLimit: '512' }],
    ['NaN', { memoryLimit: NaN }],
    ['Infinity', { memoryLimit: Infinity }]
];
dropped.forEach(([label, overrides]) => {
    const r = normalize(basePayload(overrides));
    check(`memoryLimit ${label} 不写入样例`, r.ok === true && r.payload.samples[0].memoryLimit === undefined,
        `实际 ${r.ok ? r.payload.samples[0].memoryLimit : r.message}`);
});

// --- timeLimit 回归：连带修改不得影响既有时限换算 ---
check('timeLimit=2 仍换算为 2000ms',
    normalize(basePayload({ timeLimit: 2 })).payload.samples[0].timeLimit === 2000);
check('timeLimit=1500 保持 1500ms',
    normalize(basePayload({ timeLimit: 1500 })).payload.samples[0].timeLimit === 1500);
check('timeLimit 与 memoryLimit 共存',
    normalize(basePayload({ timeLimit: 1500, memoryLimit: 256 })).payload.samples[0].timeLimit === 1500
    && normalize(basePayload({ timeLimit: 1500, memoryLimit: 256 })).payload.samples[0].memoryLimit === 256);

// --- 校验器 ---
const validated = (memoryLimit) => validate({
    problemName: 'A. Equal Cut',
    samples: [{ id: 1, input: '5\n', output: '2\n', memoryLimit }]
});

check('校验器接受 0（不限内存）', validated(0).valid === true);
check('校验器接受非整数小数', validated(31.5).valid === true);
check('校验器接受正常 MB 值', validated(256).valid === true);
check('校验器拒绝负数并指向 memoryLimit',
    validated(-1).valid === false && validated(-1).invalidField === 'memoryLimit');
check('校验器拒绝 NaN', validated(NaN).valid === false && validated(NaN).invalidField === 'memoryLimit');
check('校验器拒绝 Infinity', validated(Infinity).valid === false && validated(Infinity).invalidField === 'memoryLimit');
check('校验器拒绝字符串', validated('256').valid === false && validated('256').invalidField === 'memoryLimit');
check('校验器允许缺省 memoryLimit',
    validate({ problemName: 'p', samples: [{ id: 1, input: '', output: '' }] }).valid === true);
check('校验器仍拒绝非正整数 timeLimit',
    validate({ problemName: 'p', samples: [{ id: 1, input: '', output: '', timeLimit: 0 }] }).valid === false);

// --- 渲染端回退契约（源码断言，构造器内回调不便在 vm 中驱动） ---
const testerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'sidebar', 'sampleTester.js'), 'utf8');
check('渲染端优先使用 payload 的 memoryLimit 并回退全局默认',
    /typeof s\.memoryLimit === 'number' && Number\.isFinite\(s\.memoryLimit\) && s\.memoryLimit > 0/.test(testerSource)
    && /:\s*this\.globalSettings\.defaultMemoryLimit,/.test(testerSource));

console.log(failures === 0 ? '\nAll checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);