import { describe, expect, it } from 'vitest';
import { findCredentialShape, planBackup } from '../../src/harden/backup.js';
import { MAX_LINE_CHARS } from '../../src/harden/credential-lines.js';

/**
 * Forms of credential that a config file holds without a variable name in front of them: a
 * header, the front of a URL, a key block, the value after a flag. Every value here is built on
 * the synthetic prefix used across the repository, so none of them is a credential.
 */
const SECRET = 'stroq_attack_fixture_value_0123456789';
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

describe('findCredentialShape: an Authorization header', () => {
  it.each([
    ['in plain text', `Authorization: Bearer ${SECRET}\n`],
    ['in any case', `AUTHORIZATION: BEARER ${SECRET}\n`],
    ['with Basic', 'Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==\n'],
    ['as a Proxy-Authorization header', `Proxy-Authorization: Bearer ${SECRET}\n`],
    ['in a curl command', `curl -H "Authorization: Bearer ${SECRET}" https://x.invalid\n`],
    ['after an equals sign', `authorization=Bearer ${SECRET}\n`],
  ])('finds it %s', (_name, text) => {
    expect(findCredentialShape(text)).toBe('named-secret');
  });

  it('finds it in a JSON document, as a header object and as an argument', () => {
    expect(findCredentialShape(json({ headers: { Authorization: `Bearer ${SECRET}` } }))).toBe(
      'named-secret',
    );
    expect(
      findCredentialShape(
        json({ args: ['-H', `Authorization: Basic ${'QWxhZGRpbjpvcGVuIHNlc2FtZQ=='}`] }),
      ),
    ).toBe('named-secret');
  });

  it.each([
    ['a template', 'Authorization: Bearer <token>\n'],
    ['a shell variable', 'Authorization: Bearer $TOKEN\n'],
    ['a braced variable', 'Authorization: Bearer ${API_TOKEN}\n'],
    ['a stand-in', 'Authorization: Bearer YOUR_TOKEN_HERE\n'],
    ['no credential at all', 'Authorization: Bearer\n'],
    ['a scheme with nothing after it', 'Authorization: Basic\n'],
    ['a token that is too short to be one', 'Authorization: Bearer abc\n'],
    [
      'prose that happens to say it',
      'Basic authentication and bearer tokens are explained below.\n',
    ],
    ['the word without the header', 'Bearer abcdefghijklmnop0123\n'],
    ['another header', 'X-Request: Bearer abcdefghijklmnop0123\n'],
  ])('does not take %s for one', (_name, text) => {
    expect(findCredentialShape(text)).toBeNull();
  });
});

describe('findCredentialShape: a URL with a password in front of its host', () => {
  it.each([
    ['a database URL', `postgres://app:${SECRET}@db.invalid:5432/app\n`],
    ['an https URL', 'https://alice:s3cretPass9@example.invalid/path\n'],
    ['a short password', 'redis://default:hunter2@cache.invalid\n'],
    [
      'a token in place of the user',
      'https://abcdefghijklmnopqrstuvwxyz0123@example.invalid/repo\n',
    ],
    ['a URL among other words', 'remote = "git clone https://u:pw12345@h.invalid/r.git"\n'],
  ])('finds %s', (_name, text) => {
    expect(findCredentialShape(text)).toBe('named-secret');
  });

  it('finds it inside a JSON string', () => {
    expect(
      findCredentialShape(
        json({ mcpServers: { db: { url: 'postgres://u:pw12345@h.invalid/d' } } }),
      ),
    ).toBe('named-secret');
  });

  it.each([
    ['a user name alone', 'ssh://git@github.com/org/repo.git\n'],
    ['a scp-style address', 'git@github.com:org/repo.git\n'],
    ['no userinfo', 'https://example.invalid/path?mail=a@b.invalid\n'],
    ['an empty password', 'postgres://user:@host.invalid/db\n'],
    ['the word password', 'postgres://user:password@localhost/db\n'],
    ['the word pass', 'http://user:pass@host.invalid/\n'],
    ['a template', 'postgres://user:<password>@host.invalid/db\n'],
    ['a shell variable', 'postgres://user:${DB_PASSWORD}@host.invalid/db\n'],
    ['x marks', 'mongodb://admin:xxxxxxxx@host.invalid/db\n'],
    ['a port', 'http://localhost:8080/path\n'],
    ['a one letter password', 'ftp://u:p@host.invalid\n'],
  ])('does not take %s for one', (_name, text) => {
    expect(findCredentialShape(text)).toBeNull();
  });
});

describe('findCredentialShape: a PEM private key', () => {
  it.each([
    'PRIVATE KEY',
    'RSA PRIVATE KEY',
    'EC PRIVATE KEY',
    'DSA PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
    'ENCRYPTED PRIVATE KEY',
    'PGP PRIVATE KEY BLOCK',
  ])('finds the header of a %s', (label) => {
    expect(findCredentialShape(`-----BEGIN ${label}-----\nMIIEvQIBADANBgkq\n`)).toBe('private-key');
  });

  it('finds one inside a JSON string, where its line breaks are escapes', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----\n';

    expect(findCredentialShape(json({ tls: { key } }))).toBe('private-key');
  });

  it('finds one that has lost its footer', () => {
    expect(findCredentialShape('-----BEGIN PRIVATE KEY')).toBe('private-key');
  });

  it.each([
    '-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+g\n-----END CERTIFICATE-----\n',
    '-----BEGIN PUBLIC KEY-----\nMFwwDQYJKoZI\n-----END PUBLIC KEY-----\n',
    '-----BEGIN RSA PUBLIC KEY-----\nMEgCQQC\n-----END RSA PUBLIC KEY-----\n',
    'a private key is a secret; keep it out of git\n',
  ])('leaves public material and prose alone', (text) => {
    expect(findCredentialShape(text)).toBeNull();
  });
});

describe('findCredentialShape: the value after a flag', () => {
  const server = (...args: string[]): string =>
    json({ mcpServers: { x: { command: 'npx', args: ['some-server', ...args] } } });

  it.each([
    ['--password', 'hunter2hunter2'],
    ['--passwd', 'hunter2hunter2'],
    ['--token', 'abcdef0123456789'],
    ['--api-key', 'abcdef0123456789'],
    ['--api_key', 'abcdef0123456789'],
    ['--API-KEY', 'abcdef0123456789'],
    ['--apikey', 'abcdef0123456789'],
    ['--secret', 'abcdef0123456789'],
    ['--client-secret', 'abcdef0123456789'],
    ['--access-token', 'abcdef0123456789'],
  ])('finds %s followed by its value, as the next element of an argument list', (flag, value) => {
    expect(findCredentialShape(server(flag, value))).toBe('named-secret');
  });

  it.each(['--password', '--token', '--api-key', '--secret'])(
    'finds %s=value written as one element',
    (flag) => {
      expect(findCredentialShape(server(`${flag}=abcdef0123456789`))).toBe('named-secret');
    },
  );

  it('finds it in a command line in plain text, and in a string', () => {
    expect(findCredentialShape('mycli --password hunter2hunter2 --verbose\n')).toBe('named-secret');
    expect(findCredentialShape('mycli --token=abcdef0123456789\n')).toBe('named-secret');
    expect(
      findCredentialShape(json({ hooks: { command: 'deploy --api-key abcdef0123456789' } })),
    ).toBe('named-secret');
  });

  it.each([
    ['a flag whose name only starts the same way', ['--password-file', '/etc/app/pw']],
    ['a flag about tokens that is not a secret', ['--token-limit', '1000']],
    ['a shell variable', ['--token', '$TOKEN']],
    ['a braced variable', ['--token', '${API_TOKEN}']],
    ['a template', ['--api-key', '<your key>']],
    ['a path', ['--api-key', '~/.keys/api']],
    ['no value', ['--token']],
    ['another flag as the next element', ['--password', '--verbose']],
    ['a value that is too short', ['--secret', 'abc']],
    ['a stand-in', ['--password', 'changeme']],
    ['a value that is not the next element', ['--token', '--other', 'abcdef0123456789']],
    ['a flag spelled with one dash', ['-token', 'abcdef0123456789']],
  ])('does not take %s for one', (_name, args) => {
    expect(findCredentialShape(server(...args))).toBeNull();
  });
});

describe('findCredentialShape: what it found before still turns up', () => {
  it('finds NAME=VALUE with spaces around the sign, an export in front, and a quoted value', () => {
    expect(findCredentialShape(`export API_TOKEN = "${SECRET}"\n`)).toBe('named-secret');
    expect(findCredentialShape(`  API_TOKEN='${SECRET}'\n`)).toBe('named-secret');
    expect(findCredentialShape(`API_TOKEN=${SECRET} # note\n`)).toBe('named-secret');
    expect(findCredentialShape(`//registry.invalid/:_authToken=${SECRET}\n`)).toBe('named-secret');
  });

  it('leaves a comment, a location and a placeholder alone', () => {
    expect(findCredentialShape(`# API_TOKEN=${SECRET}\n`)).toBeNull();
    expect(findCredentialShape('AUTH_URL=https://login.example.invalid/token\n')).toBeNull();
    expect(findCredentialShape('API_TOKEN=<your-token-here>\n')).toBeNull();
  });
});

describe('findCredentialShape: a line it cannot read', () => {
  it('reports a line over the limit as unchecked when nothing else was found', () => {
    const text = `node_modules/\n# ${'x'.repeat(MAX_LINE_CHARS + 1)}\n.env\n`;

    expect(findCredentialShape(text)).toBe('unchecked-line');
  });

  it('reads a line of exactly the limit', () => {
    const text = `# ${'x'.repeat(MAX_LINE_CHARS - 2)}\n`;

    expect(text.split('\n')[0]).toHaveLength(MAX_LINE_CHARS);
    expect(findCredentialShape(text)).toBeNull();
  });

  it('still reports what it did find, when there is a long line too', () => {
    const long = `# ${'x'.repeat(MAX_LINE_CHARS + 1)}`;

    expect(findCredentialShape(`${long}\nAPI_TOKEN=${SECRET}\n`)).toBe('named-secret');
    expect(findCredentialShape(`${long}\ntoken ghp_0123456789abcdefghijklmnop\n`)).toBe(
      'vendor-token',
    );
  });

  it('does not take a long value on a NAME= line for clean', () => {
    expect(findCredentialShape(`API_TOKEN=${'y'.repeat(MAX_LINE_CHARS + 10)}\n`)).toBe(
      'unchecked-line',
    );
  });

  it('does not call a minified JSON document unchecked: it is read by its strings, not its lines', () => {
    const minified = JSON.stringify({ a: 'x'.repeat(MAX_LINE_CHARS * 2), b: [1, 2, 3] });

    expect(minified.length).toBeGreaterThan(MAX_LINE_CHARS);
    expect(findCredentialShape(minified)).toBeNull();
  });

  it('gives the notice for it that is true of it, not the one for a large file', () => {
    expect(planBackup(`# ${'x'.repeat(MAX_LINE_CHARS + 1)}\n`)).toEqual({
      backup: 'none-unchecked',
      notices: ['no byte backup: the file has a line too long to check for credential-shaped text'],
    });
  });
});

describe('findCredentialShape: JSON documents, as before', () => {
  it('hands the name of a key down to the items of its list, and to nothing else', () => {
    expect(findCredentialShape(json({ tokens: [SECRET] }))).toBe('named-secret');
    expect(findCredentialShape(json({ tokens: [[{ plain: SECRET }]] }))).toBeNull();
    expect(findCredentialShape(json({ tokens: [[SECRET]] }))).toBe('named-secret');
  });

  it('does not run out of stack on a document nested far deeper than any config is', () => {
    const deep = `{"a":${'['.repeat(100_000)}${']'.repeat(100_000)}}`;

    expect(findCredentialShape(deep)).toBeNull();
  });
});
