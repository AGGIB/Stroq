import { candidatesFromText, MAX_SCAN_CHARS } from '../secrets/candidates.js';
import type { SecretIndex } from '../secrets/index.js';
import { detectKeyedFields } from './keyed.js';
import { detectPatterns } from './patterns.js';
import { secretSpans } from './secret-spans.js';
import { mergeSpans } from './substitute.js';
import type { CloakDetector, CloakSpan } from './types.js';

/**
 * The two v1 detectors composed into one: the machine's own credential values,
 * located exactly, plus the structured shapes a regex can settle. Both report offsets
 * into the same string, so `mergeSpans` can lay them out without overlap and a single
 * right-to-left pass rewrites the text once.
 *
 * The order in `mergeSpans` gives a known credential priority over any shape it
 * happens to resemble, which is the right way round: the index is a fact about this
 * machine, a pattern is a guess about a string.
 *
 * A third detector reads the KEY a leaf arrived under (`keyed.ts`), which is how
 * names and street addresses are claimed. That is schema rather than a guess about
 * characters, so it needs no model and no dependency, and it is laid down last so a
 * known credential or a settled shape inside a labelled field still wins.
 *
 * A name in PROSE is still not detected. That is what an NER pass would be for, and
 * it stays absent because the credible offline option would add the project's first
 * native runtime dependency; `docs/CLOAK-COMPARISON.md` says so in the row where
 * AgentCloak is ahead.
 */

export interface CloakDetectorOptions {
  /** Without one, only the patterns run — which is exactly `detectPatterns`. */
  readonly secrets?: SecretIndex;
  /** The project directory the index is built for; nothing on the wire changes it. */
  readonly cwd: string;
}

/**
 * The same ceiling the secret-egress guard reads to. Text past it is not scanned, so
 * the caller must refuse to cloak rather than cloak a prefix: a partially cloaked
 * result is a result with the uncloaked half still in it. The MCP proxy enforces that
 * refusal; see `packages/cli/src/mcp/cloak.ts`.
 */
export const MAX_CLOAK_CHARS = MAX_SCAN_CHARS;

export function createCloakDetector(options: CloakDetectorOptions): CloakDetector {
  return {
    async detect(text: string, keys?: ReadonlySet<string>): Promise<readonly CloakSpan[]> {
      if (text === '' || text.length > MAX_CLOAK_CHARS) return [];
      const shapes = [...detectPatterns(text), ...detectKeyedFields(text, keys ?? new Set())];
      if (!options.secrets) return mergeSpans(shapes);
      const matches = await options.secrets.lookup(candidatesFromText(text), options.cwd);
      return mergeSpans([...secretSpans(text, matches), ...shapes]);
    },
  };
}
