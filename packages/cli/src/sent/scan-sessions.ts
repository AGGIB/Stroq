// Reading many sessions in one pass, and parsing only the ones that hold a key.
//
// First every file of a session is read as raw bytes and searched for the keys (see
// `needles.ts`); nothing is parsed. Only a session where that finds a key is read again,
// streamed through its agent's parser into the analyzer, which keeps what matched and lets
// the rest go. On a machine where no session holds a key, no JSON is parsed at all.
import { basename, dirname } from 'node:path';
import { claudeSessionFiles } from './claude-files.js';
import { accountedParser, analyzeSession, type Sighting } from './analyze.js';
import { createCodexParser } from './codex.js';
import { cursorRowEvents } from './cursor.js';
import type { SessionSightings } from './findings.js';
import type { KeyFinder } from './keys.js';
import type { McpServers } from './mcp-config.js';
import { byteMatcher } from './needles.js';
import { baseName, isAbsolutePath } from './path-form.js';
import type { SessionRef } from './sessions.js';
import { spillReader, type SpillReader } from '../replay/spilled.js';
import { feedLines } from '../replay/transcript.js';

export interface ScanDeps {
  readonly finder: KeyFinder;
  /** The home folder, for key files named from it. */
  readonly home?: string;
  readonly mcp: McpServers;
  readonly gitRemote: (cwd: string | null, name: string) => string | null;
  /** Called before each session; `done` of `total` have been read. */
  readonly progress?: (done: number, total: number) => void;
  /** Bytes of saved large outputs read into their calls over the whole scan (`SPILL_BUDGET_BYTES`). */
  readonly spillBudget?: number;
}

export interface ScanResult {
  /** Sessions with at least one sighting. */
  readonly found: readonly SessionSightings[];
  /** Session files that could not be read. */
  readonly unreadable: number;
  /** Saved large outputs left unread past the budget: their keys are found, not tied to a call. */
  readonly savedOutputsSkipped: number;
  /** Session files and texts whose search for keys was cut short by its bound (`needles.ts`). */
  readonly searchCut: number;
}

/** Words that print the environment, in the spellings a command uses. */
const ENVIRONMENT_WORDS: readonly string[] = [
  'printenv',
  'environ',
  'env |',
  'env|',
  'env >',
  'export -p',
  'declare -p',
  'declare -x',
  'typeset -x',
  'set |',
];

/**
 * What makes a session worth parsing though no key's value is in it: the name of a file keys
 * were read from (a command may send the file), and, when a key was read from the environment,
 * the words that print it.
 */
function parseWords(finder: KeyFinder): string[] {
  const words = new Set<string>();
  let environment = false;
  for (const key of finder.keys)
    for (const source of [key.source, ...(key.alsoIn ?? [])]) {
      if (source === 'env') environment = true;
      else if (isAbsolutePath(source) || source.startsWith('~/')) words.add(baseName(source));
    }
  return [...words, ...(environment ? ENVIRONMENT_WORDS : [])];
}

/** An output Claude Code saved to a file of its own: what a call printed, not the session's log. */
const isSavedOutput = (file: string): boolean => basename(dirname(file)) === 'tool-results';

/** One session's sightings, and how many of its files could not be read. */
async function readSession(
  ref: SessionRef,
  deps: ScanDeps,
  fileKeys: ReadonlySet<number>,
  savedKeys: ReadonlySet<number>,
  spill: SpillReader,
  keysByFile: ReadonlyMap<string, ReadonlySet<number>>,
): Promise<{ sightings: Sighting[]; id: string; failed: number }> {
  const analyzer = analyzeSession({
    agent: ref.agent,
    finder: deps.finder,
    mcp: deps.mcp,
    cwd: ref.cwd,
    gitRemote: deps.gitRemote,
    ...(deps.home === undefined ? {} : { home: deps.home }),
  });
  if (ref.cursor !== undefined) {
    // Each row is one record: a key in a part of it no reader read (a prompt, a field) is maybe sent.
    const id = ref.cursor.transcript.sessionId;
    for (const [n, row] of ref.cursor.rows.entries())
      analyzer.record(row, () => {
        for (const event of cursorRowEvents(id, n, row)) analyzer.sink.event(event);
      });
    return { sightings: analyzer.finish(), id, failed: 0 };
  }
  if (ref.agent === 'codex') {
    try {
      const t = await feedLines(
        ref.path,
        accountedParser(createCodexParser({ sink: analyzer.sink, keepScript: true }), analyzer),
      );
      return { sightings: analyzer.finish(fileKeys), id: t.sessionId, failed: 0 };
    } catch {
      analyzer.unread(keysByFile.get(ref.path) ?? new Set());
      return { sightings: analyzer.finish(fileKeys), id: ref.path, failed: 1 };
    }
  }
  return claudeSessionFiles(ref.path, analyzer, fileKeys, savedKeys, spill, keysByFile);
}

/** Reads `refs`, the fast pass first and the streamed parse only where it found a key. */
export async function scanSessions(
  refs: readonly SessionRef[],
  deps: ScanDeps,
): Promise<ScanResult> {
  const bytes = byteMatcher(
    deps.finder.keys.map((k) => k.value),
    parseWords(deps.finder),
  );
  // One reader for the whole scan: each saved output is read once, out of one budget.
  const spill = spillReader(deps.spillBudget);
  const found: SessionSightings[] = [];
  let unreadable = 0;
  let cutFiles = 0;
  if (deps.finder.keys.length === 0)
    return { found, unreadable, savedOutputsSkipped: 0, searchCut: 0 };
  for (const [done, ref] of refs.entries()) {
    deps.progress?.(done, refs.length);
    const fileKeys = new Set<number>();
    const logKeys = new Set<number>();
    const keysByFile = new Map<string, ReadonlySet<number>>();
    // A file whose search was cut short, or that holds a spelling worth parsing (a key a shell
    // command escapes), is parsed whatever the fast pass found in it.
    let parse = false;
    for (const file of ref.files) {
      const scan = bytes.scanFile(file);
      if (scan.failed) unreadable += 1;
      if (scan.cut === true) cutFiles += 1;
      if (scan.cut === true || scan.triggered === true) parse = true;
      for (const key of scan.keys) fileKeys.add(key);
      if (scan.keys.size > 0) keysByFile.set(file, new Set(scan.keys));
      if (!isSavedOutput(file)) for (const key of scan.keys) logKeys.add(key);
    }
    if (ref.cursor === undefined && fileKeys.size === 0 && !parse) continue;
    const saved = new Set([...fileKeys].filter((key) => !logKeys.has(key)));
    const { sightings, id, failed } = await readSession(
      ref,
      deps,
      fileKeys,
      saved,
      spill,
      keysByFile,
    );
    unreadable += failed;
    if (sightings.length > 0)
      found.push({ session: { agent: ref.agent, id, path: ref.path, cwd: ref.cwd }, sightings });
  }
  deps.progress?.(refs.length, refs.length);
  return {
    found,
    unreadable,
    savedOutputsSkipped: spill.skipped(),
    searchCut: cutFiles + deps.finder.cuts(),
  };
}
