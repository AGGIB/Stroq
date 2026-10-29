import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
async function run(args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolveRun() : reject(new Error('Platform package preparation failed.')),
    );
  });
}
// console is deliberately outside the CLI workspace. Its committed lockfile is
// installed independently; no lifecycle hooks or lockfile rewrites are needed.
await run([
  '--dir',
  'console',
  'install',
  '--ignore-workspace',
  '--frozen-lockfile',
  '--ignore-scripts',
]);
await run(['run', 'platform:build']);
