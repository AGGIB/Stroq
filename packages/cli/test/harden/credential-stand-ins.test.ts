import { describe, expect, it } from 'vitest';
import { findCredentialShape } from '../../src/harden/backup.js';
import { isLocation, isStandIn } from '../../src/harden/credential-values.js';

/**
 * What stands in for a value, and what only begins like one. A value that starts with `$`, `-`
 * or `/` was never read as a credential, so a password such as `$ecretPass` and a base64 token
 * that happens to start with `/` or `-` (one in 32) passed every check for a flag, a header or a
 * URL. Only a WHOLE variable, template, path or flag is a stand-in.
 */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const server = (...args: string[]): string => json({ mcpServers: { x: { args } } });

describe('isStandIn: whole forms', () => {
  it.each([
    '${DB_PASSWORD}',
    '${env:TOKEN}',
    '$(pass show db)',
    '$API_TOKEN',
    '$api_token',
    '$1',
    '<your token>',
    '<token>',
    '%API_TOKEN%',
    '{{ secrets.token }}',
    '{token}',
    '~',
    '~/.keys/api',
    './token.txt',
    '../keys/api',
    '/etc/ssl/private/token',
    '/Users/me/.config/gcloud/creds.json',
    '/path/to/service-account.json',
    '/run/secrets/db_password',
    '--verbose',
    '--',
    '-v',
    '-n5',
    '-',
    '@token.txt',
    '@scope/package',
    'changeme',
    'change-me-please',
    'replace_me',
    'TODO',
    'example-token',
    'sample',
    'dummy-value',
    'placeholder',
    'your_token_here',
    'xxxxxxxx',
    '********',
    'password',
    'Secret',
    'token',
    'none',
    'true',
    'write',
    '...',
    '…',
    'Bearer',
    'oauth2',
  ])('takes %s for one', (value) => {
    expect(isStandIn(value)).toBe(true);
  });

  it.each([
    '$ecretPass',
    '$Ecret1',
    '$ecret$pass',
    '<abc>def9',
    '%abc9',
    '{brace9word',
    '~tilde99',
    '/Kx9aB3dE5fG7hJ+/mN2pQ',
    '/K7MDENG/bPxRfiCYEXAMPLEKEY',
    '/AbCdEf123456+/GhIjKl==',
    '-aB3dE5fG7hJ_mN2pQ',
    '-Xk9_Lm2Qr',
    '@dm1nPass9',
    'hunter2',
    'devpass1',
    'p@ssw0rd',
    'abc123def456ghi789',
  ])('does not take %s for one', (value) => {
    expect(isStandIn(value)).toBe(false);
  });

  it('has no cost worth speaking of for a very long value', () => {
    expect(isStandIn('/'.repeat(100_000))).toBe(true);
    expect(isStandIn(`/${'a/'.repeat(50_000)}aB`)).toBe(false);
    expect(isStandIn(`$${'A'.repeat(100_000)}`)).toBe(true);
    expect(isStandIn('-'.repeat(100_000))).toBe(true);
  });
});

describe('isLocation', () => {
  it.each([
    'https://login.example.invalid/x',
    'postgres://db.invalid/app',
    'login.example.invalid',
    'login.example.invalid:8080',
    'localhost:3000',
    '.staging.example.com',
  ])('takes %s for one', (value) => {
    expect(isLocation(value)).toBe(true);
  });

  it.each(['hunter2', 'abcd1234', 'a:b'])('does not take %s for one', (value) => {
    expect(isLocation(value)).toBe(false);
  });
});

describe('findCredentialShape: values that only begin like a stand-in', () => {
  it('finds a password in front of a host that starts with a dollar sign', () => {
    expect(findCredentialShape('redis://u:$ecretPass@h.invalid\n')).toBe('named-secret');
  });

  it.each([
    ['a braced variable', 'redis://u:${DB_PASS}@h.invalid\n'],
    ['a variable', 'redis://u:$DB_PASS@h.invalid\n'],
    ['a lower-case variable', 'redis://u:$password@h.invalid\n'],
    ['a template', 'redis://u:<password>@h.invalid\n'],
  ])('leaves %s in front of a host alone', (_what, text) => {
    expect(findCredentialShape(text)).toBeNull();
  });

  it.each([
    ['starts with a slash', '/Kx9aB3dE5fG7hJ+/mN2pQ'],
    ['starts with a dash', '-aB3dE5fG7hJ_mN2pQ'],
    ['starts with a dollar sign', '$ecretPass99'],
    ['starts with a brace', '{brace9wordXY'],
  ])('finds a token after --token that %s', (_what, value) => {
    expect(findCredentialShape(server('--token', value))).toBe('named-secret');
    expect(findCredentialShape(`run --token ${value}\n`)).toBe('named-secret');
    expect(findCredentialShape(`run --token=${value}\n`)).toBe('named-secret');
  });

  it.each([
    ['starts with a slash', '/Kx9aB3dE5fG7hJ+/mN2pQ'],
    ['starts with a dash', '-aB3dE5fG7hJ_mN2pQ'],
  ])('finds a bearer token that %s', (_what, value) => {
    expect(findCredentialShape(`Authorization: Bearer ${value}\n`)).toBe('named-secret');
    expect(findCredentialShape(json({ headers: { Authorization: `Bearer ${value}` } }))).toBe(
      'named-secret',
    );
  });

  it.each([
    ['a path in a home directory', '~/.keys/api'],
    ['an absolute path', '/etc/app/token'],
    ['a relative path', './token.txt'],
    ['a flag', '--verbose'],
    ['a short flag', '-v'],
    ['a variable', '$TOKEN'],
    ['a braced variable', '${API_TOKEN}'],
  ])('still leaves %s after --token alone', (_what, value) => {
    expect(findCredentialShape(server('--token', value))).toBeNull();
    expect(findCredentialShape(`run --token ${value}\n`)).toBeNull();
  });
});

describe('findCredentialShape: vendor tokens that core does not know', () => {
  // Built from parts, so that no token-shaped string is written out in this file.
  const fill = 'stroqfixture0123456789abcdef';
  const tokens: [string, string][] = [
    ['a Stripe live secret key', ['sk', 'live', fill].join('_')],
    ['a Stripe test secret key', ['sk', 'test', fill].join('_')],
    ['a Stripe restricted key', ['rk', 'live', fill].join('_')],
    ['a GitLab personal access token', `glpat-${fill}`],
    ['a SendGrid key', `SG.${fill}.${fill}`],
    ['a Hugging Face token', `hf_${fill}${fill}`],
    ['a PyPI token', `pypi-AgEIcHlwaS5vcmc${fill}${fill}`],
    ['a DigitalOcean token', `dop_v1_${'0123456789abcdef'.repeat(4)}`],
    ['a Shopify token', `shpat_${'0123456789abcdef'.repeat(2)}`],
    ['a Google OAuth access token', `ya29.${fill}`],
    ['a Slack app token', `xapp-1-A0123456789-${fill}`],
    ['a Linear key', `lin_api_${fill}${fill}`],
    ['a Supabase token', `sbp_${'0123456789abcdef'.repeat(2)}01234567`],
  ];

  it.each(tokens)('finds %s under a name that says nothing', (_what, token) => {
    expect(findCredentialShape(json({ note: `value ${token}` }))).toBe('vendor-token');
    expect(findCredentialShape(json({ sauce: token }))).toBe('vendor-token');
    expect(findCredentialShape(`# remember: ${token}\n`)).toBe('vendor-token');
  });

  it.each([
    ['a word that starts the same way', 'sk_liveness_probe_endpoint'],
    ['a short one', 'glpat-short'],
    ['a Stripe publishable key, which is public', ['pk', 'live', fill].join('_')],
  ])('leaves %s alone', (_what, value) => {
    expect(findCredentialShape(json({ note: value }))).toBeNull();
  });
});
