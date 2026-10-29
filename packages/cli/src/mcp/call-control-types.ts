export type McpCallControlAction = 'configure-paused' | 'pause' | 'resume' | 'rebind-paused';
export type McpCallControlReason = 'paused' | 'unavailable' | 'busy';
export interface McpCallControlEvent {
  readonly id: string;
  readonly controlId: string;
  readonly previousEventId: string | null;
  readonly action: McpCallControlAction;
  readonly invocationSha256: string;
  readonly at: string;
}
export interface McpCallControlCurrent {
  readonly controlId: string;
  readonly invocationSha256: string;
  readonly mode: 'paused' | 'enabled';
  readonly eventId: string;
  readonly at: string;
}
export interface McpCallControlSnapshot {
  readonly schema: 'stroq-mcp-call-control-native-state/1';
  readonly history: 'missing' | 'ready';
  readonly revision: string | null;
  readonly homeBinding: string | null;
  readonly events: readonly McpCallControlEvent[];
  readonly controls: readonly McpCallControlCurrent[];
}
export interface McpCallControlDecision {
  readonly controlId: string;
  readonly invocationSha256: string;
  readonly action: McpCallControlAction;
  readonly operationId: string;
  readonly expectedRevision: string | null;
  readonly expectedEventId: string | null;
}
export interface McpCallControlBindingInput {
  readonly home: string;
  readonly cwd: string;
  readonly controlId: string;
  readonly client: string;
  readonly server: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly passEnv: readonly string[] | null;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly strict?: boolean;
  readonly cloak?: boolean;
  readonly toolApproval?: boolean;
  readonly strictMaxWithheld?: number;
  readonly pin?: string;
}
export interface McpCallControlBinding {
  readonly home: string;
  readonly controlId: string;
  readonly invocationSha256: string;
}
export interface McpCallControlAudit {
  readonly controlId: string;
  readonly eventId: string | null;
  readonly invocationSha256: string;
  readonly authoritySha256: string | null;
  readonly reason: McpCallControlReason;
}
export interface McpCallControlGuard {
  run(
    callback: (
      check: () => McpCallControlAudit | null,
      markWritten: () => void,
    ) => Promise<boolean> | boolean,
  ): Promise<{
    written: boolean;
    refusal: McpCallControlAudit | null;
  }>;
}
export const MCP_CALL_CONTROL_LIMITS = Object.freeze({
  controls: 64,
  events: 512,
  liveBytes: 384 * 1024,
  stages: 32,
  totalBytes: 1024 * 1024,
});
export const MCP_CALL_CONTROL_ERRORS = [
  'mcp-call-control-invalid',
  'mcp-call-control-stale',
  'mcp-call-control-unavailable',
  'mcp-call-control-limit',
  'mcp-call-control-busy',
  'mcp-call-control-write-unconfirmed',
  'mcp-call-control-unsupported',
] as const;
export type McpCallControlError = (typeof MCP_CALL_CONTROL_ERRORS)[number];
export const callControlUuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export const callControlSha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function callControlError(code: McpCallControlError): never {
  throw Error(code);
}
