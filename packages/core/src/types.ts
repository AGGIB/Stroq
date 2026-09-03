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
  | 'mcp.side_effect';

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
