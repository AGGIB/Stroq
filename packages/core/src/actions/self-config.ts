/**
 * Self-tamper gate: classifies whether a shell segment touching Stroq's own
 * security config is a benign reference, an editor-style touch, or clear
 * write intent. Shared between the Bash classifier (classify-bash.ts) and
 * used to keep classify-tool.ts's MCP/Write/Edit path check aligned on the
 * same protected-file regex.
 */
import { commandWord } from './shell-segments.js';

/**
 * Protected agent-security files: the only paths whose write/edit/delete
 * makes a command or tool call `config.self`.
 *
 * Deliberately narrow to specific files, not the bare `.claude`/`.cursor`
 * directories: an earlier, wider version matched bare `.claude`, which
 * denied routine edits like `echo "# notes" > .claude/CLAUDE.md` or
 * `vim .claude/rules/style.md` — those files are not agent security config
 * and touching them is not self-tampering. `.stroq` stays a directory match
 * (`.stroq` or `.stroq/...`) since everything under it is Stroq's own state
 * (audit log, session data) and nothing else belongs there.
 * `.codex/config.toml` is listed alongside `.codex/hooks.json` because that file
 * can both define inline `[hooks]` tables and turn the whole hooks feature off,
 * so editing it disables the firewall just as surely as deleting the hook file.
 * Copilot's hooks live in a directory rather than one file — the CLI loads every
 * `.github/hooks/*.json` and `~/.copilot/hooks/*.json` independently — so those two
 * are matched as directory prefixes, and `.copilot/settings.json` is listed beside
 * them because `disableAllHooks: true` there turns the whole firewall off. The
 * `.github` alternatives require a literal `/hooks` or `/copilot` after the
 * directory name: `.github/workflows` is not agent security config, and
 * `api.github.com` is not a path at all.
 *
 * The two `hooks` directory alternatives end at `(?![\w.-])` rather than at `\b`,
 * so they match the directory (`.github/hooks`, `.github/hooks/stroq.json`,
 * `rm -rf .github/hooks && …`) but never a FILE whose name merely starts with it:
 * `.github/hooks.md` and `.github/hooks-README.md` are documentation, and denying
 * an edit to them is a false positive of the same kind the bare `.claude` match was.
 * OpenClaw is protected at three entries rather than as a whole directory:
 * `.openclaw/openclaw.json`, where `plugins.entries.stroq.enabled = false` switches
 * the firewall off, and the `plugins`/`extensions` directories a replacement plugin
 * would be dropped into. Everything else under `.openclaw` — agent instructions,
 * skills, memory — is ordinary work, and denying an edit to it would be the same
 * false positive the bare `.claude` match once was. Those two directory
 * alternatives end at `(?![\w.-])` for the same reason `.github/hooks` does, so
 * `.openclaw/plugins.md` is documentation while `rm -rf .openclaw/plugins && …`
 * is not.
 * Windsurf is protected at its hook FILE in all five locations Cascade merges: the
 * workspace file (`.windsurf/hooks.json`), both user files (`~/.codeium/windsurf/
 * hooks.json` for the IDE and `~/.codeium/hooks.json` for the JetBrains plugin, which
 * `init` does not write but a tainted agent must still not be able to edit), and the
 * Linux and macOS system files (`/etc/windsurf/hooks.json` and `…/Application
 * Support/Windsurf/hooks.json`). The capitalised `Windsurf` alternative is what
 * matches the macOS system path and, being case-sensitive, matches nothing in the
 * lowercase user paths. `.windsurf/rules/` and `.windsurf/workflows/` stay editable:
 * the match is on `hooks.json`, not on the directory, for exactly the reason the bare
 * `.claude` match was narrowed. The Windows system path uses backslashes and is not
 * matched; that is a stated limit, not an oversight.
 */
export const SELF_CONFIG_FILE =
  /(\.claude\/settings(\.local)?\.json|\.cursor\/hooks\.json|\.codex\/(hooks\.json|config\.toml)|\.github\/(hooks(?![\w.-])|copilot\/settings(\.local)?\.json)|\.copilot\/(hooks(?![\w.-])|settings\.json|config\.json)|\.openclaw\/(openclaw\.json|plugins(?![\w.-])|extensions(?![\w.-]))|(\.windsurf|\.codeium(\/windsurf)?|etc\/windsurf|Windsurf)\/hooks\.json|\.stroq(\/|\b))/;

/**
 * Bare protected directories (`.claude`, `.cursor`, `.stroq`) as their own
 * shell word. Deliberately NOT part of the general self-tamper gate above —
 * `cd .claude`, `tar czf backup.tgz .claude` or `vim .claude/CLAUDE.md` do
 * not mention a protected FILE and are not self-tampering. Used only by the
 * `find` write-intent check below, since `find`'s directory argument and a
 * `-name` filename argument are separate shell tokens, e.g.
 * `find .claude -name 'settings.json' -delete` never has the literal
 * substring `.claude/settings.json` anywhere in the command text.
 */
export const PROTECTED_DIRS =
  /\.(claude|cursor|codex|copilot|openclaw|stroq|windsurf|codeium|github\/(hooks|copilot))(\/|$|\s)/;

export const SELF_CONFIG_READ_COMMANDS = new Set([
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'grep',
  'rg',
  'jq',
  'diff',
  'stat',
  'ls',
  'wc',
  'bat',
  'file',
  'echo',
  'printf',
  'test',
  '[',
  'du',
  'find',
  'mkdir',
]);

// Writers/editors/deleters: mentioning the protected path alongside one of
// these command words is always write intent, regardless of `>`.
export const SELF_CONFIG_WRITE_COMMANDS = new Set([
  'rm',
  'mv',
  'cp',
  'tee',
  'sed',
  'sponge',
  'truncate',
  'chmod',
  'chown',
  'ln',
  'dd',
  'install',
  'touch',
  'shred',
]);

// Interpreters are write intent only when invoked with inline code
// (`-c`/`-e`, including combined short flags like `perl -pi -e` or
// `perl -pe`); a bare `python3 -m json.tool file` is not write intent.
const SELF_CONFIG_INTERPRETERS = new Set(['perl', 'python', 'python3', 'node', 'ruby']);
const GIT_WRITE_SUBCOMMAND = /^git\s+(checkout|restore|reset|clean|rm|stash)\b/;
const GIT_READ_SUBCOMMAND = /^git\s+(status|diff|log|show|add|blame)\b/;

// `find`'s own write/delete primaries, excluding `-exec`/`-execdir` (handled
// separately below, since those two run an arbitrary inner command whose own
// verb determines intent — see findExecIsWriteIntent).
const FIND_DELETE_PRIMARIES = /-(delete|ok|okdir|fprint|fprintf)\b/;
const FIND_EXEC_PRIMARY = /-exec(?:dir)?\s+(\S+)/;
// Writer/deleter verbs that make a `find ... -exec <verb> ...` write intent.
// A reader (`cat`, `grep`, `ls`, `head`, …) is not — `find . -exec cat {} \;`
// only reads the matched files. Kept aligned with SELF_CONFIG_WRITE_COMMANDS
// (`dd`, `install`, `touch`, `sponge` included below) so a writer that is
// unconditional at the top level is also unconditional as a `-exec` verb;
// `perl` stays here even though it is conditional (inline-code-only) at the
// top level, since `find`'s own gate has no equivalent way to see whether
// the inner `perl` invocation carries `-e`/`-pi`.
const FIND_EXEC_WRITE_WORDS = new Set([
  'rm',
  'mv',
  'cp',
  'tee',
  'sed',
  'perl',
  'chmod',
  'chown',
  'ln',
  'truncate',
  'shred',
  'dd',
  'install',
  'touch',
  'sponge',
]);
// `find ... -exec bash|sh|zsh -c '<code>' \;` runs an arbitrary inner shell
// script rather than a single known verb, so its write intent can't be read
// off of one command word the way `-exec rm {} \;` can. Treated as write
// intent unconditionally (the same conservative call `SHELL_C_REMOTE` makes
// for network detection in classify-bash.ts) rather than trying to parse the
// quoted script for its own verb.
const FIND_EXEC_SHELL_C = /-exec(?:dir)?\s+(?:bash|sh|zsh)\s+-c\b/;

function isInlineCodeToken(token: string): boolean {
  if (!/^-[A-Za-z]+$/.test(token)) return false;
  return /[ec]/.test(token.slice(1));
}

function hasInlineCode(segment: string): boolean {
  return segment.split(/\s+/).some(isInlineCodeToken);
}

function findExecIsWriteIntent(segment: string): boolean {
  if (FIND_EXEC_SHELL_C.test(segment)) return true;
  const match = FIND_EXEC_PRIMARY.exec(segment);
  if (!match) return false;
  const word = (match[1] ?? '').replace(/^.*\//, '');
  return FIND_EXEC_WRITE_WORDS.has(word);
}

function isFindWriteIntent(segment: string): boolean {
  if (FIND_DELETE_PRIMARIES.test(segment)) return true;
  return findExecIsWriteIntent(segment);
}

/**
 * True when `segment` mentions a protected path at all — either one of the
 * specific protected FILES (any command), or, for `find` only, a bare
 * protected DIRECTORY (since `find`'s write intent can apply to the whole
 * directory even when no protected filename is in the same token).
 */
function touchesSelfConfig(segment: string, word: string): boolean {
  if (SELF_CONFIG_FILE.test(segment)) return true;
  return word === 'find' && PROTECTED_DIRS.test(segment);
}

function isSelfConfigWriteIntent(segment: string, word: string): boolean {
  if (SELF_CONFIG_WRITE_COMMANDS.has(word)) return true;
  if (SELF_CONFIG_INTERPRETERS.has(word) && hasInlineCode(segment)) return true;
  if (segment.includes('>')) return true;
  if (word === 'git' && GIT_WRITE_SUBCOMMAND.test(segment)) return true;
  if (word === 'find') return isFindWriteIntent(segment);
  return false;
}

function isSelfConfigReadOnly(segment: string, word: string): boolean {
  if (SELF_CONFIG_READ_COMMANDS.has(word)) return true;
  if (word === 'git' && GIT_READ_SUBCOMMAND.test(segment)) return true;
  if (SELF_CONFIG_INTERPRETERS.has(word) && !hasInlineCode(segment)) return true;
  return false;
}

/**
 * Turning the firewall off through the AGENT'S OWN CLI, which touches no
 * protected file at all and so is invisible to every check above.
 * `openclaw plugins disable stroq` unloads the gate, `remove`/`uninstall`
 * delete it, and `openclaw config set plugins.…` rewrites exactly the
 * `plugins.entries.<id>.enabled` key `.openclaw/openclaw.json` is protected
 * for — each of them leaves the Gateway running with nothing in front of it,
 * which the spec (§2b) says a tainted agent must not be able to do.
 *
 * Matched anywhere in the segment's words rather than on its command word, so
 * a wrapper (`sudo …`), an absolute path (`/usr/local/bin/openclaw …`) and an
 * inner `find … -exec openclaw plugins remove …` are all covered — a command
 * word test would exempt every one of those, and `-exec` in particular is a
 * real bypass. The cost is a false positive on a segment that only MENTIONS
 * the text (`grep -r "openclaw plugins disable" docs/`), which is the
 * conservative direction and the same call the rest of this gate makes.
 *
 * Deliberately narrow on the verb: `plugins list|inspect|enable|install` and
 * `gateway restart` are how an operator checks and repairs the install, and
 * denying those would deny the fix. `config get` is likewise untouched here.
 */
const OPENCLAW_PLUGIN_OFF = /\bopenclaw\s+plugins\s+(?:disable|remove|uninstall)\b/;
const OPENCLAW_PLUGIN_CONFIG_WRITE = /\bopenclaw\s+config\s+set\s+plugins\./;

/** True when the segment runs the agent's own CLI to unload or delete the gate. */
export const disablesAgentPlugin = (segment: string): boolean =>
  OPENCLAW_PLUGIN_OFF.test(segment) || OPENCLAW_PLUGIN_CONFIG_WRITE.test(segment);

export type SelfConfigVerdict = 'deny' | 'ask' | null;

/**
 * Classifies one segment against the self-tamper gate:
 *   - `deny`  — clear write intent against a protected path, or the agent's
 *               own CLI switching the plugin off
 *   - `null`  — no protected path mentioned, or a known read-only command
 *   - `ask`   — a protected path is mentioned by something else (unknown
 *               commands, editors, interpreters without inline code)
 */
export function classifySelfConfigSegment(segment: string): SelfConfigVerdict {
  if (disablesAgentPlugin(segment)) return 'deny';
  const word = commandWord(segment);
  if (!touchesSelfConfig(segment, word)) return null;
  if (isSelfConfigWriteIntent(segment, word)) return 'deny';
  if (isSelfConfigReadOnly(segment, word)) return null;
  return 'ask';
}

export interface SelfConfigSignals {
  readonly deny: readonly string[];
  readonly ask: readonly string[];
}

// Our segment splitter is not quote-aware (see shell-segments.ts): a `;`
// inside an interpreter's inline-code string (`python3 -c "import os;os...`)
// splits the payload away from its `-c`/`-e` flag, so the fragment that
// actually mentions the protected path can no longer see the flag on its
// own. When some sibling segment of the same command IS an interpreter
// invocation with inline code, an otherwise-ambiguous sibling that mentions
// the path is still write intent, not a mere reference.
function anySegmentIsInterpreterInlineCode(segments: readonly string[]): boolean {
  return segments.some((seg) => {
    const word = commandWord(seg);
    return SELF_CONFIG_INTERPRETERS.has(word) && hasInlineCode(seg);
  });
}

export function selfTamperSignals(segments: readonly string[]): SelfConfigSignals {
  const interpreterInlineElsewhere = anySegmentIsInterpreterInlineCode(segments);
  const deny: string[] = [];
  const ask: string[] = [];
  for (const segment of segments) {
    const verdict = classifySelfConfigSegment(segment);
    if (verdict === 'deny' || (verdict === 'ask' && interpreterInlineElsewhere)) {
      // Named apart from a file write so `stroq why` says which kind of tamper
      // it was: nothing on disk changed, the gate itself was switched off.
      deny.push(disablesAgentPlugin(segment) ? 'self-config-disable' : 'self-config-write');
    } else if (verdict === 'ask') {
      ask.push('self-config-touch');
    }
  }
  return { deny, ask };
}
