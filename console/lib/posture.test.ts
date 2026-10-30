import { describe, expect, it } from 'vitest';
import {
  CANNOT_CHECK,
  POSTURE_CATALOG,
  POSTURE_LIMITATIONS,
  postureCounts,
  parseSeenKeys,
  postureChanges,
  postureKey,
  postureOrder,
  postureStripText,
  uncheckedSources,
  validatePostureAudit,
  type PostureAudit,
  type PostureFinding,
  type SourceState,
} from './posture';

const finding = (over: Partial<PostureFinding> = {}): PostureFinding => ({
  id: 'claude-hooks-off',
  agent: 'claude-code',
  scope: 'user',
  count: null,
  ...over,
});
const audit = (over: Partial<PostureAudit> = {}): PostureAudit => ({
  schema: 'stroq-posture/1',
  source: 'local',
  generatedAt: '2026-10-27T10:00:00.000Z',
  sources: [
    { agent: 'claude-code', scope: 'user', file: 'settings', state: 'read' },
    { agent: 'codex', scope: 'user', file: 'config', state: 'missing' },
  ],
  findings: [finding()],
  cannotCheck: ['cursor-ide-run-mode'],
  limitations: [...POSTURE_LIMITATIONS],
  ...over,
});

describe('posture catalog', () => {
  it('has words for every finding, in plain language, and never says blocked or safe', () => {
    for (const [id, entry] of Object.entries(POSTURE_CATALOG)) {
      expect(entry.title.length, id).toBeGreaterThan(5);
      expect(entry.why.length, id).toBeGreaterThan(10);
      expect(entry.fix.length, id).toBeGreaterThan(5);
      expect(`${entry.title} ${entry.why} ${entry.fix}`, id).not.toMatch(
        /\b(blocked|safe|protected|protection|secure|guarded)\b/i,
      );
      expect(['critical', 'high', 'medium', 'info']).toContain(entry.severity);
    }
  });

  it('names a real setting for every finding, so the person can find it', () => {
    for (const [id, entry] of Object.entries(POSTURE_CATALOG))
      expect(entry.setting, id).toMatch(/^[A-Za-z][A-Za-z0-9_.<>\[\]-]*$/);
  });

  it('has words for every thing that cannot be checked', () => {
    for (const [id, entry] of Object.entries(CANNOT_CHECK)) {
      expect(entry.title.length, id).toBeGreaterThan(5);
      expect(entry.why.length, id).toBeGreaterThan(10);
    }
  });
});

describe('posture audit', () => {
  it('accepts a normal result', () => {
    expect(validatePostureAudit(audit())).toBe(true);
  });

  it('refuses anything the catalog does not know, and any free text', () => {
    expect(validatePostureAudit(audit({ findings: [finding({ id: 'made-up' as never })] }))).toBe(
      false,
    );
    expect(validatePostureAudit(audit({ cannotCheck: ['made-up'] as never }))).toBe(false);
    expect(validatePostureAudit({ ...audit(), note: 'free text' })).toBe(false);
    expect(
      validatePostureAudit(
        audit({ findings: [{ ...finding(), detail: '/Users/me/.claude' } as never] }),
      ),
    ).toBe(false);
  });

  it('refuses a finding for an agent other than the one the catalog says', () => {
    expect(validatePostureAudit(audit({ findings: [finding({ agent: 'codex' })] }))).toBe(false);
  });

  it('accepts a count only where it means something', () => {
    expect(
      validatePostureAudit(
        audit({ findings: [finding({ id: 'claude-allow-any-shell', count: 2 })] }),
      ),
    ).toBe(true);
    expect(
      validatePostureAudit(audit({ findings: [finding({ id: 'claude-hooks-off', count: 2 })] })),
    ).toBe(false);
    expect(
      validatePostureAudit(
        audit({ findings: [finding({ id: 'claude-allow-any-shell', count: null })] }),
      ),
    ).toBe(false);
    expect(
      validatePostureAudit(
        audit({ findings: [finding({ id: 'claude-allow-any-shell', count: 0 })] }),
      ),
    ).toBe(false);
  });

  it('keeps one finding per setting and scope', () => {
    expect(validatePostureAudit(audit({ findings: [finding(), finding()] }))).toBe(false);
    expect(
      validatePostureAudit(audit({ findings: [finding(), finding({ scope: 'project' })] })),
    ).toBe(true);
  });

  it('refuses a source state or scope it does not know', () => {
    expect(
      validatePostureAudit(
        audit({
          sources: [
            { agent: 'claude-code', scope: 'user', file: 'settings', state: 'fine' as never },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      validatePostureAudit(
        audit({
          sources: [
            { agent: 'claude-code', scope: 'managed' as never, file: 'settings', state: 'read' },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('requires limitations and a timestamp', () => {
    expect(validatePostureAudit(audit({ limitations: [] }))).toBe(false);
    expect(validatePostureAudit(audit({ generatedAt: 'now' }))).toBe(false);
  });
});

describe('posture ordering and counts', () => {
  it('puts the worst first, then the repository-shipped ones, then by agent', () => {
    const ordered = postureOrder([
      finding({ id: 'claude-sandbox-off' }),
      finding({ id: 'claude-bypass-permissions' }),
      finding({ id: 'claude-hooks-off', scope: 'user' }),
      finding({ id: 'claude-hooks-off', scope: 'project' }),
    ]);
    expect(ordered.map((f) => [f.id, f.scope])).toEqual([
      ['claude-hooks-off', 'project'],
      ['claude-hooks-off', 'user'],
      ['claude-bypass-permissions', 'user'],
      ['claude-sandbox-off', 'user'],
    ]);
  });

  it('counts by severity', () => {
    expect(
      postureCounts([
        finding(),
        finding({ id: 'claude-bypass-permissions' }),
        finding({ id: 'claude-sandbox-off' }),
      ]),
    ).toEqual({
      critical: 1,
      high: 1,
      medium: 0,
      info: 1,
    });
  });
});

describe('the Protection page line', () => {
  it('says nothing when no settings file could be read', () => {
    expect(
      postureStripText(
        audit({
          sources: [{ agent: 'claude-code', scope: 'user', file: 'settings', state: 'missing' }],
          findings: [],
        }),
      ),
    ).toBeNull();
  });

  it('says nothing is critical or high without claiming the agents are fine', () => {
    const line = postureStripText(audit({ findings: [finding({ id: 'claude-sandbox-off' })] }));
    expect(line).toEqual({
      serious: false,
      text: 'No critical or high settings found in your agents’ files',
    });
    expect(line?.text).not.toMatch(/\b(safe|secure|protected|blocked)\b/i);
  });

  it('counts critical and high settings with the right plural', () => {
    expect(postureStripText(audit({ findings: [finding()] }))?.text).toBe(
      '1 critical setting found in your agents’ files',
    );
    expect(
      postureStripText(
        audit({
          findings: [
            finding(),
            finding({ id: 'claude-bypass-permissions' }),
            finding({ id: 'claude-repo-helper', scope: 'project' }),
          ],
        }),
      )?.text,
    ).toBe('1 critical and 2 high settings found in your agents’ files');
    expect(
      postureStripText(audit({ findings: [finding({ id: 'claude-bypass-permissions' })] }))?.text,
    ).toBe('1 high setting found in your agents’ files');
  });
});

describe('changes since the last check', () => {
  it('has nothing to compare on the first check', () => {
    expect(postureChanges(null, [finding()])).toBeNull();
  });

  it('names what is new and counts what is gone', () => {
    const changes = postureChanges(
      ['claude-hooks-off/user', 'claude-sandbox-off/user'],
      [finding({ id: 'claude-sandbox-off' }), finding({ id: 'claude-bypass-permissions' })],
    );
    expect([...(changes?.added ?? [])]).toEqual(['claude-bypass-permissions/user']);
    expect(changes?.gone).toBe(1);
  });

  it('reports no change when the same findings come back', () => {
    const changes = postureChanges([postureKey(finding())], [finding()]);
    expect(changes?.added.size).toBe(0);
    expect(changes?.gone).toBe(0);
  });

  it('keeps only keys this catalog could have produced from what was stored', () => {
    expect(
      parseSeenKeys([
        'claude-hooks-off/user',
        'made-up/user',
        'claude-hooks-off/elsewhere',
        4,
        null,
      ]),
    ).toEqual(['claude-hooks-off/user']);
    expect(parseSeenKeys('claude-hooks-off/user')).toBeNull();
    expect(parseSeenKeys({ length: 1 })).toBeNull();
    expect(parseSeenKeys(Array.from({ length: 65 }, () => 'claude-hooks-off/user'))).toBeNull();
  });
});

describe('files that could not be checked', () => {
  const state = (value: SourceState) =>
    audit({
      sources: [
        { agent: 'claude-code', scope: 'user', file: 'settings', state: 'read' },
        { agent: 'claude-code', scope: 'project', file: 'settings', state: value },
      ],
      findings: [],
    });

  it('lists a file that exists and could not be used, and not one that is missing or read', () => {
    for (const hidden of ['oversize', 'invalid', 'unsafe', 'unreadable'] as const)
      expect(uncheckedSources(state(hidden)).map((s) => s.state)).toEqual([hidden]);
    expect(uncheckedSources(state('missing'))).toEqual([]);
    expect(uncheckedSources(state('read'))).toEqual([]);
  });

  it('never lets a clean Protection line stand when a file was hidden', () => {
    expect(postureStripText(state('oversize'))).toEqual({
      serious: true,
      text: '1 settings file could not be checked',
    });
    expect(postureStripText(state('missing'))?.serious).toBe(false);
  });

  it('adds what could not be checked to a count of what was found', () => {
    expect(postureStripText({ ...state('unsafe'), findings: [finding()] })?.text).toBe(
      '1 critical setting found in your agents’ files; 1 settings file could not be checked',
    );
  });

  it('has a line when nothing could be read but a file exists', () => {
    const only = audit({
      sources: [{ agent: 'codex', scope: 'project', file: 'config', state: 'invalid' }],
      findings: [],
    });
    expect(postureStripText(only)?.text).toBe('1 settings file could not be checked');
  });
});
