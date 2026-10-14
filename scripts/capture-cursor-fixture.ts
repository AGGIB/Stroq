// Prepare an opt-in capture; only Cursor's actual hook invocations produce records.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createThrowawayRoot, assertThrowaway } from '../packages/cli/src/live/throwaway.js';
import { installCursorHooks } from '../packages/cli/src/commands/cursor-hooks.js';
import { cursorRecorderSource } from './cursor-capture-recorder.js';

const [action, target, executable] = process.argv.slice(2);
if (!target || !['prepare', 'snapshot', 'control', 'restore'].includes(action ?? ''))
  throw new Error(
    'usage: tsx scripts/capture-cursor-fixture.ts prepare <new raw directory outside repo> <Cursor executable>; snapshot <raw directory> <step label>; control|restore <raw directory>',
  );
const location = relative(process.cwd(), resolve(target));
if (location === '' || (!isAbsolute(location) && !location.startsWith(`..${sep}`)))
  throw new Error('raw captures must stay outside the repository');

if (action === 'prepare') {
  if (!executable || existsSync(target))
    throw new Error('give a Cursor executable and a new output directory');
  // The Windows desktop executable needs the same Electron CLI entry as cursor.cmd.
  const windowsDesktop =
    process.platform === 'win32' && basename(executable).toLowerCase() === 'cursor.exe';
  const desktopCli = join(dirname(resolve(executable)), 'resources', 'app', 'out', 'cli.js');
  if (windowsDesktop && !existsSync(desktopCli))
    throw new Error('Cursor desktop CLI entry is missing; no capture prepared');
  const version = spawnSync(
    executable,
    windowsDesktop ? [desktopCli, '--version'] : ['--version'],
    {
      encoding: 'utf8',
      timeout: 10_000,
      shell: false,
      ...(windowsDesktop
        ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } }
        : {}),
    },
  );
  if (version.error || version.status !== 0 || !/^\d+\.\d+\.\d+/m.test(version.stdout ?? ''))
    throw new Error('Cursor version could not be read; no capture prepared');
  const cli = resolve('packages/cli/dist/index.js');
  if (!existsSync(cli)) throw new Error('run pnpm build before preparing a capture');
  const made = createThrowawayRoot('stroq-cursor-capture-');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(join(target, 'location.json'), JSON.stringify(made, null, 2));
  writeFileSync(
    join(target, 'version.json'),
    JSON.stringify(
      {
        host: 'cursor',
        version: version.stdout.trim().split(/\r?\n/)[0],
        os: process.platform,
        preparedAt: new Date().toISOString(),
        provenance: 'capture-prepared; host behavior not measured',
      },
      null,
      2,
    ),
  );
  const recorder = join(target, 'record-hook.mjs');
  writeFileSync(
    recorder,
    cursorRecorderSource({
      node: process.execPath,
      cli,
      log: join(target, 'hooks.jsonl'),
      home: made.home,
      stroqHome: made.stroqHome,
    }),
  );
  const syntax = spawnSync(process.execPath, ['--check', recorder], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (syntax.error || syntax.status !== 0)
    throw new Error('generated recorder failed syntax validation; no hooks installed');
  const quote = (value: string): string => {
    if (/["\r\n`$%]/.test(value))
      throw new Error('capture paths contain unsupported shell characters');
    return `"${value}"`;
  };
  installCursorHooks(
    join(made.project, '.cursor', 'hooks.json'),
    `${quote(process.execPath)} ${quote(recorder)}`,
  );
  mkdirSync(join(made.project, 'scratch'));
  writeFileSync(join(made.project, 'scratch', 'delete-me.txt'), 'harmless delete sentinel\n');
  mkdirSync(join(made.project, '.claude'));
  writeFileSync(join(made.project, '.claude', 'settings.json'), '{"cursor_fixture":"unchanged"}\n');
  console.log(
    `Prepared ${made.project}. Open it in the selected Cursor installation. No host action or model request has run.`,
  );
} else {
  const label = executable;
  if (action === 'snapshot' && (!label || !/^[a-z0-9-]{1,40}$/.test(label)))
    throw new Error('snapshot needs a plain step label');
  const made = JSON.parse(readFileSync(join(target, 'location.json'), 'utf8')) as {
    root: string;
    project: string;
  };
  assertThrowaway(made.root);
  assertThrowaway(made.project);
  if (realpathSync(made.project) !== join(realpathSync(made.root), 'project'))
    throw new Error('snapshot project is not the prepared throwaway project');
  const hooksFile = join(made.project, '.cursor', 'hooks.json');
  const backup = join(target, 'enforcing-hooks.json');
  const controlCopy = join(target, 'control-hooks-config.json');
  if (action === 'control') {
    const original = readFileSync(hooksFile, 'utf8');
    const config = JSON.parse(original) as { hooks?: Record<string, unknown> };
    const entries = config.hooks?.['preToolUse'];
    if (
      !Array.isArray(entries) ||
      entries.length !== 1 ||
      typeof entries[0]?.command !== 'string' ||
      !entries[0].command.includes(join(resolve(target), 'record-hook.mjs'))
    )
      throw new Error('refusing to disable an unexpected gate');
    const control =
      JSON.stringify({ ...config, hooks: { ...config.hooks, preToolUse: [] } }, null, 2) + '\n';
    // Exclusive creation is the existence check; never replace an earlier backup.
    writeFileSync(backup, original, { flag: 'wx', mode: 0o600 });
    writeFileSync(controlCopy, control, { flag: 'wx', mode: 0o600 });
    writeFileSync(hooksFile, control);
    console.log(
      'Private preToolUse gate disabled for the explicit control only. Observation hooks remain. No model request ran.',
    );
    exitAction();
  }
  if (action === 'restore') {
    if (readFileSync(hooksFile, 'utf8') !== readFileSync(controlCopy, 'utf8'))
      throw new Error('control hooks changed externally; refusing to overwrite');
    writeFileSync(hooksFile, readFileSync(backup, 'utf8'));
    console.log('Restored the private enforcing gate. No model request ran.');
    exitAction();
  }
  const paths = [
    'scratch/write-me.txt',
    'scratch/delete-me.txt',
    '.cursor/hooks.json',
    '.claude/settings.json',
  ];
  const files = paths.map((path) => {
    const file = join(made.project, path);
    return {
      path,
      exists: existsSync(file),
      content: existsSync(file) ? readFileSync(file, 'utf8') : null,
    };
  });
  writeFileSync(
    join(target, `${label}.snapshot.json`),
    JSON.stringify({ at: new Date().toISOString(), files }, null, 2),
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Recorded disk state only; no host enforcement conclusion inferred.');
}

function exitAction(): never {
  process.exit(0);
}
