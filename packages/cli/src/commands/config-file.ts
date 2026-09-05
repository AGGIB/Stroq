import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Seconds Stroq writes on every hook entry it installs, for either agent. */
export const HOOK_TIMEOUT_SECONDS = 15;

/** Reads an agent's JSON config. A missing or empty file is an empty object. */
export function readJsonObject<T extends object>(file: string): T {
  if (!existsSync(file)) return {} as T;
  const text = readFileSync(file, 'utf8');
  if (text.trim().length === 0) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`cannot parse ${file}: ${(err as Error).message}`, { cause: err });
  }
}

/** Writes an agent's JSON config with a trailing newline, creating its directory. */
export function writeJsonObject(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
