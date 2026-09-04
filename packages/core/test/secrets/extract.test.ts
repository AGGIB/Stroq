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
