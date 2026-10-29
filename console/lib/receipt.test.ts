import { describe, expect, it } from 'vitest';
import { buildReceipt, RECEIPT_LIMITS } from './receipt';
import type { JournalSummary } from './journal-view';
import { POSTURE_LIMITATIONS, type PostureAudit } from './posture';

const summary = (over: Partial<JournalSummary> = {}): JournalSummary => ({
  schema: 'stroq-journal-summary/1',
  source: 'local',
  generatedAt: '2026-10-27T10:00:00.000Z',
  state: 'ready',
  window: {
    rows: 1203,
    first: '2026-10-27T09:12:00.000Z',
    last: '2026-10-27T12:51:00.000Z',
    truncated: true,
  },
  counts: { allow: 1180, ask: 14, deny: 6, suspect: 3 },
  tools: {},
  classes: [
    { class: 'shell.network', count: 9 },
    { class: 'fs.secrets', count: 4 },
  ],
  notable: [],
  days: [
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
    '2026-10-27',
  ].map((date) => ({ date, read: 'all' as const, allow: 0, ask: 0, deny: 0, suspect: 0 })),
  daysComplete: true,
  unreadable: 0,
  limitations: ['x'],
  ...over,
});

const posture = (over: Partial<PostureAudit> = {}): PostureAudit => ({
  schema: 'stroq-posture/1',
  source: 'local',
  generatedAt: '2026-10-27T10:00:00.000Z',
  sources: [
    { agent: 'claude-code', scope: 'user', file: 'settings', state: 'read' },
    { agent: 'codex', scope: 'user', file: 'config', state: 'missing' },
  ],
  findings: [
    { id: 'claude-hooks-off', agent: 'claude-code', scope: 'project', count: null },
    { id: 'claude-bypass-permissions', agent: 'claude-code', scope: 'user', count: null },
    { id: 'claude-sandbox-off', agent: 'claude-code', scope: 'user', count: null },
  ],
  cannotCheck: [],
  limitations: [...POSTURE_LIMITATIONS],
  ...over,
});

const AT = new Date('2026-10-27T13:00:00.000Z');

describe('receipt', () => {
  it('states counts, the window and its limits, and nothing else', () => {
    const text = buildReceipt(summary(), null, AT) as string;
    expect(text).toContain('# Stroq receipt · 2026-10-27');
    expect(text).toContain(
      'Recorded actions: 1,203 (09:12 UTC to 12:51 UTC, the newest part of the journal)',
    );
    expect(text).toContain('- Allowed: 1,180');
    expect(text).toContain('- Asked you: 14');
    expect(text).toContain('- Denied: 6');
    expect(text).toContain('- Flagged: 3');
    expect(text).toContain('Most common kinds of action');
    expect(text.trimEnd().endsWith(RECEIPT_LIMITS)).toBe(true);
  });

  it('does not say blocked, safe, secure or protected', () => {
    const text = buildReceipt(summary(), posture(), AT) as string;
    expect(text.replace(RECEIPT_LIMITS, '')).not.toMatch(/\b(blocked|safe|secure|protected)\b/i);
  });

  it('adds the settings check counts only when a settings file was read', () => {
    expect(buildReceipt(summary(), posture(), AT)).toContain(
      'Settings check: 1 critical, 1 high, 0 medium, 1 note (1 of 2 files read)',
    );
    expect(
      buildReceipt(
        summary(),
        posture({
          sources: [{ agent: 'codex', scope: 'user', file: 'config', state: 'missing' }],
          findings: [],
        }),
        AT,
      ),
    ).not.toContain('Settings check');
    expect(buildReceipt(summary(), null, AT)).not.toContain('Settings check');
  });

  it('has nothing to report when the journal is missing, refused or empty', () => {
    expect(buildReceipt(summary({ state: 'missing' }), null, AT)).toBeNull();
    expect(buildReceipt(summary({ state: 'refused' }), null, AT)).toBeNull();
    expect(
      buildReceipt(
        summary({ window: { rows: 0, first: null, last: null, truncated: false } }),
        null,
        AT,
      ),
    ).toBeNull();
  });

  it('copes with no window times and no classes', () => {
    const text = buildReceipt(
      summary({ window: { rows: 2, first: null, last: null, truncated: false }, classes: [] }),
      null,
      AT,
    ) as string;
    expect(text).toContain('Recorded actions: 2\n');
    expect(text).not.toContain('Most common kinds of action');
  });

  it('leaves out the notable rows, which carry rule ids and sessions', () => {
    const text = buildReceipt(
      summary({
        notable: [
          {
            seq: 5,
            lineSha: 'a'.repeat(64),
            at: '2026-10-27T12:00:00.000Z',
            phase: 'pre',
            decision: 'deny',
            tool: 'shell',
            classes: ['shell.network'],
            ruleId: 'deny-secret-egress',
            scan: null,
            session: 'session-0123456789abcdef',
          } as never,
        ],
      }),
      null,
      AT,
    ) as string;
    expect(text).not.toContain('deny-secret-egress');
    expect(text).not.toContain('session-');
  });

  it('keeps at most five kinds of action', () => {
    const many = (
      [
        'shell.network',
        'fs.secrets',
        'shell.exec_encoded',
        'config.self',
        'fs.canary',
        'config.git_exec',
      ] as const
    ).map((c, i) => ({ class: c, count: 10 - i }));
    const text = buildReceipt(summary({ classes: many }), null, AT) as string;
    expect(
      text
        .split('\n')
        .filter((l) => /^- .*: \d+$/.test(l) && !/^- (Allowed|Asked you|Denied|Flagged)/.test(l)),
    ).toHaveLength(5);
  });

  it('says how many lines could not be read, and only when some could not', () => {
    expect(buildReceipt(summary({ unreadable: 2 }), null, AT)).toContain(
      '- Lines that could not be read: 2',
    );
    expect(buildReceipt(summary({ unreadable: 0 }), null, AT)).not.toContain('could not be read');
  });
});
