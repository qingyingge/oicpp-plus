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

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const strict = argv.includes('--strict');
const onlyTests = argv.includes('--only') && argv[argv.indexOf('--only') + 1] === 'tests';
const skipTests = argv.includes('--skip') && argv[argv.indexOf('--skip') + 1] === 'tests';

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

function finish() {
  console.log(`\n${C}=========================================${R}`);
  console.log(`  ${G}Passed:  ${passed}${R}`);
  console.log(`  ${Y}Warnings: ${warned}${R}`);
  console.log(`  ${failed > 0 ? RD : G}Failed:  ${failed}${R}`);
  console.log(`${C}=========================================${R}`);
  console.log(`${GR}Platform: ${os.platform()}/${os.arch()}${R}`);

  clearTimeout(globalTimer);
  if (failed > 0) {
    console.log(`\n${RD}${B}CI FAILED${R}`);
    process.exit(1);
  }
  if (strict && warned > 0) {
    console.log(`\n${RD}${B}STRICT: ${warned} warning(s) treated as failures${R}`);
    process.exit(1);
  }
  console.log(`\n${G}${B}CI PASSED${R}`);
  process.exit(0);
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
if (onlyTests) info('Mode: regression tests only');
if (skipTests) info('Mode: static checks only (regression tests skipped)');
if (onlyTests) {
  runRegressionTests();
  finish();
}

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
    // pnpm 12 writes a multi-document YAML stream (bootstrap doc + real deps doc):
    // scan every importers section, count only entries under dependencies:/devDependencies:
    const lockDepNames = new Set();
    for (const sec of lockContent.matchAll(/^importers:$/gm)) {
      const rest = lockContent.slice(sec.index);
      const endIdx = rest.search(/^packages:/m);
      const block = endIdx >= 0 ? rest.slice(0, endIdx) : rest;
      let group = '';
      const lines = block.split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i++) {
        const g = /^ {4}([^\s:]+):/.exec(lines[i]);
        if (g) { group = g[1]; continue; }
        const d = /^ {6}'?([^'\s:]+)'?:$/.exec(lines[i]);
        if (d && (group === 'dependencies' || group === 'devDependencies') && /^ {8}specifier:/.test(lines[i + 1])) lockDepNames.add(d[1]);
      }
    }
    if (lockDepNames.size > 0 && pkg) {
      const pkgDepNames = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
      const missingInLock = [...pkgDepNames].filter(n => !lockDepNames.has(n));
      const extraInLock = [...lockDepNames].filter(n => !pkgDepNames.has(n));
      if (missingInLock.length > 0) fail(`deps in package.json but not in lock importers (run pnpm install): ${missingInLock.join(', ')}`);
      else if (extraInLock.length > 0) fail(`deps in lock importers but not in package.json: ${extraInLock.join(', ')}`);
      else ok(`lock importers in sync with package.json (${lockDepNames.size} deps)`);
    } else {
      warn('could not parse lockfile importers section');
    }
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
const generatedPngDir = path.join(root, 'build', 'icons', 'png');
if (fileExists(generatedPngDir)) {
  const requiredSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
  const missingIcons = requiredSizes.filter((size) => !fileExists(path.join(generatedPngDir, `${size}x${size}.png`)));
  if (missingIcons.length > 0) fail(`generated icon sizes missing: ${missingIcons.join(', ')}`);
  else ok('generated PNG icon sizes ready');
} else {
  ok('generated PNG icons not present (prebuild will create them)');
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
    if (/oicpp\.ico(?=$|[^-])/.test(content)) fail(`${f} still references oicpp.ico`); else ok(`${f}`);
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
  if (/oicpp\.ico(?=$|[^-])/.test(nsiContent)) fail('old icon'); else ok('icon OK');
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
  const norm = (s) => s.replace(/[-_]/g, '').toLowerCase();
  const mainHandles = [];
  for (const m of mainJsContent.matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)) mainHandles.push(m[1]);
  const mainOns = [];
  for (const m of mainJsContent.matchAll(/ipcMain\.on\(['"]([^'"]+)['"]/g)) mainOns.push(m[1]);
  const rendererInvokes = [];
  for (const m of rendererJsContent.matchAll(/electronAPI\.(\w+)\(/g)) rendererInvokes.push(m[1]);
  const unmatched = [];
  for (const invoke of rendererInvokes) {
    if (/^on[A-Z]/.test(invoke) || invoke === 'path') continue;
    const found = [...mainHandles, ...mainOns].some(h => norm(h) === norm(invoke));
    if (!found) unmatched.push(invoke);
  }
  if (unmatched.length > 0) {
    warn(`electronAPI methods without exact main channel match (verify manually): ${unmatched.join(', ')}`);
  }
  ok(`IPC channels checked (${mainHandles.length} handlers, ${mainOns.length} listeners)`);
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
    for (const m of preloadContent.matchAll(/(?:ipcRenderer|safeIpcRenderer)\.send\('([^']+)'/g)) sendChannels.push(m[1]);
    const invokeChannels = [];
    for (const m of preloadContent.matchAll(/(?:ipcRenderer|safeIpcRenderer)\.invoke\('([^']+)'/g)) invokeChannels.push(m[1]);
    const preloadChannels = [...new Set([...sendChannels, ...invokeChannels])];
    const mainRegistered = [];
    for (const m of mainJsContent.matchAll(/ipcMain\.(handle|on|once)\('([^']+)'/g)) mainRegistered.push(m[2]);
    const unregistered = preloadChannels.filter(ch => !mainRegistered.includes(ch));
    if (unregistered.length > 0) {
      fail(`IPC channels in preload but not in main: ${unregistered.join(', ')}`);
      ipcWhitelistOk = false;
    } else {
      ok(`all ${preloadChannels.length} preload channels registered`);
    }

    // Renderer send/invoke usage must be covered by the preload whitelist AND registered in main.
    const parseWhitelist = (name) => {
      const set = new Set();
      const wm = preloadContent.match(new RegExp(`${name}[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
      if (wm) for (const q of wm[1].matchAll(/'([^']+)'/g)) set.add(q[1]);
      return set;
    };
    const allowedSend = parseWhitelist('ALLOWED_SEND_CHANNELS');
    const allowedInvoke = parseWhitelist('ALLOWED_INVOKE_CHANNELS');
    const sendUseRe = /(?:electronIPC|ipcRenderer)\.send\(\s*['"`]([^'"`]+)['"`]/g;
    const invokeUseRe = /(?:electronIPC|ipcRenderer)\.invoke\(\s*['"`]([^'"`]+)['"`]/g;
    const blockedSends = new Set();
    const blockedInvokes = new Set();
    const scanTargets = [...jsFiles.filter(f => f !== preloadPath), path.join(root, 'src', 'renderer', 'index.html')];
    for (const rf of scanTargets) {
      const rc = readFile(rf);
      if (!rc) continue;
      for (const m of rc.matchAll(sendUseRe)) {
        if (!allowedSend.has(m[1])) blockedSends.add(m[1]);
      }
      for (const m of rc.matchAll(invokeUseRe)) {
        if (!allowedInvoke.has(m[1])) blockedInvokes.add(m[1]);
      }
    }
    const blockedAll = [...new Set([...blockedSends, ...blockedInvokes])];
    if (blockedAll.length > 0) {
      const notInMain = blockedAll.filter(ch => !mainRegistered.includes(ch));
      const detail = notInMain.length > 0 ? ` (also unregistered in main: ${notInMain.join(', ')})` : '';
      fail(`renderer IPC channels blocked by preload whitelist: ${blockedAll.join(', ')}${detail}`);
      ipcWhitelistOk = false;
    } else {
      ok(`all renderer send/invoke channels covered by whitelist`);
    }
    const usedChannels = new Set(preloadChannels);
    const ipcUseRe = /(?:electronIPC|ipcRenderer)\.(?:send|sendSync|invoke)\(\s*['"`]([^'"`]+)['"`]/g;
    for (const rf of jsFiles) {
      if (rf === preloadPath) continue;
      const rc = readFile(rf);
      if (!rc) continue;
      for (const m of rc.matchAll(ipcUseRe)) usedChannels.add(m[1]);
    }
    if (indexHtmlContent) {
      for (const m of indexHtmlContent.matchAll(ipcUseRe)) usedChannels.add(m[1]);
    }
    for (const m of preloadContent.matchAll(/ALLOWED_\w*CHANNELS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/g)) {
      for (const q of m[1].matchAll(/'([^']+)'/g)) usedChannels.add(q[1]);
    }
    const deadChannels = [...new Set(mainRegistered)].filter(ch => !usedChannels.has(ch));
    if (deadChannels.length > 0) {
      warn(`IPC handlers in main but never referenced from renderer/preload: ${deadChannels.join(', ')}`);
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
    const directives = {};
    for (const part of cspValue.split(';')) {
      const tokens = part.trim().split(/\s+/);
      if (tokens[0]) directives[tokens[0]] = tokens.slice(1);
    }
    if ((directives['script-src'] || []).includes("'unsafe-eval'")) warn('CSP allows unsafe-eval (needed for Monaco)');
    for (const d of ['default-src', 'script-src']) {
      if ((directives[d] || []).includes('*')) { fail(`CSP ${d} uses wildcard *`); cspOk = false; }
    }
    for (const d of ['frame-src', 'connect-src', 'img-src', 'media-src', 'object-src']) {
      if ((directives[d] || []).includes('*')) warn(`CSP ${d} uses wildcard * (review)`);
    }
    if (cspOk) ok('CSP present, no wildcard violations in critical directives');
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
      fail(`potential secret in ${rel}`);
      secretsFound++;
    }
  }
}
if (secretsFound === 0) ok('no hardcoded secrets'); else fail(`${secretsFound} potential secrets`);

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
  const addCount = (content.match(/\b(?:window|document|globalThis)\.addEventListener\(/g) || []).length;
  const removeCount = (content.match(/\b(?:window|document|globalThis)\.removeEventListener\(/g) || []).length;
  if (addCount >= 5 && removeCount === 0) {
    info(`${rel} has ${addCount} window/document listeners, 0 removed (page-lifetime? review)`);
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
  if (/(?:writeFileSync|appendFileSync|createWriteStream|writeFile|appendFile)\s*\(\s*[^)]*\/etc\//.test(content)) {
    fail(`${rel} writes to /etc/`);
    dangerousWrites++;
  }
}
if (dangerousWrites === 0) ok('no dangerous file writes');

// --- E9-E11: Electron webPreferences 反模式（硬回归，存量为 0） ------------------
// 这三项一旦出现就是新引入的反模式，不设 baseline：出现即 FAIL。
console.log(`\n${Y}[E9] allowRunningInsecureContent${R}`);
const webPrefInsecure = (mainJsContent || '').match(/allowRunningInsecureContent.{0,3}true/g) || [];
if (mainJsContent) {
  if (webPrefInsecure.length > 0) fail(`allowRunningInsecureContent:true in ${webPrefInsecure.length} place(s)`);
  else ok('no allowRunningInsecureContent:true');
} else {
  warn('main.js not found, skipping allowRunningInsecureContent check');
}

console.log(`\n${Y}[E10] experimentalFeatures${R}`);
if (mainJsContent) {
  const expFeatures = (mainJsContent.match(/experimentalFeatures.{0,3}true/g) || []).length;
  if (expFeatures > 0) fail(`experimentalFeatures:true in ${expFeatures} place(s)`);
  else ok('no experimentalFeatures:true');
} else {
  warn('main.js not found, skipping experimentalFeatures check');
}

console.log(`\n${Y}[E11] enableBlinkFeatures${R}`);
let blinkFeaturesFound = false;
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  const content = readFile(f);
  if (!content) continue;
  if (/enableBlinkFeatures/.test(content)) {
    fail(`${rel} uses enableBlinkFeatures`);
    blinkFeaturesFound = true;
  }
}
if (!blinkFeaturesFound) ok('no enableBlinkFeatures usage');

// --- E12: <webview allowpopups>（WARN） ----------------------------------------
console.log(`\n${Y}[E12] <webview allowpopups>${R}`);
let allowpopupsFound = false;
for (const f of getAllFiles(path.join(root, 'src'), '.html')) {
  const rel = path.relative(root, f);
  const content = readFile(f);
  if (!content) continue;
  if (/allowpopups/.test(content)) {
    warn(`${rel} uses <webview allowpopups>`);
    allowpopupsFound = true;
  }
}
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  const content = readFile(f);
  if (!content) continue;
  if (/allowpopups/.test(content)) {
    warn(`${rel} references allowpopups`);
    allowpopupsFound = true;
  }
}
if (!allowpopupsFound) ok('no <webview allowpopups> usage');

// --- E13-E14, E16: 尚未落地的加固项（存量缺口，ratchet） ------------------------
// 这三项检查的是"本该有但还没有"的加固，当前全部缺失。它们不是新引入的回归，
// 而是待办的安全债，所以按缺口计数 ratchet：新增缺口才 FAIL，修复后调低 baseline。
// （直接写成 fail() 会让刚引入检查的当天 CI 全红，失去拦截意义。）
const HARDENING_GAP_BASELINE = 3; // E13 will-navigate + E14 sender 校验 + E16 Fuses
let hardeningGaps = 0;

console.log(`\n${Y}[E13] will-navigate handler${R}`);
if (mainJsContent) {
  if (/will-navigate|willNavigate/.test(mainJsContent)) {
    ok('will-navigate handler found');
  } else {
    hardeningGaps++;
    warn('no will-navigate handler — renderer navigation is unrestricted (known gap)');
  }
} else {
  fail('main.js not found for will-navigate check');
}

console.log(`\n${Y}[E14] IPC sender validation${R}`);
if (mainJsContent) {
  if (/senderFrame\.origin|validateSender|senderFrame\s*&&/.test(mainJsContent)) {
    ok('IPC sender validation found');
  } else {
    hardeningGaps++;
    warn('no IPC sender validation — event.senderFrame.origin is never checked (known gap)');
  }
} else {
  fail('main.js not found for IPC sender validation check');
}

// --- E15: file:// 协议（WARN） --------------------------------------------------
console.log(`\n${Y}[E15] file:// protocol usage${R}`);
let fileProtocolCount = 0;
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  const content = readFile(f);
  if (!content) continue;
  const matches = (content.match(/file:\/\//g) || []).length;
  if (matches > 0) {
    warn(`${rel} uses file:// protocol (${matches}x)`);
    fileProtocolCount += matches;
  }
}
if (fileProtocolCount === 0) ok('no file:// protocol usage');
else info(`${fileProtocolCount} file:// reference(s) in total`);

// E16: Electron Fuses
// 注意：上游原版只认 electron-forge 的 forge.config.*，但本项目用 electron-builder
// 打安装包（见 AGENTS.md「打安装包」），fuses 要配在 build.electronFuses 上，
// 所以这里两套都认，否则该检查对本项目恒为假阳性。
console.log(`\n${Y}[E16] Electron Fuses${R}`);
let fuseConfigFound = false;
if (pkg) {
  const buildCfg = pkg.build || {};
  if (buildCfg.electronFuses) fuseConfigFound = true;
  if (buildCfg['electron-fuses']) fuseConfigFound = true;
}
if (!fuseConfigFound) {
  for (const f of ['forge.config.js', 'forge.config.ts', 'forge.config.cjs', 'forge.config.mjs']) {
    if (fileExists(path.join(root, f))) { fuseConfigFound = true; break; }
  }
}
if (!fuseConfigFound && pkg) {
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (allDeps['@electron/fuses']) fuseConfigFound = true;
}
if (fuseConfigFound) {
  ok('Electron Fuses configuration found');
} else {
  hardeningGaps++;
  warn('no Electron Fuses configuration — build.electronFuses not set, runAsNode/nodeCliInspect stay open (known gap)');
}

// E13/E14/E16 缺口 ratchet：超过 baseline 说明新增了加固缺口
if (hardeningGaps > HARDENING_GAP_BASELINE) {
  fail(`${hardeningGaps} hardening gaps (baseline ${HARDENING_GAP_BASELINE}, +${hardeningGaps - HARDENING_GAP_BASELINE}) — see E13/E14/E16`);
} else {
  ok(`${hardeningGaps} known hardening gap(s) remain (baseline ${HARDENING_GAP_BASELINE}${hardeningGaps < HARDENING_GAP_BASELINE ? `, ${HARDENING_GAP_BASELINE - hardeningGaps} cleared — lower the baseline` : ''})`);
}

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
const lsResult = exec('pnpm ls --depth=0 2>&1', 60000);
if (lsResult !== null) {
  if (lsResult.includes('ERR!') || lsResult.includes('WARN') || lsResult.includes('missing')) {
    warn('dependency tree has warnings (may be acceptable with pnpm)');
  } else {
    ok('dependency tree clean');
  }
} else {
  info('pnpm ls timed out after 60s (inconclusive)');
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

// G2: Duplicate function names (top-level function declarations only)
console.log(`\n${Y}[G2] Duplicate function names${R}`);
let duplicateCount = 0;
const funcDeclRe = /^(?:async\s+)?function\s+(\w+)\s*\(/gm;
for (const f of jsFiles) {
  const rel = path.relative(root, f);
  const content = readFile(f);
  if (!content) continue;
  const seen = new Map();
  for (const m of content.matchAll(funcDeclRe)) {
    const line = content.slice(0, m.index).split('\n').length;
    if (seen.has(m[1])) seen.get(m[1]).push(line);
    else seen.set(m[1], [line]);
  }
  for (const [name, declLines] of seen) {
    if (declLines.length > 1) {
      warn(rel + ' redeclares ' + name + ' at lines ' + declLines.join(', '));
      duplicateCount++;
    }
  }
}
if (duplicateCount === 0) ok('no duplicate top-level function declarations');

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
// I. i18n
// ============================================================

// Ratcheting baselines. Lower these whenever a migration batch lands.
// Exceeding one means new regressions were introduced, not that the
// remaining backlog grew — that is a FAIL.
const I18N_HARDCODED_CJK_BASELINE = 0;
const I18N_EN_PUNCT_BASELINE = 1;
// 存量孤儿键（语言包里有、源码里查不到任何引用）。暂不清理，只锁死不许增长。
// 用"源码任意位置出现过的 dotted 字面量"作口径而非 I7 的 t('key') 口径：后者
// 认不出 t(c ? 'a' : 'b')、_t(key, fb)、t(el.dataset.i18n) 这类动态查表，会把
// 大量在用键误报成孤儿。宽松口径只会高估引用、不会低估，因此 ratchet 方向安全。
// 2026-10-01：删除 tabs.js 中重复的第二份 getWelcomePageContent 后，
// welcome.about / welcome.docs / welcome.shortcuts 三个键失去了唯一的
// 引用点（原先只被那份死代码引用）。存量下降 3，baseline 随之下调。
// 取 tests/i18n.test.js 的口径（更严格：只扫 src，键名全字符类）算出的值。
const I18N_ORPHAN_KEY_BASELINE = 202;

const langDir = path.join(root, 'src', 'lang');
const flattenI18n = (obj, prefix = '', out = {}) => {
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenI18n(v, key, out);
    else out[key] = v;
  }
  return out;
};
const placeholdersOf = (value) => (String(value).match(/\{\w+\}/g) || []).sort();
const summarize = (list, keep = 8) =>
  `${list.slice(0, keep).join(', ')}${list.length > keep ? `, ... (+${list.length - keep})` : ''}`;

// I1: Language pack integrity
console.log(`\n${Y}[I1] Language pack integrity${R}`);
const localeFiles = fileExists(langDir) ? fs.readdirSync(langDir).filter((f) => f.endsWith('.json')).sort() : [];
const locales = {};
if (localeFiles.length === 0) {
  fail('no language pack found in src/lang/');
} else {
  for (const f of localeFiles) {
    const code = path.basename(f, '.json');
    const data = readJson(path.join(langDir, f));
    if (!data) {
      fail(`${f} is not valid JSON (one bad escape blanks the whole UI)`);
      continue;
    }
    const flat = flattenI18n(data);
    if (Object.keys(flat).length === 0) { fail(`${f} has no keys`); continue; }
    if (data.meta && data.meta.code && data.meta.code !== code) {
      fail(`${f} declares meta.code="${data.meta.code}" but the filename implies "${code}"`);
    }
    locales[code] = flat;
  }
  if (Object.keys(locales).length === localeFiles.length) {
    const total = Object.values(locales)[0];
    ok(`${localeFiles.length} pack(s) parse cleanly: ${Object.keys(locales).join(', ')} (${Object.keys(total).length} keys)`);
  }
  for (const required of ['zh-cn', 'en']) {
    if (!locales[required]) fail(`required locale missing: ${required}.json`);
  }
}

// I2: Locale key alignment
console.log(`\n${Y}[I2] Locale key alignment${R}`);
const localeCodes = Object.keys(locales);
if (localeCodes.length >= 2) {
  const base = localeCodes[0];
  const baseKeys = Object.keys(locales[base]);
  const baseSet = new Set(baseKeys);
  let aligned = true;
  for (const code of localeCodes.slice(1)) {
    const other = Object.keys(locales[code]);
    const otherSet = new Set(other);
    const missing = baseKeys.filter((k) => !otherSet.has(k));
    const extra = other.filter((k) => !baseSet.has(k));
    if (missing.length > 0) { fail(`${code}.json missing ${missing.length} key(s) in ${base}.json: ${summarize(missing)}`); aligned = false; }
    if (extra.length > 0) { fail(`${code}.json has ${extra.length} key(s) absent from ${base}.json: ${summarize(extra)}`); aligned = false; }
  }
  if (aligned) ok(`all ${localeCodes.length} locales share the same ${baseKeys.length} keys`);
} else {
  warn('fewer than 2 locales parsed — cannot cross-check key alignment');
}

// I3: Placeholder alignment
console.log(`\n${Y}[I3] Placeholder alignment${R}`);
if (localeCodes.length >= 2) {
  const base = localeCodes[0];
  const baseSet = new Set(Object.keys(locales[base]));
  let phOk = true;
  let phChecked = 0;
  for (const code of localeCodes.slice(1)) {
    for (const [key, value] of Object.entries(locales[code])) {
      if (!baseSet.has(key)) continue;
      phChecked++;
      const mine = placeholdersOf(value);
      const theirs = placeholdersOf(locales[base][key]);
      if (mine.join('|') !== theirs.join('|') || mine.some((p) => !theirs.includes(p)) || theirs.some((p) => !mine.includes(p))) {
        fail(`${code}.json "${key}" placeholders [${mine.join(', ')}] != ${base}.json [${theirs.join(', ')}]`);
        phOk = false;
      }
    }
  }
  if (phOk) ok(`placeholder sets match across locales (${phChecked} keys checked)`);
} else {
  warn('fewer than 2 locales parsed — cannot cross-check placeholders');
}

// I4: English pack hygiene
console.log(`\n${Y}[I4] English pack hygiene${R}`);
if (locales.en) {
  const enCjk = Object.entries(locales.en).filter(([, v]) => /[\u4e00-\u9fff]/.test(String(v)));
  if (enCjk.length > 0) {
    fail(`en.json has CJK text in ${enCjk.length} key(s): ${summarize(enCjk.map(([k]) => k))}`);
  } else {
    ok('en.json has no CJK ideographs');
  }
  // Fullwidth forms, ideographic comma and CJK brackets/quotes are unambiguous;
  // U+2026 / U+2014 are legitimate English typography and must not be flagged.
  const cnPunctRe = /[\uff0c\u3002\uff1b\uff1a\u3001\uff08\uff09\u300c\u300d\u3010\u3011\u201c\u201d\u2018\u2019]/;
  const enPunct = Object.entries(locales.en).filter(([, v]) => cnPunctRe.test(String(v)));
  if (enPunct.length > I18N_EN_PUNCT_BASELINE) {
    fail(`en.json has CJK punctuation in ${enPunct.length} key(s) (baseline ${I18N_EN_PUNCT_BASELINE}): ${summarize(enPunct.map(([k]) => k))}`);
  } else if (enPunct.length > 0) {
    warn(`en.json has ${enPunct.length} key(s) still using CJK punctuation (baseline ${I18N_EN_PUNCT_BASELINE}): ${summarize(enPunct.map(([k]) => k))}`);
  } else {
    ok('en.json has no CJK punctuation');
  }
}

// I5: No-op t() residue
// A regex rewrite of `window.i18n ? window.i18n.t('key') : 'x'` can leave a bare
// parenthesized string behind, which silently renders the key name to the user.
// The lowercase dotted shape is what keeps this signal free of false positives;
// `('key')` is a no-op regardless of whether the key exists in the packs.
// 两种形态都要拦：`= ('k')` 赋值与 `k: ('key')` 对象属性。
// 只拦前者时，3 处裸 key（原生对话框标题 x2、编译输出诊断位置 x1）从 CI 漏了过去。
console.log(`\n${Y}[I5] No-op t() residue${R}`);
{
  const allKeys = new Set();
  for (const flat of Object.values(locales)) for (const k of Object.keys(flat)) allKeys.add(k);
  const residueRes = [
    /(?<![=!<>+\-*/&|%?:])\s=\s*\(\s*['"]([a-z][\w]*(?:\.[a-zA-Z][\w]*)+)['"]\s*\)\s*;?\s*$/gm,
    /(^|[,{]\s*)([A-Za-z_$][\w$]*)\s*:\s*\(\s*['"]([a-z][\w]*(?:\.[a-zA-Z][\w]*)+)['"]\s*\)/gm
  ];
  const hits = new Map();
  for (const f of [...jsFiles, ...htmlFiles]) {
    const content = readFile(f);
    if (!content) continue;
    for (const re of residueRes) {
      for (const m of content.matchAll(re)) {
        const key = m[m.length - 1];
        const line = content.slice(0, m.index).split('\n').length;
        const loc = `${path.relative(root, f)}:${line}`;
        if (!hits.has(loc)) hits.set(loc, key);
      }
    }
  }
  let residue = 0;
  for (const [loc, key] of hits) {
    const unknown = allKeys.has(key) ? '' : ' (and the key is not in any language pack)';
    fail(`${loc} has a bare parenthesized key ('${key}') instead of calling t() — renders the raw key${unknown}`);
    residue++;
  }
  if (residue === 0) ok('no no-op t() residue');
}

// I6: Referenced key resolution
console.log(`\n${Y}[I6] Referenced key resolution${R}`);
{
  const refKeys = new Set();
  const scanFiles = [...jsFiles, ...htmlFiles].filter((f) => !f.startsWith(langDir));
  // 覆盖 i18n.t('k') / i18n?.t?.('k') / i18n?.t('k') / i18n.t?.('k') 四种连接形态：
  // 可选链是 AGENTS.md 认可的写法，历史上严格口径对它不可见，导致键被删/改名
  // 不告警（裸 key 上屏）且不计入引用。连接点必须写成 (?:\?\s*\.\s*|\.\s*)，
  // 不能只写可选的那一支 —— 否则常规的 i18n.t('k') 反而匹配不上。
  // 用命名捕获组，四种形态共用一个 key 组。
  const callRe = /\b(?:i18n|i18next|__|this)\s*(?:\?\s*\.\s*|\.\s*)t\s*(?:\?\s*\.\s*)?\(\s*['"](?<key>[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)['"]/g;
  const bareCallRe = /(?<![.\w])t\s*\(\s*['"]([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)['"]/g;
  const attrRe = /data-i18n(?:-[a-z]+)?\s*=\s*['"]([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)['"]/g;
  for (const f of scanFiles) {
    const content = readFile(f);
    if (!content) continue;
    for (const m of content.matchAll(callRe)) refKeys.add(m.groups.key);
    for (const re of [bareCallRe, attrRe]) {
      for (const m of content.matchAll(re)) refKeys.add(m[1]);
    }
  }
  if (refKeys.size === 0) {
    warn('no statically referenced i18n keys found — key resolution check is inconclusive');
  } else {
    let refOk = true;
    for (const [code, flat] of Object.entries(locales)) {
      const missing = [...refKeys].filter((k) => flat[k] === undefined);
      if (missing.length > 0) {
        fail(`${code}.json is missing ${missing.length} referenced key(s): ${summarize(missing)}`);
        refOk = false;
      }
    }
    if (refOk) ok(`all ${refKeys.size} statically referenced keys resolve in ${localeCodes.join(', ')}`);
  }
}

// I7: Unused keys (informational — keys may be referenced dynamically)
console.log(`\n${Y}[I7] Unused keys${R}`);
if (localeCodes.length >= 1) {
  const base = locales[localeCodes[0]];
  const refKeys = new Set();
  const callRe = /\b(?:i18n|i18next|__|this)\s*(?:\?\s*\.\s*|\.\s*)t\s*(?:\?\s*\.\s*)?\(\s*['"](?<key>[A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)['"]/g;
  const bareCallRe = /(?<![.\w])t\s*\(\s*['"]([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)['"]/g;
  const attrRe = /data-i18n(?:-[a-z]+)?\s*=\s*['"]([A-Za-z][\w]*(?:\.[A-Za-z][\w]*)+)['"]/g;
  for (const f of [...jsFiles, ...htmlFiles].filter((x) => !x.startsWith(langDir))) {
    const content = readFile(f);
    if (!content) continue;
    for (const m of content.matchAll(callRe)) refKeys.add(m.groups.key);
    for (const re of [bareCallRe, attrRe]) for (const m of content.matchAll(re)) refKeys.add(m[1]);
  }
  const unused = Object.keys(base).filter((k) => !refKeys.has(k));
  info(`${unused.length} of ${Object.keys(base).length} keys are not statically referenced (dynamic lookups are not detected)`);

  // --- 孤儿键 ratchet ---------------------------------------------------------
  // 口径比上面的 refKeys 宽：源码任意位置出现过的 dotted 字符串字面量都算引用，
  // 因此 t(c ? 'a' : 'b')、_t(key, fb)、t(el.dataset.i18n) 都能覆盖到。
  // 还要算上属性访问：main.js:3617 读语言列表用的是 content.meta.code 而非字符串，
  // 只认引号字面量会把 meta.code/name/nameEn 三个在用键误判成孤儿。
  const anyLiteralRe = /['"]([a-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)['"]/g;
  const anyPropChainRe = /\.([a-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)/g;
  const mentioned = new Set();
  for (const f of [...jsFiles, ...htmlFiles].filter((x) => !x.startsWith(langDir))) {
    const content = readFile(f);
    if (!content) continue;
    for (const m of content.matchAll(anyLiteralRe)) mentioned.add(m[1]);
    for (const m of content.matchAll(anyPropChainRe)) mentioned.add(m[1]);
  }
  const orphans = Object.keys(base).filter((k) => !mentioned.has(k));
  if (orphans.length > I18N_ORPHAN_KEY_BASELINE) {
    fail(`${orphans.length} orphaned i18n keys (baseline ${I18N_ORPHAN_KEY_BASELINE}, +${orphans.length - I18N_ORPHAN_KEY_BASELINE}) — every new key must be referenced: ${summarize(orphans)}`);
  } else if (orphans.length === 0) {
    ok('no orphaned i18n keys');
  } else {
    ok(`${orphans.length} orphaned i18n keys remain (baseline ${I18N_ORPHAN_KEY_BASELINE}${orphans.length < I18N_ORPHAN_KEY_BASELINE ? `, ${I18N_ORPHAN_KEY_BASELINE - orphans.length} cleared — lower the baseline` : ''})`);
    if (verbose) for (const k of orphans) info(`  ${k}`);
  }
}

// I8: Hardcoded CJK ratchet
console.log(`\n${Y}[I8] Hardcoded CJK ratchet${R}`);
{
  // message:/title:/detail: 是原生 dialog 与 IPC 载荷的用户可见文案出口，
  // innerText 同理；漏掉它们会让「I8 baseline 0」虚高
  const userVisibleRe = /(showError|showWarning|showMessage|showInfo|showConfirm|dialogManager|innerHTML|innerText|textContent|\.title\s*=|placeholder|alert\(|confirm\(|label:|message\s*:|title\s*:|detail\s*:|new Error\(|throw Error)/;
  // A line carrying a data-i18n-* attribute is already wired for translation; the inline
  // CJK is only the pre-JS default that _applyToDOM overwrites. Counting it would keep the
  // ratchet permanently stuck on a backlog that no migration batch can ever clear.
  const alreadyMigratedRe = /data-i18n(-[a-z]+)?\s*=/;
  // 渲染层/主进程用 `t(...) || '兜底'` 形态：中文兜底串在语言包里查不到键时
  // 才会用到，本身不是硬编码输出。所以判定时要把 t() 调用连同其后的
  // 一个 `|| '字面量'` 一起剥掉，否则每个迁移过的调用点都算成新回归。
  //
  // 但这个豁免必须收紧：t() 查不到键时返回键名本身（非空、truthy），
  // `|| 兜底` 永远不触发，屏幕上出现的是裸 key 而不是兜底文案。
  // 也就是说「键写错 + 中文兜底」是 CI 全绿却显示裸 key 的组合。
  // 因此只有当该行 t() 的键确实存在于语言包时才豁免。
  const stripTFallback = (line) => line
    .replace(/\b(?:window\s*\.\s*)?(?:i18n|i18next|__|this)\s*(?:\?\.|\.)\s*t\s*(?:\?\.|\.)?\s*\((?:[^()]|\([^()]*\))*\)(?:\s*\|\|\s*(?:'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\([^()]*\)|[A-Za-z_$][\w.$]*))?/g, 't()')
    .replace(/(?<![.\w])t\s*\((?:[^()]|\([^()]*\))*\)/g, 't()');
  const packKeys = new Set();
  for (const flat of Object.values(locales)) for (const k of Object.keys(flat)) packKeys.add(k);
  // 行上出现的 t() 键（字面量形式）是否都真实存在于语言包
  const tKeysOnLine = (line) => {
    const keys = [];
    const keyRe = /(?:\bi18n|\bi18next|\b__|\bthis)\s*(?:\?\.|\.)\s*t\s*(?:\?\.|\.)?\s*\(\s*['"]([a-z][\w]*(?:\.[a-zA-Z][\w]*)+)['"]/g;
    let m;
    while ((m = keyRe.exec(line)) !== null) keys.push(m[1]);
    const bareRe = /(?<![.\w])t\s*\(\s*['"]([a-z][\w]*(?:\.[a-zA-Z][\w]*)+)['"]/g;
    while ((m = bareRe.exec(line)) !== null) keys.push(m[1]);
    return keys;
  };
  const missingKeys = [];
  let count = 0;
  const byFile = {};
  for (const f of [...jsFiles, ...htmlFiles]) {
    const content = readFile(f);
    if (!content) continue;
    const lineNo = (idx) => content.slice(0, idx).split('\n').length;
    for (const line of content.split('\n')) {
      if (!/[\u4e00-\u9fff]/.test(line)) continue;
      if (/log(Error|Warn|Info|Debug)/.test(line)) continue;      // logs are developer-facing
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;             // comments
      if (alreadyMigratedRe.test(line)) continue;                // already has a data-i18n-* hook
      if (!/[\u4e00-\u9fff]/.test(stripTFallback(line))) {
        // 中文只存在于 t() 兜底里 —— 但键写错时兜底永远不生效，会显示裸 key
        const unknown = tKeysOnLine(line).filter((k) => !packKeys.has(k));
        if (unknown.length > 0) {
          const rel = path.relative(root, f);
          missingKeys.push(`${rel}: ${unknown.join(', ')}`);
        }
        continue;
      }
      if (!userVisibleRe.test(line)) continue;                  // not user-facing
      count++;
      const rel = path.relative(root, f);
      byFile[rel] = (byFile[rel] || 0) + 1;
    }
  }
  if (missingKeys.length > 0) {
    fail(`t() key(s) not in any language pack on a line whose CJK is exempted as a fallback — the fallback never renders, the raw key does: ${missingKeys.join(' | ')}`);
  }
  if (count > I18N_HARDCODED_CJK_BASELINE) {
    fail(`${count} user-visible hardcoded CJK lines (baseline ${I18N_HARDCODED_CJK_BASELINE}, +${count - I18N_HARDCODED_CJK_BASELINE}) — migrate to t() or lower the baseline`);
  } else if (count === 0) {
    ok('no user-visible hardcoded CJK text');
  } else {
    ok(`${count} user-visible hardcoded CJK lines remain (baseline ${I18N_HARDCODED_CJK_BASELINE}${count < I18N_HARDCODED_CJK_BASELINE ? `, ${I18N_HARDCODED_CJK_BASELINE - count} cleared — lower the baseline` : ''})`);
  }
  if (verbose && count > 0) {
    for (const [f, c] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) info(`  ${c} ${f}`);
  }
}

// T1: Regression tests (tests/*.test.js, auto-discovered by tests/run-tests.js)
function runRegressionTests() {
  console.log(`\n${Y}[T1] Regression tests${R}`);
  const testRunnerPath = path.join(root, 'tests', 'run-tests.js');
  if (fileExists(testRunnerPath)) {
    try {
      const testOut = execSync(`node "${testRunnerPath}"`, { encoding: 'utf8', timeout: 90000, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
      testOut.split(/\r?\n/).filter(Boolean).forEach((line) => console.log(`  ${GR}  ${line}${R}`));
      ok('all regression tests passed');
    } catch (err) {
      const testErrOut = `${err.stdout || ''}${err.stderr || ''}`;
      testErrOut.split(/\r?\n/).filter(Boolean).forEach((line) => console.log(`  ${RD}  ${line}${R}`));
      fail('regression tests failed');
    }
  } else {
    fail('tests/run-tests.js not found');
  }
}

// T2: fastspawn.cc 静态语法检查
// fastspawn.cc 是 POSIX-only 扩展，build-fastspawn.js 在 Windows 上直接跳过，
// 于是它的语法/类型错误要到 POSIX 机器打包时才暴露。用 g++ -fsyntax-only +
// 最小 N-API/POSIX 桩在任意平台做检查；没有 g++ 时跳过而不判 FAIL。
function runFastspawnSyntaxCheck() {
  console.log(`\n${Y}[T2] fastspawn.cc syntax${R}`);
  const script = path.join(root, 'scripts', 'check-fastspawn-syntax.js');
  if (!fileExists(script)) {
    warn('scripts/check-fastspawn-syntax.js not found — native syntax check skipped');
    return;
  }
  try {
    const out = execSync(`node "${script}"`, { encoding: 'utf8', timeout: 120000, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    out.split(/\r?\n/).filter(Boolean).forEach((line) => console.log(`  ${GR}  ${line}${R}`));
    ok('fastspawn.cc passes g++ -fsyntax-only');
  } catch (err) {
    const errOut = `${err.stdout || ''}${err.stderr || ''}`;
    errOut.split(/\r?\n/).filter(Boolean).forEach((line) => console.log(`  ${RD}  ${line}${R}`));
    fail('fastspawn.cc syntax check failed');
  }
}

// T3: TypeScript 报错数 ratchet（路线甲基线，允许只减不增）
// 基线 5396 = scripts/ts-migration-baseline.ps1 在 HEAD b7d4f4c、tsc 7.0.2、
// node_modules 下无 @types/* 条件下实测。装上 @types 或换 tsc 版本后必须重跑基线脚本，
// 并同步更新这里与 docs/ts-migration-baseline.js 的 meta。
const TS_ERROR_BASELINE = 5396;
function runTypecheckRatchet() {
  console.log(`\n${Y}[T3] TypeScript error-count ratchet${R}`);
  const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fileExists(tscBin)) {
    fail('typescript is not installed (pnpm add -D typescript)');
    return;
  }
  let out = '';
  try {
    out = execSync(`node "${tscBin}" --noEmit`, { encoding: 'utf8', timeout: 300000, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const count = out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l)).length;
  if (count > TS_ERROR_BASELINE) {
    fail(`${count} tsc errors (baseline ${TS_ERROR_BASELINE}, +${count - TS_ERROR_BASELINE}) — do not grow the error count`);
  } else if (count === 0) {
    ok('tsc --noEmit: 0 errors');
  } else {
    ok(`${count} tsc errors (baseline ${TS_ERROR_BASELINE}${count < TS_ERROR_BASELINE ? `, ${TS_ERROR_BASELINE - count} cleared — lower the baseline` : ''})`);
  }
}

runFastspawnSyntaxCheck();
runTypecheckRatchet();

if (skipTests) {
  info('regression tests skipped (--skip tests)');
} else {
  runRegressionTests();
}

// ============================================================
// I. Summary
// ============================================================
finish();
