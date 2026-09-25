'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'Release', 'fastspawn.node');
const target = path.join(root, 'fastspawn.node');

if (process.platform === 'win32') {
    console.log('[fastspawn] Windows uses the Node child_process fallback; skipping POSIX native build');
    process.exit(0);
}

const nodeGyp = process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp';
const result = spawnSync(nodeGyp, ['rebuild'], {
    cwd: root,
    stdio: 'inherit',
    shell: false
});
if (result.error || result.status !== 0) {
    throw new Error(`fastspawn native build failed: ${result.error?.message || `exit ${result.status}`}`);
}
if (!fs.existsSync(output)) {
    throw new Error(`fastspawn native build did not produce ${output}`);
}
fs.copyFileSync(output, target);
console.log(`[fastspawn] Installed ${target}`);
