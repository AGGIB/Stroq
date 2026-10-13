import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as lockModule from '../../src/install/lock.js';
import { AuditLog } from '@stroq/core';
import { tgzOf } from '../helpers/tar-writer.js';
import { addSkill, removeSkill } from '../../src/install/skill-install.js';
import { readPassports } from '../../src/install/lock.js';
import type { Terminal } from '../../src/ui/terminal.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'stroq-add-'));
  roots.push(root);
  const source = join(root, 'demo');
  const project = join(root, 'project');
  const home = join(root, 'home');
  const stroqHome = join(home, '.stroq');
  await Promise.all([mkdir(source), mkdir(project), mkdir(home)]);
  await writeFile(
    join(source, 'SKILL.md'),
    '---\nname: demo\ndescription: a demo\n---\n# Demo\nRead the project.\n',
  );
  let output = '';
  let prompts = 0;
  const terminal: Terminal = {
    interactive: true,
    color: false,
    color256: false,
    unicode: false,
    columns: 80,
    write: (text) => {
      output += text;
    },
    readLine: async (prompt) => {
      prompts += 1;
      return /12/.test(prompt)
        ? [...output.matchAll(/sha256:([0-9a-f]{64})/g)].at(-1)![1]!.slice(0, 12)
        : 'y';
    },
  };
  const options = { project, home, stroqHome, terminal };
  return { root, source, options, terminal, output: () => output, prompts: () => prompts };
}

describe('confirmed skill install', () => {
  it('lock compatibility: adds a skill to an MCP-only lock without discarding its confirmation', async () => {
    const f = await setup();
    const mcp = { server: { kind: 'mcp', status: 'confirmed', digest: 'a'.repeat(64) } };
    await mkdir(f.options.stroqHome);
    await writeFile(join(f.options.stroqHome, 'passports.json'), JSON.stringify({ v: 1, mcp }));
    await addSkill(f.source, f.options);
    const lock = await readPassports(f.options.stroqHome);
    expect(lock.mcp).toEqual(mcp);
    expect(lock.skills.demo?.status).toBe('confirmed');
  });

  it('lock compatibility: installs and removes constructor without inherited record lookups', async () => {
    const f = await setup();
    await expect(removeSkill('constructor', f.options)).rejects.toThrow(/not installed/);
    await writeFile(
      join(f.source, 'SKILL.md'),
      '---\nname: constructor\ndescription: a demo\n---\n# Demo\nRead the project.\n',
    );
    const added = await addSkill(f.source, f.options);
    expect(added.status).toBe('confirmed');
    await addSkill('constructor', f.options);
    await removeSkill('constructor', f.options);
    expect((await readPassports(f.options.stroqHome)).skills['constructor']?.status).toBe(
      'revoked',
    );
  });

  it('shows the inspected digest, copies the bytes, locks the passport and receipts an undo', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);
    expect(f.output()).toContain(`sha256:${added.digest}`);
    expect(f.prompts()).toBe(1);
    expect(await readFile(join(added.installedTo, 'SKILL.md'), 'utf8')).toBe(
      await readFile(join(f.source, 'SKILL.md'), 'utf8'),
    );
    const locked = (await readPassports(f.options.stroqHome)).skills.demo!;
    expect(locked.status).toBe('confirmed');
    expect(locked.passport.artifact.digest).toBe(added.digest);
    expect(locked.history[0]).toMatchObject({ action: 'add', confirmed: true, to: added.digest });
    await removeSkill('demo', f.options);
    await expect(readFile(join(added.installedTo, 'SKILL.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const removed = (await readPassports(f.options.stroqHome)).skills.demo!;
    expect(removed.status).toBe('revoked');
    expect(removed.history.map((r) => r.action)).toEqual(['add', 'remove']);
    expect(await readFile(join(f.options.stroqHome, 'audit.jsonl'), 'utf8')).toContain('remove');
    expect(await new AuditLog(join(f.options.stroqHome, 'audit.jsonl')).verify()).toMatchObject({
      ok: true,
      count: 2,
    });
  });

  it('refuses scripts and end of input without installing anything', async () => {
    const f = await setup();
    await expect(
      addSkill(f.source, { ...f.options, terminal: { ...f.terminal, interactive: false } }),
    ).rejects.toThrow(/terminal/);
    await expect(
      addSkill(f.source, { ...f.options, terminal: { ...f.terminal, readLine: async () => null } }),
    ).rejects.toThrow(/confirm/);
    await expect(readFile(join(f.options.stroqHome, 'passports.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('never overwrites a foreign skill, and installs --user into the home skills folder', async () => {
    const f = await setup();
    const target = join(f.options.project, '.claude', 'skills', 'demo');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'keep'), 'owner');
    await expect(addSkill(f.source, f.options)).rejects.toThrow(/exists/);
    expect(await readFile(join(target, 'keep'), 'utf8')).toBe('owner');
    const added = await addSkill(f.source, { ...f.options, user: true });
    expect(added.installedTo).toBe(join(f.options.home, '.claude', 'skills', 'demo'));
  });

  it('updates docs with y/N, requires a digest for new capabilities, and keeps receipt history', async () => {
    const f = await setup();
    const first = await addSkill(f.source, f.options);
    await writeFile(join(f.source, 'notes.md'), 'More examples.\n');
    const second = await addSkill('demo', f.options);
    expect(second.digest).not.toBe(first.digest);
    expect(f.prompts()).toBe(2);
    await writeFile(join(f.source, 'script.sh'), 'curl https://new.example.com/data\n');
    const third = await addSkill('demo', f.options);
    expect(f.prompts()).toBe(3);
    expect(
      (await readPassports(f.options.stroqHome)).skills.demo!.history.map((r) => r.material),
    ).toEqual([true, false, true]);
    expect(third.digest).not.toBe(second.digest);
  });

  it('records external drift and refuses removal until --force is given', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);
    await writeFile(join(added.installedTo, 'notes.md'), 'an outside edit');
    await expect(removeSkill('demo', f.options)).rejects.toThrow(/drift/);
    expect((await readPassports(f.options.stroqHome)).skills.demo!.status).toBe('drifted');
    await removeSkill('demo', { ...f.options, force: true });
    expect((await readPassports(f.options.stroqHome)).skills.demo!.status).toBe('revoked');
  });

  it('restores drifted bytes from the store without reading a changed source', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);
    await writeFile(join(added.installedTo, 'SKILL.md'), 'outside');
    await rm(f.source, { recursive: true });
    const restored = await addSkill('demo', { ...f.options, restore: true });
    expect(restored.digest).toBe(added.digest);
    expect(await readFile(join(added.installedTo, 'SKILL.md'), 'utf8')).toContain('# Demo');
  });

  it('refuses source links and never replaces a linked destination', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);
    await rm(added.installedTo, { recursive: true });
    await symlink(f.source, added.installedTo, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(removeSkill('demo', { ...f.options, force: true })).rejects.toThrow(/link/);
    expect(await readFile(join(f.source, 'SKILL.md'), 'utf8')).toContain('# Demo');
  });

  it('does not delete outside files hidden by the vet reader', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);
    await mkdir(join(added.installedTo, 'node_modules'));
    await writeFile(join(added.installedTo, 'node_modules', 'keep'), 'owner');
    await expect(removeSkill('demo', f.options)).rejects.toThrow(/drift/);
    expect(await readFile(join(added.installedTo, 'node_modules', 'keep'), 'utf8')).toBe('owner');
  });

  it('installs the inspected bytes when the source changes during confirmation', async () => {
    const f = await setup();
    const original = await readFile(join(f.source, 'SKILL.md'), 'utf8');
    const added = await addSkill(f.source, {
      ...f.options,
      terminal: {
        ...f.terminal,
        readLine: async (prompt) => {
          await writeFile(join(f.source, 'SKILL.md'), 'changed after inspection');
          return f.terminal.readLine(prompt);
        },
      },
    });
    expect(await readFile(join(added.installedTo, 'SKILL.md'), 'utf8')).toBe(original);
  });

  it('keeps the old install when an update is refused', async () => {
    const f = await setup();
    const first = await addSkill(f.source, f.options);
    await writeFile(join(f.source, 'notes.md'), 'new docs');
    await expect(
      addSkill('demo', { ...f.options, terminal: { ...f.terminal, readLine: async () => 'n' } }),
    ).rejects.toThrow(/confirm/);
    expect((await readPassports(f.options.stroqHome)).skills.demo!.digest).toBe(first.digest);
    await expect(readFile(join(first.installedTo, 'notes.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects missing names, unsafe names, and restore of an uninstalled source', async () => {
    const f = await setup();
    await expect(removeSkill('missing', f.options)).rejects.toThrow(/not installed/);
    await expect(removeSkill('../outside', f.options)).rejects.toThrow(/name/);
    await expect(addSkill(f.source, { ...f.options, restore: true })).rejects.toThrow(/installed/);
  });

  it('never replaces a malformed lock', async () => {
    const f = await setup();
    await mkdir(f.options.stroqHome);
    await writeFile(join(f.options.stroqHome, 'passports.json'), '{"unexpected":"owner"}');
    await expect(addSkill(f.source, f.options)).rejects.toThrow(/lock is invalid/);
    expect(await readFile(join(f.options.stroqHome, 'passports.json'), 'utf8')).toBe(
      '{"unexpected":"owner"}',
    );
  });

  it('rolls an update back if its lock cannot be written', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);
    await writeFile(join(f.source, 'notes.md'), 'new docs');
    vi.spyOn(lockModule, 'writePassports').mockRejectedValueOnce(new Error('disk refused'));
    await expect(addSkill('demo', f.options)).rejects.toThrow('disk refused');
    expect((await readPassports(f.options.stroqHome)).skills.demo!.digest).toBe(added.digest);
    await expect(readFile(join(added.installedTo, 'notes.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(added.installedTo, 'SKILL.md'), 'utf8')).toContain('# Demo');
  });

  it('rolls a removal back if its lock cannot be written', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);
    vi.spyOn(lockModule, 'writePassports').mockRejectedValueOnce(new Error('disk refused'));
    await expect(removeSkill('demo', f.options)).rejects.toThrow('disk refused');
    expect((await readPassports(f.options.stroqHome)).skills.demo!.status).toBe('confirmed');
    expect(await readFile(join(added.installedTo, 'SKILL.md'), 'utf8')).toContain('# Demo');
  });

  it('refuses a concurrent confirmation instead of losing a newer lock record', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);
    await expect(
      addSkill('demo', {
        ...f.options,
        terminal: {
          ...f.terminal,
          readLine: async (prompt) => {
            const lock = await readPassports(f.options.stroqHome);
            await lockModule.writePassports(f.options.stroqHome, {
              ...lock,
              skills: { ...lock.skills, demo: { ...lock.skills.demo!, status: 'drifted' } },
            });
            return f.terminal.readLine(prompt);
          },
        },
      }),
    ).rejects.toThrow(/lock changed/);
    expect((await readPassports(f.options.stroqHome)).skills.demo!.status).toBe('drifted');
    expect(await readFile(join(added.installedTo, 'SKILL.md'), 'utf8')).toContain('# Demo');
  });

  it('preserves an MCP lock map without using it as a skill confirmation', async () => {
    const f = await setup();
    await mkdir(f.options.stroqHome);
    const mcp = { demo: { kind: 'mcp', status: 'confirmed', digest: 'a'.repeat(64) } };
    await writeFile(
      join(f.options.stroqHome, 'passports.json'),
      JSON.stringify({ v: 1, skills: {}, mcp }),
    );
    await addSkill(f.source, f.options);
    expect((await readPassports(f.options.stroqHome)).mcp).toEqual(mcp);
  });

  it('keeps a store referenced by an MCP pin when removing a skill', async () => {
    const f = await setup();
    const added = await addSkill(f.source, f.options);
    const lock = await readPassports(f.options.stroqHome);
    await lockModule.writePassports(f.options.stroqHome, {
      ...lock,
      mcp: { server: { kind: 'mcp', status: 'confirmed', digest: added.digest } },
    });
    await removeSkill('demo', f.options);
    expect(
      await readFile(
        join(f.options.stroqHome, 'store', `sha256-${added.digest.slice(0, 32)}`, 'manifest.json'),
        'utf8',
      ),
    ).toContain('SKILL.md');
  });

  it('collects unreferenced old revisions but keeps an old revision pinned by MCP', async () => {
    const f = await setup();
    const first = await addSkill(f.source, f.options);
    await writeFile(join(f.source, 'notes.md'), 'second revision');
    const second = await addSkill('demo', f.options);
    const lock = await readPassports(f.options.stroqHome);
    await lockModule.writePassports(f.options.stroqHome, {
      ...lock,
      mcp: { server: { kind: 'mcp', status: 'confirmed', digest: first.digest } },
    });
    await removeSkill('demo', f.options);
    expect(
      await readFile(
        join(f.options.stroqHome, 'store', `sha256-${first.digest.slice(0, 32)}`, 'manifest.json'),
        'utf8',
      ),
    ).toContain('SKILL.md');
    await expect(
      readFile(
        join(f.options.stroqHome, 'store', `sha256-${second.digest.slice(0, 32)}`, 'manifest.json'),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports a committed install honestly if the secondary audit append fails', async () => {
    const f = await setup();
    vi.spyOn(AuditLog.prototype, 'append').mockRejectedValueOnce(new Error('disk refused'));
    await expect(addSkill(f.source, f.options)).rejects.toThrow(
      /add committed.*receipt.*audit append failed/,
    );
    expect((await readPassports(f.options.stroqHome)).skills.demo!.status).toBe('confirmed');
    expect(
      await readFile(join(f.options.project, '.claude', 'skills', 'demo', 'SKILL.md'), 'utf8'),
    ).toContain('# Demo');
  });

  it('can revoke a missing installation even after its parent directory was removed', async () => {
    const f = await setup();
    await addSkill(f.source, f.options);
    await rm(join(f.options.project, '.claude'), { recursive: true });
    await removeSkill('demo', { ...f.options, force: true });
    expect((await readPassports(f.options.stroqHome)).skills.demo!.status).toBe('revoked');
  });

  it('installs a local archive without unpacking its source first', async () => {
    const f = await setup();
    const archive = join(f.root, 'skill.tgz');
    const original = await readFile(join(f.source, 'SKILL.md'), 'utf8');
    await writeFile(archive, tgzOf([{ name: 'SKILL.md', data: original }]));
    const added = await addSkill(archive, f.options);
    expect(added.passport.artifact.source.type).toBe('tarball');
    expect(added.source).toBe(archive);
    expect(await readFile(join(added.installedTo, 'SKILL.md'), 'utf8')).toBe(original);
  });

  it('does not install a plugin or server as a skill', async () => {
    const f = await setup();
    await rm(join(f.source, 'SKILL.md'));
    await writeFile(
      join(f.source, 'package.json'),
      '{"name":"demo","main":"server.js","dependencies":{"@modelcontextprotocol/sdk":"1"}}',
    );
    await expect(addSkill(f.source, f.options)).rejects.toThrow(/skills only/);
    expect(f.prompts()).toBe(0);
  });

  it('rejects names that cannot be created on every supported filesystem', async () => {
    const f = await setup();
    await writeFile(join(f.source, 'SKILL.md'), '---\nname: con\n---\n# Demo\n');
    await expect(addSkill(f.source, f.options)).rejects.toThrow(/skill name/);
    expect(f.prompts()).toBe(0);
  });

  it.runIf(process.platform === 'win32')(
    'refuses executable archives before asking on Windows',
    async () => {
      const f = await setup();
      const archive = join(f.root, 'skill.tgz');
      await writeFile(
        archive,
        tgzOf([
          { name: 'SKILL.md', data: await readFile(join(f.source, 'SKILL.md'), 'utf8') },
          { name: 'run.sh', data: '#!/bin/sh\necho hi\n', mode: 0o755 },
        ]),
      );
      await expect(addSkill(archive, f.options)).rejects.toThrow(/Windows cannot preserve/);
      expect(f.prompts()).toBe(0);
    },
  );
});
