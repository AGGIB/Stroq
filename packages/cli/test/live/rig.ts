import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, type AuditEntry } from '@stroq/core';
import { prepareProject } from '../../src/live/probes.js';
import type { ProbeContext } from '../../src/live/types.js';
import { FAKE, NONCE, SESSION } from './helpers.js';

/** The throwaway directories a live check runs in: a project, a Stroq home and a HOME. */
export interface Rig {
  readonly root: string;
  readonly project: string;
  readonly stroqHome: string;
  readonly home: string;
  ctx(over?: Partial<ProbeContext>): ProbeContext;
  /** Every audit entry in the throwaway Stroq home. */
  audit(): Promise<AuditEntry[]>;
  cleanup(): void;
}

export function makeRig(prepare = true): Rig {
  const root = mkdtempSync(join(tmpdir(), 'stroq-live-rig-'));
  const project = join(root, 'project');
  const stroqHome = join(root, 's');
  const home = join(root, 'h');
  for (const dir of [project, stroqHome, home]) mkdirSync(dir);
  if (prepare) prepareProject(project, FAKE);
  return {
    root,
    project,
    stroqHome,
    home,
    ctx: (over = {}) => ({
      project,
      stroqHome,
      home,
      sessionId: SESSION,
      nonce: NONCE,
      hookMode: 'real',
      deadlineMs: 5_000,
      env: {},
      ...over,
    }),
    audit: () => new AuditLog(join(stroqHome, 'audit.jsonl')).readAll(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
