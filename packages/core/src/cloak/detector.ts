import { candidatesFromText, MAX_SCAN_CHARS } from '../secrets/candidates.js';
import type { SecretIndex } from '../secrets/index.js';
import { detectKeyedFields } from './keyed.js';
import { detectPatterns } from './patterns.js';
import { compileNameMatcher, nameNeedles } from './prose-names.js';
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
 * A name in prose is reached by `detectAcrossLeaves` below, which runs this detector
 * over every leaf and then looks again for the names the result labelled itself. What
 * is still not detected is a name that appears ONLY in free text, with no field
 * anywhere in the result to name it — that is what an NER pass would be for, and it
 * stays absent because the credible offline option would add the project's first
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

/**
 * Detection over a whole result rather than one leaf at a time.
 *
 * Two passes, because the second needs the first's answer. The first asks the
 * detector about each distinct leaf with every key it was seen under, exactly as
 * before. The second takes the names that pass produced — names the SERVER labelled,
 * never a guess — and looks for them again in the leaves that carry prose. Without
 * it, `{"first_name":"Peter Parker","note":"call Peter about the invoice"}` cloaks
 * the field and hands the model the note intact, which protects nothing.
 *
 * `mergeSpans` settles any overlap, so a leaf already claimed whole by its key keeps
 * that claim and a secret inside a sentence still outranks a name beside it.
 */
export async function detectAcrossLeaves(
  leaves: ReadonlyMap<string, ReadonlySet<string>>,
  detector: CloakDetector,
): Promise<Map<string, readonly CloakSpan[]>> {
  const found = new Map<string, readonly CloakSpan[]>();
  const names = new Set<string>();
  for (const [text, keys] of leaves) {
    const spans = mergeSpans(await detector.detect(text, keys));
    if (spans.length > 0) found.set(text, spans);
    for (const span of spans) if (span.kind === 'name') names.add(span.value);
  }
  if (names.size === 0) return found;

  const matcher = compileNameMatcher(nameNeedles(names));
  if (matcher === null) return found;
  for (const text of leaves.keys()) {
    const prose = matcher(text);
    if (prose.length === 0) continue;
    const merged = mergeSpans([...(found.get(text) ?? []), ...prose]);
    found.set(text, merged);
  }
  return found;
}
