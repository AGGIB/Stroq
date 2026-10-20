// What one call of a session can do with a file an earlier call wrote a key into, read once.
//
// The rules that use it are coarse on purpose (`analyze.ts`): a later call that can send and names
// the file, or the folder it is in, sent it; one that can send and uploads files, or follows an
// archive, may have; one that runs a program and names it may have run it. So all that is read
// here is the call's text as the shell joins it, in lower case, and a few facts of its stages.
import { basename } from 'node:path';
import { commandUrls, type Word } from '@stroq/core';
import { plainText } from './key-text.js';
import { isProgramName } from './names.js';
import { isLoopback } from './place.js';
import { COPIERS } from './shell-place.js';
import {
  commandReading,
  MAX_READ_CHARS,
  readBudgetLeft,
  type CommandReading,
  type StageFacts,
} from './shell-read.js';
import { allStages, commandSends, halfSender, runStages, stageSends } from './shell-route.js';

export interface CallFacts {
  /** The call's text, quotes and backslashes taken out, in lower case: names are looked for in it. */
  readonly text: string;
  /** The core's reading of a shell command, or null for another tool or one too long to read. */
  readonly reading: CommandReading | null;
  /** It can send: a request, a sender, `gh`, a `git` that talks to a remote, a publish. */
  readonly sends: boolean;
  /** It sends files: `-T`, `-F`, `@file`, `--data-binary`, `scp`, `rsync`, `nc < f`, an archive. */
  readonly uploads: boolean;
  /** It makes an archive (`tar`, `zip`, `7z`, `cpio`, `git bundle`): of what, it need not say. */
  readonly archives: boolean;
  /** The program of the first stage that runs one, as a phrase names it; null when none does. */
  readonly runs: string | null;
  /** The program that sends, as a phrase names it. */
  readonly sender: string;
  /** The first host it names, and whether that is this machine. */
  readonly host?: string;
  readonly local?: true;
  /** The names of what it writes, copies or archives to, and of what it copies: lower case. */
  readonly outputs: readonly string[];
  /** The names of the archives it makes. */
  readonly archiveOutputs: readonly string[];
  /** How a later call may name what it set a variable to: `$f` and `${f` for `F=…`, lower case. */
  readonly assigns: readonly string[];
  /** More names than are kept (outputs, archives, variables): a dropped one may name a file. */
  readonly namesCut?: true;
}

/** Programs that make an archive of what they are given, or of a folder. */
const ARCHIVERS: ReadonlySet<string> = new Set([
  'tar',
  'gtar',
  'bsdtar',
  'zip',
  '7z',
  '7za',
  '7zr',
  'cpio',
  'pax',
  'jar',
  'rar',
  'ar',
  'gzip',
  'bzip2',
  'xz',
  'zstd',
  'pigz',
  'lz4',
  'lzma',
]);

/** Programs that send the files they are given, whatever their words. */
const FILE_SENDERS: ReadonlySet<string> = new Set([
  'scp',
  'sftp',
  'rsync',
  'rclone',
  'gsutil',
  'azcopy',
  's3cmd',
  'ftp',
  'lftp',
]);
/** Programs that send what they read: given a file (`nc host < f`) or piped one, they send it. */
const SOCKETS: ReadonlySet<string> = new Set([
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'websocat',
]);
/** Options that upload a file or send one as a body. */
const UPLOAD_OPTION =
  /^(?:-T|--upload-file|-F|--form|--form-string|--data-binary|--post-file|--body-file|--upload|--attach)/;
/** Words of a cloud tool or `gh` that send files. */
const UPLOAD_VERBS: ReadonlySet<string> = new Set([
  'cp',
  'sync',
  'mv',
  'put-object',
  'upload',
  'gist',
]);

/** Names that name no file of their own. */
const NOT_NAMES: ReadonlySet<string> = new Set(['', '.', '..', '-', '/']);
/** Names one call adds, at most. */
const MAX_OUTPUTS = 32;

const valuesOf = (facts: StageFacts): string[] =>
  (facts.resolved?.args ?? []).filter((w) => !w.redirect).map((w) => w.value);

/** A name as the rules compare it: the last part of a path, in lower case. */
export function nameOf(path: string): string {
  const name = basename(path.replace(/\\/g, '/').replace(/\/+$/, '')).toLowerCase();
  return NOT_NAMES.has(name) ? '' : name;
}

/** Whether a stage sends files, by its program and words. */
function stageUploads(facts: StageFacts, piped: boolean): boolean {
  if (FILE_SENDERS.has(facts.name)) return true;
  const args: readonly Word[] = facts.resolved?.args ?? [];
  const words = valuesOf(facts);
  if (words.some((w) => UPLOAD_OPTION.test(w) || w.startsWith('@') || w.includes('=@')))
    return true;
  if (words.some((w) => /^-[A-Za-z]*d@/.test(w))) return true;
  if (SOCKETS.has(facts.name))
    return piped || args.some((w) => w.redirect && /^\d*<(?!<)/.test(w.value));
  return (
    (facts.name === 'aws' || facts.name === 'gh' || facts.name === 'gcloud') &&
    words.some((w) => UPLOAD_VERBS.has(w))
  );
}

/** Whether a stage makes an archive. */
function stageArchives(facts: StageFacts): boolean {
  if (ARCHIVERS.has(facts.name)) return true;
  return facts.name === 'git' && valuesOf(facts).includes('bundle');
}

/** The names a stage writes, copies or archives to, and those of what it copies. */
function stageOutputs(facts: StageFacts, archive: boolean): string[] {
  const out = facts.writes.map(nameOf);
  const words = valuesOf(facts).filter((w) => !w.startsWith('-'));
  if (facts.name === 'git') {
    const at = words.indexOf('create');
    if (archive && at >= 0) out.push(nameOf(words[at + 1] ?? ''));
  } else if (archive || COPIERS.has(facts.name)) out.push(...words.map(nameOf));
  return out.filter((name) => name !== '');
}

const unique = (names: readonly string[]): string[] => [...new Set(names)].slice(0, MAX_OUTPUTS);
const past = (names: readonly string[]): boolean => new Set(names).size > MAX_OUTPUTS;

/** A name set where a word starts: `F=…`, `export F=…`, `env F=… cmd`. */
const ASSIGNED = /(?:^|[\s(;&|])([A-Za-z_][A-Za-z0-9_]*)=/g;

/**
 * How a later call may use the variables a command sets: `$f` and `${f`, in lower case, and
 * whether it set more than are kept.
 */
function assignedUses(command: string): { readonly uses: string[]; readonly cut: boolean } {
  const names = new Set<string>();
  for (const match of command.matchAll(ASSIGNED)) {
    const name = (match[1] as string).toLowerCase();
    if (!names.has(name) && names.size >= MAX_OUTPUTS / 2) {
      return { uses: usesOf(names), cut: true };
    }
    names.add(name);
  }
  return { uses: usesOf(names), cut: false };
}

const usesOf = (names: ReadonlySet<string>): string[] =>
  [...names].flatMap((name) => [`$${name}`, `\${${name}`]);

/** The facts of a call no reader could read: it may do anything. */
function unreadCall(text: string): CallFacts {
  const assigned = assignedUses(text);
  return {
    text,
    reading: null,
    sends: true,
    uploads: true,
    archives: true,
    runs: '',
    sender: '',
    outputs: [],
    archiveOutputs: [],
    assigns: assigned.uses,
    ...(assigned.cut ? { namesCut: true as const } : {}),
  };
}

/** The facts of one shell command, read once. */
export function shellCallFacts(command: string, cwd: string | null): CallFacts {
  const text = plainText(command);
  if (command.length > MAX_READ_CHARS || !readBudgetLeft()) return unreadCall(text);
  const reading = commandReading(command, cwd);
  const sends = commandSends(reading);
  let uploads = false;
  let archives = false;
  let runs: string | null = null;
  let sender = '';
  let half = false;
  const outputs: string[] = [];
  const archiveOutputs: string[] = [];
  const ran = new Set(runStages(reading));
  for (const stage of allStages(reading)) {
    const facts = reading.facts(stage);
    const named = isProgramName(facts.name) ? facts.name : '';
    const archive = stageArchives(facts);
    if (stageSends(facts) && sender === '') sender = named;
    if (!facts.inert && runs === null && ran.has(stage)) runs = named;
    if (halfSender(facts)) half = true;
    uploads ||= stageUploads(facts, stage.piped);
    archives ||= archive;
    outputs.push(...stageOutputs(facts, archive));
    if (archive) archiveOutputs.push(...stageOutputs(facts, true));
  }
  const host = commandUrls(command, 1).urls[0]?.host.toLowerCase() ?? '';
  // A mailer or `openssl s_client` that names where it sends is a sender too.
  const reaches = sends || (half && host !== '');
  const assigned = assignedUses(command);
  const namesCut = past(outputs) || past(archiveOutputs) || assigned.cut;
  return {
    text,
    reading,
    sends: reaches,
    uploads: reaches && (uploads || archives),
    archives,
    runs,
    sender,
    ...(host === '' ? {} : { host, ...(isLoopback(host) ? { local: true as const } : {}) }),
    outputs: unique(outputs),
    archiveOutputs: unique(archiveOutputs),
    assigns: assigned.uses,
    ...(namesCut ? { namesCut: true as const } : {}),
  };
}

/**
 * The facts of a call that is no shell command: an MCP call. One to a server elsewhere sends what
 * it is given; one to a server on this machine, or one no config names, runs a program with it.
 */
export function toolCallFacts(text: string, remote: boolean | null): CallFacts {
  return {
    text: plainText(text),
    reading: null,
    sends: remote === true,
    uploads: false,
    archives: false,
    runs: remote === true ? null : '',
    sender: '',
    outputs: [],
    archiveOutputs: [],
    assigns: [],
  };
}

/** Whether a command runs in the background: a lone `&`, not `&&`, `>&`, `&>` or `|&`. */
export const inBackground = (command: string): boolean => /(?:^|[^&>|])&(?![&>])/.test(command);
