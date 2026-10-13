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
    expect(findCredentialShape('$env:API_TOKEN="abcd1234"\n')).toBe('named-secret');
  });

  it('finds a commented-out credential, but leaves a location and a placeholder alone', () => {
    expect(findCredentialShape(`# API_TOKEN=${SECRET}\n`)).toBe('named-secret');
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

describe('findCredentialShape: a string with several lines in a JSON document', () => {
  it('reads each line of it as a line of an env file', () => {
    const doc = json({ envFile: `PORT=3000\nAPI_TOKEN=${SECRET}\n` });

    expect(findCredentialShape(doc)).toBe('named-secret');
  });

  it('finds nothing in one that has nothing', () => {
    expect(findCredentialShape(json({ envFile: 'PORT=3000\nHOST=localhost\n' }))).toBeNull();
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

// The header of credential-shape.ts lists what the reader does not read. A limit that is not
// pinned drifts: it is either closed by accident or forgotten, and "clean" means more or less
// than it said.
describe('findCredentialShape: what it says it does not read', () => {
  it.each([
    ['a value on a different line from its name', '- name: DB_PASSWORD\n  value: devpass1\n'],
    ['a secret under a name that says nothing', json({ sauce: 'abcd1234' })],
    ['a value of three characters under a name that says password', json({ password: 'abc' })],
    ['a pass that is part of a longer word', 'bypass=abcd1234\n'],
    [
      'a name whose last word is a label',
      json({ apiKeyHelper: 'print-key', tokenType: 'abcd1234' }),
    ],
    ['a count of tokens', json({ env: { MAX_THINKING_TOKENS: '31999' } })],
    ['a user and a numeric group', 'docker run -u app:1000 image\n'],
  ])('does not read %s', (_what, text) => {
    expect(findCredentialShape(text)).toBeNull();
  });

  // Said in the header too: a user and a group look like a user and a password.
  it('takes `-u user:group` for `-u user:password`, which a flag cannot tell apart', () => {
    expect(findCredentialShape('docker run -u app:appgroup image\n')).toBe('named-secret');
  });
});

describe('findCredentialShape: single-dash password flags for specific commands', () => {
  it.each([
    ['mysql with glued -p', 'mysql -uroot -pSecret123 db'],
    ['mysql with glued -p and quotes', "mysql -uroot -p'Secret123' db"],
    ['mysql with glued numeric password', 'mysql -p8080 db'],
    ['sshpass with numeric password', 'sshpass -p 8080 ssh me@host'],
    ['redis-cli with numeric password', 'redis-cli -a 8080 ping'],
    ['mysql with glued -p=', 'mysql -uroot -p=Secret123 db'],
    ['mariadb with glued -p', 'mariadb -pSecret123'],
    ['mysqldump with glued -p', 'mysqldump -pSecret123 mydb'],
    ['docker login with -p', 'docker login -u me -p Secret123 ghcr.io'],
    ['docker login with glued -p', 'docker login -pSecret123 ghcr.io'],
    ['docker login with -p=', 'docker login -p=Secret123 ghcr.io'],
    ['podman login with -p', 'podman login -p Secret123'],
    ['sshpass with -p', 'sshpass -p Secret123 ssh me@host'],
    ['sshpass with glued -p', 'sshpass -pSecret123 ssh me@host'],
    ['redis-cli with -a', 'redis-cli -a Secret123 ping'],
    ['redis-cli with -a=', 'redis-cli -a=Secret123 ping'],
    ['sudo mysql', 'sudo mysql -pSecret123 db'],
    ['path to mysql', '/usr/bin/mysql -pSecret123 db'],
    ['env with mysql', 'env NAME=x mysql -pSecret123 db'],
    ['chained command with mysql', 'cd /tmp && mysql -pSecret123 db'],
    ['indented line with mysql', '  mysql -pSecret123 db'],
    ['commented line with mysql', '# mysql -pSecret123 db'],
    ['docker exec with mysql', 'docker exec db mysql -uroot -pSecret123'],
  ])('finds %s in plain text', (_name, cmd) => {
    expect(findCredentialShape(`${cmd}\n`)).toBe('named-secret');
  });

  it.each([
    ['mysql in Claude allow rule', 'Bash(mysql -uroot -pSecret123 db:*)'],
    ['docker login in Claude allow rule', 'Bash(docker login -u me -p Secret123 ghcr.io:*)'],
    ['docker login with glued -p in rule', 'Bash(docker login -pSecret123:*)'],
    ['sshpass in Claude allow rule', 'Bash(sshpass -p Secret123 ssh me@host:*)'],
    ['redis-cli in Claude allow rule', 'Bash(redis-cli -a Secret123 ping:*)'],
    ['Windows path mysql.exe in rule', 'Bash(C:\\\\bin\\\\mysql.exe -pSecret123:*)'],
    ['sudo mysql in rule', 'Bash(sudo mysql -pSecret123:*)'],
  ])('finds %s in a JSON permission rule', (_name, rule) => {
    expect(findCredentialShape(json({ permissions: { allow: [rule] } }))).toBe('named-secret');
  });

  it.each([
    ['nc with port -p', 'nc -p 8080 host'],
    ['ssh with port -p', 'ssh -p 2222 host'],
    ['docker run with port -p', 'docker run -p 8080:80 nginx'],
    ['docker compose run with service named login', 'docker compose run -p 8080:80 login'],
    ['mysql with bare -p (interactive prompt)', 'mysql -u root -p db'],
    ['mysql with empty -p', "mysql -p'' db"],
    ['redis-cli with bare -a', 'redis-cli -a'],
    ['sshpass with placeholder variable', 'sshpass -p "$SSHPASS" ssh me@host'],
  ])('does not take %s for a password in plain text', (_name, cmd) => {
    expect(findCredentialShape(`${cmd}\n`)).toBeNull();
  });

  it.each([
    ['docker login with no password flag', 'Bash(docker login:*)'],
    ['mysql with bare -p', 'Bash(mysql -p:*)'],
    ['mysql with -u and bare -p', 'Bash(mysql -u root -p:*)'],
    ['mysql with empty -p', "Bash(mysql -p'':*)"],
    ['redis-cli with bare -a', 'Bash(redis-cli -a:*)'],
    ['redis-cli with placeholder variable', 'Bash(redis-cli -a $REDIS_PASSWORD ping:*)'],
    ['sshpass with quoted placeholder variable', 'Bash(sshpass -p "$SSHPASS" ssh me@host:*)'],
    ['mysql with glued placeholder variable', 'Bash(mysql -p$MYSQL_PWD db:*)'],
    ['nc with port -p', 'Bash(nc -p 8080 host:*)'],
    ['ssh with port -p', 'Bash(ssh -p 2222 host:*)'],
    ['docker run with port -p', 'Bash(docker run -p 8080:80 nginx:*)'],
    ['docker compose run with service named login', 'Bash(docker compose run -p 8080:80 login:*)'],
  ])('does not take %s for a password in a JSON rule', (_name, rule) => {
    expect(findCredentialShape(json({ permissions: { allow: [rule] } }))).toBeNull();
  });
});
