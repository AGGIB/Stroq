import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SecretCandidate } from '../../src/secrets/candidates.js';
import {
  FileSecretIndex,
  MAX_PROJECT_ENV_FILES,
  displayPath,
  hashSecret,
} from '../../src/secrets/index.js';

const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const NPM_TOKEN = 'npm_abcdefghijklmnopqrstuvwxyz';
const ENV_SECRET = 'ghp_0123456789abcdefghijklmnop';
/** Mode bits do not deny root, and Windows ignores them entirely. */
const CANNOT_CHMOD =
  process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);

/** The candidate shape `lookup` takes: a token that is its own spelling in the input. */
const cands = (...tokens: readonly string[]): SecretCandidate[] =>
  tokens.map((token) => ({ token, raw: token }));

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'stroq-sec-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'stroq-sec-cwd-'));
  const stroqHome = mkdtempSync(join(tmpdir(), 'stroq-sec-stroq-'));
  mkdirSync(join(home, '.aws'));
  writeFileSync(
    join(home, '.aws', 'credentials'),
    `[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\naws_secret_access_key = ${AWS_SECRET}\n`,
  );
  writeFileSync(join(home, '.npmrc'), `//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n`);
  writeFileSync(join(cwd, '.env'), 'DB_PASSWORD=p@ssw0rd-1234567\nPORT=3000\n');
  writeFileSync(join(cwd, '.env.example'), 'DB_PASSWORD=example-password-value\n');
  const file = join(stroqHome, 'secrets.json');
  const index = new FileSecretIndex(file, home, { GITHUB_TOKEN: ENV_SECRET, HOME: home });
  return { home, cwd, file, index };
}

describe('hashSecret / displayPath', () => {
  it('hashes with the salt and shortens home paths', () => {
    expect(hashSecret('s', 'v')).toMatch(/^[0-9a-f]{32}$/);
    expect(hashSecret('s', 'v')).not.toBe(hashSecret('t', 'v'));
    expect(displayPath('/Users/me/.aws/credentials', '/Users/me')).toBe('~/.aws/credentials');
    expect(displayPath('/tmp/p/.env', '/Users/me')).toBe('/tmp/p/.env');
  });
});

describe('FileSecretIndex', () => {
  it('does no I/O and returns nothing when there are no candidates', async () => {
    const { file, index, cwd } = fixture();
    expect(await index.lookup([], cwd)).toEqual([]);
    expect(() => statSync(file)).toThrow();
  });

  it('finds secrets from home files, the project .env and the environment, never the example file', async () => {
    const { home, cwd, index } = fixture();
    const hits = await index.lookup(
      cands(
        'irrelevant-token-value',
        AWS_SECRET,
        NPM_TOKEN,
        'p@ssw0rd-1234567',
        ENV_SECRET,
        'example-password-value',
      ),
      cwd,
    );
    expect(hits.map((h) => [h.name, h.source, h.token])).toEqual(
      expect.arrayContaining([
        ['aws_secret_access_key', '~/.aws/credentials', AWS_SECRET],
        ['//registry.npmjs.org/:_authToken', '~/.npmrc', NPM_TOKEN],
        ['DB_PASSWORD', join(cwd, '.env'), 'p@ssw0rd-1234567'],
        ['GITHUB_TOKEN', 'env', ENV_SECRET],
      ]),
    );
    expect(hits.find((h) => h.token === 'example-password-value')).toBeUndefined();
    expect(hits.every((h) => !h.canary)).toBe(true);
    expect(home.length).toBeGreaterThan(0);
  });

  it('stores only salted hashes, names and display paths, with private file mode', async () => {
    const { file, cwd, index } = fixture();
    await index.lookup(cands(AWS_SECRET), cwd);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain(AWS_SECRET);
    expect(raw).not.toContain(NPM_TOKEN);
    expect(raw).toContain('aws_secret_access_key');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(raw) as { salt: string; entries: unknown[]; sources: unknown[] };
    expect(parsed.salt).toMatch(/^[0-9a-f]{32}$/);
    expect(parsed.entries.length).toBeGreaterThanOrEqual(4);
    expect(parsed.sources).toHaveLength(3);
  });

  it('rebuilds when a source changes and keeps the salt', async () => {
    const { file, cwd, index } = fixture();
    await index.lookup(cands(AWS_SECRET), cwd);
    const before = JSON.parse(readFileSync(file, 'utf8')) as { salt: string };
    writeFileSync(join(cwd, '.env'), 'DB_PASSWORD=new-password-value-99\n');
    const future = new Date(Date.now() + 5000);
    utimesSync(join(cwd, '.env'), future, future);
    const hits = await index.lookup(cands('new-password-value-99', 'p@ssw0rd-1234567'), cwd);
    expect(hits.map((h) => h.token)).toEqual(['new-password-value-99']);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { salt: string }).salt).toBe(before.salt);
  });

  it('records canaries, survives a rebuild, and flags them on lookup', async () => {
    const { cwd, index } = fixture();
    await index.addCanary('stroq_canary_0123456789abcdefghijkl');
    writeFileSync(join(cwd, '.env'), 'DB_PASSWORD=another-password-77\n');
    const future = new Date(Date.now() + 5000);
    utimesSync(join(cwd, '.env'), future, future);
    const hits = await index.lookup(cands('stroq_canary_0123456789abcdefghijkl'), cwd);
    expect(hits).toEqual([
      {
        name: 'STROQ_CANARY_KEY',
        source: 'canary',
        canary: true,
        token: 'stroq_canary_0123456789abcdefghijkl',
        raw: 'stroq_canary_0123456789abcdefghijkl',
      },
    ]);
    expect(await index.stats()).toMatchObject({ canaries: 1 });
  });

  it('returns every matching token even when name and source repeat', async () => {
    const { home, cwd, index } = fixture();
    const SECOND_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYSECONDPROFILE';
    writeFileSync(
      join(home, '.aws', 'credentials'),
      `[default]\naws_secret_access_key = ${AWS_SECRET}\n[work]\naws_secret_access_key = ${SECOND_SECRET}\n`,
    );
    const hits = await index.lookup(cands(AWS_SECRET, SECOND_SECRET), cwd);
    expect(hits.map((h) => [h.name, h.source, h.token])).toEqual(
      expect.arrayContaining([
        ['aws_secret_access_key', '~/.aws/credentials', AWS_SECRET],
        ['aws_secret_access_key', '~/.aws/credentials', SECOND_SECRET],
      ]),
    );
    expect(hits).toHaveLength(2);
  });

  it('keeps one match per token/raw pair so both spellings stay redactable', async () => {
    const { cwd, index } = fixture();
    const encoded = encodeURIComponent(AWS_SECRET);
    const hits = await index.lookup(
      [
        { token: AWS_SECRET, raw: AWS_SECRET },
        { token: AWS_SECRET, raw: encoded },
        { token: AWS_SECRET, raw: AWS_SECRET },
      ],
      cwd,
    );
    expect(hits.map((h) => h.raw)).toEqual([AWS_SECRET, encoded]);
  });

  it('skips unreadable, missing and oversized sources without throwing', async () => {
    const { home, cwd, index } = fixture();
    writeFileSync(join(home, '.netrc'), 'x'.repeat(300_000));
    mkdirSync(join(home, '.docker'));
    writeFileSync(join(home, '.docker', 'config.json'), '{broken');
    const hits = await index.lookup(cands(AWS_SECRET), cwd);
    expect(hits.map((h) => h.name)).toEqual(['aws_secret_access_key']);
  });

  it.skipIf(CANNOT_CHMOD)('counts a source that exists but cannot be read', async () => {
    const { home, cwd, index } = fixture();
    chmodSync(join(home, '.npmrc'), 0o000);
    try {
      const hits = await index.lookup(cands(AWS_SECRET, NPM_TOKEN), cwd);
      expect(hits.map((h) => h.token)).toEqual([AWS_SECRET]);
      expect(await index.stats()).toMatchObject({ unreadable: 1, corrupt: false });
    } finally {
      chmodSync(join(home, '.npmrc'), 0o600);
    }
  });

  it('reads at most MAX_PROJECT_ENV_FILES project env files and records the truncation', async () => {
    const { cwd, index } = fixture();
    const secretOf = (n: number) => `stroq_test_env_secret_${String(n).padStart(2, '0')}`;
    // 40 more `.env.*` files: with the fixture's own `.env` sorting first, the cap
    // keeps `.env` plus `.env.p01`..`.env.p31` and drops everything after it.
    for (let n = 1; n <= 40; n += 1) {
      const suffix = String(n).padStart(2, '0');
      writeFileSync(join(cwd, `.env.p${suffix}`), `API_KEY=${secretOf(n)}\n`);
    }
    const kept = MAX_PROJECT_ENV_FILES - 1;
    const hits = await index.lookup(cands(secretOf(kept), secretOf(kept + 1)), cwd);
    expect(hits.map((h) => h.token)).toEqual([secretOf(kept)]);
    expect(await index.stats()).toMatchObject({ truncated: true, unreadable: 0 });
  });

  it('recovers from a corrupt index file by rebuilding', async () => {
    const { file, cwd, index } = fixture();
    for (const corrupt of ['{not json', '[]', '{"version":1}', '{"version":2}']) {
      writeFileSync(file, corrupt);
      const hits = await index.lookup(cands(AWS_SECRET), cwd);
      expect(hits.map((h) => h.name)).toEqual(['aws_secret_access_key']);
    }
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version: number };
    expect(parsed.version).toBe(2);
  });

  it('reports a corrupt index as corrupt rather than as never built', async () => {
    const { file, cwd, index } = fixture();
    await index.lookup(cands(AWS_SECRET), cwd);
    writeFileSync(file, '{not json');
    expect(await index.stats()).toMatchObject({ corrupt: true, builtAt: null, entries: 0 });
  });

  it('reports stats before and after building', async () => {
    const { cwd, index } = fixture();
    expect(await index.stats()).toEqual({
      entries: 0,
      sources: 0,
      canaries: 0,
      builtAt: null,
      truncated: false,
      unreadable: 0,
      corrupt: false,
    });
    await index.lookup(cands(AWS_SECRET), cwd);
    const stats = await index.stats();
    expect(stats.sources).toBe(3);
    expect(stats.entries).toBeGreaterThanOrEqual(4);
    expect(stats.builtAt).not.toBeNull();
    expect(stats).toMatchObject({ truncated: false, unreadable: 0, corrupt: false });
  });
});
