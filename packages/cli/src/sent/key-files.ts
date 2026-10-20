// Key files a command names: a file keys were read from (`.env`, `~/.aws/credentials`), sent or
// given to a program that may send it (`curl --data-binary @.env`, `cat ~/.aws/credentials | curl
// -d @-`, `tar czf - .env | nc`, `bash x.sh .env`). Every key read from it went where the file
// went, though its value is in no call. So did every key of the environment a command printed and
// sent (`env | curl -d @-`). A program that only looks at a file here (`ls`, `stat`, `rm`) is not
// counted. The file is named by its path, read against the folders the session ran in
// (`file-paths.ts`).
import { isAbsolute, join, sep } from 'node:path';
import { shellCallFacts } from './call-facts.js';
import { namedEnds, normalPath } from './file-paths.js';
import type { KeyFinder } from './keys.js';
import type { Cut, Place } from './place.js';
import { environmentUse, fileUse, NO_KEY, type ShellContext } from './shell-place.js';
import { readBudgetLeft } from './shell-read.js';

/** Key files keys were read from, by path, the names they go by, and the environment's keys. */
export interface KeyFileIndex {
  readonly keysOf: ReadonlyMap<string, readonly number[]>;
  /** Each key file by its own name and the name of each folder it is in. */
  readonly byName: ReadonlyMap<string, readonly string[]>;
  readonly environment: readonly number[];
  readonly all: readonly string[];
}

/** Key files a command with a pattern or a `.` in it is checked against, at most. */
const MAX_WILD_KEY_FILES = 256;

/**
 * Programs that only look at a file named here, and are not read as only reading (what reads it,
 * `cat`, `grep`, is followed to where its output goes): a key file given to one went nowhere.
 */
const LOOKS_ONLY: ReadonlySet<string> = new Set([
  'ls',
  'stat',
  'test',
  '[',
  '[[',
  'file',
  'wc',
  'du',
  'touch',
  'chmod',
  'chown',
  'chgrp',
  'rm',
  'unlink',
  'mkdir',
  'rmdir',
  'realpath',
  'readlink',
  'basename',
  'dirname',
]);

/**
 * A key file sent to this machine's own address is no strict proof of the key's own use: another
 * company's, as a key in such a request is, though the report says it was this machine.
 */
const asSent = (place: Place): Place =>
  place.tier === 'maybe' && place.local === true ? { ...place, tier: 'third_party' } : place;

/** The key files keys were read from, by path, and the names they and their folders go by. */
export function keyFileIndex(finder: KeyFinder, home: string | undefined): KeyFileIndex {
  const keysOf = new Map<string, number[]>();
  const environment: number[] = [];
  finder.keys.forEach((key, i) => {
    for (const source of [key.source, ...(key.alsoIn ?? [])]) {
      if (source === 'env') environment.push(i);
      const path =
        source.startsWith('~/') && home !== undefined ? join(home, source.slice(2)) : source;
      if (!isAbsolute(path) && !path.startsWith('~/')) continue;
      keysOf.set(path, [...(keysOf.get(path) ?? []), i]);
    }
  });
  const byName = new Map<string, string[]>();
  // Every folder of the path: a path on this machine is no deeper than a path can be.
  for (const path of keysOf.keys())
    for (const name of new Set(normalPath(path).split(sep)))
      if (name !== '') byName.set(name, [...(byName.get(name) ?? []), path]);
  return { keysOf, byName, environment, all: [...keysOf.keys()] };
}

/** Where a command put the keys of a key file it names, or of the environment it printed. */
export interface KeyFileUse {
  readonly place: Place;
  readonly keys: readonly number[];
}

/** A place cut short by a bound of the check: what it dropped may have sent the key. */
const cutPlace = (cut: Cut): Place => ({ tier: 'maybe', route: 'cut', tool: 'Bash', cut });

/** Whether a command can send, or runs a program: what it names may have gone anywhere. */
function sendsOrRuns(command: string, where: ShellContext): boolean {
  const facts = shellCallFacts(command, where.cwd);
  return facts.sends || facts.runs !== null;
}

/**
 * Every key file a command sent or gave to a program, with its keys, and the environment sent.
 * `lost` says the folder the command runs in may be one the session stopped following: then a
 * command that names files by a pattern or `.`, and can send or runs a program, may have sent any
 * key file, and every one is maybe, cut short. Past the key files a pattern is checked against,
 * the rest are maybe too.
 */
export function keyFileUses(
  command: string,
  index: KeyFileIndex,
  where: ShellContext,
  lost = false,
): KeyFileUse[] {
  if (index.keysOf.size === 0 && index.environment.length === 0) return [];
  const named = namedEnds(command);
  const paths = new Set<string>();
  for (const end of named.ends) for (const path of index.byName.get(end) ?? []) paths.add(path);
  const cut: KeyFileUse[] = [];
  if (named.wild) {
    // Past the run's time for reading commands, every key file is checked: none is read.
    const checked = readBudgetLeft() ? index.all.slice(0, MAX_WILD_KEY_FILES) : index.all;
    for (const path of checked) paths.add(path);
    const past = index.all.slice(MAX_WILD_KEY_FILES).filter((path) => !paths.has(path));
    const why: Cut | null = lost ? 'folders' : past.length > 0 ? 'key-files' : null;
    if (why !== null && sendsOrRuns(command, where)) {
      const kept = lost ? index.all : past;
      cut.push({
        place: cutPlace(why),
        keys: kept.flatMap((path) => index.keysOf.get(path) ?? []),
      });
    }
  }
  const uses: KeyFileUse[] = [];
  for (const path of paths) {
    const use = fileUse(command, path, NO_KEY, where, LOOKS_ONLY);
    if (use !== null && use.place.tier !== 'seen')
      uses.push({ place: asSent(use.place), keys: index.keysOf.get(path) ?? [] });
  }
  // Placed after what was read, so a key file a command did send is reported as sent.
  uses.push(...cut);
  if (index.environment.length === 0) return uses;
  const sent = environmentUse(command, where);
  if (sent !== null) uses.push({ place: asSent(sent), keys: index.environment });
  return uses;
}
