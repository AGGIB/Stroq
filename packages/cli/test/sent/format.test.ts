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

  // A local transcript proves the recorded match, not a subsequent model request.
  // Keep that distinction visible even for a tool result and a file-read finding.
  it('does not claim the provider received a recorded value or file', () => {
    const text = formatSent(report()).toLowerCase();
    expect(text).toContain('credential values found in this session record');
    expect(text).toContain('in the result of');
    expect(text).toContain('in the arguments of');
    expect(text).toContain('read/grep call was recorded');
    expect(text).toContain('cannot confirm a later model request, delivery to a provider');
    expect(text).toContain('breach');
    expect(text).toContain('retention');
    expect(text).not.toContain('already reached a model provider');
    expect(text).not.toContain('was sent to the model whole');
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
    expect(text).toContain('never what came back');
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
    expect(text).toContain('named in a shell command');
    expect(text).toContain('whether it read or printed the file is unknown');
    expect(text).not.toContain('Read/Grep call was recorded');
  });

  it('marks a canary as a canary', () => {
    const text = formatSent(
      report({ credentials: [credential({ name: 'STROQ_CANARY_KEY', canary: true })] }),
    );
    expect(text).toContain('canary');
  });
});

// The report opened on a header and went straight into detail: no line said what the
// scan concluded, which is the line a user would act on — or screenshot.
describe('the verdict at the top of stroq sent', () => {
  const verdict = (text: string): string => text.split('\n')[2] ?? '';

  it('names what was found, first, in one line', () => {
    const line = verdict(formatSent(report()));
    expect(line).toMatch(/^✗ /);
    expect(line).toContain('1 known credential value');
    expect(line).toContain('aws_secret_access_key');
  });

  it('says clean with the numbers that make clean mean something', () => {
    const line = verdict(formatSent(report({ credentials: [], files: [] })));
    expect(line).toMatch(/^✓ /);
    expect(line).toContain('312 tool call(s)');
    expect(line).toContain('41 indexed value(s)');
  });

  it('keeps a file touched without a value from reading as clean', () => {
    const line = verdict(formatSent(report({ credentials: [] })));
    expect(line).toMatch(/^! /);
    expect(line).toContain('1 credential file');
  });

  it('points to where each found credential is rotated', () => {
    const text = formatSent(report());
    expect(text).toContain('https://console.aws.amazon.com/iam/home#/security_credentials');
  });
});
