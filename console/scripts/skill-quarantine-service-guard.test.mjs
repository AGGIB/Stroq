import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { withLock } from '../../packages/core/dist/index.js';
import { createInventory } from './inventory.mjs';
import { prepareApplyLock } from './skill-quarantine-paths.mjs';

// Only the isolated RED probe substitutes a temporary copy of the pre-fix parent.
const service = await import(
  process.env.STROQ_TEST_QUARANTINE_PARENT
    ? pathToFileURL(process.env.STROQ_TEST_QUARANTINE_PARENT).href
    : './skill-quarantine.mjs'
);

test(
  'a preview expiring while its real apply lock is occupied never moves the selected source',
  { timeout: 15_000 },
  async (t) => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'stroq-quarantine-lock-expiry-')),
    );
    const project = join(directory, 'project'),
      userHome = join(directory, 'user'),
      home = join(userHome, '.stroq');
    await mkdir(project);
    await mkdir(userHome);
    const source = join(project, '.claude/skills/notes');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'SKILL.md'), '# Release notes\nSummarize changes.');
    let clock = Date.now(),
      calls = 0,
      entered;
    const atApply = new Promise((resolve) => {
      entered = resolve;
    });
    const quarantine = service.createSkillQuarantine({
      project,
      userHome,
      now: () => clock,
      runtimeDigest: async () => {
        if (++calls === 3) entered();
        return 'a'.repeat(64);
      },
    });
    const inventory = createInventory({ project, userHome, home });
    t.after(async () => {
      await quarantine.close();
      await inventory.close();
      await rm(directory, { recursive: true, force: true });
    });
    const current = await inventory.read();
    assert.equal(current.status, 200);
    const item = current.body.items[0];
    const preview = await quarantine.preview({
      action: 'quarantine',
      id: item.id,
      expectedSha256: item.sha256,
    });
    assert.equal(preview.status, 200, JSON.stringify(preview));
    const lock = await prepareApplyLock(userHome);
    let release, obtained;
    const locked = new Promise((resolve) => {
      obtained = resolve;
    });
    const holding = withLock(
      lock.path,
      () => {
        obtained();
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      { fs: lock.fs, timeoutMs: 3000 },
    );
    await locked;
    try {
      const applying = quarantine.apply({
        previewId: preview.body.id,
        confirm: true,
        acknowledgeSessionLimits: true,
      });
      await atApply;
      clock += 120_001;
      release();
      await holding;
      const result = await applying;
      assert.equal(result.body.error, 'quarantine-preview-expired', JSON.stringify(result));
      assert.equal(
        await readFile(join(source, 'SKILL.md'), 'utf8'),
        '# Release notes\nSummarize changes.',
      );
      await assert.rejects(access(join(project, '.claude/.stroq-quarantine')));
    } finally {
      release?.();
      await holding;
    }
  },
);
