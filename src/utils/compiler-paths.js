'use strict';

/**
 * Shared utilities for compiler include path handling.
 * Used by both main process (queryCompilerInfo) and tests.
 */

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
const GCC_PRIVATE_INCLUDE_REGEX = /\/lib\/gcc\/[^/]+\/[^/]+\/(include|include-fixed)(?!\/c\+\+)(?:\/|$)/;

/**
 * Filter out GCC private builtin include directories from a list of paths.
 * These contain GCC-specific intrinsics headers (x86intrin.h, ia32intrin.h, etc.)
 * that conflict with clang's own builtins. clang provides its own equivalents
 * via -resource-dir; keeping GCC's private headers only causes false diagnostics.
 *
 * @param {string[]} includePaths - Array of include paths (can be Windows or POSIX)
 * @returns {string[]} Filtered paths with GCC private directories removed, normalized to POSIX
 */
function filterGccPrivateIncludes(includePaths) {
    return (includePaths || [])
        .map((p) => path.normalize(p).replace(/\\/g, '/'))
        .filter((p) => !GCC_PRIVATE_INCLUDE_REGEX.test(p));
}

const path = require('path');

module.exports = {
    GCC_PRIVATE_INCLUDE_REGEX,
    filterGccPrivateIncludes
};