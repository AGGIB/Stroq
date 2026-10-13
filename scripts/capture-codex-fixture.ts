// Manual subscription-only capture of the production driver and verifyHost, capped at three requests.
// Raw output stays outside the repository. Authentication files are never read or copied.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_POLICY } from '../packages/core/src/index.js';
import { windowsHookCommands } from '../packages/cli/src/commands/hook-command.js';
import { createCodexDriver } from '../packages/cli/src/live/drivers/codex.js';
import { realSpawn, type HostSpawn } from '../packages/cli/src/live/drivers/host-process.js';
import { openLedger } from '../packages/cli/src/live/budget.js';
import { buildProbes, newFakeSecret, readSentinel } from '../packages/cli/src/live/probes.js';
import { createThrowawayRoot } from '../packages/cli/src/live/throwaway.js';
import { verifyHost } from '../packages/cli/src/live/verify.js';

const target = process.argv[2];
if (target === undefined)
  throw new Error(
    'usage: tsx scripts/capture-codex-fixture.ts <raw output directory outside the repository>',
  );
const outputLocation = relative(process.cwd(), resolve(target));
if (
  outputLocation === '' ||
  (!isAbsolute(outputLocation) && !outputLocation.startsWith(`..${sep}`))
)
  throw new Error('raw captures must be written outside the repository');
if (existsSync(target)) throw new Error('use a new raw capture directory to avoid mixing runs');
const made = createThrowawayRoot('stroq-codex-capture-');
mkdirSync(target, { recursive: true });
writeFileSync(join(target, 'location.json'), JSON.stringify(made));
const cli = resolve('packages/cli/dist/index.js');
const hookLine =
  process.platform === 'win32'
    ? windowsHookCommands(process.execPath, cli, 'codex')[0]!
    : `"${process.execPath}" "${cli}" hook codex`;
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
);
const fake = newFakeSecret();
const spawn: HostSpawn = (file, args, options) => {
  const child = realSpawn(file, args, options);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.on('close', (exitCode) => {
    if (args[0] !== 'exec') {
      const name = args[0] === '--version' ? 'version' : 'login';
      writeFileSync(join(target, `${name}.json`), JSON.stringify({ exitCode, stdout, stderr }));
      return;
    }
    const prompt = args.at(-1)!;
    const nonce = /stroq-live-[0-9a-f]{16}/.exec(prompt)?.[0];
    if (nonce === undefined) throw new Error('the driver prompt has no nonce');
    const control = args.some(
      (word) => word.startsWith('hooks.PreToolUse=') && word.includes('node -e 0'),
    );
    const kind = prompt.includes('git config --file') ? 'deny' : 'allow';
    const name = `${kind}.${control ? 'control' : 'real'}`;
    const probe = buildProbes(nonce, fake, made.project, 'native').find((p) => p.id === kind)!;
    writeFileSync(join(target, `${name}.jsonl`), stdout);
    writeFileSync(join(target, `${name}.stderr.txt`), stderr);
    writeFileSync(
      join(target, `${name}.invocation.json`),
      JSON.stringify({ argv: args, cwd: options.cwd }),
    );
    writeFileSync(
      join(target, `${name}.evidence.json`),
      JSON.stringify({ exitCode, sentinel: readSentinel(made.project, probe) }),
    );
    try {
      writeFileSync(
        join(target, `${name}.audit.jsonl`),
        readFileSync(join(made.stroqHome, 'audit.jsonl')),
      );
    } catch {
      writeFileSync(join(target, `${name}.audit.jsonl`), '');
    }
  });
  return child;
};
const driver = createCodexDriver({ hookLine, bin: env['STROQ_CODEX_BIN'] ?? 'codex', env, spawn });
const ledger = openLedger({ path: join(resolve(target), 'ledger.json'), limit: 3 });
const result = await verifyHost(
  driver,
  { ...made, env, deadlineMs: 120_000 },
  {
    agent: 'codex',
    policy: DEFAULT_POLICY,
    stroqVersion: '0.25.0',
    ledger,
    maxRequests: 3,
    ids: { fake: () => fake },
  },
);
writeFileSync(join(target, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
