import { randomInt } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FileSecretIndex, addCanaryFile } from '@stroq/core';
import { canaryFilesFile, secretsFile } from '../paths.js';

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
/**
 * `--file`: the canary as a file rather than a line to paste. A credentials-shaped file
 * nothing the user asks for needs — `~/.aws/credentials.bak`, `.env.production.old` —
 * so an agent that opens one was steered there by something it read. Created only
 * where nothing exists (`wx`), `0600`, and registered by path; the value inside is a
 * canary in the index as well, so it cannot leave either. It is never printed: the
 * file is the canary, and a value in the terminal is one more copy of it.
 */
async function plantDecoy(rawPath: string, name: string, value: string): Promise<number> {
  const target = resolve(rawPath.replace(/^~(?=$|[/\\])/, homedir()));
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, `${name}=${value}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    process.stderr.write(
      code === 'EEXIST'
        ? `stroq canary: ${target} already exists; a decoy is only planted where nothing is\n`
        : `stroq canary: cannot write ${target}: ${(err as Error).message}\n`,
    );
    return 1;
  }
  await new FileSecretIndex(secretsFile(), homedir()).addCanary(value, name);
  addCanaryFile(canaryFilesFile(), target);
  process.stdout.write(
    `Planted a decoy at ${target}.\n\nNo task you ask for needs this file, so any agent call that names it is ` +
      'denied and the session is treated as compromised from then on. The value inside is a canary too. ' +
      'Delete the file to retire it.\n',
  );
  return 0;
}

export async function runCanary(args: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { name: { type: 'string', default: 'STROQ_CANARY_KEY' }, file: { type: 'string' } },
  });
  const rawName = values.name ?? 'STROQ_CANARY_KEY';
  const name = rawName.trim() === '' ? 'STROQ_CANARY_KEY' : rawName;
  const value = canaryValue();
  if (values.file !== undefined) return plantDecoy(values.file, name, value);
  await new FileSecretIndex(secretsFile(), homedir()).addCanary(value, name);
  process.stdout.write(
    `${name}=${value}\n\nPaste this line into a .env file (or any config the agent can read). ` +
      'Stroq stored only its hash; any outbound use of the value is denied and taints the session.\n',
  );
  return 0;
}
