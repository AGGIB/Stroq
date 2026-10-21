import { describe, expect, it } from 'vitest';
import {
  buildCard,
  cardHtml,
  cardMarkdown,
  escapeHtml,
  headline,
  postLine,
} from '../../src/sent/card.js';
import { buildCounts } from '../../src/sent/counts.js';
import type { Finding } from '../../src/sent/findings.js';
import type { Tier } from '../../src/sent/place.js';
import { buildReport, type SentReport } from '../../src/sent/report.js';
import { sampleReport } from '../../src/sent/sample.js';

/**
 * `--counts` and `--card`: what a run found, with nothing the report names. Both are built by
 * taking numbers and choosing labels from tables in the code.
 */

const NOW = new Date('2026-10-19T10:00:00Z');

function finding(tier: Tier, over: Partial<Finding> = {}): Finding {
  return {
    tier,
    name: 'aws_secret_access_key',
    source: '~/.aws/credentials',
    provider: 'AWS',
    rotate: null,
    place: { tier, route: 'command', tool: 'Bash', detail: 'curl', host: 'collect.example' },
    at: '2026-10-06T09:00:00Z',
    session: { agent: 'claude-code', id: 's', path: '/p/s.jsonl', cwd: '/p' },
    times: 1,
    sessions: 1,
    seen: 1,
    ...over,
  };
}

function report(findings: readonly Finding[], over: Partial<SentReport> = {}): SentReport {
  return {
    ...buildReport({
      scope: 'machine',
      now: NOW,
      sessions: {
        total: 412,
        agents: {
          'claude-code': { sessions: 388, oldest: '2026-09-20T08:00:00Z' },
          codex: { sessions: 24, oldest: '2026-08-28T08:00:00Z' },
        },
        first: '2026-08-28T08:00:00Z',
        last: '2026-10-19T09:00:00Z',
      },
      keys: { compared: 23, files: ['~/.aws/credentials'], env: 2, unreadable: 0 },
      findings,
      notChecked: [],
      unreadable: 0,
    }),
    ...over,
  };
}

describe('--counts', () => {
  const counts = buildCounts(
    report([
      finding('third_party', { provider: 'Stripe' }),
      finding('third_party', { provider: 'GitHub' }),
      finding('maybe', { provider: 'Database' }),
      finding('seen'),
      finding('own_service', { provider: 'OpenAI' }),
      finding('blocked', { provider: 'Other' }),
    ]),
    '0.28.0',
  );

  it('holds the numbers of section 5 of the design: sessions, keys, places and services', () => {
    expect(counts).toEqual({
      schema: 'stroq-sent-counts/1',
      checked: '2026-10-19',
      version: '0.28.0',
      agents: {
        'claude-code': { sessions: 388, oldest: '2026-09-20' },
        codex: { sessions: 24, oldest: '2026-08-28' },
        cursor: { sessions: 0, oldest: null },
      },
      keys_compared: 23,
      found: { third_party: 2, maybe: 1, seen: 1, own_service: 1, blocked: 1, model_only: 1 },
      blocked_third_party: 0,
      providers: { Stripe: 1, GitHub: 1, Database: 1, AWS: 1, OpenAI: 1, Other: 1 },
      unreadable_files: 0,
      complete: true,
      not_checked: [],
      limits: [
        'encoded-keys',
        'unseen-sends',
        'ssh-kube-gcloud-keychain',
        'secrets-in-json-yaml-toml',
        'other-agents',
        'deleted-sessions',
      ],
    });
  });

  it('says Cursor was not read, and that the check is not complete', () => {
    const partial = buildCounts(report([], { notChecked: ['cursor'], unreadable: 2 }), '0.28.0');
    expect(partial.agents.cursor).toEqual({ status: 'not-read' });
    expect(partial).toMatchObject({
      complete: false,
      not_checked: ['cursor'],
      unreadable_files: 2,
    });
  });

  it('says saved outputs past the budget were not tied to their calls, and is not complete', () => {
    const partial = buildCounts(
      report([], { notChecked: ['saved-outputs'], savedOutputsSkipped: 4 }),
      '0.28.0',
    );
    expect(partial).toMatchObject({ complete: false, not_checked: ['saved-outputs'] });
  });
});

describe('what --counts and a card never hold', () => {
  const SEEDED = {
    name: '</script><img src=x onerror=alert(1)>_secret_key_name',
    source: '/Users/alice/private-project/.env‮',
    host: 'private.example',
    path: '/Users/alice/.claude/projects/-Users-alice-secret-project/abc.jsonl',
    id: 'sess-9f31-private',
  };
  const hostile = report([
    finding('third_party', {
      name: SEEDED.name,
      source: SEEDED.source,
      provider: '<img onerror=x>',
      place: { tier: 'third_party', route: 'command', host: SEEDED.host, detail: 'curl' },
      session: {
        agent: 'claude-code',
        id: SEEDED.id,
        path: SEEDED.path,
        cwd: '/Users/alice/private-project',
      },
    }),
  ]);
  const counts = buildCounts(hostile, '0.22.0<script>');
  const card = buildCard(counts);
  const forms = {
    counts: JSON.stringify(counts),
    markdown: cardMarkdown(card),
    html: cardHtml(card),
    json: JSON.stringify(card),
    post: postLine(card),
  };

  it.each(Object.entries(forms))('is free of every seeded text in the %s form', (_form, text) => {
    for (const seeded of [
      ...Object.values(SEEDED),
      'alice',
      'private-project',
      '.aws',
      '.env',
      '/Users',
      '‮',
      '<img',
      'onerror',
      '0.22.0<script>',
    ])
      expect(text, `holds "${seeded}"`).not.toContain(seeded);
  });

  it('files a key under a label from the table, never one it was given', () => {
    expect(counts.providers).toEqual({ Other: 1 });
    expect(counts.version).toBe('unknown');
  });

  it('holds no 32-or-more character run of hex or base64 that could be a hash or a value', () => {
    for (const text of Object.values(forms)) expect(text).not.toMatch(/[A-Za-z0-9+/_-]{32,}/);
  });
});

describe('the card', () => {
  it('leads with the keys sent to another company', () => {
    const card = buildCard(
      buildCounts(report([finding('third_party'), finding('seen')]), '0.28.0'),
    );
    expect(headline(card)).toBe(
      '2 of 23 keys from this machine appear in AI agent sessions: 1 sent to another company, 1 seen by the AI.',
    );
    expect(cardMarkdown(card)).toContain('| Sent to another company | 1 |');
    expect(cardMarkdown(card)).toContain('| Agents | Claude Code, Codex |');
    expect(postLine(card)).toBe(
      'Checked 412 AI agent sessions on my machine against 23 keys: 2 appear, 1 sent to another company, 1 seen by the AI. Done locally with `npx @stroq/cli sent`.',
    );
  });

  it('does not call a run with no keys clean', () => {
    const card = buildCard(
      buildCounts(
        report([], { keys: { compared: 0, files: [], env: 0, unreadable: 0 } }),
        '0.28.0',
      ),
    );
    expect(headline(card)).toBe('Nothing to check against: Stroq found no keys on this machine.');
  });

  it('keeps the sample marker in every form', () => {
    const card = buildCard(buildCounts(sampleReport(NOW), '0.28.0'));
    expect(card.synthetic).toBe(true);
    expect(cardMarkdown(card)).toMatch(/made-up key/);
    expect(cardHtml(card)).toMatch(/made-up key/);
    expect(postLine(card)).toContain('sent --try');
  });
});

describe('the HTML card', () => {
  const html = cardHtml(buildCard(buildCounts(report([finding('third_party')]), '0.28.0')));

  it('has no script, no external resource and a policy that allows neither', () => {
    expect(html).not.toMatch(/<script|<link|<img|<iframe|<object|<embed|<form|<base/i);
    expect(html).not.toMatch(/\b(?:src|href|action)\s*=/i);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'none'");
    expect(html).toContain('no-referrer');
  });

  it('is a document of its own, in English, that works at a phone width', () => {
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('prefers-color-scheme:dark');
  });

  it('escapes what it is given', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&#60;&#62;&#38;&#34;&#39;');
  });
});
