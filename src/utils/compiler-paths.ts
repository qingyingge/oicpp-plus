'use strict';

/**
 * Shared utilities for compiler include path handling.
 * Used by both main process (queryCompilerInfo) and tests.
 */

import * as path from 'path';

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
export const GCC_PRIVATE_INCLUDE_REGEX = /\/lib\/gcc\/[^/]+\/[^/]+\/(include|include-fixed)(?!\/c\+\+)(?:\/|$)/;

/**
 * Filter out GCC private builtin include directories from a list of paths.
 * These contain GCC-specific intrinsics headers (x86intrin.h, ia32intrin.h, etc.)
 * that conflict with clang's own builtins. clang provides its own equivalents
 * via -resource-dir; keeping GCC's private headers only causes false diagnostics.
 *
 * @param includePaths - Array of include paths (can be Windows or POSIX)
 * @returns Filtered paths with GCC private directories removed, normalized to POSIX
 */
export function filterGccPrivateIncludes(includePaths?: string[] | null): string[] {
    return (includePaths || [])
        .map((p) => path.normalize(p).replace(/\\/g, '/'))
        .filter((p) => !GCC_PRIVATE_INCLUDE_REGEX.test(p));
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        GCC_PRIVATE_INCLUDE_REGEX,
        filterGccPrivateIncludes
    };
}
