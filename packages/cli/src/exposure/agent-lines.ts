import { createHmac, randomBytes } from 'node:crypto';
import { digestOf, hit, type AgentHit } from './agent-kinds.js';
import { foldName } from './git-dir-names.js';

/**
 * Files that are not agent configs, whose lines a change can use to bring what an agent runs
 * without a config showing it: a `.gitattributes` line that has a checkout write other text than
 * git holds (a filter such as Git LFS, an encoding), and any line of an npm, yarn or bun config,
 * which can name the registry packages come from, the shell scripts run in, code node preloads or
 * the program yarn itself is. Each line is a hit of its own, compared with the base by its value.
 *
 * Every step is a split or one pass over a line, so the work is linear in the text.
 */

/** The most lines of one file reported; past it, one more hit says how many were left out. */
const MAX_LINES = 64;
/** The most characters of one line kept as a value. */
const LINE_MAX = 512;

type LineRule = (line: string) => AgentHit | undefined;

/** The name of the file a rule reads, folded as a disk opens it, and the rule. */
const RULES: ReadonlyMap<string, (path: string) => LineRule> = new Map([
  ['.gitattributes', checkoutFilter],
  ['.npmrc', setting],
  ['.yarnrc', setting],
  ['.yarnrc.yml', setting],
  ['.yarnrc.yaml', setting],
  ['bunfig.toml', setting],
]);

/** The name a rule is chosen by: the last part of the path, folded as the most forgiving disk opens it. */
const ruleName = (path: string): string => foldName(path.slice(path.lastIndexOf('/') + 1));

/** Whether the lines of this file are read for what they change. */
export const isLineFile = (path: string): boolean => RULES.has(ruleName(path));

/** The configs of npm, yarn and bun, by the name a disk opens them as. */
const PACKAGE_CONFIGS: ReadonlySet<string> = new Set([
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.yarnrc.yaml',
  'bunfig.toml',
]);

/**
 * Whether a path is the config of a package manager. A change to one fails as a whole, whatever
 * byte it is (see `agent-git.ts`); on disk, each line but a comment is an error.
 */
export const isPackageConfig = (path: string): boolean => PACKAGE_CONFIGS.has(ruleName(path));

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
 * A key for this run only: the value of a package manager's line is a digest under it, so two
 * revisions compare within one check, while nothing printed can be matched with a guessed line
 * elsewhere. Such a line can hold a token.
 */
const RUN_KEY = randomBytes(32);
export const keyed = (text: string): string =>
  `keyed:${createHmac('sha256', RUN_KEY).update(text).digest('hex').slice(0, 16)}`;

/** What a package manager's line is called: no word of the line itself is ever shown. */
export const PACKAGE_SETTING = 'package manager setting';
/** What a package manager's whole config is called, when a change adds, edits or deletes it. */
export const PACKAGE_CONFIG = 'package manager config';

/**
 * Any line of a package manager's config: none of its keys is harmless enough to pass unread
 * (`registry`, `script-shell`, `node-options`, `yarnPath`, `plugins`, `preload` all run or fetch
 * other code), and a line that does not parse is read the same way.
 */
function setting(path: string): LineRule {
  return (line) => hit('agent-api-redirect', path, 1, PACKAGE_SETTING, keyed(line));
}

const bounded = (line: string): string =>
  line.length <= LINE_MAX ? line : `${line.slice(0, LINE_MAX)}... (${digestOf(line)})`;

/**
 * What makes a package manager's lines other than these: a carriage return that ends no line, which
 * npm, yarn and bun read as the end of one, a NUL, another control byte, or a byte that was not
 * UTF-8. A file that holds one fails as a whole.
 */
const HIDDEN_BREAK = /\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffd]/;

/** The files whose lines a `;` makes a comment of: the ini ones. YAML and TOML read it as text. */
const SEMICOLON_COMMENTS: ReadonlySet<string> = new Set(['.npmrc', '.yarnrc']);

/** The hits of one file's lines, with the line each is on. */
export function lineHits(path: string, text: string): AgentHit[] {
  const name = ruleName(path);
  const rule = RULES.get(name)?.(path);
  if (rule === undefined) return [];
  const isPackage = PACKAGE_CONFIGS.has(name);
  if (isPackage && HIDDEN_BREAK.test(text))
    return [
      hit(
        'unreadable-config',
        path,
        1,
        'lines',
        'it holds a carriage return that ends no line, a NUL or another control byte, which its program may read as another line (its text is not shown)',
      ),
    ];
  const semicolon = SEMICOLON_COMMENTS.has(name);
  const hits: AgentHit[] = [];
  let left = 0;
  text.split(isPackage ? /\r\n|\r|\n/ : '\n').forEach((raw, i) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || (semicolon && line.startsWith(';'))) return;
    const found = rule(line);
    if (found === undefined) return;
    if (hits.length < MAX_LINES) hits.push({ ...found, line: i + 1 });
    else left += 1;
  });
  if (left > 0) {
    const all = name === '.gitattributes' ? digestOf(text) : keyed(text);
    hits.push(hit('unreadable-config', path, 1, 'lines', `${left} more such lines (${all})`));
  }
  return hits;
}
