import { describe, expect, it } from 'vitest';
import { describeSecretHit } from '../../src/secrets/describe.js';

describe('describeSecretHit', () => {
  it('names the secret and its source, never a value', () => {
    expect(
      describeSecretHit({
        name: 'aws_secret_access_key',
        source: '~/.aws/credentials',
        canary: false,
      }),
    ).toBe('the arguments contain the value of aws_secret_access_key from ~/.aws/credentials.');
    expect(describeSecretHit({ name: 'STROQ_CANARY_KEY', source: 'canary', canary: true })).toBe(
      'the arguments contain the value of STROQ_CANARY_KEY, a Stroq canary; the session is now marked suspect.',
    );
  });
});
