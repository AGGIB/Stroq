import { randomInt } from 'node:crypto';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { FileSecretIndex } from '@stroq/core';
import { secretsFile } from '../paths.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CANARY_LENGTH = 32;

/**
 * `randomInt` rather than a random byte modulo 62: 256 is not a multiple of 62, so
 * the modulo made the first eight letters a quarter more likely than the rest.
 */
export function canaryValue(): string {
  const chars = Array.from({ length: CANARY_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return `stroq_canary_${chars.join('')}`;
}

/**
 * Prints a canary secret to plant in a .env file or any config the agent can
 * read. Only its salted hash is stored; using the value in an outbound call is
 * denied and marks the session suspect.
 */
export async function runCanary(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { name: { type: 'string', default: 'STROQ_CANARY_KEY' } },
  });
  const rawName = values.name ?? 'STROQ_CANARY_KEY';
  const name = rawName.trim() === '' ? 'STROQ_CANARY_KEY' : rawName;
  const value = canaryValue();
  await new FileSecretIndex(secretsFile(), homedir()).addCanary(value, name);
  process.stdout.write(
    `${name}=${value}\n\nPaste this line into a .env file (or any config the agent can read). ` +
      'Stroq stored only its hash; any outbound use of the value is denied and taints the session.\n',
  );
  return 0;
}
