// Prepare an opt-in capture; only OpenClaw's actual hook invocations produce records.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createThrowawayRoot, assertThrowaway } from '../packages/cli/src/live/throwaway.js';
import { installOpenClawPlugin } from '../packages/cli/src/commands/openclaw-plugin.js';
import { openclawRecorderSource } from './openclaw-capture-recorder.js';

const [action, rawTarget, executable] = process.argv.slice(2);
if (!rawTarget || !['prepare', 'snapshot', 'control', 'restore'].includes(action ?? '')) {
  throw new Error(
    'usage: tsx scripts/capture-openclaw-fixture.ts prepare <new raw directory outside repo> <OpenClaw executable>; snapshot <raw directory> <step label>; control|restore <raw directory>',
  );
}

const target = resolve(rawTarget);
const location = relative(process.cwd(), target);
if (location === '' || (!isAbsolute(location) && !location.startsWith(`..${sep}`))) {
  throw new Error('raw captures must stay outside the repository');
}

if (action === 'prepare') {
  if (!executable || existsSync(target)) {
    throw new Error('give an OpenClaw executable and a new output directory');
  }

  const version = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    shell: false,
  });
  if (version.error || version.status !== 0) {
    throw new Error('OpenClaw version could not be read; no capture prepared');
  }
  const versionString =
    version.stdout
      .trim()
      .split(/\r?\n/)[0]
      ?.replace(/^OpenClaw\s*/i, '')
      .replace(/\s*\(.*\)$/, '') ?? 'unknown';

  const cli = resolve('packages/cli/dist/index.js');
  if (!existsSync(cli)) {
    throw new Error('run pnpm build before preparing a capture');
  }

  const made = createThrowawayRoot('stroq-openclaw-capture-');
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
  const made = JSON.parse(readFileSync(join(target, 'location.json'), 'utf8')) as {
    root: string;
    project: string;
    home: string;
    stroqHome: string;
  };
  assertThrowaway(made.root, 'stroq-openclaw-capture-');

  const pluginDir = join(made.home, '.stroq', 'openclaw-plugin');
  const indexJs = join(pluginDir, 'index.js');
  const backupJs = join(target, 'index.backup.js');

  if (action === 'snapshot') {
    const list = [
      'scratch/write-me.txt',
      'scratch/delete-me.txt',
      '.claude/settings.json',
      'sample.txt',
    ];
    const files = list.map((rel) => {
      const abs = join(made.project, rel);
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
    );
    console.log(`Snapshot ${label} recorded.`);
  } else if (action === 'control') {
    const current = readFileSync(indexJs, 'utf8');
    writeFileSync(backupJs, current);
    // Replace before_tool_call implementation with pass-through allow
    const disabled = current.replace(
      /api\.on\(\s*'before_tool_call'[\s\S]*?\{\s*priority:\s*100\s*\},?\s*\);/,
      `api.on('before_tool_call', async () => undefined, { priority: 100 });`,
    );
    writeFileSync(indexJs, disabled);
    console.log('Control configured: before_tool_call disabled.');
  } else if (action === 'restore') {
    const backup = readFileSync(backupJs, 'utf8');
    writeFileSync(indexJs, backup);
    console.log('Plugin index.js restored from backup.');
  }
}
