'use strict';

const GDBDebugger = require('../src/gdb-debugger');
const { decodeGdbString, parseMiRecord } = require('../src/gdb-mi');
const { parseGDBWatchValue } = require('../src/gdb-utils');

// 挂死不等于通过：await 一个永不 settle 的 promise 时，Node 带着 0 退出码排空
// event loop，runner 只看 status 和 [FAIL] 行数 —— 后半截断言一条不发也算过。
// 这些文件收尾写 process.exitCode 而不是 process.exit，所以定时器必须具名，
// 并在每个收尾点显式 clearTimeout，否则正常跑完会被它多留 60s 再判红。
const watchdog = setTimeout(() => {
    console.log('[FAIL] 主流程没有跑到结尾：某个 await 永不 settle（异步守卫没被驱动完）');
    process.exit(1);
}, 60000);

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

(async () => {
    const result = parseMiRecord('7^done,bkpt={number="2",file="main.cpp",line="12",pending="0"}');
    check('MI result records expose token and nested fields', result.token === '7' && result.status === 'done' && result.fields.bkpt.number === '2');
    const stopped = parseMiRecord('*stopped,reason="breakpoint-hit",frame={addr="0x1",func="main",file="main.cpp",line="9"}');
    check('MI stopped records are parsed structurally', stopped.name === 'stopped' && stopped.fields.frame.func === 'main');
    check('MI strings decode GDB escapes', decodeGdbString('"line\\n\\x41"') === 'line\nA');
    const malformedWatch = { name: 'x', value: '', children: [] };
    const malformedStarted = Date.now();
    parseGDBWatchValue(malformedWatch, '{, a = hello b = 5}');
    check('malformed watch values cannot loop indefinitely', Date.now() - malformedStarted < 1000);

    const debuggerInstance = new GDBDebugger();
    check('GDB debugger uses the MI2 protocol', debuggerInstance.protocol === 'mi2');
    debuggerInstance._breakpoints.push({ number: 1, file: '/tmp/main.cpp', line: 3 });
    const snapshot = debuggerInstance.getBreakpoints();
    snapshot[0].line = 99;
    check('GDB exposes an isolated breakpoint snapshot', debuggerInstance.getBreakpoints()[0].line === 3);

    const writes = [];
    const fakeProcess = {
        pid: 1234,
        exitCode: null,
        signalCode: null,
        stdin: { write(line) { writes.push(line); } }
    };
    debuggerInstance.gdbProcess = fakeProcess;
    debuggerInstance._nextMiToken = 7;
    const request = debuggerInstance._miRequest('-gdb-set confirm off', { timeoutMs: 100 });
    check('MI requests use numeric tokens', writes[0]?.trim() === '7-gdb-set confirm off');
    debuggerInstance._handleMiRecord({ type: 'result', token: '7', status: 'done', fields: { ok: true } });
    const requestResult = await request;
    check('MI result records resolve requests', requestResult.ok === true);

    const timeoutDebugger = new GDBDebugger();
    timeoutDebugger.gdbProcess = {
        pid: 4321,
        exitCode: null,
        signalCode: null,
        stdin: { write() {} }
    };
    let timeoutError = null;
    try {
        await timeoutDebugger._miRequest('-gdb-set width 0', { timeoutMs: 10 });
    } catch (error) {
        timeoutError = error;
    }
    check('MI requests have a bounded response timeout', /timed out/i.test(timeoutError?.message || ''));

    let stoppedEvent = null;
    debuggerInstance.once('stopped', (event) => { stoppedEvent = event; });
    debuggerInstance._handleMiRecord({
        type: 'exec',
        name: 'stopped',
        fields: {
            reason: 'breakpoint-hit',
            frame: { addr: '0xabc', func: 'main', file: 'main.cpp', line: '9' }
        }
    });
    check('MI stop events preserve frame data', stoppedEvent?.frame?.function === 'main' && stoppedEvent?.line === 9);

    console.log(`gdb-debugger tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
    clearTimeout(watchdog);
    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.error(`[FAIL] gdb-debugger unexpected error | ${error?.stack || error}`);
    clearTimeout(watchdog);
    process.exitCode = 1;
});
