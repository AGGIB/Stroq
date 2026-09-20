import { SELF_CONFIG_WRITE_COMMANDS } from './self-config.js';
import { commandWord } from './shell-segments.js';

/**
 * Git configuration keys whose value git executes as a command.
 *
 * This is the surface behind GitSpawn (Manifold Security, 2026-09-01): a repository
 * that arrives as files with its own `.git` directory already inside — a shared zip,
 * a sync folder, a bare repository committed inside an ordinary one — carries a
 * `core.fsmonitor`, and git runs it during an index refresh. The agent triggers that
 * merely by orienting itself with `git status`, which several agents do at startup
 * before the user has approved anything.
 *
 * Stroq's hooks cannot see that first `git status`, and this list does not pretend
 * to: what it catches is the other direction, an agent that has read something
 * untrusted and is now asked to *install* one of these keys. That is persistence,
 * and unlike the payloads that install it, the key set is finite.
 *
 * `include.path` and `includeIf.*.path` execute nothing themselves. They are here
 * because they are how a repository points git at a config file that does.
 */
export const GIT_EXEC_KEY =
  /\b(core\.(fsmonitor|hookspath|sshcommand|gitproxy|pager|editor|askpass|alternaterefscommand)|sequence\.editor|diff\.external|diff\.[\w-]+\.(textconv|command)|filter\.[\w-]+\.(clean|smudge|process)|merge\.[\w-]+\.driver|(mergetool|difftool)\.[\w-]+\.cmd|credential\.helper|(uploadpack|receivepack)\.[\w.-]+|protocol\.ext\.allow|alias\.[\w-]+|include\.path|includeif\.[^\s=]+\.path)\b/i;

/**
 * A `git config` invocation that is not one of its read verbs, or a `git -c key=…`
 * override. `-c` is transient rather than persisted, and still runs the command for
 * that invocation, which is the whole of what the attack needs.
 */
const GIT_CONFIG_WRITE = /\bgit\b[^\n]*?\bconfig\b/i;
const GIT_CONFIG_READ = /\bconfig\b[^\n]*\s--(get|get-all|get-regexp|list|name-only)\b/i;
const GIT_DASH_C = /\bgit\s+(?:\S+\s+)*?-c\s*[\w.-]+=/i;

/**
 * Files a repository can ship that make git — or tooling that opens the checkout —
 * run a command. `.git/config` and `.git/hooks/*` are git's own. `.gitattributes`
 * names the filter that `.git/config` defines; `.husky`, `.devcontainer` and
 * `.envrc` are the same idea one layer up, run by tools that read a checkout.
 *
 * Deliberately absent: `.github/workflows`, which runs on a server under its own
 * review, and `package.json`, where the executable part is one key among hundreds
 * and a write to it is ordinary work.
 *
 * Bounded with character-class lookarounds rather than anchors because this runs
 * against a whole command segment as well as a bare path: `echo … >> .git/config`
 * has the path in the middle of a line, while `docs/.gitattributes.md` is a document
 * about one and must not match.
 *
 * `.git` is joined to `config`/`hooks` by `[/\\]+`, so the Windows spelling counts.
 * The five entries beside it carry no separator and so always worked; `.git\hooks`
 * was the one alternative that silently matched nothing on the platform, which is
 * precisely the alternative that names an executable file.
 */
export const GIT_EXEC_FILE =
  /(?<![\w.-])(\.git[/\\]+(config|hooks)|\.gitattributes|\.gitmodules|\.husky|\.devcontainer|\.envrc)(?![\w.-])/;

/**
 * True for a dotted git configuration key whose value git executes.
 *
 * Takes the key on its own, as an INI parser produces it, rather than a whole command
 * line — `stroq exposure` reads `.git/config` directly and needs to ask about
 * `filter.lfs.clean`, not about a segment that happens to mention it.
 */
export function isGitExecKey(dottedKey: string): boolean {
  return new RegExp(`^(?:${GIT_EXEC_KEY.source.replace(/^\\b|\\b$/g, '')})$`, 'i').test(dottedKey);
}

/** True for a path a repository can use to make git, or an editor, run a command. */
export function isGitExecPath(path: string): boolean {
  return GIT_EXEC_FILE.test(path);
}

function isWriteIntent(segment: string): boolean {
  if (segment.includes('>')) return true;
  return SELF_CONFIG_WRITE_COMMANDS.has(commandWord(segment));
}

/**
 * Signals for `config.git_exec`: the agent is installing repository-supplied
 * execution, either by setting one of the keys above or by writing one of the files
 * that carries them.
 */
export function gitExecSignals(segments: readonly string[]): string[] {
  const out = new Set<string>();
  for (const seg of segments) {
    const setsKey =
      (GIT_CONFIG_WRITE.test(seg) && !GIT_CONFIG_READ.test(seg)) || GIT_DASH_C.test(seg);
    if (setsKey && GIT_EXEC_KEY.test(seg)) out.add('git-exec-key');
    if (isWriteIntent(seg) && GIT_EXEC_FILE.test(seg)) out.add('git-exec-file');
  }
  return [...out];
}
