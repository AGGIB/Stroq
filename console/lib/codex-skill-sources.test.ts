import { describe, expect, it } from 'vitest';
import { validateCodexSkillSourcesReport } from './codex-skill-sources';

const sourceId = 'source-' + 'a'.repeat(24);
const candidate = (id = 'candidate-' + 'b'.repeat(24)) => ({
  id,
  sourceId,
  name: 'Release notes',
  location: { label: 'release-notes', redacted: false },
  entrypointSha256: 'c'.repeat(64),
  bytes: 42,
  declaredState: 'disabled',
  metadata: 'valid',
  scan: { status: 'clean', findings: 0, matches: [], omitted: 0 },
});
const report = () => ({
  schema: 'stroq-codex-skill-sources/1',
  source: 'local',
  workspaceId: 'workspace-' + 'd'.repeat(24),
  generatedAt: '2026-10-24T12:00:01.000Z',
  runtimeSha256: 'e'.repeat(64),
  capture: {
    startedAt: '2026-10-24T12:00:00.000Z',
    completedAt: '2026-10-24T12:00:01.000Z',
    atomicSnapshot: false,
  },
  context: { boundary: 'marker', ancestorCount: 1, markerPolicy: 'default', profile: 'default' },
  settings: { status: 'ready', sha256: 'f'.repeat(64), rules: 1, unmatchedRules: 0 },
  sources: [
    {
      id: sourceId,
      family: 'agents',
      scope: 'ancestor',
      distance: 1,
      label: '../.agents/skills',
      status: 'complete',
      candidates: 1,
    },
  ],
  items: [candidate()],
  gaps: [],
  omitted: { sources: 0, items: 0 },
});

describe('manual Codex skill source evidence', () => {
  it('accepts source-bound candidates without inferring a loaded host or effective enablement', () => {
    expect(validateCodexSkillSourcesReport(report())).toBe(true);
    const value = report();
    value.items.push(candidate('candidate-' + '9'.repeat(24)));
    value.sources[0]!.candidates = 2;
    expect(validateCodexSkillSourcesReport(value)).toBe(true);
  });
  it('refuses browser paths, raw config, source bodies and extra host protection claims', () => {
    for (const key of ['path', 'config', 'instructions', 'loaded', 'protected'])
      expect(
        validateCodexSkillSourcesReport({ ...report(), [key]: '/private/token-sentinel' }),
      ).toBe(false);
    const value = report();
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        items: [{ ...candidate(), path: '/private/skill' }],
      }),
    ).toBe(false);
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        items: [{ ...candidate(), declaredState: 'active' }],
      }),
    ).toBe(false);
  });
  it('rejects dangling or duplicated source/candidate identities and inconsistent counts', () => {
    const value = report();
    expect(validateCodexSkillSourcesReport({ ...value, sources: [] })).toBe(false);
    expect(
      validateCodexSkillSourcesReport({ ...value, sources: [...value.sources, ...value.sources] }),
    ).toBe(false);
    expect(
      validateCodexSkillSourcesReport({ ...value, items: [...value.items, ...value.items] }),
    ).toBe(false);
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        sources: [{ ...value.sources[0], candidates: 2 }],
      }),
    ).toBe(false);
  });
  it('keeps unavailable hashes, invalid metadata and unknown config explicit', () => {
    const value = report();
    const item = {
      ...candidate(),
      entrypointSha256: null,
      metadata: 'invalid',
      declaredState: 'unknown',
      scan: { status: 'incomplete', findings: 0, matches: [], omitted: 0 },
    };
    expect(validateCodexSkillSourcesReport({ ...value, items: [item] })).toBe(true);
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        items: [{ ...item, scan: { ...item.scan, status: 'clean' } }],
      }),
    ).toBe(false);
    expect(
      validateCodexSkillSourcesReport({ ...value, items: [{ ...item, declaredState: 'enabled' }] }),
    ).toBe(false);
  });
  it('bounds capture ordering, source distances, entrypoint bytes and static signals', () => {
    const value = report();
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        capture: { ...value.capture, completedAt: '2026-10-23T12:00:00.000Z' },
      }),
    ).toBe(false);
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        sources: [{ ...value.sources[0], distance: 33 }],
      }),
    ).toBe(false);
    expect(
      validateCodexSkillSourcesReport({ ...value, items: [{ ...candidate(), bytes: 65537 }] }),
    ).toBe(false);
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        items: [
          { ...candidate(), scan: { status: 'suspect', findings: 1, matches: [], omitted: 0 } },
        ],
      }),
    ).toBe(false);
  });
  it('refuses absolute source labels and completeness claims for uninspected source families', () => {
    const value = report();
    for (const label of [
      '/private/profile/.agents/skills',
      'C:\\Users\\profile\\skills',
      'https://private.invalid/skills',
    ])
      expect(
        validateCodexSkillSourcesReport({ ...value, sources: [{ ...value.sources[0], label }] }),
      ).toBe(false);
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        sources: [{ ...value.sources[0], family: 'plugins', scope: 'plugins', distance: null }],
      }),
    ).toBe(false);
  });
  it('never turns missing or invalid settings and unreadable entrypoints into declared enablement', () => {
    const value = report();
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        settings: { status: 'ready', sha256: null, rules: 0, unmatchedRules: 0 },
      }),
    ).toBe(false);
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        settings: { status: 'missing', sha256: null, rules: 1, unmatchedRules: 0 },
      }),
    ).toBe(false);
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        settings: { status: 'invalid', sha256: 'f'.repeat(64), rules: 0, unmatchedRules: 0 },
      }),
    ).toBe(false);
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        items: [
          {
            ...candidate(),
            entrypointSha256: null,
            declaredState: 'enabled',
            scan: { status: 'incomplete', findings: 0, matches: [], omitted: 0 },
          },
        ],
      }),
    ).toBe(false);
  });
  it('returns false for malformed transport values without throwing', () => {
    const value = report();
    for (const bad of [
      null,
      false,
      [],
      42,
      { ...value, items: [null] },
      { ...value, sources: [false] },
      { ...value, gaps: [null] },
      { ...value, items: [{ ...candidate(), scan: null }] },
    ]) {
      expect(() => validateCodexSkillSourcesReport(bad)).not.toThrow();
      expect(validateCodexSkillSourcesReport(bad)).toBe(false);
    }
  });
  it('accepts captured legacy sources with the same bounded evidence as shared skills', () => {
    for (const scope of ['cwd', 'ancestor', 'user']) {
      const value = report();
      Object.assign(value.sources[0]!, {
        family: 'codex-legacy',
        scope,
        distance: scope === 'cwd' ? 0 : scope === 'ancestor' ? 1 : null,
      });
      expect(validateCodexSkillSourcesReport(value)).toBe(true);
    }
    const value = report();
    value.gaps.push({ code: 'source-limit' } as never);
    value.omitted.sources = 5;
    expect(validateCodexSkillSourcesReport(value)).toBe(true);
  });
  it('closes source family/scope combinations and refuses candidates on absent or uninspected roots', () => {
    for (const [family, scope, distance] of [
      ['agents', 'system', null],
      ['codex-legacy', 'plugins', null],
      ['plugins', 'cwd', 0],
      ['admin', 'user', null],
      ['system', 'ancestor', 1],
    ] as const) {
      const value = report();
      Object.assign(value.sources[0]!, {
        family,
        scope,
        distance,
        status: 'uninspected',
        candidates: 0,
      });
      value.items = [];
      expect(validateCodexSkillSourcesReport(value)).toBe(false);
    }
    for (const status of ['absent', 'uninspected']) {
      const value = report();
      Object.assign(value.sources[0]!, { family: 'codex-legacy', status });
      expect(validateCodexSkillSourcesReport(value)).toBe(false);
    }
  });
  it('keeps ancestor evidence inside the reported marker boundary', () => {
    const value = report();
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        sources: [{ ...value.sources[0], distance: 2 }],
      }),
    ).toBe(false);
    for (const boundary of ['cwd-only', 'limit', 'unverifiable'])
      expect(
        validateCodexSkillSourcesReport({
          ...value,
          context: { ...value.context, boundary, ancestorCount: 0 },
        }),
      ).toBe(false);
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        context: { ...value.context, profile: 'unverified' },
        sources: [{ ...value.sources[0], family: 'codex-legacy', scope: 'user', distance: null }],
      }),
    ).toBe(false);
  });
  it('retains changed-context ancestor observations only as incomplete unknown historical evidence', () => {
    const value = report();
    value.context = { ...value.context, boundary: 'unverifiable', ancestorCount: 0 };
    value.sources[0]!.status = 'partial';
    value.items[0]!.declaredState = 'unknown';
    value.items[0]!.scan.status = 'incomplete';
    value.gaps.push({ code: 'changed-context' } as never);
    expect(validateCodexSkillSourcesReport(value)).toBe(true);
    expect(validateCodexSkillSourcesReport({ ...value, gaps: [] })).toBe(false);
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        items: [{ ...value.items[0], declaredState: 'enabled' }],
      }),
    ).toBe(false);
    expect(
      validateCodexSkillSourcesReport({
        ...value,
        sources: [{ ...value.sources[0], status: 'complete' }],
      }),
    ).toBe(false);
  });
});
