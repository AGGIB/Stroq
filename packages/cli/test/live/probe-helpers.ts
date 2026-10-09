import { buildProbes } from '../../src/live/probes.js';
import type { Probe } from '../../src/live/types.js';
import { FAKE, NONCE } from './helpers.js';

export const probesFor = (nonce: string = NONCE, fake: string = FAKE): readonly Probe[] =>
  buildProbes(nonce, fake);

/** The probe of this kind, built around the fixed nonce unless another is given. */
export const probe = (kind: Probe['kind'], nonce: string = NONCE): Probe => {
  const found = probesFor(nonce).find((p) => p.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} probe`);
  return found;
};
