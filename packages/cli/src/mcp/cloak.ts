import {
  MAX_CLOAK_CHARS,
  applySpans,
  collectKeyedStrings,
  findPlaceholders,
  mapStrings,
  mergeSpans,
  restore,
  type AuditLog,
  type CloakDetector,
  type CloakEvent,
  type CloakRequest,
  type CloakSpan,
  type CloakStore,
} from '@stroq/core';

/**
 * The MCP cloak, as the proxy uses it: replace values on their way to the model,
 * restore them on their way back to the server, and refuse the cases where doing
 * either would be wrong.
 *
 * Two rules decide everything here.
 *
 * 1. **Cloak inbound, restore outbound — except for secrets.** A placeholder that
 *    stands for a value this machine's secret index recognises is NEVER turned back
 *    into that value. The model only ever saw the placeholder, so restoring it would
 *    put a credential on the wire that `deny-secret-egress` exists to keep off it.
 *    Such a call is refused; `plan.refused` carries the labels a refusal may print.
 *
 * 2. **Judge what the model actually sent, then restore.** The proxy judges the call
 *    as it arrived — with placeholders in it — and only substitutes afterwards, on the
 *    line it forwards. That ordering is safe precisely because of rule 1 plus the
 *    kinds v1 detects: an email, a phone number, an IBAN, a card number and an SSN
 *    contribute no action class and no provenance atom, so restoring one cannot turn
 *    an allow into something the policy would have denied. A kind that DID carry
 *    classification weight would have to be judged after restoring instead, and that
 *    is the constraint any future detector has to satisfy before it is added.
 */

/** What happened to one result. `refused` means it must not be delivered as it stands. */
export type CloakOutcome =
  | { readonly kind: 'unchanged' }
  | {
      readonly kind: 'cloaked';
      readonly result: unknown;
      readonly replacements: readonly CloakEvent[];
    }
  | { readonly kind: 'refused'; readonly reason: string };

/** What a client line's placeholders resolve to, before anything is rewritten. */
export interface UncloakPlan {
  /** Placeholder → value, for the ones that may be restored. */
  readonly values: ReadonlyMap<string, string>;
  /** Kind per restorable placeholder, so the audit can name it without the value. */
  readonly kinds: ReadonlyMap<string, string>;
  /**
   * One LABEL per placeholder standing for a known secret — `NAME (source)`, never
   * the value. The plan travels into a deny reason, an audit summary and, on a bad
   * day, a stack trace; carrying the credential in it would undo the whole feature,
   * so the value is looked up, classified and dropped inside `planUncloak`.
   */
  readonly refused: readonly string[];
  /** Placeholders no dictionary knows — expired, pruned, or never minted here. */
  readonly unresolved: readonly string[];
}

/**
 * The plan for "this line carries no placeholder at all", which is almost every line.
 * Shared rather than rebuilt, and safe to share only because nothing in this module
 * ever writes to a plan: `applyUncloak` reads `values`, `auditUncloak` reads
 * `unresolved`, and both return new objects. A future reader that needs a mutable
 * plan must build one instead of reaching for this.
 */
export const EMPTY_PLAN: UncloakPlan = {
  values: new Map(),
  kinds: new Map(),
  refused: [],
  unresolved: [],
};

export interface McpCloakOptions {
  readonly detector: CloakDetector;
  readonly store: CloakStore;
  readonly audit: AuditLog;
  readonly sessionId: string;
}

/** `{ kind, placeholder, count }` from a flat list, in first-seen order. */
function tally(
  direction: CloakEvent['direction'],
  seen: readonly { readonly kind: string; readonly placeholder: string }[],
): readonly CloakEvent[] {
  const counts = new Map<string, CloakEvent>();
  for (const { kind, placeholder } of seen) {
    const previous = counts.get(placeholder);
    counts.set(
      placeholder,
      previous
        ? { ...previous, count: previous.count + 1 }
        : { direction, kind, placeholder, count: 1 },
    );
  }
  return [...counts.values()];
}

export class McpCloak {
  constructor(private readonly opts: McpCloakOptions) {}

  /**
   * Detects across every string LEAF of the parsed result and rewrites each one in a
   * single right-to-left pass. The whole result is measured first: a payload past
   * `MAX_CLOAK_CHARS` is everything the detector can read, and cloaking a prefix of it
   * would deliver the uncloaked remainder — so it is refused instead, which the proxy
   * turns into "not forwarded".
   */
  async cloakResult(result: unknown): Promise<CloakOutcome> {
    const serialised = JSON.stringify(result) ?? '';
    if (serialised.length > MAX_CLOAK_CHARS)
      return {
        kind: 'refused',
        reason: `the result serialises to ${serialised.length} characters, more than the ${MAX_CLOAK_CHARS} Stroq can scan whole`,
      };
    // One detection per DISTINCT string, cached: a result that repeats the same cell
    // in a hundred rows costs one pass, and `mapStrings` below reads the same cache.
    //
    // Keyed by text and not by (text, key) on purpose. `collectKeyedStrings` hands
    // over every key one value was seen under, so a name that arrives as
    // `first_name` in one row and inside a `note` in another is detected once and
    // replaced in BOTH — a value cloaked in one leaf and left in the next is a value
    // the model still reads.
    const spansByText = new Map<string, readonly CloakSpan[]>();
    for (const [text, keys] of collectKeyedStrings(result)) {
      const spans = mergeSpans(await this.opts.detector.detect(text, keys));
      if (spans.length > 0) spansByText.set(text, spans);
    }
    if (spansByText.size === 0) return { kind: 'unchanged' };

    const requests: CloakRequest[] = [];
    for (const spans of spansByText.values()) {
      for (const span of spans) {
        requests.push({
          kind: span.kind,
          value: span.value,
          ...(span.label === undefined ? {} : { label: span.label }),
        });
      }
    }
    // `serialised` is what a freshly minted placeholder must not already occur in:
    // it covers every leaf at once, so no placeholder can collide with text the
    // server wrote in a part of the result this leaf knows nothing about.
    const assigned = await this.opts.store.assign(requests, serialised);
    const seen: { kind: string; placeholder: string }[] = [];
    const rewritten = mapStrings(result, (text) => {
      const spans = spansByText.get(text);
      if (!spans) return text;
      const out = applySpans(text, spans, (span) => assigned.get(span.value)?.placeholder ?? text);
      for (const r of out.replacements) seen.push({ kind: r.kind, placeholder: r.placeholder });
      return out.text;
    });
    return { kind: 'cloaked', result: rewritten, replacements: tally('cloak', seen) };
  }

  /** Writes the `post`-phase record of a cloak. A no-op for anything but `cloaked`. */
  async auditCloak(toolName: string, outcome: CloakOutcome): Promise<void> {
    if (outcome.kind !== 'cloaked') return;
    await this.opts.audit.append({
      sessionId: this.opts.sessionId,
      phase: 'post',
      tool: toolName,
      summary: `mcp cloak: ${outcome.replacements.length} value(s) replaced in a tools/call result`,
      cloak: outcome.replacements,
    });
  }

  /** Writes the `pre`-phase record of a restore, and of the placeholders it could not resolve. */
  async auditUncloak(
    toolName: string,
    plan: UncloakPlan,
    replacements: readonly CloakEvent[],
  ): Promise<void> {
    if (replacements.length === 0 && plan.unresolved.length === 0) return;
    await this.opts.audit.append({
      sessionId: this.opts.sessionId,
      phase: 'pre',
      tool: toolName,
      summary:
        `mcp uncloak: ${replacements.length} placeholder(s) restored, ` +
        `${plan.unresolved.length} unresolved and forwarded as written`,
      ...(replacements.length > 0 ? { cloak: replacements } : {}),
    });
  }

  /**
   * Looks up every placeholder the message carries, without changing anything.
   *
   * The search runs over the SERIALISED message, not over its string leaves, so a
   * placeholder hidden in an object key is still found — a key is never rewritten
   * (see `json-strings.ts`), but a secret placeholder sitting in one must still refuse
   * the call rather than travel as literal text nobody looked at.
   */
  async planUncloak(value: unknown): Promise<UncloakPlan> {
    const placeholders = findPlaceholders(JSON.stringify(value) ?? '');
    if (placeholders.length === 0) return EMPTY_PLAN;
    const entries = await this.opts.store.lookup(placeholders);
    const values = new Map<string, string>();
    const kinds = new Map<string, string>();
    const refused: string[] = [];
    const unresolved: string[] = [];
    for (const placeholder of placeholders) {
      const entry = entries.get(placeholder);
      if (entry === undefined) {
        unresolved.push(placeholder);
        continue;
      }
      // The dictionary records the kind; `secret` is the one that is never restored.
      if (entry.kind === 'secret') {
        refused.push(entry.label ?? `${placeholder}, an unnamed credential`);
        continue;
      }
      values.set(placeholder, entry.value);
      kinds.set(placeholder, entry.kind);
    }
    return { values, kinds, refused, unresolved };
  }

  /**
   * Applies a plan to the string leaves of `value`. Keys are left alone: rewriting one
   * would change the shape the server is asked to look up, and a restorable
   * placeholder in a key is not a case any MCP tool has.
   */
  applyUncloak(
    value: unknown,
    plan: UncloakPlan,
  ): { readonly value: unknown; readonly replacements: readonly CloakEvent[] } {
    if (plan.values.size === 0) return { value, replacements: [] };
    const seen: { kind: string; placeholder: string }[] = [];
    const out = mapStrings(value, (text) => {
      const done = restore(text, plan.values);
      for (const placeholder of done.restored)
        seen.push({ kind: plan.kinds.get(placeholder) ?? 'unknown', placeholder });
      return done.text;
    });
    return { value: out, replacements: tally('uncloak', seen) };
  }
}

/**
 * The extra content item a cloaked result carries. Without it the model reads
 * `[STROQ_EMAIL_1]` as a corrupted field and either invents a plausible address or
 * tells the user the tool is broken; with it, echoing the placeholder verbatim is the
 * documented way to act on the value it stands for. It is Stroq's own text, appended
 * the same way the taint warning already is.
 */
export function cloakNotice(replacements: readonly CloakEvent[]): string {
  const kinds = [...new Set(replacements.map((r) => r.kind))].sort().join(', ');
  const secret = replacements.some((r) => r.kind === 'secret');
  return (
    `⚠ Stroq cloak: ${replacements.length} value(s) in this result were replaced with placeholders before you saw them (${kinds}). ` +
    'Use a placeholder verbatim where you would have used the value and Stroq will restore it on the way back to this server. ' +
    (secret
      ? 'A [STROQ_SECRET_*] placeholder stands for a credential on this machine and is never restored: a call carrying one is blocked.'
      : 'Do not guess at what a placeholder stands for.')
  );
}
