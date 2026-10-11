import { describe, expect, it } from 'vitest';
import { findCredentialShape } from '../../src/harden/backup.js';

/**
 * Credentials that a developer actually leaves in a config: a short password in an `env` block, a
 * key in the query string of an MCP server's URL, `NAME=value` in front of a command. A miss puts
 * the credential in a byte copy and in the context lines of a diff, and a false alarm costs only
 * the copy, so these lean toward yes. Every value is made up.
 */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const env = (name: string, value: string): string => json({ env: { [name]: value } });

describe('findCredentialShape: a short value under a name that says it is secret', () => {
  it.each([
    ['DB_PASSWORD', 'devpass1'],
    ['password', 'hunter2'],
    ['PASSWD', 'abcd'],
    ['pwd', 's3cr3t'],
    ['SECRET', 'topsecret'],
    ['client_secret', 'abcd1234'],
    ['API_TOKEN', 'abcd1234'],
    ['authToken', 'x1y2z3'],
    ['ANTHROPIC_AUTH_TOKEN', 'abcd1234'],
    ['apiKey', 'k3y-value'],
    ['api_key', '12345678'],
    ['X-Api-Key', 'abcd-efgh'],
    ['exaApiKey', '0123abcd'],
    ['MY_APIKEY', 'abcdef'],
    ['auth', 'secretvalue'],
    ['credentials', 'abcd1234'],
    ['private_key', 'abcd1234'],
    ['access_key', 'abcd1234'],
    ['DB_PASS', 'devpass1'],
    ['REDIS_PW', 'abcd1234'],
  ])('finds %s: %s', (name, value) => {
    expect(findCredentialShape(env(name, value))).toBe('named-secret');
  });

  it('finds the example in the review: an env block with a plain development password', () => {
    expect(findCredentialShape('{"env":{"DB_PASSWORD":"devpass1"}}')).toBe('named-secret');
  });

  it('finds a value of four characters, and not one of three', () => {
    expect(findCredentialShape(env('password', 'abcd'))).toBe('named-secret');
    expect(findCredentialShape(env('password', 'abc'))).toBeNull();
  });

  it('finds a short value in a list under such a name, and not one in an object below it', () => {
    expect(findCredentialShape(json({ passwords: ['abcd1234'] }))).toBe('named-secret');
    expect(findCredentialShape(json({ secret: ['abcd1234'] }))).toBe('named-secret');
    expect(findCredentialShape(json({ secret: { nested: ['abcd1234'] } }))).toBeNull();
  });

  it('finds a passphrase with spaces under a name that says password, and not under others', () => {
    expect(findCredentialShape(env('PASSPHRASE', 'correct horse battery'))).toBe('named-secret');
    expect(findCredentialShape(env('db_password', 'my pass phrase'))).toBe('named-secret');
    expect(findCredentialShape(env('API_TOKEN', 'two words here'))).toBeNull();
    expect(findCredentialShape(env('description_auth', 'Logs in through the browser'))).toBeNull();
  });

  it('finds a number under a name that says password: a PIN is a password', () => {
    expect(findCredentialShape(env('password', '123456'))).toBe('named-secret');
  });
});

describe('findCredentialShape: values under such names that are not credentials', () => {
  it.each([
    ['a stand-in', 'password', 'changeme'],
    ['a template', 'API_TOKEN', '<your token>'],
    ['a braced variable', 'SECRET', '${SECRET}'],
    ['a variable', 'api_key', '$API_KEY'],
    ['a lower-case variable', 'password', '$password'],
    ['the word itself', 'password', 'password'],
    ['a mode', 'auth', 'none'],
    ['a scheme', 'authorization', 'bearer'],
    ['a boolean written as a string', 'token', 'true'],
    ['a URL', 'authUrl', 'https://login.example.invalid/auth'],
    ['a URL under a name that does not say it is a location', 'auth', 'https://login.invalid/x'],
    ['a host', 'auth', 'login.example.invalid'],
    ['a path', 'private_key', '/home/me/.ssh/id_rsa'],
    ['a path in a home directory', 'credentials', '~/creds.json'],
    [
      'the path of a credentials file',
      'GOOGLE_APPLICATION_CREDENTIALS',
      '/path/to/service-acct.json',
    ],
    ['a relative path', 'private_key', './keys/id_rsa'],
    ['a count of tokens', 'MAX_THINKING_TOKENS', '10000'],
    ['a limit', 'tokenLimit', '5000'],
    ['a kind of authentication', 'authMethod', 'oauth'],
    ['a kind of token', 'tokenType', 'Bearer'],
    ['the name of a helper', 'apiKeyHelper', 'print-key'],
    ['a command that refreshes credentials', 'awsAuthRefresh', 'aws-login'],
    ['a command that exports credentials', 'awsCredentialExport', 'creds-out'],
    ['the name of a header', 'API_KEY_HEADER', 'X-Api-Key'],
    ['the id of a key', 'secretId', 'abcd1234'],
    ['a person who wrote it', 'author', 'jdoe'],
    ['a command with arguments', 'apiKeyHelper', 'print-key --quiet'],
  ])('leaves %s alone', (_what, name, value) => {
    expect(findCredentialShape(env(name, value))).toBeNull();
  });

  it('leaves a realistic Claude Code settings file alone', () => {
    const settings = {
      apiKeyHelper: '~/bin/print-key.sh',
      awsAuthRefresh: 'aws sso login --profile work',
      awsCredentialExport: '/usr/local/bin/export-aws-credentials',
      forceLoginMethod: 'claudeai',
      env: {
        MAX_THINKING_TOKENS: '31999',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
        MAX_MCP_OUTPUT_TOKENS: '50000',
        BASH_DEFAULT_TIMEOUT_MS: '120000',
        DISABLE_TELEMETRY: '1',
      },
      mcpServers: { docs: { type: 'http', url: 'https://docs.example.invalid/mcp' } },
      permissions: { deny: ['Read(./.env)', 'Bash(curl:*)'], allow: ['Bash(git status)'] },
    };

    expect(findCredentialShape(json(settings))).toBeNull();
  });
});

describe('findCredentialShape: NAME=VALUE in plain text', () => {
  it.each([
    ['a development password', 'DB_PASSWORD=devpass1\n'],
    ['an export', 'export DB_PASS=devpass1\n'],
    ['an ini file with spaces', 'password = hunter2\n'],
    ['a quoted value', 'api_key="abcd1234"\n'],
    ['a value followed by a comment', 'API_TOKEN=abcd1234 # rotate monthly\n'],
    ['a value followed by a command', 'MY_SECRET=abc123def456ghi789 node run.js\n'],
    ['a quoted passphrase', 'PASSWORD="correct horse battery"\n'],
    ['a commented-out password', '# DB_PASSWORD=devpass1\n'],
  ])('finds %s', (_what, text) => {
    expect(findCredentialShape(text)).toBe('named-secret');
  });

  it.each([
    ['a stand-in', 'DB_PASSWORD=changeme\n'],
    ['a variable', 'DB_PASSWORD=$DB_PASSWORD\n'],
    ['a short value', 'DB_PASSWORD=abc\n'],
    ['a count of tokens', 'MAX_THINKING_TOKENS=10000\n'],
    ['a name that says nothing', 'GREETING=hello-world\n'],
    ['a value with spaces under a token name', 'API_TOKEN=two words here\n'],
  ])('does not take %s for one', (_what, text) => {
    expect(findCredentialShape(text)).toBeNull();
  });
});

describe('findCredentialShape: name: value in YAML-like text and header strings', () => {
  it.each([
    ['a password', 'password: hunter2hunter2\n'],
    ['a token', 'API_TOKEN: abcdef0123456789abcd\n'],
    ['an indented key', '  secret: abcd1234\n'],
    ['a list item', '- token: abcd1234\n'],
    ['a quoted value', 'api_key: "abcd1234"\n'],
    ['a value followed by a comment', 'secret: abcd1234 # rotate\n'],
    ['an HTTP header', 'X-Api-Key: abcd1234efgh\n'],
    ['an auth header', 'X-Auth-Token: abcd1234\n'],
    ['a key with no space after the colon', 'password:hunter2hunter2\n'],
    ['a commented-out password', '# password: hunter2hunter2\n'],
  ])('finds %s', (_what, text) => {
    expect(findCredentialShape(text)).toBe('named-secret');
  });

  it.each([
    ['no value', 'password:\n'],
    ['a template', 'token: <token>\n'],
    ['a mode', 'auth: none\n'],
    ['a permission in a workflow', 'permissions:\n  id-token: write\n  contents: read\n'],
    ['a location', 'auth_url: https://login.example.invalid/auth\n'],
    ['a name that says nothing', 'greeting: hello-world\n'],
    ['a URL', 'https://example.invalid/auth\n'],
    ['a drive', 'C:\\Users\\me\\token.txt\n'],
  ])('does not take %s for one', (_what, text) => {
    expect(findCredentialShape(text)).toBeNull();
  });

  it('finds a header written as a string of a JSON document', () => {
    expect(findCredentialShape(json({ args: ['-H', 'X-Api-Key: abcd1234efgh'] }))).toBe(
      'named-secret',
    );
  });
});

describe('findCredentialShape: NAME=value in front of a command, or in an option', () => {
  it.each([
    ['in a command string', json({ command: 'MY_SECRET=abc123def456ghi789 node run.js' })],
    ['after a directory change', json({ command: 'cd app && DB_PASSWORD=devpass1 npm test' })],
    ['as an argument of an option', json({ args: ['-e', 'API_KEY=abcd1234', 'image'] })],
    ['in a docker command', 'docker run -e API_KEY=abcd1234 image\n'],
    ['joined to its option', 'docker run --env=API_KEY=abcd1234 image\n'],
    ['in the middle of a line', 'run --quiet DB_PASSWORD=devpass1 --verbose\n'],
    ['in an npm config command', 'npm config set //registry.invalid/:_authToken=abcd1234\n'],
  ])('finds one %s', (_what, text) => {
    expect(findCredentialShape(text)).toBe('named-secret');
  });

  it.each([
    ['a plain variable', json({ command: 'NODE_ENV=production node run.js' })],
    ['a path', json({ command: 'TOKEN_FILE=/etc/app/token node run.js' })],
    ['a variable', json({ command: 'API_KEY=$API_KEY node run.js' })],
    ['a braced variable', json({ command: 'API_KEY=${API_KEY} node run.js' })],
    ['a count of tokens', json({ command: 'MAX_THINKING_TOKENS=10000 claude' })],
    ['a flag that only starts like a secret one', 'run --token-limit=1000\n'],
    ['an assignment of a short value', json({ command: 'API_TOKEN=abc run' })],
    ['a comparison', json({ command: 'test "$TOKEN" = "$EXPECTED_TOKEN"' })],
  ])('does not take %s for one', (_what, text) => {
    expect(findCredentialShape(text)).toBeNull();
  });
});

describe('findCredentialShape: a key in the query string or the fragment of a URL', () => {
  const exa = 'https://mcp.exa.ai/mcp?exaApiKey=0123abcd-4567-89ef-0123-456789abcdef';

  it.each([
    ['an MCP server URL, as the review gave it', json({ mcpServers: { exa: { url: exa } } })],
    ['the same in plain text', `url = ${exa}\n`],
    ['a token parameter', 'https://hooks.invalid/x?token=abcd1234\n'],
    ['a later parameter', 'https://hooks.invalid/x?a=1&api_key=abcd1234\n'],
    ['a parameter of a bare query string', '?a=1&token=abcd1234\n'],
    ['the fragment', 'https://app.invalid/cb#access_token=abcd1234\n'],
    ['a parameter called key', 'https://maps.invalid/api?key=abcd1234\n'],
    ['a parameter called sig', 'https://files.invalid/x?sig=abcd1234\n'],
    ['a parameter called signature', 'https://files.invalid/x?signature=abcd1234\n'],
    ['a password parameter', 'https://db.invalid/x?password=abcd1234\n'],
    ['a parameter after a semicolon', 'https://db.invalid/x?a=1;secret=abcd1234\n'],
  ])('finds %s', (_what, text) => {
    expect(findCredentialShape(text)).toBe('named-secret');
  });

  it.each([
    ['parameters that say nothing', 'https://api.invalid/x?page=2&limit=10\n'],
    ['a variable', 'https://api.invalid/x?token=${TOKEN}\n'],
    ['a template', 'https://api.invalid/x?token=<token>\n'],
    ['a short value', 'https://api.invalid/x?token=abc\n'],
    ['auth in the path', 'https://example.invalid/auth/callback?state=abcd1234\n'],
    ['the word auth as a value', 'https://api.invalid/x?mode=auth\n'],
    ['an author', 'https://api.invalid/x?author=jdoe\n'],
    ['a parameter called key outside a URL', 'key=abcd1234\n'],
    ['a count', 'https://api.invalid/x?max_tokens=4096\n'],
  ])('does not take %s for one', (_what, text) => {
    expect(findCredentialShape(text)).toBeNull();
  });
});

describe('findCredentialShape: credentials given to curl, and headers given with -H', () => {
  it.each([
    ['-u', 'curl -u admin:s3cretpw https://x.invalid\n'],
    ['--user', 'curl --user admin:s3cretpw https://x.invalid\n'],
    ['--user=', 'curl --user=admin:s3cretpw https://x.invalid\n'],
    ['--proxy-user', 'curl --proxy-user admin:s3cretpw https://x.invalid\n'],
    ['-H', "curl -H 'X-Api-Key: abcd1234efgh' https://x.invalid\n"],
    ['-H with a double quote', 'curl -H "X-Auth-Token: abcd1234" https://x.invalid\n'],
    ['--header', "curl --header 'X-Api-Key: abcd1234efgh' https://x.invalid\n"],
    ['--header=', "curl --header='X-Api-Key: abcd1234efgh' https://x.invalid\n"],
    [
      '-H in an argument list',
      json({ args: ['-H', 'X-Api-Key: abcd1234efgh', 'https://x.invalid'] }),
    ],
    ['-u in an argument list', json({ args: ['-u', 'admin:s3cretpw'] })],
  ])('finds %s', (_flag, text) => {
    expect(findCredentialShape(text)).toBe('named-secret');
  });

  it.each([
    ['a user and a group', 'docker run -u 1000:1000 image\n'],
    ['a user without a password', 'curl -u admin https://x.invalid\n'],
    ['a variable', 'curl -u admin:$PASSWORD https://x.invalid\n'],
    [
      'a header that is not a secret',
      "curl -H 'Content-Type: application/json' https://x.invalid\n",
    ],
    ['a header with a variable', "curl -H 'X-Api-Key: ${KEY}' https://x.invalid\n"],
    ['a header with no value', "curl -H 'X-Api-Key:' https://x.invalid\n"],
    ['-H and nothing after it', 'curl -H\n'],
  ])('does not take %s for one', (_what, text) => {
    expect(findCredentialShape(text)).toBeNull();
  });
});

describe('findCredentialShape: the Authorization header', () => {
  it('finds a token after a letter that lower-cases to two, which moves every offset after it', () => {
    const text = `${'\u0130'.repeat(3)} Authorization: Bearer abcdef0123456789\n`;

    expect(text.toLowerCase().length).not.toBe(text.length);
    expect(findCredentialShape(text)).toBe('named-secret');
  });

  it.each([
    ['the Token scheme', 'Authorization: Token abcdef0123456789\n'],
    [
      'the Token scheme as a JSON header',
      json({ headers: { Authorization: 'Token abcdef0123456789' } }),
    ],
    ['a key with no scheme', 'Authorization: abcdef0123456789\n'],
    [
      'a key with no scheme as a JSON header',
      json({ headers: { Authorization: 'abcdef0123456789' } }),
    ],
  ])('finds %s', (_what, text) => {
    expect(findCredentialShape(text)).toBe('named-secret');
  });

  it.each([
    ['a template', 'Authorization: Token <token>\n'],
    ['the scheme alone', 'Authorization: Token\n'],
    ['a variable', 'Authorization: abc ${TOKEN}\n'],
  ])('does not take %s for one', (_what, text) => {
    expect(findCredentialShape(text)).toBeNull();
  });
});
