import type { ActionClass } from '../types.js';
import { powershellSignals } from './classify-powershell.js';
import { stroqStateReading } from './stroq-state.js';
import { isDangerousRmTarget } from './dangerous-target.js';
import { remoteClassification, remoteTextClassification } from './classify-remote.js';
import { isTooCostly } from './reading-cost.js';
import { anyOf, followedBy, type PatternTest, type TextTest } from './followed-by.js';
import {
  commandWord,
  firstArgAfter,
  splitCommand,
  tokenize,
  type SplitCommand,
} from './shell-segments.js';
import { commandSegments } from './shell-top-level.js';
import {
  isLineProcessor,
  isReadInterpreter,
  pipeConsumer,
  type ConsumerContext,
  type PipeConsumer,
} from './pipe-consumer.js';
import { lex, type Stage } from './shell-lex.js';
import { isInitSubstitution } from './init-tools.js';
import { resolve } from './shell-words.js';
import {
  SELF_CONFIG_READ_COMMANDS,
  SELF_CONFIG_WRITE_COMMANDS,
  instructionWriteSignals,
  selfTamperSignals,
} from './self-config.js';

export interface CommandClassification {
  readonly classes: readonly ActionClass[];
  readonly hosts: readonly string[];
  readonly signals: readonly string[];
  /**
   * The text of each script the command runs, as it was read: what the command carries
   * besides its own words, which the secret guard has to look through for a known value.
   */
  readonly scripts?: readonly string[];
}

export { commandWord, splitSegments } from './shell-segments.js';
import { codeInValue } from './code-in-values.js';
import { COMMAND_ENVIRONMENT } from './command-environment.js';
import { fetchedExecSignals } from './fetched-exec.js';
import { gitExecSignals, gitUnparsedSignals } from './git-exec.js';
import type { FunctionRoom } from './function-readings.js';
import { functionKey, inheritedFunctions, type FunctionDefinition } from './inlined-functions.js';
import { flattened } from './shell-names.js';
import {
  NO_INPUT,
  decodePrograms,
  newBudget,
  type Budget,
  type ShellInput,
} from './shell-input.js';
import { READING_DEADLINE_MS, withDeadline } from './deadline.js';
import { jobStages, persistenceSignals } from './persistence.js';

const SHELLS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'python',
  'python3',
  'node',
  'perl',
  'ruby',
  'php',
  'eval',
  'source',
  '.',
]);
const NETWORK_COMMANDS = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'telnet',
  'ftp',
  'socat',
]);
// Wrapper CLIs that are only network-ish for specific subcommands — bare
// `npm install` / `docker build` / `gh pr view` stay benign.
const NETWORK_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  gh: new Set(['api', 'release', 'gist']),
  aws: new Set(['s3', 'sns', 'sqs', 'lambda', 'ssm']),
  az: new Set(['storage', 'keyvault']),
  gcloud: new Set(['storage', 'secrets', 'pubsub']),
  kubectl: new Set(['cp', 'exec']),
  docker: new Set(['push', 'login']),
  npm: new Set(['publish']),
  pnpm: new Set(['publish']),
  yarn: new Set(['publish']),
  pip: new Set(['upload']),
  twine: new Set(['upload']),
  cargo: new Set(['publish']),
};
// Command words whose arguments are inert data, never an invocation of
// another command — `echo curl https://x` prints a string, it does not run
// curl. These are excluded from the unknown-wrapper network scan below.
const TERMINAL_DATA_COMMANDS = new Set([
  'echo',
  'printf',
  'grep',
  'rg',
  'man',
  'which',
  'type',
  'help',
  'alias',
  'unalias',
  'export',
  'set',
  'unset',
  'read',
  'test',
  '[',
  'true',
  'false',
]);
const URL_HOST = /https?:\/\/([^\s/'"`:]+)/g;
// Starts only where a run of `[\w.-]` starts, and only if that run holds a word
// character before its `@` — which is where `\b[\w.-]+@` could start, and gives the
// same host. Starting at every `\b` inside the run, as that did, re-read the run from
// each of them: 16 KiB of `a.` took 241 ms, growing with the square.
export const SSH_TARGET = /(?<![\w.-])(?=[.-]*\w)[\w.-]+@([\w-]+(?:\.[\w-]+)+)/g;
const DECODE = /\b(base64\s+(-d|--decode|-D)|openssl\s+(base64|enc)\s+-d|xxd\s+-r)\b/;
// The `[^\n]*` patterns in this file are `followedBy`: the same question, answered
// in linear time. 16 KiB of `eval ` took 28 s as a pattern; see `followed-by.ts`.
// Not the tail of a longer name (`spynex-eval run`, `node --eval`, `lib/eval`): that is not `eval`.
export const EVAL_DYNAMIC = followedBy(/(?<![\w./-])eval\b/, /(\$\(|`|\$\{?\w)/);
const INLINE_INTERP = /\b(python3?|node|perl|ruby)\s+(-c|-e)\b/;
// `Buffer.from(x, 'base64')` needs no alternative of its own: it contains `base64`,
// which is matched anywhere in the segment already. A `Buffer\.from\([^)]*base64`
// alternative used to sit here, adding no match and only cost: from every
// `Buffer.from(` with no `)` or `base64` after it, `[^)]*` rescanned the rest of the
// segment, so 262,144 characters of them took 2.1 s in this pattern alone.
const INLINE_PAYLOAD = /(exec\(|base64|__import__|atob\(|child_process|subprocess|os\.system)/;
// Not at the end of a snake-case name, where it is a word of it and not the library: a table
// `organization_join_requests` in the SQL that an inline program is given is not `requests`. A name that
// begins with an underscore is the library under another name (`_socket`, `_http.request`).
const INLINE_NETWORK =
  /(?<![A-Za-z0-9]_)(?:urllib|requests|socket|http\.client|fetch\(|http\.request|net\.connect)/;
const SHELL_C_REMOTE = /\b(ba|z|da)?sh\s+-c\s+["']?\$\((curl|wget)\b/;
// `bash|sh|zsh|source|.` piping a process substitution straight into the
// shell — `bash <(curl ...)` / `source <(curl ...)`. The substitution's
// inner text is also split out as its own segment by shell-segments.ts, so
// this only needs to add the `shell.exec_encoded` signal; `shell.network`
// comes from that extracted inner segment matching `isNetwork` on its own.
export const SHELL_PROC_SUB_REMOTE = followedBy(
  /\b(bash|sh|zsh|dash|ksh|source|\.)\b/,
  /<\(\s*(curl|wget)\b/,
);
const RSYNC_DELETE = followedBy(/\brsync\b/, /\s--del(?:ete(?:-[a-z]+)?)?(?![\w-])/);
/**
 * `rsync --delete` is a deploy script's business locally; to a host it removes what is not
 * in the source from somebody's server.
 */
const RSYNC_DELETE_TO_HOST: TextTest = {
  test: (text) =>
    RSYNC_DELETE.test(text) && /(?:\s(?:[\w.-]+@)?[\w.-]{2,}:(?!\/\/)\S)|rsync:\/\//.test(text),
};
export const DESTRUCTIVE: ReadonlyArray<readonly [TextTest, string]> = [
  [/\bgit\s+reset\s+--hard\b/, 'git-destructive'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git-destructive'],
  [/\bgit\s+checkout\s+(--\s+)?\.\s*$/, 'git-destructive'],
  [/\bgit\s+restore\s+\.\s*$/, 'git-destructive'],
  [followedBy(/\bgit\s+push\b/, /(--force|\s-f\b)/), 'git-destructive'],
  [/\bgit\s+branch\s+-D\b/, 'git-destructive'],
  [/\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, 'sql-destructive'],
  [/\bmkfs(\.\w+)?\b/, 'disk-destructive'],
  [followedBy(/\bdd\b/, /\bof=\/dev\/(?!null\b|zero\b)/), 'disk-destructive'],
  [/\bshred\b/, 'disk-destructive'],
  [/\bwipefs\b/, 'disk-destructive'],
  [/\bchmod\s+-R\s+777\s+\//, 'chmod-root'],
  [/>\s*\/dev\/(sd|nvme|disk)/, 'write-device'],
  [/\bkill\s+-9\s+-1\b/, 'kill-all'],
  // Infrastructure and database wipes the incident record shows agents running
  // unprompted: `terraform destroy` / `apply -destroy`, `drizzle-kit push --force`
  // (claude-code #27063), `prisma migrate reset` / `db push --force-reset`.
  // `-destroy`, `-destroy=true|t|1` are destructive; `-destroy=false` explicitly is not.
  [
    anyOf(
      /\b(terraform|tofu)\s+destroy\b/i,
      followedBy(/\b(terraform|tofu)\s+apply\b/i, /\s-destroy(?:=(?:1|t|true))?(?![\w=-])/i),
    ),
    'iac-destroy',
  ],
  [/\bpulumi\s+destroy\b/, 'iac-destroy'],
  [followedBy(/\bdrizzle-kit\s+push\b/, /--force(?![\w-])/), 'db-force-migrate'],
  [/\bprisma\s+migrate\s+reset\b/, 'db-force-migrate'],
  // `--accept-data-loss=false` declines it.
  [
    followedBy(
      /\bprisma\s+db\s+push\b/,
      /--(?:force-reset|accept-data-loss)(?![\w-])(?!=(?:false|0)\b)/,
    ),
    'db-force-migrate',
  ],
  // Only the remote-targeting forms: a bare `supabase db reset` resets the local dev stack.
  [followedBy(/\bsupabase\s+db\s+reset\b/, /--(linked|db-url)\b/), 'db-force-migrate'],
  [/\bgh\s+repo\s+delete\b/, 'gh-repo-delete'],
  // Deletes on hosting, storage and clusters that agents ran on their own initiative in
  // 2026: `firebase hosting:disable --force` on a live site (claude-code #93002), `lftp
  // mirror --delete` over a production FTP root (#89014), a cloud-storage purge of every
  // object version (#97084). Each names the verb that removes, not the tool: `firebase
  // deploy`, `gsutil cp` and `kubectl get` are ordinary work and stay unclassified.
  // Global options come before the verb (`kubectl -n prod delete`, `aws --profile p s3 rm`,
  // `gcloud --project=p … delete`), so each tool allows a few words ahead of it. A verb is
  // a whole word: `describe delete-me-vm` is the name of a machine.
  [
    /\bfirebase\s+(?:\S+\s+){0,5}?(?:hosting:disable|hosting:channel:delete|projects:delete|firestore:delete|database:remove|functions:delete|apphosting:backends:delete)(?![\w:-])/,
    'cloud-destructive',
  ],
  [/\bgcloud\s+(?:\S+\s+){0,6}?(?:delete|rm)(?=\s|$)/, 'cloud-destructive'],
  [/\bgsutil\s+(?:-[\w-]+\s+)*(?:rm|rb)\b/, 'cloud-destructive'],
  [/\baws\s+(?:\S+\s+){0,5}?s3\s+(?:rm|rb)\b/, 'cloud-destructive'],
  [followedBy(/\baws\s+(?:\S+\s+){0,5}?s3\s+sync\b/, /\s--delete\b/), 'cloud-destructive'],
  [
    /\baws\s+(?:\S+\s+){0,5}?[A-Za-z][\w-]*\s+(?:delete|terminate|deregister|remove)-[\w-]+/,
    'cloud-destructive',
  ],
  [/\baz\s+(?:\S+\s+){1,6}?delete(?=\s|$)/, 'cloud-destructive'],
  [
    followedBy(
      /\bkubectl\b/,
      /\sdelete\s(?:[^|;&\n]{0,200}?[\s,])?(?:--all|--all-namespaces|-A|ns|namespaces?|pv|pvc|persistentvolumeclaims?|statefulsets?|sts|deployments?|deploy|nodes?|crds?)(?:[\s/,]|$)/,
    ),
    'cloud-destructive',
  ],
  [
    /\b(?:heroku\s+(?:apps:destroy|pg:reset|addons:destroy)|netlify\s+sites:delete|vercel\s+(?:rm|remove))\b|\bhelm\s+(?:\S+\s+){0,5}?(?:uninstall|delete)(?=\s|$)/,
    'cloud-destructive',
  ],
  [/\bfly(?:ctl)?\s+(?:apps\s+destroy|volumes?\s+destroy|destroy)\b/, 'cloud-destructive'],
  // A volume holds data. `docker system prune` removes only what is rebuilt, until it is
  // given `--volumes`.
  [/\bdocker\s+volume\s+(?:rm|prune)\b/, 'cloud-destructive'],
  [followedBy(/\bdocker\s+system\s+prune\b/, /\s--volumes\b/), 'cloud-destructive'],
  [followedBy(/\bgh\s+api\b/, /(?:-X|--method)\s*=?\s*DELETE\b/i), 'cloud-destructive'],
  [/\b(?:npm\s+unpublish|gh\s+release\s+delete)\b/, 'cloud-destructive'],
  [followedBy(/\blftp\b/, /--delete\b/), 'remote-sync-delete'],
  [RSYNC_DELETE_TO_HOST, 'remote-sync-delete'],
  [/\bgit\s+(?:filter-branch|filter-repo|reflog\s+expire)\b/, 'git-history-rewrite'],
  [followedBy(/\bgit\s+gc\b/, /--prune=now\b/), 'git-history-rewrite'],
];
// Every separator here is `[/\\]`, for the reason spelled out over `SELF_CONFIG_FILE`
// in self-config.ts: on Windows these paths arrive with backslashes, and the ones
// anchored on a slash — `.ssh`, `.aws/credentials`, `.env`, `.kube/config`,
// `.config/gcloud` — matched nothing there at all, while the `\b`-delimited bare
// filenames beside them kept working. Half a credential list checking out is the
// shape this whole pass exists to remove. The two `/proc` and `/etc` entries keep
// their slashes: those name POSIX files that have no Windows counterpart.
export const SECRET_PATTERNS: readonly PatternTest[] = [
  /(^|[\s"'/\\=])~?[/\\]?\.ssh([/\\]|\b)/,
  /\bid_(rsa|ed25519|ecdsa|dsa)\b/,
  /\.aws[/\\](credentials|config)\b/,
  // `@` is included so `-f body=@.env` / `-d @.env` (a file-upload argument,
  // not a literal path segment) is also recognised.
  /(^|[\s"'/\\=@])\.env(\.[\w-]+)?\b/,
  /\.(pem|p12|pfx|key)\b/,
  /\.(npmrc|netrc|pgpass|git-credentials)\b/,
  /\.kube[/\\]config\b/,
  /\.config[/\\]gcloud\b/,
  /\/etc\/(shadow|passwd)\b/,
  /\bsecurity\s+find-(generic|internet)-password\b/,
  followedBy(/\/proc\//, /\/environ\b/, 'word'),
];
const ENV_DUMP = /^(env|printenv|set|export)\s*$/;
export const PUSH_EXTERNAL = anyOf(
  followedBy(/\bgit\s+push\b/, /\b(https?:\/\/|git@|ssh:\/\/)/),
  /\bgit\s+remote\s+(add|set-url)\b/,
);
// `gh repo create … --push` creates a remote repository and pushes the source
// directory to it in one step — the s1ngularity exfiltration shape.
export const GH_REPO_CREATE_PUSH = followedBy(/\bgh\s+repo\s+create\b/, /--push\b/);

// Re-exported from its own module so the PowerShell reader can share the judgement
// without importing this one; `dangerous-target.ts` explains why it moved.
export { isDangerousRmTarget } from './dangerous-target.js';

function rmIsDangerous(segment: string, cwd: string): boolean {
  const tokens = tokenize(segment);
  const rmIndex = tokens.findIndex((t) => t.replace(/^.*\//, '').toLowerCase() === 'rm');
  if (rmIndex < 0) return false;
  const args = tokens.slice(rmIndex + 1);
  const recursive = args.some(
    (a) => a === '--recursive' || (/^-[A-Za-z]+$/.test(a) && /[rR]/.test(a)),
  );
  if (!recursive) return false;
  return args.filter((a) => !a.startsWith('-')).some((a) => isDangerousRmTarget(a, cwd));
}

/** What `find` tests that limits what it removes: a name, a time, a size, an owner. `-type` does not. */
const FIND_FILTER =
  /^-(?:i?name|i?path|i?wholename|i?regex|i?lname|newer\w*|[mac](?:time|min)|size|user|group|nouser|nogroup|perm|empty|samefile|inum|links|readable|writable|executable)$/;

/**
 * `find ~ -delete` and `find / -exec rm -rf {} +` remove everything under the roots they name, as
 * `rm -rf` on that root would, unless a test on the name, the age or the size picks what goes. They
 * are judged by the same list of roots (see `isDangerousRmTarget`).
 */
function findDeletesDangerousRoot(segment: string, cwd: string): boolean {
  const tokens = tokenize(segment);
  const at = tokens.findIndex((t) => t.replace(/^.*\//, '').toLowerCase() === 'find');
  if (at < 0) return false;
  const args = tokens.slice(at + 1);
  if (args.some((a) => FIND_FILTER.test(a))) return false;
  const firstExpression = args.findIndex((a) => a.startsWith('-') || a === '(' || a === '!');
  const roots = firstExpression < 0 ? args : args.slice(0, firstExpression);
  const removes = args.some(
    (a, i) =>
      a === '-delete' ||
      (/^-exec(?:dir)?$/.test(a) && /^(?:.*\/)?(?:rm|shred|unlink)$/i.test(args[i + 1] ?? '')),
  );
  return removes && roots.some((root) => isDangerousRmTarget(root, cwd));
}

/**
 * `echo ~ | xargs rm -rf` and `find ~ -type f | xargs rm`: what is piped into `xargs rm -r…` is the
 * list of what goes. A pipeline that names a root `rm -rf` is asked about, with nothing in front
 * of `xargs` that limits it to some names, removes that root.
 */
function xargsRemovesDangerousRoot(pipelines: readonly string[][], cwd: string): boolean {
  return pipelines.some((stages) =>
    stages.some((stage, i) => {
      if (i === 0) return false;
      const rest = tokenize(stage);
      const xargs = rest.findIndex((t) => t.replace(/^.*\//, '').toLowerCase() === 'xargs');
      const rm = rest.findIndex((t, at) => at > xargs && /^(?:.*\/)?rm$/i.test(t));
      if (xargs < 0 || rm < 0) return false;
      const recursive = rest
        .slice(rm + 1)
        .some((a) => a === '--recursive' || /^-[A-Za-z]*[rR]/.test(a));
      const before = stages.slice(0, i).flatMap(tokenize);
      return (
        recursive &&
        before.some((t) => isDangerousRmTarget(t, cwd)) &&
        !before.some((t) => FIND_FILTER.test(t))
      );
    }),
  );
}

const isShell = (seg: string): boolean => SHELLS.has(commandWord(seg));

function hasNetworkSubcommand(seg: string, word: string): boolean {
  // Own keys only: a word such as `toString` or `__proto__` is not a command in the table.
  const subcommands = Object.hasOwn(NETWORK_SUBCOMMANDS, word)
    ? NETWORK_SUBCOMMANDS[word]
    : undefined;
  return subcommands !== undefined && subcommands.has(firstArgAfter(seg));
}

/**
 * True when `word` is a command we already have a specific, deliberate
 * verdict for elsewhere (a known network command, a shell, a self-config
 * reader/writer, a command whose args are inert data, or `git` — whose
 * network behaviour is already covered by the push/remote rules). Only a
 * command word outside all of those categories is "unknown" enough to
 * warrant scanning its argument list for an embedded network command —
 * otherwise `grep curl notes.txt` or `npm install` would be misread as
 * running curl.
 */
function isClassifiedElsewhere(word: string): boolean {
  return (
    word === 'git' ||
    NETWORK_COMMANDS.has(word) ||
    SHELLS.has(word) ||
    Object.hasOwn(NETWORK_SUBCOMMANDS, word) ||
    SELF_CONFIG_READ_COMMANDS.has(word) ||
    SELF_CONFIG_WRITE_COMMANDS.has(word) ||
    TERMINAL_DATA_COMMANDS.has(word)
  );
}

function hasEmbeddedNetworkToken(tokens: readonly string[]): boolean {
  return tokens.some((token, i) => {
    if (NETWORK_COMMANDS.has(token)) return true;
    const subcommands = Object.hasOwn(NETWORK_SUBCOMMANDS, token)
      ? NETWORK_SUBCOMMANDS[token]
      : undefined;
    return subcommands !== undefined && subcommands.has(tokens[i + 1] ?? '');
  });
}

// A token that is nothing but one matching quoted span — `"curl"` or
// `'curl'` — is what the shell would treat as the bare word, so it is
// unwrapped to that word before the embedded-network-token check runs.
// When the quoted content itself contains whitespace (a quoted multi-word
// argument, e.g. a `-k "test curl"` filter, rather than a single quoted
// word) the token is a piece of inert data and is dropped instead of
// contributing any word to the scan.
const FULLY_QUOTED_TOKEN = /^"([^"]*)"$|^'([^']*)'$/;

function unwrapQuotedToken(token: string): string | null {
  const match = FULLY_QUOTED_TOKEN.exec(token);
  if (!match) return token;
  const content = match[1] ?? match[2] ?? '';
  return /\s/.test(content) ? null : content;
}

// Unlisted single-word wrappers (`setsid`, `flock`, `script`, `unbuffer`,
// `strace`, `runuser`, …) run an arbitrary trailing command but are not
// themselves in PREFIX_WORDS, so `commandWord` returns the wrapper itself
// rather than skipping to the wrapped command. Rather than maintaining an
// ever-growing wrapper allowlist, an unknown command word's remaining
// tokens are scanned for an embedded network command word.
//
// The scan runs on tokens already produced by `tokenize` (which strips
// empty quote pairs and backslashes per token) rather than pre-stripping
// quoted spans out of the raw segment string first: stripping `"[^"]*"`
// from the raw string also matches an *empty* pair like the `""` inside
// `cu""rl`, deleting it and splitting what should be one word (`curl`)
// into two (`cu`, `rl`) before `tokenize` ever gets a chance to fold it
// back together. Running on tokens avoids that, and `unwrapQuotedToken`
// still keeps a deliberately-quoted argument (`-k "test_curl"`, a commit
// message) from being misread as a command name.
//
// `-m <value>` / `--message=<value>` is deliberately NOT stripped here:
// `git` — the only command where a commit message could plausibly contain
// a network word — is excluded from this scan entirely (see
// `isClassifiedElsewhere`), and stripping `-m <word>` for every OTHER
// unknown wrapper wrongly ate real, unrelated arguments, e.g.
// `setsid -m curl https://x` (where `-m` is setsid's own flag).
function isUnknownWrapperNetworkCall(seg: string, word: string): boolean {
  if (word === '' || isClassifiedElsewhere(word)) return false;
  const tokens = tokenize(seg)
    .filter((t) => t !== '--')
    .map(unwrapQuotedToken)
    .filter((t): t is string => t !== null);
  return hasEmbeddedNetworkToken(tokens);
}

function isNetwork(seg: string): boolean {
  const word = commandWord(seg);
  if (NETWORK_COMMANDS.has(word)) return true;
  if (hasNetworkSubcommand(seg, word)) return true;
  if (/\bpython3?\s+-m\s+http\.server\b/.test(seg)) return true;
  if (INLINE_INTERP.test(seg) && INLINE_NETWORK.test(seg)) return true;
  if (/\/dev\/tcp\//.test(seg)) return true;
  return isUnknownWrapperNetworkCall(seg, word);
}

/**
 * `decode-pipe-shell` and `remote-pipe-shell` are named for a pipe, and they have to
 * mean one.
 *
 * They used to read the flat segment list, which `splitSegments` produces by cutting
 * on `|`, `;`, `&&`, `||` and newline with a single regex that keeps no record of
 * which separator it was. `curl x.sh | sh` and `curl x.sh; sh` therefore arrived as
 * the same two segments, and only the first is a fetch being executed.
 *
 * Measured on 4,902 distinct commands from this machine's own Codex and Claude
 * transcripts, the sequence reading denied 12 of them — every one an ordinary
 * `ssh host '…; python3 -c "…"'` diagnostic, since `python3` is in `SHELLS` and the
 * remote script's `;` put it in a later segment. The reason printed on those denials
 * was "executing decoded or remotely fetched code", which is false about that
 * command; on a tool whose product is the reason, that is the expensive kind of
 * defect. Nothing in the attack corpus depended on the loose reading: every
 * fetch-and-execute scenario there uses a real `|` or `bash <(curl …)`.
 *
 * What is given up is the accidental coverage of `curl -o f url; sh f`, where the
 * link between the two is a file rather than a pipe. That needs data flow, not
 * separator awareness, and the old reading caught it only by also catching
 * `curl url; ls`.
 *
 * Every other signal here is a property of one segment however it was reached, so
 * those keep reading the flat list.
 */
function encodedExecSignals(
  segments: readonly string[],
  pipelines: readonly (readonly string[])[],
  texts: readonly string[],
): { readonly encoded: string[]; readonly unparsed: string[] } {
  const encoded: string[] = [];
  const unparsed: string[] = [];
  // What the plain cut cannot say is read from the pipelines as the shell cuts them: a quoted
  // program (`python3 -c "import json; print(1)"`) is cut at its `;`, and what is left of it says
  // nothing. Where those are not sure of themselves, an interpreter is as it always was, a shell,
  // and a command that is not known to read is a question.
  const wantsRead = texts.some((text) => READ_PIPELINES_FOR.test(text) || carriesPipedData(text));
  // Read once, for whoever asks first: it costs a pass over the text.
  let lexed: ReturnType<typeof readEachText> | undefined;
  const lexedTexts = (): ReturnType<typeof readEachText> => (lexed ??= readEachText(texts));
  const read = wantsRead ? (lexedTexts()?.flat() ?? null) : null;
  const context = wantsRead ? consumerContext(texts, segments, read ?? []) : {};
  const consumerOf = (stage: string): PipeConsumer => {
    const word = commandWord(stage);
    if (isReadInterpreter(word) || isLineProcessor(word)) return read === null ? 'program' : 'none';
    const found = pipeConsumer(stage, word, isShell(stage), context);
    // Whole stages say whether a command reads; where there are none (the lexer was not sure), the
    // plain cut's stage is what there is, and a command that is not known to read is a question.
    return found === 'unknown' && read !== null ? 'none' : found;
  };
  for (const stages of pipelines)
    signalsOf(
      stages,
      consumerOf,
      encoded,
      unparsed,
      'decode-into-unknown-program',
      'fetch-into-unknown-program',
    );
  for (const stages of read ?? [])
    signalsOf(
      stages.map((stage) => stage.text),
      (stage) => pipeConsumer(stage, commandWord(stage), isShell(stage), context),
      encoded,
      unparsed,
      'decode-into-unknown-program',
      'fetch-into-unknown-program',
    );
  if (texts.some(codeInValue)) unparsed.push('code-in-value');
  // A command that fetches or decodes is read for what its text may run. Without one, text that the
  // command makes as it runs (a substitution or a variable) is read where it is a command or the
  // program of an interpreter: it needs an expansion to be there to be looked for.
  const fetchLine = segments.some(isFetchSource);
  if (fetchLine || texts.some((text) => text.includes('$') || text.includes('`'))) {
    const each = lexedTexts();
    const stageTexts = (found: readonly (readonly Stage[])[]): readonly (readonly string[])[] =>
      found.map((stages) => stages.map((stage) => stage.text));
    // The command as it was written is `texts[0]`; the others are what was read from it, and one that
    // is `( … )` from the first character is what `$(( … ))` held: an expression.
    const fetched = fetchedExecSignals({
      texts:
        each === null
          ? [{ pipelines, arithmetic: false }]
          : each.map((found, i) => ({
              pipelines: stageTexts(found),
              arithmetic: i > 0 && (texts[i] ?? '').startsWith('('),
            })),
      lineFetches: fetchLine,
      fetches: (text) => splitCommand(text, null).segments.some(isFetchSource),
    });
    encoded.push(...fetched.encoded);
    unparsed.push(...fetched.unparsed);
  }
  for (const seg of segments) {
    if (EVAL_DYNAMIC.test(seg) && !evalsInitTool(seg)) encoded.push('eval-dynamic');
    if (INLINE_INTERP.test(seg) && INLINE_PAYLOAD.test(seg))
      encoded.push('inline-interpreter-payload');
    if (SHELL_C_REMOTE.test(seg)) encoded.push('shell-c-remote');
    if (SHELL_PROC_SUB_REMOTE.test(seg)) encoded.push('shell-proc-sub-remote');
  }
  return { encoded, unparsed };
}

/** `eval "$(ssh-agent -s)"`: a tool that prints its own setup, which is what `eval` is for. */
function evalsInitTool(segment: string): boolean {
  const program = resolve(segment)?.evalProgram;
  return program !== null && program !== undefined && isInitSubstitution(program.text);
}

/** A Python or a Node, or a line processor, anywhere in a text: where an interpreter's command line is read. */
const READ_PIPELINES_FOR =
  /(?:python|pypy|node|awk|sed|make|\bat\b|batch|parallel|m4|\bed\b|\bex\b)/i;

/**
 * A superset of what `isNetwork` says, cheap to ask: a word that fetches or a tool that has a
 * subcommand that does, a `/dev/tcp`, a server, an inline program of an interpreter.
 */
const MAYBE_NETWORK = new RegExp(
  `\\b(?:${[...NETWORK_COMMANDS, ...Object.keys(NETWORK_SUBCOMMANDS)].join('|')})\\b|/dev/tcp/|http\\.server|\\b(?:python3?|node|perl|ruby)\\s+(?:-c|-e)\\b`,
);

/** Whether a stage may fetch or decode: a superset of what `isNetwork` and `DECODE` say. */
const maySource = (stage: string): boolean => DECODE.test(stage) || MAYBE_NETWORK.test(stage);

/** Whether a text may pipe a fetch or a decode into something: a `|`, and a stage that may fetch or decode. */
const carriesPipedData = (text: string): boolean => text.includes('|') && maySource(text);

/**
 * The pipelines of each text (the command, and each text nested in it), cut as the shell cuts them,
 * or null when any of them is not sure of what it read (an open quote, a substitution that does not
 * end).
 */
function readEachText(texts: readonly string[]): (readonly (readonly Stage[])[])[] | null {
  const out: (readonly (readonly Stage[])[])[] = [];
  for (const text of texts) {
    const lexed = lex(text);
    if (lexed.uncertain) return null;
    out.push(lexed.pipelines);
  }
  return out;
}

/**
 * What the whole command says about how its stages are read: the functions it defines (a stage that
 * calls one runs its body, not the program of that name), and whether the environment of a Python or
 * a Node is set anywhere in it (`export PYTHONINSPECT=1; curl … | python3 -c …` reads the input at a
 * prompt, and `NODE_OPTIONS=--require=/dev/stdin` loads it), with the quotes taken off the words so
 * that a name written in pieces is found.
 */
function consumerContext(
  texts: readonly string[],
  segments: readonly string[],
  read: readonly (readonly Stage[])[],
): ConsumerContext {
  const defined = new Set<string>();
  const note = (stage: string): void => {
    const found = resolve(stage);
    for (const name of found?.defined ?? []) defined.add(name);
    // `alias head=sh` and `hash -p ./evil head` make a name mean another program.
    if (found?.name === 'alias' || found?.name === 'hash')
      for (const word of found.args) {
        const eq = word.value.indexOf('=');
        if (found.name === 'alias' && eq > 0) defined.add(word.value.slice(0, eq));
        if (found.name === 'hash' && !word.value.startsWith('-')) defined.add(word.value);
      }
  };
  // What the lexer cut, where it was sure; what the plain cut made of the rest, where it was not.
  for (const stages of read) for (const stage of stages) note(stage.text);
  if (read.length === 0) segments.forEach(note);
  // As the shell reads the words: `export $'\x50ATH'=…` is `export PATH=…`.
  const flat = texts.map(flattened);
  return {
    defined,
    pythonPrompt: flat.some((text) => /PYTHON(?:INSPECT|STARTUP)/.test(text)),
    nodeOptions: flat.some((text) => /NODE_OPTIONS/.test(text)),
    untrusted: flat.some((text) => COMMAND_ENVIRONMENT.test(text)),
  };
}

/** Whether the stage is a decoder (`base64 -d`, `openssl base64 -d`, `xxd -r`) and not text that says so. */
function decodesAsCommand(stage: string): boolean {
  const found = resolve(stage);
  if (found === null || !/^(?:base64|openssl|xxd)$/.test(found.name)) return false;
  return DECODE.test([found.name, ...found.args.map((word) => word.value)].join(' '));
}

/** Whether a segment fetches (`curl`, `ssh`) or is a decoder: what prints text that something may run. */
const isFetchSource = (segment: string): boolean => isNetwork(segment) || decodesAsCommand(segment);

/** What the stages after one say about it: it is run, may be run by a program it cannot be read to be, or by one not known to read. */
interface After {
  readonly program: boolean;
  readonly unread: boolean;
  readonly unknown: boolean;
}

/**
 * Where a fetch or a decode is piped into something that runs, or into something that is not known to
 * only read: a program that takes it for its program, or runs code, is `exec_encoded`; one that could
 * not be read, or is not known to only read, is a question; one that only reads is nothing. Read from
 * the end of the pipeline back, once, so that the length of a pipeline costs no more than its stages.
 */
function signalsOf(
  stages: readonly string[],
  consumerOf: (stage: string) => PipeConsumer,
  encoded: string[],
  unparsed: string[],
  decodeUnknown: string,
  fetchUnknown: string,
): void {
  const first = stages.findIndex(maySource);
  // Nothing is run from what no stage fetches or decodes, and nothing follows the last stage.
  if (first === -1 || first === stages.length - 1) return;
  let program = false;
  let unread = false;
  let unknown = false;
  const after: (After | null)[] = new Array<After | null>(stages.length).fill(null);
  for (let i = stages.length - 1; i >= first; i -= 1) {
    const stage = stages[i] as string;
    if (maySource(stage)) after[i] = { program, unread, unknown };
    const consumer = consumerOf(stage);
    if (consumer === 'program' || consumer === 'inline-exec') program = true;
    else if (consumer === 'inline-unknown') unread = true;
    else if (consumer === 'unknown') unknown = true;
  }
  stages.forEach((stage, i) => {
    const here = after[i];
    if (here === null || here === undefined || (!here.program && !here.unread && !here.unknown))
      return;
    const decodes = DECODE.test(stage);
    const fetches = isNetwork(stage);
    if (here.program) {
      if (decodes) encoded.push('decode-pipe-shell');
      if (fetches) encoded.push('remote-pipe-shell');
    } else if (here.unread) {
      // A program of its own that cannot be read is a question: it may only read what it is given.
      if (decodes) unparsed.push('decode-into-inline-program');
      if (fetches) unparsed.push('fetch-into-inline-program');
    } else {
      // A command that is not known to only read what it is given may run it. The decode has to be
      // the command: `echo '… base64 -d …' | npx stroq hook` prints a string that says it.
      if (decodes && decodesAsCommand(stage)) unparsed.push(decodeUnknown);
      if (fetches) unparsed.push(fetchUnknown);
    }
  });
}

/**
 * A segment that runs `ssh` or `sshpass` is a command for another machine, which
 * `remoteClassification` reads with its own rules (`/tmp` is scratch there); read here as
 * well, `ssh prod rm -rf /tmp/build` was a local delete of `/tmp/build`. Past the depth the
 * remote reader stops at, the local reading is all there is, and it stays.
 */
function destructiveSignals(segments: readonly string[], cwd: string, depth: number): string[] {
  return segments.flatMap((seg) => {
    if (depth < 2 && /^ssh(?:pass)?$/.test(commandWord(seg))) return [];
    const found = DESTRUCTIVE.filter(([re]) => re.test(seg)).map(([, name]) => name);
    if (findDeletesDangerousRoot(seg, cwd)) found.push('find-delete-dangerous-root');
    return rmIsDangerous(seg, cwd) ? [...found, 'rm-dangerous-target'] : found;
  });
}

function pushExternalSignals(segments: readonly string[]): string[] {
  return segments.flatMap((seg) => [
    ...(PUSH_EXTERNAL.test(seg) ? ['git-push-external'] : []),
    ...(GH_REPO_CREATE_PUSH.test(seg) ? ['gh-repo-create-push'] : []),
  ]);
}

function secretSignals(segments: readonly string[]): string[] {
  return segments.flatMap((seg) => {
    const signals = SECRET_PATTERNS.filter((re) => re.test(seg)).map(
      (re) => `secret:${re.source.slice(0, 20)}`,
    );
    return ENV_DUMP.test(seg) ? [...signals, 'env-dump'] : signals;
  });
}

function hostsOf(command: string): string[] {
  const hosts = [...command.matchAll(URL_HOST), ...command.matchAll(SSH_TARGET)].map(
    (m) => m[1] ?? '',
  );
  return [...new Set(hosts.filter((h) => h.length > 0))];
}

/** A classification with each class's own signals kept apart, for callers that remap classes. */
export interface CommandGroups {
  readonly groups: ReadonlyArray<readonly [ActionClass, readonly string[]]>;
  readonly hosts: readonly string[];
}

/** What a caller that has already done part of the reading hands on, so that it is not done twice. */
export interface ClassifyOptions {
  /** The programs the shells in the command are handed, when they have been read. */
  readonly decoded?: ShellInput;
  /** The meter that bounds the decoded text of this command and of the commands nested in it. */
  readonly budget?: Budget;
  /** The command cut into segments, when the caller has done it: it is not cut again. */
  readonly split?: SplitCommand;
  /**
   * The functions of the command that this one is a program of: it calls them as it calls its own. Null
   * for a text that is an approximation of a program and not one (a script read with its variables
   * replaced), which is not read for the functions it calls.
   */
  readonly functions?: readonly FunctionDefinition[] | null;
  /** What is left to spend on reading the functions of the command that this one is a program of. */
  readonly room?: FunctionRoom;
  /** How long the reading may take, in milliseconds: for a caller that waits less than the host does, and for the tests. */
  readonly deadlineMs?: number;
}

export function classifyCommand(
  command: string,
  cwd: string,
  depth = 0,
  options: ClassifyOptions = {},
): CommandClassification {
  const { groups, hosts } = classifyCommandGroups(command, cwd, depth, options);
  return {
    classes: groups.map(([cls]) => cls),
    hosts,
    signals: groups.flatMap(([, signals]) => signals),
  };
}

/**
 * The classes of the programs a shell is handed on its standard input, each read as the
 * command it is, and `shell.unparsed` for one that cannot be read: a shell running something
 * nobody could see is asked about, so an evasion of the decoding ends in a question. The
 * programs of every level of nesting arrive together (see `decodePrograms`), so none is decoded
 * again here.
 */
function programClassification(
  input: ShellInput,
  cwd: string,
  depth: number,
  budget: Budget,
  functions: readonly FunctionDefinition[] | null,
  room: FunctionRoom,
): Array<readonly [ActionClass, string[]]> {
  const found = new Map<ActionClass, string[]>();
  const add = (cls: ActionClass, signal: string): void => {
    found.set(cls, [...(found.get(cls) ?? []), signal]);
  };
  const addRemote = (cls: ActionClass, signal: string): void => add(cls, `ssh-remote:${signal}`);
  input.texts.forEach((text, n) => {
    // What a shell `ssh` started is handed runs on the server: it is judged as a command sent
    // over `ssh` is, and not as one run here.
    if (input.remote[n] === true) {
      if (depth < 2)
        remoteTextClassification(
          text,
          cwd,
          depth,
          budget,
          addRemote,
          classifyCommandGroups,
          NO_INPUT,
          room,
        );
      return;
    }
    for (const [cls, signals] of classifyCommandGroups(text, cwd, depth + 1, {
      decoded: NO_INPUT,
      functions,
      room,
    }).groups)
      for (const signal of signals) add(cls, `shell-input:${signal}`);
  });
  if (input.opaque) add('shell.unparsed', 'opaque-shell-input');
  return [...found.entries()];
}

/** The command cut again where the programs it hands to shells define functions that it does not know. */
function withProgramFunctions(
  command: string,
  split: SplitCommand,
  decoded: ShellInput,
  given: readonly FunctionDefinition[] | null | undefined,
): SplitCommand {
  if (given === null) return split;
  const known = new Set(split.functions.map(functionKey));
  const extra = inheritedFunctions(decoded.texts).definitions.filter(
    (definition) => !known.has(functionKey(definition)),
  );
  if (extra.length === 0) return split;
  return splitCommand(command, [...(given ?? []), ...extra], split.room);
}

export function classifyCommandGroups(
  command: string,
  cwd: string,
  depth = 0,
  options: ClassifyOptions = {},
): CommandGroups {
  // A command too costly to read is not read (see `readingCost`): a caller that reaches here
  // without `classifyTool` is held to the same bound.
  if (depth === 0 && isTooCostly(command))
    return { groups: [['shell.unparsed', ['command-too-large']]], hosts: [] };
  // And one that takes longer than the clock allows is stopped, and asked about (see `deadline.ts`).
  if (depth === 0)
    return withDeadline(
      options.deadlineMs ?? READING_DEADLINE_MS,
      () => readCommandGroups(command, cwd, depth, options),
      () => ({ groups: [['shell.unparsed', ['reading-took-too-long']]], hosts: [] }),
    );
  return readCommandGroups(command, cwd, depth, options);
}

function readCommandGroups(
  command: string,
  cwd: string,
  depth: number,
  options: ClassifyOptions,
): CommandGroups {
  const budget = options.budget ?? newBudget(command.length);
  const first = options.split ?? splitCommand(command, options.functions, options.room);
  // What the programs that a shell is handed define is in force where the command calls it, when that shell
  // is the one that runs the command (`source <(echo 'f() { …; }'); f -rf ~`): the command is read once
  // more with them.
  const decoded = options.decoded ?? decodePrograms(command, budget, first);
  const split = withProgramFunctions(command, first, decoded, options.functions);
  const { segments, pipelines, truncated } = split;
  // Cut where the shell cuts, not inside a quoted string (see `splitTopQuoted`).
  const shellSegments = commandSegments(command, split);
  const selfConfig = selfTamperSignals(segments);
  const stroqState = stroqStateReading(command, split, options.functions);
  // The PowerShell and cmd forms of the same four dangers, merged into the same
  // classes rather than given their own. A dangerous command is dangerous whichever
  // shell wrote it, and a policy rule naming `shell.exec_encoded` must not have to
  // name a Windows twin of it as well. `shell.unparsed` is the one class that IS
  // new, because "I could not read what this runs" is not any of the four.
  const ps = powershellSignals(segments, pipelines, cwd);
  const exec = encodedExecSignals(segments, pipelines, split.texts);
  const groups: ReadonlyArray<readonly [ActionClass, readonly string[]]> = [
    ['shell.exec_encoded', [...exec.encoded, ...ps.encoded]],
    ['shell.network', [...segments.filter(isNetwork).map(() => 'network-command'), ...ps.network]],
    [
      'shell.destructive',
      [
        ...destructiveSignals(segments, cwd, depth),
        ...(xargsRemovesDangerousRoot(pipelines, cwd) ? ['xargs-rm-dangerous-root'] : []),
        ...ps.destructive,
      ],
    ],
    ['fs.secrets', [...secretSignals(segments), ...ps.secrets]],
    ['git.push_external', pushExternalSignals(segments)],
    ['config.self', [...selfConfig.deny, ...stroqState.signals]],
    ['config.self_touch', selfConfig.ask],
    ['config.git_exec', gitExecSignals(segments)],
    ['config.instructions', instructionWriteSignals(segments)],
    ['config.persistence', persistenceSignals(shellSegments, command, cwd, jobStages(split.texts))],
    // Too much nesting to read is not reading it: see `nestedBudget`.
    [
      'shell.unparsed',
      [
        ...exec.unparsed,
        ...ps.unparsed,
        ...gitUnparsedSignals(segments),
        ...(truncated ? ['nested-commands-too-large'] : []),
        ...(split.functionsUnread || stroqState.unread ? ['function-call-not-read'] : []),
      ],
    ],
  ];
  const remote = [
    ...remoteClassification(
      command,
      segments,
      cwd,
      depth,
      budget,
      classifyCommandGroups,
      split.room,
    ),
    ...programClassification(
      decoded,
      cwd,
      depth,
      budget,
      options.functions === null ? null : split.functions,
      split.room,
    ),
  ];
  const merged = groups.map(([cls, signals]) => {
    const extra = remote.filter(([c]) => c === cls).flatMap(([, more]) => more);
    return [cls, [...signals, ...extra]] as const;
  });
  for (const [cls, more] of remote) {
    if (!groups.some(([c]) => c === cls)) merged.push([cls, more] as const);
  }
  return {
    groups: merged.filter(([, signals]) => signals.length > 0),
    hosts: hostsOf(command),
  };
}
