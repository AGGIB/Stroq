// Commands that could have taken a key out without showing it: a later call of a session that can
// reach the network, or that runs what Stroq cannot read. A key the AI saw stays in the SEEN place,
// because no send of it was seen; these are counted beside it, because none was ruled out either.
import { isShellTool } from '@stroq/core';
import { commandReading, MAX_READ_CHARS, readBudgetLeft, type StageFacts } from './shell-read.js';
import { allStages, commandSends, halfSender } from './shell-route.js';
import { TOOL_RUNNERS } from './where.js';

/**
 * Programs whose own work is on files here and that open no connection: a stage that runs one is
 * not counted. Network verbs of `git` (`push`, `fetch`, …) are read as sends before this.
 */
const LOCAL_PROGRAMS: ReadonlySet<string> = new Set([
  'ls',
  'stat',
  'test',
  '[',
  '[[',
  'file',
  'wc',
  'du',
  'df',
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
  'cd',
  'pushd',
  'popd',
  'pwd',
  'cp',
  'mv',
  'ln',
  'tee',
  'sort',
  'uniq',
  'diff',
  'cmp',
  'tar',
  'zip',
  'unzip',
  'gzip',
  'gunzip',
  'git',
  'true',
  'false',
  'sleep',
  'date',
  'which',
  'type',
]);

/**
 * What the core says of a command that reaches the network, or that it could not read: one that
 * runs encoded text, a git option that runs a program, a write a later shell runs.
 */
const SENDS_OR_UNREAD: ReadonlySet<string> = new Set([
  'shell.network',
  'git.push_external',
  'network.fetch',
  'secret.egress',
  'shell.unparsed',
  'shell.exec_encoded',
  'secret.unscannable',
  'config.git_exec',
  'config.persistence',
]);

/** Whether a shell command can reach the network, or does what Stroq cannot read. */
export function commandCouldSend(command: string, cwd: string | null): boolean {
  if (command.trim() === '') return false;
  if (command.length > MAX_READ_CHARS || !readBudgetLeft()) return true;
  const reading = commandReading(command, cwd);
  if ([...reading.classes].some((cls) => SENDS_OR_UNREAD.has(cls))) return true;
  if (commandSends(reading)) return true;
  return allStages(reading).some((stage) => {
    const facts = reading.facts(stage);
    return (
      halfSender(facts) || (!facts.inert && !LOCAL_PROGRAMS.has(facts.name) && !findsOnly(facts))
    );
  });
}

/** `find` that runs nothing it finds: no `-exec`, `-execdir`, `-ok` or `-okdir`. */
function findsOnly(facts: StageFacts): boolean {
  if (facts.name !== 'find') return false;
  return !(facts.resolved?.args ?? []).some((w) => /^-(?:exec|execdir|ok|okdir)$/.test(w.value));
}

/** One call, as far as this asks: its tool, its input, and what the reader marked on it. */
export interface LaterCall {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly scriptRest?: string;
  readonly unknownRecord?: true;
}

/**
 * Whether a call could have taken a key out without showing it: a shell command that can reach the
 * network or that Stroq cannot read, a tool that runs what it is given, a Codex script, or a record
 * no reader knows. `known` keeps the answer for commands already read.
 */
export function callCouldSend(
  call: LaterCall,
  cwd: string | null,
  known: Map<string, boolean> = new Map(),
): boolean {
  if (call.unknownRecord === true || TOOL_RUNNERS.has(call.tool)) return true;
  if ((call.scriptRest ?? '').trim() !== '') return true;
  if (!isShellTool(call.tool)) return false;
  const value = call.input['command'];
  const command = typeof value === 'string' ? value : '';
  const id = `${cwd ?? ''}\u0000${command}`;
  const seen = known.get(id);
  if (seen !== undefined) return seen;
  const could = commandCouldSend(command, cwd);
  if (known.size < MAX_KNOWN && command.length <= MAX_KNOWN_CHARS) known.set(id, could);
  return could;
}

/** Commands whose answer is kept, at most, and the longest one kept. */
const MAX_KNOWN = 4_096;
const MAX_KNOWN_CHARS = 4_096;

/** The later calls of one session that could have sent a key, counted after any moment of it. */
export interface LaterCounter {
  /** A call that could have sent a key: its order in the session, and its time. */
  add(seq: number, at: string): void;
  /**
   * How many such calls came after a sighting: by time where both times read and differ, by the
   * order the session lists them in otherwise.
   */
  after(seq: number, at: string): number;
}

/** The first index of a sorted list whose item `past` says is past the point; the length if none. */
function firstPast<T>(items: readonly T[], past: (item: T) => boolean): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (past(items[mid] as T)) high = mid;
    else low = mid + 1;
  }
  return low;
}

export function laterCounter(): LaterCounter {
  /** Every call, in the order the session lists them. */
  const all: number[] = [];
  const timed: { readonly time: number; readonly seq: number }[] = [];
  const untimed: number[] = [];
  let sorted = true;
  return {
    add(seq, at) {
      all.push(seq);
      const time = Date.parse(at);
      if (Number.isNaN(time)) untimed.push(seq);
      else {
        sorted &&= timed.length === 0 || (timed.at(-1)?.time ?? 0) <= time;
        timed.push({ time, seq });
      }
    },
    after(seq, at) {
      const time = Date.parse(at);
      if (Number.isNaN(time)) return all.length - firstPast(all, (s) => s > seq);
      if (!sorted) {
        timed.sort((a, b) => a.time - b.time || a.seq - b.seq);
        sorted = true;
      }
      const byTime = firstPast(timed, (c) => c.time > time || (c.time === time && c.seq > seq));
      return timed.length - byTime + (untimed.length - firstPast(untimed, (s) => s > seq));
    },
  };
}
