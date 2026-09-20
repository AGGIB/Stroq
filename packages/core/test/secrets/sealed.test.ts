import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SecretCandidate } from '../../src/secrets/candidates.js';
import { FileSecretIndex, SEALED_SOURCES_ENV } from '../../src/secrets/index.js';

const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const ENV_SECRET = 'DB_PASSWORD=p@ssw0rd-1234567';

const cands = (...tokens: readonly string[]): SecretCandidate[] =>
  tokens.map((token) => ({ token, raw: token }));

function fixture(env: Readonly<Record<string, string | undefined>> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'stroq-sealed-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'stroq-sealed-cwd-'));
  const stroqHome = mkdtempSync(join(tmpdir(), 'stroq-sealed-stroq-'));
  mkdirSync(join(home, '.aws'));
  writeFileSync(
    join(home, '.aws', 'credentials'),
    `[default]\naws_secret_access_key = ${AWS_SECRET}\n`,
  );
  writeFileSync(join(cwd, '.env'), `${ENV_SECRET}\nPORT=3000\n`);
  writeFileSync(join(cwd, '.env.example'), 'DB_PASSWORD=example-password-value\n');
  const file = join(stroqHome, 'secrets.json');
  return { home, cwd, file, index: new FileSecretIndex(file, home, env) };
}

/**
 * What the sandbox does to a source, done the only way a test can do it portably:
 * a `denyRead` entry makes `stat` itself fail with EPERM (measured on macOS
 * Seatbelt, srt 0.0.77), which `statSources` cannot tell from a deleted file — so
 * deleting it exercises the same branch.
 */
const hideSources = (home: string, cwd: string): void => {
  rmSync(join(home, '.aws'), { recursive: true, force: true });
  rmSync(join(cwd, '.env'), { force: true });
};

describe('FileSecretIndex.sourcePaths', () => {
  it('names the credential files it would index, and never the example env', () => {
    const { home, cwd, index } = fixture();
    const paths = index.sourcePaths(cwd);
    expect(paths).toContain(join(home, '.aws', 'credentials'));
    expect(paths).toContain(join(cwd, '.env'));
    expect(paths).not.toContain(join(cwd, '.env.example'));
  });

  it('names only files that exist, so a deny list built from it has no phantom entries', () => {
    const { home, cwd, index } = fixture();
    expect(index.sourcePaths(cwd)).not.toContain(join(home, '.npmrc'));
  });
});

describe('FileSecretIndex.refresh', () => {
  it('builds the index on demand and reports what went into it', async () => {
    const { cwd, index } = fixture();
    const stats = await index.refresh(cwd);
    expect(stats.builtAt).not.toBeNull();
    expect(stats.entries).toBeGreaterThan(0);
    expect(stats.sources).toBeGreaterThan(0);
  });
});

describe('sealing the sources', () => {
  // The behaviour the seal exists to prevent, asserted so the seal is measured
  // against the real default rather than against an assumption about it.
  it('is needed because an unsealed index rebuilds itself empty when its sources vanish', async () => {
    const { home, cwd, index } = fixture();
    expect(await index.lookup(cands(AWS_SECRET), cwd)).toHaveLength(1);
    hideSources(home, cwd);
    expect(await index.lookup(cands(AWS_SECRET), cwd)).toHaveLength(0);
  });

  it('keeps the index that is already on disk when the sources cannot be reached', async () => {
    const built = fixture();
    await built.index.refresh(built.cwd);
    hideSources(built.home, built.cwd);

    const sealed = new FileSecretIndex(built.file, built.home, { [SEALED_SOURCES_ENV]: '1' });
    expect(await sealed.lookup(cands(AWS_SECRET), built.cwd)).toHaveLength(1);
  });

  it('still builds when there is no index yet, so a sealed run is never left with nothing', async () => {
    const { cwd, index } = fixture({ [SEALED_SOURCES_ENV]: '1' });
    expect(await index.lookup(cands(AWS_SECRET), cwd)).toHaveLength(1);
  });

  it('is off unless the variable says exactly 1', async () => {
    const { home, cwd, file } = fixture({ [SEALED_SOURCES_ENV]: 'yes' });
    const index = new FileSecretIndex(file, home, { [SEALED_SOURCES_ENV]: 'yes' });
    await index.refresh(cwd);
    hideSources(home, cwd);
    expect(await index.lookup(cands(AWS_SECRET), cwd)).toHaveLength(0);
  });
});
