import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';

// The incidents below are made up for these tests in the shape of pwn.watch's list; none is its data.
const imported = (path) => tsImport(path, { parentURL: import.meta.url });
const source = await imported('./threat-feed-source.ts');
const { matchThreats, namedPackages } = await imported('./threat-feed-match.ts');
const { readStack, listedPackages } = await imported('./threat-feed-stack.ts');
const { createThreatFeedService } = await imported('./threat-feed-service.ts');
const schemas = await imported('../lib/threat-feed.ts');

const NOW = new Date('2026-10-28T10:00:00.000Z');
const roots = [];
after(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
async function folder() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-threats-test-')));
  roots.push(root);
  return root;
}

const incident = (slug, over = {}) => ({
  slug,
  title: `Title of ${slug}`,
  url: `https://pwn.watch/i/${slug}`,
  json: `https://pwn.watch/i/${slug}.json`,
  category: 'supply-chain',
  status: 'live',
  severity: 'critical',
  patchStatus: 'partial',
  product: 'something',
  stacks: [],
  tags: [],
  cveIds: [],
  affectedVersions: [],
  fixedVersions: [],
  startedAt: '2026-10-20',
  closedAt: null,
  updatedAt: '2026-10-27T10:00:00Z',
  summary: 'text',
  xPost: null,
  isExample: false,
  ...over,
});
const feed = (incidents) => JSON.stringify({ site: 'https://pwn.watch', incidents });
const parsed = (raw) => source.parseIncident(raw);
const stack = (over = {}) => ({
  ecosystems: new Set(),
  npm: new Set(),
  pypi: new Set(),
  agents: new Set(),
  unread: [],
  ...over,
});

test('an incident is kept only with a slug that is its address, a known kind and a day it began', () => {
  assert.equal(parsed(incident('a-b')).slug, 'a-b');
  assert.equal(parsed(incident('a-b', { url: 'https://evil.example/i/a-b' })), null);
  assert.equal(parsed(incident('A_B')), null);
  assert.equal(parsed(incident('a-b', { category: 'rumour' })), null);
  assert.equal(parsed(incident('a-b', { status: 'maybe' })), null);
  assert.equal(parsed(incident('a-b', { startedAt: 'last week' })), null);
  assert.equal(parsed(incident('a-b', { title: '   ' })), null);
  assert.equal(parsed(null), null);
  assert.equal(parsed([]), null);
});

test('the text shown has no control or invisible characters and is cut to length', () => {
  const kept = parsed(incident('a', { title: 'one\u202e\u0007 two\u200b three', severity: 'odd' }));
  assert.equal(kept.title, 'one two three');
  assert.equal(kept.severity, 'unknown');
  assert.equal([...parsed(incident('a', { title: 'x'.repeat(500) })).title].length, 200);
});

test('a list that is not pwn.watch, or mostly does not fit, is refused whole', () => {
  assert.equal(source.parseFeed('not json'), null);
  assert.equal(
    source.parseFeed(JSON.stringify({ site: 'https://evil.example', incidents: [] })),
    null,
  );
  const bad = Array.from({ length: 3 }, (_, i) => incident(`b${i}`, { category: 'x' }));
  assert.equal(source.parseFeed(feed([incident('a'), ...bad])), null);
  const ok = source.parseFeed(
    feed([incident('a'), incident('a'), incident('b', { status: 'x' }), incident('c')]),
  );
  assert.deepEqual(
    ok.incidents.map((i) => i.slug),
    ['a', 'c'],
  );
  assert.equal(ok.skipped, 2);
});

const response = (body, { status = 200, type = 'application/json', etag = null, length } = {}) => {
  const headers = new Headers({ 'content-type': type });
  if (etag) headers.set('etag', etag);
  if (length !== undefined) headers.set('content-length', String(length));
  return new Response(status === 304 ? null : body, { status, headers });
};

test('the list is downloaded from one address, without redirects, and reused for a while', async () => {
  let at = NOW;
  let tick = 0;
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1
      ? response(feed([incident('a')]), { etag: '"v1"' })
      : response(null, { status: 304 });
  };
  const list = source.createFeedSource({ fetch, now: () => at, clock: () => tick });
  const first = await list.read();
  assert.equal(first.copy.incidents.length, 1);
  assert.equal(calls[0].url, 'https://pwn.watch/incidents.json');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers['if-none-match'], undefined);
  // Nothing about this machine in the request.
  assert.deepEqual(Object.keys(calls[0].init.headers).sort(), ['accept', 'user-agent']);
  await list.read();
  assert.equal(calls.length, 1, 'read again within the refresh time, from the copy');
  // The wall clock set back does not stop a refresh: the wait is measured on a clock that goes on.
  at = new Date(NOW.getTime() - 3 * 60 * 60_000);
  tick += source.REFRESH_MS;
  const again = await list.read();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers['if-none-match'], '"v1"');
  assert.equal(again.copy.incidents.length, 1, 'an unchanged list keeps its copy');
  assert.equal(again.copy.fetchedAt.getTime(), at.getTime());
});

test('"not modified" is taken only for a copy that was asked about', async () => {
  let tick = 0;
  let calls = 0;
  const fetch = async () =>
    ++calls === 1 ? response(feed([incident('a')])) : response(null, { status: 304 });
  const list = source.createFeedSource({ fetch, now: () => NOW, clock: () => tick });
  await list.read();
  tick += source.REFRESH_MS;
  const read = await list.read();
  assert.equal(read.problem, 'network', 'a 304 to a question never asked is not an answer');
  assert.equal(read.copy.fetchedAt.getTime(), NOW.getTime());
});

test('an empty list, or one less than half the list it would replace, is refused', async () => {
  let tick = 0;
  let next = feed(Array.from({ length: 10 }, (_, i) => incident(`n${i}`)));
  const fetch = async () => response(next);
  const list = source.createFeedSource({ fetch, now: () => NOW, clock: () => tick });
  assert.equal((await list.read()).copy.incidents.length, 10);
  for (const [body, problem, kept] of [
    [feed([]), 'invalid', 10],
    [feed([incident('only')]), 'invalid', 10],
    [feed(Array.from({ length: 6 }, (_, i) => incident(`m${i}`))), null, 6],
  ]) {
    next = body;
    tick += source.REFRESH_MS;
    const read = await list.read();
    assert.equal(read.problem, problem);
    assert.equal(read.copy.incidents.length, kept);
  }
});

test('readers at the same moment share one download', async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return response(feed([incident('a')]));
  };
  const list = source.createFeedSource({ fetch, now: () => NOW });
  await Promise.all([list.read(), list.read(), list.read()]);
  assert.equal(calls, 1);
});

test('a failed download says why, keeps the copy it had, and is tried again later', async () => {
  let tick = 0;
  let mode = 'ok';
  const fetch = async (_url, init) => {
    if (mode === 'ok') return response(feed([incident('a')]));
    if (mode === 'html') return response('<html>', { type: 'text/html' });
    if (mode === 'big') return response('x', { length: 5 * 1024 * 1024 });
    if (mode === 'status') return response('', { status: 500 });
    if (mode === 'hang')
      return new Promise((_resolve, reject) =>
        init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    throw new TypeError('fetch failed');
  };
  const list = source.createFeedSource({ fetch, now: () => NOW, clock: () => tick, timeoutMs: 50 });
  await list.read();
  for (const [next, problem] of [
    ['html', 'invalid'],
    ['big', 'too-large'],
    ['status', 'network'],
    ['down', 'network'],
    ['hang', 'timeout'],
  ]) {
    mode = next;
    tick += source.REFRESH_MS;
    const read = await list.read();
    assert.equal(read.problem, problem, next);
    assert.equal(read.copy.incidents.length, 1, `${next}: the older copy is kept`);
    // Just after the failure nothing is downloaded again.
    mode = 'ok';
    tick += 1_000;
    assert.equal((await list.read()).problem, problem);
  }
});

test('after each failure the next try waits twice as long, up to the refresh time', async () => {
  let tick = 0;
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    throw new TypeError('fetch failed');
  };
  const list = source.createFeedSource({ fetch, now: () => NOW, clock: () => tick });
  await list.read();
  for (const wait of [1, 2, 4, 8, 15].map((minutes) => minutes * 60_000)) {
    const before = calls;
    tick += wait - 1;
    await list.read();
    assert.equal(calls, before, `nothing before ${wait / 60_000} min`);
    tick += 1;
    await list.read();
    assert.equal(calls, before + 1, `one try at ${wait / 60_000} min`);
  }
});

test('a body larger than the cap stops the download even without a length', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      sent += 1;
      controller.enqueue(chunk);
      if (sent > 20) controller.close();
    },
  });
  const fetch = async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  const read = await source.createFeedSource({ fetch, now: () => NOW }).read();
  assert.equal(read.problem, 'too-large');
  assert.ok(sent <= 10, `stopped after ${sent} MiB`);
});

test('long hostile text in the list is read in time that grows with its length', () => {
  const entry = `a${'!'.repeat(398)}a`;
  const incidents = Array.from({ length: 700 }, (_, i) =>
    parsed(incident(`h${i}`, { affectedVersions: Array.from({ length: 30 }, () => entry) })),
  );
  const start = process.cpuUsage();
  for (const one of incidents) namedPackages(one);
  matchThreats(incidents, stack({ npm: new Set(['a']) }), NOW);
  const used = process.cpuUsage(start);
  assert.ok(
    (used.user + used.system) / 1000 < 1_500,
    `took ${(used.user + used.system) / 1000} ms`,
  );
});

test('a title is cut to what the page accepts, between characters', () => {
  const title = `${'a'.repeat(98)}${'\u{1F6A8}'.repeat(2)}${'a'.repeat(99)}`;
  const kept = parsed(incident('a', { title })).title;
  assert.ok(kept.length <= 200, `${kept.length} units`);
  assert.equal(kept.at(-1), '…');
  assert.equal(
    [...kept].some((ch) => ch.length === 1 && /[\uD800-\uDFFF]/.test(ch)),
    false,
  );
});

test('characters that show as nothing or reorder text never reach the page', () => {
  assert.equal(parsed(incident('a', { title: '⠀'.repeat(20) })), null);
  assert.equal(parsed(incident('a', { title: 'ㅤᅟﾠ' })), null);
  assert.equal(parsed(incident('a', { title: 'a؜b\u{E0041}c­͏️d⁦e' })).title, 'abcde');
});

test('packages are named as packages: with a version, a mark, a scope or in a listed bracket', () => {
  const named = (product, affected = [], tags = []) =>
    [...namedPackages(parsed(incident('x', { product, affectedVersions: affected, tags })))].sort();
  assert.deepEqual(
    named('LiteLLM (PyPI + Docker images)', ['litellm==1.107.0'], ['litellm', 'ai']),
    ['litellm'],
  );
  assert.deepEqual(named('tensorlake (npm)', ['0.5.144']), ['tensorlake']);
  assert.deepEqual(named('@subql/common (npm) and downstream', ['@subql/common 5.8.3']), [
    '@subql/common',
  ]);
  assert.deepEqual(named('npm ecosystem (keyv, cacheable, flat-cache, and 400+ packages)'), [
    'cacheable',
    'flat-cache',
    'keyv',
  ]);
  assert.deepEqual(named('Widget SDK', ['widget-core before 2.3.0']), ['widget-core']);
  // A language or an ecosystem named in prose is not a package.
  assert.deepEqual(named('x402 SDKs (TypeScript @x402/*, Python x402, Go)', []), []);
  assert.deepEqual(named('OpenCode AI coding agent', ['OpenCode 1.0.137 through 1.18.32']), [
    'opencode',
  ]);
});

test('a package this project lists matches an incident in its ecosystem that names it', () => {
  const incidents = [
    parsed(
      incident('npm-worm', {
        product: 'tensorlake (npm)',
        stacks: ['node', 'npm'],
        affectedVersions: ['0.5.144'],
      }),
    ),
    parsed(
      incident('pypi-one', {
        product: 'Foo_Bar (PyPI)',
        stacks: ['python', 'pypi'],
        affectedVersions: ['foo_bar==1.2.0'],
      }),
    ),
  ];
  const found = matchThreats(
    incidents,
    stack({ npm: new Set(['tensorlake']), pypi: new Set(['foo-bar']) }),
    NOW,
  );
  assert.deepEqual(
    found.map((m) => m.why),
    [
      { kind: 'package', name: 'tensorlake', ecosystem: 'npm' },
      { kind: 'package', name: 'foo-bar', ecosystem: 'pypi' },
    ],
  );
  // The same name in the other ecosystem is another package.
  assert.deepEqual(matchThreats(incidents, stack({ pypi: new Set(['tensorlake']) }), NOW), []);
});

test('a tag names a package only for a patch: elsewhere it may name the company that was hit', () => {
  const hit = parsed(
    incident('vendor-hit', {
      product: 'Widget npm packages / Acme employee laptops',
      stacks: ['node', 'npm'],
      tags: ['acme', 'npm'],
    }),
  );
  assert.deepEqual(matchThreats([hit], stack({ npm: new Set(['acme']) }), NOW), []);
  const patch = parsed(
    incident('acme-cve', {
      category: 'patch',
      product: 'Acme Acme',
      stacks: ['node'],
      tags: ['acme'],
    }),
  );
  assert.deepEqual(
    matchThreats([patch], stack({ npm: new Set(['acme']) }), NOW).map((m) => m.why),
    [{ kind: 'package', name: 'acme', ecosystem: 'npm' }],
  );
});

test('a coding agent matches by its name, never by its vendor tag', () => {
  const incidents = [
    parsed(
      incident('cursor-rce', { category: 'patch', product: 'Cursor AI code editor', tags: ['ai'] }),
    ),
    parsed(
      incident('browser-bug', {
        category: 'patch',
        product: 'Chrome',
        tags: ['chrome', 'anthropic'],
      }),
    ),
    parsed(incident('cursor-word', { category: 'patch', product: 'a cursor-based pager' })),
  ];
  const found = matchThreats(incidents, stack({ agents: new Set(['claude-code', 'cursor']) }), NOW);
  assert.deepEqual(
    found.map((m) => [m.slug, m.why]),
    [['cursor-rce', { kind: 'agent', agent: 'cursor' }]],
  );
});

test('an ecosystem matches only a supply-chain incident pwn.watch still follows or saw lately', () => {
  const incidents = [
    parsed(incident('live-npm', { stacks: ['npm'] })),
    parsed(
      incident('old-npm', {
        stacks: ['npm'],
        status: 'closed',
        updatedAt: '2026-08-01T00:00:00Z',
        startedAt: '2026-07-30',
      }),
    ),
    parsed(incident('patch-npm', { stacks: ['npm'], category: 'patch' })),
    parsed(incident('wp-plugin', { stacks: ['php', 'wordpress'] })),
    parsed(incident('pypi-via-ci', { stacks: ['python', 'pypi', 'docker', 'github-actions'] })),
  ];
  const npmProject = matchThreats(incidents, stack({ ecosystems: new Set(['npm']) }), NOW);
  assert.deepEqual(
    npmProject.map((m) => m.slug),
    ['live-npm'],
  );
  // Filed first under PyPI: a project with workflows is not where it happened.
  assert.deepEqual(
    matchThreats(incidents, stack({ ecosystems: new Set(['github-actions']) }), NOW),
    [],
  );
  assert.deepEqual(matchThreats(incidents, stack({ ecosystems: new Set(['php']) }), NOW), []);
  assert.deepEqual(
    matchThreats(incidents, stack({ ecosystems: new Set(['php', 'wordpress']) }), NOW).map(
      (m) => m.slug,
    ),
    ['wp-plugin'],
  );
});

test('matches come most pressing first: a package, then an agent, then an ecosystem', () => {
  const incidents = [
    parsed(incident('eco', { stacks: ['npm'], severity: 'critical' })),
    parsed(incident('agent', { category: 'patch', product: 'Codex CLI', severity: 'high' })),
    parsed(incident('pkg-high', { product: 'left-pad (npm)', stacks: ['npm'], severity: 'high' })),
    parsed(
      incident('pkg-critical', {
        product: 'right-pad (npm)',
        stacks: ['npm'],
        severity: 'critical',
      }),
    ),
  ];
  const found = matchThreats(
    incidents,
    stack({
      ecosystems: new Set(['npm']),
      npm: new Set(['left-pad', 'right-pad']),
      agents: new Set(['codex']),
    }),
    NOW,
  );
  assert.deepEqual(
    found.map((m) => m.slug),
    ['pkg-critical', 'pkg-high', 'agent', 'eco'],
  );
});

test('the stack is read from a fixed list of project files, never through a link', async () => {
  const root = await folder();
  const project = join(root, 'project');
  const home = join(root, 'home');
  await mkdir(join(project, '.github', 'workflows'), { recursive: true });
  await mkdir(join(home, '.cursor'), { recursive: true });
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({
      dependencies: { Left_Pad: '1', '@scope/x': '1' },
      devDependencies: { vitest: '1' },
    }),
  );
  await writeFile(
    join(project, 'requirements.txt'),
    '# tools\nRequests>=2.31  # web\n-r other.txt\n./local\nhttps://x/y.whl\nFoo_Bar[extra]; python_version>"3"\n',
  );
  await writeFile(join(project, 'Dockerfile'), 'FROM scratch\n');
  await writeFile(join(root, 'outside.toml'), '[project]\ndependencies = ["secret-pkg"]\n');
  await symlink(join(root, 'outside.toml'), join(project, 'pyproject.toml'));
  const found = await readStack({ userHome: home, project });
  assert.deepEqual([...found.ecosystems].sort(), ['docker', 'github-actions', 'npm', 'pypi']);
  assert.deepEqual([...found.npm].sort(), ['@scope/x', 'left_pad', 'vitest']);
  assert.deepEqual([...found.pypi].sort(), ['foo-bar', 'requests']);
  assert.deepEqual(found.unread, ['pyproject.toml']);
  assert.deepEqual([...found.agents], ['cursor']);
});

test('a manifest with another name outside the project (a hard link) is not read', async (t) => {
  if (process.platform === 'win32') return t.skip('hard links need POSIX here');
  const root = await folder();
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(root, 'outside.txt'), 'outer-pkg\n');
  await link(join(root, 'outside.txt'), join(project, 'requirements.txt'));
  const found = await readStack({ userHome: join(root, 'home'), project });
  assert.deepEqual([...found.pypi], []);
  assert.deepEqual(found.unread, ['requirements.txt']);
});

test('a pyproject lists its own, optional, grouped and poetry dependencies', () => {
  const listed = listedPackages('pyproject', {
    project: {
      dependencies: ['httpx>=0.27', 'Flask'],
      'optional-dependencies': { dev: ['pytest'] },
    },
    'dependency-groups': { lint: ['ruff'] },
    tool: {
      poetry: {
        dependencies: { python: '^3.12', Django: '*' },
        group: { docs: { dependencies: { mkdocs: '*' } } },
      },
    },
  });
  assert.deepEqual(listed.pypi.sort(), ['django', 'flask', 'httpx', 'mkdocs', 'pytest', 'ruff']);
});

const fixedFeed = (incidents, problem = null, { fetchedAt = NOW, skipped = 0 } = {}) => ({
  read: async () => ({
    copy:
      incidents === null
        ? null
        : { incidents: incidents.map(parsed), fetchedAt, etag: null, skipped },
    problem,
  }),
});

test('a list more than a day old is not shown, and incidents that could not be read are counted', async () => {
  const root = await folder();
  const incidents = [incident('n', { stacks: ['npm'] })];
  const old = createThreatFeedService({
    userHome: root,
    project: root,
    now: () => NOW,
    feed: fixedFeed(incidents, 'network', { fetchedAt: new Date(NOW.getTime() - 25 * 3600_000) }),
  });
  const stale = await old.read({ source: 'pwn.watch' });
  assert.equal(schemas.validateThreatFeed(stale.body), true);
  assert.equal(stale.body.state, 'unavailable');
  assert.deepEqual(stale.body.matches, []);
  const partial = createThreatFeedService({
    userHome: root,
    project: root,
    now: () => NOW,
    feed: fixedFeed(incidents, null, { skipped: 3 }),
  });
  assert.equal((await partial.read({ source: 'pwn.watch' })).body.compared.skipped, 3);
});

test('the service answers the closed schema, five matches at most, and counts the rest', async () => {
  const root = await folder();
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
  const incidents = Array.from({ length: 7 }, (_, i) => incident(`n${i}`, { stacks: ['npm'] }));
  const service = createThreatFeedService({
    userHome: join(root, 'nohome'),
    project: root,
    now: () => NOW,
    feed: fixedFeed(incidents),
  });
  const res = await service.read({ source: 'pwn.watch' });
  assert.equal(res.status, 200);
  assert.equal(schemas.validateThreatFeed(res.body), true, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.matches.length, 5);
  assert.equal(res.body.more, 2);
  assert.deepEqual(res.body.compared.ecosystems, ['npm']);
  assert.deepEqual(await service.read({ source: 'elsewhere' }), {
    status: 400,
    body: { error: 'invalid-request' },
  });
  assert.deepEqual(await service.read({ source: 'pwn.watch', url: 'https://x' }), {
    status: 400,
    body: { error: 'invalid-request' },
  });
  await service.close();
  assert.equal((await service.read({ source: 'pwn.watch' })).status, 503);
});

test('with no copy of the list, the service says so and why, and shows nothing', async () => {
  const root = await folder();
  const service = createThreatFeedService({
    userHome: root,
    project: root,
    now: () => NOW,
    feed: fixedFeed(null, 'timeout'),
  });
  const res = await service.read({ source: 'pwn.watch' });
  assert.equal(schemas.validateThreatFeed(res.body), true);
  assert.equal(res.body.state, 'unavailable');
  assert.equal(res.body.problem, 'timeout');
  assert.deepEqual(res.body.matches, []);
});

test('the page refuses an answer that is not exactly the threat feed', () => {
  const good = {
    schema: 'stroq-threat-feed/1',
    source: 'pwn.watch',
    generatedAt: NOW.toISOString(),
    state: 'ready',
    problem: null,
    fetchedAt: NOW.toISOString(),
    compared: { incidents: 1, packages: 0, ecosystems: [], agents: [], unread: [], skipped: 0 },
    matches: [
      {
        slug: 'a',
        title: 'A',
        category: 'patch',
        severity: 'high',
        live: true,
        patch: 'patched',
        startedAt: '2026-10-20',
        why: { kind: 'agent', agent: 'cursor' },
      },
    ],
    more: 0,
  };
  assert.equal(schemas.validateThreatFeed(good), true);
  const bad = (change) => schemas.validateThreatFeed({ ...good, ...change });
  assert.equal(bad({ extra: 1 }), false);
  assert.equal(bad({ state: 'unavailable' }), false, 'no copy, yet a time and matches');
  assert.equal(bad({ more: 3 }), false, 'more than shown with fewer than five shown');
  const match = (change) => bad({ matches: [{ ...good.matches[0], ...change }] });
  assert.equal(match({ slug: '../x' }), false);
  assert.equal(match({ title: 'a\u202eb' }), false);
  assert.equal(match({ startedAt: '2026-02-31' }), false);
  assert.equal(match({ why: { kind: 'package', name: 'Bad Name', ecosystem: 'npm' } }), false);
  assert.equal(match({ why: { kind: 'agent', agent: 'cursor', name: 'x' } }), false);
  assert.equal(schemas.threatUrl('a-b'), 'https://pwn.watch/i/a-b');
  assert.equal(schemas.threatUrl('a/../b'), null);
});
