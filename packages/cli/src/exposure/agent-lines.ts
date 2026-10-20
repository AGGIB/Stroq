import { digestOf, hit, type AgentHit } from './agent-kinds.js';

/**
 * Files that are not agent configs, whose lines a change can use to bring what an agent runs
 * without a config showing it: a `.gitattributes` line that has a checkout write other text than
 * git holds (a filter such as Git LFS, an encoding), and the line of an npm, yarn or bun config
 * that names the registry packages come from, so the next `npx` or install in the folder runs
 * other code. Each line is a hit of its own, compared with the base by its value.
 *
 * Every step is a split or one pass over a line, so the work is linear in the text.
 */

/** The most lines of one file reported; past it, one more hit says how many were left out. */
const MAX_LINES = 64;
/** The most characters of one line kept as a value. */
const LINE_MAX = 512;

type LineRule = (line: string) => AgentHit | undefined;

/** The name of the file a rule reads, in lower case, and the rule. */
const RULES: ReadonlyMap<string, (path: string) => LineRule> = new Map([
  ['.gitattributes', checkoutFilter],
  ['.npmrc', registry],
  ['.yarnrc', registry],
  ['.yarnrc.yml', registry],
  ['.yarnrc.yaml', registry],
  ['bunfig.toml', registry],
]);

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** Whether the lines of this file are read for what they change. */
export const isLineFile = (path: string): boolean => RULES.has(baseName(path).toLowerCase());

/** Attributes that make a checkout write other text than the blob git holds. */
const REWRITES = /^(?:filter|working-tree-encoding)(?:=|$)/i;

/**
 * A `.gitattributes` line that sets a filter or an encoding, for any pattern, or defines a macro
 * that does: a coarse reading, since which paths a pattern matches is not worked out here.
 */
function checkoutFilter(path: string): LineRule {
  return (line) => {
    const words = line.split(/\s+/).filter((w) => w !== '');
    if (!words.slice(1).some((w) => REWRITES.test(w))) return undefined;
    return hit('unreadable-config', path, 1, 'checkout filter', bounded(line));
  };
}

/**
 * A line of a package manager's config that names a registry or an address: `registry=`,
 * `@scope:registry=`, `npmRegistryServer:`, a scope table of bunfig. Only the key is kept, with a
 * digest of the line: the rest of the line can hold a token.
 */
function registry(path: string): LineRule {
  return (line) => {
    if (!/registry/i.test(line) && !line.includes('://')) return undefined;
    return hit(
      'agent-api-redirect',
      path,
      1,
      'package registry',
      `${keyOf(line)} ${digestOf(line)}`,
    );
  };
}

/** The key of a config line: what comes before `=`, `: ` or a blank, cut short. */
function keyOf(line: string): string {
  const ends = [line.indexOf('='), line.indexOf(': '), line.search(/\s/)].filter((i) => i > 0);
  const end = ends.length === 0 ? line.length : Math.min(...ends);
  const key = line.slice(0, Math.min(end, 64));
  // A key with no `=` after it could be the token itself: only its length is kept then.
  return line.includes('=') || line.includes(':') ? key : `(${key.length} characters)`;
}

const bounded = (line: string): string =>
  line.length <= LINE_MAX ? line : `${line.slice(0, LINE_MAX)}... (${digestOf(line)})`;

/** The hits of one file's lines, with the line each is on. */
export function lineHits(path: string, text: string): AgentHit[] {
  const rule = RULES.get(baseName(path).toLowerCase())?.(path);
  if (rule === undefined) return [];
  const hits: AgentHit[] = [];
  let left = 0;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) return;
    const found = rule(line);
    if (found === undefined) return;
    if (hits.length < MAX_LINES) hits.push({ ...found, line: i + 1 });
    else left += 1;
  });
  if (left > 0)
    hits.push(
      hit('unreadable-config', path, 1, 'lines', `${left} more such lines (${digestOf(text)})`),
    );
  return hits;
}
