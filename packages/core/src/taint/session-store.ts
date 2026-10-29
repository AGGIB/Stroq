import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AskedCopy, OwnTextFlag, SessionState, TaintSource } from '../types.js';
import { MAX_FETCHED } from '../scan/fetched-paths.js';
import { withLock } from '../util/lock.js';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
/** The most questions about copied values kept waiting for their call, and values kept let through. */
export const MAX_ASKED_COPIES = 32;
export const MAX_ALLOWED_COPIES = 256;

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

/** A state without the questions about copied values and what they let through: a new flag forgets them. */
function withoutCopies(state: SessionState): SessionState {
  const { askedCopies: _asked, allowedCopies: _allowed, ...rest } = state;
  return rest;
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

function allowAsked(
  state: SessionState,
  call: { readonly callId: string; readonly tool: string; readonly input: string },
  now: string,
): SessionState {
  const asked = state.askedCopies ?? [];
  const answered = asked.find(
    (item) => item.callId === call.callId && item.tool === call.tool && item.input === call.input,
  );
  if (answered === undefined || state.taint !== null) return state;
  const allowed = [
    ...(state.allowedCopies ?? []).filter((atom) => !answered.atoms.includes(atom)),
    ...answered.atoms,
  ];
  return {
    ...state,
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
    value['atoms'].every(isHash)
  );
}

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
    !(Array.isArray(allowed) && allowed.length <= MAX_ALLOWED_COPIES && allowed.every(isHash))
  )
    return false;
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
