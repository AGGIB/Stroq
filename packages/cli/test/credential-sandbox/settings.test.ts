import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../../src/commands/init.js';
import { runUninstall } from '../../src/commands/uninstall.js';
import { claudeSandboxStatus, type SandboxLocation } from '../../src/credential-sandbox/status.js';
import { BASE_PATHS, EXTRA_PATHS, RETRY_RULE } from '../../src/credential-sandbox/rules.js';

let home: string, cwd: string, settings: string, where: SandboxLocation;
const save = (file: string, value: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};
const read = () => JSON.parse(readFileSync(settings, 'utf8'));
const entry = (path: string) => ({ path, mode: 'deny' });
/** A user-scope install as an interactive run makes it: a person agreed to the list, and to nothing more. */
const init = (args: string[] = []) =>
  runInit(['--user', ...args], { platform: 'darwin', sandbox: {} });
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'stroq-credentials-'));
  cwd = join(home, 'project');
  mkdirSync(cwd);
  settings = join(home, '.claude/settings.json');
  where = { home, cwd, platform: 'darwin', managedDir: join(home, 'managed'), env: {} };
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CLAUDE_CONFIG_DIR', undefined);
  vi.stubEnv('STROQ_HOME', join(home, '.stroq'));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('user-scope Claude credential rules', () => {
  it('previews the actual list without touching disk, and the list alone never enables the sandbox', async () => {
    await init(['--dry-run']);
    const preview = JSON.parse(vi.mocked(process.stdout.write).mock.calls[0]![0] as string);
    expect(existsSync(settings)).toBe(false);
    expect(existsSync(join(home, '.stroq'))).toBe(false);
    await init();
    expect(read()).toEqual(preview);
    expect(read().sandbox.credentials.files).toEqual(BASE_PATHS.map(entry));
    expect(read().sandbox.enabled).toBeUndefined();
    expect(BASE_PATHS).toHaveLength(8);
    expect(EXTRA_PATHS).toHaveLength(5);
  });
  it('reinstalls once and removes only newly added entries, across concurrent runs', async () => {
    const original = { theme: 'test', sandbox: { credentials: { files: [entry('~/.ssh')] } } };
    save(settings, original);
    await Promise.all([init(), init()]);
    const value = read();
    expect(value.sandbox.credentials.files).toHaveLength(8);
    value.sandbox.credentials.files.push(entry('~/my-key'));
    save(settings, value);
    await runUninstall(['--user']);
    expect(read()).toEqual({
      ...original,
      sandbox: { credentials: { files: [entry('~/.ssh'), entry('~/my-key')] } },
    });
    await runUninstall(['--user']);
    expect(read().sandbox.credentials.files).toHaveLength(2);
  });
  it('preserves a mask, pre-existing empty containers and user ownership when the ledger is absent', async () => {
    const mask = { path: '~/.ssh', mode: 'mask', extract: 'example' };
    save(settings, { sandbox: { credentials: { files: [mask] } }, permissions: {} });
    await init();
    expect(
      read().sandbox.credentials.files.filter((e: { path: string }) => e.path === '~/.ssh'),
    ).toEqual([mask]);
    vi.stubEnv('STROQ_HOME', join(home, 'other-stroq'));
    await runUninstall(['--user']);
    expect(read().sandbox.credentials.files).toHaveLength(8);
  });
  it('refuses malformed credential settings before changing hooks', async () => {
    const bad = { sandbox: { credentials: { files: 'mine' } } };
    save(settings, bad);
    await expect(init()).rejects.toThrow();
    expect(read()).toEqual(bad);
  });
  it('only installs the hooks on native Windows and for a project install', async () => {
    await runInit(['--user'], {
      platform: 'win32',
      sandbox: { enable: true },
      probe: async () => ({ ok: true, detail: '' }),
    });
    expect(read().sandbox).toBeUndefined();
    await runInit([], { platform: 'darwin', sandbox: { enable: true } });
    expect(
      JSON.parse(readFileSync(join(cwd, '.claude/settings.json'), 'utf8')).sandbox,
    ).toBeUndefined();
  });
});

describe('Claude configuration status', () => {
  it('separates a staged list from an enabled sandbox and reports overrides and exceptions', () => {
    save(settings, {
      sandbox: {
        enabled: true,
        credentials: { files: BASE_PATHS.map(entry) },
        filesystem: { allowRead: ['~/.ssh/config'] },
        excludedCommands: ['example'],
      },
      permissions: { ask: [RETRY_RULE] },
    });
    const on = claudeSandboxStatus(where);
    expect(on).toMatchObject({
      state: 'on',
      source: 'user',
      listed: 8,
      overlaps: 1,
      retry: 'asks',
      excluded: 1,
    });
    save(join(cwd, '.claude/settings.local.json'), { sandbox: { enabled: false } });
    expect(claudeSandboxStatus(where)).toMatchObject({ state: 'off', source: 'local', listed: 8 });
    save(join(home, 'managed/managed-settings.json'), {
      sandbox: { enabled: true, filesystem: { disabled: true } },
    });
    expect(claudeSandboxStatus(where)).toMatchObject({
      state: 'filesystem-off',
      source: 'managed',
    });
  });
  it('reports unknown on unparseable settings and native Windows explicitly', () => {
    save(settings, { sandbox: { enabled: 'yes' } });
    expect(claudeSandboxStatus(where).state).toBe('unknown');
    expect(claudeSandboxStatus({ ...where, platform: 'win32' }).state).toBe('unsupported');
  });
});

describe('consent and recovery', () => {
  it('restores the prior enabled value, keeps user ask rules and restores empty containers', async () => {
    const original = {
      sandbox: { enabled: false, autoAllowBashIfSandboxed: true, credentials: { files: [] } },
      permissions: { ask: ['Read(example)'] },
    };
    save(settings, original);
    await runInit(['--user'], { platform: 'darwin', sandbox: { enable: true, extra: true } });
    expect(read().sandbox).toMatchObject({ enabled: true, autoAllowBashIfSandboxed: true });
    expect(read().sandbox.credentials.files).toHaveLength(13);
    expect(read().permissions.ask).toEqual(['Read(example)', RETRY_RULE]);
    const installed = read();
    await runUninstall(['--user', '--dry-run']);
    expect(read()).toEqual(installed);
    await runUninstall(['--user']);
    expect(read()).toEqual(original);
  });
  it('keeps a user edit to a boolean and a changed rule on removal', async () => {
    await runInit(['--user'], { platform: 'darwin', sandbox: { enable: true } });
    const edited = read();
    edited.sandbox.enabled = false;
    edited.sandbox.credentials.files[0].mode = 'mask';
    save(settings, edited);
    await runUninstall(['--user']);
    expect(read()).toEqual({
      sandbox: { enabled: false, credentials: { files: [{ path: '~/.ssh', mode: 'mask' }] } },
    });
  });
  it('keeps hook-only previews and installs out of credential settings', async () => {
    await init(['--hooks-only', '--dry-run']);
    expect(
      JSON.parse(String(vi.mocked(process.stdout.write).mock.calls[0]![0])).sandbox,
    ).toBeUndefined();
    await init(['--hooks-only']);
    expect(read().sandbox).toBeUndefined();
  });
  it('recovers the ownership record when a write stops after replacing the settings', async () => {
    const atomic = await import('../../src/harden/atomic.js');
    const write = atomic.writeFileAtomic;
    const spy = vi
      .spyOn(atomic, 'writeFileAtomic')
      .mockImplementation(async (file, data, options) => {
        if (file.includes(join('.stroq', 'sandbox')) && !String(data).includes('"pending"'))
          throw new Error('interrupted');
        return write(file, data, options);
      });
    await expect(init()).rejects.toThrow('interrupted');
    expect(read().sandbox.credentials.files).toHaveLength(8);
    spy.mockRestore();
    await init();
    await runUninstall(['--user']);
    expect(read()).toEqual({});
  });
  it('retries cleanly after the settings write fails and does not act on a malformed receipt', async () => {
    const atomic = await import('../../src/harden/atomic.js');
    const write = atomic.writeFileAtomic;
    const spy = vi
      .spyOn(atomic, 'writeFileAtomic')
      .mockImplementation(async (file, data, options) => {
        if (file === settings) throw new Error('settings busy');
        return write(file, data, options);
      });
    await expect(init()).rejects.toThrow('settings busy');
    expect(existsSync(settings)).toBe(false);
    spy.mockRestore();
    await init();
    const { readdirSync } = await import('node:fs');
    const dir = join(home, '.stroq', 'sandbox');
    const ledger = join(dir, readdirSync(dir)[0]!);
    const malformed = { version: 1, owned: [{ id: 'unknown', created: 0, previous: null }] };
    save(ledger, malformed);
    const installed = read();
    await runUninstall(['--user']);
    expect(read()).toEqual({ sandbox: installed.sandbox });
    expect(JSON.parse(readFileSync(ledger, 'utf8'))).toEqual(malformed);
  });
});

describe('other agents and the card', () => {
  it('reads the selected Codex profile, handles conflicts and never changes its TOML', async () => {
    const { sandboxReports, CODEX_EXAMPLE } =
      await import('../../src/credential-sandbox/report.js');
    const configDir = join(home, 'custom-codex');
    mkdirSync(configDir);
    const path = join(configDir, 'config.toml');
    const from = () =>
      sandboxReports({ ...where, env: { CODEX_HOME: configDir } }, false).find(
        (r) => r.agent === 'codex',
      )!.detail;
    writeFileSync(path, CODEX_EXAMPLE);
    expect(from()).toContain('8/13');
    expect(readFileSync(path, 'utf8')).toBe(CODEX_EXAMPLE);
    writeFileSync(path, 'sandbox_mode = "workspace-write"\n' + CODEX_EXAMPLE);
    expect(from()).toContain('mixes');
    writeFileSync(path, 'sandbox_mode = "danger-full-access"');
    expect(from()).toContain('full access');
    writeFileSync(path, 'invalid[');
    expect(from()).toContain('could not be assessed');
  });
  it('reports Cursor workspace overrides without writing to either file', async () => {
    const { sandboxReports } = await import('../../src/credential-sandbox/report.js');
    save(join(home, '.cursor/sandbox.json'), { readBoundary: 'workspace' });
    const file = join(cwd, '.cursor/sandbox.json');
    save(file, { readBoundary: 'system' });
    const from = () => sandboxReports(where, false).find((r) => r.agent === 'cursor')!.detail;
    expect(from()).toContain('project sandbox.json sets system');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ readBoundary: 'system' });
    save(file, { type: 'insecure_none' });
    expect(from()).toContain('unsandboxed');
    save(file, { readBoundary: 'unrecognized' });
    expect(from()).toContain('could not be assessed');
  });
  it('includes the file-based status on a no-sessions card, and keeps it out of the shared line', async () => {
    const { buildCard } = await import('../../src/card/build.js');
    const { cardView, shareLine } = await import('../../src/card/render.js');
    const { cardDataSchema } = await import('../../src/card/data-schema.js');
    save(settings, {});
    const data = await buildCard(1, {
      cwd,
      home,
      env: {},
      stroqHome: join(home, '.stroq'),
      now: new Date(),
      version: 'test',
    });
    expect(cardDataSchema.safeParse(data).success).toBe(true);
    expect(data.coverage.sandboxNote).toContain('sandbox');
    expect(cardView(data, home)).toMatchObject({
      kind: 'nothing-to-read',
      looked: expect.stringContaining('sandbox'),
    });
    expect(shareLine(data)).not.toContain('sandbox');
  });
});

describe('scope precedence', () => {
  it('uses the active Claude profile for installation, diagnosis and removal', async () => {
    const profile = join(home, 'work-claude');
    vi.stubEnv('CLAUDE_CONFIG_DIR', profile);
    const env = { CLAUDE_CONFIG_DIR: profile };
    save(settings, { sandbox: { enabled: false } });
    await init();
    const active = join(profile, 'settings.json');
    expect(JSON.parse(readFileSync(active, 'utf8')).sandbox.credentials.files).toHaveLength(8);
    expect(claudeSandboxStatus({ ...where, env })).toMatchObject({ listed: 8 });
    await runUninstall(['--user']);
    expect(JSON.parse(readFileSync(active, 'utf8'))).toEqual({});
    expect(read()).toEqual({ sandbox: { enabled: false } });
  });
  it('compares exact denies with child allowances, including Read and Edit rules', () => {
    save(settings, {
      sandbox: { enabled: true, filesystem: { denyRead: ['~/.ssh/'], allowRead: ['~/'] } },
      permissions: {
        deny: ['Read(~/.npmrc)'],
        allow: ['Edit(~/.ssh/config)'],
        additionalDirectories: ['~/.npmrc-extra'],
      },
    });
    expect(claudeSandboxStatus(where)).toMatchObject({ state: 'on', listed: 2, overlaps: 1 });
    save(join(cwd, '.claude/settings.json'), {
      sandbox: { filesystem: { disabled: true, allowRead: ['~/.npm*'] } },
    });
    expect(claudeSandboxStatus(where)).toMatchObject({ state: 'on', listed: 2, overlaps: 2 });
  });
  it('respects a managed policy and handles same-level settings fragments in order', () => {
    save(settings, {
      sandbox: { enabled: true, allowUnsandboxedCommands: false },
      permissions: { ask: [RETRY_RULE] },
    });
    save(join(cwd, '.claude/settings.local.json'), {
      sandbox: { enabled: false, allowUnsandboxedCommands: true, excludedCommands: ['example'] },
    });
    expect(claudeSandboxStatus(where)).toMatchObject({
      state: 'off',
      retry: 'closed',
      excluded: 1,
    });
    const dir = join(home, 'managed', 'managed-settings.d');
    save(join(dir, '10-base.json'), { sandbox: { enabled: false } });
    save(join(dir, '20-policy.json'), {
      sandbox: { enabled: true, allowUnsandboxedCommands: false, excludedCommands: ['managed'] },
    });
    save(join(dir, '.temporary.json'), { sandbox: { enabled: false } });
    expect(claudeSandboxStatus(where)).toMatchObject({
      state: 'on',
      source: 'managed',
      retry: 'closed',
      excluded: 1,
    });
  });
  it('only counts managed read allowances and ask rules when the corresponding policy requires it', () => {
    save(settings, {
      sandbox: {
        enabled: true,
        credentials: { files: [entry('~/.ssh')] },
        filesystem: { allowRead: ['~/.ssh/config'] },
      },
      permissions: { ask: [RETRY_RULE] },
    });
    save(join(home, 'managed/managed-settings.json'), {
      allowManagedPermissionRulesOnly: true,
      sandbox: { filesystem: { allowManagedReadPathsOnly: true } },
    });
    expect(claudeSandboxStatus(where)).toMatchObject({
      state: 'on',
      listed: 1,
      overlaps: 0,
      retry: 'open',
    });
  });
});

it.skipIf(process.platform === 'win32')(
  'keeps edits inside an explicitly selected external profile',
  async () => {
    const { symlinkSync } = await import('node:fs');
    const profile = mkdtempSync(join(tmpdir(), 'stroq-config-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', profile);
    const other = join(home, 'another-config.json');
    save(other, { theme: 'other profile' });
    symlinkSync(other, join(profile, 'settings.json'));
    await expect(init()).rejects.toThrow();
    expect(JSON.parse(readFileSync(other, 'utf8'))).toEqual({ theme: 'other profile' });
  },
);
