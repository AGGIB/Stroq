import { describe, expect, it } from 'vitest';
import { MAX_SCAN_CHARS } from '@stroq/core';
import { findCredentialShape, planBackup } from '../../src/harden/backup.js';
import { cpuNow } from '../helpers/cpu-time.js';

/**
 * Values taken from the detectors' own test fixtures in core, or built on the synthetic prefix
 * every fixture in this repository uses, so that none of them is a credential.
 */
const VENDOR_TOKENS = {
  github: 'ghp_0123456789abcdefghijklmnop',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  openai: 'sk-abcdefghijklmnop1234',
  npm: 'npm_abcdefghijklmnopqrstuvwxyz',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop',
};
const FAKE_SECRET = 'stroq_attack_fixture_value_0123456789';

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

describe('findCredentialShape: text that holds a credential', () => {
  it.each(Object.entries(VENDOR_TOKENS))(
    'finds a %s-shaped token wherever it sits in a JSON file',
    (_vendor, token) => {
      expect(findCredentialShape(json({ hooks: { note: `use ${token} here` } }))).toBe(
        'vendor-token',
      );
      expect(findCredentialShape(json({ mcpServers: { x: { args: ['--key', token] } } }))).toBe(
        'vendor-token',
      );
      expect(findCredentialShape(json({ misc: [1, [token]] }))).toBe('vendor-token');
    },
  );

  it('finds a vendor token in a comment or in prose, where no parser would look', () => {
    expect(findCredentialShape(`# remember: ${VENDOR_TOKENS.github}\nnode_modules/\n`)).toBe(
      'vendor-token',
    );
  });

  it('finds a vendor token that is written URL-encoded', () => {
    expect(findCredentialShape('url=https://x.invalid/?t=ghp%5F0123456789abcdefghijklmnop')).toBe(
      'vendor-token',
    );
  });

  it('finds a value under a name that says it is a credential, in JSON', () => {
    expect(findCredentialShape(json({ env: { API_TOKEN: FAKE_SECRET } }))).toBe('named-secret');
    expect(findCredentialShape(json({ db: { password: 'p@ssw0rd-1234567' } }))).toBe(
      'named-secret',
    );
    expect(findCredentialShape(json({ servers: [{ client_secret: FAKE_SECRET }] }))).toBe(
      'named-secret',
    );
  });

  it('finds a value in a list under a name that says it is a credential', () => {
    expect(findCredentialShape(json({ tokens: [FAKE_SECRET] }))).toBe('named-secret');
  });

  it('finds NAME=VALUE lines, as in an env file, an ini file or an npmrc', () => {
    expect(findCredentialShape(`PORT=3000\nAPI_TOKEN=${FAKE_SECRET}\n`)).toBe('named-secret');
    expect(
      findCredentialShape(
        '[default]\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n',
      ),
    ).toBe('named-secret');
    expect(findCredentialShape(`export SECRET_TOKEN=${FAKE_SECRET}\n`)).toBe('named-secret');
  });

  it('finds it far down a long file, past the point where line readers stop', () => {
    const padding = 'node_modules/\n'.repeat(6000);
    expect(findCredentialShape(`${padding}API_TOKEN=${FAKE_SECRET}\n`)).toBe('named-secret');
  });

  it('finds a payment card, an IBAN and a social security number', () => {
    expect(findCredentialShape(json({ note: 'card 4242 4242 4242 4242' }))).toBe('personal-data');
    expect(findCredentialShape(json({ note: 'DE89370400440532013000' }))).toBe('personal-data');
    expect(findCredentialShape(json({ note: 'ssn 123-45-6789' }))).toBe('personal-data');
  });

  // Text beyond the bound is not scanned by the detectors; a file that cannot be checked all the
  // way through is not one to copy.
  it('treats a text too large to check completely as one that holds a credential', () => {
    expect(findCredentialShape('x'.repeat(MAX_SCAN_CHARS + 1))).toBe('unchecked');
  });
});

describe('findCredentialShape: text that does not', () => {
  const settings = {
    model: 'claude-sonnet-4-5-20250929',
    permissions: {
      defaultMode: 'acceptEdits',
      allow: ['Bash(npm run test:*)', 'Bash(git status)', 'WebFetch(domain:docs.example.invalid)'],
      deny: ['Read(~/.ssh/**)', 'Read(./.env)', 'Bash(curl:*)'],
    },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'stroq hook claude-code' }] },
      ],
    },
    statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
    apiKeyHelper: '~/bin/print-key.sh',
    env: { NODE_ENV: 'production', BASH_DEFAULT_TIMEOUT_MS: '120000' },
    enabledPlugins: { 'everything-claude-code@everything-claude-code': true },
    includeCoAuthoredBy: false,
  };

  it('leaves a realistic agent settings file alone', () => {
    expect(findCredentialShape(json(settings))).toBeNull();
  });

  it('leaves an ignore file alone', () => {
    expect(findCredentialShape('.env\n.env.*\nnode_modules/\n**/*.pem\nsecrets/\n')).toBeNull();
  });

  it('leaves locations under credential-looking names alone: a URL, a host, a path', () => {
    const doc = json({
      env: {
        AUTH0_ISSUER_BASE_URL: 'https://dev-abc.us.auth0.com',
        SESSION_COOKIE_DOMAIN: '.staging.example.com',
        TOKEN_FILE: '/etc/ssl/private/token',
        token_endpoint: 'https://login.example.invalid/oauth/token',
      },
    });
    expect(findCredentialShape(doc)).toBeNull();
  });

  // Not "short" as it was: a value of four characters or more under a name that says password,
  // token or api key is a credential (a development password is not twelve characters long); see
  // credential-short-forms.test.ts. Under four characters it is still an ordinary word.
  it('leaves a value of under four characters under a credential-looking name alone', () => {
    expect(findCredentialShape(json({ password: 'abc', token: 'xy' }))).toBeNull();
  });

  it('leaves placeholders alone', () => {
    expect(
      findCredentialShape(
        json({ env: { API_TOKEN: '<your-token-here>', SECRET_KEY: 'changeme-please-now' } }),
      ),
    ).toBeNull();
  });

  // An address, a date and a version number are not credentials, and a file that holds one is
  // exactly the file worth a copy.
  it('leaves an email address, a date and a version number alone', () => {
    expect(
      findCredentialShape(
        json({ email: 'dev@example.com', appliedAt: '2026-10-10', version: '1.2.3.4' }),
      ),
    ).toBeNull();
  });

  it('is null for empty text', () => {
    expect(findCredentialShape('')).toBeNull();
  });

  it('never returns the value it found', () => {
    expect(findCredentialShape(json({ env: { API_TOKEN: FAKE_SECRET } }))).not.toContain(
      FAKE_SECRET,
    );
  });
});

// A repository can commit a config file, and a config file is what this reads.
describe('findCredentialShape: hostile text', () => {
  it('stays fast on long runs of the characters the patterns look for', () => {
    const texts = [
      '1'.repeat(1_000_000),
      '1 '.repeat(300_000),
      '"a":"'.repeat(150_000),
      'a'.repeat(1_000_000),
      '='.repeat(500_000),
      `{${'['.repeat(100_000)}`,
    ];
    const begin = cpuNow();
    for (const text of texts) findCredentialShape(text);
    expect(cpuNow() - begin).toBeLessThan(20_000);
  });

  it('does not run out of stack on a document nested far deeper than any config is', () => {
    const deep = `{"a":${'['.repeat(50_000)}${']'.repeat(50_000)}}`;
    expect(() => findCredentialShape(deep)).not.toThrow();
    expect(findCredentialShape(deep)).toBeNull();
  });
});

describe('planBackup: what the plan tells the owner about the copy', () => {
  it('promises a copy of a file that holds nothing like a credential', () => {
    expect(planBackup(json({ model: 'x' }))).toEqual({ backup: 'copy', notices: [] });
  });

  it('says there is no byte backup when the file holds credential-shaped text', () => {
    expect(planBackup(json({ env: { API_TOKEN: FAKE_SECRET } }))).toEqual({
      backup: 'none-credential-text',
      notices: ['no byte backup: the file holds credential-shaped text'],
    });
  });

  it('needs no copy of a file that does not exist yet, and says nothing alarming', () => {
    expect(planBackup(null)).toEqual({ backup: 'none-new-file', notices: [] });
  });

  // Not the same thing, and not to be said as if it were: nothing was found, because nothing could
  // be looked at in full.
  it('says so when the file was too large to be checked, rather than that it holds a credential', () => {
    expect(planBackup('x'.repeat(MAX_SCAN_CHARS + 1))).toEqual({
      backup: 'none-unchecked',
      notices: ['no byte backup: the file is too large to check for credential-shaped text'],
    });
  });
});
