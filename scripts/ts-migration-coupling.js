#!/usr/bin/env node
'use strict';
/*
 * Extracts the real coupling surface between tests and src, then merges it into
 * docs/ts-migration-baseline.js (produced by scripts/ts-migration-baseline.ps1).
 *
 * Why this exists
 * ---------------
 * docs/TS_MIGRATION_PLAN.md treats "a test file reads source file X" as the unit
 * of coupling. That is far too coarse: measured on this tree, adding JSDoc or a
 * plain statement to a file breaks ZERO assertions. Only editing the exact
 * asserted literal breaks one. See the empirical table in the plan.
 *
 * So the actionable constraint is not "these files are serialised" but
 * "these specific strings are load-bearing". This script enumerates them.
 *
 * Usage:  node scripts/ts-migration-coupling.js
 *         (run scripts/ts-migration-baseline.ps1 first)
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const testsDir = path.join(root, 'tests');
const baselinePath = path.join(root, 'docs', 'ts-migration-baseline.js');

if (!fs.existsSync(baselinePath)) {
    console.error('docs/ts-migration-baseline.js not found -- run scripts/ts-migration-baseline.ps1 first');
    process.exit(1);
}

const testFiles = fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.js')).sort();

/** file -> { literals: [{test,lit}], structural: [{test,kind,detail}] } */
const coupling = new Map();

function slot(file) {
    if (!coupling.has(file)) coupling.set(file, { literals: [], structural: [] });
    return coupling.get(file);
}
function pushUnique(arr, obj) {
    if (!arr.some((x) => JSON.stringify(x) === JSON.stringify(obj))) arr.push(obj);
}

for (const name of testFiles) {
    const testId = name.replace('.test.js', '');
    const lines = fs.readFileSync(path.join(testsDir, name), 'utf8').split(/\r?\n/);

    // ---- which local variable holds which source file -----------------------
    const var2file = new Map();
    for (const line of lines) {
        const decl = line.match(/(?:const|let)\s+(\w+)\s*=/);
        if (!decl) continue;
        const v = decl[1];
        for (const m of line.matchAll(/read\(\s*'([^']+)'\s*\)/g)) {
            if (!var2file.has(v)) var2file.set(v, []);
            var2file.get(v).push(m[1]);
        }
    }
    const filesOf = (v) => (var2file.has(v) ? var2file.get(v) : []);

    // ---- var derived from another var's content (method body extraction) ----
    // e.g.  const method = /async foo\(\)\s*\{([\s\S]*?)\n    \}/.exec(compileManagerSource)
    for (const line of lines) {
        const d = line.match(/(?:const|let)\s+(\w+)\s*=\s*\/.*\/[gimsuy]*\.exec\(\s*(\w+)\s*\)/);
        if (!d) continue;
        for (const f of filesOf(d[2])) {
            if (!f.startsWith('src/')) continue;
            pushUnique(slot(f).structural, {
                test: testId,
                kind: 'method-body-regex',
                detail: `${d[1]} extracted from ${d[2]} by a hand-written regex`,
            });
        }
    }

    // ---- assertion lines ---------------------------------------------------
    for (const line of lines) {
        const isAssertion = /\bcheck\(|\bassert/.test(line);
        if (!isAssertion) continue;

        // <var>.includes('<literal>')
        for (const m of line.matchAll(/(\w+)\.includes\(\s*(['"`])([^'"`]{3,160})\2/g)) {
            for (const f of filesOf(m[1])) {
                if (f.startsWith('src/')) pushUnique(slot(f).literals, { test: testId, lit: m[3] });
            }
        }
        // read('<path>').includes('<literal>')
        for (const m of line.matchAll(/read\(\s*'([^']+)'\s*\)\.includes\(\s*(['"`])([^'"`]{3,160})\2/g)) {
            if (m[1].startsWith('src/')) pushUnique(slot(m[1]).literals, { test: testId, lit: m[3] });
        }
        // (X.match(/re/g) || []).length >= N      occurrence-count assertion
        for (const m of line.matchAll(/\(\s*(\w+)\.match\(\s*\/(.+?)\/g\s*\)\s*\|\|\s*\[\]\s*\)\.length\s*(>=|==)\s*(\d+)/g)) {
            for (const f of filesOf(m[1])) {
                if (!f.startsWith('src/')) continue;
                pushUnique(slot(f).structural, {
                    test: testId,
                    kind: 'occurrence-count',
                    detail: `count of /${m[2]}/g ${m[3]} ${m[4]}`,
                });
            }
        }
    }

    // ---- eval-based extraction anywhere in the file ------------------------
    if (/\beval\s*\(|new Function/.test(lines.join('\n'))) {
        for (const v of var2file.keys()) {
            for (const f of filesOf(v)) {
                if (f.startsWith('src/')) {
                    pushUnique(slot(f).structural, {
                        test: testId,
                        kind: 'eval',
                        detail: 'test evaluates extracted source text',
                    });
                }
            }
        }
    }
}

// ---- merge into the baseline payload --------------------------------------
const raw = fs.readFileSync(baselinePath, 'utf8');
const m = raw.match(/window\.TS_BASELINE\s*=\s*([\s\S]*?);\s*$/);
if (!m) { console.error('cannot parse docs/ts-migration-baseline.js'); process.exit(1); }

const payload = JSON.parse(m[1]);
payload.coupling = {};
let nLit = 0;
let nStr = 0;
let nFiles = 0;
for (const [file, v] of coupling) {
    payload.coupling[file] = v;
    nLit += v.literals.length;
    nStr += v.structural.length;
    if (v.literals.length || v.structural.length) nFiles++;
}

fs.writeFileSync(
    baselinePath,
    'window.TS_BASELINE = ' + JSON.stringify(payload) + ';\n',
    'utf8'
);

const short = (f) => f
    .replace('src/renderer/js/sidebar/', 'sb/')
    .replace('src/renderer/js/settings/', 'js/')
    .replace('src/renderer/settings/', 'set/')
    .replace('src/renderer/js/', 'js/')
    .replace('src/main-process/', 'mp/')
    .replace('src/utils/', 'u/')
    .replace('src/renderer/', 'r/')
    .replace('src/', '');

const rows = [...coupling.entries()]
    .filter(([, v]) => v.literals.length || v.structural.length)
    .sort((a, b) => (b[1].literals.length + b[1].structural.length) - (a[1].literals.length + a[1].structural.length));

console.log(`coupling merged into docs/ts-migration-baseline.js`);
console.log(`  src files with load-bearing assertions : ${nFiles} / ${payload.files.length}`);
console.log(`  exact literals asserted               : ${nLit}`);
console.log(`  structural assertions                  : ${nStr}`);
console.log('');
for (const [f, v] of rows) {
    console.log(
        `  ${String(v.literals.length).padStart(2)} lit / ${String(v.structural.length).padStart(2)} str  ${short(f)}` +
        (v.structural.length ? '   <-- breaks on structural edits too' : '')
    );
}
console.log('');
console.log('The remaining files have no load-bearing assertion: annotation-only work there cannot break a test.');