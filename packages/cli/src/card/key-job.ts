// The key check of one transcript, as a job for a worker: the same scan `stroq sent` makes of a
// session (the raw-byte pass for the keys, the streamed parse only where it found one or a command may
// name a key file), against the index the run registered.
//
// What a worker keeps between transcripts is what costs to build and does not change in a run: the
// finder, the byte matcher, the MCP table. What it must not keep is anything a transcript changed, so
// each check starts its own time for reading commands, its own budget for saved outputs, and counts
// only the cuts it caused. Checks run one at a time in a thread: the time for reading commands is the
// thread's, and two checks sharing it would give answers that depend on what else the thread was doing.
import { gitRemoteReader } from '../sent/git-remote.js';
import { keyFinder, type KeyFinder } from '../sent/keys.js';
import { mcpServersFrom, type McpServers } from '../sent/mcp-config.js';
import type { ByteMatcher } from '../sent/needles.js';
import { scanMatcher, scanSessions } from '../sent/scan-sessions.js';
import type { SessionRef } from '../sent/sessions.js';
import { budgetSpent, commandsCut, startReadBudget } from '../sent/shell-read.js';
import { prepareIndex } from './key-index.js';
import { registeredKeyIndex } from './key-registry.js';
import { hitsOf } from './key-result.js';
import type { SessionKeys } from './key-schema.js';

/** What checking one transcript found. */
export interface KeyAnswer {
  readonly result: SessionKeys;
  /** Nothing was cut short or left unread: the result is the same whenever it is made. */
  readonly complete: boolean;
  /** Files of the session that could not be read. */
  readonly unreadable: number;
}

interface Prepared {
  readonly digest: string;
  readonly finder: KeyFinder;
  readonly matcher: ByteMatcher;
  readonly mcp: McpServers;
  readonly home: string;
  readonly idOf: readonly number[];
  readonly gitRemote: ReturnType<typeof gitRemoteReader>;
}

let prepared: Prepared | null = null;

/** The finder and matcher for the registered index, built once for as long as it is the same. */
function preparedFor(digest: string): Prepared | null {
  const index = registeredKeyIndex();
  if (index === null || index.digest !== digest) return null;
  if (prepared?.digest === digest) return prepared;
  const finder = keyFinder(index.data.keys);
  prepared = {
    digest,
    finder,
    matcher: scanMatcher(finder),
    mcp: mcpServersFrom(new Map(index.data.mcp)),
    home: index.data.home,
    idOf: prepareIndex(index.data).idOf,
    gitRemote: gitRemoteReader(),
  };
  return prepared;
}

async function check(ref: SessionRef, digest: string): Promise<KeyAnswer | null> {
  const run = preparedFor(digest);
  if (run === null) return null;
  startReadBudget();
  const cutsBefore = run.finder.cuts();
  const scan = await scanSessions([ref], {
    finder: run.finder,
    home: run.home,
    mcp: run.mcp,
    gitRemote: run.gitRemote,
    bytes: run.matcher,
  });
  const found = scan.found[0];
  const searchCut = scan.searchCut - cutsBefore;
  return {
    result: { id: found?.session.id ?? '', hits: hitsOf(found?.sightings ?? [], run.idOf) },
    complete:
      scan.unreadable === 0 &&
      searchCut === 0 &&
      scan.savedOutputsSkipped === 0 &&
      commandsCut() === 0 &&
      !budgetSpent(),
    unreadable: scan.unreadable,
  };
}

let tail: Promise<unknown> = Promise.resolve();

/**
 * Checks `ref` against the registered index, which must be the one with `digest`; null when it is not
 * (the answer would be for other keys). Never overlaps another check in this thread.
 */
export function checkKeys(ref: SessionRef, digest: string): Promise<KeyAnswer | null> {
  const run = tail.then(() => check(ref, digest));
  tail = run.catch(() => undefined);
  return run;
}
