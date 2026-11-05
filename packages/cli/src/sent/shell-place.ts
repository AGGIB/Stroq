// Where a shell command put a key, and the files it wrote it into.
//
// The whole command is judged, not only the stage that holds the key. A command any stage of
// which can send (a request the core reads, a sender, `gh`, a `git` that talks to a remote, a
// publish) sent the key to another company, unless the strict proof of the key's own use holds
// (`strict-own.ts`). A command that cannot send, but runs any program the core does not read as
// only reading or printing, may have sent it: "maybe". A mailer, `openssl s_client` or `git
// credential` is another company's when the command names where it goes, else "maybe". Only a
// command in which every stage only reads, prints or writes files is placed as seen by the AI.
//
// Each stage the key reached is still placed by `shell-route.ts`, for where the report says it
// went (its host, `gh`, a hosting tool that stores a secret). A file a stage wrote the key into is
// kept with every text written to it in the command, and what it holds is read as a command too:
// a script that sends the key, run in the same command or a later one, sent it there. The
// session's later calls are matched to the file by its name (`analyze.ts`).
import { commandUrls, REDIRECT, type Word } from '@stroq/core';
import {
  changesFolderByOption,
  commandPathWords,
  folderChanges,
  namesFile,
  namesFileHow,
  type Folders,
} from './file-paths.js';
import { embedsPrinter, printsEnvironment } from './env-printers.js';
import { plainText, valueHolds } from './key-text.js';
import { linkedByReach, type Link } from './link-by-reach.js';
import { isDataHeredoc } from './heredoc-programs.js';
import { runsQuotedText } from './quoted-cut.js';
import { inStringPosition } from './string-positions.js';
import { baseName, isAbsolutePath, joinPath, normalPath } from './path-form.js';
import { farther, isThisMachine, type KeyOf, type Place, type Route } from './place.js';
import {
  commandReading,
  countCut,
  INERT_CLASSES,
  MAX_READ_CHARS,
  readBudgetLeft,
  reached,
  SEND_CLASSES,
  type CommandReading,
  type Reach,
  type Stage,
} from './shell-read.js';
import {
  allStages,
  commandSends,
  halfSenderPlace,
  publishes,
  routesElsewhere,
  runStages,
  shownName,
  stagePlace,
  stageSends,
} from './shell-route.js';
import { isProgramName } from './names.js';
import { strictOwnHost } from './strict-own.js';

export { valueHolds } from './key-text.js';

export interface ShellContext {
  readonly cwd: string | null;
  /** Other folders the session's commands changed to: a relative path may be read against them. */
  readonly cwds?: readonly string[];
  /** The home folder, for `cd ~/dir`. */
  readonly home?: string;
  /**
   * False when the session changed folder in a way not read (`cd "$DIR"`), or past the folders it
   * follows: the folders above are then not all there are, and a word that spells only the end of a
   * folder's path is taken to name it wherever it is.
   */
  readonly foldersKnown?: boolean;
  /** The URL a git remote of a folder points at, or null when it cannot be read. */
  readonly gitRemote: (cwd: string | null, name: string) => string | null;
}

/** The folders a command may run in: the session's, those it changed to, and its own `cd`s. */
function foldersOf(command: string, ctx: ShellContext): Folders {
  const more = [...(ctx.cwds ?? [])];
  let read = ctx.cwd !== null && ctx.foldersKnown !== false && !changesFolderByOption(command);
  for (const base of [ctx.cwd, ...more].slice(0, 8)) {
    const changes = folderChanges(command, base, ctx.home);
    more.push(...changes.folders);
    if (changes.unread || changes.cut) read = false;
  }
  return { cwd: ctx.cwd, more, exact: read, ...(ctx.home === undefined ? {} : { home: ctx.home }) };
}

const pick = (a: Place | null, b: Place | null): Place | null =>
  a === null ? b : b === null ? a : farther(a, b);

const detailOf = (word: string): { readonly detail?: string } =>
  word === '' ? {} : { detail: word };

/** A file a command wrote, and every text it wrote there. */
export interface WrittenFile {
  readonly path: string;
  readonly text: string;
}

/** What one command did with a text it holds: where it went, and the files it was written to. */
interface Placed {
  readonly place: Place | null;
  readonly written: readonly WrittenFile[];
  /** The program of the first stage that held it with a name to print. */
  readonly word: string;
  /** Some stage was reached. */
  readonly reached: boolean;
  /** A stage reached made a request: the core's reading of one is accounted for. */
  readonly sent: boolean;
  /** It wrote to more files, or more text, than are kept: the rest may have been sent. */
  readonly writtenCut: boolean;
}

/** Files one command wrote a text into that are kept, at most. */
const MAX_WRITTEN = 64;
/**
 * The text kept of one file: past what a command may hold to be read, a file is a text Stroq does
 * not read all of, and a script in it may send the key anywhere.
 */
export const MAX_WRITTEN_TEXT = MAX_READ_CHARS + 1;

/** `text` added to what a file holds, cut at what is kept. */
export const appended = (held: string, text: string): string =>
  (held === '' ? text : `${held}\n${text}`).slice(0, MAX_WRITTEN_TEXT);

/** The words a stage writes: its own arguments past redirects and their files, and its heredoc. */
function wordsWritten(args: readonly Word[], body: string): string {
  const words: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word;
    if (!word.redirect) words.push(word.value);
    // An operator alone (`>`, `2>`) takes the next word as its file.
    else if (REDIRECT.exec(word.value)?.[0].length === word.value.length) i += 1;
  }
  return [words.join(' '), body].filter((t) => t !== '').join('\n');
}

/**
 * The stages whose heredoc is text: the program only reads text (`cat > f <<EOF`), nothing is piped on from it and it
 * is not written to a network address.
 */
function dataBodies(reading: CommandReading): Set<Stage> {
  const text = new Set<Stage>();
  for (const pipelines of reading.run)
    for (const stages of pipelines)
      stages.forEach((stage, at) => {
        if (stage.body === '' || at !== stages.length - 1) return;
        if (isDataHeredoc(stage.text, '', stage.quoted === true, stage.body)) text.add(stage);
      });
  return text;
}

/**
 * Every place a command put a text `holds` finds in it: each stage reached in each text the core
 * reads, then the plain cut for what sends. `sendOnly` places only what sends. Every file a stage
 * reached writes is kept with every text written to it.
 */
function placeIn(
  reading: CommandReading,
  holds: (text: string) => boolean,
  key: KeyOf,
  cwd: string | null,
  sendOnly: boolean,
  link?: Link,
): Placed {
  // The heredocs that are text, where the link asks for them to be left out.
  const textBodies = link?.ignoreDataBodies === true ? dataBodies(reading) : null;
  const has = (stage: Stage): boolean =>
    holds(stage.text) || (textBodies?.has(stage) !== true && holds(stage.body));
  let place: Place | null = null;
  const written = new Map<string, string>();
  let writtenCut = false;
  let word = '';
  let any = false;
  let sent = false;
  const add = (found: Place | null): void => {
    if (found !== null && found.route !== 'command-ran') sent = true;
    place = pick(place, found);
  };
  const write = (file: string, text: string): void => {
    // One spelling on every system: a later call names the file in either (`path-form.ts`).
    const path =
      cwd === null || isAbsolutePath(file) || file.startsWith('~')
        ? normalPath(file)
        : joinPath(cwd, file);
    const held = written.get(path);
    if (held === undefined && written.size >= MAX_WRITTEN) {
      writtenCut = true;
      return;
    }
    const next = appended(held ?? '', text);
    if (next.length >= MAX_WRITTEN_TEXT) writtenCut = true;
    written.set(path, next);
  };
  for (const pipelines of reading.run) {
    const reaches = reached(pipelines, has, reading.facts);
    for (const reach of reaches) {
      any = true;
      const facts = reading.facts(reach.stage);
      if (word === '' && reach.direct) word = shownName(facts, holds);
      add(linkedByReach(stagePlace(reach, reading, key, holds, sendOnly), reach, link));
      // It names more files it may write than are read: one not read may be sent unseen.
      if (facts.writesCut === true) writtenCut = true;
      if (facts.writes.length === 0) continue;
      const text = pipelineText(pipelines, reach, reading);
      for (const file of facts.writes) write(file, text);
    }
    // What a group prints goes where the group's redirect sends it: `{ …; } > f`, `( … ) > f`,
    // `done > f`, `fi > f`. The lexer gives that redirect to the stage that closes the group.
    if (reaches.length === 0) continue;
    const reachedStages = new Set(reaches.map((r) => r.stage));
    let group: string | null = null;
    for (const stage of pipelines.flat()) {
      if (reachedStages.has(stage)) continue;
      const facts = reading.facts(stage);
      if (!CLOSERS.has(facts.name) && !stage.text.includes(')')) continue;
      for (const file of facts.writes) write(file, (group ??= groupText(pipelines, reading)));
    }
  }
  // The plain cut, read for sends: a heredoc the lexer read wrongly can hide no request.
  for (const reach of reached(reading.plain, has, reading.facts)) {
    any = true;
    add(linkedByReach(stagePlace(reach, reading, key, holds, true), reach, link));
  }
  const files = [...written].map(([path, text]) => ({ path, text }));
  return { place, written: files, word, reached: any, sent, writtenCut };
}

/** Words that close a group whose redirect is given to the stage that holds them. */
const CLOSERS: ReadonlySet<string> = new Set(['}', 'done', 'fi', 'esac']);

/** What reaches a file a group writes: the words of every stage in it. */
function groupText(pipelines: readonly (readonly Stage[])[], reading: CommandReading): string {
  return pipelines
    .flat()
    .map((stage) => wordsWritten(reading.facts(stage).resolved?.args ?? [], stage.body))
    .filter((t) => t !== '')
    .join('\n');
}

/** What reaches a file a stage writes: the words of its pipeline up to it, and their heredocs. */
function pipelineText(
  pipelines: readonly (readonly Stage[])[],
  reach: Reach,
  reading: CommandReading,
): string {
  const stages = pipelines.find((p) => p.includes(reach.stage)) ?? [reach.stage];
  return stages
    .slice(0, stages.indexOf(reach.stage) + 1)
    .map((stage) => wordsWritten(reading.facts(stage).resolved?.args ?? [], stage.body))
    .filter((t) => t !== '')
    .join('\n');
}

/**
 * What the core says of the whole command that no stage accounts for: a write to a startup file,
 * a git option that runs a program, a text it could not read, a request the key did not reach.
 * Any of these makes a command that holds the key at least "maybe sent". A request is accounted
 * for when a stage the key reached made one (`sent`).
 */
function wholeCommand(reading: CommandReading, word: string, sent: boolean): Place | null {
  const doubts = [...reading.classes].filter(
    (cls) => !INERT_CLASSES.has(cls) && !(sent && SEND_CLASSES.has(cls)),
  );
  const near = !sent && (doubts.some((cls) => SEND_CLASSES.has(cls)) || reading.sends());
  if (doubts.length === 0 && !near) return null;
  if (!near) return { tier: 'maybe', route: 'command-unread', tool: 'Bash', ...detailOf(word) };
  const host = commandUrls(reading.command, 1).urls[0]?.host;
  return {
    tier: 'maybe',
    route: 'command-near',
    tool: 'Bash',
    ...detailOf(word),
    ...(host === undefined || host === '' ? {} : { host: host.toLowerCase() }),
    ...(host !== undefined && host !== '' && staysHome(reading) ? { local: true as const } : {}),
  };
}

/** A command too long to read, or one whose reading lost the key: it may have gone anywhere. */
const unreadCommand = (word = ''): Place => ({
  tier: 'maybe',
  route: 'command-unread',
  tool: 'Bash',
  ...detailOf(word),
});

/** Routes that say where a request went: kept, as another company's, when the command sent. */
const REQUEST_ROUTES: ReadonlySet<Route> = new Set([
  'command',
  'command-near',
  'post',
  'ssh',
  'git-push',
  'publish',
  'secret-store',
  'write-sent',
  'write-script',
]);

/**
 * The program of the first stage of a command that sends, or runs a program, as a phrase names it.
 * What runs is read in the stages the lexer cut (the plain cut too, where the lexer was not sure);
 * what sends in the plain cut as well, which can only find more.
 */
function firstStage(reading: CommandReading, which: 'sends' | 'runs'): string | null {
  for (const stage of which === 'sends' ? allStages(reading) : runStages(reading)) {
    const facts = reading.facts(stage);
    const hit = which === 'sends' ? stageSends(facts) : !facts.inert;
    if (hit) return isProgramName(facts.name) ? facts.name : '';
  }
  return null;
}

/** Most addresses read in one stage. */
const MAX_STAGE_URLS = 64;

/**
 * Whether every stage of the command that sends does so to this machine, by an address that was read:
 * a command that also reaches another host, or one whose destination was not read, does not stay home.
 */
function staysHome(reading: CommandReading): boolean {
  for (const stage of allStages(reading)) {
    if (!stageSends(reading.facts(stage))) continue;
    const read = commandUrls(stage.text, MAX_STAGE_URLS);
    if (read.capped || read.urls.length === 0 || routesElsewhere(stage.text)) return false;
    if (!read.urls.every((u) => isThisMachine(u.host))) return false;
  }
  return true;
}

/** The first host of the command that is not this machine, or null. */
function elsewhereHost(reading: CommandReading): string | null {
  const hosts = commandUrls(reading.command, MAX_STAGE_URLS).urls.map((u) => u.host.toLowerCase());
  return hosts.find((h) => h !== '' && !isThisMachine(h)) ?? null;
}

/**
 * A command that can send, and holds the key, sent it to another company: where, as far as read. Not
 * when everything it sends goes to this machine: a local program may send the key on, which is a maybe
 * and no more.
 */
function anotherCompany(place: Place, reading: CommandReading): Place {
  if (place.tier === 'third_party') return place;
  const home = staysHome(reading);
  if (place.local === true && home) return place;
  if (REQUEST_ROUTES.has(place.route)) {
    if (place.local !== true) return { ...place, tier: 'third_party' };
    // It also reached a host that is not this machine: that is the host, and the key may have gone there.
    const { local: _local, host: _host, ...rest } = place;
    const elsewhere = elsewhereHost(reading);
    return { ...rest, tier: 'third_party', ...(elsewhere === null ? {} : { host: elsewhere }) };
  }
  // The key was not where the request is: a command that also made a request.
  const host = (commandUrls(reading.command, 1).urls[0]?.host ?? '').toLowerCase();
  const near: Place = {
    tier: 'third_party',
    route: 'command-near',
    tool: 'Bash',
    ...detailOf(firstStage(reading, 'sends') ?? ''),
    ...(host === '' ? {} : { host }),
  };
  return home && host !== '' ? { ...near, tier: 'maybe', local: true } : near;
}

/**
 * The whole command, judged: one that can send sent the key to another company unless the strict
 * proof of its own use holds; one that runs a program may have sent it; a half-sender sent it
 * where it names, or may have.
 */
function judgedWhole(place: Place, reading: CommandReading, key: KeyOf, word: string): Place {
  if (commandSends(reading)) {
    const host = strictOwnHost(reading, key);
    if (host === null) return anotherCompany(place, reading);
    return { tier: 'own_service', route: 'command', tool: 'Bash', ...detailOf(word), host };
  }
  const runs = firstStage(reading, 'runs');
  const ran: Place | null =
    runs === null ? null : { tier: 'maybe', route: 'command-ran', tool: 'Bash', ...detailOf(runs) };
  return pick(pick(place, ran), halfSenderPlace(reading)) ?? place;
}

/**
 * A file the command wrote, run by a later stage of the same command (`sh x.sh`, `./x.sh`, `node
 * x.js`): a stage that does more than read, named by the file's own name, which does not write it.
 * Null when none ran it.
 */
function ranInCommand(file: WrittenFile, reading: CommandReading): Place | null {
  const name = baseName(file.path).toLowerCase();
  if (name === '') return null;
  for (const stage of runStages(reading)) {
    const facts = reading.facts(stage);
    if (facts.inert || !plainText(stage.text).includes(name)) continue;
    if (facts.writes.some((out) => baseName(out).toLowerCase() === name)) continue;
    const word = isProgramName(facts.name) ? facts.name : '';
    return { tier: 'maybe', route: 'command-ran', tool: 'Bash', ...detailOf(word) };
  }
  return null;
}

/** One reading of a command for one key, kept for the call that asks for its files next. */
let lastPlaced: {
  readonly command: string;
  readonly value: string;
  readonly cwd: string | null;
  readonly placed: Placed;
} | null = null;

function placedFor(command: string, key: KeyOf, cwd: string | null): Placed {
  const holds = valueHolds(key);
  if (
    lastPlaced !== null &&
    lastPlaced.command === command &&
    lastPlaced.value === key.value &&
    lastPlaced.cwd === cwd
  )
    return lastPlaced.placed;
  const placed = placeIn(commandReading(command, cwd), holds, key, cwd, false);
  lastPlaced = { command, value: key.value, cwd, placed };
  return placed;
}

/** Where a shell command that carried `key` sent it. */
export function shellPlace(command: string, key: KeyOf, ctx: ShellContext): Place {
  const holds = valueHolds(key);
  if (!holds(command)) return { tier: 'seen', route: 'arguments', tool: 'Bash' };
  // Too long to read, or past the run's time for reading commands: it may have sent it anywhere.
  if (command.length > MAX_READ_CHARS || !readBudgetLeft()) return unreadCommand();
  const reading = commandReading(command, ctx.cwd);
  const found = placedFor(command, key, ctx.cwd);
  // A key in the command that no stage holds was lost by the reading: it may have gone anywhere.
  let place = found.reached ? found.place : unreadCommand();
  place = pick(place, wholeCommand(reading, found.word, found.sent));
  // Written to more files, or more text, than are kept: what was not kept may have been sent.
  if (found.writtenCut) place = pick(place, unreadCommand(found.word));
  for (const file of found.written) {
    // What it wrote may be a command that sends the key, and the same command may run the file:
    // `echo "curl -d <key> host" > x.sh && sh x.sh`. The time is the call's own.
    const write: Place = { tier: 'seen', route: 'write', tool: 'Bash', detail: file.path };
    const ran = ranInCommand(file, reading);
    const own = writtenPlace(
      write,
      scriptPlace(file.text, key, ctx),
      ran === null ? null : { place: ran },
      '',
    );
    place = pick(place, own);
  }
  const base = place ?? {
    tier: 'seen',
    route: 'arguments',
    tool: 'Bash',
    ...detailOf(found.word),
  };
  return judgedWhole(base, reading, key, found.word);
}

const stageOf = (text: string): Stage => ({ text, body: '', piped: false });

/** The files a command wrote a text into, and whether there were more files or text than are kept. */
export interface Writes {
  readonly files: readonly WrittenFile[];
  readonly cut: boolean;
}

/** The files a shell command wrote `key` into, each with every text it wrote there. */
export function shellWrites(command: string, key: KeyOf, ctx: ShellContext): Writes {
  if (!valueHolds(key)(command)) return { files: [], cut: false };
  if (command.length > MAX_READ_CHARS || !readBudgetLeft()) return { files: [], cut: true };
  const found = placedFor(command, key, ctx.cwd);
  return { files: found.written, cut: found.writtenCut };
}

/**
 * The files the stages of a shell command that `holds` finds wrote, or that what they printed
 * reached: for a command that uses a variable a key was put in (`echo "$K" > f`).
 */
export function shellWritesBy(
  command: string,
  holds: (text: string) => boolean,
  ctx: ShellContext,
): Writes {
  if (!holds(command)) return { files: [], cut: false };
  if (command.length > MAX_READ_CHARS || !readBudgetLeft()) return { files: [], cut: true };
  const found = placeIn(commandReading(command, ctx.cwd), holds, NO_KEY, ctx.cwd, false);
  return { files: found.written, cut: found.writtenCut };
}

/**
 * Where a text the AI wrote into a file would send the key, were it run as a command: the whole
 * text is judged as a command is. Null when it cannot send, or holds no key: source code that
 * holds a key is not counted as run. A text too long to read may send it anywhere.
 */
export function scriptPlace(text: string, key: KeyOf, ctx: ShellContext): Place | null {
  const holds = valueHolds(key);
  if (text === '' || !holds(text)) return null;
  if (text.length > MAX_READ_CHARS || !readBudgetLeft()) return unreadCommand();
  const reading = commandReading(text, ctx.cwd);
  if (!commandSends(reading)) return null;
  const { place, word } = placeIn(reading, holds, key, ctx.cwd, true);
  const base: Place = place ?? { tier: 'seen', route: 'arguments', tool: 'Bash' };
  const judged = judgedWhole(base, reading, key, word);
  return judged.tier === 'seen' || judged.tier === 'blocked' ? null : judged;
}

/** What a later command did with a file the AI wrote the key into. */
export interface FileUse {
  readonly place: Place;
  /** The command named a folder the file is in, not the file. */
  readonly folder?: boolean;
  /** How the command named it: the file, a folder it is in, a pattern; `near` when it only ran beside a request. */
  readonly how?: 'file' | 'folder' | 'pattern' | 'near';
  /** The word of the command that named it. */
  readonly word?: string;
}

/**
 * How a command's words name a file: as the file, as a folder it is in, or not at all, and as a
 * maybe (`file?`, `folder?`) when only a wildcard someone may fill in reaches it.
 */
export function fileKinds(command: string, file: string, ctx: ShellContext): Set<string> {
  const target = normalPath(file);
  const folders = foldersOf(command, ctx);
  // The root and the home folder have every key file under them: they name one only where a program that
  // archives or uploads a folder is given them.
  let archives: boolean | null = null;
  const mayArchive = (): boolean =>
    (archives ??= archivesFolders(commandReading(command, ctx.cwd)));
  return new Set(
    commandPathWords(command, runsQuotedText(command)).map((w) => {
      const named = namesFileHow(w, target, folders);
      if (named === null || (named.broad === true && !mayArchive())) return '';
      return named.sure ? named.kind : `${named.kind}?`;
    }),
  );
}

/**
 * Programs that take a folder in their words and archive, copy or upload it whole. The root or the home folder is
 * named by a command only through one of these; for any other program it is text, or a string.
 */
const FOLDER_TAKERS: ReadonlySet<string> = new Set([
  'tar',
  'bsdtar',
  'gtar',
  'zip',
  '7z',
  '7za',
  '7zr',
  'cpio',
  'pax',
  'rsync',
  'scp',
  'sftp',
  'rclone',
  'aws',
  'gsutil',
  'gcloud',
  'az',
  's3cmd',
  'mc',
  'kubectl',
  'docker',
  'find',
  'unison',
  'ftp',
  'lftp',
]);

/** Whether any stage of a command is a program that takes a folder whole. */
const archivesFolders = (reading: CommandReading): boolean =>
  allStages(reading).some((stage) => FOLDER_TAKERS.has(reading.facts(stage).name));

/** A place a pattern only may have reached: never surer than maybe. */
const atMostMaybe = (place: Place): Place =>
  place.tier === 'third_party' || place.tier === 'own_service'
    ? { ...place, tier: 'maybe' }
    : place;

/**
 * Where a command put a key file (a file keys were read from) it names, by the same rule as a key:
 * a stage that names the file (or is piped what such a stage printed) and sends, sent it; one that
 * runs a program with it may have; one that only reads it changes nothing. A stage that writes the
 * file is not a use of it. A command that names a folder the file is in counts only where it sends
 * it.
 */
export function fileUse(
  command: string,
  file: string,
  key: KeyOf,
  ctx: ShellContext,
  ignore: ReadonlySet<string> = NONE,
): FileUse | null {
  const target = normalPath(file);
  // Past the run's time for reading commands, nothing is read: any command may have sent the file.
  if (!readBudgetLeft()) {
    countCut(command);
    return { place: unreadCommand(), folder: false };
  }
  const kinds = fileKinds(command, target, ctx);
  if (!['file', 'folder', 'file?', 'folder?'].some((k) => kinds.has(k))) return null;
  if (command.length > MAX_READ_CHARS) return { place: unreadCommand(), folder: false };
  const folders = foldersOf(command, ctx);
  const reading = commandReading(command, ctx.cwd);
  // A stage that writes the file (a redirect into it, a copy onto it) does not use it, and one
  // that runs a program in `ignore` (one that only looks at files here) is not counted.
  const skips = (stageText: string): boolean => {
    const facts = reading.facts({ text: stageText, body: '', piped: false });
    if (ignore.has(facts.name)) return true;
    const words = (facts.resolved?.args ?? []).filter((w) => !w.redirect).map((w) => w.value);
    const onto = COPIERS.has(facts.name) ? words.filter((w) => !w.startsWith('-')).slice(-1) : [];
    return [...facts.surelyWrites, ...onto].some(
      (out) => namesFile(out, target, folders) === 'file',
    );
  };
  // What is quoted in a command that hands text to a shell is code: its words may name a file.
  const quotedIsCode = runsQuotedText(command);
  // The word that named the file in the pass that placed it, for the evidence.
  let namedBy = '';
  let namedByEnd = false;
  let namedStage = '';
  // `glob`: null any naming, false only a naming by the file's own name, true only a pattern.
  const namesAs =
    (kind: 'file' | 'folder', sure: boolean, glob: boolean | null) =>
    (text: string): boolean => {
      const hit = commandPathWords(text, quotedIsCode).find((w) => {
        const named = namesFileHow(w, target, folders);
        return (
          named !== null &&
          named.kind === kind &&
          named.sure === sure &&
          (glob === null || (named.glob === true) === glob) &&
          (named.broad !== true || FOLDER_TAKERS.has(reading.facts(stageOf(text)).name))
        );
      });
      if (hit === undefined || skips(text)) return false;
      if (namedBy === '') {
        namedStage = text;
        namedBy = hit.text;
        namedByEnd = namesFileHow(hit, target, folders)?.byEnd === true;
      }
      return true;
    };
  // Whether every word of a stage that names the folder stands where its program takes a string.
  const strings = (text: string): boolean => {
    const facts = reading.facts(stageOf(text));
    const naming = commandPathWords(text, quotedIsCode).filter((w) => {
      const named = namesFileHow(w, target, folders);
      return named !== null && named.kind === 'folder';
    });
    return (
      naming.length > 0 &&
      naming.every((w) => inStringPosition(facts.name, facts.resolved?.args ?? [], w.text))
    );
  };
  // Sure namings first, and of those the file by its own name. Whatever was named, a request that names
  // it in its own words, or is piped what a stage that names it printed (an archive of the folder, a
  // `cat` of the pattern), sent it. One that only ran after such a step is a maybe, linked to the key by
  // what the step named; so is a naming only a pattern someone may fill in reaches.
  const passes: readonly {
    readonly kind: 'file' | 'folder';
    readonly sure: boolean;
    readonly glob: boolean | null;
    readonly how: 'file' | 'folder' | 'pattern';
    readonly link: Link;
  }[] = [
    {
      kind: 'file',
      sure: true,
      glob: false,
      how: 'file',
      link: { via: 'pattern', proof: 'named', ignoreDataBodies: true },
    },
    {
      kind: 'file',
      sure: true,
      glob: true,
      how: 'pattern',
      link: { via: 'pattern', proof: 'named', ignoreDataBodies: true },
    },
    {
      kind: 'folder',
      sure: true,
      glob: null,
      how: 'folder',
      link: { via: 'folder', proof: 'named', strings, ignoreDataBodies: true },
    },
    {
      kind: 'file',
      sure: false,
      glob: null,
      how: 'pattern',
      link: { via: 'pattern', proof: 'named', ignoreDataBodies: true },
    },
    {
      kind: 'folder',
      sure: false,
      glob: null,
      how: 'folder',
      link: { via: 'folder', proof: 'named', strings, ignoreDataBodies: true },
    },
  ];
  for (const { kind, sure, glob, how, link } of passes) {
    if (!kinds.has(sure ? kind : `${kind}?`)) continue;
    namedBy = '';
    namedByEnd = false;
    const { place } = placeIn(
      reading,
      namesAs(kind, sure, glob),
      key,
      ctx.cwd,
      kind === 'folder',
      link,
    );
    if (place !== null && place.tier !== 'seen')
      return {
        // A folder named by a word that is only its name, where the cut is not sure of the command: a maybe.
        place: sure && (!namedByEnd || reading.certainOf(namedStage)) ? place : atMostMaybe(place),
        folder: kind === 'folder',
        how,
        word: namedBy,
      };
  }
  // A command that names the file and makes a request the file was not seen to reach (`find dir
  // -exec curl -T {} …`, `xargs`) may have sent it: as a key beside a request is.
  const near = wholeCommand(reading, '', false);
  return near !== null && near.route === 'command-near'
    ? {
        place: atMostMaybe(near),
        folder: !kinds.has('file') && !kinds.has('file?'),
        how: 'near',
      }
    : null;
}

const NONE: ReadonlySet<string> = new Set();

/** No key: a use of a key file is placed for every key in it, whichever service issued it. */
export const NO_KEY: KeyOf = { name: '', source: '', value: '' };

/**
 * Where a command sent the environment it printed (`env | curl -d @- …`, `printenv | nc …`): a
 * stage that prints it, and what it is piped into, read for sends only. Null when it sent none.
 */
export function environmentUse(command: string, ctx: ShellContext): Place | null {
  if (command.length > MAX_READ_CHARS) return null;
  if (!/env|set|export|declare|typeset|environ/.test(command)) return null;
  // Past the run's time for reading commands: any command that may print the environment is not
  // read, and may have sent it.
  if (!readBudgetLeft()) {
    countCut(command);
    return unreadCommand();
  }
  // A request is a send of the environment when it is piped what the printer printed (`env | curl -d
  // @-`) or has the printer in its own words (`curl -d "$(env)"`). One that merely ran beside `set -x`,
  // `export -p` or a script that reads `environ` may have, and is a maybe.
  const { place } = placeIn(
    commandReading(command, ctx.cwd),
    (text) => printsEnvironment(text) || embedsPrinter(text),
    NO_KEY,
    ctx.cwd,
    true,
    { via: 'environment', proof: 'piped', embeds: embedsPrinter, ignoreDataBodies: true },
  );
  return place === null || place.tier === 'seen' ? null : place;
}

/** Programs that copy, move or link a file to a path they are given. */
export const COPIERS: ReadonlySet<string> = new Set([
  'cp',
  'mv',
  'ln',
  'install',
  'ditto',
  'rsync',
  'dd',
  'gcp',
  'gmv',
  'link',
]);

/** Where a key went, given that it was written to a file: by the file's own command, or its use. */
export function writtenPlace(
  write: Place,
  script: Place | null,
  use: FileUse | null,
  at: string,
): Place {
  const usePlace =
    use === null || use.place.tier === 'seen' || use.place.tier === 'blocked' ? null : use.place;
  if (usePlace !== null) {
    const ran = usePlace.route === 'command-ran';
    // A script that sends the key, run: it went where the script sends it.
    const sent = ran && script !== null ? farther(script, usePlace) : usePlace;
    const host = ran && script !== null ? script.host : usePlace.host;
    return {
      ...write,
      tier: sent.tier,
      route: 'write-sent',
      ...(host === undefined ? {} : { host }),
      ...(sent.local === true && !ran ? { local: true as const } : {}),
      then: {
        route: usePlace.route,
        host: usePlace.host ?? null,
        at,
        ...detailOf(usePlace.detail ?? ''),
      },
    };
  }
  if (script === null) return write;
  return {
    ...write,
    tier: 'maybe',
    route: 'write-script',
    ...(script.host === undefined ? {} : { host: script.host }),
    then: {
      route: script.route,
      host: script.host ?? null,
      at,
      ...detailOf(script.detail ?? ''),
      tier: script.tier,
    },
  };
}

/** A push or a publish a command ran, which a file written before it may have gone out with. */
export interface PushSeen {
  readonly route: 'git-push' | 'publish';
  readonly host: string | null;
}

/** The host a git remote URL points at: `git@github.com:o/r.git` or `https://github.com/o/r`. */
function remoteHost(url: string): string | null {
  const host = commandUrls(url, 1).urls[0]?.host ?? '';
  return host === '' ? null : host.toLowerCase();
}

/** The pushes and publishes a command ran, for a file written before it. */
export function pushesIn(command: string, ctx: ShellContext): PushSeen[] {
  if (!/push|publish|upload/.test(command)) return [];
  // Too long, or past the run's time for reading commands: a push to a host not read.
  if (command.length > MAX_READ_CHARS || !readBudgetLeft())
    return [{ route: 'git-push', host: null }];
  const reading = commandReading(command, ctx.cwd);
  const found: PushSeen[] = [];
  for (const stage of allStages(reading)) {
    const facts = reading.facts(stage);
    const args = facts.resolved?.args ?? [];
    const words = args.filter((w) => !w.redirect && !w.value.startsWith('-')).map((w) => w.value);
    if (facts.name === 'git' && words.includes('push')) {
      const named = commandUrls(stage.text, 1).urls[0]?.host;
      const remote = words[words.indexOf('push') + 1] ?? 'origin';
      const url = named === undefined ? ctx.gitRemote(ctx.cwd, remote) : null;
      found.push({
        route: 'git-push',
        host: named !== undefined ? named.toLowerCase() : url === null ? null : remoteHost(url),
      });
    } else if (publishes(facts.name, args)) found.push({ route: 'publish', host: null });
  }
  return found;
}
