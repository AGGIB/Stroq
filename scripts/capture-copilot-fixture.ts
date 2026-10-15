// Prepare an opt-in capture; only Copilot CLI's actual hook invocations produce records.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createThrowawayRoot, assertThrowaway } from '../packages/cli/src/live/throwaway.js';
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
const location = relative(process.cwd(), target);
if (location === '' || (!isAbsolute(location) && !location.startsWith(`..${sep}`))) {
  throw new Error('raw captures must stay outside the repository');
}

if (action === 'prepare') {
  if (!executable || existsSync(target)) {
    throw new Error('give a Copilot executable and a new output directory');
  }

  const version = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    shell: false,
  });
  if (version.error || version.status !== 0) {
    throw new Error('Copilot version could not be read; no capture prepared');
  }
  const versionString =
    version.stdout
      .trim()
      .split(/\r?\n/)[0]
      ?.replace(/^GitHub Copilot CLI\s*/i, '')
      .replace(/\.$/, '') ?? 'unknown';

  const cli = resolve('packages/cli/dist/index.js');
  if (!existsSync(cli)) {
    throw new Error('run pnpm build before preparing a capture');
  }

  const made = createThrowawayRoot('stroq-copilot-capture-');
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
  const made = JSON.parse(readFileSync(join(target, 'location.json'), 'utf8')) as {
    root: string;
    project: string;
    home: string;
    stroqHome: string;
  };
  assertThrowaway(made.root, 'stroq-copilot-capture-');

  const hookFile = join(made.project, '.github', 'hooks', 'stroq.json');
  const userHookFile1 = join(made.home, '.copilot', 'hooks', 'stroq.json');
  const userHookFile2 = join(made.home, 'hooks', 'stroq.json');

  if (action === 'snapshot') {
    const list = [
      'scratch/write-me.txt',
      'scratch/delete-me.txt',
      '.claude/settings.json',
      'sample.txt',
      '.github/hooks/stroq.json',
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
    const current = JSON.parse(readFileSync(hookFile, 'utf8')) as CopilotHooksFile;
    writeFileSync(join(target, 'hook.backup.json'), JSON.stringify(current, null, 2));
    const disabled: CopilotHooksFile = {
      version: 1,
      hooks: {
        preToolUse: [],
        postToolUse: current.hooks.postToolUse,
      },
    };
    writeFileSync(hookFile, JSON.stringify(disabled, null, 2));
    if (existsSync(userHookFile1)) writeFileSync(userHookFile1, JSON.stringify(disabled, null, 2));
    if (existsSync(userHookFile2)) writeFileSync(userHookFile2, JSON.stringify(disabled, null, 2));
    console.log('Control configured: preToolUse disabled.');
  } else if (action === 'restore') {
    const backup = readFileSync(join(target, 'hook.backup.json'), 'utf8');
    writeFileSync(hookFile, backup);
    if (existsSync(userHookFile1)) writeFileSync(userHookFile1, backup);
    if (existsSync(userHookFile2)) writeFileSync(userHookFile2, backup);
    console.log('Hooks restored from backup.');
  }
}
