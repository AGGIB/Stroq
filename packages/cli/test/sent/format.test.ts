import { describe, expect, it } from 'vitest';
import type { Finding } from '../../src/sent/findings.js';
import { formatSent } from '../../src/sent/format.js';
import type { Place, Tier } from '../../src/sent/place.js';
import { buildReport, type SentReport } from '../../src/sent/report.js';
import { sampleReport, SAMPLE_KEY } from '../../src/sent/sample.js';

const HOME = '/home/u';
const AT = '2026-10-11T14:02:00.000Z';

function finding(tier: Tier, place: Partial<Place> = {}, over: Partial<Finding> = {}): Finding {
  return {
    tier,
    name: 'STRIPE_SECRET_KEY',
    source: '/home/u/shop/.env',
    provider: 'Stripe',
    rotate: 'https://dashboard.stripe.com/apikeys',
    place: {
      tier,
      route: 'command',
      tool: 'Bash',
      detail: 'curl',
      host: 'collect.example',
      ...place,
    },
    at: AT,
    session: {
      agent: 'claude-code',
      id: 's1',
      path: '/home/u/.claude/projects/x/s1.jsonl',
      cwd: '/home/u/shop',
    },
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
      now: new Date('2026-10-19T00:00:00Z'),
      sessions: {
        total: 412,
        agents: {
          'claude-code': { sessions: 388, oldest: '2026-09-20T08:00:00Z' },
          codex: { sessions: 24, oldest: '2026-08-28T08:00:00Z' },
        },
        first: '2026-08-28T08:00:00Z',
        last: '2026-10-19T09:00:00Z',
      },
      keys: {
        compared: 23,
        files: ['~/.aws/credentials', '~/.npmrc', '/a/.env', '/b/.env', '/c/.env'],
        env: 4,
        unreadable: 0,
      },
      findings,
      notChecked: [],
      unreadable: 0,
    }),
    ...over,
  };
}

const ALL: readonly Finding[] = [
  finding('third_party'),
  finding(
    'maybe',
    {
      route: 'write-push',
      detail: 'src/db.ts',
      then: { route: 'git-push', host: 'github.com', at: AT },
    },
    { name: 'DATABASE_PASSWORD', provider: 'Database', rotate: null },
  ),
  finding(
    'seen',
    {},
    {
      name: 'aws_secret_access_key',
      source: '~/.aws/credentials',
      place: { tier: 'seen', route: 'result', tool: 'Read', detail: '~/.aws/credentials' },
    },
  ),
  finding(
    'own_service',
    { host: 'api.openai.com' },
    { name: 'OPENAI_API_KEY', provider: 'OpenAI' },
  ),
  finding(
    'blocked',
    { blocked: 'stroq', host: 'paste.example' },
    { name: 'NPM_TOKEN', source: 'env' },
  ),
];

describe('formatSent', () => {
  const text = formatSent(report(ALL), HOME);
  const lines = text.split('\n');

  it('opens with the question, then the verdict', () => {
    expect(lines[0]).toBe('stroq sent: did your AI agent pass your keys on?');
    expect(lines[2]).toBe(
      '5 of your 23 keys appear in your agent sessions: 1 sent to another company, 1 maybe sent, 1 seen by the AI, 1 used with its own service, 1 blocked before it ran.',
    );
  });

  it('says what was read and what it was compared with', () => {
    expect(text).toContain(
      'Checked 412 sessions (Claude Code 388, Codex 24), 2026-08-28 to 2026-10-19.',
    );
    expect(text).toContain(
      'Compared with 23 keys: ~/.aws/credentials, ~/.npmrc, 3 .env files, your shell environment.',
    );
  });

  it('lists the places in order, most external first, numbered across them', () => {
    const headings = [
      'SENT TO ANOTHER COMPANY: rotate these today (1)',
      'MAYBE SENT: check these (1)',
      "SEEN BY THE AI: your agent's model saw these keys (1)",
      'USED WITH ITS OWN SERVICE: check you expected this (1)',
      'BLOCKED BEFORE IT RAN: the AI still saw these keys (1)',
    ];
    const at = headings.map((h) => lines.indexOf(h));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain(' 5. NPM_TOKEN  from your shell environment');
  });

  it('says where each key went, in words', () => {
    expect(text).toContain('    went to  collect.example, in a curl command');
    expect(text).toContain(
      'src/db.ts, written by the AI, then a git push to github.com at 2026-10-11 14:02 UTC',
    );
    expect(text).toContain('    seen in  the output of a Read of ~/.aws/credentials');
    expect(text).toContain('    stopped  paste.example, in a curl command (Stroq blocked it)');
    expect(text).toContain('    when     2026-10-11 14:02 UTC · Claude Code · ~/shop');
  });

  it('ends every finding with what to do', () => {
    const numbered = lines.filter((l) => /^ \d+\. /.test(l)).length;
    expect(lines.filter((l) => l.startsWith('    do       ')).length).toBe(numbered);
    expect(text).toContain(
      'do       revoke it at https://dashboard.stripe.com/apikeys, then update /home/u/shop/.env',
    );
    expect(text).toContain(
      'do       check src/db.ts was not in what you pushed; if it was, rotate it',
    );
    expect(text).toContain(
      "do       the call did not run, and your agent's model saw the key in it; rotate it if that matters: https://dashboard.stripe.com/apikeys",
    );
  });

  it('ends with what was not checked, and that it only read files', () => {
    expect(text).toContain(
      'Not checked: a key split, encoded or rebuilt before it was sent (base64, reversed, in pieces), which a search for its value or its file cannot see; keys in ~/.ssh, kube and gcloud config, and the keychain;',
    );
    expect(text).toContain('cleanupPeriodDays (30 days by default)');
    expect(lines.at(-2)).toBe(
      'This check only read files: it sent nothing and wrote nothing. No key values are printed.',
    );
  });

  it('says once that the AI provider saw a key the AI put in a call', () => {
    expect(text.match(/your AI provider saw it too/g)).toHaveLength(1);
  });

  it('uses none of the words a newcomer would not know, and no long dashes', () => {
    for (const word of [
      'evidence',
      'indexed',
      'occurrence',
      'egress',
      'coverage',
      'provenance',
      'taint',
    ])
      expect(text.toLowerCase()).not.toContain(word);
    expect(text).not.toContain('—');
  });

  it('writes a file path in a finding with ~ for the home folder', () => {
    const write = finding(
      'maybe',
      {
        route: 'write-push',
        detail: '/home/u/work/api/src/db.ts',
        then: { route: 'git-push', host: 'github.com', at: AT },
      },
      { rotate: null },
    );
    const out = formatSent(report([write]), HOME);
    expect(out).toContain('went to  ~/work/api/src/db.ts, written by the AI');
    expect(out).toContain('do       check ~/work/api/src/db.ts was not in what you pushed');
  });

  it('names Cursor when it could not be read', () => {
    expect(formatSent(report([], { notChecked: ['cursor'] }), HOME)).toContain(
      'Not checked: Cursor sessions (they need node:sqlite, in Node 22.23 or newer);',
    );
  });

  it('says how many saved outputs were past the budget, and what that leaves out', () => {
    const out = formatSent(
      report([], { notChecked: ['saved-outputs'], savedOutputsSkipped: 3 }),
      HOME,
    );
    expect(out).toContain(
      'which call printed a key found in 3 saved large outputs read past the first 256 MB of them;',
    );
  });

  it('says a canary check cut short by a flood, as possible tampering, and calls nothing clean', () => {
    const keys = { compared: 23, files: [], env: 0, unreadable: 0, canaryCheckCut: 2 };
    const out = formatSent(report([], { keys }), HOME);
    expect(out).toContain(
      'the rest of 2 session files: canary check cut short by too many canary-shaped values (possible tampering)',
    );
    expect(out.split('\n')[2]).not.toContain('✓');
  });

  it('does not call a run with no keys clean', () => {
    const none = report([], { keys: { compared: 0, files: [], env: 0, unreadable: 0 } });
    expect(formatSent(none, HOME).split('\n')[2]).toBe(
      'No keys found on this machine, so there was nothing to look for.',
    );
    expect(formatSent(report([]), HOME).split('\n')[2]).toBe(
      "None of your 23 keys' values appear in these session logs.",
    );
  });

  it('writes control characters from a session out as visible escapes', () => {
    const odd = finding('third_party', { host: 'evil.example\u001b[2Kfake' });
    expect(formatSent(report([odd]), HOME)).not.toContain('\u001b');
  });

  it('writes control characters in a key name and its source out as visible escapes', () => {
    const odd = finding('seen', {}, { name: 'A\u001b[2JB', source: '/x/.env\u001b[31m' });
    expect(formatSent(report([odd]), HOME)).not.toContain('\u001b');
  });

  it('says a key was beside a request it did not reach, without naming the wrong program', () => {
    const out = formatSent(
      report([finding('maybe', { route: 'command-near', detail: 'echo' })]),
      HOME,
    );
    expect(out).toContain(
      'went to  collect.example? It was in a command that also made a request there',
    );
  });

  it('names a host Stroq could not read, for a request to another company', () => {
    const { host: _host, ...unread } = finding('third_party').place;
    const out = formatSent(report([{ ...finding('third_party'), place: unread }]), HOME);
    expect(out).toContain('went to  a host Stroq could not read, in a curl command');
  });

  it('says a program ran with the key, and that Stroq could not tell where it went', () => {
    const out = formatSent(
      report([finding('maybe', { route: 'command-ran', detail: 'node' })]),
      HOME,
    );
    expect(out).toContain(
      'went to  a node command: a program ran with this key; Stroq could not tell where it went',
    );
  });

  it('says a key was posted with a command, and to delete the post', () => {
    const out = formatSent(
      report([
        finding(
          'third_party',
          { route: 'post', detail: 'gh', host: 'api.github.com' },
          {
            name: 'GITHUB_TOKEN',
            provider: 'GitHub',
            rotate: 'https://github.com/settings/tokens',
            source: 'env',
          },
        ),
      ]),
      HOME,
    );
    expect(out).toContain('went to  api.github.com, posted by a gh command');
    expect(out).toContain(
      'do       revoke it at https://github.com/settings/tokens, then update your shell environment; delete what the command posted',
    );
  });

  it('names the service a key was stored at as a secret, and says when that is fine', () => {
    const out = formatSent(
      report([
        finding('maybe', {
          route: 'secret-store',
          detail: 'vercel',
          host: 'api.vercel.com',
          service: 'Vercel',
        }),
      ]),
      HOME,
    );
    expect(out).toContain(
      'went to  Vercel (api.vercel.com), stored as a secret by a vercel command',
    );
    expect(out).toContain(
      'do       If you meant to store this key in Vercel, nothing to do. If not, rotate it.',
    );
  });

  it('says a command could not be read all through, and may have sent the key on', () => {
    const out = formatSent(
      report([finding('maybe', { route: 'command-unread', detail: 'echo' })]),
      HOME,
    );
    expect(out).toContain(
      'went to  an echo command Stroq cannot read all of, so it may have sent it on',
    );
    expect(out).toContain('do       check what that command did with it');
  });

  it('prints the first findings of a long list and says how many more there are', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      finding('seen', { route: 'prompt' }, { name: `KEY_${i}` }),
    );
    const out = formatSent(report(many), HOME);
    expect(out).toContain(' 25. KEY_24');
    expect(out).not.toContain('KEY_25 ');
    expect(out).toContain('and 5 more. `stroq sent --json` lists them all.');
  });
});

describe('the built-in sample', () => {
  const text = formatSent(sampleReport(new Date('2026-10-19T00:00:00Z')), HOME);

  it('says it is a sample, finds the made-up key sent away, and never prints it', () => {
    expect(text).toContain('This is a built-in sample. The key and the session are made up.');
    expect(text).toContain(
      '1 of your 1 key appears in your agent sessions: 1 sent to another company.',
    );
    expect(text).toContain('collector.example, in a curl command');
    expect(text).not.toContain(SAMPLE_KEY.value);
    expect(text).toContain('`stroq sent` checks every session on this machine.');
  });
});
