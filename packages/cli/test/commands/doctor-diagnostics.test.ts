import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSecretIndex, type SecretIndexStats } from '@stroq/core';
import { doctorReport, MCP_CONFIGS, type DoctorReport } from '../../src/commands/doctor.js';
import { installHooks, settingsPath } from '../../src/commands/init.js';
import { cursorHooksPath, installCursorHooks } from '../../src/commands/cursor-hooks.js';
import { codexHooksPath, installCodexHooks } from '../../src/commands/codex-hooks.js';
import { installWindsurfHooks, windsurfHooksPath } from '../../src/commands/windsurf-hooks.js';
import { recordInstall } from '../../src/commands/install-record.js';
import { mcpConfigPath } from '../../src/commands/mcp-config.js';

interface Diagnostic {
  kind: string;
  observations: { code: string; scope: string; agent: string | null; client: string | null }[];
}
const diagnostic = (report: DoctorReport, name: string): Diagnostic | undefined =>
  (report.checks.find((check) => check.name === name) as { diagnostic?: Diagnostic } | undefined)
    ?.diagnostic;
const stats: SecretIndexStats = {
  entries: 0,
  sources: 0,
  canaries: 0,
  builtAt: null,
  corrupt: false,
  truncated: false,
  unreadable: 0,
};
let root: string;
let cwd: string;
let entry: string;
let command: string;
const put = (file: string, value: unknown): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'stroq-doctor-typed-'));
  cwd = join(root, 'private-project-marker');
  mkdirSync(cwd);
  const userHome = join(root, 'private-home-marker');
  mkdirSync(userHome);
  vi.stubEnv('HOME', userHome);
  vi.stubEnv('USERPROFILE', userHome);
  vi.stubEnv('APPDATA', join(userHome, 'AppData'));
  vi.stubEnv('CODEX_HOME', join(userHome, '.codex'));
  vi.stubEnv('STROQ_HOME', join(root, 'data'));
  entry = join(root, 'private-entry-marker', 'index.js');
  put(entry, '');
  command = `"${process.execPath}" "${entry}"`;
  vi.spyOn(FileSecretIndex.prototype, 'stats').mockResolvedValue(stats);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('doctor typed observations retain source identity without interpreting display text', () => {
  it('does not describe absent Claude hooks as configured when Cursor carries the legacy passing row', async () => {
    installCursorHooks(cursorHooksPath('project', cwd), `${command} hook cursor`);
    const report = await doctorReport(cwd);
    expect(report.checks.find((check) => check.name === 'hooks')?.ok).toBe(true);
    expect(diagnostic(report, 'hooks')).toEqual({
      kind: 'agent-hooks',
      observations: ['project', 'user'].map((scope) => ({
        code: 'not-configured',
        scope,
        agent: 'claude-code',
        client: null,
      })),
    });
    expect((report as DoctorReport & { diagnosticsVersion?: number }).diagnosticsVersion).toBe(1);
    expect(report.version).toBe(1);
  });

  it('types the collapsed row as an unconfigured machine observation, not a Claude check', async () => {
    expect(diagnostic(await doctorReport(cwd), 'hooks')).toEqual({
      kind: 'agent-hooks',
      observations: [{ code: 'not-configured', scope: 'machine', agent: null, client: null }],
    });
  });

  it('keeps an unrecorded project distinct from a recorded user registration', async () => {
    const hook = `${command} hook claude-code`;
    installHooks(settingsPath('project', cwd), hook);
    installHooks(settingsPath('user', cwd), hook);
    recordInstall('claude-code', 'user', hook);
    expect(diagnostic(await doctorReport(cwd), 'hooks')?.observations).toEqual([
      { code: 'unrecorded-registration', scope: 'project', agent: 'claude-code', client: null },
      { code: 'ready', scope: 'user', agent: 'claude-code', client: null },
    ]);
  });

  it('distinguishes missing events from an unreadable other scope', async () => {
    const file = cursorHooksPath('project', cwd);
    installCursorHooks(file, `${command} hook cursor`);
    const config = JSON.parse(readFileSync(file, 'utf8'));
    delete config.hooks.beforeShellExecution;
    put(file, config);
    put(cursorHooksPath('user', cwd), '{ invalid private-source-marker');
    expect(
      diagnostic(await doctorReport(cwd, { all: true }), 'cursor hooks')?.observations,
    ).toEqual([
      { code: 'missing-events', scope: 'project', agent: 'cursor', client: null },
      { code: 'unreadable-source', scope: 'user', agent: 'cursor', client: null },
    ]);
  });

  it.each(['changed', 'vanished'] as const)(
    'reports %s registration from structured status',
    async (problem) => {
      const hook = `${command} hook claude-code`;
      recordInstall('claude-code', 'project', hook);
      installHooks(
        settingsPath('project', cwd),
        problem === 'changed' ? 'other hook claude-code' : hook,
      );
      if (problem === 'vanished') rmSync(entry);
      expect(
        diagnostic(await doctorReport(cwd, { all: true }), 'hooks')?.observations,
      ).toContainEqual({
        code: problem === 'changed' ? 'changed-registration' : 'missing-runtime',
        scope: 'project',
        agent: 'claude-code',
        client: null,
      });
    },
  );

  it('reports Codex approval rather than presenting complete event registration as ready', async () => {
    installCodexHooks(codexHooksPath('project', cwd), `${command} hook codex`);
    expect(
      diagnostic(await doctorReport(cwd, { all: true }), 'codex hooks')?.observations,
    ).toContainEqual({
      code: 'approval-required',
      scope: 'project',
      agent: 'codex',
      client: null,
    });
  });

  it('preserves a shadowed project observation beside a working user scope', async () => {
    installWindsurfHooks(windsurfHooksPath('project', cwd), `${command} hook windsurf`);
    installWindsurfHooks(windsurfHooksPath('user', cwd), `${command} hook windsurf`);
    put(join(cwd, '.devin/hooks.json'), { hooks: { pre_run_command: [{ command: 'foreign' }] } });
    expect(
      diagnostic(await doctorReport(cwd, { all: true }), 'windsurf hooks')?.observations,
    ).toContainEqual({
      code: 'shadowed-registration',
      scope: 'project',
      agent: 'windsurf',
      client: null,
    });
  });

  it('reports every MCP coverage issue even when one live wrapper keeps legacy ok true', async () => {
    const wrapper = (path: string) => ({
      command: process.execPath,
      args: [
        path,
        'mcp',
        '--server',
        'private-server-marker',
        '--client',
        'claude-code',
        '--cwd',
        cwd,
        '--',
        'srv',
      ],
    });
    put(mcpConfigPath('claude-code', 'project', cwd), {
      mcpServers: {
        live: wrapper(entry),
        stale: wrapper(join(root, 'absent-entry', 'index.js')),
        unwrapped: { command: 'foreign' },
      },
    });
    const report = await doctorReport(cwd, { all: true });
    expect(report.checks.find((check) => check.name === 'mcp proxy')?.ok).toBe(true);
    expect(diagnostic(report, 'mcp proxy')).toEqual({
      kind: 'mcp-proxy',
      observations: ['unwrapped-servers', 'stale-wrappers', 'unfiltered-environment'].map(
        (code) => ({
          code,
          scope: 'project',
          agent: null,
          client: 'claude-code',
        }),
      ),
    });
  });

  it('reports no MCP config separately from configured hooks', async () => {
    installHooks(settingsPath('project', cwd), `${command} hook claude-code`);
    expect(diagnostic(await doctorReport(cwd), 'mcp proxy')).toEqual({
      kind: 'mcp-proxy',
      observations: [{ code: 'no-config', scope: 'machine', agent: null, client: null }],
    });
  });

  it('reports one user-scope MCP source when the workspace is the home directory', async () => {
    const userHome = process.env['HOME']!;
    put(mcpConfigPath('cursor', 'project', userHome), {
      mcpServers: {
        live: {
          command: process.execPath,
          args: [
            entry,
            'mcp',
            '--server',
            'live',
            '--client',
            'cursor',
            '--cwd',
            userHome,
            '--',
            'srv',
          ],
        },
      },
    });
    expect(
      diagnostic(await doctorReport(userHome, { all: true }), 'mcp proxy')?.observations,
    ).toEqual([{ code: 'unfiltered-environment', scope: 'user', agent: null, client: 'cursor' }]);
  });

  it('retains all fifteen observed MCP issues across the five distinct sources without truncating', async () => {
    const wrapper = (path: string) => ({
      command: process.execPath,
      args: [
        path,
        'mcp',
        '--server',
        'private-server-marker',
        '--client',
        'cursor',
        '--cwd',
        cwd,
        '--',
        'srv',
      ],
    });
    for (const { client, scope } of MCP_CONFIGS)
      put(mcpConfigPath(client, scope, cwd), {
        mcpServers: {
          live: wrapper(entry),
          stale: wrapper(join(root, 'absent', 'index.js')),
          bare: { command: 'foreign' },
        },
      });
    const observations = diagnostic(
      await doctorReport(cwd, { all: true }),
      'mcp proxy',
    )!.observations;
    expect(observations).toHaveLength(15);
    expect(new Set(observations.map((value) => JSON.stringify(value))).size).toBe(15);
    expect(observations.some((value) => value.code === 'ready')).toBe(false);
  });

  it('uses a typed unsupported-runtime observation without changing the legacy Node check', async () => {
    const original = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
    try {
      Object.defineProperty(process.versions, 'node', { ...original, value: '20.0.0' });
      const report = await doctorReport(cwd);
      expect(report.checks.find((check) => check.name === 'node')?.ok).toBe(false);
      expect(diagnostic(report, 'node')).toEqual({
        kind: 'runtime',
        observations: [
          { code: 'platform-unsupported', scope: 'runtime', agent: null, client: null },
        ],
      });
    } finally {
      Object.defineProperty(process.versions, 'node', original);
    }
  });

  it('reports the pinned-copy sandbox launch conflict without claiming measured coverage', async () => {
    const hash = 'a'.repeat(64);
    put(join(process.env['STROQ_HOME']!, 'passports.json'), {
      v: 1,
      skills: {},
      mcp: {
        'private-server-marker': {
          kind: 'mcp',
          status: 'confirmed',
          digest: hash,
          grant: { pin: `sha256:${hash}` },
        },
      },
    });
    const report = await doctorReport(cwd);
    const check = report.checks.find((value) => value.name === 'mcp pins and the sandbox');
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain('not measured with a real srt');
    expect(diagnostic(report, 'mcp pins and the sandbox')).toEqual({
      kind: 'mcp-sandbox',
      observations: [
        { code: 'sandbox-launch-conflict', scope: 'unspecified', agent: null, client: null },
      ],
    });
  });

  it.each([
    ['not-built', {}],
    ['corrupt-index', { corrupt: true }],
    ['incomplete-index', { builtAt: '2026-10-23T00:00:00.000Z', unreadable: 1 }],
    ['incomplete-index', { builtAt: '2026-10-23T00:00:00.000Z', truncated: true }],
    ['ready', { builtAt: '2026-10-23T00:00:00.000Z' }],
  ] as const)(
    'reports secret-index %s without scanning credential sources',
    async (code, change) => {
      vi.mocked(FileSecretIndex.prototype.stats).mockResolvedValue({ ...stats, ...change });
      expect(diagnostic(await doctorReport(cwd), 'secrets')).toEqual({
        kind: 'secret-index',
        observations: [{ code, scope: 'data', agent: null, client: null }],
      });
    },
  );

  it('reports unavailable secret statistics without returning the exception in metadata', async () => {
    vi.mocked(FileSecretIndex.prototype.stats).mockRejectedValue(
      new Error('private-source-marker'),
    );
    expect(diagnostic(await doctorReport(cwd), 'secrets')).toEqual({
      kind: 'secret-index',
      observations: [{ code: 'unavailable', scope: 'data', agent: null, client: null }],
    });
  });

  it('annotates every row with a closed metadata shape free of source values', async () => {
    const report = await doctorReport(cwd, { all: true });
    for (const check of report.checks) {
      const value = diagnostic(report, check.name)!;
      expect(Object.keys(value).sort()).toEqual(['kind', 'observations']);
      expect(value.observations.length).toBeGreaterThan(0);
      expect(value.observations.length).toBeLessThanOrEqual(16);
      for (const observation of value.observations)
        expect(Object.keys(observation).sort()).toEqual(['agent', 'client', 'code', 'scope']);
      expect(JSON.stringify(value)).not.toMatch(
        /private-|stroq-doctor-typed|last hook|proof|[\\/]/,
      );
    }
  });
});
