import { join } from 'node:path';
import type { JsonEdit } from '../types.js';
import { CLAUDE_READ_DENY_RULES } from './credential-paths.js';
import type { Recipe, RecipeContext, RecipeTarget } from './types.js';

/**
 * R1, `claude-read-deny`: asks Claude Code itself to refuse to read credential files, by adding read
 * rules to the `permissions.deny` list of its settings.
 *
 * What was measured, on Claude Code 2.1.271 with the made-up key of a throwaway `.env` and rules in the
 * three spellings `Read(./.env)`, `Read(.env)` and `Read(<absolute path>)`: the Read tool was refused
 * ("Permission to read ... has been denied"), and so was a plain `cat <absolute path>` through the Bash
 * tool; the key was in neither stream. It was not separated which of the three rules matched the Bash
 * case. So the claim is the narrow one below: the host refuses its Read tool and the simple shell readers
 * it recognises, as a filter of its own. It is not an OS boundary, and the text says so.
 *
 * `~/.claude/settings.json` is the user's. `<project>/.claude/settings.local.json` is the project's file
 * for one person's own settings, the one a team does not share, so a rule written there is this user's
 * protection and not a change to what the repository tells everyone else's Claude Code to do.
 */

const DENY_PATH = ['permissions', 'deny'] as const;
const NEW_SETTINGS_MODE = 0o600;

const LIMITS: readonly string[] = [
  'Claude Code will then refuse to read these files with its Read tool, and with the simple shell readers it recognises, such as cat.',
  'This is a filter inside Claude Code, a best effort and not a guarantee: a program that reads the file itself, such as python -c, is not covered.',
  'Only an operating system sandbox covers that; stroq run --sandbox starts an agent inside one.',
  'The two project rules name the .env files at the top of the folder Claude Code is started in; Stroq has not checked whether Claude Code also applies them to a .env in a subfolder.',
  'The rule for .env.* also covers .env.example, because a deny rule cannot say "all but".',
  'Rules the file already has are kept as they are, and undo never removes one of them.',
];

/** The lines to add by hand, as a fragment that fits inside the braces of a settings file. */
const SNIPPET = [
  '"permissions": {',
  '  "deny": [',
  CLAUDE_READ_DENY_RULES.map((rule) => `    ${JSON.stringify(rule)}`).join(',\n'),
  '  ]',
  '}',
].join('\n');

const EDITS: readonly JsonEdit[] = CLAUDE_READ_DENY_RULES.map((value) => ({
  kind: 'json-array-add',
  path: [...DENY_PATH],
  value,
}));

function target(context: RecipeContext): RecipeTarget {
  const user = context.scope === 'user';
  return {
    recipe: 'claude-read-deny',
    agent: 'claude-code',
    scope: context.scope,
    file: user
      ? join(context.home, '.claude', 'settings.json')
      : join(context.cwd, '.claude', 'settings.local.json'),
    root: user ? context.home : context.cwd,
    items: CLAUDE_READ_DENY_RULES,
    change: { kind: 'json', edits: EDITS, snippet: SNIPPET },
    newFileMode: NEW_SETTINGS_MODE,
    limits: LIMITS,
    unverified: null,
  };
}

export const claudeReadDeny: Recipe = {
  name: 'claude-read-deny',
  agent: 'claude-code',
  scopes: ['user', 'project'],
  defaultScope: 'user',
  summary: 'ask Claude Code to refuse to read credential files',
  target,
};
