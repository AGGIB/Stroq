import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as harden from '../../src/harden/index.js';
import { backupPath } from '../../src/harden/backup.js';
import { nodeFs } from '../../src/harden/atomic.js';
import { hardenManifestFileIn } from '../../src/paths.js';
import { CLAUDE_READ_DENY_RULES } from '../../src/harden/recipes/credential-paths.js';
import { addDeny, applied, engine, jsonText, owner } from './engine-setup.js';
import { removeTempDirs, tempDir } from './helpers.js';
import { signedText } from './manifest-fixtures.js';

afterEach(removeTempDirs);

// Console mutation is POSIX-only; normal CLI tests retain their cross-platform coverage.
describe.skipIf(process.platform === 'win32')(
  'prepared operations under a caller-owned manifest lock',
  () => {
    it('previews absent directories without writes and permits the lock/engine to create them', async () => {
      const e = engine({ home: join(tempDir('prepared-home'), 'new-stroq-home') });
      const plan = e.planJson('.claude/settings.local.json', [addDeny('Read(./.env)')]);
      const prepared = harden.prepareApply(plan, e.env);
      expect(existsSync(e.env.home)).toBe(false);
      expect(existsSync(dirname(plan.file))).toBe(false);
      let checks = 0;
      const result = await harden.withManifestLock(
        e.env,
        () =>
          harden.applyPreparedPlanUnderManifestLock(prepared, e.env, {
            assertCurrent: () => {
              checks += 1;
            },
          }),
        { timeoutMs: 3000 },
      );
      expect(result.changed).toBe(true);
      expect(checks).toBeGreaterThanOrEqual(2);
      expect(JSON.parse(readFileSync(plan.file, 'utf8')).permissions.deny).toEqual([
        'Read(./.env)',
      ]);
    });

    it('prepares every application to the file and safely undoes a fresh surgical candidate', async () => {
      const e = engine();
      const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'original' }), [
        addDeny('a'),
      ]);
      await harden.applyPlan(
        e.planJson('settings.json', [addDeny('b')], { recipe: 'another-recipe' }),
        e.env,
      );
      owner(path, (doc) => ({ ...doc, newer: { keep: true } }));
      const manifest = readFileSync(hardenManifestFileIn(e.env.home));
      const prepared = harden.prepareUndo(e.env, real, { root: e.project });
      expect(prepared.applications).toBe(2);
      expect(prepared.recipes).toEqual(['test-recipe', 'another-recipe']);
      expect(prepared.candidateText).not.toBeNull();
      expect(harden.sha256Text(prepared.candidateText!)).toBe(prepared.candidateSha256);
      expect(JSON.parse(prepared.candidateText!)).toEqual({
        model: 'original',
        newer: { keep: true },
      });
      expect(readFileSync(hardenManifestFileIn(e.env.home))).toEqual(manifest);
      const result = await harden.withManifestLock(e.env, () =>
        harden.applyPreparedUndoUnderManifestLock(prepared, e.env),
      );
      expect(result.applications).toBe(2);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        model: 'original',
        newer: { keep: true },
      });
      expect(harden.readManifest(e.env).files[real]).toBeUndefined();
    });

    it.each(['pretty', 'minified'] as const)(
      'returns an already configured %s no-op without acknowledgements or creating a lock/home',
      async (format) => {
        const e = engine({ home: join(tempDir('noop-home'), 'absent-stroq-home') });
        const document = { permissions: { deny: CLAUDE_READ_DENY_RULES } };
        const before = format === 'pretty' ? jsonText(document) : JSON.stringify(document);
        writeFileSync(e.file('settings.json'), before);
        const prepared = harden.prepareApply(
          e.planJson('settings.json', CLAUDE_READ_DENY_RULES.map(addDeny)),
          e.env,
        );
        expect(prepared.plan.changed).toBe(false);
        let checks = 0;
        const result = await harden.applyPreparedPlanUnderManifestLock(prepared, e.env, {
          assertCurrent: () => {
            checks += 1;
          },
        });
        expect(result.changed).toBe(false);
        expect(checks).toBe(1);
        expect(readFileSync(e.file('settings.json'), 'utf8')).toBe(before);
        expect(existsSync(e.env.home)).toBe(false);
      },
    );

    it('refuses an unrelated manifest apply queued between undo preview and the lock', async () => {
      const e = engine();
      const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'keep' }), [
        addDeny('a'),
      ]);
      const prepared = harden.prepareUndo(e.env, real, { root: e.project });
      await harden.applyPlan(e.planJson('another.json', [addDeny('other')]), e.env);
      const before = readFileSync(path);
      const manifest = readFileSync(hardenManifestFileIn(e.env.home));
      await expect(
        harden.withManifestLock(e.env, () =>
          harden.applyPreparedUndoUnderManifestLock(prepared, e.env),
        ),
      ).rejects.toMatchObject({ code: 'stale-plan' });
      expect(readFileSync(path)).toEqual(before);
      expect(readFileSync(hardenManifestFileIn(e.env.home))).toEqual(manifest);
    });

    it.each(['source-mode', 'source-identity', 'manifest-layout', 'backup-missing'] as const)(
      'refuses changed %s even when the approved undo could produce the same JSON',
      async (change) => {
        const e = engine();
        const { real, path, result } = await applied(
          e,
          'settings.json',
          jsonText({ model: 'keep' }),
          [addDeny('a')],
        );
        const prepared = harden.prepareUndo(e.env, real, { root: e.project });
        if (change === 'source-mode')
          chmodSync(
            path,
            0o644 === (prepared.binding.source.identity!.mode & 0o777) ? 0o600 : 0o644,
          );
        if (change === 'source-identity') {
          const replacement = `${path}.replacement`;
          writeFileSync(replacement, readFileSync(path));
          chmodSync(replacement, prepared.binding.source.identity!.mode & 0o777);
          renameSync(replacement, path);
        }
        if (change === 'manifest-layout') {
          const file = hardenManifestFileIn(e.env.home);
          writeFileSync(file, JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))));
        }
        if (change === 'backup-missing')
          unlinkSync(backupPath(e.env.home, result.backup!.id, real));
        const bytes = readFileSync(path);
        await expect(
          harden.withManifestLock(e.env, () =>
            harden.applyPreparedUndoUnderManifestLock(prepared, e.env),
          ),
        ).rejects.toMatchObject({ code: 'stale-plan' });
        expect(readFileSync(path)).toEqual(bytes);
        expect(harden.readManifest(e.env).files[real]).toHaveLength(1);
      },
    );

    it('rechecks source identity after the final callback before undo rename', async () => {
      const e = engine();
      const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'keep' }), [
        addDeny('a'),
      ]);
      const prepared = harden.prepareUndo(e.env, real, { root: e.project });
      const bytes = readFileSync(path);
      let checks = 0;
      await expect(
        harden.withManifestLock(e.env, () =>
          harden.applyPreparedUndoUnderManifestLock(prepared, e.env, {
            assertCurrent: () => {
              if (++checks !== 2) return;
              writeFileSync(`${path}.new`, bytes);
              chmodSync(`${path}.new`, prepared.binding.source.identity!.mode & 0o777);
              renameSync(`${path}.new`, path);
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'stale-plan' });
      expect(readFileSync(path)).toEqual(bytes);
      expect(harden.readManifest(e.env).files[real]).toHaveLength(1);
    });

    it('does not roll a foreign manifest back when a prepared apply final guard fails', async () => {
      const e = engine();
      const file = e.file('settings.json');
      writeFileSync(file, jsonText({ model: 'keep' }));
      const prepared = harden.prepareApply(e.planJson('settings.json', [addDeny('a')]), e.env);
      let checks = 0;
      let foreign = '';
      await expect(
        harden.withManifestLock(e.env, () =>
          harden.applyPreparedPlanUnderManifestLock(prepared, e.env, {
            assertCurrent: () => {
              if (++checks !== 2) return;
              const manifestPath = hardenManifestFileIn(e.env.home);
              // Another Stroq of this home writing at the same moment: signed with the same key.
              const { files } = JSON.parse(readFileSync(manifestPath, 'utf8'));
              foreign = signedText(e.env.home, { ...files, [join(e.project, 'foreign.json')]: [] });
              writeFileSync(manifestPath, foreign);
              throw new Error('fixture guard failure');
            },
          }),
        ),
      ).rejects.toThrow('fixture guard failure');
      expect(readFileSync(hardenManifestFileIn(e.env.home), 'utf8')).toBe(foreign);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ model: 'keep' });
      expect(harden.readManifest(e.env).files[file]).toHaveLength(1);
    });

    it('binds a deletion and keeps a newly created file after a stale deletion preview', async () => {
      const e = engine();
      const { real, path } = await applied(e, 'new.json', null, [addDeny('a')]);
      const prepared = harden.prepareUndo(e.env, real, { root: e.project });
      expect(prepared.removesFile).toBe(true);
      expect(prepared.candidateSha256).toBeNull();
      expect(prepared.candidateText).toBeNull();
      writeFileSync(path, jsonText({ owned: 'later' }));
      await expect(
        harden.withManifestLock(e.env, () =>
          harden.applyPreparedUndoUnderManifestLock(prepared, e.env),
        ),
      ).rejects.toMatchObject({ code: 'stale-plan' });
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ owned: 'later' });
    });

    it('refuses a changed private candidate text even when its other approved bindings remain', async () => {
      const e = engine();
      const { real, path } = await applied(e, 'settings.json', jsonText({ model: 'keep' }), [
        addDeny('a'),
      ]);
      const prepared = harden.prepareUndo(e.env, real, { root: e.project });
      const before = readFileSync(path);
      await expect(
        harden.withManifestLock(e.env, () =>
          harden.applyPreparedUndoUnderManifestLock(
            { ...prepared, candidateText: '{"unexpected":true}' },
            e.env,
          ),
        ),
      ).rejects.toMatchObject({ code: 'stale-plan' });
      expect(readFileSync(path)).toEqual(before);
    });

    it('refuses an identical-byte replacement of its intent manifest before source rename', async () => {
      const e = engine();
      const prepared = harden.prepareApply(e.planJson('new.json', [addDeny('a')]), e.env);
      let checks = 0;
      await expect(
        harden.withManifestLock(e.env, () =>
          harden.applyPreparedPlanUnderManifestLock(prepared, e.env, {
            assertCurrent: () => {
              if (++checks !== 2) return;
              const path = hardenManifestFileIn(e.env.home);
              writeFileSync(`${path}.replacement`, readFileSync(path), { mode: 0o600 });
              renameSync(`${path}.replacement`, path);
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'stale-plan' });
      expect(existsSync(e.file('new.json'))).toBe(false);
      expect(harden.readManifest(e.env).files[e.file('new.json')]).toHaveLength(1);
    });

    it('never overwrites a manifest edited while a prepared undo stages record cleanup', async () => {
      const e = engine();
      const { real } = await applied(e, 'settings.json', jsonText({ model: 'keep' }), [
        addDeny('a'),
      ]);
      const prepared = harden.prepareUndo(e.env, real, { root: e.project });
      let foreign = '';
      const env = {
        ...e.env,
        fs: {
          ...nodeFs,
          open: (file: string, flags: string, mode: number) => {
            if (basename(file).startsWith('.manifest.json.stroq-')) {
              const path = hardenManifestFileIn(e.env.home);
              const { files } = JSON.parse(readFileSync(path, 'utf8'));
              foreign = signedText(e.env.home, { ...files, [join(e.project, 'foreign.json')]: [] });
              writeFileSync(path, foreign);
            }
            return nodeFs.open(file, flags, mode);
          },
        },
      };
      await expect(
        harden.withManifestLock(env, () =>
          harden.applyPreparedUndoUnderManifestLock(prepared, env),
        ),
      ).rejects.toMatchObject({ code: 'stale-plan' });
      expect(readFileSync(hardenManifestFileIn(e.env.home), 'utf8')).toBe(foreign);
      expect(harden.readManifest(e.env).files[real]).toHaveLength(1);
    });

    it('offers a bounded caller-selected lock timeout while retaining normal lock use', async () => {
      const e = engine();
      let entered!: () => void;
      const held = new Promise<void>((done) => {
        entered = done;
      });
      let release!: () => void;
      const first = harden.withManifestLock(e.env, async () => {
        entered();
        await new Promise<void>((done) => {
          release = done;
        });
      });
      await held;
      await expect(
        harden.withManifestLock(e.env, async () => undefined, { timeoutMs: 20 }),
      ).rejects.toThrow('lock timeout');
      release();
      await first;
    });
  },
);
