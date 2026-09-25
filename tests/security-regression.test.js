'use strict';

const fs = require('fs');
const path = require('path');

let failures = 0;
const check = (name, condition, extra = '') => {
    console.log(`${condition ? '[PASS]' : '[FAIL]'} ${name}${extra ? ' | ' + extra : ''}`);
    if (!condition) failures++;
};

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const mainSource = read('src/main.js');
const preloadSource = read('src/preload.js');
const rendererMainSource = read('src/renderer/js/main.js');
const rendererInitSource = read('src/renderer/js/init.js');
const settingsInitSource = read('src/renderer/js/settings-init.js');
const workerSource = read('src/main-process/compare-worker-v6.js');
const gdbSource = `${read('src/gdb-debugger.js')}\n${read('src/gdb-mi-debugger.js')}`;
const workflows = ['build.yml', 'build-windows-test.yml', 'build-dmg-test.yml']
    .map((name) => read(path.join('.github', 'workflows', name)))
    .join('\n');

check('cloud compilation endpoint is no longer allowlisted', !mainSource.includes("'/api/cloudCompilation'") && !mainSource.includes("'/api/getCloudCompilationResult'"));
check('cloud compiler method is disabled before reading source', read('src/renderer/js/compile-manager.js').includes("this.t('cloudCompile.disabled')"));
check('run-program rejects shell command strings', !mainSource.includes("executablePath.startsWith('cmd /c ')") && mainSource.includes('Shell command strings are disabled'));
check('run-program is routed through the invoke whitelist', preloadSource.includes("'run-program'") && preloadSource.includes("safeIpcRenderer.invoke('run-program'"));
check('GDB breakpoint snapshot API exists', gdbSource.includes('getBreakpoints()'));
check('GDB command timeout is implemented', gdbSource.includes('MI_COMMAND_TIMEOUT_MS'));
check('GDB uses structured MI2 records', gdbSource.includes('--interpreter=mi2') && gdbSource.includes('GdbMiStream'));
check('comparer rejects truncated output', workerSource.includes('output_limit') && workerSource.includes('MAX_WORKER_OUTPUT_BYTES'));
check('comparer uses one output normalization policy', workerSource.includes('function outputsEqual'));
check('workflows do not depend on the Node 22-only system CA flag', !workflows.includes('--use-system-ca'));
check('markdown fallback does not assign untrusted innerHTML', !preloadSource.includes('innerHTML'));
check('Linux hard memory limits use a non-shell prlimit wrapper', read('src/utils/process-supervisor.js').includes('getResourceLimitedSpawn') && read('src/utils/process-supervisor.js').includes('prlimit'));
check('native fastspawn has a reproducible POSIX build script', read('scripts/build-fastspawn.js').includes('node-gyp') && read('binding.gyp').includes('fastspawn.cc'));
check('release downloaders share one hardened implementation', read('scripts/lib/release-downloader.js').includes('maxRedirects') && read('scripts/download-clangd.js').includes('createReleaseDownloader') && read('scripts/download-clang-format.js').includes('createReleaseDownloader'));
check('disabled automatic update checks cannot leave UI busy', !mainSource.includes('function checkDailyUpdate') && !mainSource.includes('setAutoUpdateCheckInProgress(true)'));
check('disabled update checks have no remote fallback', !mainSource.includes('oicpp.mywwzh.top/api/checkUpdate') && !mainSource.includes('oicpp.mywwzh.top/api/getUpdateFilelist') && !mainSource.includes('downloadAndInstallUpdate'));
check('renderer Buffer bridge is removed', !preloadSource.includes("exposeInMainWorld('Buffer'") && !rendererMainSource.includes('window.Buffer') && rendererMainSource.includes('new Uint8Array(arrayBuffer)') && rendererMainSource.includes('btoa(binary)'));
check('renderer startup awaits ordered initialization', /await setUserIconPath\(\)[\s\S]*await window\.i18n\.init\(\)[\s\S]*await initializeApp\(\)/.test(rendererInitSource));
check('startup font validation stays local', !settingsInitSource.includes('updateSettings({ font: validatedFont })') && settingsInitSource.includes('fontFamily = validatedFont'));

console.log(`security regression tests completed: ${failures ? failures + ' failure(s)' : 'all checks passed'}`);
process.exitCode = failures ? 1 : 0;
