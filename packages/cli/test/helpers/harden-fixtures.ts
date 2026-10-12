import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readManifest, type ManifestEntry } from '../../src/harden/manifest.js';
import { CLAUDE_READ_DENY_RULES } from '../../src/harden/recipes/credential-paths.js';
import { fakeEnv } from '../harden/helpers.js';

/** What the command makes of a settings file that is not there, written out in full. */
export const GOLDEN_SETTINGS = `{
  "permissions": {
    "deny": [
${CLAUDE_READ_DENY_RULES.map((rule) => `      ${JSON.stringify(rule)}`).join(',\n')}
    ]
  }
}
`;

/**
 * The path as the diff header writes it: slashes for separators and no slash in front, so that the line
 * is `+++ b/` and this, on every platform (`/tmp/x` gives `tmp/x`, `C:\\Users\\x` gives `C:/Users/x`).
 */
export const diffLabel = (path: string): string => path.replace(/\\/g, '/').replace(/^\/+/, '');

/** A JSON settings file as an editor writes it. */
export const settingsText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export const bytesOf = (path: string): string => readFileSync(path, 'utf8');

/** The records the command has kept for `real`, from the Stroq home `stroqHome`. */
export function recordsFor(stroqHome: string, real: string): readonly ManifestEntry[] {
  const files = readManifest(fakeEnv(stroqHome)).files;
  return Object.hasOwn(files, real) ? (files[real] ?? []) : [];
}
