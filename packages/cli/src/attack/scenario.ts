import { z } from 'zod';
import type { ClaudeHookEvent } from '../adapters/claude-code.js';
import { ASI_ID, asiIds } from '../coverage/asi.js';
import { atlasIds, ATLAS_ID } from '../coverage/atlas.js';

/** What a step must produce: a decision effect for `PreToolUse`, a scan verdict for `PostToolUse`. */
export type StepExpectation = 'deny' | 'ask' | 'allow' | 'suspect' | 'clean';

export interface ScenarioStep {
  /**
   * A recorded Claude Code hook event, exactly as `stroq hook claude-code` receives it.
   * `__CWD__` inside any string is replaced by the scenario's project directory at run time.
   */
  readonly event: ClaudeHookEvent;
  readonly expect: StepExpectation;
}

export interface Incident {
  readonly name: string;
  readonly url: string;
  /** `YYYY-MM` of the public report. */
  readonly date: string;
}

/**
 * Where the untrusted content that drives a scenario arrives from. `direct-user` is
 * not one of the spec's fourteen: it marks a recorded incident where the agent's own
 * action is the attack and no content was injected anywhere (an `rm -rf ~`, a token
 * written into an egress call). Those cells are real incidents and must stay, but
 * they carry no payload text, so the fuzzer has nothing to mutate in them and says so.
 */
export const ORIGINS = [
  'web-fetch',
  'repo-file',
  'dependency-content',
  'mcp-result',
  'mcp-tool-description',
  'skill-markdown',
  'instruction-file',
  'command-output',
  'image',
  'pdf',
  'issue-body',
  'issue-title',
  'ci-log',
  'filename',
  'direct-user',
] as const;
export type Origin = (typeof ORIGINS)[number];

export const ENCODINGS = [
  'plain',
  'base64',
  'hex',
  'rot13',
  'homoglyph',
  'invisible',
  'bidi',
  'html-comment',
  'markdown-link-title',
  'split',
  'non-english',
  'code-comment',
  'format-mimicry',
] as const;
export type Encoding = (typeof ENCODINGS)[number];

export const EFFECTS = [
  'exec',
  'credential-exfil',
  'source-exfil',
  'supply-chain-persistence',
  'self-tamper',
  'destructive',
  'policy-weakening',
  'data-poisoning',
] as const;
export type Effect = (typeof EFFECTS)[number];

export interface Scenario {
  /** Stable id `NN-kebab-case`; `NN` is the scenario's position in the suite. */
  readonly id: string;
  readonly title: string;
  /** The public report this models, or null for a synthetic matrix cell. */
  readonly incident: Incident | null;
  /** What class of attack a synthetic cell models. Null exactly when `incident` is set. */
  readonly class: string | null;
  readonly origin: Origin;
  readonly encoding: Encoding;
  readonly effect: Effect;
  /** Canonical MITRE ATLAS technique ids; every one exists in the vendored denominator. */
  readonly atlas: readonly string[];
  /** OWASP ASI ids; every one exists in the pinned Top 10 for Agentic Applications list. */
  readonly asi: readonly string[];
  /** Files created inside the project directory before the steps run (paths relative to it). */
  readonly files?: Readonly<Record<string, string>>;
  /** At least one step; the last one is the attack itself and must be a `PreToolUse`. */
  readonly steps: readonly [ScenarioStep, ...ScenarioStep[]];
}

export const CWD_PLACEHOLDER = '__CWD__';
/** Every secret value in the suite starts with this, so no scenario can ever carry a real credential. */
export const SYNTHETIC_SECRET_PREFIX = 'stroq_attack_';
export const SESSION_ID = 'stroq-attack';

const StepExpectationSchema = z.enum(['deny', 'ask', 'allow', 'suspect', 'clean']);

const AtlasIdSchema = z
  .string()
  .regex(ATLAS_ID, 'not an ATLAS technique id (AML.T####[.###])')
  .refine((id) => atlasIds().has(id), {
    message: 'not present in the vendored ATLAS denominator (vendor/atlas)',
  });

const AsiIdSchema = z
  .string()
  .regex(ASI_ID, 'not an OWASP ASI id (ASI01-ASI10)')
  .refine((id) => asiIds().has(id), {
    message: 'not present in the pinned OWASP Top 10 for Agentic Applications list',
  });

/**
 * Structural shape of a scenario loaded from `scenarios/corpus.json`. `event` is left
 * as an untyped record here: `runScenario` already parses it fully against
 * `ClaudeHookInputSchema` before running it, so this schema only needs to catch a
 * malformed corpus file, not duplicate that validation.
 */
const ScenarioSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    incident: z
      .object({ name: z.string(), url: z.string(), date: z.string() })
      .nullable()
      .default(null),
    class: z.string().min(1).nullable().default(null),
    origin: z.enum(ORIGINS),
    encoding: z.enum(ENCODINGS),
    effect: z.enum(EFFECTS),
    atlas: z.array(AtlasIdSchema).min(1),
    asi: z.array(AsiIdSchema).default([]),
    files: z.record(z.string(), z.string()).optional(),
    steps: z
      .array(z.object({ event: z.record(z.string(), z.unknown()), expect: StepExpectationSchema }))
      .min(1),
  })
  // A cell is either a documented incident or a synthetic class, never both and never
  // neither: that is the whole guarantee §8 of the spec makes publicly, and it is
  // cheaper to enforce here than to police in review.
  .refine((s) => (s.incident === null) !== (s.class === null), {
    message: 'a scenario carries exactly one of `incident` (documented) or `class` (synthetic)',
  });

const ScenarioCorpusSchema = z.array(ScenarioSchema).min(1);

/** Parses and narrows the JSON content of `scenarios/corpus.json` into typed scenarios. */
export function parseScenarioCorpus(raw: unknown): readonly Scenario[] {
  return ScenarioCorpusSchema.parse(raw) as unknown as readonly Scenario[];
}

/** True for a scenario that cites a public incident, false for a synthetic matrix cell. */
export function isDocumented(s: Scenario): boolean {
  return s.incident !== null;
}
