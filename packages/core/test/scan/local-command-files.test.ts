import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { printsOwnText } from '../../src/scan/local-commands.js';

const race = vi.hoisted(() => ({
  path: '',
  fd: -1,
  afterCheck: undefined as (() => void) | undefined,
}));

// Schedule a real file mutation immediately after the size check, whichever API supplies it.
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const checked = () => {
    const change = race.afterCheck;
    race.afterCheck = undefined;
    change?.();
  };
  return {
    ...fs,
    statSync: (...args: Parameters<typeof fs.statSync>) => {
      const stat = fs.statSync(...args);
      if (args[0] === race.path) checked();
      return stat;
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      if (args[0] === race.path) race.fd = fd;
      return fd;
    },
    fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
      const stat = fs.fstatSync(...args);
      if (args[0] === race.fd) checked();
      return stat;
    },
  };
});

let root: string;
const manifest = (script = 'vitest run', padding = '') =>
  JSON.stringify({ scripts: { test: script }, padding });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stroq-local-manifest-'));
  race.path = join(root, 'package.json');
  race.fd = -1;
  race.afterCheck = undefined;
});
afterEach(() => {
  race.afterCheck = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe('reading project scripts for local output', () => {
  it('keeps ordinary local and remote scripts distinct', () => {
    writeFileSync(race.path, manifest());
    expect(printsOwnText('npm test', root)).toBe(true);
    writeFileSync(race.path, manifest('curl https://example.invalid'));
    expect(printsOwnText('npm test', root)).toBe(false);
  });

  it('does not adopt a manifest that grows beyond the limit after its size check', () => {
    writeFileSync(race.path, manifest());
    race.afterCheck = () =>
      writeFileSync(race.path, manifest('vitest run', 'x'.repeat(1024 * 1024)));
    expect(printsOwnText('npm test', root)).toBe(false);
    expect(race.afterCheck).toBeUndefined();
  });

  it('does not adopt a smaller in-place rewrite after its size check', () => {
    writeFileSync(race.path, manifest('curl https://example.invalid', 'x'.repeat(256)));
    race.afterCheck = () => writeFileSync(race.path, manifest());
    expect(printsOwnText('npm test', root)).toBe(false);
    expect(race.afterCheck).toBeUndefined();
  });

  it('leaves missing, malformed and oversized manifests unknown', () => {
    expect(printsOwnText('npm test', root)).toBe(false);
    for (const bytes of ['{', manifest('vitest run', 'x'.repeat(1024 * 1024))]) {
      writeFileSync(race.path, bytes);
      expect(printsOwnText('npm test', root)).toBe(false);
    }
  });

  it('does not treat a directory as a package manifest', () => {
    mkdirSync(race.path);
    expect(printsOwnText('npm test', root)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO without waiting for its writer', () => {
    expect(spawnSync('mkfifo', [race.path]).status).toBe(0);
    const source = new URL('../../src/scan/local-commands.ts', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        '--input-type=module',
        '--eval',
        "const { printsOwnText } = await import(process.argv[1]); process.stdout.write(JSON.stringify(printsOwnText('npm test', process.argv[2])));",
        source,
        root,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe('false');
  });
});
