// The three kinds of job the card gives its workers, and what each one does.
//
//   session  one transcript: replay it and count what a text told the agent to run
//   keys     one session: the keys of this machine against it, as `stroq sent` reads it (`key-job.ts`)
//   repos    the session folders that still exist, for what they run by themselves
//
// Every job and every result is plain data, so it crosses a thread unchanged. `handleJob` is the one
// function that does the work, in a worker or in this process: a run with one thread and a run with
// many call the same code and so give the same answer.
import type { SessionRef } from '../sent/sessions.js';
import { findAutorun, type AutorunResult } from './autorun.js';
import { checkKeys, type KeyAnswer } from './key-job.js';
import type { CardAgent, SessionSummary } from './schema.js';
import { summarizeSession } from './session-summary.js';

export type CardJob =
  | { readonly kind: 'session'; readonly agent: CardAgent; readonly path: string }
  | {
      readonly kind: 'keys';
      readonly ref: SessionRef;
      /** The digest of the key index the run registered (`key-registry.ts`); a job meeting another is refused. */
      readonly digest: string;
    }
  | { readonly kind: 'repos'; readonly dirs: readonly string[]; readonly stopAt: number };

export type CardResult =
  | { readonly kind: 'session'; readonly summary: SessionSummary | null }
  | { readonly kind: 'keys'; readonly answer: KeyAnswer | null }
  | { readonly kind: 'repos'; readonly result: AutorunResult };

/** Does a job. Never throws: a job that fails is a result that says so. */
export async function handleJob(job: CardJob): Promise<CardResult> {
  switch (job.kind) {
    case 'session':
      try {
        return { kind: 'session', summary: await summarizeSession(job.agent, job.path) };
      } catch {
        return { kind: 'session', summary: null };
      }
    case 'keys':
      try {
        return { kind: 'keys', answer: await checkKeys(job.ref, job.digest) };
      } catch {
        return { kind: 'keys', answer: null };
      }
    case 'repos':
      return { kind: 'repos', result: findAutorun(job.dirs, job.stopAt) };
  }
}
