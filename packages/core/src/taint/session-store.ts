import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AllowedCopy,
  AskedCopy,
  OwnTextFlag,
  RunningCall,
  SessionState,
  TaintSource,
} from '../types.js';
import { MAX_FETCHED } from '../scan/fetched-paths.js';
import { withLock } from '../util/lock.js';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
/** The most questions about copied values kept waiting for their call, and values kept let through. */
export const MAX_ASKED_COPIES = 32;
export const MAX_ALLOWED_COPIES = 256;
export const MAX_CALLS_RUNNING = 32;
/**
 * A call that has not reported back for this long is let go of, and no answer is taken for as long
 * again (`callsLostAt`): a host's longest call is ten minutes, and a call the user refused never reports.
 */
const CALL_RUNNING_MS = 15 * 60 * 1000;

export interface SessionStore {
  get(sessionId: string): Promise<SessionState>;
  markSuspect(sessionId: string, source: TaintSource): Promise<SessionState>;
  /**
   * Notes a flag on the developer's own text (see `OwnTextFlag`). A store without it cannot hold
   * the note, so such a flag taints the session there, as every flag did before.
   */
  markFlagged?(sessionId: string, source: TaintSource): Promise<SessionState>;
  /** Notes files the session downloaded (`SessionState.fetched`), keeping the newest `MAX_FETCHED`. */
  markFetched?(sessionId: string, paths: readonly string[]): Promise<SessionState>;
  /** Notes a question about copied values that waits for its call (`SessionState.askedCopies`). */
  noteAskedCopy?(sessionId: string, asked: AskedCopy): Promise<SessionState>;
  /** Notes a call that starts (`SessionState.callsRunning`). */
  noteCallStarted?(sessionId: string, call: CallIdentity): Promise<SessionState>;
  /** Notes that a call could not be kept track of: questions are forgotten and none is answered for a while. */
  noteCallsLost?(sessionId: string): Promise<SessionState>;
  /** Notes a call that goes on after it returns: no answer is taken for the rest of the session. */
  noteBackground?(sessionId: string): Promise<SessionState>;
  /**
   * Lets through the values of the question a call that ran was asked about: the same id, tool and
   * input. A session with a flag noted after the question lets nothing through.
   */
  allowAskedCopy?(
    sessionId: string,
    call: { readonly callId: string; readonly tool: string; readonly input: string },
  ): Promise<SessionState>;
  clear(sessionId: string): Promise<void>;
}

export function sessionKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

function emptyState(sessionId: string, now: string): SessionState {
  return { sessionId, taint: null, updatedAt: now };
}

/** A call as its question and its report name it: its id, its tool and the hash of its input. */
export interface CallIdentity {
  readonly callId: string;
  readonly tool: string;
  readonly input: string;
}

/**
 * A state without the questions about copied values and what they let through: a new flag forgets
 * them. The calls still running are kept: one that started before the flag runs on after it.
 */
function withoutCopies(state: SessionState): SessionState {
  const { askedCopies: _asked, allowedCopies: _allowed, ...rest } = state;
  return rest;
}

/** A state that lost track of a call: its questions are forgotten, and none is answered for a while. */
function lostTrack(state: SessionState, now: string): SessionState {
  const { askedCopies: _asked, ...rest } = state;
  return { ...rest, callsLostAt: now, updatedAt: now };
}

function addSource(state: SessionState, source: TaintSource, now: string): SessionState {
  const taint = state.taint
    ? { ...state.taint, sources: [...state.taint.sources, source] }
    : { level: 'suspect' as const, since: now, sources: [source] };
  return { ...withoutCopies(state), taint, updatedAt: now };
}

function addFlag(state: SessionState, source: TaintSource, now: string): SessionState {
  const flagged: OwnTextFlag = state.flagged
    ? { ...state.flagged, count: state.flagged.count + 1, last: source }
    : { since: now, count: 1, last: source };
  return { ...withoutCopies(state), flagged, updatedAt: now };
}

function addAsked(state: SessionState, asked: AskedCopy, now: string): SessionState {
  const kept = (state.askedCopies ?? []).filter((item) => item.callId !== asked.callId);
  return { ...state, askedCopies: [...kept, asked].slice(-MAX_ASKED_COPIES), updatedAt: now };
}

function addRunning(state: SessionState, call: CallIdentity, now: string): SessionState {
  const kept = (state.callsRunning ?? []).filter((item) => item.callId !== call.callId);
  const running: RunningCall = { callId: call.callId, tool: call.tool, input: call.input, at: now };
  const next = {
    ...state,
    callsRunning: [...kept, running].slice(-MAX_CALLS_RUNNING),
    updatedAt: now,
  };
  // More calls than are kept: the oldest falls off, and since it may still run, the questions that
  // wait are forgotten and asked again rather than answered.
  return kept.length >= MAX_CALLS_RUNNING ? lostTrack(next, now) : next;
}

/**
 * The host reports that a call ran: it no longer runs, and when it is a call a question was asked
 * about (the same id, tool and input), its values are let through for calls of its kinds, unless
 * the session is tainted or another call that started while the question waited still runs.
 */
function allowAsked(state: SessionState, call: CallIdentity, now: string): SessionState {
  const since = Date.parse(now) - CALL_RUNNING_MS;
  const list = state.callsRunning ?? [];
  // A report ends only the call that started with its id, tool and input: one that names another
  // tool or input does not end it.
  const others = list.filter(
    (item) => item.callId !== call.callId || item.tool !== call.tool || item.input !== call.input,
  );
  const running = others.filter((item) => Date.parse(item.at) >= since);
  let ended: SessionState =
    others.length !== list.length || running.length !== others.length
      ? { ...state, callsRunning: running, updatedAt: now }
      : state;
  // A call that never reported back is let go of, but it may still run: what waits is forgotten.
  if (running.length !== others.length) ended = lostTrack(ended, now);
  const lost =
    ended.backgroundSince !== undefined ||
    (ended.callsLostAt !== undefined && Date.parse(ended.callsLostAt) >= since);
  const asked = ended.askedCopies ?? [];
  const answered = asked.find(
    (item) => item.callId === call.callId && item.tool === call.tool && item.input === call.input,
  );
  if (answered === undefined || state.taint !== null || running.length > 0 || lost) return ended;
  const allowed: AllowedCopy[] = [
    ...(state.allowedCopies ?? []).filter((item) => !answered.atoms.includes(item.atom)),
    ...answered.atoms.map((atom) => ({ atom, classes: answered.classes })),
  ];
  return {
    ...ended,
    askedCopies: asked.filter((item) => item !== answered),
    allowedCopies: allowed.slice(-MAX_ALLOWED_COPIES),
    updatedAt: now,
  };
}

const isHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{16,64}$/.test(value);

function isAskedCopy(value: unknown): value is AskedCopy {
  return (
    isRecord(value) &&
    typeof value['callId'] === 'string' &&
    value['callId'].length > 0 &&
    value['callId'].length <= 256 &&
    typeof value['tool'] === 'string' &&
    value['tool'].length <= 256 &&
    isHash(value['input']) &&
    Array.isArray(value['atoms']) &&
    value['atoms'].length <= MAX_ALLOWED_COPIES &&
    value['atoms'].every(isHash) &&
    isClassList(value['classes'])
  );
}

const isClassList = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= 64 &&
  value.every((item) => typeof item === 'string' && /^[a-z_.]{1,64}$/.test(item));

const isAllowedCopy = (value: unknown): value is AllowedCopy =>
  isRecord(value) && isHash(value['atom']) && isClassList(value['classes']);

const isRunningCall = (value: unknown): value is RunningCall =>
  isRecord(value) &&
  typeof value['callId'] === 'string' &&
  value['callId'].length > 0 &&
  value['callId'].length <= 256 &&
  typeof value['tool'] === 'string' &&
  value['tool'].length <= 256 &&
  isHash(value['input']) &&
  typeof value['at'] === 'string' &&
  !Number.isNaN(Date.parse(value['at']));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function isTaintSource(item: unknown): item is TaintSource {
  if (!isRecord(item)) return false;
  return (
    typeof item['tool'] === 'string' &&
    typeof item['at'] === 'string' &&
    (item['source'] === undefined || typeof item['source'] === 'string') &&
    Array.isArray(item['ruleIds']) &&
    item['ruleIds'].every((rule: unknown) => typeof rule === 'string')
  );
}

function isOwnTextFlag(value: unknown): value is OwnTextFlag {
  return (
    isRecord(value) &&
    typeof value['since'] === 'string' &&
    Number.isSafeInteger(value['count']) &&
    (value['count'] as number) > 0 &&
    isTaintSource(value['last'])
  );
}

const isFetched = (value: unknown): boolean =>
  Array.isArray(value) &&
  value.length <= MAX_FETCHED &&
  value.every((path) => typeof path === 'string' && path.length > 0 && path.length <= 4096);

function addFetched(state: SessionState, paths: readonly string[], now: string): SessionState {
  const kept = (state.fetched ?? []).filter((path) => !paths.includes(path));
  return { ...state, fetched: [...kept, ...paths].slice(-MAX_FETCHED), updatedAt: now };
}

function isSessionState(value: unknown, sessionId: string): value is SessionState {
  if (!isRecord(value)) return false;
  if (value['sessionId'] !== sessionId || typeof value['updatedAt'] !== 'string') return false;
  if (value['flagged'] !== undefined && !isOwnTextFlag(value['flagged'])) return false;
  if (value['fetched'] !== undefined && !isFetched(value['fetched'])) return false;
  const asked = value['askedCopies'];
  if (
    asked !== undefined &&
    !(Array.isArray(asked) && asked.length <= MAX_ASKED_COPIES && asked.every(isAskedCopy))
  )
    return false;
  const allowed = value['allowedCopies'];
  if (
    allowed !== undefined &&
    !(
      Array.isArray(allowed) &&
      allowed.length <= MAX_ALLOWED_COPIES &&
      allowed.every(isAllowedCopy)
    )
  )
    return false;
  const running = value['callsRunning'];
  if (
    running !== undefined &&
    !(Array.isArray(running) && running.length <= MAX_CALLS_RUNNING && running.every(isRunningCall))
  )
    return false;
  for (const key of ['callsLostAt', 'backgroundSince']) {
    const at = value[key];
    if (at !== undefined && (typeof at !== 'string' || Number.isNaN(Date.parse(at)))) return false;
  }
  if (value['taint'] === null) return true;
  if (!isRecord(value['taint'])) return false;
  const taint = value['taint'];
  return (
    taint['level'] === 'suspect' &&
    typeof taint['since'] === 'string' &&
    Array.isArray(taint['sources']) &&
    taint['sources'].every(isTaintSource)
  );
}

export class FileSessionStore implements SessionStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private file(sessionId: string): string {
    return join(this.dir, `${sessionKey(sessionId)}.json`);
  }

  private async read(sessionId: string): Promise<SessionState> {
    let raw: string;
    try {
      raw = await readFile(this.file(sessionId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        return emptyState(sessionId, this.now().toISOString());
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // Fail closed: a corrupt session file must surface as an error, not as an
      // untainted or partially-tainted state, so the caller (the CLI hook layer)
      // can deny/ask on high-impact tools instead of silently trusting bad state.
      throw new Error(`corrupt session state: ${this.file(sessionId)}`, { cause: err });
    }
    if (!isSessionState(parsed, sessionId)) {
      throw new Error(`corrupt session state: ${this.file(sessionId)}`);
    }
    return parsed;
  }

  private async write(state: SessionState): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const target = this.file(state.sessionId);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(state), { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
    await rename(tmp, target);
  }

  async get(sessionId: string): Promise<SessionState> {
    return this.read(sessionId);
  }

  async markSuspect(sessionId: string, source: TaintSource): Promise<SessionState> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    return withLock(`${this.file(sessionId)}.lock`, async () => {
      const next = addSource(await this.read(sessionId), source, this.now().toISOString());
      await this.write(next);
      return next;
    });
  }

  async markFlagged(sessionId: string, source: TaintSource): Promise<SessionState> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    return withLock(`${this.file(sessionId)}.lock`, async () => {
      const next = addFlag(await this.read(sessionId), source, this.now().toISOString());
      await this.write(next);
      return next;
    });
  }

  async markFetched(sessionId: string, paths: readonly string[]): Promise<SessionState> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    return withLock(`${this.file(sessionId)}.lock`, async () => {
      const next = addFetched(await this.read(sessionId), paths, this.now().toISOString());
      await this.write(next);
      return next;
    });
  }

  async noteAskedCopy(sessionId: string, asked: AskedCopy): Promise<SessionState> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    return withLock(`${this.file(sessionId)}.lock`, async () => {
      const next = addAsked(await this.read(sessionId), asked, this.now().toISOString());
      await this.write(next);
      return next;
    });
  }

  async noteCallStarted(sessionId: string, call: CallIdentity): Promise<SessionState> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    return withLock(`${this.file(sessionId)}.lock`, async () => {
      const next = addRunning(await this.read(sessionId), call, this.now().toISOString());
      await this.write(next);
      return next;
    });
  }

  async noteBackground(sessionId: string): Promise<SessionState> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    return withLock(`${this.file(sessionId)}.lock`, async () => {
      const now = this.now().toISOString();
      const current = await this.read(sessionId);
      const next = lostTrack(
        current.backgroundSince === undefined ? { ...current, backgroundSince: now } : current,
        now,
      );
      await this.write(next);
      return next;
    });
  }

  async noteCallsLost(sessionId: string): Promise<SessionState> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    return withLock(`${this.file(sessionId)}.lock`, async () => {
      const next = lostTrack(await this.read(sessionId), this.now().toISOString());
      await this.write(next);
      return next;
    });
  }

  async allowAskedCopy(
    sessionId: string,
    call: { readonly callId: string; readonly tool: string; readonly input: string },
  ): Promise<SessionState> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    return withLock(`${this.file(sessionId)}.lock`, async () => {
      const current = await this.read(sessionId);
      const next = allowAsked(current, call, this.now().toISOString());
      if (next !== current) await this.write(next);
      return next;
    });
  }

  async clear(sessionId: string): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    return withLock(`${this.file(sessionId)}.lock`, async () => {
      await rm(this.file(sessionId), { force: true });
    });
  }
}
