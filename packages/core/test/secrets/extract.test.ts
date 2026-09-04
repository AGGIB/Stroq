import { describe, expect, it } from 'vitest';
import {
  MIN_SECRET_LENGTH,
  extractDockerAuths,
  extractEnv,
  extractKeyValues,
  extractNetrc,
  isSecretValue,
  looksLikeToken,
} from '../../src/secrets/extract.js';

const names = (list: readonly { name: string }[]): string[] => list.map((e) => e.name);

describe('isSecretValue / looksLikeToken', () => {
  it('requires MIN_SECRET_LENGTH chars, no whitespace, no placeholder, no path', () => {
    expect(MIN_SECRET_LENGTH).toBe(12);
    expect(isSecretValue('short')).toBe(false);
    expect(isSecretValue('has a space in it')).toBe(false);
    expect(isSecretValue('<your-secret-here>')).toBe(false);
    expect(isSecretValue('${SECRET_FROM_VAULT}')).toBe(false);
    expect(isSecretValue('changeme-please-now')).toBe(false);
    expect(isSecretValue('/etc/ssl/private/key.pem')).toBe(false);
    expect(isSecretValue('./relative/path/x')).toBe(false);
    expect(isSecretValue('~/.ssh/id_rsa_backup')).toBe(false);
    expect(isSecretValue('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe(true);
  });
  it('recognises vendor token shapes', () => {
    expect(looksLikeToken('ghp_abcdefghijklmnopqrstuvwxyz1234')).toBe(true);
    expect(looksLikeToken('AKIAIOSFODNN7EXAMPLE')).toBe(true);
    expect(looksLikeToken('sk-abcdefghijklmnop1234')).toBe(true);
    expect(looksLikeToken('npm_abcdefghijklmnopqrstuvwxyz')).toBe(true);
    expect(
      looksLikeToken('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop'),
    ).toBe(true);
    expect(looksLikeToken('awesome-widgets-app')).toBe(false);
  });
  it('rejects locations: URLs, localhost, cookie domains, hostnames and host:port', () => {
    expect(isSecretValue('http://localhost:3000')).toBe(false);
    expect(isSecretValue('https://dev-abc.us.auth0.com')).toBe(false);
    expect(isSecretValue('postgres://user:pw@db.internal:5432/app')).toBe(false);
    expect(isSecretValue('localhost:5432')).toBe(false);
    expect(isSecretValue('.staging.example.com')).toBe(false);
    expect(isSecretValue('api.staging.example.com')).toBe(false);
    expect(isSecretValue('api.staging.example.com:8443')).toBe(false);
    // A vendor-shaped token is a credential whatever else it resembles.
    expect(isSecretValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop')).toBe(
      true,
    );
    expect(isSecretValue('demo_secret_value_1234567890abcdef')).toBe(true);
  });
});

describe('extractKeyValues', () => {
  const dotenv = [
    '# comment',
    'PORT=3000',
    'APP_NAME=awesome-widgets-app',
    'API_KEY="sk-abcdefghijklmnop1234"',
    "DB_PASSWORD='p@ssw0rd-1234567'",
    'export SECRET_TOKEN=abcdefghijklmnopqrstu # trailing comment',
    'KEY_PATH=/etc/ssl/private/key.pem',
    'PLACEHOLDER_SECRET=<your-secret-here>',
    'DEPLOY=ghp_abcdefghijklmnopqrstuvwxyz1234',
    'STROQ_CANARY_KEY=stroq_canary_0123456789abcdefghijkl',
    '',
  ].join('\n');

  it('keeps credential-named or token-shaped values, drops short, placeholder and path values', () => {
    const found = extractKeyValues(dotenv);
    expect(names(found)).toEqual([
      'API_KEY',
      'DB_PASSWORD',
      'SECRET_TOKEN',
      'DEPLOY',
      'STROQ_CANARY_KEY',
    ]);
    expect(found.find((e) => e.name === 'API_KEY')?.value).toBe('sk-abcdefghijklmnop1234');
    expect(found.find((e) => e.name === 'DB_PASSWORD')?.value).toBe('p@ssw0rd-1234567');
    expect(found.find((e) => e.name === 'SECRET_TOKEN')?.value).toBe('abcdefghijklmnopqrstu');
    expect(found.find((e) => e.name === 'STROQ_CANARY_KEY')?.canary).toBe(true);
    expect(found.filter((e) => e.canary)).toHaveLength(1);
  });

  it('parses ini-style AWS credentials and npmrc auth tokens', () => {
    const aws = [
      '[default]',
      'aws_access_key_id = AKIAIOSFODNN7EXAMPLE',
      'aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      'region = eu-central-1',
    ].join('\n');
    expect(names(extractKeyValues(aws))).toEqual(['aws_access_key_id', 'aws_secret_access_key']);
    const npmrc = [
      'registry=https://registry.npmjs.org/',
      '//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz',
    ].join('\n');
    expect(extractKeyValues(npmrc)).toEqual([
      {
        name: '//registry.npmjs.org/:_authToken',
        value: 'npm_abcdefghijklmnopqrstuvwxyz',
        canary: false,
      },
    ]);
  });

  it('ignores commented lines and lines without an equals sign', () => {
    expect(extractKeyValues('; API_KEY=abcdefghijklmnop\nAPI_KEY abcdefghijklmnop\n')).toEqual([]);
  });

  it('strips an inline comment introduced by a tab as well as by a space', () => {
    const found = extractKeyValues('API_KEY=abcdefghijklmnopqrstu\t# tab-introduced comment\n');
    expect(found[0]?.value).toBe('abcdefghijklmnopqrstu');
  });

  it('indexes only the real credential in a realistic Next.js/Auth0 .env', () => {
    const dotenv = [
      'NEXTAUTH_URL=http://localhost:3000',
      'AUTH0_ISSUER_BASE_URL=https://dev-abc.us.auth0.com',
      'SESSION_COOKIE_DOMAIN=.staging.example.com',
      'API_KEY_HEADER_NAME=x-api-key-header',
      'AUTH0_CLIENT_SECRET=stroq_test_client_secret_0123456789',
      'DATABASE_URL=postgres://user:stroq_test_pw_0123456789@db.internal:5432/app',
    ].join('\n');
    // Documented v1 limit: a connection URL is skipped whole, so the password
    // inside `DATABASE_URL` is not indexed.
    expect(names(extractKeyValues(dotenv))).toEqual(['AUTH0_CLIENT_SECRET']);
  });

  it('keeps the demo key indexable', () => {
    expect(names(extractKeyValues('DEMO_API_KEY=demo_secret_value_1234567890abcdef\n'))).toEqual([
      'DEMO_API_KEY',
    ]);
  });
});

describe('extractNetrc', () => {
  it('pairs passwords with their machine and skips short ones', () => {
    const text = [
      'machine api.github.com',
      '  login me',
      '  password ghp_0123456789abcdefghijklmnop',
      'default login anonymous password guest',
    ].join('\n');
    expect(extractNetrc(text)).toEqual([
      { name: 'password (api.github.com)', value: 'ghp_0123456789abcdefghijklmnop', canary: false },
    ]);
  });
});

describe('extractDockerAuths', () => {
  it('indexes the base64 auth blob and the password inside it', () => {
    const auth = Buffer.from('me:ghp_0123456789abcdefghijklmnop').toString('base64');
    const text = JSON.stringify({ auths: { 'ghcr.io': { auth } } });
    expect(extractDockerAuths(text)).toEqual([
      { name: 'docker auth (ghcr.io)', value: auth, canary: false },
      { name: 'docker password (ghcr.io)', value: 'ghp_0123456789abcdefghijklmnop', canary: false },
    ]);
    expect(extractDockerAuths('{not json')).toEqual([]);
    expect(extractDockerAuths('{"auths": 5}')).toEqual([]);
  });
});

describe('extractEnv', () => {
  it('keeps credential-named or token-shaped variables, skips paths and identifier-like names', () => {
    const env = {
      GITHUB_TOKEN: 'ghp_0123456789abcdefghijklmnop',
      SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.x/Listeners',
      HOME: '/Users/me',
      TERM: 'xterm-256color',
      SESSION_ID: 'abcdefghijklmnop',
      AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
      STROQ_CANARY_KEY: 'stroq_canary_0123456789abcdefghijkl',
      EMPTY_SECRET: undefined,
    };
    const found = extractEnv(env);
    expect(names(found)).toEqual(['GITHUB_TOKEN', 'AWS_ACCESS_KEY_ID', 'STROQ_CANARY_KEY']);
    expect(found.find((e) => e.name === 'STROQ_CANARY_KEY')?.canary).toBe(true);
  });
});

describe('size caps', () => {
  it('drops secrets past MAX_LINES but keeps ones before the cutoff', () => {
    const lines = Array.from({ length: 6000 }, (_, i) => {
      if (i === 0) return 'EARLY_SECRET_KEY=abcdefghijklmnopqrstuvwxyz';
      if (i === 5499) return 'LATE_SECRET_KEY=abcdefghijklmnopqrstuvwxyz';
      return `FILLER_${i}=x`;
    });
    const found = extractKeyValues(lines.join('\n'));
    expect(names(found)).toContain('EARLY_SECRET_KEY');
    expect(names(found)).not.toContain('LATE_SECRET_KEY');
  });

  it('cuts an oversized line at MAX_LINE_CHARS before parsing its value', () => {
    const name = 'LONG_SECRET_KEY';
    const line = `${name}=${'a'.repeat(5000)}`;
    const found = extractKeyValues(line);
    const entry = found.find((e) => e.name === name);
    expect(entry?.value.length).toBe(4096 - `${name}=`.length);
  });

  it('bounds extractNetrc cost and output on pathological input', () => {
    const text = `machine x password ${'p'.repeat(20)} ${'x '.repeat(200_000)}`;
    const start = performance.now();
    const found = extractNetrc(text);
    expect(performance.now() - start).toBeLessThan(500);
    expect(found).toHaveLength(1);
  });

  it('bounds extractDockerAuths cost and fails safe on truncated JSON', () => {
    const text = `{"auths":{"a":{"auth":"${'A'.repeat(400_000)}"}}}`;
    const start = performance.now();
    const found = extractDockerAuths(text);
    expect(performance.now() - start).toBeLessThan(500);
    expect(found).toEqual([]);
  });

  it('caps extractEnv values at MAX_LINE_CHARS before classifying', () => {
    // 'k' avoids the PLACEHOLDER `xxx+` branch that a repeated 'x' value would trip.
    const found = extractEnv({ BIG_TOKEN: 'k'.repeat(10_000) });
    expect(found).toHaveLength(1);
    expect(found[0]?.value.length).toBeLessThanOrEqual(4096);
  });
});
