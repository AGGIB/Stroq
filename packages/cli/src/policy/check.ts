import { DEFAULT_POLICY, type Effect, type Policy } from '@stroq/core';
import { quotePath } from '../install/safe-path.js';
import { policySha256 } from './digest.js';
import { fixForField } from './fault-hints.js';
import type { Finding } from './findings.js';
import { lintPolicy, needsAttention } from './lint.js';
import type { PolicyRead } from './load.js';
import { unknownFieldFindings } from './unknown-fields.js';

/**
 * A fault that stops the file loading: the YAML does not parse, or a field does not match the schema.
 * Always an error, because the hook cannot use the file (it fails closed while the file is in place).
 */
export interface Fault {
  readonly severity: 'error';
  readonly kind: 'yaml' | 'schema';
  /** Dotted path of the field; empty when the fault is the file as a whole. */
  readonly path: string;
  /** One line from a fixed list of phrases, with the path quoted; nothing of the file's own text. */
  readonly message: string;
  readonly fix: string;
  readonly line?: number;
  readonly code?: string;
}

export interface PolicySummary {
  readonly rules: number;
  readonly default: Effect;
  readonly threshold: number;
  readonly sha256: string;
  /** Static linting is not a replay of producer-reported labels or native host enforcement. */
  readonly mcpGovernance?: {
    readonly mode: 'enforce';
    readonly allowedServers: number;
    readonly identityReplay: 'not-performed';
  };
}

/** What `stroq policy check --json` prints, and what the text form is made from. */
export interface CheckReport {
  readonly version: 1;
  /** True exactly when the command exits 0: it loaded, and no finding is an error or a warning. */
  readonly ok: boolean;
  /** `default` when no policy.yaml is in force and the built-in policy was checked. */
  readonly source: 'default' | 'file';
  readonly file: string | null;
  readonly loaded: boolean;
  readonly policy: PolicySummary | null;
  readonly faults: readonly Fault[];
  readonly findings: readonly Finding[];
}

export type Loaded = Exclude<PolicyRead, { readonly problem: 'unreadable' }>;

const summaryOf = (policy: Policy): PolicySummary => ({
  rules: policy.rules.length,
  default: policy.default,
  threshold: policy.threshold,
  sha256: policySha256(policy),
  ...(policy.version === 2
    ? {
        mcpGovernance: {
          mode: 'enforce' as const,
          allowedServers: policy.mcpGovernance.allowed.length,
          identityReplay: 'not-performed' as const,
        },
      }
    : {}),
});

export function faultsOf(read: Exclude<Loaded, { readonly ok: true }>): readonly Fault[] {
  if (read.problem === 'yaml') {
    const { what, line, code } = read.fault;
    const where = [line === null ? '' : `line ${line}`, code ?? ''].filter((s) => s !== '');
    return [
      {
        severity: 'error',
        kind: 'yaml',
        path: '',
        message: where.length === 0 ? what : `${what} (${where.join(', ')})`,
        fix:
          line === null
            ? 'rewrite the file as plain YAML, without aliases or deep nesting'
            : `correct the YAML on line ${line}`,
        ...(line === null ? {} : { line }),
        ...(code === null ? {} : { code }),
      },
    ];
  }
  return read.faults.map((fault): Fault => ({
    severity: 'error',
    kind: 'schema',
    path: fault.path,
    message: `${fault.path === '' ? 'the file' : quotePath(fault.path)}: ${fault.kind}`,
    fix: fixForField(fault.path),
  }));
}

/**
 * The report for a policy, or for the faults that stopped it loading. Lints run only on a policy that
 * loaded: they ask the evaluator, which needs one. A misspelled field is reported either way, because
 * it is often the reason a policy does not load.
 */
export function checkReport(
  where: { readonly source: 'default' | 'file'; readonly file: string | null },
  read: Loaded,
): CheckReport {
  const unknown = 'unknownFields' in read ? unknownFieldFindings(read.unknownFields) : [];
  if (!read.ok) {
    return {
      version: 1,
      ok: false,
      ...where,
      loaded: false,
      policy: null,
      faults: faultsOf(read),
      findings: unknown,
    };
  }
  const findings = [...lintPolicy(read.policy), ...unknown].sort(
    (a, b) => Number(a.severity === 'info') - Number(b.severity === 'info'),
  );
  return {
    version: 1,
    ok: !needsAttention(findings),
    ...where,
    loaded: true,
    policy: summaryOf(read.policy),
    faults: [],
    findings,
  };
}

/** The built-in policy, as a read that succeeded, for when no policy.yaml is in force. */
export const BUILT_IN_READ: Loaded = { ok: true, policy: DEFAULT_POLICY, unknownFields: [] };
