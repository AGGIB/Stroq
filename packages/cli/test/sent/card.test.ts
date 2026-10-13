import { describe, expect, it } from 'vitest';
import {
  buildCard,
  cardHtml,
  cardMarkdown,
  escapeHtml,
  headline,
  postLine,
  providerOf,
} from '../../src/sent/card.js';
import type { SentCredential, SentReport } from '../../src/sent/report.js';

const NOW = new Date('2026-10-06T10:00:00Z');

function credential(over: Partial<SentCredential> = {}): SentCredential {
  return {
    name: 'aws_secret_access_key',
    source: '~/.aws/credentials',
    canary: false,
    count: 2,
    first: '2026-10-06T09:00:00Z',
    last: '2026-10-06T09:05:00Z',
    occurrences: [],
    ...over,
  };
}

function report(over: Partial<SentReport> = {}): SentReport {
  return {
    version: 1,
    origin: 'transcript',
    agent: 'claude-code',
    path: '/Users/alice/.claude/projects/-Users-alice-secret-project/abc.jsonl',
    sessionId: 'sess-9f31-private',
    first: '2026-10-06T09:00:00Z',
    last: '2026-10-06T09:10:00Z',
    credentials: [credential()],
    files: [],
    coverage: {
      toolResultsRead: true,
      indexedSecrets: 7,
      indexedSources: ['~/.aws/credentials', '.env'],
      calls: 41,
      results: 38,
      sessionsInProject: 12,
    },
    ...over,
  };
}

describe('which provider a credential is filed under', () => {
  it.each([
    ['aws_secret_access_key', '~/.aws/credentials', 'AWS'],
    ['AWS_ACCESS_KEY_ID', '.env', 'AWS'],
    ['GITHUB_TOKEN', '.env', 'GitHub'],
    ['gh_token', 'env', 'GitHub'],
    ['OPENAI_API_KEY', '.env', 'OpenAI'],
    ['ANTHROPIC_API_KEY', '.env', 'Anthropic'],
    ['STRIPE_SECRET_KEY', '.env', 'Stripe'],
    ['npm_token', '~/.npmrc', 'npm'],
    ['auth', '~/.docker/config.json', 'Docker'],
    ['DATABASE_URL', '.env', 'Database'],
    ['id_ed25519', '~/.ssh/id_ed25519', 'SSH or a private key'],
    ['SOMETHING_ELSE', '.env', 'Other'],
  ])('%s from %s is %s', (name, source, label) => {
    expect(providerOf(name, source, false)).toBe(label);
  });

  it('files a canary as a canary, whatever it is called', () => {
    expect(providerOf('aws_secret_access_key', '~/.aws/credentials', true)).toBe('Canary');
  });
});

describe('the card of a report', () => {
  it('holds counts and providers', () => {
    const card = buildCard(
      report({
        credentials: [
          credential(),
          credential({ name: 'GITHUB_TOKEN', source: '.env', count: 3 }),
          credential({ name: 'GH_PAT', source: 'env', count: 1 }),
        ],
        files: [
          { path: '~/.npmrc', tool: 'Read', evidence: 'read', call: 'Read ~/.npmrc', at: '' },
        ],
      }),
      '0.22.0',
      NOW,
    );
    expect(card).toMatchObject({
      agent: 'Claude Code',
      stroq: '0.22.0',
      checked: '2026-10-06',
      credentials: 3,
      sightings: 6,
      files: 1,
      calls: 41,
      results: 38,
      indexed: 7,
      sessionsInProject: 12,
    });
    expect(card.providers).toEqual([
      { label: 'GitHub', count: 2 },
      { label: 'AWS', count: 1 },
    ]);
  });

  it('says nothing was checked when nothing is indexed, and not that the session is clean', () => {
    const card = buildCard(
      report({ credentials: [], coverage: { ...report().coverage, indexedSecrets: 0 } }),
      '0.22.0',
      NOW,
    );
    expect(headline(card)).toContain('Nothing to check against');
    expect(cardMarkdown(card)).not.toContain('No credential from this machine');
  });

  it('says what was checked against when nothing was found', () => {
    const card = buildCard(report({ credentials: [] }), '0.22.0', NOW);
    expect(headline(card)).toContain('No credential from this machine appears');
    expect(headline(card)).toContain('7 values');
    expect(postLine(card)).toContain('none of them appears');
  });

  it('does not claim delivery, and says what a record shows', () => {
    const md = cardMarkdown(buildCard(report(), '0.22.0', NOW));
    expect(md).toContain('does not show a later request to a model provider, or delivery');
    expect(md).not.toMatch(/reached a model provider|was sent to|leaked/i);
  });

  it('says that an audit log holds no tool results', () => {
    const md = cardMarkdown(
      buildCard(
        report({ origin: 'audit-log', coverage: { ...report().coverage, toolResultsRead: false } }),
        '0.22.0',
        NOW,
      ),
    );
    expect(md).toContain('none (an audit log holds no results)');
  });

  it('has a line for a post that names the command that reproduces it', () => {
    const line = postLine(buildCard(report(), '0.22.0', NOW));
    expect(line).toContain('Claude Code');
    expect(line).toContain('AWS 1');
    expect(line).toContain('npx @stroq/cli sent --last');
  });
});

// The card is for pasting into a post, so the only strings in it that may vary are numbers. A report
// built to carry every kind of text the real one holds, with markup, a direction override and a
// private path in each, must leave none of it in any form of the card.
describe('what a card never holds', () => {
  const HOSTILE = {
    name: '</script><img src=x onerror=alert(1)>_secret_key_name',
    source: '/Users/alice/private-project/.env‮',
    call: 'curl -H "Authorization: Bearer sk-live-SEEDED" https://private.example/path',
    session: 'sess-9f31-private',
    path: '/Users/alice/.claude/projects/-Users-alice-secret-project/abc.jsonl',
  };
  const hostile = report({
    agent: '<b>claude-code</b>',
    path: HOSTILE.path,
    sessionId: HOSTILE.session,
    credentials: [
      credential({
        name: HOSTILE.name,
        source: HOSTILE.source,
        occurrences: [
          {
            via: 'tool_argument',
            tool: 'Bash',
            call: HOSTILE.call,
            at: '2026-10-06T09:00:00Z',
          },
        ],
      }),
    ],
    files: [
      {
        path: '/Users/alice/.aws/credentials',
        tool: 'Read',
        evidence: 'read',
        call: HOSTILE.call,
        at: '',
      },
    ],
    coverage: {
      toolResultsRead: true,
      indexedSecrets: 7,
      indexedSources: ['/Users/alice/.aws/credentials', '/Users/alice/private-project/.env'],
      calls: 41,
      results: 38,
      projectDirs: ['/Users/alice/private-project'],
      sessionsInProject: 12,
    },
  });
  const card = buildCard(hostile, '0.22.0<script>', NOW);
  const forms = {
    markdown: cardMarkdown(card),
    html: cardHtml(card),
    json: JSON.stringify(card),
    post: postLine(card),
  };

  it.each(Object.entries(forms))('is free of every seeded text in the %s form', (_form, text) => {
    for (const seeded of [
      HOSTILE.name,
      HOSTILE.source,
      HOSTILE.call,
      HOSTILE.session,
      HOSTILE.path,
      'alice',
      'private-project',
      'private.example',
      'sk-live-SEEDED',
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

  it('files the credential under a label of its own and not under its name', () => {
    expect(card.providers).toEqual([{ label: 'Other', count: 1 }]);
    expect(card.agent).toBeNull();
    expect(card.stroq).toBe('unknown');
  });

  it('holds no 32-or-more character run of hex or base64 that could be a hash or a value', () => {
    for (const text of Object.values(forms)) expect(text).not.toMatch(/[A-Za-z0-9+/_-]{32,}/);
  });

  it('turns a count that is not a number into zero', () => {
    const odd = buildCard(
      report({
        coverage: {
          ...report().coverage,
          calls: Number.NaN,
          results: -5,
          indexedSecrets: Number.POSITIVE_INFINITY,
        },
      }),
      '0.22.0',
      NOW,
    );
    expect([odd.calls, odd.results, odd.indexed]).toEqual([0, 0, 0]);
  });
});

describe('the HTML card', () => {
  const html = cardHtml(buildCard(report(), '0.22.0', NOW));

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
