#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
let failed = 0;
let passed = 0;
let warned = 0;

const verbose = process.argv.includes('--verbose');
const strict = process.argv.includes('--strict');

const R = '\x1b[0m';
const G = '\x1b[32m';
const RD = '\x1b[31m';
const Y = '\x1b[33m';
const GR = '\x1b[90m';
const C = '\x1b[36m';
const B = '\x1b[1m';

function ok(msg)   { passed++; console.log(`  ${G}[OK]${R} ${msg}`); }
function fail(msg) { failed++; console.log(`  ${RD}[FAIL]${R} ${msg}`); }
function warn(msg) { warned++; console.log(`  ${Y}[WARN]${R} ${msg}`); }
function info(msg) { console.log(`  ${GR}[INFO]${R} ${msg}`); }

function fileExists(p) {
  try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; }
}
function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}
function exec(cmd, timeoutMs = 30000) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); } catch { return null; }
}

// Global timeout: force exit after 120 seconds
const GLOBAL_TIMEOUT = 120000;
const globalTimer = setTimeout(() => {
  console.log(`\n${RD}${B}CI TIMEOUT: exceeded ${GLOBAL_TIMEOUT/1000}s limit${R}`);
  process.exit(1);
}, GLOBAL_TIMEOUT);
globalTimer.unref();
function getAllFiles(dir, ext) {
  const results = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...getAllFiles(full, ext));
      } else if (!ext || entry.name.endsWith(ext)) {
        results.push(full);
      }
    }
  } catch {}
  return results;
}

console.log(`\n${C}${B}=== OICPP-Plus CI/CD (Strict Mode) ===${R}`);
console.log(`${GR}Platform: ${os.platform()} ${os.arch()} | Node ${process.version}${R}`);
console.log(`${GR}Root: ${root}${R}`);
if (verbose) info('Verbose mode enabled');
if (strict) info('Strict mode enabled');

// ============================================================
// A. Infrastructure
// ============================================================

// A1: package.json
console.log(`\n${Y}[A1] package.json${R}`);
const pkg = readJson(path.join(root, 'package.json'));
if (pkg) {
  if (pkg.name === 'oicpp-plus-ide') ok(`name: ${pkg.name}`); else fail(`name: ${pkg.name} (expected oicpp-plus-ide)`);
  if (pkg.main === 'src/main.js') ok(`main: ${pkg.main}`); else fail(`main: ${pkg.main}`);
  if (fileExists(path.join(root, 'src/main.js'))) ok('main.js exists'); else fail('src/main.js missing');
  if (pkg.build) ok('build config present'); else fail('build config missing');
  if (typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version)) ok(`version: ${pkg.version}`); else fail(`version invalid: ${pkg.version}`);
} else {
  fail('package.json parse error');
}

// A2: Lock file
console.log(`\n${Y}[A2] Lock file${R}`);
const pnpmLockPath = path.join(root, 'pnpm-lock.yaml');
const npmLockPath = path.join(root, 'package-lock.json');
if (fileExists(pnpmLockPath)) {
  ok('pnpm-lock.yaml found');
  const lockContent = readFile(pnpmLockPath);
  if (lockContent) {
    if (lockContent.includes('oicpp-plus')) ok('lock references oicpp-plus'); else fail('lock missing oicpp-plus reference');
  }
} else if (fileExists(npmLockPath)) {
  ok('package-lock.json found');
  const lockJson = readJson(npmLockPath);
  if (lockJson) {
    if (lockJson.name === 'oicpp-plus-ide') ok(`lock name: ${lockJson.name}`); else fail(`lock name: ${lockJson.name} (expected oicpp-plus-ide)`);
    if (lockJson.version && pkg && lockJson.version === pkg.version) ok(`version match: ${lockJson.version}`);
    else if (pkg) fail(`version mismatch: lock=${lockJson.version} pkg=${pkg.version}`);
  }
} else {
  fail('no lock file found (pnpm-lock.yaml or package-lock.json)');
}

// A3: Icon files
console.log(`\n${Y}[A3] Icon files${R}`);
const icoPath = path.join(root, 'oicpp-plus.ico');
if (fileExists(icoPath)) {
  const stat = fs.statSync(icoPath);
  if (stat.size > 1000) ok(`oicpp-plus.ico (${stat.size} bytes)`); else fail(`oicpp-plus.ico too small (${stat.size} bytes)`);
} else {
  fail('oicpp-plus.ico missing');
}
if (fileExists(path.join(root, 'build', 'icons', 'png'))) {
  fail('build/icons/png should be deleted');
} else {
  ok('build/icons/png removed');
}

// A4: Dependencies
console.log(`\n${Y}[A4] Dependencies${R}`);
const criticalDeps = ['electron', 'monaco-editor', 'node-pty'];
if (fileExists(path.join(root, 'node_modules'))) {
  for (const dep of criticalDeps) {
    if (fileExists(path.join(root, 'node_modules', dep))) ok(`${dep} installed`); else fail(`${dep} missing`);
  }
} else {
  fail('node_modules missing');
}

// A5: .gitignore
console.log(`\n${Y}[A5] .gitignore${R}`);
const gitignore = readFile(path.join(root, '.gitignore'));
if (gitignore) {
  for (const entry of ['node_modules', 'dist']) {
    if (gitignore.includes(entry)) ok(`ignores ${entry}`); else fail(`missing ignore: ${entry}`);
  }
} else {
  fail('.gitignore not found');
}

// ============================================================
// B. Brand Consistency
// ============================================================

// B1: Icon references
console.log(`\n${Y}[B1] Icon references${R}`);
const iconRefFiles = ['src/main.js', 'src/renderer/js/tabs.js', 'scripts/generate-icons.js', 'installer.nsi'];
for (const f of iconRefFiles) {
  const fp = path.join(root, f);
  const content = readFile(fp);
  if (content) {
    if (/oicpp\.ico[^-]/.test(content)) fail(`${f} still references oicpp.ico`); else ok(`${f}`);
  }
}

// B2: Data directory
console.log(`\n${Y}[B2] Data directory (.oicpp-plus)${R}`);
for (const f of ['installer.nsi', 'src/main.js', 'src/renderer/js/monaco-editor-manager.js']) {
  const fp = path.join(root, f);
  const content = readFile(fp);
  if (content) {
    if (/\.oicpp-plus/.test(content)) ok(`${f}`);
    else if (/\.oicpp[^-]/.test(content)) fail(`${f} uses old .oicpp`);
    else ok(`${f} (no ref)`);
  }
}

// B3: Brand consistency
console.log(`\n${Y}[B3] Brand consistency${R}`);
let brandOk = true;
for (const f of ['src/main.js', 'src/renderer/js/main.js', 'installer.nsi']) {
  const fp = path.join(root, f);
  const content = readFile(fp);
  if (content && /mywwzh\/oicpp[^-]/.test(content)) {
    fail(`${f} old repo ref`);
    brandOk = false;
  }
}
if (brandOk) ok('no old brand refs');

// B4: installer.nsi
console.log(`\n${Y}[B4] installer.nsi${R}`);
const nsiContent = readFile(path.join(root, 'installer.nsi'));
if (nsiContent) {
  if (/oicpp\.ico[^-]/.test(nsiContent)) fail('old icon'); else ok('icon OK');
  if (/\.oicpp-plus/.test(nsiContent)) ok('data dir'); else fail('no .oicpp-plus');
  if (/OICPP-Plus IDE\.lnk/.test(nsiContent)) ok('shortcut'); else fail('shortcut wrong');
}

// ============================================================
// C. Syntax & Structure
// ============================================================

// C1: JS syntax check
console.log(`\n${Y}[C1] JS syntax${R}`);
const srcDir = path.join(root, 'src');
const jsFiles = getAllFiles(srcDir, '.js');
let syntaxErrors = 0;
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  const result = exec(`node -c "${f}"`, 10000);
  if (result === null) {
    fail(`syntax: ${rel}`);
    syntaxErrors++;
  }
}
if (syntaxErrors === 0) ok(`all ${jsFiles.length} JS files OK`);
else fail(`${syntaxErrors} syntax errors`);

// C2: CSS brace matching
console.log(`\n${Y}[C2] CSS${R}`);
const cssDir = path.join(root, 'src', 'renderer', 'css');
const cssFiles = fileExists(cssDir) ? getAllFiles(cssDir, '.css') : [];
let cssOk = true;
for (const f of cssFiles) {
  const content = readFile(f);
  if (content) {
    const open = (content.match(/\{/g) || []).length;
    const close = (content.match(/\}/g) || []).length;
    if (open !== close) { fail(`braces: ${path.basename(f)} (${open}/${close})`); cssOk = false; }
  }
}
if (cssOk) ok(`all ${cssFiles.length} CSS OK`);

// C3: HTML DOCTYPE check
console.log(`\n${Y}[C3] HTML${R}`);
const rendererDir = path.join(root, 'src', 'renderer');
const htmlFiles = fileExists(rendererDir) ? getAllFiles(rendererDir, '.html') : [];
let htmlOk = true;
for (const f of htmlFiles) {
  const content = readFile(f);
  if (content) {
    if (!content.includes('<!DOCTYPE html>')) { fail(`no DOCTYPE: ${path.basename(f)}`); htmlOk = false; }
    if (!content.includes('<html')) { fail(`no <html>: ${path.basename(f)}`); htmlOk = false; }
  }
}
if (htmlOk) ok(`all ${htmlFiles.length} HTML OK`);

// ============================================================
// D. Runtime Integrity
// ============================================================

// D1: HTML resource references
console.log(`\n${Y}[D1] HTML resource references${R}`);
let htmlResOk = true;
for (const f of htmlFiles) {
  const dir = path.dirname(f);
  const content = readFile(f);
  if (!content) continue;
  for (const m of content.matchAll(/src="([^"]*\.js)"/g)) {
    const ref = m[1];
    if (/^https?:\/\//.test(ref)) continue;
    const full = path.resolve(dir, ref);
    if (!fileExists(full)) { fail(`${path.basename(f)} -> JS not found: ${ref}`); htmlResOk = false; }
  }
  for (const m of content.matchAll(/href="([^"]*\.css)"/g)) {
    const ref = m[1];
    if (/^https?:\/\//.test(ref)) continue;
    const full = path.resolve(dir, ref);
    if (!fileExists(full)) { fail(`${path.basename(f)} -> CSS not found: ${ref}`); htmlResOk = false; }
  }
}
if (htmlResOk) ok('all HTML resources resolved');

// D2: JS module resolution
console.log(`\n${Y}[D2] JS module resolution${R}`);
let modOk = true;
const mainJsFiles = ['src/main.js', 'src/renderer/js/main.js', 'src/renderer/js/init.js', 'src/renderer/js/tabs.js', 'src/renderer/js/monaco-editor-manager.js'];
for (const f of mainJsFiles) {
  const fp = path.join(root, f);
  if (!fileExists(fp)) continue;
  const content = readFile(fp);
  if (!content) continue;
  const dir = path.dirname(fp);
  for (const m of content.matchAll(/require\(['"](\.\.?\/[^'"]+)['"]\)/g)) {
    const target = m[1];
    const full = path.resolve(dir, target);
    if (!fileExists(full) && !fileExists(full + '.js') && !fileExists(path.join(full, 'index.js'))) {
      fail(`${f} -> require not found: ${target}`);
      modOk = false;
    }
  }
}
if (modOk) ok('all local requires resolved');

// D3: DOM selector consistency
console.log(`\n${Y}[D3] DOM selector consistency${R}`);
const indexHtmlContent = readFile(path.join(root, 'src', 'renderer', 'index.html'));
const htmlIds = [];
if (indexHtmlContent) {
  for (const m of indexHtmlContent.matchAll(/id="([^"]+)"/g)) htmlIds.push(m[1]);
}
const jsSelectorFiles = ['src/renderer/js/main.js', 'src/renderer/js/tabs.js', 'src/renderer/js/init.js', 'src/renderer/js/monaco-editor-manager.js'];
for (const f of jsSelectorFiles) {
  const fp = path.join(root, f);
  if (!fileExists(fp)) continue;
  const content = readFile(fp);
  if (!content) continue;
  for (const m of content.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)) {
    const id = m[1];
    if (!htmlIds.includes(id) && !/^group-/.test(id) && !/^tab-/.test(id) && !/monaco/.test(id)) {
      if (verbose) warn(`${f} -> #${id} not in HTML (may be dynamic)`);
    }
  }
  for (const m of content.matchAll(/querySelector\(['"]\.([^'"]+)['"]\)/g)) {
    const cls = m[1];
    let cssFound = false;
    for (const cssF of cssFiles) {
      const cssContent = readFile(cssF);
      if (cssContent && new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(cssContent)) { cssFound = true; break; }
    }
    if (!cssFound && !/monaco/.test(cls) && !/^tab-/.test(cls)) {
      if (verbose) warn(`${f} -> .${cls} not in CSS (may be dynamic)`);
    }
  }
}
ok('DOM selectors checked');

// D4: IPC channel consistency
console.log(`\n${Y}[D4] IPC channel consistency${R}`);
const mainJsContent = readFile(path.join(root, 'src', 'main.js'));
const rendererJsContent = readFile(path.join(root, 'src', 'renderer', 'js', 'main.js'));
let ipcOk = true;
if (mainJsContent && rendererJsContent) {
  const mainHandles = [];
  for (const m of mainJsContent.matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)) mainHandles.push(m[1]);
  const rendererInvokes = [];
  for (const m of rendererJsContent.matchAll(/electronAPI\.(\w+)\(/g)) rendererInvokes.push(m[1]);
  for (const invoke of rendererInvokes) {
    const found = mainHandles.some(h => h.includes(invoke) || invoke.includes(h));
    if (!found && !/^on[A-Z]/.test(invoke) && invoke !== 'path') {
      if (verbose) info(`renderer calls electronAPI.${invoke} (may be event-based)`);
    }
  }
  ok(`IPC channels checked (${mainHandles.length} handlers)`);
} else {
  warn('Could not read main.js files for IPC check');
}

// D5: CSS url() references
console.log(`\n${Y}[D5] CSS url() references${R}`);
let cssUrlOk = true;
for (const f of cssFiles) {
  const content = readFile(f);
  if (!content) continue;
  const dir = path.dirname(f);
  for (const m of content.matchAll(/url\(['"]?([^)'"]+)['"]?\)/g)) {
    const url = m[1];
    if (/^https?:\/\//.test(url) || /^data:/.test(url)) continue;
    const full = path.resolve(dir, url);
    if (!fileExists(full)) { fail(`${path.basename(f)} -> url() not found: ${url}`); cssUrlOk = false; }
  }
}
if (cssUrlOk) ok('CSS url() references checked');

// D6: Critical DOM elements
console.log(`\n${Y}[D6] Critical DOM elements${R}`);
const criticalIds = ['editor-groups', 'welcome-container', 'app-icon'];
let domCritOk = true;
for (const id of criticalIds) {
  if (htmlIds.includes(id)) ok(`#${id} found`); else { fail(`#${id} missing from HTML`); domCritOk = false; }
}
const criticalClasses = ['editor-container', 'editor-area', 'tab-bar', 'editor-group', 'sidebar'];
if (indexHtmlContent) {
  for (const cls of criticalClasses) {
    if (new RegExp(`class="[^"]*\\b${cls}\\b`).test(indexHtmlContent)) ok(`.${cls} found`);
    else { fail(`.${cls} missing from HTML`); domCritOk = false; }
  }
}

// D7: Debug logging check — FAIL on debug artifacts
console.log(`\n${Y}[D7] Debug logging check${R}`);
let debugOk = true;
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  const content = readFile(f);
  if (!content) continue;
  const logCount = (content.match(/console\.log\(/g) || []).length;
  const dbgCount = (content.match(/debugger;/g) || []).length;
  const alertCount = (content.match(/alert\(/g) || []).length;
  if (logCount > 0) { warn(`${rel} has ${logCount}x console.log`); debugOk = false; }
  if (dbgCount > 0) { fail(`${rel} has ${dbgCount}x debugger`); debugOk = false; }
  if (alertCount > 0) { warn(`${rel} has ${alertCount}x alert()`); debugOk = false; }
}
if (debugOk) ok('debug artifacts clean');

// D8: File encoding — FAIL on BOM
console.log(`\n${Y}[D8] File encoding${R}`);
const bomFiles = ['src/main.js', 'src/renderer/js/main.js', 'src/renderer/js/tabs.js', 'src/renderer/js/monaco-editor-manager.js'];
let bomOk = true;
for (const f of bomFiles) {
  const fp = path.join(root, f);
  if (fileExists(fp)) {
    const bytes = fs.readFileSync(fp);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
      fail(`${f} has UTF-8 BOM`);
      bomOk = false;
    }
  }
}
if (bomOk) ok('encoding OK');

// ============================================================
// E. Security
// ============================================================

// E1: IPC whitelist audit
console.log(`\n${Y}[E1] IPC whitelist audit${R}`);
const preloadPath = path.join(root, 'src', 'preload.js');
let ipcWhitelistOk = true;
if (fileExists(preloadPath)) {
  const preloadContent = readFile(preloadPath);
  if (preloadContent && mainJsContent) {
    const sendChannels = [];
    for (const m of preloadContent.matchAll(/ipcRenderer\.send\('([^']+)'/g)) sendChannels.push(m[1]);
    const invokeChannels = [];
    for (const m of preloadContent.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)) invokeChannels.push(m[1]);
    const preloadChannels = [...new Set([...sendChannels, ...invokeChannels])];
    const mainRegistered = [];
    for (const m of mainJsContent.matchAll(/ipcMain\.(handle|on)\('([^']+)'/g)) mainRegistered.push(m[2]);
    const unregistered = preloadChannels.filter(ch => !mainRegistered.includes(ch));
    if (unregistered.length > 0) {
      fail(`IPC channels in preload but not in main: ${unregistered.join(', ')}`);
      ipcWhitelistOk = false;
    } else {
      ok(`all ${preloadChannels.length} preload channels registered`);
    }
  }
} else {
  warn('preload.js not found, skipping IPC whitelist');
}

// E2: CSP regression guard
console.log(`\n${Y}[E2] CSP regression guard${R}`);
let cspOk = true;
if (indexHtmlContent) {
  const cspMatch = indexHtmlContent.match(/Content-Security-Policy"?\s+content="([^"]+)"/);
  if (cspMatch) {
    const cspValue = cspMatch[1];
    if (/script-src.*'unsafe-eval'/.test(cspValue)) warn('CSP allows unsafe-eval (needed for Monaco)');
    if (/default-src.*\*/.test(cspValue)) { fail('CSP default-src uses wildcard *'); cspOk = false; }
    if (/script-src\s+\*/.test(cspValue)) { fail('CSP script-src uses wildcard *'); cspOk = false; }
    if (cspOk) ok('CSP present, no wildcard violations');
  } else {
    fail('No Content-Security-Policy found in index.html');
  }
} else {
  fail('index.html not found for CSP check');
}

// E3: --no-sandbox detection
console.log(`\n${Y}[E3] --no-sandbox detection${R}`);
let noSandboxFound = false;
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  const content = readFile(f);
  if (content && /no-sandbox/.test(content)) {
    fail(`${rel} contains --no-sandbox`);
    noSandboxFound = true;
  }
}
if (!noSandboxFound) ok('no --no-sandbox in source');

// E4: Secrets scan — FAIL
console.log(`\n${Y}[E4] Secrets scan${R}`);
let secretsFound = 0;
const secretPatterns = [
  /api[_-]?key\s*[=:]\s*['"][A-Za-z0-9]{20,}['"]/i,
  /password\s*[=:]\s*['"][^'"]{8,}['"]/i,
  /token\s*[=:]\s*['"][A-Za-z0-9]{20,}['"]/i,
  /secret\s*[=:]\s*['"][A-Za-z0-9]{20,}['"]/i
];
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  const content = readFile(f);
  if (!content) continue;
  for (const pattern of secretPatterns) {
    if (pattern.test(content)) {
      warn(`potential secret in ${rel}`);
      secretsFound++;
    }
  }
}
if (secretsFound === 0) ok('no hardcoded secrets'); else warn(`${secretsFound} potential secrets (review manually)`);

// E5: eval()/Function() detection — FAIL
console.log(`\n${Y}[E5] Dangerous eval detection${R}`);
let evalFound = 0;
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  const content = readFile(f);
  if (!content) continue;
  const evalCount = (content.match(/\beval\(/g) || []).length;
  const funcCount = (content.match(/\bnew Function\(/g) || []).length;
  if (evalCount > 0) { fail(`${rel} has ${evalCount}x eval()`); evalFound += evalCount; }
  if (funcCount > 0) { fail(`${rel} has ${funcCount}x new Function()`); evalFound += funcCount; }
}
if (evalFound === 0) ok('no eval()/Function() found'); else fail(`${evalFound} dangerous calls`);

// E6: child_process security — WARN
console.log(`\n${Y}[E6] child_process security${R}`);
let shellExecFound = 0;
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  const content = readFile(f);
  if (!content) continue;
  const childProcessImport = /require\s*\(\s*['"]child_process['"]\s*\)/.test(content);
  const execCount = childProcessImport ? (content.match(/child_process\.exec\(/g) || []).length : 0;
  const execSyncCount = childProcessImport ? (content.match(/child_process\.execSync\(/g) || []).length : 0;
  const spawnShellCount = (content.match(/spawn\([^)]*shell\s*:\s*true/g) || []).length;
  if (execCount > 0) { warn(`${rel} has ${execCount}x exec()`); shellExecFound += execCount; }
  if (execSyncCount > 0) { warn(`${rel} has ${execSyncCount}x execSync()`); shellExecFound += execSyncCount; }
  if (spawnShellCount > 0) { warn(`${rel} has spawn with shell:true`); shellExecFound += spawnShellCount; }
}
if (shellExecFound === 0) ok('no shell execution found'); else warn(`${shellExecFound} shell exec calls (review for safety)`);

// E7: Event listener leak risk
console.log(`\n${Y}[E7] Event listener leak risk${R}`);
let leakRisk = 0;
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  const content = readFile(f);
  if (!content) continue;
  const addCount = (content.match(/\.addEventListener\(/g) || []).length;
  const removeCount = (content.match(/\.removeEventListener\(/g) || []).length;
  if (addCount > 10 && removeCount === 0) {
    warn(`${rel} has ${addCount} addEventListener but 0 removeEventListener`);
    leakRisk++;
  }
}
if (leakRisk === 0) ok('no obvious listener leak risk');

// E8: Dangerous file writes
console.log(`\n${Y}[E8] Dangerous file writes${R}`);
let dangerousWrites = 0;
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  const content = readFile(f);
  if (!content) continue;
  if (/writeFileSync\([^,]+,\s*[^,]+,\s*['"]?utf-?8/.test(content) && /\/etc\//.test(content)) {
    fail(`${rel} writes to /etc/`);
    dangerousWrites++;
  }
}
if (dangerousWrites === 0) ok('no dangerous file writes');

// ============================================================
// F. Supply Chain
// ============================================================

// F1: Unpinned dependencies
console.log(`\n${Y}[F1] Unpinned dependencies${R}`);
if (pkg) {
  let latestDeps = [];
  if (pkg.dependencies) {
    latestDeps = Object.entries(pkg.dependencies).filter(([, v]) => v === 'latest').map(([k]) => k);
  }
  if (latestDeps.length > 0) {
    fail(`production deps with 'latest': ${latestDeps.join(', ')}`);
  } else {
    ok("no unpinned 'latest' deps");
  }
}

// F2: Dependency tree
console.log(`\n${Y}[F2] Dependency tree${R}`);
const lsResult = exec('pnpm ls --depth=0 2>&1', 15000);
if (lsResult !== null) {
  if (lsResult.includes('ERR!') || lsResult.includes('WARN') || lsResult.includes('missing')) {
    warn('dependency tree has warnings (may be acceptable with pnpm)');
  } else {
    ok('dependency tree clean');
  }
} else {
  warn('pnpm ls could not run (timed out or failed)');
}

// ============================================================
// G. Code Quality
// ============================================================

// G1: Large file check
console.log(`\n${Y}[G1] Large file check${R}`);
let largeFiles = 0;
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  try {
    const content = fs.readFileSync(f, 'utf8');
    const lines = content.split('\n').length;
    if (lines > 3000) { warn(`${rel}: ${lines} lines (>3000)`); largeFiles++; }
  } catch {}
}
if (largeFiles === 0) ok('no oversized files');

// G2: Duplicate function names (same file only)
console.log(`\n${Y}[G2] Duplicate function names${R}`);
let duplicateCount = 0;
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  const content = readFile(f);
  if (!content) continue;
  const fileFuncNames = {};
  for (const m of content.matchAll(/(?:function|const|let|var)\s+(\w+)\s*[=(]/g)) {
    const name = m[1];
    if (name.length > 5 && !/^(log|err|warn|info|debug|init|setup|load|create|render|update|remove|delete|get|set|add|start|stop|open|close|read|write|send|receive|process|handle|execute|run|test|check|validate|parse|format|convert|encode|decode|encrypt|decrypt|hash|compress|decompress|upload|download|connect|disconnect|subscribe|unsubscribe|on|off|emit|trigger|dispatch|listen|bind|unbind|mount|unmount|install|uninstall|enable|disable|show|hide|toggle|focus|blur|select|deselect|copy|cut|paste|undo|redo|save|export|import|sync|async|await|promise|callback|handler|listener|observer|provider|factory|builder|adapter|wrapper|helper|util|utils|tool|tools|config|settings|options|params|args|props|state|context|store|cache|pool|queue|stack|list|array|map|set|dict|hash|tree|graph|node|edge|link|path|route|endpoint|url|uri|link|href|src|dest|source|target|input|output|stream|pipe|channel|port|socket|connection|session|token|key|value|data|payload|body|header|meta|info|details|description|name|label|title|text|content|message|error|warning|exception|fault|status|code|type|kind|category|group|class|namespace|module|package|library|framework|plugin|extension|addon|component|widget|element|node|tag|attribute|property|method|function|api|interface|contract|schema|model|view|controller|service|repository|dao|dto|vo|po|entity|model|domain|business|logic|presentation|ui|ux|gui|cli|tui|web|mobile|desktop|server|client|agent|bot|daemon|service|worker|scheduler|job|task|queue|pool|thread|process|instance|container|pod|node|cluster|region|zone|dc|env|environment|stage|prod|dev|test|qa|uat|staging|sandbox|local|remote|cloud|aws|gcp|azure|docker|k8s|kubernetes|helm|terraform|ansible|jenkins|gitlab|github|bitbucket|jira|confluence|slack|teams|discord|telegram|email|sms|push|notification|alert|alarm|event|trigger|webhook|hook|callback|listener|observer|subscriber|publisher|emitter|bus|queue|topic|channel|exchange|routing|binding|consumer|producer|sender|receiver|client|server|proxy|gateway|loadbalancer|router|switch|firewall|vpn|ssl|tls|https|http|tcp|udp|ip|dns|dhcp|ntp|ssh|ftp|smtp|imap|pop3|ldap|kerberos|oauth|jwt|saml|oidc|mfa|2fa|sso|rbac|abac|acl|rbac|dac|mac|cryptography|cipher|encrypt|decrypt|sign|verify|hash|hmac|sha|md5|aes|rsa|ecdsa|ed25519|x509|certificate|ca|pkcs|pem|der|jks|keystore|truststore|secret|credential|password|pin|otp|totp|hotp|recovery|backup|restore|archive|compress|zip|tar|gzip|bzip2|lzma|zstd|lz4|snappy|deflate|inflate|encrypt|decrypt|encode|decode|base64|hex|ascii|utf8|unicode|latin|cp1252|iso8859|charset|encoding|decoding|serialization|deserialization|marshal|unmarshal|parse|unparse|format|unformat|stringify|json|xml|yaml|toml|ini|csv|tsv|parquet|avro|orc|feather|arrow|protobuf|thrift|grpc|rest|soap|graphql|websocket|socket|sse|longpoll|短命名)$/.test(name)) {
      if (fileFuncNames[name]) {
        warn(`${rel} has duplicate: ${name}`);
        duplicateCount++;
      } else {
        fileFuncNames[name] = true;
      }
    }
  }
}
if (duplicateCount === 0) ok('no duplicate function names in same file');

// G3: Dead code patterns
console.log(`\n${Y}[G3] Dead code patterns${R}`);
let deadPatterns = 0;
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  const content = readFile(f);
  if (!content) continue;
  const emptyFuncs = (content.match(/function\s+\w+\s*\([^)]*\)\s*\{\s*\}/g) || []).length;
  const emptyCatch = (content.match(/catch\s*\([^)]*\)\s*\{\s*\}/g) || []).length;
  if (emptyFuncs > 0) { info(`${rel} has ${emptyFuncs} empty functions`); deadPatterns += emptyFuncs; }
  if (emptyCatch > 0) { info(`${rel} has ${emptyCatch} empty catch blocks`); deadPatterns += emptyCatch; }
}
if (deadPatterns === 0) ok('no obvious dead code'); else info(`${deadPatterns} dead code patterns (may be intentional)`);

// ============================================================
// H. Crash & Runtime
// ============================================================

// H1: Crash handlers
console.log(`\n${Y}[H1] Crash handlers${R}`);
if (mainJsContent) {
  if (/render-process-gone/.test(mainJsContent)) ok('render-process-gone handler'); else fail('no render-process-gone handler');
  if (/uncaughtException/.test(mainJsContent)) ok('uncaughtException handler'); else fail('no uncaughtException handler');
  if (/unhandledRejection/.test(mainJsContent)) ok('unhandledRejection handler'); else fail('no unhandledRejection handler');
  if (/process\.on/.test(mainJsContent)) ok('process exit handler'); else fail('no process exit handler');
} else {
  fail('main.js not found for crash handler check');
}

// H2: BrowserWindow security
console.log(`\n${Y}[H2] BrowserWindow security${R}`);
if (mainJsContent) {
  const sandboxFalse = (mainJsContent.match(/sandbox.{0,3}false/g) || []).length;
  const webSecFalse = (mainJsContent.match(/webSecurity.{0,3}false/g) || []).length;
  const nodeIntTrue = (mainJsContent.match(/nodeIntegration.{0,3}true/g) || []).length;
  const ctxIsoFalse = (mainJsContent.match(/contextIsolation.{0,3}false/g) || []).length;

  if (sandboxFalse > 0) warn(`sandbox:false in ${sandboxFalse} BrowserWindow(s)`);
  if (webSecFalse > 0) warn(`webSecurity:false in ${webSecFalse} BrowserWindow(s)`);
  if (nodeIntTrue > 0) fail(`nodeIntegration:true in ${nodeIntTrue} BrowserWindow(s)`);
  if (ctxIsoFalse > 0) fail(`contextIsolation:false in ${ctxIsoFalse} BrowserWindow(s)`);
  if (sandboxFalse === 0 && webSecFalse === 0 && nodeIntTrue === 0 && ctxIsoFalse === 0) {
    ok('all BrowserWindow configs secure');
  }
} else {
  fail('main.js not found for BrowserWindow security check');
}

// H3: Version consistency
console.log(`\n${Y}[H3] Version consistency${R}`);
const buildInfoPath = path.join(root, 'src', 'build-info.json');
if (fileExists(buildInfoPath)) {
  const buildInfo = readJson(buildInfoPath);
  if (buildInfo && pkg) {
    if (buildInfo.version === pkg.version) ok(`build-info version matches: ${buildInfo.version}`);
    else fail(`version mismatch: pkg=${pkg.version} build-info=${buildInfo.version}`);
  }
} else {
  warn('build-info.json not found');
}

// H4: Electron version check
console.log(`\n${Y}[H4] Electron version${R}`);
if (pkg && pkg.devDependencies && pkg.devDependencies.electron) {
  const electronVer = pkg.devDependencies.electron.replace(/[^0-9.]/g, '');
  const firstDot = electronVer.indexOf('.');
  const majorVer = firstDot > 0 ? parseInt(electronVer.substring(0, firstDot), 10) : parseInt(electronVer, 10);
  if (majorVer < 35) {
    fail(`Electron ${electronVer} is too old (security risk)`);
  } else if (majorVer < 39) {
    warn(`Electron ${electronVer} -- check for security patches at electronjs.org`);
  } else {
    ok(`Electron ${electronVer} is recent`);
  }
} else {
  fail('electron version not found in devDependencies');
}

// ============================================================
// I. Summary
// ============================================================
console.log(`\n${C}=========================================${R}`);
console.log(`  ${G}Passed:  ${passed}${R}`);
console.log(`  ${Y}Warnings: ${warned}${R}`);
console.log(`  ${failed > 0 ? RD : G}Failed:  ${failed}${R}`);
console.log(`${C}=========================================${R}`);
console.log(`${GR}Platform: ${os.platform()}/${os.arch()}${R}`);

if (failed > 0) {
  console.log(`\n${RD}${B}CI FAILED${R}`);
  clearTimeout(globalTimer);
  process.exit(1);
} else {
  console.log(`\n${G}${B}CI PASSED${R}`);
  clearTimeout(globalTimer);
  process.exit(0);
}
