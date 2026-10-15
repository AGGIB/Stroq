// Prepare an opt-in capture; only Copilot CLI's actual hook invocations produce records.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  createThrowawayRoot,
  assertThrowaway,
  removeThrowawayRoot,
  type Throwaway,
} from '../packages/cli/src/live/throwaway.js';
import {
  installCopilotHooks,
  type CopilotHooksFile,
} from '../packages/cli/src/commands/copilot-hooks.js';
import { assertWriteAllowed } from '../packages/cli/src/harden/atomic.js';
import { copilotRecorderSource } from './copilot-capture-recorder.js';

const [action, rawTarget, executable] = process.argv.slice(2);
if (!rawTarget || !['prepare', 'snapshot', 'control', 'restore'].includes(action ?? '')) {
  throw new Error(
    'usage: tsx scripts/capture-copilot-fixture.ts prepare <new raw directory outside repo> <Copilot executable>; snapshot <raw directory> <step label>; control|restore <raw directory>',
  );
}
const target = resolve(rawTarget);
for (const [repo, destination] of [
  [process.cwd(), target],
  [realpathSync(process.cwd()), assertWriteAllowed(target, { initRule: false })],
] as const) {
  const location = relative(repo, destination);
  if (location === '' || (!isAbsolute(location) && !location.startsWith(`..${sep}`))) {
    throw new Error('raw captures must stay outside the repository');
  }
}

if (action === 'prepare') {
  if (!executable || existsSync(target)) {
    throw new Error('give a Copilot executable and a new output directory');
  }

  const cli = resolve('packages/cli/dist/index.js');
  if (!existsSync(cli)) {
    throw new Error('run pnpm build before preparing a capture');
  }
  const made = createThrowawayRoot('stroq-copilot-capture-');
  const version = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    shell: false,
    env: {
      ...process.env,
      HOME: made.home,
      USERPROFILE: made.home,
      COPILOT_HOME: made.home,
      STROQ_HOME: made.stroqHome,
    },
  });
  if (version.error || version.status !== 0) {
    removeThrowawayRoot(made.root);
    throw new Error('Copilot version could not be read; no capture prepared');
  }
  const versionString =
    version.stdout
      .trim()
      .split(/\r?\n/)[0]
      ?.replace(/^GitHub Copilot CLI\s*/i, '')
      .replace(/\.$/, '') ?? 'unknown';

  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(versionString)) {
    removeThrowawayRoot(made.root);
    throw new Error('Copilot version could not be read; no capture prepared');
  }

  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(join(target, 'location.json'), JSON.stringify(made, null, 2));
  writeFileSync(
    join(target, 'version.json'),
    JSON.stringify(
      {
        host: 'copilot',
        version: versionString,
        os: process.platform,
        preparedAt: new Date().toISOString(),
        provenance: 'capture-prepared; host behavior not measured',
        stroqBuild: {
          packageVersion: (
            JSON.parse(readFileSync(resolve('packages/cli/package.json'), 'utf8')) as {
              version: string;
            }
          ).version,
          distribution: 'local development build of Stroq CLI',
          cliSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'),
        },
      },
      null,
      2,
    ),
  );

  const recorder = join(target, 'record-hook.mjs');
  writeFileSync(
    recorder,
    copilotRecorderSource({
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
  if (syntax.error || syntax.status !== 0) {
    throw new Error('generated recorder failed syntax validation; no hooks installed');
  }

  const quote = (value: string): string => {
    if (/["\r\n`$%]/.test(value)) {
      throw new Error('capture paths contain unsupported shell characters');
    }
    return `"${value}"`;
  };

  const preCmd = `${quote(process.execPath)} ${quote(recorder)} pre`;
  const postCmd = `${quote(process.execPath)} ${quote(recorder)} post`;

  // Write hooks in project .github/hooks/stroq.json
  installCopilotHooks(join(made.project, '.github', 'hooks', 'stroq.json'), preCmd, postCmd);

  // Also write user-level hooks in made.home/.copilot/hooks and made.home/hooks
  mkdirSync(join(made.home, '.copilot', 'hooks'), { recursive: true });
  mkdirSync(join(made.home, 'hooks'), { recursive: true });
  installCopilotHooks(join(made.home, '.copilot', 'hooks', 'stroq.json'), preCmd, postCmd);
  installCopilotHooks(join(made.home, 'hooks', 'stroq.json'), preCmd, postCmd);

  // Prepare test files and sentinels in throwaway project
  mkdirSync(join(made.project, 'scratch'), { recursive: true });
  writeFileSync(join(made.project, 'scratch', 'delete-me.txt'), 'harmless delete sentinel\n');
  mkdirSync(join(made.project, '.claude'), { recursive: true });
  writeFileSync(
    join(made.project, '.claude', 'settings.json'),
    '{"copilot_fixture":"unchanged"}\n',
  );
  writeFileSync(join(made.project, 'sample.txt'), 'Sample content to be read by Copilot tool.\n');

  console.log(
    `Prepared ${made.project}. Run Copilot against this directory with COPILOT_HOME=${made.home}.`,
  );
} else {
  const label = executable;
  if (action === 'snapshot' && (!label || !/^[a-z0-9-]{1,40}$/.test(label))) {
    throw new Error('snapshot needs a plain step label');
  }
  const made = JSON.parse(readFileSync(join(target, 'location.json'), 'utf8')) as Throwaway;
  assertThrowaway(made.root);
  for (const [key, name] of [
    ['project', 'project'],
    ['home', 'home'],
    ['stroqHome', 'stroq-home'],
  ] as const) {
    assertThrowaway(made[key]);
    if (realpathSync(made[key]) !== join(realpathSync(made.root), name)) {
      throw new Error('capture location is not the prepared throwaway location');
    }
  }
  const captureFile = (root: string, path: string): string => {
    const file = join(root, path);
    assertWriteAllowed(file, { root, initRule: false });
    return file;
  };
  const hookFiles = [
    captureFile(made.project, '.github/hooks/stroq.json'),
    captureFile(made.home, '.copilot/hooks/stroq.json'),
    captureFile(made.home, 'hooks/stroq.json'),
  ];
  const backupFile = join(target, 'hook.backup.json');

  if (action === 'snapshot') {
    const list = [
      'scratch/write-me.txt',
      'scratch/delete-me.txt',
      '.claude/settings.json',
      'sample.txt',
      '.github/hooks/stroq.json',
    ];
    const files = list.map((rel) => {
      const abs = captureFile(made.project, rel);
      const exists = existsSync(abs);
      return {
        path: rel,
        exists,
        content: exists ? readFileSync(abs, 'utf8') : null,
      };
    });
    writeFileSync(
      join(target, `${label}.snapshot.json`),
      JSON.stringify({ at: new Date().toISOString(), label, files }, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    console.log(`Snapshot ${label} recorded.`);
  } else if (action === 'control') {
    const backups = hookFiles.map((file) => {
      const original = readFileSync(file, 'utf8');
      const current = JSON.parse(original) as CopilotHooksFile;
      const entries = current.hooks?.preToolUse;
      if (
        !Array.isArray(entries) ||
        entries.length !== 1 ||
        typeof entries[0]?.bash !== 'string' ||
        !entries[0].bash.includes(join(target, 'record-hook.mjs')) ||
        !entries[0].bash.endsWith(' pre')
      ) {
        throw new Error('refusing to disable an unexpected gate');
      }
      const control =
        JSON.stringify({ ...current, hooks: { ...current.hooks, preToolUse: [] } }, null, 2) + '\n';
      return { original, control };
    });
    writeFileSync(backupFile, JSON.stringify(backups, null, 2), { flag: 'wx', mode: 0o600 });
    for (const [index, file] of hookFiles.entries()) writeFileSync(file, backups[index]!.control);
    console.log('Control configured: preToolUse disabled.');
  } else if (action === 'restore') {
    const backups: unknown = JSON.parse(readFileSync(backupFile, 'utf8'));
    if (
      !Array.isArray(backups) ||
      backups.length !== hookFiles.length ||
      backups.some(
        (value) =>
          value === null ||
          typeof value !== 'object' ||
          typeof value.original !== 'string' ||
          typeof value.control !== 'string',
      )
    ) {
      throw new Error('invalid enforcing hook backup');
    }
    // Inspect every file first: a changed user copy must not leave a partially restored gate.
    for (const [index, file] of hookFiles.entries()) {
      const current = readFileSync(file, 'utf8');
      if (current !== backups[index].control && current !== backups[index].original) {
        throw new Error('control hooks changed externally; refusing to overwrite');
      }
    }
    for (const [index, file] of hookFiles.entries()) writeFileSync(file, backups[index].original);
    console.log('Hooks restored from backup.');
  }
}
