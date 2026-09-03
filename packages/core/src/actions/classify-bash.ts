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
const SELF_CONFIG = /(\.claude\/settings(\.local)?\.json|\.cursor\/hooks\.json|\.stroq(\/|\b))/;
// Deny-unless-read: any segment that mentions a protected path is
// `config.self` UNLESS its command word is a known read-only tool AND the
// segment has no write redirection. This replaces the previous
// allow-unless-on-a-write-list gate, which any command not on the write
// list (python, perl, jq|sponge, git checkout, …) could bypass.
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
]);
// A pipe into these always counts as a write even without `>` in that segment.
const WRITE_REDIRECT_COMMANDS = new Set(['sponge', 'tee']);

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

function isWriteSegment(seg: string): boolean {
  return seg.includes('>') || WRITE_REDIRECT_COMMANDS.has(commandWord(seg));
}

function selfTamperSignals(segments: readonly string[]): string[] {
  return segments
    .filter((seg) => {
      if (!SELF_CONFIG.test(seg)) return false;
      const isReadOnly = SELF_CONFIG_READ_COMMANDS.has(commandWord(seg)) && !isWriteSegment(seg);
      return !isReadOnly;
    })
    .map(() => 'self-config-write');
}

function hostsOf(command: string): string[] {
  const hosts = [...command.matchAll(URL_HOST), ...command.matchAll(SSH_TARGET)].map(
    (m) => m[1] ?? '',
  );
  return [...new Set(hosts.filter((h) => h.length > 0))];
}

export function classifyCommand(command: string, cwd: string): CommandClassification {
  const segments = splitSegments(command);
  const groups: ReadonlyArray<readonly [ActionClass, readonly string[]]> = [
    ['shell.exec_encoded', encodedExecSignals(segments)],
    ['shell.network', segments.filter(isNetwork).map(() => 'network-command')],
    ['shell.destructive', destructiveSignals(segments, cwd)],
    ['fs.secrets', secretSignals(segments)],
    [
      'git.push_external',
      segments.filter((s) => PUSH_EXTERNAL.test(s)).map(() => 'git-push-external'),
    ],
    ['config.self', selfTamperSignals(segments)],
  ];
  const active = groups.filter(([, signals]) => signals.length > 0);
  return {
    classes: active.map(([cls]) => cls),
    hosts: hostsOf(command),
    signals: active.flatMap(([, signals]) => signals),
  };
}
