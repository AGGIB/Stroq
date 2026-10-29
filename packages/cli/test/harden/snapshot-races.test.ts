import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readManifestSnapshot } from '../../src/harden/manifest.js';
import { hardenManifestFileIn } from '../../src/paths.js';
import { engine } from './engine-setup.js';
import { removeTempDirs } from './helpers.js';

const race = vi.hoisted(() => ({
  path: '',
  fd: -1,
  done: false,
  afterRead: undefined as (() => void) | undefined,
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    openSync: ((...args: unknown[]) => {
      const fd = (fs.openSync as (...items: unknown[]) => number)(...args);
      if (String(args[0]) === race.path) race.fd = fd;
      return fd;
    }) as typeof fs.openSync,
    readSync: ((...args: unknown[]) => {
      const read = (fs.readSync as (...items: unknown[]) => number)(...args);
      if (args[0] === race.fd && !race.done) {
        race.done = true;
        race.afterRead?.();
      }
      return read;
    }) as typeof fs.readSync,
  };
});
afterEach(() => {
  race.path = '';
  race.fd = -1;
  race.done = false;
  race.afterRead = undefined;
  removeTempDirs();
});

describe.skipIf(process.platform === 'win32')('prepared raw manifest read races', () => {
  it.each(['grows', 'shrinks', 'replacement'] as const)(
    'refuses a manifest that %s during the descriptor read',
    (change) => {
      const e = engine();
      const path = hardenManifestFileIn(e.env.home);
      const raw = '{"version":1,"files":{}}';
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, raw, { mode: 0o600 });
      race.path = path;
      race.afterRead = () => {
        if (change === 'grows') appendFileSync(path, ' ');
        if (change === 'shrinks') truncateSync(path, 1);
        if (change === 'replacement') {
          writeFileSync(`${path}.new`, raw, { mode: 0o600 });
          chmodSync(`${path}.new`, 0o600);
          renameSync(`${path}.new`, path);
        }
      };
      expect(() => readManifestSnapshot(e.env)).toThrow(
        expect.objectContaining({ code: 'stale-plan' }),
      );
      expect(readFileSync(path).length).toBe(
        change === 'grows' ? raw.length + 1 : change === 'shrinks' ? 1 : raw.length,
      );
    },
  );
});
