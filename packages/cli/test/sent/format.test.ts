import { describe, expect, it } from 'vitest';
import { formatSent } from '../../src/sent/format.js';
import type { SentCredential, SentReport } from '../../src/sent/report.js';

const AT = '2026-09-14T11:02:14.000Z';

const credential = (c: Partial<SentCredential> = {}): SentCredential => ({
  name: 'aws_secret_access_key',
  source: '~/.aws/credentials',
  canary: false,
  count: 2,
  first: AT,
  last: AT,
  occurrences: [
    { via: 'tool_result', tool: 'Read', call: '~/.aws/credentials', at: AT },
    { via: 'tool_argument', tool: 'Bash', call: 'curl -H [REDACTED] https://x.test', at: AT },
  ],
  ...c,
});

const report = (r: Partial<SentReport> = {}): SentReport => ({
  version: 1,
  origin: 'transcript',
  agent: 'claude-code',
  path: '/home/u/.claude/projects/-repo/abc.jsonl',
  sessionId: 'abc',
  first: AT,
  last: AT,
  credentials: [credential()],
  files: [
    {
      path: '~/.aws/credentials',
      tool: 'Read',
      evidence: 'read',
      call: '~/.aws/credentials',
      at: AT,
    },
  ],
  coverage: {
    toolResultsRead: true,
    indexedSecrets: 41,
    indexedSources: ['~/.aws/credentials', '.env'],
    calls: 312,
    results: 300,
  },
  ...r,
});

describe('formatSent', () => {
  it('names the credential, its source and how it got there', () => {
    const text = formatSent(report());
    expect(text).toContain('aws_secret_access_key');
    expect(text).toContain('~/.aws/credentials');
    expect(text).toContain('Bash');
  });

  // The single most important line in the whole command. Content reaching a model
  // provider is how these products work; the finding is "you probably did not know",
  // never "you were breached". Copy that overstates this is the thing this project
  // has already been punished for, so it is asserted, not left to reviewers.
  it('states plainly what the finding does not mean', () => {
    const text = formatSent(report()).toLowerCase();
    expect(text).toContain('not');
    expect(text).toContain('breach');
    expect(text).toMatch(/retain|kept|stored/);
    expect(text).not.toContain('leaked');
    expect(text).not.toContain('hacked');
    expect(text).not.toContain('compromised');
  });

  it('says what the index knew, because that is the ceiling on what it can find', () => {
    const text = formatSent(report());
    expect(text).toContain('41');
    expect(text).toContain('rotated');
  });

  it('warns that the audit log holds no tool results', () => {
    const text = formatSent(
      report({
        origin: 'audit-log',
        agent: null,
        path: null,
        coverage: {
          toolResultsRead: false,
          indexedSecrets: 41,
          indexedSources: ['.env'],
          calls: 12,
          results: 0,
        },
      }),
    );
    expect(text).toContain('--last');
    expect(text.toLowerCase()).toContain('arguments');
  });

  it('is unambiguous when nothing was found', () => {
    const text = formatSent(report({ credentials: [], files: [] }));
    expect(text).toContain('No indexed credential');
  });

  // A shell command that names a credential file is not the same observation as a
  // `Read` of one, and the report must not present them as though they were.
  it('hedges a file a command merely named', () => {
    const text = formatSent(
      report({
        files: [
          {
            path: '~/.aws/credentials',
            tool: 'Bash',
            evidence: 'named',
            call: 'grep -c profile ~/.aws/credentials',
            at: AT,
          },
        ],
      }),
    );
    expect(text).toContain('named in the command');
    expect(text).not.toContain('contents came back');
  });

  it('marks a canary as a canary', () => {
    const text = formatSent(
      report({ credentials: [credential({ name: 'STROQ_CANARY_KEY', canary: true })] }),
    );
    expect(text).toContain('canary');
  });
});
