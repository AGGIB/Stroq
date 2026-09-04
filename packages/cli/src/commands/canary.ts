import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { FileSecretIndex } from '@stroq/core';
import { secretsFile } from '../paths.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function canaryValue(): string {
  const bytes = randomBytes(32);
  return `stroq_canary_${[...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('')}`;
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
  const name = values.name ?? 'STROQ_CANARY_KEY';
  const value = canaryValue();
  await new FileSecretIndex(secretsFile(), homedir()).addCanary(value, name);
  process.stdout.write(
    `${name}=${value}\n\nPaste this line into a .env file (or any config the agent can read). ` +
      'Stroq stored only its hash; any outbound use of the value is denied and taints the session.\n',
  );
  return 0;
}
