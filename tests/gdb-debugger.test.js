'use strict';

const GDBDebugger = require('../src/gdb-debugger');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

(async () => {
    const debuggerInstance = new GDBDebugger();
    debuggerInstance._breakpoints.push({ number: 1, file: '/tmp/main.cpp', line: 3 });
    const snapshot = debuggerInstance.getBreakpoints();
    snapshot[0].line = 99;
    check('GDB exposes an isolated breakpoint snapshot', debuggerInstance.getBreakpoints()[0].line === 3);

    const fakeProcess = {
        killed: false,
        exitCode: null,
        signalCode: null,
        stdin: { write() {} }
    };
    debuggerInstance.gdbProcess = fakeProcess;
    debuggerInstance._programStopped = true;
    let timeoutError = null;
    try {
        await debuggerInstance._send('show version', { timeoutMs: 10 });
    } catch (error) {
        timeoutError = error;
    }
    check('GDB commands have a bounded response timeout', /timed out/i.test(timeoutError?.message || ''));

    console.log(`gdb-debugger tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
    process.exitCode = failures ? 1 : 0;
})().catch((error) => {
    console.error(`[FAIL] gdb-debugger unexpected error | ${error?.stack || error}`);
    process.exitCode = 1;
});
