// Prepare an opt-in capture of the plugin/CLI boundary; native host origin needs separate review.
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
  installOpenClawPlugin,
  packagedPluginDir,
} from '../packages/cli/src/commands/openclaw-plugin.js';
import { assertWriteAllowed } from '../packages/cli/src/harden/atomic.js';
import { openclawRecorderSource } from './openclaw-capture-recorder.js';

const [action, rawTarget, executable] = process.argv.slice(2);
if (!rawTarget || !['prepare', 'snapshot', 'control', 'restore'].includes(action ?? '')) {
  throw new Error(
    'usage: tsx scripts/capture-openclaw-fixture.ts prepare <new raw directory outside repo> <OpenClaw executable>; snapshot <raw directory> <step label>; control|restore <raw directory>',
  );
}

const target = resolve(rawTarget);
for (const [repo, destination] of [
  [process.cwd(), target],
  [realpathSync(process.cwd()), assertWriteAllowed(target, { initRule: false })],
] as const) {
  const location = relative(repo, destination);
  if (
    location === '' ||
    (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`))
  ) {
    throw new Error('raw captures must stay outside the repository');
  }
}

if (action === 'prepare') {
  if (!executable || existsSync(target)) {
    throw new Error('give an OpenClaw executable and a new output directory');
  }

  const cli = resolve('packages/cli/dist/index.js');
  if (!existsSync(cli)) throw new Error('run pnpm build before preparing a capture');
  const made = createThrowawayRoot('stroq-openclaw-capture-');
  const version = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    shell: false,
    cwd: made.project,
    env: {
      ...process.env,
      HOME: made.home,
      USERPROFILE: made.home,
      OPENCLAW_HOME: made.home,
      OPENCLAW_STATE_DIR: join(made.home, '.openclaw'),
      OPENCLAW_CONFIG_PATH: join(made.home, '.openclaw', 'openclaw.json'),
      OPENCLAW_WORKSPACE_DIR: made.project,
      STROQ_HOME: made.stroqHome,
    },
  });
  const versionString =
    version.stdout
      ?.trim()
      .split(/\r?\n/)[0]
      ?.replace(/^OpenClaw\s*/i, '')
      .replace(/\s*\(.*\)$/, '') ?? '';
  if (
    version.error ||
    version.status !== 0 ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(versionString)
  ) {
    removeThrowawayRoot(made.root);
    throw new Error('OpenClaw version could not be read; no capture prepared');
  }

  mkdirSync(target, { recursive: true, mode: 0o700 });
  writeFileSync(join(target, 'location.json'), JSON.stringify(made, null, 2));
  writeFileSync(
    join(target, 'version.json'),
    JSON.stringify(
      {
        host: 'openclaw',
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
    openclawRecorderSource({
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
    throw new Error('generated recorder failed syntax validation; no plugin installed');
  }

  // Materialize plugin in made.home/.stroq/openclaw-plugin
  const pluginDir = join(made.home, '.stroq', 'openclaw-plugin');
  installOpenClawPlugin(pluginDir, [process.execPath, recorder]);

  // Prepare test files and sentinels in throwaway project
  mkdirSync(join(made.project, 'scratch'), { recursive: true });
  writeFileSync(join(made.project, 'scratch', 'delete-me.txt'), 'harmless delete sentinel\n');
  mkdirSync(join(made.project, '.claude'), { recursive: true });
  writeFileSync(
    join(made.project, '.claude', 'settings.json'),
    '{"openclaw_fixture":"unchanged"}\n',
  );
  writeFileSync(join(made.project, 'sample.txt'), 'Sample content to be read by OpenClaw tool.\n');

  console.log(`Prepared ${made.project}. Plugin installed at ${pluginDir}.`);
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
  const pluginDir = captureFile(made.home, '.stroq/openclaw-plugin');
  const indexJs = captureFile(pluginDir, 'index.js');
  const backupFile = assertWriteAllowed(join(target, 'index.backup.json'), {
    root: target,
    initRule: false,
  });
  const disable = (original: string): string => {
    const gate = /api\.on\(\s*'before_tool_call'[\s\S]*?\{\s*priority:\s*100\s*\},?\s*\);/g;
    const matches = [...original.matchAll(gate)];
    if (matches.length !== 1) throw new Error('refusing to disable an unexpected gate');
    return original.replace(
      gate,
      "api.on('before_tool_call', async () => undefined, { priority: 100 });",
    );
  };

  if (action === 'snapshot') {
    const list = [
      'scratch/write-me.txt',
      'scratch/delete-me.txt',
      '.claude/settings.json',
      'sample.txt',
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
    const original = readFileSync(indexJs, 'utf8');
    const command = JSON.parse(readFileSync(captureFile(pluginDir, 'stroq.json'), 'utf8')) as {
      command?: unknown;
    };
    if (
      original !== readFileSync(join(packagedPluginDir(), 'index.js'), 'utf8') ||
      JSON.stringify(command.command) !==
        JSON.stringify([process.execPath, join(target, 'record-hook.mjs')])
    ) {
      throw new Error('refusing to disable an unexpected gate');
    }
    const control = disable(original);
    writeFileSync(backupFile, JSON.stringify({ original, control }), { flag: 'wx', mode: 0o600 });
    writeFileSync(indexJs, control);
    console.log('Control configured: before_tool_call disabled.');
  } else if (action === 'restore') {
    const backup: unknown = JSON.parse(readFileSync(backupFile, 'utf8'));
    if (
      backup === null ||
      typeof backup !== 'object' ||
      !('original' in backup) ||
      typeof backup.original !== 'string' ||
      !('control' in backup) ||
      typeof backup.control !== 'string' ||
      disable(backup.original) !== backup.control
    ) {
      throw new Error('invalid enforcing plugin backup');
    }
    const current = readFileSync(indexJs, 'utf8');
    if (current !== backup.control && current !== backup.original) {
      throw new Error('control plugin changed externally; refusing to overwrite');
    }
    writeFileSync(indexJs, backup.original);
    console.log('Plugin index.js restored from backup.');
  }
}
