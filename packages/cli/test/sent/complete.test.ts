import { describe, expect, it } from 'vitest';
import { buildCard, cardHtml, cardMarkdown, headline, postLine } from '../../src/sent/card.js';
import { buildCounts } from '../../src/sent/counts.js';
import type { Finding } from '../../src/sent/findings.js';
import { formatSent } from '../../src/sent/format.js';
import { buildReport, keysLeftOut, type SentReport } from '../../src/sent/report.js';
import { sampleReport } from '../../src/sent/sample.js';

/**
 * A check that read nothing, or not everything, is never summed up as all clear: not by the card,
 * not by `--counts`, not by `--json`. Every value is made up.
 */

const NOW = new Date('2026-10-20T00:00:00Z');

function report(over: Partial<Parameters<typeof buildReport>[0]> = {}): SentReport {
  return buildReport({
    scope: 'machine',
    now: NOW,
    sessions: {
      total: 3,
      agents: { 'claude-code': { sessions: 3, oldest: '2026-10-01T00:00:00Z' } },
      first: '2026-10-01T00:00:00Z',
      last: '2026-10-19T00:00:00Z',
    },
    keys: { compared: 3, files: [], env: 0, unreadable: 0 },
    findings: [],
    notChecked: [],
    unreadable: 0,
    ...over,
  });
}

const none = report({
  sessions: { total: 0, agents: {}, first: null, last: null },
});
const unread = report({ unreadable: 1 });
const noFolder = report({
  sessions: {
    total: 3,
    agents: { 'claude-code': { sessions: 3, oldest: null } },
    first: null,
    last: null,
    noFolder: 2,
  },
});

describe('the card of a check that read nothing, or not everything', () => {
  it('no session read: says so, and never that no value appears', () => {
    const card = buildCard(buildCounts(none, '0.28.0'));
    expect(headline(card)).toBe('No sessions were read.');
    for (const text of [cardMarkdown(card), cardHtml(card), postLine(card)])
      expect(text).not.toMatch(/None of|none of their values/);
  });

  it.each([
    ['a session file not read', unread],
    ['sessions whose folder is not recorded', noFolder],
  ])('%s: incomplete, see the full report', (_how, r) => {
    const card = buildCard(buildCounts(r, '0.28.0'));
    expect(headline(card)).toBe('Incomplete: see the full report.');
    expect(cardMarkdown(card)).not.toContain('None of');
  });

  it('says what was read and what was not, on a coverage line', () => {
    expect(cardMarkdown(buildCard(buildCounts(unread, '0.28.0')))).toContain(
      'Coverage: 3 sessions read, 1 file not read, and more not checked: see the full report.',
    );
    expect(cardMarkdown(buildCard(buildCounts(report(), '0.28.0')))).toContain(
      'Coverage: 3 sessions read, 0 files not read.',
    );
  });

  it('a complete check that found no value says that, and only that', () => {
    expect(headline(buildCard(buildCounts(report(), '0.28.0')))).toBe(
      "None of 3 keys' values from this machine appear in these AI agent sessions.",
    );
  });

  it('the HTML card has no number without a label', () => {
    const sent: Finding = {
      tier: 'third_party',
      name: 'K',
      source: 'env',
      provider: 'Other',
      rotate: null,
      place: { tier: 'third_party', route: 'command', host: 'a.example' },
      at: '2026-10-01T00:00:00Z',
      session: { agent: 'claude-code', id: 's', path: '/p', cwd: null },
      times: 1,
      sessions: 1,
      seen: 1,
    };
    expect(cardHtml(buildCard(buildCounts(report(), '0.28.0')))).not.toContain('class="big');
    const html = cardHtml(buildCard(buildCounts(report({ findings: [sent] }), '0.28.0')));
    expect(html).toMatch(
      /class="big hot"[^>]*>1<\/div>\s*<div class="big-label">sent to another company<\/div>/,
    );
  });
});

describe('--counts and --json', () => {
  it.each([
    ['no session read', none],
    ['a session file not read', unread],
    ['sessions whose folder is not recorded', noFolder],
    [
      'a canary planted and found nowhere',
      report({ keys: { compared: 3, files: [], env: 0, unreadable: 0, canariesNotFound: 1 } }),
    ],
    [
      'lines named like a key not compared',
      report({ keys: { compared: 3, files: [], env: 0, unreadable: 0, rejectedLines: 2 } }),
    ],
  ])('%s: not complete', (_how, r) => {
    expect(buildCounts(r, '0.28.0').complete).toBe(false);
    expect(r.complete).toBe(false);
  });

  it('a check that read everything is complete, and still lists what no check sees', () => {
    const r = report();
    expect(buildCounts(r, '0.28.0').complete).toBe(true);
    expect(r.complete).toBe(true);
    const limits = [
      'encoded-keys',
      'unseen-sends',
      'ssh-kube-gcloud-keychain',
      'secrets-in-json-yaml-toml',
      'other-agents',
      'deleted-sessions',
    ];
    expect(buildCounts(r, '0.28.0').limits).toEqual(limits);
    expect(r.limits).toEqual(limits);
  });
});

describe('the built-in sample', () => {
  it('never says "Nothing was sent" under a key it found sent', () => {
    const text = formatSent(sampleReport(NOW), '/home/u');
    expect(text).not.toContain('Nothing was sent');
    expect(text.trimEnd().split('\n').at(-3)).toBe(
      'Stroq read a made-up session here: this check sent nothing and wrote nothing. No key values are printed.',
    );
  });

  it('a real run says what the check did, not what the agent did', () => {
    const text = formatSent(report(), '/home/u');
    expect(text).toContain(
      'This check only read files: it sent nothing and wrote nothing. No key values are printed.',
    );
    expect(text).not.toContain('Nothing was sent');
  });
});

describe('the first lines when something was not checked', () => {
  const NOT_EVERY = 'Not every key was compared: see Not checked.';

  it.each([
    [
      'a line named like a key not compared',
      { keys: { compared: 3, files: [], env: 0, unreadable: 0, rejectedLines: 1 } },
    ],
    [
      'an env file in a subfolder not read',
      { keys: { compared: 3, files: [], env: 0, unreadable: 0, subfolderEnvFiles: 1 } },
    ],
    ['a reader that could not run', { notChecked: ['cursor' as const] }],
  ])('%s: the count, then that not every key was compared', (_how, over) => {
    const lines = formatSent(report(over), '/home/u').split('\n');
    expect(lines[2]).toBe("None of your 3 keys' values appear in these session logs.");
    expect(lines[3]).toBe(NOT_EVERY);
  });

  it('a check with nothing left unchecked says no such line', () => {
    expect(formatSent(report(), '/home/u')).not.toContain(NOT_EVERY);
  });

  it('a key file read in part counts as keys left out', () => {
    expect(keysLeftOut({ compared: 3, files: [], env: 0, unreadable: 0, rejectedLines: 2 })).toBe(
      true,
    );
    expect(
      keysLeftOut({ compared: 3, files: [], env: 0, unreadable: 0, subfolderEnvFiles: 1 }),
    ).toBe(true);
  });
});
