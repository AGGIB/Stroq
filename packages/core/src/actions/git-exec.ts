import { followedBy, type TextTest } from './followed-by.js';
import { GIT_OUTPUT_OPTION, SELF_CONFIG_WRITE_COMMANDS, hasFileRedirect } from './self-config.js';
import { flattened } from './shell-names.js';
import { commandWord } from './shell-segments.js';
import { resolve, type Word } from './shell-words.js';

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
  /\b(core\.(fsmonitor|hookspath|sshcommand|gitproxy|pager|editor|askpass|alternaterefscommand)|sequence\.editor|diff\.external|diff\.[\w-]+\.(textconv|command)|filter\.[\w-]+\.(clean|smudge|process)|merge\.[\w-]+\.driver|(mergetool|difftool)\.[\w-]+\.cmd|credential\.helper|(uploadpack|receivepack)\.[\w.-]+|remote\.[\w.-]+\.(uploadpack|receivepack|vcs)|protocol\.ext\.allow|alias\.[\w-]+|include\.path|includeif\.[^\s=]+\.path)\b/i;

/**
 * A `git config` invocation that is not one of its read verbs, or a `git -c key=…`
 * override. `-c` is transient rather than persisted, and still runs the command for
 * that invocation, which is the whole of what the attack needs.
 */
export const GIT_CONFIG_WRITE = followedBy(/\bgit\b/i, /\bconfig\b/i);
export const GIT_CONFIG_READ = followedBy(
  /\bconfig\b/i,
  /\s--(get|get-all|get-regexp|list|name-only)\b/i,
);

const GIT_THEN_SPACE = /\bgit\s/i;
const DASH_C_ASSIGNMENT = /(?<=\s)-c\s*[\w.-]+=/gi;

/**
 * `git`, whitespace, any words, then `-c key=` at the start of one — what
 * `/\bgit\s+(?:\S+\s+)*?-c\s*[\w.-]+=/i` asked. That pattern walked the words after
 * every `git` in the segment, so a segment of `git x ` repeated cost the square of
 * its length. Whatever lies between the space after `git` and the space before `-c`
 * is some run of words and spaces, so the question is only whether a `-c key=`
 * preceded by whitespace starts after the first `git` and its space.
 */
export const GIT_DASH_C: TextTest = {
  test(text: string): boolean {
    const git = GIT_THEN_SPACE.exec(text);
    if (git === null) return false;
    DASH_C_ASSIGNMENT.lastIndex = git.index + git[0].length;
    return DASH_C_ASSIGNMENT.test(text);
  },
};

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

const EXEC_KEY_WHOLE = new RegExp(`^(?:${GIT_EXEC_KEY.source.replace(/^\\b|\\b$/g, '')})$`, 'i');

/**
 * True for a dotted git configuration key whose value git executes.
 *
 * Takes the key on its own, as an INI parser produces it, rather than a whole command
 * line — `stroq exposure` reads `.git/config` directly and needs to ask about
 * `filter.lfs.clean`, not about a segment that happens to mention it.
 */
export function isGitExecKey(dottedKey: string): boolean {
  return EXEC_KEY_WHOLE.test(dottedKey);
}

/** True for a path a repository can use to make git, or an editor, run a command. */
export function isGitExecPath(path: string): boolean {
  return GIT_EXEC_FILE.test(path);
}

/**
 * The options of `git` whose value is a command that it runs through a shell: `git fetch --upload-pack=…`
 * and `git push --receive-pack=…` run it on whichever side serves the pack (a local path is enough),
 * `git archive --remote=… --exec=…` runs it too, and `git --exec-path=…` is where git looks for the
 * program of every subcommand. `git` takes the start of a long option for it when it is not ambiguous
 * (`--upload=`), so any start of one of these is read as it.
 */
const GIT_PROGRAM_OPTIONS = ['upload-pack', 'receive-pack', 'exec'];

/**
 * `ext::` where a URL is: at the start of a word (`git fetch 'ext::sh -c …'`), as the base that a configuration
 * rewrites a name to (`url.ext::sh -c '…'.insteadOf=zz:`), as the value of a URL (`remote.o.url=ext::…`), and
 * as the value of an option that takes one (`git archive --remote='ext::…'`, `git push --repo=…`). Not in the
 * middle of a word, where it is a message or a pattern (`-m 'support ext:: transport'`, `--grep=ext::`,
 * `text::x`). The value of a configuration key is read where its pairs are (`gitConfigPairs`).
 */
const EXT_URL = /(?:^|(?<=url\.)|(?<=url=)|(?<=--(?:remote|repo)=))ext::/i;

/**
 * `git rebase --exec` and `-x` give git a command line to run after each commit, which is the command
 * it is, and is read as one (`git-commands.ts`): it is a program option only for the other commands.
 */
const COMMAND_LINE_EXEC: ReadonlySet<string> = new Set(['rebase']);

/**
 * The subcommand of `git` or `gh`, or null where there is none to find: the first word that is not an
 * option, past the options of `git` that take the next word for their value.
 */
const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--attr-source',
]);
export function subcommandOf(command: string, args: readonly Word[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const value = (args[i] as Word).value;
    if (GIT_VALUE_OPTIONS.has(value) && command === 'git') i += 1;
    else if (!value.startsWith('-')) return value;
  }
  return null;
}

/**
 * Whether a word is one of those options, or the start of one. `subcommand` is the one the word is an
 * argument of, where it is known: `clone` has `-u` for `--upload-pack`, and `rebase` reads `--exec` as a command.
 */
export function isGitProgramOption(word: string, subcommand: string | null = null): boolean {
  // The `ext::` transport is a URL that is a command: `ext::sh -c '…'` runs it, wherever a URL is given,
  // and in what a configuration rewrites a name to (`url.ext::sh -c '…'.insteadOf=zz:`).
  if (EXT_URL.test(word)) return true;
  if (subcommand === 'clone' && /^-[A-Za-z]*u/.test(word) && !word.startsWith('--')) return true;
  if (!word.startsWith('--')) return false;
  const name = word.slice(2).split('=')[0] ?? '';
  // The directory that git looks for the program of each subcommand in: only where it is given one.
  if (name === 'exec-path' && word.includes('=')) return true;
  if (name === 'exec' && subcommand !== null && COMMAND_LINE_EXEC.has(subcommand)) return false;
  return (
    name.length >= 2 &&
    GIT_PROGRAM_OPTIONS.some(
      (option) =>
        option.startsWith(name) &&
        !(option === 'exec' && subcommand !== null && COMMAND_LINE_EXEC.has(subcommand)),
    )
  );
}

/**
 * Whether a segment may run `git`, spelled however a shell reads it (`g'i't`, `g\it`): the word is in it once
 * its quotes and escapes are off. Resolving a segment costs what its words do, and most segments are not git.
 */
const mayRunGit = (segment: string): boolean =>
  /git/i.test(segment) || (/['"\\]/.test(segment) && /git/i.test(flattened(segment)));

/**
 * Whether a segment is a `git` command that is given one of them: read by its words, as a shell does
 * (`'--upload-pack=touch x'` is one word with a space in it, and the message of `git commit -m "…
 * --exec"` is a word that does not start with a dash), and the environment variable that is the
 * directory of its programs.
 */
function runsAProgramOption(segment: string): boolean {
  if (!mayRunGit(segment)) return false;
  const found = resolve(segment);
  if (found === null || found.name !== 'git') return false;
  const subcommand = subcommandOf('git', found.args);
  return found.args.some((word) => !word.redirect && isGitProgramOption(word.value, subcommand));
}

export interface GitConfigPair {
  /** The key, or null for one that is made as the command runs (`-c "=v"`), which is not known. */
  readonly key: string | null;
  /** What it is set to: for `--config-env=key=VARIABLE`, the name of the variable. */
  readonly value: string;
  /** The value is the name of a variable that holds it (`--config-env`). */
  readonly byVariable: boolean;
}

/**
 * The configuration that a `git` command sets for its own run (`-c key=value`, `-ckey=value`,
 * `--config-env=key=VARIABLE`), read from its words as a shell reads them: a quote may hold the key and
 * its value together (`-c "core.fsmonitor=curl … | sh"`), which a pattern over the text cannot tell
 * from a pipe.
 */
export function gitConfigPairs(segment: string): GitConfigPair[] {
  if (!mayRunGit(segment)) return [];
  const found = resolve(segment);
  if (found === null || found.name !== 'git') return [];
  const pairs: GitConfigPair[] = [];
  const add = (word: Word | undefined, text: string, byVariable: boolean): void => {
    const eq = text.indexOf('=');
    const key = eq === -1 ? text : text.slice(0, eq);
    pairs.push({
      key: word?.expands === true && /[$`]/.test(key) ? null : key,
      value: eq === -1 ? '' : text.slice(eq + 1),
      byVariable,
    });
  };
  found.args.forEach((word, i) => {
    if (word.redirect) return;
    const value = word.value;
    if (value === '-c' || value === '--config-env') {
      const next = found.args[i + 1];
      if (next !== undefined) add(next, next.value, value === '--config-env');
    } else if (value.startsWith('-c') && !value.startsWith('--')) add(word, value.slice(2), false);
    else if (value.startsWith('--config-env='))
      add(word, value.slice('--config-env='.length), true);
  });
  return pairs;
}

/** The keys of those pairs: `null` for a key that is made as the command runs, which is not known. */
export function gitConfigKeys(segment: string): (string | null)[] {
  return gitConfigPairs(segment).map((pair) => pair.key);
}

/** `GIT_EXEC_PATH=dir git …` is `--exec-path=dir`; `GIT_CONFIG_COUNT`, `…_KEY_n`, `…_PARAMETERS` set configuration by environment. */
const GIT_EXEC_PATH_SET = /(?<![\w.-])GIT_EXEC_PATH=(?!\s|$|''|"")/;
const GIT_CONFIG_BY_ENVIRONMENT = /(?<![\w.-])GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)=/;
/**
 * A URL given by the environment that is a command: `GIT_CONFIG_VALUE_0='ext::sh -c …'` with a key that
 * names a URL, `GIT_CONFIG_KEY_0='url.ext::sh -c …'` (the base that a configuration rewrites a name to),
 * and `GIT_CONFIG_PARAMETERS="'remote.o.url=ext::…'"`. Read on the text with its quotes taken off, so that
 * `e'x't::` is `ext::`.
 */
const GIT_CONFIG_EXT_VALUE =
  /(?<![\w.-])(?:GIT_CONFIG_VALUE_\d+=ext::|GIT_CONFIG_KEY_\d+=url\.ext::|GIT_CONFIG_PARAMETERS=[^\s]{0,300}?(?:url\.|url=|=)ext::)/i;

function isWriteIntent(segment: string): boolean {
  if (hasFileRedirect(segment)) return true;
  const word = commandWord(segment);
  // `git show --output=.git/config`: a read verb that writes where it is told to.
  if (word === 'git' && GIT_OUTPUT_OPTION.test(segment)) return true;
  return SELF_CONFIG_WRITE_COMMANDS.has(word);
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
      (GIT_CONFIG_WRITE.test(seg) && !GIT_CONFIG_READ.test(seg)) ||
      GIT_DASH_C.test(seg) ||
      GIT_CONFIG_BY_ENVIRONMENT.test(seg);
    if (setsKey && GIT_EXEC_KEY.test(seg)) out.add('git-exec-key');
    if (gitConfigKeys(seg).some((key) => key !== null && isGitExecKey(key)))
      out.add('git-exec-key');
    if (isWriteIntent(seg) && GIT_EXEC_FILE.test(seg)) out.add('git-exec-file');
    if (
      GIT_EXEC_PATH_SET.test(seg) ||
      GIT_CONFIG_EXT_VALUE.test(flattened(seg)) ||
      runsAProgramOption(seg) ||
      // What a configuration key is set to, whatever the key: a URL that is a command (`-c branch.main.remote=ext::…`).
      gitConfigPairs(seg).some((pair) => !pair.byVariable && /^ext::/i.test(pair.value))
    )
      out.add('git-exec-option');
  }
  return [...out];
}

/** A configuration key whose value is a URL (or the name of a remote, which is one), or what rewrites one. */
const URL_KEY =
  /^(?:remote\..+\.(?:url|pushurl)|remote\.pushdefault|branch\..+\.(?:remote|pushremote)|url\..+\.(?:insteadof|pushinsteadof)|submodule\..+\.url)$/i;

/**
 * What `git` is given that may be a program and is made as the command runs: a configuration key that a
 * substitution or a variable spells (`-c "$(echo core.fsmonitor)=…"`). Asked about, as a command word that
 * a substitution makes is.
 */
export function gitUnparsedSignals(segments: readonly string[]): string[] {
  const out: string[] = [];
  if (segments.some((segment) => gitConfigKeys(segment).includes(null)))
    out.push('git-config-key-made-at-run-time');
  // A URL that a variable holds (`--config-env=remote.o.url=U`) is a command where `U` holds `ext::…`.
  if (
    segments.some((segment) =>
      gitConfigPairs(segment).some(
        (pair) => pair.byVariable && pair.key !== null && URL_KEY.test(pair.key),
      ),
    )
  )
    out.push('git-config-url-from-variable');
  return out;
}

/**
 * Git configuration written as TEXT: the `[diff] external = …` a `git show --output`
 * leaves behind, or the `core.fsmonitor` in a config an agent writes at a path that is
 * not literally `.git/config` — a `gitdir:` pointer to `.alt/config`, or a file a
 * `[include]` pulls in. The path rule above cannot see either, and a repository's
 * `.git` directory does not have to be called `.git` (Pillar Security, 2026-07).
 *
 * Read as INI, section by section, in files whose name is a configuration's: a gitdir's
 * `config`, a `.gitconfig` or anything named like one, or `.cfg`/`.conf`/`.config`/`.ini`/
 * `.inc`. A source file, a document or a data file quotes
 * config sections and is not one. Two tiers. The keys git runs whenever it works in the
 * repository (`core.fsmonitor`, `core.hooksPath`, `diff.external`, a filter or merge
 * driver) are `exec`, which the policy denies. The keys that name a program for one feature
 * (`gpg.program`, a `textconv`, an `include.path`, a shell alias, a credential helper that
 * starts with `!`) are `program`: a user's own `~/.gitconfig` has them for 1Password
 * signing or `bun` lockfiles, so they are asked about rather than refused.
 */
const MAX_CONFIG_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_DOTTED_KEY_CHARS = 300;
const INI_HEADER = /^\[\s*([A-Za-z][\w.-]*)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*(.*)$/;
const INI_ASSIGNMENT = /^([A-Za-z][\w-]*)\s*(?:=\s*(.*))?$/;
const EXEC_TEXT_KEY =
  /^(?:core\.(?:fsmonitor|hookspath|sshcommand|gitproxy|askpass|alternaterefscommand)|diff\.external|diff\..+?\.command|filter\..+?\.(?:clean|smudge|process)|merge\..+?\.driver|uploadpack\.packobjectshook|receivepack\.[\w-]*hook|protocol\.ext\.allow|remote\..+?\.(?:uploadpack|receivepack|vcs))$/i;
const PROGRAM_TEXT_KEY =
  /^(?:diff\..+?\.textconv|gpg\.(?:.+?\.)?program|trailer\..+?\.cmd|init\.templatedir|include\.path|includeif\..+?\.path)$/i;
/**
 * Keys that name a program only sometimes: a pager or an editor is usually just `less`,
 * and a merge tool's `cmd` runs only when somebody starts the tool, with `$MERGED` in it.
 */
const SOMETIMES_TEXT_KEY =
  /^(?:core\.(?:pager|editor)|sequence\.editor|pager\.[\w-]+|credential\.(?:.+?\.)?helper|(?:mergetool|difftool|browser)\..+?\.cmd)$/i;
/** Keys whose value is a git command unless it starts with `!`, which hands it to a shell. */
const BANG_KEY = /^(?:alias\.[\w-]+|submodule\..+?\.update)$/i;
const BOOLEAN_VALUE = /^(?:true|false|yes|no|on|off|0|1)$/i;
/** Git LFS's own filter, which `git lfs install` writes into every user's `~/.gitconfig`. */
const GIT_LFS_VALUE = /^git-lfs\s/;
/**
 * A value that starts a shell or another program that fetches or runs code. A pipe or a
 * `$VARIABLE` alone is not it: `diff-so-fancy | less` and `code --wait $MERGED` are pagers
 * and merge tools, and `sh -c …`, `curl … | sh` and `$(…)` are what an attack writes.
 */
const ACTIVE_VALUE =
  /[;`]|\$\(|&&|\|\||^!|\b(?:sh|bash|zsh|cmd|powershell|pwsh|curl|wget|nc|python3?|node|perl)\b/i;
const CONFIG_EXTENSION = /^\.(?:cfg|conf|config|ini|inc|gitconfig)$/i;
/** Documents, source and data files: they quote config sections and are not one. */
const NOT_CONFIG_EXTENSION =
  /^\.(?:md|mdx|markdown|txt|rst|adoc|html?|[cm]?[jt]sx?|mts|cts|py|rb|go|rs|java|kts?|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|zsh|ps1|json|jsonc|ya?ml|toml|xml|lock|snap|dart|vue|svelte|scala|lua|exs?|pl|sql|ipynb|gradle|tf|csv|log)$/i;

/** What a git configuration text makes git run: on every operation, for one feature, or nothing. */
export type GitConfigRisk = 'exec' | 'program' | 'unread' | null;

function keyRisk(dotted: string, value: string): GitConfigRisk {
  if (dotted.length > MAX_DOTTED_KEY_CHARS || value === '' || BOOLEAN_VALUE.test(value))
    return null;
  // A URL that is a command, whatever the key it is the value of, and the base that a name is rewritten to.
  if (/^ext::/i.test(value) || /^url\.ext::/i.test(dotted)) return 'exec';
  if (EXEC_TEXT_KEY.test(dotted)) {
    return /^filter\./i.test(dotted) && GIT_LFS_VALUE.test(value) ? null : 'exec';
  }
  if (PROGRAM_TEXT_KEY.test(dotted)) return 'program';
  if (BANG_KEY.test(dotted)) return value.startsWith('!') && value.length > 1 ? 'program' : null;
  if (SOMETIMES_TEXT_KEY.test(dotted)) {
    return value.startsWith('!') || ACTIVE_VALUE.test(value) ? 'program' : null;
  }
  return null;
}

const stronger = (a: GitConfigRisk, b: GitConfigRisk): GitConfigRisk => {
  const order: readonly GitConfigRisk[] = ['exec', 'program', 'unread'];
  for (const risk of order) if (a === risk || b === risk) return risk;
  return null;
};

/** Whether `path` is named like a git configuration (see above). */
export function isGitConfigPath(path: string): boolean {
  const base = path.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
  if (NOT_CONFIG_EXTENSION.test(ext)) return false;
  // A gitdir's own file is `config`; a user's is `.gitconfig` or named like it.
  return base.toLowerCase() === 'config' || /gitconfig/i.test(base) || CONFIG_EXTENSION.test(ext);
}

export function gitConfigTextRunsCommand(path: string, text: string): boolean {
  return isGitConfigPath(path) && iniRisk(text) !== null;
}

/**
 * The part of `gitConfigTextRunsCommand` that does not depend on the path, for a caller
 * that asks it about one text and many paths and must not parse the text for each. A text
 * past `MAX_CONFIG_TEXT_CHARS` is `unread`: padding ahead of a key is not a way past it.
 */
export function iniRisk(text: string): GitConfigRisk {
  if (text.length === 0) return null;
  if (text.length > MAX_CONFIG_TEXT_CHARS) return 'unread';
  let section = '';
  let found: GitConfigRisk = null;
  const assign = (line: string): void => {
    const assignment = section === '' ? null : INI_ASSIGNMENT.exec(line);
    if (!assignment) return;
    const eq = line.indexOf('=');
    const key = (assignment[1] as string).toLowerCase();
    const value = eq === -1 ? '' : line.slice(eq + 1).trim();
    found = stronger(found, keyRisk(`${section}.${key}`, value));
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = INI_HEADER.exec(line);
    if (header) {
      const sub = header[2];
      section = (sub === undefined ? header[1] : `${header[1]}.${sub}`) as string;
      // `[core] fsmonitor = x` is a section and its first key on one line.
      const tail = (header[3] as string).trim();
      if (tail !== '' && !tail.startsWith('#') && !tail.startsWith(';')) assign(tail);
    } else assign(line);
    if (found === 'exec') return found;
  }
  return found;
}

/**
 * An editor task that runs when the folder is opened: VS Code's `"runOn": "folderOpen"`,
 * or the `task.allowAutomaticTasks` switch that lets one run unasked. The Antigravity
 * time bomb, Miasma and ChainDrop all plant exactly this, because opening the project
 * is something the developer does anyway. These files are JSON with comments, so a
 * comment may sit between the key and its value, and a `.code-workspace` file carries
 * both the tasks and the settings.
 */
// A block comment's body cannot contain `*/`, so each comment parses one way only. With a
// lazy `[\s\S]` body a run of `/**/` could be split 2^k ways, and 26 of them after
// `"runOn":` took a second: every Bash command is tested against this.
const COMMENTS = String.raw`(?:\/\*(?:[^*]|\*(?!\/)){0,200}\*\/\s*|\/\/[^\n]{0,200}\n\s*){0,8}`;
const RUN_ON_FOLDER_OPEN = new RegExp(String.raw`"runOn"\s*:\s*${COMMENTS}"folderOpen"`, 'i');
const ALLOW_AUTOMATIC_TASKS = new RegExp(
  String.raw`"task\.allowAutomaticTasks"\s*:\s*${COMMENTS}"on"`,
  'i',
);
/** The text of either, for a caller that has a command and not a file to look at. */
export const EDITOR_AUTORUN_TEXT = new RegExp(
  `${RUN_ON_FOLDER_OPEN.source}|${ALLOW_AUTOMATIC_TASKS.source}`,
  'i',
);

/** Whether `path` is a file an editor reads an auto-run task from. */
export const isEditorAutorunPath = (path: string): boolean =>
  /(?:^|\/)(?:tasks\.json|settings\.json)$|\.code-workspace$/i.test(path.replace(/\\/g, '/'));

export function editorAutorunText(path: string, text: string): boolean {
  const lowered = path.replace(/\\/g, '/').toLowerCase();
  if (/(?:^|\/)tasks\.json$/.test(lowered)) return RUN_ON_FOLDER_OPEN.test(text);
  if (/(?:^|\/)settings\.json$/.test(lowered)) return ALLOW_AUTOMATIC_TASKS.test(text);
  if (/\.code-workspace$/.test(lowered)) return EDITOR_AUTORUN_TEXT.test(text);
  return false;
}
