// One session, streamed: every call, result and message is matched against the keys as it
// arrives, and only what matched is kept.
//
// A call's arguments are placed by `where.ts`. Its result can still change that: a call that
// came back refused or blocked did not run, so what it carried was blocked. And a session's
// later calls can change a write: a file the AI wrote a key into is followed by its names
// (`followed.ts`), and a push or a publish later in the same session may have taken it out. A key
// put in a variable (or in a value that uses such a variable) is in every later call that uses
// the variable: one that can send sent it to another company, one that runs a program may have
// sent it. A key file a call names is placed for every key read from it (`key-files.ts`). All of
// it is settled in `finish`.
import { commandWord, isShellTool } from '@stroq/core';
import type {
  LineParser,
  TranscriptEvent,
  TranscriptPost,
  TranscriptPre,
  TranscriptSink,
  TranscriptText,
} from '../replay/transcript.js';
import { inBackground, shellCallFacts, toolCallFacts, type CallFacts } from './call-facts.js';
import { folderChanges } from './file-paths.js';
import { createFollower, type CallSeen } from './followed.js';
import { inputText } from './input-text.js';
import { keyFileIndex, keyFileUses, type KeyFileIndex } from './key-files.js';
import type { FoundKey, KeyFinder } from './keys.js';
import { isHostShape, isProgramName, NAME_NOT_SHOWN } from './names.js';
import { callCouldSend, laterCounter } from './later-commands.js';
import { keyForms, shellJoined } from './needles.js';
import type { Place, Push } from './place.js';
import { farther, placeRank } from './place.js';
import {
  changesRoutes,
  MAX_KEPT_VARIABLES,
  mayRunCurl,
  namesCurlConfig,
  rerouted,
  stepAssignments,
  variablesSetTo,
  variablesUsed,
} from './session-state.js';
import { appended, pushesIn, shellWrites, shellWritesBy, type Writes } from './shell-place.js';
import { charge, chargeStart, countCut, readBudgetLeft } from './shell-read.js';
import {
  blockedBy,
  placeOfArgument,
  saidStopped,
  WRITE_TOOLS,
  writtenFiles,
  writtenFilesCut,
  writtenText,
  type WhereContext,
} from './where.js';

/** One key, seen once, somewhere in one session. */
export interface Sighting {
  /** The key's index in the finder's `keys`. */
  readonly key: number;
  readonly place: Place;
  readonly at: string;
  readonly subagent?: string;
  /**
   * Calls of the same session after this one that could have taken the key out without showing
   * it (`later-commands.ts`): set when there are any. It changes no place.
   */
  readonly laterNetwork?: number;
}

export interface SessionContext extends WhereContext {
  /** The agent that recorded the session, which decides how a blocked call is recognised. */
  readonly agent: string;
  readonly finder: KeyFinder;
  /** The home folder, for key files a report names from it (`~/.aws/credentials`). */
  readonly home?: string;
}

export interface SessionAnalyzer {
  readonly sink: TranscriptSink;
  /**
   * One raw record of the session (a line of a log, a row of a store), handed to the sink by
   * `read`. A key the raw record holds that nothing read from it holds is in a part no reader
   * read: maybe sent, whatever else the session shows of that key.
   */
  record(raw: string, read: () => void): void;
  /** The keys of a file that could not be read through: each may be in a record that sent it. */
  unread(keys: Iterable<number>): void;
  /**
   * The session's sightings. `fileKeys` are the keys the fast pass found in the session's
   * files: one no call or message explains is in a part of the record no reader read, and may
   * have been sent. `savedKeys` are those found only in outputs Claude Code saved to files: the
   * output of a call, shown to the AI.
   */
  finish(fileKeys?: ReadonlySet<number>, savedKeys?: ReadonlySet<number>): Sighting[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * A key the session's files hold that no call or message read explains. In the session's own
 * log it is in a part no reader read (a record of a kind it does not know, a field it drops), and
 * may have been sent. Only in an output Claude Code saved to a file, it is a call's output.
 */
const unexplained = (saved: boolean): Place =>
  saved ? { tier: 'seen', route: 'result', spilled: true } : { tier: 'maybe', route: 'record' };

/** A key in a record of a kind no reader knows: it may be a call that sent it. */
const UNKNOWN_RECORD: Place = { tier: 'maybe', route: 'record' };

/** A key put in a variable past those a session follows: a later call may have used it unseen. */
const VARIABLES_CUT: Place = { tier: 'maybe', route: 'cut', tool: 'Bash', cut: 'variables' };

/** A key in a call or a text Stroq could not read through: it may have gone anywhere. */
const unreadCall = (tool: string): Place => ({ tier: 'maybe', route: 'arguments', tool });

/** What is printed in place of a host, a file or a name that holds a key. */
export const HIDDEN = '[a name that holds a key]';

/** Routes whose `detail` is a file path; every other route's is a program or a server name. */
const PATH_DETAIL = new Set(['write', 'write-script', 'write-sent', 'write-push']);

const isPathDetail = (place: Place): boolean =>
  PATH_DETAIL.has(place.route) ||
  (place.route === 'result' && (place.tool === 'Read' || place.tool === 'Grep'));

/** A tool's name as a phrase prints it: letters, digits and `_ . : -`. */
const TOOL_NAME = /^[\w.:-]{1,128}$/;

/** Whether a tool's name has the shape of one, and may be printed. */
export const isToolName = (tool: string): boolean => TOOL_NAME.test(tool);

/**
 * A place with every name that came from the session checked. A host, a file, a program or a tool
 * named after a key (`https://<key>.collect.example`) would print the key, and so would one that
 * holds six characters of one (`https://<ten letters of a key>.collect.example`, a folder named
 * with a piece, the tail of a key with a `/` read as a program, an MCP tool named with a piece), in
 * any case and URL-encoded too (`pieces.ts`). A host, a program or a tool name that does not have
 * the shape of one is not printed either.
 */
export function scrubPlace(place: Place, finder: KeyFinder): Place {
  const clean = (text: string | undefined, shaped: (t: string) => boolean): string | undefined => {
    if (text === undefined) return undefined;
    if (finder.hasPiece(text)) return HIDDEN;
    return shaped(text) ? text : NAME_NOT_SHOWN;
  };
  const host = clean(place.host, isHostShape);
  const detail = clean(place.detail, isPathDetail(place) ? () => true : isProgramName);
  const tool = clean(place.tool, isToolName);
  const then = place.then;
  return {
    ...place,
    ...(host === undefined ? {} : { host }),
    ...(detail === undefined ? {} : { detail }),
    ...(tool === undefined ? {} : { tool }),
    ...(then === undefined
      ? {}
      : {
          then: {
            ...then,
            host: then.host === null ? null : (clean(then.host, isHostShape) ?? null),
            ...(then.detail === undefined
              ? {}
              : { detail: clean(then.detail, isProgramName) ?? NAME_NOT_SHOWN }),
          },
        }),
  };
}

/**
 * What a result's phrase names: the file a Read or Grep read, or the program a command ran. A
 * command word that holds a key names no program: what is left of it once its folders are cut
 * off can be the end of the key.
 */
function resultDetail(
  tool: string,
  input: Readonly<Record<string, unknown>>,
  finder: KeyFinder,
): string | null {
  if (tool === 'Read' || tool === 'Grep')
    return str(input['file_path']) || str(input['path']) || null;
  if (isShellTool(tool)) {
    const raw = commandWord(str(input['command']));
    if (finder.holds(raw)) return null;
    const word = raw
      .replace(/^.*[/\\]/, '')
      .replace(/\.exe$/i, '')
      .toLowerCase();
    return isProgramName(word) ? word : null;
  }
  return null;
}

/**
 * Time order of two stamps; two stamps that will not parse, or that are the same, are judged by
 * the order the events came in.
 */
function after(
  a: { at: string | null; seq: number },
  b: { at: string | null; seq: number },
): boolean {
  const x = Date.parse(a.at ?? '');
  const y = Date.parse(b.at ?? '');
  return Number.isNaN(x) || Number.isNaN(y) || x === y ? a.seq > b.seq : x > y;
}

interface Held extends Sighting {
  readonly seq: number;
  readonly call?: string;
}

/**
 * How far one call's derived places reached, farthest first: as one call's places are ranked
 * (`farther`), with a stopped call ranked by where it would have gone (`placeRank`).
 */
const CALL_RANK: Readonly<Record<string, number>> = {
  third_party: 0,
  maybe: 1,
  own_service: 2,
  seen: 3,
};
const settleRank = (place: Place): number =>
  place.tier === 'blocked'
    ? placeRank(place) + (place.wouldBe === 'third_party' ? 0 : 4)
    : (CALL_RANK[place.tier] ?? 9);

/** Folders the session's commands changed to that relative paths are read against, at most. */
const MAX_FOLDERS = 64;
/** Words that may make a call one that sends: an earlier call without one is not kept. */
const SEND_HINT =
  /curl|wget|nc\b|ncat|netcat|socat|ssh|scp|sftp|rsync|ftp|telnet|https?:|\/dev\/|gh\b|git\b|aws|gsutil|rclone|mail|openssl|http|xh\b/i;

/** Routes of a key written into a file, whose file a later call may have sent or run. */
const WRITTEN: ReadonlySet<string> = new Set(['write', 'write-script']);

export function analyzeSession(ctx: SessionContext): SessionAnalyzer {
  const held: Held[] = [];
  const blocked = new Map<string, 'stroq' | 'user'>();
  /** Calls whose log says they were stopped, in a shape that proves nothing. */
  const said = new Set<string>();
  /** The calls that could have sent a key without showing it, and the commands already read. */
  const couldSend = laterCounter();
  const readCommands = new Map<string, boolean>();
  const pushes: (Push & { seq: number })[] = [];
  /** The variables earlier calls set to a key, by name, with the keys' indices. */
  const keyVariables = new Map<string, Set<number>>();
  /** Keys put in a variable past those followed, already placed as cut short. */
  const variablesCut = new Set<number>();
  /** The first call that may have changed where the requests after it go. */
  let routesChangedAt: number | null = null;
  /** The first call or result that named a curl config file: later curl requests may go elsewhere. */
  let curlConfigAt: number | null = null;
  /** The folder the session's commands run in now, and every folder they changed to. */
  let folderNow = ctx.cwd;
  const folders = new Set<string>();
  /** A folder changed to was past those followed, and one was changed to in a way not read. */
  let foldersCut = false;
  let folderUnread = false;
  /** The files a key was written to, followed to the end of the session. */
  const follower = createFollower(ctx);
  let keyFiles: KeyFileIndex | null = null;
  let seq = 0;
  /** The keys read from the raw record being read now, and the time of the last item read. */
  let recordKeys: Set<number> | null = null;
  let lastAt = '';

  /** Keys found in an item of the raw record being read: that record explains them. */
  const explain = (found: readonly FoundKey[]): void => {
    if (recordKeys !== null) for (const one of found) recordKeys.add(one.index);
  };

  const keep = (
    key: number,
    place: Place,
    item: { at: string; subagent?: string },
    call?: string,
  ): number =>
    held.push({
      key,
      // A place read from a command alone knows no time: what it says came after is the call's.
      place: place.then?.at === '' ? { ...place, then: { ...place.then, at: item.at } } : place,
      at: item.at,
      seq,
      ...(item.subagent === undefined ? {} : { subagent: item.subagent }),
      ...(call === undefined ? {} : { call }),
    }) - 1;

  /**
   * The keys in what a call was given: as they are, and as a shell joins the words it is given,
   * so a key split or escaped by quotes and backslashes (`"Pa\$\$w0rd"`, `'a'\''b'`) is found.
   */
  function findQuoted(text: string): readonly FoundKey[] {
    const found = ctx.finder.find(text);
    if (!/['"\\]/.test(text)) return found;
    const seen = new Set(found.map((one) => one.index));
    return [...found, ...ctx.finder.find(shellJoined(text)).filter((one) => !seen.has(one.index))];
  }

  /**
   * One event. Whatever goes wrong reading it costs only that event: a key found in it is placed
   * as maybe sent, and one not found is still in the session's bytes (`finish`).
   */
  function event(e: TranscriptEvent): void {
    seq += 1;
    if (e.at !== '') lastAt = e.at;
    let found: readonly FoundKey[] = [];
    try {
      if (e.kind === 'post') {
        found = ctx.finder.find(e.resultText);
        explain(found);
        result(e, found);
        return;
      }
      const rest = e.scriptRest ?? '';
      const text = inputText(e.input);
      found = findQuoted(`${text}\n${rest}`);
      explain(found);
      pre(e, found, rest, text);
    } catch {
      for (const one of found) keep(one.index, unreadCall(e.tool), e, e.id);
    }
  }

  /**
   * One call, its whole analysis charged to the run's time for reading commands. The budget is
   * asked first: once it is spent, every reader below answers without reading (a key in the call
   * is maybe sent), and a command that holds a key is counted as not read.
   */
  function pre(e: TranscriptPre, found: readonly FoundKey[], rest: string, text: string): void {
    if (isShellTool(e.tool) && found.length > 0 && !readBudgetLeft())
      countCut(str(e.input['command']));
    const started = chargeStart();
    try {
      analyzeCall(e, found, rest, text);
    } finally {
      charge(started);
    }
  }

  function analyzeCall(
    e: TranscriptPre,
    found: readonly FoundKey[],
    rest: string,
    text: string,
  ): void {
    const shell = isShellTool(e.tool);
    const command = str(e.input['command']);
    if (callCouldSend(e, folderNow, readCommands)) couldSend.add(seq, e.at);
    if (shell) {
      for (const push of pushesIn(command, ctx)) pushes.push({ ...push, at: e.at, seq });
      // The folder a session's commands run in stays where the last `cd` left it.
      const changes = folderChanges(command, folderNow);
      if (changes.unread) folderUnread = true;
      if (changes.cut) foldersCut = true;
      for (const folder of changes.folders) {
        folderNow = folder;
        if (folders.has(folder)) continue;
        if (folders.size < MAX_FOLDERS) folders.add(folder);
        else foldersCut = true;
      }
    }
    const reroute =
      shell &&
      ((routesChangedAt !== null && routesChangedAt < seq) ||
        (curlConfigAt !== null && curlConfigAt < seq && mayRunCurl(command)));
    const call: CallSeen = { tool: e.tool, at: e.at, rerouted: reroute };
    // What this call did with the files earlier calls wrote a key into.
    const facts = laterCall(e, command, shell, call);
    /** A request after a call that may have changed where requests go went elsewhere. */
    const routed = (place: Place): Place => (reroute ? rerouted(place) : place);
    const indices = new Map<number, number>();
    for (const one of found) {
      const place = routed(placeOfArgument(e.tool, e.input, one.key, ctx, rest));
      // A record of a kind no reader knows may be a call that sent it.
      const kept = e.unknownRecord === true ? farther(place, UNKNOWN_RECORD) : place;
      indices.set(one.index, keep(one.index, kept, e, e.id));
    }
    followWrites(e, command, shell, found, indices, call);
    if (shell) {
      variables(e, command, found, facts, call);
      keepSend(e, command, facts);
      keyFilesUsed(e, command, new Set(found.map((one) => one.index)), routed);
    }
    if (routesChangedAt === null && changesRoutes(e.tool, e.input, ctx.agent, ctx.cwd))
      routesChangedAt = seq;
    if (curlConfigAt === null && namesCurlConfig(text)) curlConfigAt = seq;
  }

  function result(e: TranscriptPost, found: readonly FoundKey[]): void {
    // A curl config file a result shows (a listing, a read) is there for every later curl request.
    if (curlConfigAt === null && namesCurlConfig(e.resultText)) curlConfigAt = seq;
    const who = blockedBy(e, ctx.agent);
    if (who !== null) blocked.set(e.id, who);
    else if (saidStopped(e, ctx.agent)) said.add(e.id);
    const detail = resultDetail(e.tool, e.input, ctx.finder);
    for (const one of found) {
      keep(
        one.index,
        {
          tier: 'seen',
          route: 'result',
          tool: e.tool,
          ...(detail === null ? {} : { detail }),
          ...(e.spilled === true ? { spilled: true as const } : {}),
        },
        e,
      );
    }
  }

  function text(t: TranscriptText): void {
    seq += 1;
    if (t.at !== '') lastAt = t.at;
    const route = t.role === 'user' ? 'prompt' : 'reply';
    let found: readonly FoundKey[] = [];
    try {
      found = ctx.finder.find(t.text);
      explain(found);
      for (const one of found) keep(one.index, { tier: 'seen', route }, t);
    } catch {
      for (const one of found) keep(one.index, unreadCall('message'), t);
    }
  }

  /** The files a call wrote each key it holds into, followed from now on. */
  function followWrites(
    e: TranscriptPre,
    command: string,
    shell: boolean,
    found: readonly FoundKey[],
    indices: ReadonlyMap<number, number>,
    call: CallSeen,
  ): void {
    for (const one of found) {
      const index = indices.get(one.index);
      const s = index === undefined ? undefined : held[index];
      if (s === undefined || index === undefined || s.place.tier === 'third_party') continue;
      if (WRITE_TOOLS.has(e.tool)) {
        const text = appended('', writtenText(e.input));
        // A patch past the files followed: one not followed may be sent by its name, unseen.
        if (writtenFilesCut(e.input)) follower.cut(index, call);
        for (const path of writtenFiles(e.input))
          follower.follow(index, one.index, path, text, call);
      } else if (shell) followShell(index, one.index, shellWrites(command, one.key, ctx), call);
    }
  }

  /** The files a shell call wrote, followed; more than are kept: maybe sent. */
  function followShell(index: number, key: number, writes: Writes, call: CallSeen): void {
    if (writes.cut) follower.cut(index, call);
    for (const file of writes.files) follower.follow(index, key, file.path, file.text, call);
  }

  /** The facts of a call that may change what became of a followed file, or null for none. */
  function laterCall(
    e: TranscriptPre,
    command: string,
    shell: boolean,
    call: CallSeen,
  ): CallFacts | null {
    const usesVariable =
      shell &&
      keyVariables.size > 0 &&
      [...variablesUsed(command)].some((n) => keyVariables.has(n));
    if (!follower.active() && !usesVariable) return null;
    if (WRITE_TOOLS.has(e.tool)) follower.wrote(e.input);
    const server = shell ? null : ctx.mcp.lookup(e.tool);
    const facts = shell
      ? shellCallFacts(command, ctx.cwd)
      : server === null
        ? null
        : toolCallFacts(inputText(e.input), server.server === null ? null : server.server.remote);
    if (facts !== null) follower.onCall(facts, command, call);
    return facts;
  }

  /**
   * A call that could send, kept for a file written after it: one run in the background, or in a
   * shell that keeps running (Codex, Cursor), may still have been running.
   */
  function keepSend(e: TranscriptPre, command: string, facts: CallFacts | null): void {
    const background = e.input['run_in_background'] === true || inBackground(command);
    if (!(background || ctx.agent !== 'claude-code') || !SEND_HINT.test(command)) return;
    follower.keepSend(facts ?? shellCallFacts(command, ctx.cwd), e.at);
  }

  /**
   * A name a key is in, from now on: to the bound on names kept. Past it the name is not followed,
   * and a later call that uses it would not be seen: its keys are maybe sent, cut short.
   */
  function track(name: string, keys: Iterable<number>, item: { at: string }): void {
    if (!keyVariables.has(name) && keyVariables.size >= MAX_KEPT_VARIABLES) {
      // Once for each key: one such place is enough to say the check was cut.
      for (const k of keys)
        if (!variablesCut.has(k)) {
          variablesCut.add(k);
          keep(k, VARIABLES_CUT, item);
        }
      return;
    }
    const set = keyVariables.get(name) ?? new Set<number>();
    for (const k of keys) set.add(k);
    keyVariables.set(name, set);
  }

  /**
   * Keys put in variables, and the later calls that use them. A call that can send and uses a
   * variable an earlier call put a key in sent it to another company; one that runs a program
   * with it may have sent it; the files it wrote are followed. A name set in a step that uses such
   * a variable holds the key too.
   */
  function variables(
    e: TranscriptPre,
    command: string,
    found: readonly FoundKey[],
    facts: CallFacts | null,
    call: CallSeen,
  ): void {
    const holdsNow = new Set(found.map((one) => one.index));
    const used = keyVariables.size === 0 ? new Set<string>() : variablesUsed(command);
    const reached = new Set<number>();
    const names: string[] = [];
    for (const name of used) {
      const keys = keyVariables.get(name);
      if (keys === undefined) continue;
      names.push(name);
      for (const k of keys) if (!holdsNow.has(k)) reached.add(k);
    }
    if (reached.size > 0 && facts !== null) {
      const place = variablePlace(facts, e.tool);
      const uses = (t: string): boolean =>
        names.some((n) => t.includes(`$${n}`) || t.includes(`\${${n}`));
      for (const k of reached) {
        const index = keep(k, place, e, e.id);
        if (place.tier !== 'third_party')
          followShell(index, k, shellWritesBy(command, uses, ctx), call);
      }
    }
    // As written and as the shell joins it: `K="Pa\$\$w0rd…"` sets K to the key too.
    const joined = shellJoined(command);
    for (const one of found)
      for (const form of keyForms(one.key.value))
        for (const text of joined === command ? [command] : [command, joined])
          for (const name of variablesSetTo(text, form)) track(name, [one.index], e);
    // A name set where a variable with a key in it is used: `T="Bearer $K"`.
    if (keyVariables.size > 0)
      for (const step of stepAssignments(command)) {
        const keys = [...step.uses].flatMap((n) => [...(keyVariables.get(n) ?? [])]);
        if (keys.length > 0) for (const name of step.names) track(name, keys, e);
      }
  }

  /** A key file a command names, sent or given to a program, for every key read from it. */
  function keyFilesUsed(
    e: TranscriptPre,
    command: string,
    holding: Set<number>,
    routed: (place: Place) => Place,
  ): void {
    keyFiles ??= keyFileIndex(ctx.finder, ctx.home);
    // The folder the command runs in is read too, past the folders followed; when the session
    // stopped following folders and changed folder in a way not read, it may be any.
    const cwds = folderNow === null ? [...folders] : [...folders, folderNow];
    const lost = foldersCut && folderUnread;
    for (const use of keyFileUses(command, keyFiles, { ...ctx, cwds }, lost))
      for (const i of use.keys)
        if (!holding.has(i)) {
          holding.add(i);
          keep(i, routed(use.place), e, e.id);
        }
  }

  /** A push or a publish after a write, which the file may have gone out with. */
  function pushedLater(s: Held, write: Place): Place | null {
    const push = pushes.find((p) => after(p, s));
    if (push === undefined) return null;
    const { seq: _seq, ...then } = push;
    return { ...write, tier: 'maybe', route: 'write-push', then };
  }

  /**
   * A held sighting with what the rest of the session says about it. Every place derived from the
   * call is worked out (stopped by its result, a later call that used a file it wrote, or a push
   * later) and the farthest one is kept: a result can say a call was stopped, which only its result
   * says, and that must not hide where the file it wrote went.
   */
  function settle(s: Held, index: number): Sighting {
    const who = s.call === undefined ? undefined : blocked.get(s.call);
    const noted: Place =
      s.call !== undefined && said.has(s.call) ? { ...s.place, saidStopped: true } : s.place;
    const places: Place[] = [
      who === undefined
        ? noted
        : { ...s.place, tier: 'blocked', blocked: who, wouldBe: s.place.tier },
    ];
    const used = follower.later(index);
    if (used !== undefined) places.push(used);
    const write = follower.firstWrite(index) ?? (WRITTEN.has(s.place.route) ? s.place : undefined);
    const pushed = write === undefined ? null : pushedLater(s, write);
    if (pushed !== null) places.push(pushed);
    const place = places.reduce((best, next) =>
      settleRank(next) < settleRank(best) ? next : best,
    );
    const later = couldSend.after(s.seq, s.at);
    return {
      key: s.key,
      place: scrubPlace(place, ctx.finder),
      at: s.at,
      ...(s.subagent === undefined ? {} : { subagent: s.subagent }),
      ...(later > 0 ? { laterNetwork: later } : {}),
    };
  }

  /** A key in a raw record that nothing read from it holds: the record may be a call that sent it. */
  function record(raw: string, read: () => void): void {
    const outer = recordKeys;
    const explained = new Set<number>();
    recordKeys = explained;
    try {
      read();
    } finally {
      recordKeys = outer;
      let inRaw: readonly FoundKey[] = [];
      try {
        inRaw = ctx.finder.find(raw);
      } catch {
        // The search itself failed: the record's keys are still in the session's bytes (`finish`).
      }
      for (const one of inRaw)
        if (!explained.has(one.index)) keep(one.index, UNKNOWN_RECORD, { at: lastAt });
    }
  }

  return {
    sink: { event, text },
    record,
    unread(keys: Iterable<number>): void {
      for (const key of keys) keep(key, UNKNOWN_RECORD, { at: lastAt });
    },
    finish(fileKeys = new Set<number>(), savedKeys = new Set<number>()): Sighting[] {
      const out = held.map(settle);
      const explained = new Set(out.map((s) => s.key));
      for (const key of [...fileKeys].sort((a, b) => a - b))
        if (!explained.has(key)) out.push({ key, place: unexplained(savedKeys.has(key)), at: '' });
      return out;
    },
  };
}

/**
 * A parser whose every line is read as one raw record of the session (`SessionAnalyzer.record`):
 * a key in a line that nothing read from the line holds is maybe sent.
 */
export function accountedParser(parser: LineParser, analyzer: SessionAnalyzer): LineParser {
  return {
    push: (line) => analyzer.record(line, () => parser.push(line)),
    finish: () => parser.finish(),
  };
}

/**
 * Where a later call that uses a variable a key was put in took it: another company's when the call
 * can send (a `$` is never the strict proof of the key's own use), maybe when it runs a program,
 * and seen by the AI when it only reads or prints.
 */
function variablePlace(facts: CallFacts, tool: string): Place {
  if (facts.sends)
    return {
      tier: 'third_party',
      route: 'command',
      tool,
      ...(facts.sender === '' ? {} : { detail: facts.sender }),
      ...(facts.host === undefined ? {} : { host: facts.host }),
      ...(facts.local === true ? { local: true as const } : {}),
    };
  if (facts.runs !== null)
    return {
      tier: 'maybe',
      route: 'command-ran',
      tool,
      ...(facts.runs === '' ? {} : { detail: facts.runs }),
    };
  return { tier: 'seen', route: 'arguments', tool };
}
