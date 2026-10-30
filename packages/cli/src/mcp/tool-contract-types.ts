export type ContractJson =
  null | boolean | number | string | ContractJson[] | { [key: string]: ContractJson };
export interface ToolContractBinding {
  readonly schema: 'stroq-mcp-tool-binding/1';
  readonly id: string;
  readonly home: string;
  readonly cwd: string;
  readonly cwdIdentity: { readonly dev: string; readonly ino: string };
  readonly client: string;
  readonly server: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly passEnv: readonly string[];
  readonly envSha256: string;
  readonly strictMaxWithheld: number;
  readonly pin: string | null;
  readonly runtime: { readonly entry: string; readonly sha256: string };
  readonly launch: { readonly command: string; readonly argv: readonly string[] } | null;
}
export interface ToolContract {
  readonly id: string;
  readonly name: string;
  readonly sha256: string;
  readonly contract: { readonly [key: string]: ContractJson };
}
export interface ToolContractCapture {
  readonly sha256: string;
  readonly tools: readonly ToolContract[];
}
export interface ToolContractDecision {
  readonly toolId: string;
  readonly contractSha256: string;
  readonly approved: boolean;
  readonly decidedAt: string;
}
export interface ToolContractEvent {
  readonly action: 'approve' | 'revoke';
  readonly toolId: string;
  readonly contractSha256: string;
  readonly at: string;
}
/** Comparison evidence only. Null bodies are explicit unavailable legacy evidence. */
export interface ToolContractApprovedBaseline {
  readonly toolId: string;
  readonly contractSha256: string;
  readonly decidedAt: string;
  readonly contract: ToolContract['contract'] | null;
}
/** Version 3 is signed on disk (`tool-contract-record.ts`); the signature is not part of the record. */
export interface ToolContractRecord {
  readonly schema: 'stroq-mcp-tool-contracts/3';
  /** Raised by every write, inside the signed body, so a running store can refuse an older record. */
  readonly sequence: number;
  readonly binding: ToolContractBinding;
  readonly observedAt: string;
  readonly observation: 'complete' | 'invalidated';
  readonly capture: ToolContractCapture | null;
  readonly approvals: readonly ToolContractDecision[];
  readonly history: readonly ToolContractEvent[];
  readonly approvedBaselines: readonly ToolContractApprovedBaseline[];
}
export interface ToolContractSnapshot extends ToolContractRecord {
  readonly revision: string;
}
export interface ToolContractDecisionRequest {
  readonly bindingId: string;
  readonly expectedRevision: string;
  readonly expectedCaptureSha256: string;
  readonly toolId: string;
  readonly expectedContractSha256: string;
  readonly action: 'approve' | 'revoke';
}
export const TOOL_CONTRACT_LIMITS = Object.freeze({
  bindings: 64,
  tools: 256,
  toolBytes: 65_536,
  captureBytes: 1_048_576,
  recordBytes: 2_097_152,
  totalBytes: 33_554_432,
  history: 1024,
  nodes: 20_000,
  depth: 24,
});
export const TOOL_CONTRACT_ERRORS = [
  'tool-contract-invalid',
  'tool-contract-limit',
  'tool-contract-unsupported',
  'tool-contract-unavailable',
  'tool-contract-stale',
  'tool-contract-write-unconfirmed',
  'tool-contract-lock-timeout',
] as const;
export type ToolContractError = (typeof TOOL_CONTRACT_ERRORS)[number];
export function contractError(code: ToolContractError): never {
  throw new Error(code);
}
