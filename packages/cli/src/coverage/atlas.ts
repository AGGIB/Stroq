import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** `AML.T####`, or `AML.T####.###` for a sub-technique. The only id shape ATLAS uses. */
export const ATLAS_ID = /^AML\.T\d{4}(?:\.\d{3})?$/;

export interface AtlasTechnique {
  readonly id: string;
  readonly name: string;
  /** The parent technique's id for a sub-technique, null for a top-level one. */
  readonly parent: string | null;
}

export interface AtlasDenominator {
  /** Upstream content release, e.g. `2026.08`. */
  readonly release: string;
  /** Upstream format version, e.g. `6.0.0`. */
  readonly formatVersion: string;
  readonly source: string;
  /** sha256 of the vendored YAML this was derived from. */
  readonly sha256: string;
  readonly techniques: readonly AtlasTechnique[];
}

const AtlasSchema = z.object({
  release: z.string().min(1),
  formatVersion: z.string().min(1),
  source: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  techniques: z
    .array(
      z.object({
        id: z.string().regex(ATLAS_ID),
        name: z.string().min(1),
        parent: z.string().regex(ATLAS_ID).nullable(),
      }),
    )
    .min(1),
});

/**
 * Read next to the bundle at runtime, the way `attack/scenarios/index.ts` reads
 * `corpus.json`: this is data, not code, and inlining 15 KB of taxonomy into
 * `dist/index.js` buys nothing. `tsup.config.ts` copies it beside the bundle.
 */
const ATLAS_URL = new URL('./atlas.json', import.meta.url);
let cached: AtlasDenominator | null = null;

export function loadAtlas(): AtlasDenominator {
  cached ??= AtlasSchema.parse(JSON.parse(readFileSync(ATLAS_URL, 'utf8')));
  return cached;
}

let cachedIds: ReadonlySet<string> | null = null;

/** Every technique id in the vendored denominator, for validating a corpus tag. */
export function atlasIds(): ReadonlySet<string> {
  cachedIds ??= new Set(loadAtlas().techniques.map((t) => t.id));
  return cachedIds;
}
