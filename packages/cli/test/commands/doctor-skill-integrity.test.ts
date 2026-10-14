import { mkdir, readFile, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorReport } from '../../src/commands/doctor.js';
import { addSkill, removeSkill } from '../../src/install/skill-install.js';
import { readPassports, writePassports } from '../../src/install/lock.js';
import {
  checkInstalledSkills,
  checkSingleSkillIntegrity,
} from '../../src/install/skill-integrity.js';
import { setup } from '../helpers/skill-install.js';

describe('doctor skill integrity', () => {
  it('reports nothing when no skills are installed and does not create state directories', async () => {
    const f = await setup();
    const beforeExists = existsSync(f.options.stroqHome);
    const report = await doctorReport(f.options.project, {
      home: f.options.home,
    });
    const skillChecks = report.checks.filter((c) => c.name.startsWith('skill'));
    expect(skillChecks).toEqual([]);
    expect(existsSync(f.options.stroqHome)).toBe(beforeExists);
  });

  it('reports intact for matching bytes and modes', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);
    const report = await doctorReport(f.options.project, {
      home: f.options.stroqHome,
    });
    const check = report.checks.find((c) => c.name === 'skill "demo"');
    expect(check).toBeDefined();
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain('intact at');
  });

  it('reports changed when files are modified, added or removed', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);
    const skillMd = join(added.installedTo, 'SKILL.md');

    // 1. Modified file
    await writeFile(skillMd, 'tampered content');
    let report = await doctorReport(f.options.project, { home: f.options.stroqHome });
    let check = report.checks.find((c) => c.name === 'skill "demo"');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('changed at');
    expect(check?.detail).toContain('reconfirm with "stroq add demo"');
    expect(check?.detail).toContain('restore with "stroq add demo --restore"');

    // Restore original file
    await writeFile(
      skillMd,
      '---\nname: demo\ndescription: a demo\n---\n# Demo\nRead the project.\n',
    );

    // 2. Added file
    const extraFile = join(added.installedTo, 'EXTRA.txt');
    await writeFile(extraFile, 'extra');
    report = await doctorReport(f.options.project, { home: f.options.stroqHome });
    check = report.checks.find((c) => c.name === 'skill "demo"');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('changed at');
    await rm(extraFile);

    // 3. Removed file
    await rm(skillMd);
    report = await doctorReport(f.options.project, { home: f.options.stroqHome });
    check = report.checks.find((c) => c.name === 'skill "demo"');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('changed at');
  });

  it('reports missing when the installed directory is absent', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);
    await rm(added.installedTo, { recursive: true, force: true });

    const report = await doctorReport(f.options.project, { home: f.options.stroqHome });
    const check = report.checks.find((c) => c.name === 'skill "demo"');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('missing at');
    expect(check?.detail).toContain('restore with "stroq add demo --restore"');
    expect(check?.detail).toContain('remove with "stroq remove demo"');
  });

  it('user-scope skill reports next actions with --user', async () => {
    const f = await setup();
    const added = await addSkill(f.source, { ...f.options, user: true });
    await rm(added.installedTo, { recursive: true, force: true });

    const report = await doctorReport(f.options.project, {
      home: f.options.stroqHome,
      userHome: f.options.home,
    });
    const check = report.checks.find((c) => c.name === 'skill "demo"');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('missing at');
    expect(check?.detail).toContain('restore with "stroq add demo --user --restore"');
    expect(check?.detail).toContain('remove with "stroq remove demo --user"');
  });

  it('reports unverifiable when installed directory or internal entry is a symlink', async () => {
    // Symlinks on Windows require elevated privileges, so we only run if symlinks are permitted
    const f = await setup();
    const added = await addSkill(f.source, f.options);

    // Test directory link
    const targetDir = added.installedTo;
    const backupDir = `${targetDir}-backup`;
    await rm(targetDir, { recursive: true, force: true });

    let symlinksSupported = true;
    try {
      await symlink(f.source, targetDir, 'junction');
    } catch {
      symlinksSupported = false;
    }

    if (symlinksSupported) {
      const report = await doctorReport(f.options.project, { home: f.options.stroqHome });
      const check = report.checks.find((c) => c.name === 'skill "demo"');
      expect(check?.ok).toBe(false);
      expect(check?.detail).toContain('unverifiable at');
      expect(check?.detail).toContain('symbolic links are not permitted');
    }
  });

  it('reports unverifiable when store manifest is corrupt or missing required schema', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);
    const storeDir = join(f.options.stroqHome, 'store', `sha256-${added.digest.slice(0, 32)}`);
    const manifestPath = join(storeDir, 'manifest.json');

    // Corrupt the manifest JSON
    await writeFile(manifestPath, '{"invalid": "schema"}');
    const report = await doctorReport(f.options.project, { home: f.options.stroqHome });
    const check = report.checks.find((c) => c.name === 'skill "demo"');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('unverifiable at');
    expect(check?.detail).toContain('invalid schema');
  });

  it('reports unverifiable when passports lock file is invalid', async () => {
    const f = await setup();
    await mkdir(f.options.stroqHome, { recursive: true });
    await writeFile(join(f.options.stroqHome, 'passports.json'), 'not valid json {{{');

    const report = await doctorReport(f.options.project, { home: f.options.stroqHome });
    const check = report.checks.find((c) => c.name === 'skills');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('unverifiable: passports lock is invalid or unreadable');
  });

  it('does not treat revoked records as missing active installs', async () => {
    const f = await setup();
    await addSkill(f.source, f.options);
    await removeSkill('demo', f.options);

    const lock = await readPassports(f.options.stroqHome);
    expect(lock.skills.demo?.status).toBe('revoked');

    const report = await doctorReport(f.options.project, { home: f.options.stroqHome });
    const skillChecks = report.checks.filter((c) => c.name.startsWith('skill'));
    expect(skillChecks).toEqual([]);
  });

  it('does not report installs belonging to another project', async () => {
    const f = await setup();
    await addSkill(f.source, f.options);

    const anotherProject = join(f.root, 'another-project');
    await mkdir(anotherProject);

    const report = await doctorReport(anotherProject, { home: f.options.stroqHome });
    const skillChecks = report.checks.filter((c) => c.name.startsWith('skill'));
    expect(skillChecks).toEqual([]);
  });

  it('safely renders skill names and paths with quotePath', async () => {
    const f = await setup();
    const weirdName = 'bad"name';
    const fakeRecord = {
      kind: 'skill' as const,
      status: 'confirmed' as const,
      source: f.source,
      digest: 'a'.repeat(64),
      passport: {
        artifact: {
          kind: 'skill' as const,
          digest: 'a'.repeat(64),
          names: [weirdName],
          files: 1,
          bytes: 10,
        },
        declared: { sensitive: [], network: [] },
        observed: { sensitive: [], network: [] },
        rules: [],
        blindSpots: [],
        unsupported: [],
      },
      installedTo: join(f.options.project, '.claude', 'skills', weirdName),
      root: f.options.project,
      history: [],
    };

    const check = await checkSingleSkillIntegrity(weirdName, fakeRecord as any, {
      isUser: false,
      home: f.options.stroqHome,
    });
    expect(check.name).toBe('skill "bad\\"name"');
    expect(check.detail).toContain('"');
    expect(check.ok).toBe(false);
  });

  it('is strictly read-only: does not modify passports lock, store, or receipts', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);
    const passportsPath = join(f.options.stroqHome, 'passports.json');
    const lockBefore = await readFile(passportsPath, 'utf8');

    // Simulate drift on disk
    await writeFile(join(added.installedTo, 'SKILL.md'), 'tampered content');

    // Run doctor diagnosis
    const report = await doctorReport(f.options.project, { home: f.options.stroqHome });
    const check = report.checks.find((c) => c.name === 'skill "demo"');
    expect(check?.ok).toBe(false);

    // Verify lockfile on disk was untouched
    const lockAfter = await readFile(passportsPath, 'utf8');
    expect(lockAfter).toBe(lockBefore);

    const parsedLock = await readPassports(f.options.stroqHome);
    expect(parsedLock.skills.demo?.status).toBe('confirmed'); // NOT changed to drifted!
    expect(parsedLock.skills.demo?.history.length).toBe(1); // No new receipts added!
  });

  it('respects platform digest semantics for win32 and linux', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);

    const checkWin32 = await checkInstalledSkills(f.options.project, f.options.stroqHome, {
      platform: 'win32',
      stroqHome: f.options.stroqHome,
    });
    expect(checkWin32[0]?.ok).toBe(true);

    const checkLinux = await checkInstalledSkills(f.options.project, f.options.stroqHome, {
      platform: 'linux',
      stroqHome: f.options.stroqHome,
    });
    expect(checkLinux[0]?.ok).toBe(true);
  });
});
