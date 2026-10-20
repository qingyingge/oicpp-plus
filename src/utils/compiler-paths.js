'use strict';
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
exports.GCC_PRIVATE_INCLUDE_REGEX = void 0;
exports.filterGccPrivateIncludes = filterGccPrivateIncludes;
/**
 * Shared utilities for compiler include path handling.
 * Used by both main process (queryCompilerInfo) and tests.
 */
const path = __importStar(require("path"));
/**
 * Regex to match GCC private builtin include directories that should be filtered out
 * when feeding include paths to clangd.
 *
 * Matches:
 *   .../lib/gcc/<triple>/<version>/include
 *   .../lib/gcc/<triple>/<version>/include-fixed
 *
 * Does NOT match (preserved for libstdc++):
 *   .../lib/gcc/<triple>/<version>/include/c++
 *   .../lib/gcc/<triple>/<version>/include/c++/<triple>
 *   .../lib/gcc/<triple>/<version>/include/c++/backward
 */
exports.GCC_PRIVATE_INCLUDE_REGEX = /\/lib\/gcc\/[^/]+\/[^/]+\/(include|include-fixed)(?!\/c\+\+)(?:\/|$)/;
/**
 * Filter out GCC private builtin include directories from a list of paths.
 * These contain GCC-specific intrinsics headers (x86intrin.h, ia32intrin.h, etc.)
 * that conflict with clang's own builtins. clang provides its own equivalents
 * via -resource-dir; keeping GCC's private headers only causes false diagnostics.
 *
 * @param includePaths - Array of include paths (can be Windows or POSIX)
 * @returns Filtered paths with GCC private directories removed, normalized to POSIX
 */
function filterGccPrivateIncludes(includePaths) {
    return (includePaths || [])
        .map((p) => path.normalize(p).replace(/\\/g, '/'))
        .filter((p) => !exports.GCC_PRIVATE_INCLUDE_REGEX.test(p));
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        GCC_PRIVATE_INCLUDE_REGEX: exports.GCC_PRIVATE_INCLUDE_REGEX,
        filterGccPrivateIncludes
    };
}
