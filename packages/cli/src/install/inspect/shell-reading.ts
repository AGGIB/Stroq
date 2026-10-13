// One piece of shell text, read by the shell classifier of Stroq's firewall.
//
// This is the same reader that judges a command before an agent runs it, pointed at text that was
// found in an artifact. Nothing is run: it splits the text, follows quotes, pipes, substitutions and
// the shells it hands programs to, and says what classes of action the text would be. What comes out
// is turned here into a plain `Reading` (hosts, credential files, signals, programs, and whether
// something could not be read), which `shell-lines.ts` turns into lines.
import {
  SECRET_PATTERNS,
  classifyCommandGroups,
  commandUrls,
  commandWord,
  isClockSignal,
  isLimitSignal,
  splitSegments,
  type ActionClass,
} from '@stroq/core';

/**
 * Where the text is read as if it ran. A fixed place that is not on any machine: the reading judges a
 * delete of something outside it as dangerous, and the same text must give the same answer anywhere.
 */
const READ_CWD = '/stroq-vet/artifact';
/** How long one reading may take, in milliseconds. The classifier checks its clock as it goes. */
const READ_DEADLINE_MS = 3000;
/** The most addresses, credential files and programs kept from one piece of text. */
const MAX_PER_KIND = 50;
const MAX_PROGRAMS = 200;
/** A word of a command longer than this is not a program name. */
const PROGRAM_MAX = 100;

export interface HostFound {
  /** The host, or null when the address is built at run time and has none to read. */
  readonly host: string | null;
  /** The text of the address as written, to find its line. */
  readonly url: string;
}

/** A class of action the text would be, with the names of the rules that said so. */
export interface ClassFound {
  readonly action: ActionClass;
  readonly ids: readonly string[];
}

export interface Reading {
  readonly hosts: readonly HostFound[];
  /** True when a command that talks to the network was recognised. */
  readonly talksToNetwork: boolean;
  /** Credential files named, as written. Empty strings are not kept. */
  readonly credentialFiles: readonly string[];
  readonly hasCredentialFile: boolean;
  /** Classes that are signals to look at. */
  readonly classes: readonly ClassFound[];
  /** Why the text could not be read, or null. */
  readonly unreadable: null | 'unparsed' | 'too-large' | 'too-slow';
  /** The rule names behind an `unparsed`. */
  readonly unparsedIds: readonly string[];
  readonly programs: readonly string[];
  /** True when a command word is made at run time (`$CMD`, a substitution). */
  readonly dynamicProgram: boolean;
}

/** The classes that are shown as signals; the others (network, secrets, unparsed) have lines of their own. */
const SIGNAL_CLASSES: readonly ActionClass[] = [
  'shell.exec_encoded',
  'shell.destructive',
  'config.persistence',
  'config.git_exec',
  'config.self',
  'config.self_touch',
  'config.instructions',
  'git.push_external',
];

/** Builtins and keywords of a shell: words that start a segment and are not a program anyone installed. */
const NOT_PROGRAMS: ReadonlySet<string> = new Set([
  'cd',
  'echo',
  'printf',
  'export',
  'set',
  'unset',
  'true',
  'false',
  ':',
  'test',
  '[',
  '[[',
  'read',
  'pwd',
  'exit',
  'return',
  'shift',
  'alias',
  'unalias',
  'wait',
  'type',
  'hash',
  'let',
  'local',
  'declare',
  'typeset',
  'readonly',
  'umask',
  'ulimit',
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'while',
  'until',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'select',
  'function',
  '{',
  '}',
  '!',
  'time',
  'break',
  'continue',
  'getopts',
  'trap',
  'command',
  'builtin',
  'enable',
  'help',
  'logout',
  'jobs',
  'fg',
  'bg',
  'disown',
  'dirs',
  'pushd',
  'popd',
  'history',
  'fc',
  'bind',
  'caller',
  'compgen',
  'complete',
  'mapfile',
  'readarray',
  'write-host',
  'write-output',
  'set-location',
  'rem',
  'goto',
  'setlocal',
  'endlocal',
  'pause',
  'title',
  'cls',
  '@echo',
]);
/** A word that starts a loop header, whose next word is a variable and not a program. */
const LOOP_HEADERS: ReadonlySet<string> = new Set(['for', 'select', 'case', 'function']);
const PROGRAM_NAME = /^[\w.@+/~-]+$/;

const CREDENTIAL_SPLIT = /[\s"'`=@;|&<>()]+/;

/** The credential files a text names: the words of it that the classifier's own patterns call secret. */
function credentialFilesIn(text: string): string[] {
  const found = new Set<string>();
  for (const word of text.split(CREDENTIAL_SPLIT)) {
    if (word === '' || word.length > PROGRAM_MAX * 2) continue;
    if (SECRET_PATTERNS.some((pattern) => pattern.test(word))) found.add(word);
    if (found.size >= MAX_PER_KIND) break;
  }
  return [...found];
}

function hostsIn(text: string): HostFound[] {
  const { urls } = commandUrls(text, MAX_PER_KIND);
  return urls.map(({ url, host }) => ({ host: host === '' ? null : host, url }));
}

interface Programs {
  readonly programs: string[];
  readonly dynamic: boolean;
}

/** The programs a text runs, by the first word of each of its commands. */
function programsIn(text: string): Programs {
  const programs = new Set<string>();
  let dynamic = false;
  for (const segment of splitSegments(text)) {
    const opening = segment.trimStart().split(/\s/, 1)[0]?.toLowerCase() ?? '';
    if (LOOP_HEADERS.has(opening)) continue;
    const word = commandWord(segment);
    if (word === '' || NOT_PROGRAMS.has(word)) continue;
    if (/^[$`(]/.test(word)) {
      dynamic = true;
      continue;
    }
    if (word.length <= PROGRAM_MAX && PROGRAM_NAME.test(word)) programs.add(word);
    if (programs.size >= MAX_PROGRAMS) break;
  }
  return { programs: [...programs], dynamic };
}

/** The ids of the rules that fired in a class, without repeats, in a fixed order. */
const idsOf = (signals: readonly string[]): string[] => [...new Set(signals)].sort();

/** Reads one piece of shell text. It does not throw: a text that cannot be read is a `Reading` that says so. */
export function readShell(text: string): Reading {
  const hosts = hostsIn(text);
  let groups: Map<ActionClass, readonly string[]>;
  try {
    // `classifyCommand` is this call with the signals of the classes put in one list; here they are
    // wanted apart, to say which rules fired for which class.
    groups = new Map(
      classifyCommandGroups(text, READ_CWD, 0, { deadlineMs: READ_DEADLINE_MS }).groups,
    );
  } catch {
    // The classifier does not throw on text; if it ever does, the text is one that was not read.
    return unread(hosts, 'unparsed', ['reader-failed']);
  }
  const everySignal = [...groups.values()].flat();
  if (everySignal.some(isClockSignal)) return unread(hosts, 'too-slow', []);
  if (everySignal.some(isLimitSignal)) return unread(hosts, 'too-large', []);

  const classes: ClassFound[] = SIGNAL_CLASSES.flatMap((action) =>
    groups.has(action) ? [{ action, ids: idsOf(groups.get(action) ?? []) }] : [],
  );
  const hasCredentialFile = groups.has('fs.secrets');
  const { programs, dynamic } = programsIn(text);
  return {
    hosts,
    talksToNetwork: groups.has('shell.network'),
    credentialFiles: hasCredentialFile ? credentialFilesIn(text) : [],
    hasCredentialFile,
    classes,
    unreadable: groups.has('shell.unparsed') ? 'unparsed' : null,
    unparsedIds: idsOf(groups.get('shell.unparsed') ?? []),
    programs,
    dynamicProgram: dynamic,
  };
}

function unread(
  hosts: readonly HostFound[],
  unreadable: 'unparsed' | 'too-large' | 'too-slow',
  ids: readonly string[],
): Reading {
  return {
    hosts,
    talksToNetwork: false,
    credentialFiles: [],
    hasCredentialFile: false,
    classes: [],
    unreadable,
    unparsedIds: ids,
    programs: [],
    dynamicProgram: false,
  };
}
