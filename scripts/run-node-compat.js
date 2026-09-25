'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const script = process.argv[2];
if (!script) {
    console.error('Usage: node scripts/run-node-compat.js <script> [args...]');
    process.exit(2);
}

const major = Number(process.versions.node.split('.')[0]);
const useSystemCa = process.env.OICPP_USE_SYSTEM_CA !== '0' && major >= 22;
const args = useSystemCa
    ? ['--use-system-ca', path.resolve(script), ...process.argv.slice(3)]
    : [path.resolve(script), ...process.argv.slice(3)];
const result = spawnSync(process.execPath, args, { stdio: 'inherit', shell: false });
if (result.error) {
    console.error(result.error.message || String(result.error));
    process.exit(1);
}
process.exit(typeof result.status === 'number' ? result.status : 1);
