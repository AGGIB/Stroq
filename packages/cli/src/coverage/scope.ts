import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { ATLAS_ID } from './atlas.js';

export interface ScopedTechnique {
  readonly id: string;
  /** What Stroq does NOT do for this technique, or null when coverage is unqualified. */
  readonly limitation: string | null;
}

export interface ExclusionGroup {
  /** Why a local action firewall cannot address these, in a sentence a reader can weigh. */
  readonly reason: string;
  readonly ids: readonly string[];
}

export interface AtlasScope {
  readonly atlasRelease: string;
  readonly inScope: readonly ScopedTechnique[];
  readonly outOfScope: readonly ExclusionGroup[];
}

const ScopeSchema = z.object({
  atlasRelease: z.string().min(1),
  inScope: z
    .array(z.object({ id: z.string().regex(ATLAS_ID), limitation: z.string().nullable() }))
    .min(1),
  outOfScope: z
    .array(z.object({ reason: z.string().min(31), ids: z.array(z.string().regex(ATLAS_ID)).min(1) }))
    .min(1),
});

/**
 * Read next to the bundle at runtime, the same way `atlas.ts` reads `atlas.json`:
 * this is data, not code, and a reader auditing scope decisions should be able to
 * diff this file directly rather than decompile a bundle. `tsup.config.ts` copies
 * it beside the bundle.
 */
const SCOPE_URL = new URL('./scope.json', import.meta.url);
let cached: AtlasScope | null = null;

export function loadScope(): AtlasScope {
  cached ??= ScopeSchema.parse(JSON.parse(readFileSync(SCOPE_URL, 'utf8')));
  return cached;
}
