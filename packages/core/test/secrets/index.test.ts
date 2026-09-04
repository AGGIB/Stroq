import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileSecretIndex, displayPath, hashSecret } from '../../src/secrets/index.js';

const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const NPM_TOKEN = 'npm_abcdefghijklmnopqrstuvwxyz';
const ENV_SECRET = 'ghp_0123456789abcdefghijklmnop';

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
      [
        'irrelevant-token-value',
        AWS_SECRET,
        NPM_TOKEN,
        'p@ssw0rd-1234567',
        ENV_SECRET,
        'example-password-value',
      ],
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
    await index.lookup([AWS_SECRET], cwd);
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
    await index.lookup([AWS_SECRET], cwd);
    const before = JSON.parse(readFileSync(file, 'utf8')) as { salt: string };
    writeFileSync(join(cwd, '.env'), 'DB_PASSWORD=new-password-value-99\n');
    const future = new Date(Date.now() + 5000);
    utimesSync(join(cwd, '.env'), future, future);
    const hits = await index.lookup(['new-password-value-99', 'p@ssw0rd-1234567'], cwd);
    expect(hits.map((h) => h.token)).toEqual(['new-password-value-99']);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { salt: string }).salt).toBe(before.salt);
  });

  it('records canaries, survives a rebuild, and flags them on lookup', async () => {
    const { cwd, index } = fixture();
    await index.addCanary('stroq_canary_0123456789abcdefghijkl');
    writeFileSync(join(cwd, '.env'), 'DB_PASSWORD=another-password-77\n');
    const future = new Date(Date.now() + 5000);
    utimesSync(join(cwd, '.env'), future, future);
    const hits = await index.lookup(['stroq_canary_0123456789abcdefghijkl'], cwd);
    expect(hits).toEqual([
      {
        name: 'STROQ_CANARY_KEY',
        source: 'canary',
        canary: true,
        token: 'stroq_canary_0123456789abcdefghijkl',
      },
    ]);
    expect(await index.stats()).toMatchObject({ canaries: 1 });
  });

  it('skips unreadable, missing and oversized sources without throwing', async () => {
    const { home, cwd, index } = fixture();
    writeFileSync(join(home, '.netrc'), 'x'.repeat(300_000));
    mkdirSync(join(home, '.docker'));
    writeFileSync(join(home, '.docker', 'config.json'), '{broken');
    const hits = await index.lookup([AWS_SECRET], cwd);
    expect(hits.map((h) => h.name)).toEqual(['aws_secret_access_key']);
  });

  it('fails closed on a corrupt index file', async () => {
    const { file, cwd, index } = fixture();
    writeFileSync(file, '{not json');
    await expect(index.lookup([AWS_SECRET], cwd)).rejects.toThrow(/corrupt secret index/);
    writeFileSync(file, '[]');
    await expect(index.lookup([AWS_SECRET], cwd)).rejects.toThrow(/corrupt secret index/);
  });

  it('reports stats before and after building', async () => {
    const { cwd, index } = fixture();
    expect(await index.stats()).toEqual({ entries: 0, sources: 0, canaries: 0, builtAt: null });
    await index.lookup([AWS_SECRET], cwd);
    const stats = await index.stats();
    expect(stats.sources).toBe(3);
    expect(stats.entries).toBeGreaterThanOrEqual(4);
    expect(stats.builtAt).not.toBeNull();
  });
});
