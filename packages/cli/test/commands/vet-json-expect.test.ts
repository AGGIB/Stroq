import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stableStringify } from '@stroq/core';
import { afterEach, describe, expect, it } from 'vitest';
import { INSPECT_RULES_ID, inspectTree } from '../../src/install/inspect/index.js';
import { readDirTree } from '../../src/install/read-dir.js';
import { PassportSchema } from '../../src/install/types.js';
import { PDF_SKILL } from '../helpers/inspect-fixtures.js';
import { removeTempRoots, tempRoot } from '../helpers/install-dir.js';
import { folder, mcpFolder, skillFolder, vet } from '../helpers/vet-world.js';

afterEach(removeTempRoots);

const SKILL_DIGEST = '32bb90d578d8f26224c2f87ec67ce6672c92091d108eb655a652feda5076d3f6';
const OTHER_DIGEST = 'f'.repeat(64);

describe('stroq vet --json', () => {
  it('prints the passport itself, in the canonical form, with one newline at the end', async () => {
    const dir = skillFolder();
    const { tree, blindSpots } = await readDirTree(dir);
    const expected = PassportSchema.parse(
      inspectTree(tree, {
        kind: 'auto',
        source: { type: 'dir', label: 'pdf-forms-fixture' },
        extraBlindSpots: blindSpots,
        stroqVersion: '0.0.0-test',
        rulesId: INSPECT_RULES_ID,
      }),
    );

    const run = await vet(['--from', dir, '--json']);

    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe(`${stableStringify(expected)}\n`);
    expect(run.stdout.endsWith('}\n')).toBe(true);
    expect(run.stdout.indexOf('\n')).toBe(run.stdout.length - 1);
  });

  it('is a passport that fits the schema, with the digest of the files and the label of the folder', async () => {
    const run = await vet(['--from', skillFolder(), '--json']);
    const passport = PassportSchema.parse(JSON.parse(run.stdout));

    expect(passport.artifact.digest).toBe(SKILL_DIGEST);
    expect(passport.artifact.source).toEqual({ type: 'dir', label: 'pdf-forms-fixture' });
    expect(passport.analysis).toEqual({ stroq: '0.0.0-test', rules: INSPECT_RULES_ID });
  });

  it('is the same bytes when it is run twice, and when the same files are in another place', async () => {
    const here = skillFolder('same-name');
    const there = skillFolder('same-name');
    const first = await vet(['--from', here, '--json']);
    const second = await vet(['--from', there, '--json']);

    expect(dirname(here)).not.toBe(dirname(there));
    expect(first.stdout).toBe(second.stdout);
    expect(await vet(['--from', here, '--json'])).toEqual(first);
    expect(first.stdout).not.toContain(dirname(here));
  });

  it('is the same bytes whatever order the files were made in, because the order is of the names', async () => {
    const entries = Object.entries(PDF_SKILL).map(([path, spec]) => [path, String(spec)] as const);
    const forward = folder('order-fixture', Object.fromEntries(entries));
    const backward = folder('order-fixture', Object.fromEntries([...entries].reverse()));

    const a = await vet(['--from', forward, '--json']);
    const b = await vet(['--from', backward, '--json']);

    expect(a.code).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it('holds no time and no path of this machine', async () => {
    const dir = mcpFolder();
    const run = await vet(['--from', dir, '--json']);

    expect(run.stdout).not.toContain(dir);
    expect(run.stdout).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  });

  it('changes when a file changes, and so does the digest in it', async () => {
    const dir = skillFolder();
    const before = PassportSchema.parse(JSON.parse((await vet(['--from', dir, '--json'])).stdout));
    writeFileSync(join(dir, 'LICENSE.txt'), 'MIT License\n\nchanged\n');
    const after = PassportSchema.parse(JSON.parse((await vet(['--from', dir, '--json'])).stdout));

    expect(after.artifact.digest).not.toBe(before.artifact.digest);
  });

  it('keeps the digest of a folder that has the same files plus an empty folder, because empty folders are not entries', async () => {
    const dir = skillFolder();
    mkdirSync(join(dir, 'empty-folder'));

    const run = await vet(['--from', dir, '--json']);

    expect(PassportSchema.parse(JSON.parse(run.stdout)).artifact.digest).toBe(SKILL_DIGEST);
  });
});

describe('stroq vet --expect', () => {
  it('exits 0 when the digest is the one of the files, bare or written as sha256:<hex>, and says so on the digest line', async () => {
    const dir = skillFolder();
    const bare = await vet(['--from', dir, '--expect', SKILL_DIGEST]);
    const prefixed = await vet(['--from', dir, '--expect', `sha256:${SKILL_DIGEST}`]);

    for (const run of [bare, prefixed]) {
      expect(run.code, run.stderr).toBe(0);
      expect(run.stdout.split('\n')[1]).toBe(
        `stroq-tree/1 sha256:${SKILL_DIGEST}  4 files, 945 bytes (matches --expect)`,
      );
    }
  });

  it('keeps --json the passport and nothing else when the digest matches', async () => {
    const dir = skillFolder();
    const plain = await vet(['--from', dir, '--json']);
    const expected = await vet(['--from', dir, '--json', '--expect', SKILL_DIGEST]);

    expect(expected.code).toBe(0);
    expect(expected.stdout).toBe(plain.stdout);
  });

  it('exits 1 and prints both digests on stderr and nothing on stdout, when it is not the digest of the files', async () => {
    const run = await vet(['--from', skillFolder(), '--expect', OTHER_DIGEST]);

    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain(`expected: sha256:${OTHER_DIGEST}`);
    expect(run.stderr).toContain(`found:    sha256:${SKILL_DIGEST}`);
  });

  it('does not write a file for a mismatch, so that a wrong digest never leaves a passport behind', async () => {
    const out = join(tempRoot('out'), 'passport.json');
    const run = await vet([
      '--from',
      skillFolder(),
      '--json',
      '--expect',
      OTHER_DIGEST,
      '--out',
      out,
    ]);

    expect(run.code).toBe(1);
    expect(await vet(['--from', skillFolder(), '--json', '--out', out])).toMatchObject({ code: 0 });
  });

  it('exits 2 on Windows, before it reads anything, and says why', async () => {
    const run = await vet(['--from', skillFolder(), '--expect', SKILL_DIGEST], {
      platform: 'win32',
    });

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('Windows');
    expect(run.stderr).toContain('executable bit');
  });

  it('exits 2 for a digest that is not written as one, whatever the files are', async () => {
    const run = await vet(['--from', skillFolder(), '--expect', 'not-a-digest']);

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('--expect');
  });

  it('judges the digest of a folder read as Windows reads it, which has no executable bit, as another digest, and says so', async () => {
    const dir = skillFolder();
    const asWindows = await vet(['--from', dir], { platform: 'win32' });

    expect(asWindows.code).toBe(0);
    expect(asWindows.stdout.split('\n')[1]).toContain('(platform-dependent: no executable bit)');
    expect(asWindows.stdout).toContain('executable bit not available on this platform');
  });
});
