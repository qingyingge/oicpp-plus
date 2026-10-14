import GDBDebugger = require('./gdb-mi-debugger');
export { GDBDebugger };
export type { MiValue, MiRecord } from './gdb-mi';

if (typeof module !== 'undefined' && module.exports) {
    module.exports = require('./gdb-mi-debugger');
}