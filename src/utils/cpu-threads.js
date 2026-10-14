"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_CPU_THREADS = void 0;
exports.getCpuThreads = getCpuThreads;
exports.scheduleCpuThreadsWarmUp = scheduleCpuThreadsWarmUp;
exports.resetCpuThreadsCache = resetCpuThreadsCache;
exports.detectCpuThreads = detectCpuThreads;
const os = __importStar(require("os"));
const DEFAULT_CPU_THREADS = 2;
exports.DEFAULT_CPU_THREADS = DEFAULT_CPU_THREADS;
const WARM_UP_DELAY_MS = 2000;
let cachedCpuThreads = null;
function detectCpuThreads() {
    try {
        const cpus = os.cpus();
        const count = Array.isArray(cpus) && cpus.length > 0 ? cpus.length : DEFAULT_CPU_THREADS;
        return Math.max(1, count);
    }
    catch (_) {
        return DEFAULT_CPU_THREADS;
    }
}
function getCpuThreads() {
    if (cachedCpuThreads === null) {
        cachedCpuThreads = detectCpuThreads();
    }
    return cachedCpuThreads;
}
function scheduleCpuThreadsWarmUp(delayMs = WARM_UP_DELAY_MS) {
    if (cachedCpuThreads !== null)
        return undefined;
    const timer = setTimeout(() => {
        try {
            getCpuThreads();
        }
        catch (_) { }
    }, delayMs);
    if (timer && typeof timer.unref === 'function')
        timer.unref();
    return timer;
}
function resetCpuThreadsCache() {
    cachedCpuThreads = null;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        DEFAULT_CPU_THREADS,
        detectCpuThreads,
        getCpuThreads,
        scheduleCpuThreadsWarmUp,
        resetCpuThreadsCache
    };
}
