import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionState, TaintSource } from '../types.js';
import { withLock } from '../util/lock.js';

export interface SessionStore {
  get(sessionId: string): Promise<SessionState>;
  markSuspect(sessionId: string, source: TaintSource): Promise<SessionState>;
  clear(sessionId: string): Promise<void>;
}

export function sessionKey(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

function emptyState(sessionId: string, now: string): SessionState {
  return { sessionId, taint: null, updatedAt: now };
}

function addSource(state: SessionState, source: TaintSource, now: string): SessionState {
  const taint = state.taint
    ? { ...state.taint, sources: [...state.taint.sources, source] }
    : { level: 'suspect' as const, since: now, sources: [source] };
  return { ...state, taint, updatedAt: now };
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
    try {
      const parsed = JSON.parse(raw) as SessionState;
      return { ...parsed, sessionId };
    } catch (err) {
      // Fail closed: a corrupt session file must surface as an error, not as an
      // untainted or partially-tainted state, so the caller (the CLI hook layer)
      // can deny/ask on high-impact tools instead of silently trusting bad state.
      throw new Error(`corrupt session state: ${this.file(sessionId)}`, { cause: err });
    }
  }

  private async write(state: SessionState): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(state.sessionId);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(state), 'utf8');
    await rename(tmp, target);
  }

  async get(sessionId: string): Promise<SessionState> {
    return this.read(sessionId);
  }

  async markSuspect(sessionId: string, source: TaintSource): Promise<SessionState> {
    await mkdir(this.dir, { recursive: true });
    return withLock(`${this.file(sessionId)}.lock`, async () => {
      const next = addSource(await this.read(sessionId), source, this.now().toISOString());
      await this.write(next);
      return next;
    });
  }

  async clear(sessionId: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    return withLock(`${this.file(sessionId)}.lock`, async () => {
      await rm(this.file(sessionId), { force: true });
    });
  }
}
