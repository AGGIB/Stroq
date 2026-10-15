// Sanitizes candidate observations; produces clean fixture files for Copilot CLI.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cleanFixture, leaksIn } from '../packages/cli/test/live/drivers/clean-fixture.js';
import { assertThrowaway } from '../packages/cli/src/live/throwaway.js';
import { assertWriteAllowed } from '../packages/cli/src/harden/atomic.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  throw new Error(
    'usage: tsx scripts/clean-copilot-fixture.ts <raw directory> <fixture directory>',
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid capture JSON; inspect the raw file locally');
  }
}

const POSSIBLE_CREDENTIAL =
  /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|"(?:password|api_key|authorization|access_token)"\s*:/i;
const CREDENTIAL_KEY = /^(?:password|api_key|authorization|access_token)$/i;

/** Captured file bodies can themselves contain JSON encoded inside the host record. */
function assertNoCredentials(raw: string): void {
  const pending: unknown[] = [raw];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      if (POSSIBLE_CREDENTIAL.test(value)) {
        throw new Error('raw capture contains possible credentials; remove them before cleaning');
      }
      if (/^\s*["\[{]/.test(value)) {
        try {
          pending.push(JSON.parse(value));
        } catch {
          // Ordinary command text need not be JSON.
        }
      }
    } else if (Array.isArray(value)) {
      for (const each of value) pending.push(each);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, each] of Object.entries(value)) {
        if (CREDENTIAL_KEY.test(key)) {
          throw new Error('raw capture contains possible credentials; remove them before cleaning');
        }
        pending.push(each);
      }
    }
  }
}

const locationText = readFileSync(join(input, 'location.json'), 'utf8');
const versionText = readFileSync(join(input, 'version.json'), 'utf8');
assertNoCredentials(locationText);
assertNoCredentials(versionText);
const location = safeJson(locationText) as {
  project?: string;
  home?: string;
  stroqHome?: string;
  root?: string;
};
const version = safeJson(versionText) as Record<string, unknown>;

if (
  !location.project ||
  !location.root ||
  typeof version['version'] !== 'string' ||
  !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version['version']) ||
  !['darwin', 'linux', 'win32'].includes(String(version['os']))
) {
  throw new Error('missing capture metadata; no version or OS is invented');
}

// Copy audit.jsonl from stroqHome if present and not already in raw input directory
if (
  !existsSync(join(input, 'audit.jsonl')) &&
  location.stroqHome &&
  existsSync(join(location.stroqHome, 'audit.jsonl'))
) {
  assertThrowaway(location.root);
  assertThrowaway(location.stroqHome);
  const audit = assertWriteAllowed(join(location.stroqHome, 'audit.jsonl'), {
    root: location.root,
    initRule: false,
  });
  writeFileSync(join(input, 'audit.jsonl'), readFileSync(audit, 'utf8'), {
    flag: 'wx',
    mode: 0o600,
  });
}

const hooks = readFileSync(join(input, 'hooks.jsonl'), 'utf8');
if (!hooks.trim()) throw new Error('no host hook invocations were recorded');

const snapshots = readdirSync(input).filter((name) => name.endsWith('.snapshot.json'));
if (snapshots.length < 2) throw new Error('record before and after disk snapshots');

const files = [
  'hooks.jsonl',
  ...(existsSync(join(input, 'audit.jsonl')) ? ['audit.jsonl'] : []),
  ...snapshots,
];

const ids = new Map<string, string>();
const idKeys = new Set([
  'conversation_id',
  'session_id',
  'generation_id',
  'tool_use_id',
  'sessionId',
  'toolUseId',
]);

function anonymizeIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(anonymizeIds);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, each]) => {
      if (idKeys.has(key) && typeof each === 'string' && each !== '') {
        if (!ids.has(each)) {
          ids.set(each, `copilot-fixture-id-${String(ids.size + 1).padStart(4, '0')}`);
        }
        return [key, ids.get(each)];
      }
      return [key, anonymizeIds(each)];
    }),
  );
}

const fixtureRoot =
  version['os'] === 'win32' ? 'C:\\stroq-live-fixture' : '/tmp/stroq-live-fixture';
const fixturePath = (name: string): string =>
  fixtureRoot + (version['os'] === 'win32' ? '\\' : '/') + name;

const renames = [
  [location.project, fixturePath('project')],
  [location.stroqHome ?? '', fixturePath('stroq-home')],
  [location.home ?? '', fixturePath('home')],
  [location.root, fixtureRoot],
  [resolve(input), fixturePath('capture')],
].filter(([from]) => from !== '') as [string, string][];

renames.push(
  ...renames.map(([from, to]): [string, string] => [
    JSON.stringify(from).slice(1, -1),
    JSON.stringify(to).slice(1, -1),
  ]),
);
renames.sort((a, b) => b[0].length - a[0].length);

const candidates = files.map((name) => {
  const raw = readFileSync(join(input, name), 'utf8');
  assertNoCredentials(raw);

  const lines = (
    name.endsWith('.jsonl') ? raw.split('\n').filter((line) => line.trim() !== '') : [raw]
  )
    .map((line) => {
      assertNoCredentials(line);
      return JSON.stringify(anonymizeIds(safeJson(line)));
    })
    .join('\n');

  let relocated = lines;
  for (const [from, to] of renames) {
    relocated = relocated.split(from).join(to);
  }

  let cleaned: string;
  try {
    cleaned = cleanFixture(relocated).replace(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
      'fixture-user@example.invalid',
    );
    const opUser = process.env.USER || process.env.USERNAME;
    if (opUser && opUser !== 'fixture-user') {
      cleaned = cleaned.replaceAll(opUser, 'fixture-user');
    }
  } catch {
    throw new Error('invalid hook JSONL; inspect the raw file locally');
  }

  const leaks = leaksIn(cleaned);
  if (leaks.length > 0) {
    throw new Error(`candidate still contains private paths or identities: ${leaks.join(', ')}`);
  }
  const text = name.endsWith('.jsonl')
    ? cleaned.trimEnd() + '\n'
    : JSON.stringify(safeJson(cleaned), null, 2) + '\n';
  return [name, text] as const;
});

mkdirSync(output, { recursive: true });
const sha256Map: Record<string, string> = {};

for (const [name, text] of candidates) {
  writeFileSync(join(output, name), text);
  const hash = createHash('sha256').update(text, 'utf8').digest('hex');
  sha256Map[name] = hash;
}

const recorded = candidates
  .find(([name]) => name === 'hooks.jsonl')![1]
  .trim()
  .split('\n')
  .map(
    (line) => safeJson(line) as { phase?: string; input?: { toolName?: unknown }; at?: unknown },
  );
const toolsAt = (phase: string): string[] =>
  [
    ...new Set(
      recorded
        .filter((record) => record.phase === phase && typeof record.input?.toolName === 'string')
        .map((record) => record.input!.toolName as string),
    ),
  ].sort();
const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  !Number.isNaN(Date.parse(value));
const observedDates = [
  ...new Set(
    recorded
      .map((record) => (isTimestamp(record.at) ? record.at.slice(0, 10) : null))
      .filter((date): date is string => date !== null),
  ),
].sort();
const build = version['stroqBuild'] as
  { packageVersion?: unknown; cliSha256?: unknown } | undefined;
const capturedBuild =
  build !== undefined &&
  build !== null &&
  typeof build.packageVersion === 'string' &&
  typeof build.cliSha256 === 'string' &&
  /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(build.packageVersion) &&
  /^[0-9a-f]{64}$/.test(build.cliSha256);

const manifest = {
  host: 'copilot',
  version: version['version'],
  os: version['os'],
  capturePreparedAt: isTimestamp(version['preparedAt']) ? version['preparedAt'] : null,
  observedDates,
  kind: 'unreviewed-host-candidate',
  provenance:
    'Sanitized candidate hook records and disk snapshots. Host origin, enforcement, and control success require independent review before promotion to recorded-host.',
  scope: {
    observedPreToolNames: toolsAt('pre'),
    observedPostToolNames: toolsAt('post'),
    enforcement: 'unverified',
    control: 'unverified',
  },
  sanitization: [
    'Exact private paths replaced with /tmp/stroq-live-fixture equivalents.',
    'Session and tool ids replaced with deterministic aliases.',
    'User emails sanitized; possible credentials cause refusal.',
  ],
  files: files,
  sha256: sha256Map,
  stroqBuild: capturedBuild
    ? {
        packageVersion: build.packageVersion,
        cliSha256: build.cliSha256,
        provenance: 'recorded at capture preparation',
      }
    : { provenance: 'not recorded at capture time; no identity inferred from this checkout' },
};

writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Sanitized Copilot fixture written to ${output}`);
