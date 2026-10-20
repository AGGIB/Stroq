// One run of the check over a set of sessions: the keys and MCP configs of the folders those
// sessions ran in, the scan, and the report. Every read here is a read; nothing is written.
import { statSync } from 'node:fs';
import { projectFolders } from '@stroq/core';
import { HIDDEN } from './analyze.js';
import { cursorChangesPending, cursorStateDb } from './cursor.js';
import { collectFindings, type Finding, type SessionInfo } from './findings.js';
import { gitRemoteReader } from './git-remote.js';
import { keyFinder, loadKeys, type KeyFinder } from './keys.js';
import { loadMcpServers } from './mcp-config.js';
import {
  buildReport,
  keysCompared,
  sessionsRead,
  type KeysCompared,
  type NotChecked,
  type SentReport,
  type SentScope,
} from './report.js';
import { scanSessions } from './scan-sessions.js';
import { budgetSpent, commandsCut, startReadBudget } from './shell-read.js';
import { CANARY_SOURCE, withSessionCanaries } from './session-canaries.js';
import type { SessionRef } from './sessions.js';

export interface RunEnv {
  readonly home: string;
  /** The folder the command was typed in: its `.env*` files are read too. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: Date;
  /** Stroq's own folder, where `stroq canary` records the canaries it planted. */
  readonly stroqHome?: string;
  readonly progress?: (done: number, total: number) => void;
}

export interface RunScope {
  readonly scope: SentScope;
  readonly cursorUnavailable: string | null;
  /** `--last`: how many sessions the project has. */
  readonly inProject?: number;
  /** `--here`: sessions whose folder is not recorded and that could not be placed. */
  readonly skipped?: number;
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The folders whose `.env*` files are read: where the command was typed and where each session
 * ran, each with the folders above it up to its repository's root.
 */
export function projectDirs(cwd: string, refs: readonly SessionRef[]): string[] {
  const recorded = refs.map((r) => r.cwd).filter((dir): dir is string => dir !== null);
  const folders = [...new Set([cwd, ...recorded])].filter(isDir).flatMap(projectFolders);
  return [...new Set(folders)];
}

/** Scopes that read Cursor's store: every session, this project's, or the newest one. */
const readsCursorStore = (scope: SentScope): boolean =>
  scope === 'machine' || scope === 'project' || scope === 'last';

/** Where this run's HOME keeps Cursor's store. */
const cursorStore = (run: RunEnv): string =>
  cursorStateDb(process.platform, { ...run.env }, run.home);

/** A path from this machine or a session, hidden when it holds a piece of a key: it would print it. */
const cleanWith =
  (finder: KeyFinder) =>
  (path: string): string =>
    finder.hasPiece(path) ? HIDDEN : path;

/** What is printed in place of a session's or a subagent's id that is not printed. */
export const ID_NOT_SHOWN = '[an id that cannot be printed]';

/** An id as a record gives it: plain characters, a bound on its length. */
const ID_SHAPE = /^[A-Za-z0-9._:-]{1,64}$/;

const printableId = (id: string, finder: KeyFinder): string =>
  ID_SHAPE.test(id) && !finder.hasPiece(id) ? id : ID_NOT_SHOWN;

/**
 * A finding's session and subagent as they may be printed: an id is kept only when it has the
 * shape of one and holds no piece of a key; a path or a folder that holds a piece is hidden.
 */
export function printableSession(
  session: SessionInfo,
  subagent: string | undefined,
  finder: KeyFinder,
): { readonly session: SessionInfo; readonly subagent?: string } {
  const clean = cleanWith(finder);
  return {
    session: {
      ...session,
      id: printableId(session.id, finder),
      path: clean(session.path),
      cwd: session.cwd === null ? null : clean(session.cwd),
    },
    ...(subagent === undefined ? {} : { subagent: printableId(subagent, finder) }),
  };
}

/** A finding with its session, subagent and source as they may be printed. */
function printableFinding(f: Finding, finder: KeyFinder): Finding {
  const { session, subagent } = printableSession(f.session, f.subagent, finder);
  // `env` and `stroq canary` are fixed labels, not paths.
  const source =
    f.source === 'env' || f.source === CANARY_SOURCE ? f.source : cleanWith(finder)(f.source);
  const { subagent: _old, ...rest } = f;
  return { ...rest, session, ...(subagent === undefined ? {} : { subagent }), source };
}

/** The key files a report names, with any path that holds a piece of a key hidden. */
function scrubbedKeys(keys: KeysCompared, finder: KeyFinder): KeysCompared {
  const clean = cleanWith(finder);
  return {
    ...keys,
    files: keys.files.map(clean),
    ...(keys.partial === undefined ? {} : { partial: keys.partial.map(clean) }),
  };
}

export async function checkSessions(
  refs: readonly SessionRef[],
  run: RunEnv,
  scope: RunScope,
): Promise<SentReport> {
  const dirs = projectDirs(run.cwd, refs);
  // A planted canary that is in no file read is looked for in the sessions by its hash.
  const keys = withSessionCanaries(
    loadKeys({
      home: run.home,
      env: run.env,
      projectDirs: dirs,
      ...(run.stroqHome === undefined ? {} : { stroqHome: run.stroqHome }),
    }),
    refs,
    run.stroqHome,
  );
  const finder = keyFinder(keys.keys);
  startReadBudget();
  const result = await scanSessions(refs, {
    finder,
    home: run.home,
    mcp: loadMcpServers({ home: run.home, projectDirs: dirs }),
    gitRemote: gitRemoteReader(),
    ...(run.progress === undefined ? {} : { progress: run.progress }),
  });
  const found = result.found;
  const notChecked: NotChecked[] =
    scope.cursorUnavailable !== null
      ? ['cursor']
      : readsCursorStore(scope.scope) && cursorChangesPending(cursorStore(run))
        ? ['cursor-recent']
        : [];
  return buildReport({
    scope: scope.scope,
    now: run.now,
    sessions: {
      ...sessionsRead(refs),
      ...(scope.inProject === undefined ? {} : { inProject: scope.inProject }),
      ...(scope.skipped === undefined || scope.skipped === 0 ? {} : { skipped: scope.skipped }),
    },
    keys: scrubbedKeys(keysCompared(keys), finder),
    // A folder, a path, an id or a key file named with a piece of a key would print it.
    findings: collectFindings(finder.keys, found).map((f) => printableFinding(f, finder)),
    notChecked,
    unreadable: result.unreadable,
    savedOutputsSkipped: result.savedOutputsSkipped,
    searchCut: result.searchCut,
    workCut: commandsCut(),
    workSpent: budgetSpent(),
  });
}

/** A progress line on a terminal: `Reading sessions: 120 of 999`, redrawn in place, then cleared. */
export function progressLine(
  isTTY: boolean,
  write: (text: string) => void,
): { readonly update: (done: number, total: number) => void; readonly end: () => void } | null {
  if (!isTTY) return null;
  let last = 0;
  let drawn = false;
  return {
    update(done, total) {
      const now = Date.now();
      if (done !== total && now - last < 150) return;
      last = now;
      drawn = true;
      write(`\rReading sessions: ${done} of ${total}`);
    },
    end() {
      if (drawn) write('\r\u001b[2K');
      drawn = false;
    },
  };
}
