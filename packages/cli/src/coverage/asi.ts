import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** `ASI01` through `ASI10`. The only id shape the OWASP list uses. */
export const ASI_ID = /^ASI(?:0[1-9]|10)$/;

export interface AsiRisk {
  readonly id: string;
  readonly name: string;
}

export interface AsiLayer {
  readonly source: string;
  /** The edition year the ids were transcribed from, e.g. `2026`. */
  readonly edition: string;
  /** `YYYY-MM-DD` the edition was announced. */
  readonly published: string;
  readonly url: string;
  readonly note: string;
  readonly risks: readonly AsiRisk[];
}

const AsiSchema = z.object({
  source: z.string().min(1),
  edition: z.string().min(1),
  published: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  url: z.string().url(),
  note: z.string().min(1),
  risks: z
    .array(z.object({ id: z.string().regex(ASI_ID), name: z.string().min(1) }))
    .length(10),
});

/**
 * Read next to the bundle at runtime, the same way `atlas.ts` reads `atlas.json`:
 * this is data, not code, and a reader should be able to diff it directly rather
 * than decompile it out of the bundle. `tsup.config.ts` copies it beside the bundle.
 */
const ASI_URL = new URL('./asi.json', import.meta.url);
let cached: AsiLayer | null = null;

export function loadAsi(): AsiLayer {
  cached ??= AsiSchema.parse(JSON.parse(readFileSync(ASI_URL, 'utf8')));
  return cached;
}

let cachedIds: ReadonlySet<string> | null = null;

/** Every risk id in the pinned OWASP list, for validating a corpus tag. */
export function asiIds(): ReadonlySet<string> {
  cachedIds ??= new Set(loadAsi().risks.map((r) => r.id));
  return cachedIds;
}
