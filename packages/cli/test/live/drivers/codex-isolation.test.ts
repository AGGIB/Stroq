import { join } from 'node:path';
import { mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeRig } from '../rig.js';
import { describe, expect, it } from 'vitest';
import {
  codexHookSources,
  codexIsolationProblem,
} from '../../../src/live/drivers/codex-isolation.js';

describe('Codex hook isolation preflight', () => {
  it.each(['linux', 'darwin', 'win32'] as const)(
    'checks standalone user hooks and local managed sources on %s',
    (platform) => {
      const sources = codexHookSources(
        { CODEX_HOME: '/fake/codex', ProgramData: '/fake/program-data' },
        '/fake/project',
        platform,
      );
      expect(sources.some((path) => path.endsWith(join('codex', 'hooks.json')))).toBe(true);
      expect(sources.some((path) => path.endsWith('requirements.toml'))).toBe(true);
      expect(sources.some((path) => path.endsWith(join('.codex', 'config.toml')))).toBe(true);
      if (platform === 'darwin')
        expect(sources).toContain('/Library/Managed Preferences/com.openai.codex.plist');
    },
  );
  it('proceeds only when all candidate sources are absent', () => {
    const absent = (): never => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    };
    expect(codexIsolationProblem({}, tmpdir(), absent)).toBeNull();
  });
  it('refuses unreadable sources and does not echo the source content', () => {
    const unreadable = (): never => {
      throw Object.assign(new Error('private text'), { code: 'EACCES' });
    };
    expect(codexIsolationProblem({}, tmpdir(), unreadable)).toBe(
      'Codex hook sources could not be inspected safely; no inference request was made',
    );
  });
  it('ignores the base user config while still inspecting its standalone hooks file', () => {
    const sources = codexHookSources({ CODEX_HOME: '/fake/.codex' }, '/fake/project');
    expect(sources.filter((path) => path.endsWith(join('.codex', 'config.toml')))).not.toContain(
      join('/fake', '.codex', 'config.toml'),
    );
  });
  it('refuses a relative authentication home before looking in the wrong directory', () => {
    expect(codexIsolationProblem({ CODEX_HOME: 'relative' }, '/fake/project')).toContain(
      'must be an absolute path',
    );
  });
  it('refuses a project whose physical directory cannot be established', () => {
    expect(codexIsolationProblem({}, join(tmpdir(), 'no-such-stroq-project'))).toContain(
      'real path could not be established',
    );
  });
  it('inspects ancestors of the physical cwd as well as a directory alias', () => {
    const rig = makeRig();
    try {
      const physical = join(rig.root, 'physical');
      mkdirSync(join(physical, 'project'), { recursive: true });
      const alias = join(rig.root, 'alias');
      symlinkSync(
        join(physical, 'project'),
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect(codexHookSources({ CODEX_HOME: rig.home }, alias)).toContain(
        join(physical, '.codex', 'config.toml'),
      );
    } finally {
      rig.cleanup();
    }
  });
});
