/**
 * The vocabulary of the MCP cloak: what a detector may find, where it found it, and
 * what a dictionary remembers about it.
 *
 * A `CloakSpan` is deliberately a POSITION in a specific string, not a "this value
 * occurs somewhere" claim. The scanner's `RuleMatch` is the latter — it carries no
 * offsets, and it fires on decoded variants (base64, hex, url) of the text, which have
 * no position in the original at all. Substituting from a match like that means
 * guessing where to cut, and a wrong guess corrupts the payload rather than protecting
 * it. So everything in this directory works in offsets into one exact string, and a
 * value that cannot be PLACED is never cloaked.
 */

/**
 * What a span stands for. `secret` is the value of a credential the machine's own
 * `SecretIndex` already knows, which is a stronger claim than any pattern can make;
 * the rest are structured shapes matched by regex against the original text.
 *
 * Names and street addresses are deliberately absent: they need NER, and the credible
 * offline option would add a native runtime dependency to a project that has none. The
 * `CloakDetector` seam below is where such a pass would be added later.
 */
export type CloakKind = 'secret' | 'email' | 'phone' | 'iban' | 'card' | 'ssn';

export const CLOAK_KINDS: readonly CloakKind[] = [
  'secret',
  'email',
  'phone',
  'iban',
  'card',
  'ssn',
];

/** One value found at one place in one string. `value === text.slice(start, end)`. */
export interface CloakSpan {
  readonly kind: CloakKind;
  /** Index into the exact string this span was found in. */
  readonly start: number;
  /** Exclusive end index into that same string. */
  readonly end: number;
  readonly value: string;
  /**
   * Whether a placeholder standing for this value may ever be turned back into the
   * value on an OUTBOUND call. False for a `secret`: the model only ever saw the
   * placeholder, and restoring it would hand a known credential to the server — which
   * is exactly what `deny-secret-egress` exists to stop. A non-restorable placeholder
   * arriving in a `tools/call` is refused, not resolved.
   */
  readonly restorable: boolean;
  /**
   * A human-readable name for the value that is NOT the value — `DEMO_API_KEY (.env)`
   * for a secret — so a refusal can say what it refused to send.
   */
  readonly label?: string;
}

/**
 * The seam a later detector plugs into. Synchronous pattern matching and the
 * asynchronous secret-index lookup both satisfy it, and so would an NER pass.
 */
export interface CloakDetector {
  detect(text: string): Promise<readonly CloakSpan[]> | readonly CloakSpan[];
}

/** One remembered substitution. This is the only place Stroq stores a value it can restore. */
export interface CloakEntry {
  readonly placeholder: string;
  readonly kind: CloakKind;
  readonly value: string;
  /** ISO time this entry was last minted or used; drives the idle TTL. */
  readonly at: string;
  readonly label?: string;
}

/** What the caller asks the dictionary to find or mint a placeholder for. */
export interface CloakRequest {
  readonly kind: CloakKind;
  readonly value: string;
  readonly label?: string;
}

export interface CloakStore {
  /**
   * A placeholder per distinct requested value, minting what is new. `avoidIn` is the
   * text about to be cloaked: a freshly minted placeholder must not already occur in
   * it, or the uncloak would resolve the server's own text.
   */
  assign(requests: readonly CloakRequest[], avoidIn: string): Promise<Map<string, CloakEntry>>;
  /** The entries for the placeholders that are known; unknown ones are simply absent. */
  lookup(placeholders: readonly string[]): Promise<Map<string, CloakEntry>>;
}
