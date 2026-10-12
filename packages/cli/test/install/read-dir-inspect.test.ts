import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { stableStringify } from '@stroq/core';
import { afterEach, describe, expect, it } from 'vitest';
import { INSPECT_RULES_ID, inspectTree } from '../../src/install/inspect/index.js';
import { readDirTree } from '../../src/install/read-dir.js';
import { treeDigest } from '../../src/install/tree.js';
import { PassportSchema, type Passport } from '../../src/install/types.js';
import { PDF_SKILL } from '../helpers/inspect-fixtures.js';
import { removeTempRoots, tempRoot, writeFiles } from '../helpers/install-dir.js';
import { completeTree } from '../helpers/inspect.js';

afterEach(removeTempRoots);

/** The files of a fixture as a folder on the disk, with what a clone adds to it. */
function skillOnDisk(): string {
  const root = tempRoot('vet');
  const files: Record<string, string> = {};
  for (const [path, spec] of Object.entries(PDF_SKILL)) files[path] = String(spec);
  writeFiles(root, {
    ...files,
    '.git/config': '[core]\n\tfsmonitor = true\n',
    'node_modules/dep/index.js': 'process.env.NOT_READ_KEY;\n',
  });
  return root;
}

async function passportOfDirectory(root: string): Promise<Passport> {
  const { tree, blindSpots } = await readDirTree(root);
  return PassportSchema.parse(
    inspectTree(tree, {
      kind: 'auto',
      source: { type: 'dir', label: 'pdf-forms' },
      extraBlindSpots: blindSpots,
      stroqVersion: '0.0.0-test',
      rulesId: INSPECT_RULES_ID,
    }),
  );
}

describe('a folder on the disk, read and inspected', () => {
  it('gives the passport of the files that are in it, with what the reader left out as blind spots', async () => {
    const passport = await passportOfDirectory(skillOnDisk());

    expect(passport.artifact.kind).toBe('skill');
    expect(passport.artifact.name).toBe('pdf-forms');
    expect(passport.blindSpots).toContain('a .git entry was left out');
    expect(
      passport.blindSpots.some((spot) => spot.includes('node_modules entry was left out')),
    ).toBe(true);
    expect(passport.lines.some((line) => line.subject === 'NOT_READ_KEY')).toBe(false);
  });

  it('names the same digest as the same files in memory, so that an author can quote it', async () => {
    const passport = await passportOfDirectory(skillOnDisk());

    const inMemory = treeDigest(completeTree(PDF_SKILL));
    // The files in a folder have the executable bit of the disk (none was set); the fixture has none either.
    expect(passport.artifact.digest).toBe(inMemory);
  });

  it('gives the same bytes when the folder is read twice, and from another place', async () => {
    const first = await passportOfDirectory(skillOnDisk());
    const second = await passportOfDirectory(skillOnDisk());

    expect(stableStringify(first)).toBe(stableStringify(second));
    expect(stableStringify(first)).not.toContain(process.cwd());
  });

  it.skipIf(process.platform === 'win32')(
    'puts the executable bit of a file in the digest it names, and flags a program outside bin and scripts',
    async () => {
      const plain = skillOnDisk();
      const program = skillOnDisk();
      chmodSync(join(program, 'reference.md'), 0o755);

      const first = await passportOfDirectory(plain);
      const second = await passportOfDirectory(program);

      expect(first.artifact.digest).not.toBe(second.artifact.digest);
      expect(second.signals.map((signal) => signal.ruleId)).toContain('executable-file');
    },
  );

  it('says on Windows that the executable bit is not known, in the passport', async () => {
    const { tree, blindSpots } = await readDirTree(skillOnDisk(), { platform: 'win32' });

    const passport = inspectTree(tree, {
      kind: 'skill',
      source: { type: 'dir', label: 'pdf-forms' },
      extraBlindSpots: blindSpots,
      stroqVersion: '0.0.0-test',
      rulesId: INSPECT_RULES_ID,
    });

    expect(passport.blindSpots).toContain('executable bit not available on this platform');
  });
});
