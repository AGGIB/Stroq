export type ActionClass =
  | 'shell.exec_encoded'
  | 'shell.network'
  | 'shell.destructive'
  | 'fs.secrets'
  | 'git.push_external'
  | 'config.self'
  | 'config.self_touch'
  | 'network.fetch'
  | 'mcp.call'
  | 'mcp.side_effect'
  | 'origin.untrusted'
  | 'origin.suspect'
  | 'secret.egress';

export const ACTION_CLASSES: readonly ActionClass[] = [
  'shell.exec_encoded',
  'shell.network',
  'shell.destructive',
  'fs.secrets',
  'git.push_external',
  'config.self',
  'config.self_touch',
  'network.fetch',
  'mcp.call',
  'mcp.side_effect',
  'origin.untrusted',
  'origin.suspect',
  'secret.egress',
];

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export type Effect = 'allow' | 'deny' | 'ask';

export interface Decision {
  readonly effect: Effect;
  readonly ruleId: string | null;
  readonly reason: string;
}

export type TaintLevel = 'suspect';

export interface TaintSource {
  readonly tool: string;
  readonly ruleIds: readonly string[];
  readonly at: string;
}

export interface Taint {
  readonly level: TaintLevel;
  readonly since: string;
  readonly sources: readonly TaintSource[];
}

export interface SessionState {
  readonly sessionId: string;
  readonly taint: Taint | null;
  readonly updatedAt: string;
}

export type VariantKind = 'raw' | 'normalized' | 'base64' | 'hex' | 'url';

export interface RuleMatch {
  readonly ruleId: string;
  readonly title: string;
  readonly severity: Severity;
  readonly category: string;
  readonly variant: VariantKind;
}

export interface ScanResult {
  readonly verdict: 'clean' | 'suspect';
  readonly score: number;
  readonly matches: readonly RuleMatch[];
  /** True when the scan hit its time budget and failed closed. */
  readonly timedOut?: boolean;
}

export interface PreToolEvent {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  readonly cwd: string;
}

export interface PostToolEvent extends PreToolEvent {
  readonly toolResultText: string;
}

/** Kinds of "actionable atoms" tracked for instruction provenance. */
export type AtomKind = 'url' | 'host' | 'pkg' | 'pipe_shell' | 'encoded';

export interface Atom {
  readonly kind: AtomKind;
  /** Normalized value (lower-cased, whitespace-collapsed, version-stripped); ≤ 512 chars. */
  readonly value: string;
}

/** One atom seen in a tool output earlier in the session. Stored on disk; never contains raw output. */
export interface ProvenanceRecord {
  readonly seq: number;
  readonly at: string;
  /** Tool whose output carried the atom, e.g. `Read`, `mcp__sentry__get_issue`. */
  readonly tool: string;
  /** Redacted summary of that tool's input (file path, URL, command, or JSON), ≤ 120 chars. */
  readonly source: string;
  readonly kind: AtomKind;
  /** `atomHash(atom)` — the lookup key. */
  readonly hash: string;
  /** Redacted atom value, ≤ 120 chars, for explanations. */
  readonly excerpt: string;
  /** Whether the scan of that output was `suspect`. */
  readonly suspect: boolean;
}

export interface ProvenanceHit {
  readonly atom: Atom;
  readonly record: ProvenanceRecord;
}

/** The explanation-oriented subset of a hit, as written to the audit log. */
export interface ProvenanceEvidence {
  readonly kind: AtomKind;
  readonly excerpt: string;
  readonly tool: string;
  readonly source: string;
  readonly at: string;
  readonly suspect: boolean;
}

/** A known secret whose value appeared in an outbound tool call. Never carries the value. */
export interface SecretHit {
  /** Key or variable name, e.g. `AWS_SECRET_ACCESS_KEY`, `password (api.github.com)`. */
  readonly name: string;
  /** Where the value was indexed from: a display path (`~/.aws/credentials`), `env`, or `canary`. */
  readonly source: string;
  readonly canary: boolean;
}

/** In-memory match result: what matched, used only to redact it from summaries. */
export interface SecretMatch extends SecretHit {
  /** The lookup form that hashed to a known secret (URL-decoded where that applied). */
  readonly token: string;
  /** The substring exactly as it appeared in the tool input, over-encoding and all. */
  readonly raw: string;
}
