import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DESTRUCTIVE,
  EVAL_DYNAMIC,
  GH_REPO_CREATE_PUSH,
  PUSH_EXTERNAL,
  SECRET_PATTERNS,
  SHELL_PROC_SUB_REMOTE,
  SSH_TARGET,
} from '../../src/actions/classify-bash.js';
import { PS_ENCODED_COMMAND, PS_LOLBIN_FETCH } from '../../src/actions/classify-powershell.js';
import { followedBy, type TextTest } from '../../src/actions/followed-by.js';
import { GIT_CONFIG_READ, GIT_CONFIG_WRITE, GIT_DASH_C } from '../../src/actions/git-exec.js';
import { SELF_CONFIG_FILE } from '../../src/actions/self-config.js';

/**
 * Each linear test next to the pattern it replaced, copied here verbatim as the
 * oracle: the replacement has to agree with it on every input, not just on the
 * examples that motivated it.
 */
const ORACLES: ReadonlyArray<readonly [string, TextTest, RegExp]> = [
  ['EVAL_DYNAMIC', EVAL_DYNAMIC, /\beval\b[^\n]*(\$\(|`|\$\{?\w)/],
  [
    'SHELL_PROC_SUB_REMOTE',
    SHELL_PROC_SUB_REMOTE,
    /\b(bash|sh|zsh|dash|ksh|source|\.)\b[^\n]*<\(\s*(curl|wget)\b/,
  ],
  [
    'PUSH_EXTERNAL',
    PUSH_EXTERNAL,
    /\bgit\s+(push\b[^\n]*\b(https?:\/\/|git@|ssh:\/\/)|remote\s+(add|set-url)\b)/,
  ],
  ['GH_REPO_CREATE_PUSH', GH_REPO_CREATE_PUSH, /\bgh\s+repo\s+create\b[^\n]*--push\b/],
  ['GIT_CONFIG_WRITE', GIT_CONFIG_WRITE, /\bgit\b[^\n]*?\bconfig\b/i],
  [
    'GIT_CONFIG_READ',
    GIT_CONFIG_READ,
    /\bconfig\b[^\n]*\s--(get|get-all|get-regexp|list|name-only)\b/i,
  ],
  ['GIT_DASH_C', GIT_DASH_C, /\bgit\s+(?:\S+\s+)*?-c\s*[\w.-]+=/i],
  [
    'PS_LOLBIN_FETCH',
    PS_LOLBIN_FETCH,
    /\bcertutil\b[^\n]*-urlcache\b|\bbitsadmin\b[^\n]*\/transfer\b/i,
  ],
  [
    'PS_ENCODED_COMMAND',
    PS_ENCODED_COMMAND,
    /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*?\s-e(?:c|nc|ncodedcommand)?\s+\S/i,
  ],
];

/**
 * The `DESTRUCTIVE` rows that used `[^\n]*`, by position. A reordered table fails
 * here loudly, since each row is compared with a pattern it does not stand for.
 */
const DESTRUCTIVE_ORACLES: ReadonlyArray<readonly [number, RegExp]> = [
  [4, /\bgit\s+push\b[^\n]*(--force|\s-f\b)/],
  [8, /\bdd\b[^\n]*\bof=\/dev\/(?!null\b|zero\b)/],
  [14, /\b(terraform|tofu)\s+(destroy\b|apply\b[^\n]*\s-destroy(?:=(?:1|t|true))?(?![\w=-]))/i],
  [16, /\bdrizzle-kit\s+push\b[^\n]*--force(?![\w-])/],
  [18, /\bprisma\s+db\s+push\b[^\n]*--(force-reset|accept-data-loss)\b/],
  [19, /\bsupabase\s+db\s+reset\b[^\n]*--(linked|db-url)\b/],
];

/**
 * Fragments every pattern above is made of, plus the characters that sit between
 * them, so generated text is dense with near-misses: a head with the wrong
 * spacing, a tail on the next line, a tail before its head.
 */
const FRAGMENTS = [
  ' ',
  '  ',
  '\t',
  '\n',
  '\r',
  'x',
  'a.b',
  '.',
  '-',
  '--',
  '=',
  '/',
  '\\',
  '@',
  '"',
  "'",
  ';',
  '|',
  '(',
  ')',
  '$(',
  '`',
  '${',
  '$x',
  'eval',
  'bash',
  'sh',
  'source',
  'zsh',
  '<(',
  'curl',
  'wget',
  'git',
  'GIT',
  'push',
  'remote',
  'add',
  'set-url',
  'https://',
  'git@',
  'ssh://',
  'gh',
  'repo',
  'create',
  '--push',
  'config',
  '--get',
  '--list',
  '-c',
  '-C',
  'core.x=',
  'k=',
  'certutil',
  '-urlcache',
  'bitsadmin',
  '/transfer',
  'powershell',
  'pwsh',
  '.exe',
  '-e',
  '-enc',
  '-ec',
  '--force',
  '-f',
  'dd',
  'of=/dev/',
  'null',
  'sda',
  'terraform',
  'tofu',
  'apply',
  'destroy',
  '-destroy',
  '-destroy=true',
  '-destroy=false',
  'drizzle-kit',
  'prisma',
  'db',
  '--force-reset',
  'supabase',
  'reset',
  '--linked',
  '/proc/',
  '/environ',
  '1',
];

const text = fc
  .array(fc.constantFrom(...FRAGMENTS), { maxLength: 24 })
  .map((parts) => parts.join(''));

describe('followedBy and the patterns it replaced', () => {
  it.each(ORACLES)('%s agrees with its old pattern on every input', (_name, linear, oracle) => {
    fc.assert(
      fc.property(text, (t) => linear.test(t) === oracle.test(t)),
      { numRuns: 3_000 },
    );
  });

  it.each(DESTRUCTIVE_ORACLES)('DESTRUCTIVE row %i agrees with its old pattern', (row, oracle) => {
    const linear = DESTRUCTIVE[row]?.[0];
    expect(linear).toBeDefined();
    fc.assert(
      fc.property(text, (t) => linear?.test(t) === oracle.test(t)),
      { numRuns: 3_000 },
    );
  });

  it('keeps the /proc environ secret pattern, and the signal name built from its source', () => {
    const oracle = /\/proc\/[^\s]*\/environ\b/;
    const linear = SECRET_PATTERNS.find((p) => p.source === oracle.source);
    expect(linear).toBeDefined();
    fc.assert(
      fc.property(text, (t) => linear?.test(t) === oracle.test(t)),
      { numRuns: 3_000 },
    );
  });

  it('finds the same hosts SSH_TARGET did', () => {
    const oracle = /\b[\w.-]+@([\w-]+(?:\.[\w-]+)+)/g;
    const hosts = (re: RegExp, t: string) => [...t.matchAll(re)].map((m) => m[1]);
    fc.assert(
      fc.property(text, (t) => {
        expect(hosts(SSH_TARGET, t)).toEqual(hosts(oracle, t));
      }),
      { numRuns: 3_000 },
    );
  });

  it('SELF_CONFIG_FILE agrees with its old /etc/windsurf branch', () => {
    const oracle =
      /(\.claude[/\\]+settings(\.local)?\.json|\.cursor[/\\]+hooks\.json|\.codex[/\\]+(hooks\.json|config\.toml)|\.github[/\\]+(hooks(?![\w.-])|copilot[/\\]+settings(\.local)?\.json)|\.copilot[/\\]+(hooks(?![\w.-])|settings\.json|config\.json)|\.openclaw[/\\]+(openclaw\.json|plugins(?![\w.-])|extensions(?![\w.-]))|(\.windsurf|\.codeium([/\\]+windsurf)?)[/\\]+hooks\.json|(?<![\w.-])[/\\]+etc[/\\]+windsurf[/\\]+hooks\.json|Application(?:\\ | )Support[/\\]+Windsurf[/\\]+hooks\.json|\.agents[/\\]+hooks\.json|\.gemini[/\\]+(config[/\\]+hooks\.json|antigravity-cli[/\\]+settings\.json)|(?<![\w.-])claude_desktop_config\.json|(?<![\w.-])mcp_config\.json|\.stroq([/\\]+|\b))/i;
    const paths = fc
      .array(
        fc.constantFrom('/', '\\', '//', 'etc', 'windsurf', 'hooks.json', 'x', '.', '-', ' '),
        {
          maxLength: 16,
        },
      )
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(paths, (t) => SELF_CONFIG_FILE.test(t) === oracle.test(t)),
      { numRuns: 3_000 },
    );
  });

  it('handles a head that spans a line break, and a tail that starts on one', () => {
    const push = followedBy(/\bgit\s+push\b/, /(--force|\s-f\b)/);
    // The second head starts inside the first line and ends on the next one.
    expect(push.test('git push a git\npush --force')).toBe(true);
    // `\s` in the tail may be the line break `[^\n]*` stopped at.
    expect(push.test('git push\n-f')).toBe(true);
    expect(push.test('git push x\n--force')).toBe(false);
  });
});
