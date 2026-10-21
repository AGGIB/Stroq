// Files a key was written to, followed through the rest of a session by coarse rules that read no
// path:
//
//  - Every file a key was written to is remembered with every text written there, by its own name
//    and the name of the folder it is in. A later call that can send and names either of them, as
//    a part of its text with quotes and backslashes taken out and in any case, sent the key to
//    another company, unless the strict proof of the key's own use holds for that call.
//  - A later call that can send and uploads files, or that comes after an archive, may have sent
//    it ("maybe"), though it names neither. An archive or a copy made after the write goes by the
//    names of what it wrote, and a variable set where the file is named by `$` and its name: a
//    later send that names one sent it.
//  - A later call that runs a program and names the file may have run it: "maybe", and where the
//    text of the file sends the key, read as a command, if it does.
//  - A call that could send that ran before the write, in the background or in a shell that keeps
//    running (Codex, Cursor), and names the file may have been reading it already: "maybe".
//
// What is followed is bounded; past a bound a file is "maybe", with a phrase that says so: a file
// one of whose names is dropped (past the names one file goes by, or the names a session follows)
// may be sent by that name, unseen. Names are looked for with `includes`, and the characters
// compared are counted before each look.
import type { CallFacts } from './call-facts.js';
import { nameOf } from './call-facts.js';
import { isAbsolutePath, joinPath, normalPath } from './path-form.js';
import { plainText } from './key-text.js';
import type { KeyFinder } from './keys.js';
import { farther, type Place, type Then } from './place.js';
import { rerouted } from './session-state.js';
import {
  appended,
  scriptPlace,
  shellWritesBy,
  writtenPlace,
  type ShellContext,
} from './shell-place.js';
import { strictOwnHost } from './strict-own.js';
import { writtenFiles, writtenText } from './where.js';

/** Files a key was written to that are followed in one session, at most. */
const MAX_FOLLOWED = 256;
/** Names the followed files go by, at most, and the names one file goes by. */
const MAX_NAMES = 1_024;
const MAX_NAMES_PER_FILE = 16;
/** Work spent looking for followed names in later calls, in characters compared, at most. */
const MAX_MATCH_WORK = 1 << 28;
/** Text of earlier calls that could send kept, at most, for files written after them. */
const MAX_KEPT_SENDS = 1 << 22;

/** A file a key was written to, followed to the end of the session. */
interface Followed {
  /** The sighting whose place the file's fate can change. */
  readonly held: number;
  readonly key: number;
  /** The write, as a place: what a later call's place is built on. */
  readonly write: Place;
  readonly at: string;
  /** The file's own name: a later write to a file by that name adds to its text. */
  readonly base: string;
  names: string[];
  text: string;
  script: Place | null | undefined;
  /** An archive was made after it was written: a later send may hold it. */
  archived: boolean;
}

/** A call that could send, kept for a file written after it. */
interface EarlierSend {
  readonly text: string;
  readonly at: string;
  readonly host: string | null;
}

/** One call, as the follower is told of it. */
export interface CallSeen {
  readonly tool: string;
  readonly at: string;
  /** Requests after this call may go elsewhere: an earlier call changed where they go. */
  readonly rerouted: boolean;
}

export interface FollowContext extends ShellContext {
  readonly finder: KeyFinder;
}

export interface Follower {
  /** Whether any file is followed. */
  active(): boolean;
  /** A file a key was written to by sighting `held`, from now on followed by its names. */
  follow(held: number, key: number, path: string, text: string, call: CallSeen): void;
  /** A write by sighting `held` past what a command's files are kept to: maybe sent. */
  cut(held: number, call: CallSeen): void;
  /** What a later call did with the files followed. */
  onCall(facts: CallFacts, command: string, call: CallSeen): void;
  /** A write tool's text, added to a followed file of the same name: what the file holds now. */
  wrote(input: Readonly<Record<string, unknown>>): void;
  /** A call that could send, kept for a file written after it. */
  keepSend(facts: CallFacts, at: string): void;
  /** The farthest place a later call gave a sighting. */
  later(held: number): Place | undefined;
  /** The first file a sighting wrote, for a push after it. */
  firstWrite(held: number): Place | undefined;
}

/** A file a key was written to, followed by more files or names than are kept: maybe sent. */
const cutPlace = (write: Place, at: string): Place => ({
  ...write,
  tier: 'maybe',
  route: 'write-sent',
  then: { route: 'command-unread', host: null, at },
});

export function createFollower(ctx: FollowContext): Follower {
  const later = new Map<number, Place>();
  const firstWrite = new Map<number, Place>();
  const followed: Followed[] = [];
  /** The files still followed, and the names they go by. */
  const live = new Set<number>();
  const byName = new Map<string, Set<number>>();
  let matchWork = 0;
  /** Past a bound, no file is followed: every one written is "maybe". */
  let followCut = false;
  const earlierSends: EarlierSend[] = [];
  let keptSends = 0;
  let sendsCut = false;

  const raise = (held: number, place: Place): void => {
    const before = later.get(held);
    later.set(held, before === undefined ? place : farther(before, place));
  };

  /** The names a file goes by: its own, and the folder it is in, in lower case. */
  function namesOf(path: string): string[] {
    const whole = isAbsolutePath(path) || path.startsWith('~') || ctx.cwd === null;
    const parts = (whole ? normalPath(path) : joinPath(ctx.cwd as string, path))
      .split('/')
      .filter((part) => part !== '');
    const names = [nameOf(parts.at(-1) ?? ''), parts.length > 1 ? nameOf(parts.at(-2) ?? '') : ''];
    return [...new Set(names.filter((n) => n !== '').map((n) => n.slice(0, 255)))];
  }

  /** Stop following a file: it went to another company, or past a bound. */
  function unlink(id: number): void {
    live.delete(id);
    for (const name of followed[id]?.names ?? []) {
      const ids = byName.get(name);
      ids?.delete(id);
      if (ids?.size === 0) byName.delete(name);
    }
  }

  /** Past a bound: every file still followed may have been sent, and none is followed from now. */
  function cutAll(at: string): void {
    for (const id of [...live]) {
      const f = followed[id] as Followed;
      raise(f.held, cutPlace(f.write, at));
      unlink(id);
    }
    followCut = true;
  }

  /** Whether the characters about to be compared are past the bound: then every file is cut. */
  function spend(chars: number, at: string): boolean {
    matchWork += chars;
    if (matchWork <= MAX_MATCH_WORK) return false;
    cutAll(at);
    return true;
  }

  /**
   * Names added to a file, to the bounds. A name past them is dropped, and a later call that uses
   * it would not be seen: the file may have been sent, and its phrase says the check was cut.
   */
  function addNames(id: number, names: readonly string[], at: string): void {
    const f = followed[id] as Followed;
    for (const name of names) {
      if (f.names.includes(name)) continue;
      if (f.names.length >= MAX_NAMES_PER_FILE || (!byName.has(name) && byName.size >= MAX_NAMES)) {
        raise(f.held, cutPlace(f.write, at));
        return;
      }
      f.names.push(name);
      const ids = byName.get(name) ?? new Set<number>();
      ids.add(id);
      byName.set(name, ids);
    }
  }

  /** An earlier call that could send and names the file may have been reading it already. */
  function earlierReaders(f: Followed): void {
    if (sendsCut) {
      raise(f.held, cutPlace(f.write, f.at));
      return;
    }
    for (const send of earlierSends)
      for (const name of f.names) {
        if (spend(send.text.length, f.at)) return;
        if (!send.text.includes(name)) continue;
        raise(f.held, {
          ...f.write,
          tier: 'maybe',
          route: 'write-sent',
          ...(send.host === null ? {} : { host: send.host }),
          then: { route: 'command', host: send.host, at: send.at },
        });
        return;
      }
  }

  function follow(held: number, key: number, path: string, text: string, call: CallSeen): void {
    const write: Place = { tier: 'seen', route: 'write', tool: call.tool, detail: path };
    if (!firstWrite.has(held)) firstWrite.set(held, write);
    const names = namesOf(path);
    if (followCut || live.size >= MAX_FOLLOWED || byName.size + names.length > MAX_NAMES) {
      raise(held, cutPlace(write, call.at));
      return;
    }
    const id = followed.length;
    const f: Followed = {
      held,
      key,
      write,
      at: call.at,
      base: names[0] ?? '',
      names: [],
      text,
      script: undefined,
      archived: false,
    };
    followed.push(f);
    live.add(id);
    addNames(id, names, call.at);
    earlierReaders(f);
  }

  /** Where a followed file's text sends the key, were it run: read once, until it changes. */
  function scriptOf(f: Followed): Place | null {
    if (f.script === undefined) {
      const key = ctx.finder.keys[f.key];
      f.script = key === undefined ? null : scriptPlace(f.text, key, ctx);
    }
    return f.script;
  }

  /** Text added to what a followed file holds. */
  function addText(f: Followed, text: string): void {
    f.text = appended(f.text, text);
    f.script = undefined;
  }

  /** What a later command wrote to a file by a followed file's name, added to its text. */
  function addWritten(f: Followed, command: string): void {
    const holds = (t: string): boolean => plainText(t).includes(f.base);
    for (const file of shellWritesBy(command, holds, ctx).files)
      if (nameOf(file.path) === f.base) addText(f, file.text);
  }

  /**
   * The followed files a call names, by any of their names: those named by their own name first,
   * the longest name first, so the report names the file the call named over one whose name is a
   * part of it or that is only in the same folder.
   */
  function named(c: CallFacts, at: string): Set<number> | null {
    const own = new Set<number>();
    const rest = new Set<number>();
    for (const [name, ids] of byName) {
      if (spend(c.text.length, at)) return null;
      if (c.text.includes(name))
        for (const id of ids) (followed[id]?.base === name ? own : rest).add(id);
    }
    const length = (id: number): number => followed[id]?.base.length ?? 0;
    return new Set([...[...own].sort((a, b) => length(b) - length(a)), ...rest]);
  }

  function onCall(c: CallFacts, command: string, call: CallSeen): void {
    if (live.size === 0) return;
    const matched = named(c, call.at);
    if (matched === null) return;
    const own = new Map<number, boolean>();
    /**
     * Whether the strict proof of a key's own use holds for this call: never after an earlier call
     * changed where requests go.
     */
    const ownFor = (key: number): boolean => {
      if (call.rerouted) return false;
      const known = own.get(key);
      if (known !== undefined) return known;
      const value = ctx.finder.keys[key];
      const holds =
        c.reading !== null && value !== undefined && strictOwnHost(c.reading, value) !== null;
      own.set(key, holds);
      return holds;
    };
    const where = {
      ...(c.host === undefined ? {} : { host: c.host }),
      ...(c.local === true ? { local: true as const } : {}),
    };
    const then = (route: 'command' | 'command-near'): Then => ({
      route,
      host: c.host ?? null,
      at: call.at,
      ...(c.sender === '' ? {} : { detail: c.sender }),
    });
    for (const id of [...matched, ...[...live].filter((id) => !matched.has(id))]) {
      const f = followed[id] as Followed;
      if (!live.has(id)) continue;
      if (matched.has(id)) {
        // A call that can send and names the file, or its folder, sent it with it; unless the
        // strict proof of the key's own use holds for it, which leaves no way to send a file.
        if (c.sends) {
          if (ownFor(f.key)) continue;
          raise(f.held, {
            ...f.write,
            tier: 'third_party',
            route: 'write-sent',
            ...where,
            then: then('command'),
          });
          unlink(id);
          continue;
        }
        if (c.runs !== null) {
          const ran: Place = {
            tier: 'maybe',
            route: 'command-ran',
            tool: call.tool,
            ...(c.runs === '' ? {} : { detail: c.runs }),
          };
          const place = writtenPlace(f.write, scriptOf(f), { place: ran }, call.at);
          raise(f.held, call.rerouted ? rerouted(place) : place);
        }
        // A variable set where the file is named names it in a later call: `F=leak.txt`.
        addNames(id, c.assigns, call.at);
        if (c.outputs.length > 0) {
          addNames(id, c.outputs, call.at);
          if (c.outputs.includes(f.base)) addWritten(f, command);
        }
        // More names than a call's are kept: one dropped may name a copy of the file.
        if (c.namesCut) raise(f.held, cutPlace(f.write, call.at));
      } else if (c.sends && (c.uploads || f.archived))
        // It sent files, or followed an archive, and names none of this one's names.
        raise(f.held, {
          ...f.write,
          tier: 'maybe',
          route: 'write-sent',
          ...where,
          then: then('command-near'),
        });
      if (c.archives) {
        f.archived = true;
        addNames(id, c.archiveOutputs, call.at);
        if (c.namesCut) raise(f.held, cutPlace(f.write, call.at));
      }
    }
  }

  function wrote(input: Readonly<Record<string, unknown>>): void {
    for (const path of writtenFiles(input)) {
      const name = nameOf(path);
      for (const id of byName.get(name) ?? []) {
        const f = followed[id] as Followed;
        if (f.base === name) addText(f, writtenText(input));
      }
    }
  }

  function keepSend(c: CallFacts, at: string): void {
    if (!c.sends) return;
    if (keptSends + c.text.length > MAX_KEPT_SENDS) {
      sendsCut = true;
      return;
    }
    keptSends += c.text.length;
    earlierSends.push({ text: c.text, at, host: c.host ?? null });
  }

  return {
    active: () => live.size > 0,
    follow,
    cut: (held, call) =>
      raise(held, cutPlace({ tier: 'seen', route: 'write', tool: call.tool }, call.at)),
    onCall,
    wrote,
    keepSend,
    later: (held) => later.get(held),
    firstWrite: (held) => firstWrite.get(held),
  };
}
