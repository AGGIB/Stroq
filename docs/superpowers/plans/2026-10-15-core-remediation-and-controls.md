# Core Remediation, Control Neutralization, and Trust Store Test Implementation Plan

## Context
The core policy evaluation and remediation pipeline (`packages/core`) protects terminals from malicious escape sequences via `neutralizeControls` and constructs remediation guidance for taint/origin false positives via `withWayOut`. In addition, `FileTrustStore` maintains cryptographic exemption pins. Adding dedicated unit tests locks in the invariants across C0/C1 control neutralization, bidirectional isolate stripping, shell argument escaping, remediation reason formatting, and trust store listing and caching.

## Scope of Work
1. `packages/core/test/util/controls.test.ts`: Dedicated unit test suite for `neutralizeControls` covering C0/C1 ranges, DEL, BiDi isolates/overrides, preserved whitespace, JSON serialization idempotency, and unicode multi-byte stability.
2. `packages/core/test/policy/way-out.test.ts`: Dedicated unit test suite for `withWayOut` verifying taint/origin matching, shell-quoting with single-quote escaping, file trust suggestion generation for Read tools, age label formatting, and period deduplication.
3. `packages/core/test/taint/trust.test.ts`: Expanded coverage for `FileTrustStore.list()`, cache memoization, non-existent file handling, and corrupted JSON resilience.
4. `packages/core/src/index.ts`: Re-export `way-out.js` to expose remediation utilities cleanly.

## Execution Order
- Task 1: Add implementation plan.
- Task 2: Create `packages/core/test/util/controls.test.ts`.
- Task 3: Create `packages/core/test/policy/way-out.test.ts`.
- Task 4: Expand `packages/core/test/taint/trust.test.ts`.
- Task 5: Export `way-out.js` from `packages/core/src/index.ts` and verify test suite.
