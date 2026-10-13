import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupFile } from '../../src/harden/backup.js';
import { planTextBlock } from '../../src/harden/textblock.js';
import { ID_PATTERN } from '../../src/harden/types.js';
import { fakeEnv, removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

/**
 * A backup id and a text block id are both the name of one thing that is joined into a path or a
 * marker line, so they follow one rule. Two copies of it would drift, and then the manifest would
 * accept an id one of the writers refuses.
 */
const ACCEPTED = [
  'a',
  'A',
  '0',
  'cursor-ignore',
  'v1.2_3',
  'x'.repeat(64),
  '20261010T100000000Z-abc123',
];
const REJECTED = [
  '',
  '.',
  '..',
  '.hidden',
  '-lead',
  '_lead',
  'a b',
  'a/b',
  'a\\b',
  'a\nb',
  'é',
  'x'.repeat(65),
];

describe('the one rule for ids', () => {
  it.each(ACCEPTED)('accepts %j', (id) => {
    expect(ID_PATTERN.test(id)).toBe(true);
  });

  it.each(REJECTED)('rejects %j', (id) => {
    expect(ID_PATTERN.test(id)).toBe(false);
  });

  it.each([...ACCEPTED, ...REJECTED])(
    'is what backups and blocks each decide with: %j',
    async (id) => {
      const wanted = ID_PATTERN.test(id);
      const home = tempDir('home');
      const real = join(tempDir('project'), 'settings.json');

      const backup = await backupFile(fakeEnv(home), real, Buffer.from('{}'), id).then(
        () => true,
        (err: { code?: string }) => err.code !== 'invalid-backup-id',
      );
      const block = (() => {
        try {
          planTextBlock(join(tempDir('b'), 'ignore'), { id, lines: [] }, { read: () => null });
          return true;
        } catch (err) {
          return (err as { code?: string }).code !== 'invalid-edit';
        }
      })();

      expect(backup).toBe(wanted);
      expect(block).toBe(wanted);
    },
  );
});
