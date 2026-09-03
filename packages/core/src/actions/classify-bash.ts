import type { ActionClass } from '../types.js';
import { commandWord, firstArgAfter, splitSegments } from './shell-segments.js';

export interface CommandClassification {
  readonly classes: readonly ActionClass[];
  readonly hosts: readonly string[];
  readonly signals: readonly string[];
}

export { commandWord, splitSegments } from './shell-segments.js';

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
const URL_HOST = /https?:\/\/([^\s/'"`:]+)/g;
const SSH_TARGET = /\b[\w.-]+@([\w-]+(?:\.[\w-]+)+)/g;
const DECODE = /\b(base64\s+(-d|--decode|-D)|openssl\s+(base64|enc)\s+-d|xxd\s+-r)\b/;
const EVAL_DYNAMIC = /\beval\b[^\n]*(\$\(|`|\$\{?\w)/;
const INLINE_INTERP = /\b(python3?|node|perl|ruby)\s+(-c|-e)\b/;
const INLINE_PAYLOAD =
  /(exec\(|base64|__import__|atob\(|Buffer\.from\([^)]*base64|child_process|subprocess|os\.system)/;
const INLINE_NETWORK = /(urllib|requests|socket|http\.client|fetch\(|http\.request|net\.connect)/;
const SHELL_C_REMOTE = /\b(ba|z|da)?sh\s+-c\s+["']?\$\((curl|wget)\b/;
// `bash|sh|zsh|source|.` piping a process substitution straight into the
// shell — `bash <(curl ...)` / `source <(curl ...)`. The substitution's
// inner text is also split out as its own segment by shell-segments.ts, so
// this only needs to add the `shell.exec_encoded` signal; `shell.network`
// comes from that extracted inner segment matching `isNetwork` on its own.
const SHELL_PROC_SUB_REMOTE = /\b(bash|sh|zsh|dash|ksh|source|\.)\b[^\n]*<\(\s*(curl|wget)\b/;
const DESTRUCTIVE: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bgit\s+reset\s+--hard\b/, 'git-destructive'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git-destructive'],
  [/\bgit\s+checkout\s+(--\s+)?\.\s*$/, 'git-destructive'],
  [/\bgit\s+restore\s+\.\s*$/, 'git-destructive'],
  [/\bgit\s+push\b[^\n]*(--force|\s-f\b)/, 'git-destructive'],
  [/\bgit\s+branch\s+-D\b/, 'git-destructive'],
  [/\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i, 'sql-destructive'],
  [/\bmkfs(\.\w+)?\b/, 'disk-destructive'],
  [/\bdd\b[^\n]*\bof=\/dev\/(?!null\b|zero\b)/, 'disk-destructive'],
  [/\bshred\b/, 'disk-destructive'],
  [/\bwipefs\b/, 'disk-destructive'],
  [/\bchmod\s+-R\s+777\s+\//, 'chmod-root'],
  [/>\s*\/dev\/(sd|nvme|disk)/, 'write-device'],
  [/\bkill\s+-9\s+-1\b/, 'kill-all'],
];
const SECRET_PATTERNS: readonly RegExp[] = [
  /(^|[\s"'/=])~?\/?\.ssh(\/|\b)/,
  /\bid_(rsa|ed25519|ecdsa|dsa)\b/,
  /\.aws\/(credentials|config)\b/,
  // `@` is included so `-f body=@.env` / `-d @.env` (a file-upload argument,
  // not a literal path segment) is also recognised.
  /(^|[\s"'/=@])\.env(\.[\w-]+)?\b/,
  /\.(pem|p12|pfx|key)\b/,
  /\.(npmrc|netrc|pgpass|git-credentials)\b/,
  /\.kube\/config\b/,
  /\.config\/gcloud\b/,
  /\/etc\/(shadow|passwd)\b/,
  /\bsecurity\s+find-(generic|internet)-password\b/,
  /\/proc\/[^\s]*\/environ\b/,
];
const ENV_DUMP = /^(env|printenv|set|export)\s*$/;
const PUSH_EXTERNAL =
  /\bgit\s+(push\b[^\n]*\b(https?:\/\/|git@|ssh:\/\/)|remote\s+(add|set-url)\b)/;
// `.claude` and `.stroq` are matched as bare directories (like `find .claude
// -name settings.json -delete`, where the filename never appears adjacent to
// the directory in the same token) — not just the specific
// `.claude/settings.json` path. `.cursor` stays scoped to its one protected
// file since nothing else under it is agent-security-relevant today.
const SELF_CONFIG = /(\.claude(\/|\b)|\.cursor\/hooks\.json|\.stroq(\/|\b))/;
// Self-tamper gate: a segment that mentions a protected path is classified
// into one of three buckets:
//   - `config.self` (deny)       — clear write intent against the path
//   - no class                   — a known read-only command, no redirection
//   - `config.self_touch` (ask)  — everything else (unknown commands,
//                                  editors, interpreters without inline code)
// This replaces the previous deny-unless-read gate, which denied harmless
// references (`git add`, `echo`, `mkdir ~/.stroq`, …) alongside real tamper
// attempts.
const SELF_CONFIG_READ_COMMANDS = new Set([
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
const SELF_CONFIG_WRITE_COMMANDS = new Set([
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
// `find` is read-only by default (in SELF_CONFIG_READ_COMMANDS), but any of
// these primaries give it write/delete intent regardless of the path
// mentioned, e.g. `find ~/.stroq -delete` or `find . -exec rm -rf {} \;`.
const FIND_WRITE_PRIMARIES = /-(delete|exec|execdir|ok|okdir|fprint|fprintf)\b/;

function isInlineCodeToken(token: string): boolean {
  if (!/^-[A-Za-z]+$/.test(token)) return false;
  return /[ec]/.test(token.slice(1));
}

function hasInlineCode(segment: string): boolean {
  return segment.split(/\s+/).some(isInlineCodeToken);
}

function isSelfConfigWriteIntent(segment: string, word: string): boolean {
  if (SELF_CONFIG_WRITE_COMMANDS.has(word)) return true;
  if (SELF_CONFIG_INTERPRETERS.has(word) && hasInlineCode(segment)) return true;
  if (segment.includes('>')) return true;
  if (word === 'git' && GIT_WRITE_SUBCOMMAND.test(segment)) return true;
  if (word === 'find' && FIND_WRITE_PRIMARIES.test(segment)) return true;
  return false;
}

function isSelfConfigReadOnly(segment: string, word: string): boolean {
  if (SELF_CONFIG_READ_COMMANDS.has(word)) return true;
  if (word === 'git' && GIT_READ_SUBCOMMAND.test(segment)) return true;
  if (SELF_CONFIG_INTERPRETERS.has(word) && !hasInlineCode(segment)) return true;
  return false;
}

export function isDangerousRmTarget(target: string, cwd: string): boolean {
  const t = target.replace(/["']/g, '');
  if (t === '') return false;
  if (['/', '/*', '~', '~/', '~/*', '.', './', '*', './*'].includes(t)) return true;
  if (t.startsWith('$') || t.startsWith('..')) return true;
  if (!t.startsWith('/')) return false;
  const normalized = t.replace(/\/+$/, '');
  return !normalized.startsWith(`${cwd}/`);
}

function rmIsDangerous(segment: string, cwd: string): boolean {
  const tokens = segment.split(/\s+/);
  const rmIndex = tokens.findIndex((t) => t.replace(/^.*\//, '') === 'rm');
  if (rmIndex < 0) return false;
  const args = tokens.slice(rmIndex + 1);
  const recursive = args.some(
    (a) => a === '--recursive' || (/^-[A-Za-z]+$/.test(a) && /[rR]/.test(a)),
  );
  if (!recursive) return false;
  return args.filter((a) => !a.startsWith('-')).some((a) => isDangerousRmTarget(a, cwd));
}

const isShell = (seg: string): boolean => SHELLS.has(commandWord(seg));

function hasNetworkSubcommand(seg: string, word: string): boolean {
  const subcommands = NETWORK_SUBCOMMANDS[word];
  return subcommands !== undefined && subcommands.has(firstArgAfter(seg));
}

function isNetwork(seg: string): boolean {
  const word = commandWord(seg);
  if (NETWORK_COMMANDS.has(word)) return true;
  if (hasNetworkSubcommand(seg, word)) return true;
  if (/\bpython3?\s+-m\s+http\.server\b/.test(seg)) return true;
  if (INLINE_INTERP.test(seg) && INLINE_NETWORK.test(seg)) return true;
  return /\/dev\/tcp\//.test(seg);
}

function encodedExecSignals(segments: readonly string[]): string[] {
  return segments.flatMap((seg, i) => {
    const later = segments.slice(i + 1);
    const signals: string[] = [];
    if (DECODE.test(seg) && later.some(isShell)) signals.push('decode-pipe-shell');
    if (isNetwork(seg) && later.some(isShell)) signals.push('remote-pipe-shell');
    if (EVAL_DYNAMIC.test(seg)) signals.push('eval-dynamic');
    if (INLINE_INTERP.test(seg) && INLINE_PAYLOAD.test(seg))
      signals.push('inline-interpreter-payload');
    if (SHELL_C_REMOTE.test(seg)) signals.push('shell-c-remote');
    if (SHELL_PROC_SUB_REMOTE.test(seg)) signals.push('shell-proc-sub-remote');
    return signals;
  });
}

function destructiveSignals(segments: readonly string[], cwd: string): string[] {
  return segments.flatMap((seg) => {
    const found = DESTRUCTIVE.filter(([re]) => re.test(seg)).map(([, name]) => name);
    return rmIsDangerous(seg, cwd) ? [...found, 'rm-dangerous-target'] : found;
  });
}

function secretSignals(segments: readonly string[]): string[] {
  return segments.flatMap((seg) => {
    const signals = SECRET_PATTERNS.filter((re) => re.test(seg)).map(
      (re) => `secret:${re.source.slice(0, 20)}`,
    );
    return ENV_DUMP.test(seg) ? [...signals, 'env-dump'] : signals;
  });
}

type SelfConfigVerdict = 'deny' | 'ask' | null;

function classifySelfConfigSegment(segment: string): SelfConfigVerdict {
  if (!SELF_CONFIG.test(segment)) return null;
  const word = commandWord(segment);
  if (isSelfConfigWriteIntent(segment, word)) return 'deny';
  if (isSelfConfigReadOnly(segment, word)) return null;
  return 'ask';
}

interface SelfConfigSignals {
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

function selfTamperSignals(segments: readonly string[]): SelfConfigSignals {
  const interpreterInlineElsewhere = anySegmentIsInterpreterInlineCode(segments);
  const deny: string[] = [];
  const ask: string[] = [];
  for (const segment of segments) {
    const verdict = classifySelfConfigSegment(segment);
    if (verdict === 'deny' || (verdict === 'ask' && interpreterInlineElsewhere)) {
      deny.push('self-config-write');
    } else if (verdict === 'ask') {
      ask.push('self-config-touch');
    }
  }
  return { deny, ask };
}

function hostsOf(command: string): string[] {
  const hosts = [...command.matchAll(URL_HOST), ...command.matchAll(SSH_TARGET)].map(
    (m) => m[1] ?? '',
  );
  return [...new Set(hosts.filter((h) => h.length > 0))];
}

export function classifyCommand(command: string, cwd: string): CommandClassification {
  const segments = splitSegments(command);
  const selfConfig = selfTamperSignals(segments);
  const groups: ReadonlyArray<readonly [ActionClass, readonly string[]]> = [
    ['shell.exec_encoded', encodedExecSignals(segments)],
    ['shell.network', segments.filter(isNetwork).map(() => 'network-command')],
    ['shell.destructive', destructiveSignals(segments, cwd)],
    ['fs.secrets', secretSignals(segments)],
    [
      'git.push_external',
      segments.filter((s) => PUSH_EXTERNAL.test(s)).map(() => 'git-push-external'),
    ],
    ['config.self', selfConfig.deny],
    ['config.self_touch', selfConfig.ask],
  ];
  const active = groups.filter(([, signals]) => signals.length > 0);
  return {
    classes: active.map(([cls]) => cls),
    hosts: hostsOf(command),
    signals: active.flatMap(([, signals]) => signals),
  };
}
