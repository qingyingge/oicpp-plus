"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GDBDebugger = void 0;
const GDBDebugger = require("./gdb-mi-debugger");
exports.GDBDebugger = GDBDebugger;
if (typeof module !== 'undefined' && module.exports) {
    module.exports = require('./gdb-mi-debugger');
}
