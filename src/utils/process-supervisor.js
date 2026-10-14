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
exports.terminateProcessTree = terminateProcessTree;
exports.detachedSpawnOptions = detachedSpawnOptions;
exports.getResourceLimitedSpawn = getResourceLimitedSpawn;
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
function terminateProcessTree(child, signal = 'SIGKILL') {
    if (!child || !child.pid)
        return;
    if (process.platform === 'win32') {
        const result = (0, child_process_1.spawnSync)('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
        });
        if (result.status === 0)
            return;
    }
    else {
        try {
            process.kill(-child.pid, signal);
            return;
        }
        catch (_) { }
    }
    try {
        child.kill?.(signal);
    }
    catch (_) { }
}
function detachedSpawnOptions() {
    return process.platform !== 'win32' ? { detached: true } : {};
}
function getResourceLimitedSpawn(executablePath, args = [], memoryLimitMb = 0) {
    const limitMb = Number(memoryLimitMb);
    if (process.platform !== 'linux' || !Number.isFinite(limitMb) || limitMb <= 0) {
        return null;
    }
    const prlimitPath = ['/usr/bin/prlimit', '/bin/prlimit'].find((candidate) => fs.existsSync(candidate));
    if (!prlimitPath)
        return null;
    const limitBytes = Math.max(1, Math.floor(limitMb * 1024 * 1024));
    return {
        command: prlimitPath,
        args: ['--as', String(limitBytes), '--', executablePath, ...args],
        hardMemoryLimit: true,
        limitBytes
    };
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        detachedSpawnOptions,
        getResourceLimitedSpawn,
        terminateProcessTree
    };
}
