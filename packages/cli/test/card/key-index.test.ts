import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { indexDigest, newSalt, prepareIndex, type KeyIndexData } from '../../src/card/key-index.js';
import type { Key } from '../../src/sent/keys.js';

/** Every value is made up. */
const AWS = 'FAKEawsSecretValue0123456789abcdefABCDEF';
const STRIPE = 'sk_FAKEprojectStripe0123456789abcdef';
const TOKEN = 'ghp_FAKEtoken0123456789abcdefghijklmnop';

const keys = (): Key[] => [
  { name: 'aws_secret_access_key', source: '~/.aws/credentials', value: AWS },
  { name: 'STRIPE_SECRET_KEY', source: '~/shop/.env', value: STRIPE },
  { name: 'GITHUB_TOKEN', source: 'env', value: TOKEN },
];
const data = (over: Partial<KeyIndexData> = {}): KeyIndexData => ({
  home: '/home/dev',
  keys: keys(),
  mcp: [['github', { remote: true, host: 'api.githubcopilot.com' }]],
  ...over,
});
const SALT = '00112233445566778899aabbccddeeff';
const digestOf = (d: KeyIndexData, salt = SALT): string => indexDigest(prepareIndex(d), salt);

describe('the digest of the key index', () => {
  it('is 64 hexadecimal characters and the same for the same index and salt', () => {
    expect(digestOf(data())).toMatch(/^[0-9a-f]{64}$/);
    expect(digestOf(data())).toBe(digestOf(data()));
  });

  it('does not depend on the order the key files were read in', () => {
    expect(digestOf(data({ keys: [...keys()].reverse() }))).toBe(digestOf(data()));
  });

  it('does not depend on the order of the places a key was also read', () => {
    const a = keys().map((k) => (k.name === 'GITHUB_TOKEN' ? { ...k, alsoIn: ['x', 'y'] } : k));
    const b = keys().map((k) => (k.name === 'GITHUB_TOKEN' ? { ...k, alsoIn: ['y', 'x'] } : k));
    expect(digestOf(data({ keys: a }))).toBe(digestOf(data({ keys: b })));
  });

  it.each([
    [
      'a value',
      (k: Key[]) => k.map((x) => (x.name === 'GITHUB_TOKEN' ? { ...x, value: `${TOKEN}x` } : x)),
    ],
    [
      'a name',
      (k: Key[]) => k.map((x) => (x.name === 'GITHUB_TOKEN' ? { ...x, name: 'GH_TOKEN' } : x)),
    ],
    [
      'a source',
      (k: Key[]) => k.map((x) => (x.name === 'GITHUB_TOKEN' ? { ...x, source: '~/.env' } : x)),
    ],
    [
      'another place the key was read',
      (k: Key[]) => k.map((x) => (x.name === 'GITHUB_TOKEN' ? { ...x, alsoIn: ['~/.env'] } : x)),
    ],
    [
      'a canary mark',
      (k: Key[]) => k.map((x) => (x.name === 'GITHUB_TOKEN' ? { ...x, canary: true as const } : x)),
    ],
    [
      'a key added',
      (k: Key[]) => [
        ...k,
        { name: 'NEW_TOKEN', source: 'env', value: 'FAKEnewTokenValue0123456789abcdef' },
      ],
    ],
    ['a key taken away', (k: Key[]) => k.slice(1)],
  ])('changes when %s changes', (_what, change) => {
    expect(digestOf(data({ keys: change(keys()) }))).not.toBe(digestOf(data()));
  });

  it('changes when the home folder or an MCP server changes', () => {
    const base = digestOf(data());
    expect(digestOf(data({ home: '/home/other' }))).not.toBe(base);
    expect(digestOf(data({ mcp: [['github', { remote: false, host: null }]] }))).not.toBe(base);
    expect(digestOf(data({ mcp: [] }))).not.toBe(base);
  });

  it('changes with the salt, so that it cannot be compared from one cache to another', () => {
    expect(digestOf(data(), newSalt())).not.toBe(digestOf(data()));
    expect(newSalt()).toMatch(/^[0-9a-f]{32}$/);
    expect(newSalt()).not.toBe(newSalt());
  });

  it('holds no value, and no plain hash of one', () => {
    const digest = digestOf(data());
    const salt = SALT;
    for (const key of keys()) {
      expect(digest + salt).not.toContain(key.value);
      const plain = createHash('sha256').update(key.value).digest('hex');
      expect(digest + salt).not.toContain(plain);
      expect(digest + salt).not.toContain(plain.slice(0, 32));
    }
  });
});

describe('the numbers of the keys', () => {
  it('number each key the same whatever the order it was read in', () => {
    const forward = prepareIndex(data());
    const backward = prepareIndex(data({ keys: [...keys()].reverse() }));
    for (const key of keys()) {
      const a = forward.data.keys.findIndex((k) => k.value === key.value);
      const b = backward.data.keys.findIndex((k) => k.value === key.value);
      expect(forward.idOf[a]).toBe(backward.idOf[b]);
    }
  });

  it('are a way there and back', () => {
    const index = prepareIndex(data());
    index.data.keys.forEach((_, place) => {
      expect(index.indexOf[index.idOf[place] as number]).toBe(place);
    });
    expect([...index.idOf].sort()).toEqual(['0', '1', '2'].map(Number).sort());
  });
});
