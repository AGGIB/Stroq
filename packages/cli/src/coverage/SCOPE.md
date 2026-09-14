# How `scope.json` was decided

`scope.json` declares, for every technique in the vendored MITRE ATLAS distribution, whether a
local hook-based action firewall could plausibly address it (`inScope`) or why it cannot
(`outOfScope`, grouped with a reason). Each `inScope` entry's `limitation` says what Stroq does
**not** do for that technique — the half it doesn't enforce, or the surface it cannot see.

This file is not a rehash of all 59 in-scope justifications or all 138 excluded ones — `scope.json`
already carries a `limitation` or a group `reason` for every one of the 197. It records only the
method, and the handful of calls that were genuinely close.

## Method

For each technique, the question applied was: **could a tool that sees only an agent's tool
calls and the content those calls return address this at all?** That question was answered from
the technique's own name and description in the vendored YAML
(`vendor/atlas/ATLAS-2026.08.yaml`) — not from whether Stroq's rule set already implements
something for it, and not from whether an attack-corpus scenario already tags it. Reasoning
backward from "we have a scenario for this, so it must be in scope" was the failure mode to avoid;
the corpus's own ATLAS tags were checked only once, near the end, as a sanity cross-check against
the independently-drafted list, not as an input to it.

Two consequences of taking the question literally, applied consistently across families that look
alike:

- **A technique with both a file-read vector and a conversation-only vector goes in scope with a
  limitation carving out the conversational half**, because the file read genuinely is a tool call
  Stroq sees. This is why `AML.T0084` (Discover AI Agent Configuration) and the parallel
  `AML.T0056`/`AML.T0069` family (system-prompt and LLM-system-information discovery) are both in
  scope with a matching carve-out — an earlier draft had only the first in scope, which a review
  caught as an unprincipled inconsistency between two techniques with the identical dual structure.
- **A technique that is majority one thing and minority another is placed by its majority text,
  with the minority named in the limitation or left to the sibling technique that actually covers
  it.** `AML.T0074` Masquerading is majority generic file-metadata and type deception — the same
  surface as the in-scope `AML.T0068`/`AML.T0123` obfuscation techniques — with only a minority
  clause about reclaiming a stale package/model namespace, which is adversary-side registry
  activity Stroq cannot see. It is in scope with that namespace-reclaim clause named as the gap.

## The hard calls

Six calls were close enough that a different reader could reasonably land the other way. Each is
recorded once here, not restated as a `limitation` sentence, because the reasoning is more than
one sentence.

1. **`AML.T0010.002` Data (poisoned training data arriving via supply chain) — OUT.** Its siblings
   under `AML.T0010` (`AI Software`, `Model`, `Container Registry`, `AI Agent Tool`) are in scope
   because the agent's own fetch/load/exec is a visible tool call and the artifact often carries
   executable content a rule can pattern-match. Poisoned *data* has no such tell at the point of
   fetch — a corrupted training example is byte-for-byte indistinguishable from a normal one — so
   this one sub-technique was pulled into the model-attack-surface exclusion group instead of
   following its family.

2. **`AML.T0125` Create Account — IN.** The least confident of the 59. It requires the agent to
   hold IAM/cloud-account-creation tool access, a narrow deployment shape, and no scenario in the
   corpus exercises it. Kept in because it matches the design spec's own §6b "privilege-widening
   writes" direction and the brief's instruction not to restrict scope to what's already
   implemented. This is the entry to reconsider first if a future review pushes back on it.

3. **`AML.T0056` Extract LLM System Prompt, and the `AML.T0069` family (Discover LLM System
   Information, Special Character Sets, System Instruction Keywords, System Prompt) — IN**, each
   with a limitation carving out the conversational-extraction vector. Originally excluded on the
   reasoning that reading an agent's own system-prompt file looks like routine operation with no
   distinguishing pattern. A review pointed out this reasoning was never weighed against
   `AML.T0084`, which has the identical file-read-vs-conversation structure and was kept in scope.
   Consistency won: both families are in, both carved the same way.

4. **`AML.T0102` Generate Malicious Commands — OUT.** Describes an adversary using an LLM (not
   necessarily the victim's own compromised agent) as a command-generation capability. Once such a
   command actually executes on the victim's machine through the coding agent, it is already
   covered by `AML.T0050`/`AML.T0051` regardless of how it was authored; no hook-visible signature
   distinct from "a shell command ran" could be named, so counting it separately would be claiming
   credit for detecting authorship method rather than action.

5. **`AML.T0007` Discover AI Artifacts — OUT.** Could occur through an agent's own `ls`/`find`/
   `Glob` calls if an adversary steers it there via injection, which is technically hook-visible.
   But "the agent listed some files" has no signature distinguishing it from ordinary repository
   browsing, and the technique's core — identifying ML-pipeline artifacts as a target — reads
   closer to reconnaissance than to an addressable action.

6. **`AML.T0011.003` Malicious Link — OUT**, despite sharing a parent (`AML.T0011` User Execution)
   with three in-scope siblings. Its description is majority about a human user clicking a link,
   with the agent-specific aside (an agent that fails to validate website origin headers) a minor
   fraction of the text. The majority framing was weighted over the aside, the same rule applied
   to `AML.T0074` above.
