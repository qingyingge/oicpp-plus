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

// 沿用 pnpm 为生命周期注入的 npm_config_node_gyp 入口：与 gypfile 隐式构建的命令逐字一致，
// POSIX 行为不变，且不要求 PATH 上有 node-gyp。不经生命周期调用时（pnpm run prebuild:native）退回裸命令名。
const nodeGypEntry = process.env.npm_config_node_gyp;
const command = nodeGypEntry ? process.execPath : 'node-gyp';
const args = nodeGypEntry ? [nodeGypEntry, 'rebuild'] : ['rebuild'];
const result = spawnSync(command, args, {
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
