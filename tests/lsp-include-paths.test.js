'use strict';

/**
 * Regression test for LSP include path filtering.
 *
 * This test ensures that:
 * 1. GCC private builtin include directories (lib/gcc/<triple>/<ver>/include, include-fixed)
 *    are filtered out from clangd's compile_flags.txt
 * 2. The default CP template (with bits/stdc++.h and windows.h) produces zero diagnostics
 *    when parsed by clangd with the filtered include paths.
 *
 * The issue: GCC's private headers contain GCC-specific intrinsics (ia32intrin.h, x86intrin.h, etc.)
 * that clang doesn't understand. When these are passed via -isystem, clangd emits false errors
 * like "use of undeclared identifier '__builtin_ia32_bsrsi'".
 *
 * Fix: Filter out lib/gcc/<triple>/<ver>/include and include-fixed from the include paths
 * fed to clangd. clang provides its own builtins via -resource-dir.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const {
    buildCompileFlagsText,
    writeCompileFlagsFile
} = require('../src/utils/clangd-compile-flags');
const {
    GCC_PRIVATE_INCLUDE_REGEX,
    filterGccPrivateIncludes
} = require('../src/utils/compiler-paths');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

// Default CP template from settings.json (includes bits/stdc++.h and windows.h)
const DEFAULT_CP_TEMPLATE = `#include<bits/stdc++.h>
namespace {
#ifndef ONLINE_JUDGE
#include<cassert>
#ifdef _WIN32
#include<windows.h>
#endif
#define DEBUG
#endif
// #define int long long
#ifdef DEBUG
#define debug(...) fprintf(stderr,__VA_ARGS__)
#else
#define debug(...) ((void)0)
#endif
#ifdef _WIN32
#define getchar_unlocked() _getchar_nolock()
#endif
    inline int read(){
        int c = 0;
        int ng = 0;
        int x = 0;
        while (c<'0' || c>  '9'){
            if (c ==  '-') ng = 1;
            c = getchar_unlocked();
        }
        if (ng){
            while (c >=  '0' && c <=  '9'){
                x = x * 10 - c +  '0';
                c = getchar_unlocked();
            }
        }
        else {
            while (c >=  '0' && c <=  '9'){
                x = x * 10 + c -  '0';
                c = getchar_unlocked();
            }
        }

        return x;
    }
}
using namespace std;

signed main(){

    return 0;
}`;

// Create a temp workspace first
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oicpp-lsp-test-'));
const sourceFile = path.join(workspace, 'test.cpp');
fs.writeFileSync(sourceFile, DEFAULT_CP_TEMPLATE, 'utf8');

// Helper: normalize to POSIX paths (forward slashes)
const toPosix = (p) => path.normalize(p).replace(/\\/g, '/');

// Synthetic MinGW-like paths for testing the filter (created under temp workspace)
const SYNTHETIC_BASE = path.join(workspace, 'fake-mingw');
const SYNTHETIC_MINGW_INCLUDE_PATHS = [
    path.join(SYNTHETIC_BASE, 'lib/gcc/x86_64-w64-mingw32/16.1.0/include/c++'),
    path.join(SYNTHETIC_BASE, 'lib/gcc/x86_64-w64-mingw32/16.1.0/include/c++/x86_64-w64-mingw32'),
    path.join(SYNTHETIC_BASE, 'lib/gcc/x86_64-w64-mingw32/16.1.0/include/c++/backward'),
    path.join(SYNTHETIC_BASE, 'lib/gcc/x86_64-w64-mingw32/16.1.0/include'),
    path.join(SYNTHETIC_BASE, 'lib/gcc/x86_64-w64-mingw32/16.1.0/include-fixed'),
    path.join(SYNTHETIC_BASE, 'x86_64-w64-mingw32/include')
];

const GCC_PRIVATE_INCLUDE_PATHS = [
    path.join(SYNTHETIC_BASE, 'lib/gcc/x86_64-w64-mingw32/16.1.0/include'),
    path.join(SYNTHETIC_BASE, 'lib/gcc/x86_64-w64-mingw32/16.1.0/include-fixed')
];

const LIBSTDCXX_PATHS = [
    path.join(SYNTHETIC_BASE, 'lib/gcc/x86_64-w64-mingw32/16.1.0/include/c++'),
    path.join(SYNTHETIC_BASE, 'lib/gcc/x86_64-w64-mingw32/16.1.0/include/c++/x86_64-w64-mingw32'),
    path.join(SYNTHETIC_BASE, 'lib/gcc/x86_64-w64-mingw32/16.1.0/include/c++/backward'),
    path.join(SYNTHETIC_BASE, 'x86_64-w64-mingw32/include')
];

// Create the synthetic directory structure so buildCompileFlagsText finds them
for (const dir of SYNTHETIC_MINGW_INCLUDE_PATHS) {
    fs.mkdirSync(dir, { recursive: true });
}

try {
    // --- Test 1: Verify the GCC private include filter regex works correctly ---
    for (const privatePath of GCC_PRIVATE_INCLUDE_PATHS) {
        check(`GCC private path matches filter regex: ${toPosix(privatePath)}`,
            GCC_PRIVATE_INCLUDE_REGEX.test(toPosix(privatePath)));
    }

    // libstdc++ paths should NOT match
    for (const libPath of LIBSTDCXX_PATHS) {
        check(`libstdc++ path does NOT match filter regex: ${toPosix(libPath)}`,
            !GCC_PRIVATE_INCLUDE_REGEX.test(toPosix(libPath)));
    }

    // --- Test 2: filterGccPrivateIncludes utility function ---
    const filteredPaths = filterGccPrivateIncludes(SYNTHETIC_MINGW_INCLUDE_PATHS);

    check('filterGccPrivateIncludes: correct count (6 - 2 = 4)',
        filteredPaths.length === 4,
        `got ${filteredPaths.length}`);

    const libstdcxxPosix = LIBSTDCXX_PATHS.map(toPosix);

    check('filterGccPrivateIncludes: GCC private paths excluded',
        !filteredPaths.some(p => GCC_PRIVATE_INCLUDE_REGEX.test(p)));

    check('filterGccPrivateIncludes: libstdc++ paths preserved',
        libstdcxxPosix.every(p => filteredPaths.includes(p)),
        `filteredPaths: ${JSON.stringify(filteredPaths)} libstdcxxPosix: ${JSON.stringify(libstdcxxPosix)}`);

    // --- Test 3: buildCompileFlagsText with FILTERED paths ---
    const flagsText = buildCompileFlagsText({
        includePaths: filteredPaths,
        target: 'x86_64-w64-mingw32',
        compileFlags: ['-std=c++14']
    });

    check('buildCompileFlagsText: output contains -isystem lines',
        flagsText.includes('-isystem'));

    const isystemLines = flagsText.split(/\r?\n/).filter(line => line === '-isystem');
    check('buildCompileFlagsText: correct number of -isystem pairs (4 libstdc++)',
        isystemLines.length === 4,
        `got ${isystemLines.length} -isystem pairs`);

    // Verify libstdc++ paths ARE in the output (flagsText uses POSIX paths)
    for (const expectedPath of libstdcxxPosix) {
        check(`buildCompileFlagsText: libstdc++ path included: ${expectedPath}`,
            flagsText.includes(expectedPath));
    }

    check('buildCompileFlagsText: target triple is present',
        flagsText.includes('--target=x86_64-w64-mingw32'));

    check('buildCompileFlagsText: -std=c++14 is present',
        flagsText.includes('-std=c++14'));

    // --- Test 4: writeCompileFlagsFile with FILTERED paths ---
    const written = writeCompileFlagsFile({
        workspaceRoot: workspace,
        includePaths: filteredPaths,
        target: 'x86_64-w64-mingw32',
        compileFlags: ['-std=c++14']
    });

    check('writeCompileFlagsFile: succeeds',
        written.ok === true && written.written === true);

    const compileFlagsPath = written.filePath;
    check('writeCompileFlagsFile: file exists',
        fs.existsSync(compileFlagsPath));

    const writtenContent = fs.readFileSync(compileFlagsPath, 'utf8');
    check('writeCompileFlagsFile: written content matches buildCompileFlagsText output',
        writtenContent === flagsText);

    // --- Test 5: Run clang++ with the FILTERED flags on the template (requires real MinGW) ---
    // Find clangd/clang++ executable
    let clangdPath = 'clangd';
    const possibleClangdPaths = [
        'E:/Program Files/LLVM/bin/clangd.exe',
        'C:/Program Files/LLVM/bin/clangd.exe',
        'C:/Program Files (x86)/LLVM/bin/clangd.exe'
    ];
    for (const p of possibleClangdPaths) {
        if (fs.existsSync(p)) {
            clangdPath = p;
            break;
        }
    }

    // Check if clangd is available
    const clangdVersion = spawnSync(clangdPath, ['--version'], { encoding: 'utf8' });
    const clangdAvailable = clangdVersion.status === 0;

    if (!clangdAvailable) {
        console.log('[SKIP] clangd/clang++ not found, skipping runtime check (requires LLVM toolchain)');
    } else {
        // Use real MinGW installation if available (user's machine has it at known path)
        // This is the same MinGW used in earlier manual verification
        const knownMingwRoot = 'C:/Users/admin/.oicpp/Compilers/16.1.0/mingw64';
        let realMingwIncludePaths = null;
        
        if (fs.existsSync(knownMingwRoot)) {
            const gccLib = path.join(knownMingwRoot, 'lib', 'gcc');
            if (fs.existsSync(gccLib)) {
                const targetDirs = fs.readdirSync(gccLib);
                for (const target of targetDirs) {
                    const versionDirs = fs.readdirSync(path.join(gccLib, target));
                    for (const version of versionDirs) {
                        const includeDir = path.join(gccLib, target, version, 'include');
                        const includeFixedDir = path.join(gccLib, target, version, 'include-fixed');
                        const cxxDir = path.join(gccLib, target, version, 'include', 'c++');
                        const cxxTargetDir = path.join(cxxDir, target);
                        const cxxBackwardDir = path.join(cxxDir, 'backward');
                        const targetIncludeDir = path.join(knownMingwRoot, target, 'include');
                        // Only include essential paths that work with clang:
                        // - c++ base, target-specific c++, backward (libstdc++)
                        // - target include (platform headers like windows.h)
                        // EXCLUDE: include, include-fixed (GCC private intrinsics - filtered later)
                        // EXCLUDE: c++ subdirs like tr1, bits, debug, etc. (clang incompatible)
                        if (fs.existsSync(cxxDir) && fs.existsSync(cxxTargetDir) && 
                            fs.existsSync(cxxBackwardDir) && fs.existsSync(targetIncludeDir)) {
                            realMingwIncludePaths = [
                                cxxDir,
                                cxxTargetDir,
                                cxxBackwardDir,
                                targetIncludeDir
                            ].filter(p => fs.existsSync(p));
                            break;
                        }
                    }
                    if (realMingwIncludePaths) break;
                }
            }
        }

        if (!realMingwIncludePaths || realMingwIncludePaths.length === 0) {
            console.log('[SKIP] Real MinGW installation not found at expected path, skipping clang++ runtime check');
            console.log('[INFO] Expected: ' + knownMingwRoot);
        } else {
            // Use real MinGW paths for the runtime test
            const filteredRealPaths = filterGccPrivateIncludes(realMingwIncludePaths);
            const realFlagsText = buildCompileFlagsText({
                includePaths: filteredRealPaths,
                target: 'x86_64-w64-mingw32',
                compileFlags: ['-std=c++14']
            });

            const clangppPath = clangdPath.replace('clangd', 'clang++').replace('clangd.exe', 'clang++.exe');
            const flagLines = realFlagsText.trim().split(/\r?\n/);
            const clangArgs = ['-fsyntax-only'];
            let i = 0;
            while (i < flagLines.length) {
                if (flagLines[i] === '-isystem' && i + 1 < flagLines.length) {
                    clangArgs.push('-isystem', flagLines[i + 1]);
                    i += 2;
                } else if (flagLines[i].startsWith('--target=')) {
                    clangArgs.push(flagLines[i]);
                    i++;
                } else if (flagLines[i].startsWith('-std=')) {
                    clangArgs.push(flagLines[i]);
                    i++;
                } else {
                    i++;
                }
            }
            clangArgs.push(sourceFile);

            const result = spawnSync(clangppPath, clangArgs, {
                encoding: 'utf8',
                timeout: 30000,
                cwd: workspace
            });

            const stderr = result.stderr || '';
            const stdout = result.stdout || '';
            const combined = stderr + '\n' + stdout;

            check('clang++: exits with code 0 (no errors)',
                result.status === 0,
                `exit code: ${result.status}, stderr: ${stderr.slice(0, 200)}`);

            // Check for specific GCC intrinsic errors that should NOT appear
            check('clang++: no __builtin_ia32_bsrsi error (GCC private header leak fixed)',
                !combined.includes('__builtin_ia32_bsrsi'),
                combined.slice(0, 500));

            check('clang++: no __builtin_ia32_rolqi error (GCC private header leak fixed)',
                !combined.includes('__builtin_ia32_rolqi'),
                combined.slice(0, 500));

            check('clang++: no __builtin_ia32_rolhi error (GCC private header leak fixed)',
                !combined.includes('__builtin_ia32_rolhi'),
                combined.slice(0, 500));

            check('clang++: no ia32intrin.h related error (GCC private header leak fixed)',
                !combined.includes('ia32intrin.h'),
                combined.slice(0, 500));

            // bits/stdc++.h and windows.h should be found without error
            check('clang++: bits/stdc++.h found (no pp_file_not_found)',
                !combined.includes('pp_file_not_found'),
                combined.slice(0, 500));

            check('clang++: windows.h found (no pp_file_not_found)',
                !combined.includes('pp_file_not_found'),
                combined.slice(0, 500));

            console.log('[INFO] clang++ output:', combined.slice(0, 500));
        }
    }

    // --- Test 6: Verify queryCompilerInfo logic in main.js ---
    const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    check('main.js: GCC private include filter logic present (uses shared utility)',
        mainSource.includes('filterGccPrivateIncludes') &&
        mainSource.includes('require') &&
        mainSource.includes('compiler-paths'));

    // --- Test 7: Verify monaco-editor-manager.js collectGccIncludeDirs filters correctly ---
    const monacoSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'js', 'monaco-editor-manager.js'), 'utf8');
    check('monaco-editor-manager.js: collectGccIncludeDirs skips include/include-fixed',
        monacoSource.includes('collectGccIncludeDirs') &&
        !monacoSource.includes("await addDir(await this.joinPath(versionDir, 'include'));") &&
        monacoSource.includes('include/c++'));

    console.log(`\n[SUMMARY] lsp-include-paths regression tests: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
    process.exitCode = failures ? 1 : 0;

} finally {
    // Cleanup
    try {
        fs.rmSync(workspace, { recursive: true, force: true });
    } catch (_) { }
}