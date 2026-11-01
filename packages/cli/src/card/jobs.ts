// The three kinds of job the card gives its workers, and what each one does.
//
//   session  one transcript: replay it and count what a text told the agent to run
//   sent     the keys of this machine against every session in the window (`stroq sent`)
//   repos    the session folders that still exist, for what they run by themselves
//
// Every job and every result is plain data, so it crosses a thread unchanged. `handleJob` is the one
// function that does the work, in a worker or in this process: a run with one thread and a run with
// many call the same code and so give the same answer.
import { checkSessions } from '../sent/run.js';
import type { SentReport } from '../sent/report.js';
import type { SessionRef } from '../sent/sessions.js';
import { findAutorun, type AutorunResult } from './autorun.js';
import type { CardAgent, SessionSummary } from './schema.js';
import { summarizeSession } from './session-summary.js';

export type CardJob =
  | { readonly kind: 'session'; readonly agent: CardAgent; readonly path: string }
  | {
      readonly kind: 'sent';
      readonly refs: readonly SessionRef[];
      readonly home: string;
      readonly cwd: string;
      readonly stroqHome: string;
      /** The time of the run, in milliseconds since the epoch. */
      readonly now: number;
    }
  | { readonly kind: 'repos'; readonly dirs: readonly string[]; readonly stopAt: number };

export type CardResult =
  | { readonly kind: 'session'; readonly summary: SessionSummary | null }
  | { readonly kind: 'sent'; readonly report: SentReport | null; readonly why?: string }
  | { readonly kind: 'repos'; readonly result: AutorunResult };

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Does a job. Never throws: a job that fails is a result that says so. */
export async function handleJob(job: CardJob): Promise<CardResult> {
  switch (job.kind) {
    case 'session':
      try {
        return { kind: 'session', summary: await summarizeSession(job.agent, job.path) };
      } catch {
        return { kind: 'session', summary: null };
      }
    case 'sent':
      try {
        const report = await checkSessions(
          job.refs,
          {
            home: job.home,
            cwd: job.cwd,
            env: process.env,
            now: new Date(job.now),
            stroqHome: job.stroqHome,
          },
          { scope: 'machine', cursorUnavailable: null },
        );
        return { kind: 'sent', report };
      } catch (err) {
        return { kind: 'sent', report: null, why: messageOf(err) };
      }
    case 'repos':
      return { kind: 'repos', result: findAutorun(job.dirs, job.stopAt) };
  }
}
