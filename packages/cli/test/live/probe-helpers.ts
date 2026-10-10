import { buildProbes } from '../../src/live/probes.js';
import type { Probe } from '../../src/live/types.js';
import { FAKE, NONCE } from './helpers.js';

/**
 * A project directory that is not there. The pure tests (marks, evidence, prompts) only read the text of a
 * command, so they build their probes around a path that nothing touches; a test that runs a command
 * through the real engine, or a driver in a directory, gives the real one.
 */
export const PROJECT = '/fixed/project';

export const probesFor = (
  nonce: string = NONCE,
  fake: string = FAKE,
  project: string = PROJECT,
): readonly Probe[] => buildProbes(nonce, fake, project);

/** The probe of this kind, built around the fixed nonce and project unless others are given. */
export const probe = (
  kind: Probe['kind'],
  nonce: string = NONCE,
  project: string = PROJECT,
): Probe => {
  const found = probesFor(nonce, FAKE, project).find((p) => p.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} probe`);
  return found;
};
