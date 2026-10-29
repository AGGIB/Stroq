export const workspace = 'workspace-' + 'a'.repeat(24);
export const runtime = 'c'.repeat(64);
export const sourceId = (n = 1) => 'source-' + String(n).padStart(24, '0');
export const candidateId = (n = 1) => 'candidate-' + String(n).padStart(24, '0');
export function codexSourcesFixture() {
  return {
    schema: 'stroq-codex-skill-sources/1',
    source: 'local',
    workspaceId: workspace,
    generatedAt: '2026-10-24T01:00:01.000Z',
    runtimeSha256: runtime,
    capture: {
      startedAt: '2026-10-24T01:00:00.000Z',
      completedAt: '2026-10-24T01:00:01.000Z',
      atomicSnapshot: false,
    },
    context: { boundary: 'marker', ancestorCount: 1, markerPolicy: 'default', profile: 'default' },
    settings: { status: 'ready', sha256: 'd'.repeat(64), rules: 1, unmatchedRules: 0 },
    sources: [
      {
        id: sourceId(),
        family: 'agents',
        scope: 'ancestor',
        distance: 1,
        label: '../.agents/skills',
        status: 'complete',
        candidates: 1,
      },
      {
        id: sourceId(2),
        family: 'agents',
        scope: 'user',
        distance: null,
        label: '~/.agents/skills',
        status: 'absent',
        candidates: 0,
      },
      ...['codex-legacy', 'system', 'admin', 'plugins'].map((family, n) => ({
        id: sourceId(n + 3),
        family,
        scope: family === 'codex-legacy' ? 'user' : family,
        distance: null,
        label: family === 'codex-legacy' ? '~/.codex/skills' : family + ' sources',
        status: 'uninspected',
        candidates: 0,
      })),
    ],
    items: [
      {
        id: candidateId(),
        sourceId: sourceId(),
        name: 'Release notes',
        location: { label: 'release/notes', redacted: false },
        entrypointSha256: 'b'.repeat(64),
        bytes: 42,
        declaredState: 'disabled',
        metadata: 'valid',
        scan: {
          status: 'suspect',
          findings: 2,
          matches: [{ ruleId: 'INJ.1', severity: 'high', title: 'Instruction override' }],
          omitted: 1,
        },
        capabilities: [{ kind: 'fs.read', count: 2 }],
      },
    ],
    gaps: [
      { code: 'compatibility-uninspected', sourceId: sourceId(3) },
      { code: 'system-uninspected', sourceId: sourceId(4) },
      { code: 'admin-uninspected', sourceId: sourceId(5) },
      { code: 'plugins-uninspected', sourceId: sourceId(6) },
      { code: 'session-overrides-unverified' },
    ],
    omitted: { sources: 0, items: 0 },
  };
}
