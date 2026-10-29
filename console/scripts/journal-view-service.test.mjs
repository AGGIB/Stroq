import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
  appendFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';
import { AuditLog } from '../../packages/core/dist/index.js';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const loader = await mkdtemp(join(tmpdir(), 'stroq-journal-loader-'));
after(() => rm(loader, { recursive: true, force: true }));
const tsconfig = join(loader, 'tsconfig.json');
await writeFile(
  tsconfig,
  JSON.stringify({
    compilerOptions: {
      baseUrl: repositoryRoot,
      paths: { '@stroq/core': ['packages/core/src/index.ts'] },
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
    },
  }),
);
const imported = (path) => tsImport(path, { parentURL: import.meta.url, tsconfig });
const { createJournalViewService } = await imported('./journal-view-service.ts');
const schemas = await imported('../lib/journal-view.ts');

const NOW = new Date('2026-10-27T10:00:00.000Z');
const POSIX = process.platform !== 'win32';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-journal-test-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'state');
  await mkdir(home, { mode: 0o700 });
  const file = join(home, 'audit.jsonl');
  const service = createJournalViewService({ home, now: () => NOW });
  const log = new AuditLog(file, () => NOW);
  return { root, home, file, service, log };
}
const input = (tool, effect, extra = {}) => ({
  sessionId: 'private-session-id',
  phase: 'pre',
  tool,
  summary: 'private-summary-text',
  classes: [],
  decision: { effect, ruleId: null, reason: 'private reason' },
  ...extra,
});
const token = (cursor) => (cursor === null ? null : `${cursor.seq}.${cursor.lineSha}`);
const tail = async (service, after = null) => {
  const res = await service.tail({ after: token(after) });
  assert.equal(res.status, 200);
  assert.equal(schemas.validateJournalTail(res.body), true, JSON.stringify(res.body).slice(0, 300));
  return res.body;
};
const summary = async (service) => {
  const res = await service.summary();
  assert.equal(res.status, 200);
  assert.equal(
    schemas.validateJournalSummary(res.body),
    true,
    JSON.stringify(res.body).slice(0, 300),
  );
  return res.body;
};
const line = (seq, over = {}) =>
  JSON.stringify({
    seq,
    ts: `2026-10-27T09:${String(Math.floor(seq / 60) % 60).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}.000Z`,
    prevHash: '0'.repeat(64),
    hash: 'a'.repeat(64),
    sessionId: 'raw-session',
    phase: 'pre',
    tool: 'Read',
    summary: 's',
    classes: [],
    decision: { effect: 'allow', ruleId: null, reason: '' },
    ...over,
  });

test('a journal that does not exist is reported as missing, not as an empty success', async (t) => {
  const { service } = await fixture(t);
  const body = await tail(service);
  assert.equal(body.state, 'missing');
  assert.deepEqual(body.rows, []);
  const sum = await summary(service);
  assert.equal(sum.state, 'missing');
  assert.equal(sum.window.rows, 0);
});

test('a first read returns the newest rows, oldest first, with a cursor to continue from', async (t) => {
  const { service, log } = await fixture(t);
  await log.append(input('Read', 'allow'));
  await log.append(
    input('Bash', 'deny', {
      classes: ['shell.network', 'secret.egress'],
      decision: { effect: 'deny', ruleId: 'deny-secret-egress', reason: 'x' },
    }),
  );
  await log.append(
    input('Edit', 'ask', {
      classes: ['shell.destructive'],
      decision: { effect: 'ask', ruleId: 'ask-destructive', reason: 'x' },
    }),
  );
  const body = await tail(service);
  assert.equal(body.cursor, 'start');
  assert.deepEqual(
    body.rows.map((r) => [r.seq, r.tool, r.decision, r.ruleId]),
    [
      [1, 'file-read', 'allow', null],
      [2, 'shell', 'deny', 'deny-secret-egress'],
      [3, 'file-write', 'ask', 'ask-destructive'],
    ],
  );
  assert.equal(body.head.seq, 3);
});

test('a later read from the cursor returns only newer rows, and nothing when there are none', async (t) => {
  const { service, log } = await fixture(t);
  await log.append(input('Read', 'allow'));
  const first = await tail(service);
  const idle = await tail(service, first.head);
  assert.equal(idle.cursor, 'ok');
  assert.deepEqual(idle.rows, []);
  assert.deepEqual(idle.head, first.head);
  await log.append(input('Bash', 'allow'));
  await log.append(input('Grep', 'allow'));
  const next = await tail(service, first.head);
  assert.equal(next.cursor, 'ok');
  assert.deepEqual(
    next.rows.map((r) => [r.seq, r.tool]),
    [
      [2, 'shell'],
      [3, 'search'],
    ],
  );
});

test('a cursor from a different journal is a reset, and the page starts over from the newest rows', async (t) => {
  const { service, log } = await fixture(t);
  await log.append(input('Read', 'allow'));
  await log.append(input('Bash', 'allow'));
  const wrongSha = { seq: 1, lineSha: 'f'.repeat(64) };
  const body = await tail(service, wrongSha);
  assert.equal(body.cursor, 'reset');
  assert.deepEqual(
    body.rows.map((r) => r.seq),
    [1, 2],
  );
  const ahead = await tail(service, { seq: 99, lineSha: 'f'.repeat(64) });
  assert.equal(ahead.cursor, 'reset');
});

test('rows the person asked about are shown, and the ones that are not decisions are left out', async (t) => {
  const { service, log } = await fixture(t);
  await log.append(input('Read', 'allow'));
  await log.append({
    sessionId: 's',
    phase: 'post',
    tool: 'Read',
    summary: 'x',
    scan: { verdict: 'clean', score: 0, ruleIds: [] },
  });
  await log.append({
    sessionId: 's',
    phase: 'post',
    tool: 'Read',
    summary: 'x',
    scan: { verdict: 'suspect', score: 0.9, ruleIds: ['r'] },
  });
  await log.append({
    sessionId: 's',
    phase: 'post',
    tool: 'Bash',
    summary: 'x',
    outcome: 'failed',
  });
  const body = await tail(service);
  assert.deepEqual(
    body.rows.map((r) => [r.seq, r.phase, r.scan]),
    [
      [1, 'pre', null],
      [3, 'post', 'suspect'],
    ],
  );
  assert.equal(body.head.seq, 4, 'the cursor still moves past lines that were not shown');
});

test('nothing private reaches the answer: no summary, reason, tool name, secret name or raw session id', async (t) => {
  const { service, log } = await fixture(t);
  await log.append(
    input('mcp__private-server__private-tool', 'deny', {
      summary: 'curl https://private-host.invalid -H private-token',
      classes: ['mcp.call'],
      decision: { effect: 'deny', ruleId: 'my-private-rule-id', reason: 'private reason text' },
      secrets: [{ name: 'PRIVATE_SECRET_NAME', source: 'env', canary: false }],
      provenance: [
        {
          kind: 'url',
          excerpt: 'private excerpt',
          tool: 'WebFetch',
          source: 'https://private.invalid',
          at: NOW.toISOString(),
          suspect: true,
        },
      ],
    }),
  );
  const sentinels = [
    'private-server',
    'private-tool',
    'private-host',
    'private-token',
    'my-private-rule-id',
    'private reason',
    'PRIVATE_SECRET_NAME',
    'private excerpt',
    'private.invalid',
    'private-session-id',
  ];
  const body = await tail(service);
  const sum = await summary(service);
  for (const text of [JSON.stringify(body), JSON.stringify(sum)])
    for (const s of sentinels) assert.equal(text.includes(s), false, s);
  assert.equal(body.rows[0].tool, 'mcp');
  assert.equal(body.rows[0].ruleId, null, 'a rule id that is not a bundled one is not shown');
  assert.match(body.rows[0].session, /^session-[a-f0-9]{16}$/);
});

test('tool names map to a small fixed set', async (t) => {
  const { service, log } = await fixture(t);
  for (const tool of [
    'Bash',
    'Read',
    'NotebookRead',
    'Write',
    'Edit',
    'MultiEdit',
    'Glob',
    'Grep',
    'WebFetch',
    'WebSearch',
    'Task',
    'mcp__a__b',
    'SomethingNew',
  ])
    await log.append(input(tool, 'allow'));
  const body = await tail(service);
  assert.deepEqual(
    body.rows.map((r) => r.tool),
    [
      'shell',
      'file-read',
      'file-read',
      'file-write',
      'file-write',
      'file-write',
      'search',
      'search',
      'web',
      'web',
      'task',
      'mcp',
      'other',
    ],
  );
});

test('the summary counts decisions and flagged results and lists the notable ones newest first', async (t) => {
  const { service, log } = await fixture(t);
  for (let i = 0; i < 6; i += 1) await log.append(input('Read', 'allow'));
  await log.append(
    input('Bash', 'ask', {
      classes: ['shell.destructive'],
      decision: { effect: 'ask', ruleId: 'ask-destructive', reason: 'x' },
    }),
  );
  await log.append(
    input('Bash', 'deny', {
      classes: ['shell.network'],
      decision: { effect: 'deny', ruleId: 'deny-encoded-exec', reason: 'x' },
    }),
  );
  await log.append({
    sessionId: 's',
    phase: 'post',
    tool: 'Read',
    summary: 'x',
    scan: { verdict: 'suspect', score: 0.9, ruleIds: ['r'] },
  });
  const sum = await summary(service);
  assert.deepEqual(sum.counts, { allow: 6, ask: 1, deny: 1, suspect: 1 });
  assert.equal(sum.window.rows, 9);
  assert.deepEqual(
    sum.notable.map((r) => r.seq),
    [9, 8, 7],
  );
  assert.deepEqual(sum.tools, { 'file-read': 7, shell: 2 });
  assert.deepEqual(sum.classes[0], { class: 'shell.destructive', count: 1 });
});

test('lines that are not records, and an unfinished last line, are skipped and counted', async (t) => {
  const { service, file } = await fixture(t);
  await writeFile(
    file,
    [line(1), 'this is not json', '{"seq":"two"}', line(2), line(3)].join('\n') +
      '\n' +
      line(4).slice(0, 40),
    { mode: 0o600 },
  );
  const body = await tail(service);
  assert.deepEqual(
    body.rows.map((r) => r.seq),
    [1, 2, 3],
  );
  assert.equal(body.unreadable, 2);
  assert.equal(body.head.seq, 3, 'the unfinished line is not read yet');
});

test('a sequence that goes backwards is not shown as if it were in order', async (t) => {
  const { service, file } = await fixture(t);
  await writeFile(file, [line(5), line(6), line(2), line(7)].join('\n') + '\n', { mode: 0o600 });
  const body = await tail(service);
  assert.deepEqual(
    body.rows.map((r) => r.seq),
    [5, 6, 7],
  );
  assert.equal(body.unreadable, 1);
});

test('a backlog is returned 100 rows at a time and the cursor continues where it stopped', async (t) => {
  const { service, file } = await fixture(t);
  const first = Array.from({ length: 250 }, (_, i) => line(i + 1)).join('\n') + '\n';
  await writeFile(file, first, { mode: 0o600 });
  const start = await tail(service, { seq: 1, lineSha: await shaOfLine(file, 1) });
  assert.equal(start.cursor, 'ok');
  assert.equal(start.rows.length, 100);
  assert.deepEqual([start.rows[0].seq, start.rows.at(-1).seq], [2, 101]);
  const next = await tail(service, start.head);
  assert.deepEqual([next.rows[0].seq, next.rows.at(-1).seq], [102, 201]);
  const last = await tail(service, next.head);
  assert.deepEqual([last.rows[0].seq, last.rows.at(-1).seq], [202, 250]);
});

async function shaOfLine(file, seq) {
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const text = (await readFile(file, 'utf8'))
    .split('\n')
    .find((l) => l.startsWith(`{"seq":${seq},`));
  return createHash('sha256').update(text).digest('hex');
}

test('only the newest megabyte is read, and the first partial line in it is dropped', async (t) => {
  const { service, file } = await fixture(t);
  const filler = 'x'.repeat(2000);
  const lines = Array.from({ length: 700 }, (_, i) => line(i + 1, { summary: filler }));
  await writeFile(file, lines.join('\n') + '\n', { mode: 0o600 });
  const body = await tail(service);
  assert.equal(body.windowTruncated, true);
  assert.equal(body.head.seq, 700);
  const sum = await summary(service);
  assert.equal(sum.window.truncated, true);
  assert.ok(sum.window.rows < 700 && sum.window.rows > 400, String(sum.window.rows));
  const gap = await tail(service, { seq: 1, lineSha: 'e'.repeat(64) });
  assert.equal(
    gap.cursor,
    'gap',
    'a cursor older than the window is a gap, with no invented count',
  );
});

test('two reads at once both answer', async (t) => {
  const { service, log } = await fixture(t);
  await log.append(input('Read', 'allow'));
  const [a, b] = await Promise.all([service.tail({ after: null }), service.summary()]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
});

test('a request that is not exactly {after} is refused', async (t) => {
  const { service } = await fixture(t);
  for (const bad of [
    {},
    { after: null, limit: 5000 },
    { after: `0.${'a'.repeat(64)}` },
    { after: '1.x' },
    { after: { seq: 1, lineSha: 'a'.repeat(64) } },
    null,
    [],
  ])
    assert.deepEqual(await service.tail(bad), { status: 400, body: { error: 'invalid-request' } });
});

test('reading writes nothing under the Stroq home', async (t) => {
  const { service, log, home } = await fixture(t);
  await log.append(input('Read', 'allow'));
  const before = (await readdir(home)).sort();
  await tail(service);
  await summary(service);
  assert.deepEqual((await readdir(home)).sort(), before);
});

test(
  'a journal that is a symlink, group-writable or in an unsafe folder is refused',
  { skip: !POSIX },
  async (t) => {
    const { root, home, file, service, log } = await fixture(t);
    await log.append(input('Read', 'allow'));
    await chmod(file, 0o666);
    assert.equal((await tail(service)).state, 'refused');
    await chmod(file, 0o600);
    assert.equal((await tail(service)).state, 'ready');
    await chmod(home, 0o777);
    assert.equal((await tail(service)).state, 'refused');
    await chmod(home, 0o700);
    const real = join(root, 'elsewhere.jsonl');
    await writeFile(real, line(1) + '\n', { mode: 0o600 });
    await rm(file);
    await symlink(real, file);
    const refused = await tail(service);
    assert.equal(refused.state, 'refused');
    assert.deepEqual(refused.rows, []);
    assert.equal(refused.head, null);
  },
);

test('rows appended while reading do not make the read fail', async (t) => {
  const { service, file, log } = await fixture(t);
  await log.append(input('Read', 'allow'));
  const reading = service.tail({ after: null });
  await appendFile(file, line(2) + '\n');
  assert.equal((await reading).status, 200);
});

test('a denied action whose line is long is still shown; a line beyond the cap is counted, not hidden', async (t) => {
  const { service, file } = await fixture(t);
  const big = (seq, size) =>
    line(seq, {
      decision: { effect: 'deny', ruleId: 'deny-secret-egress', reason: 'x' },
      operation: 'o'.repeat(size),
    });
  await writeFile(
    file,
    [line(1), big(2, 100 * 1024), big(3, 400 * 1024), line(4)].join('\n') + '\n',
    {
      mode: 0o600,
    },
  );
  const body = await tail(service);
  assert.deepEqual(
    body.rows.map((r) => [r.seq, r.decision]),
    [
      [1, 'allow'],
      [2, 'deny'],
      [4, 'allow'],
    ],
  );
  assert.equal(body.unreadable, 1, 'the line beyond the cap is counted');
  const sum = await summary(service);
  assert.equal(sum.unreadable, 1);
  assert.equal(sum.counts.deny, 1);
});

test('a suspect result is shown even when the tool call failed, and an ordinary failed call is not', async (t) => {
  const { service, file } = await fixture(t);
  const post = (seq, over) =>
    line(seq, { phase: 'post', decision: undefined, outcome: 'failed', ...over });
  await writeFile(
    file,
    [
      post(1, { scan: { verdict: 'suspect' } }),
      post(2, { scan: { verdict: 'clean' } }),
      line(3, { outcome: 'failed' }),
      line(4),
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
  const body = await tail(service);
  assert.deepEqual(
    body.rows.map((r) => [r.seq, r.phase, r.scan]),
    [
      [1, 'post', 'suspect'],
      [4, 'pre', null],
    ],
  );
});

test('a window that begins exactly on a line boundary keeps that line', async (t) => {
  const { service, file } = await fixture(t);
  // Every line is 1024 bytes with its newline, and 1100 of them leave the 1 MiB window starting at
  // exactly the start of the 77th line, so a reader that always drops the first line loses a whole record.
  const make = (seq) => {
    const base = line(seq, { summary: '' });
    return line(seq, { summary: 'x'.repeat(1023 - Buffer.byteLength(base)) });
  };
  const lines = Array.from({ length: 1100 }, (_, i) => make(1000 + i));
  assert.equal(Buffer.byteLength(lines[0]), 1023);
  await writeFile(file, lines.join('\n') + '\n', { mode: 0o600 });
  const sum = await summary(service);
  assert.equal(sum.window.truncated, true);
  assert.equal(sum.window.rows, 1024, 'lines 77 to 1100 are all in the window');
});

const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const decided = (effect) => ({ decision: { effect, ruleId: null, reason: '' } });
const suspectLine = (seq, ts) =>
  line(seq, {
    ts,
    phase: 'post',
    decision: undefined,
    scan: { verdict: 'suspect', score: 0.9, ruleIds: ['r'] },
  });

test('the summary counts the newest seven local days, oldest first, and leaves older rows out', async (t) => {
  const { service, file } = await fixture(t);
  // Each row's day is its own local date, wherever this runs: a row a minute old can be yesterday.
  const rows = [
    [9 * DAY_MS, 'deny'],
    [3 * DAY_MS, 'ask'],
    [1 * DAY_MS, 'deny'],
    [1 * DAY_MS, 'suspect'],
    [60 * 1000, 'allow'],
    [30 * 1000, 'deny'],
  ];
  const lines = rows.map(([ms, kind], i) =>
    kind === 'suspect'
      ? suspectLine(i + 1, ago(ms))
      : line(i + 1, { ts: ago(ms), ...decided(kind) }),
  );
  await writeFile(file, lines.join('\n') + '\n', { mode: 0o600 });
  const sum = await summary(service);
  assert.equal(sum.days.length, 7);
  assert.equal(sum.days[6].date, schemas.localDate(NOW));
  const dates = new Set(sum.days.map((day) => day.date));
  const expected = new Map(
    sum.days.map((day) => [day.date, { allow: 0, ask: 0, deny: 0, suspect: 0 }]),
  );
  for (const [ms, kind] of rows) {
    const date = schemas.localDate(new Date(NOW.getTime() - ms));
    if (dates.has(date)) expected.get(date)[kind] += 1;
  }
  for (const day of sum.days) {
    const { date, read, ...counts } = day;
    assert.equal(read, 'all');
    assert.deepEqual(counts, expected.get(date), date);
  }
  // The row of nine days ago is in the window and the totals, and in none of the seven days.
  assert.equal(sum.counts.deny, 3);
  assert.equal(
    sum.days.reduce((n, day) => n + day.deny, 0),
    2,
  );
  assert.equal(sum.daysComplete, true);
});

test('a row stamped after today counts today, since it was recorded', async (t) => {
  const { service, file } = await fixture(t);
  await writeFile(
    file,
    [
      line(1, { ts: ago(0), ...decided('allow') }),
      line(2, { ts: ago(-26 * 60 * 60 * 1000), ...decided('deny') }),
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
  const sum = await summary(service);
  assert.equal(sum.days[6].deny, 1);
  assert.equal(sum.daysComplete, true);
});

test('the days are incomplete when the window read begins after the oldest of them', async (t) => {
  const { service, file } = await fixture(t);
  const filler = 'x'.repeat(2000);
  const lines = Array.from({ length: 700 }, (_, i) =>
    line(i + 1, { summary: filler, ts: ago((700 - i) * 1000) }),
  );
  await writeFile(file, lines.join('\n') + '\n', { mode: 0o600 });
  const sum = await summary(service);
  assert.equal(sum.window.truncated, true);
  assert.equal(sum.daysComplete, false, 'the week reaches back past the megabyte that was read');
  // The day the window begins in is read in part, the days before it not at all, the later ones whole.
  const begins = sum.days.findIndex(
    (day) => day.date === schemas.localDate(new Date(sum.window.first)),
  );
  assert.ok(begins >= 0);
  sum.days.forEach((day, i) =>
    assert.equal(day.read, i < begins ? 'none' : i === begins ? 'part' : 'all', day.date),
  );
  for (const day of sum.days.slice(0, begins))
    assert.equal(day.allow + day.ask + day.deny + day.suspect, 0);
});

test('a line that cannot be read makes the week and the count since a visit incomplete', async (t) => {
  const { service, file } = await fixture(t);
  // A damaged line may have held a denial: the page must not say that nothing was denied.
  await writeFile(
    file,
    [
      line(1, { ts: ago(5 * 60 * 60 * 1000) }),
      '{"seq": 2, "ts": "damaged',
      line(3, { ts: ago(60 * 1000) }),
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
  const sum = await summary(service);
  assert.ok(sum.unreadable > 0);
  assert.equal(sum.daysComplete, false);
  const res = await service.since({ since: ago(DAY_MS) });
  assert.equal(schemas.validateJournalSince(res.body), true, JSON.stringify(res.body));
  assert.equal(res.body.complete, false);
  assert.ok(res.body.unreadable > 0);
});

test('what was recorded since a moment is counted from the same window', async (t) => {
  const { service, file } = await fixture(t);
  const lines = [
    line(1, { ts: ago(2 * 60 * 60 * 1000), ...decided('deny') }),
    line(2, { ts: ago(30 * 60 * 1000), ...decided('ask') }),
    suspectLine(3, ago(10 * 60 * 1000)),
    line(4, { ts: ago(5 * 60 * 1000), ...decided('allow') }),
  ];
  await writeFile(file, lines.join('\n') + '\n', { mode: 0o600 });
  const res = await service.since({ since: ago(60 * 60 * 1000) });
  assert.equal(res.status, 200);
  assert.equal(schemas.validateJournalSince(res.body), true, JSON.stringify(res.body));
  assert.deepEqual(res.body.counts, { allow: 1, ask: 1, deny: 0, suspect: 1 });
  assert.equal(res.body.complete, true);
});

test('since a moment older than the window read, the count is not complete', async (t) => {
  const { service, file } = await fixture(t);
  const filler = 'x'.repeat(2000);
  const lines = Array.from({ length: 700 }, (_, i) =>
    line(i + 1, { summary: filler, ts: ago((700 - i) * 1000) }),
  );
  await writeFile(file, lines.join('\n') + '\n', { mode: 0o600 });
  const res = await service.since({ since: ago(DAY_MS) });
  assert.equal(res.status, 200);
  assert.equal(res.body.complete, false);
});

test('since, with no journal, counts nothing and misses nothing', async (t) => {
  const { service } = await fixture(t);
  const res = await service.since({ since: ago(DAY_MS) });
  assert.equal(res.status, 200);
  assert.equal(res.body.state, 'missing');
  assert.deepEqual(res.body.counts, { allow: 0, ask: 0, deny: 0, suspect: 0 });
  assert.equal(res.body.complete, true);
});

test('a moment still to come is refused, not answered as a quiet stretch', async (t) => {
  const { service } = await fixture(t);
  assert.deepEqual(await service.since({ since: '9999-12-31T23:59:59.999Z' }), {
    status: 400,
    body: { error: 'invalid-request' },
  });
  assert.deepEqual(await service.since({ since: ago(-60 * 60 * 1000) }), {
    status: 400,
    body: { error: 'invalid-request' },
  });
  // A clock a little ahead is not refused.
  assert.equal((await service.since({ since: ago(-60 * 1000) })).status, 200);
});

test('a request that is not exactly {since: a moment} is refused', async (t) => {
  const { service } = await fixture(t);
  for (const bad of [
    {},
    { since: 'yesterday' },
    { since: '2026-10-27T10:00:00Z' },
    { since: ago(0), extra: 1 },
    { since: 1730000000000 },
    null,
    [],
  ])
    assert.deepEqual(await service.since(bad), { status: 400, body: { error: 'invalid-request' } });
});
