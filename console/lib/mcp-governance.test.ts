import { it, expect } from 'vitest';
import * as g from './mcp-governance';
import * as f from './mcp-governance-fixtures';
it('accepts closed policy-only state and bound manual capture with opaque choices', () => {
  expect(g.validateMcpGovernanceState(f.governanceState())).toBe(true);
  expect(g.validateMcpGovernanceCapture(f.governanceCapture())).toBe(true);
  expect(g.validateMcpGovernancePreview(f.governancePreview())).toBe(true);
  expect(g.validateMcpGovernanceReceipt(f.governanceReceipt())).toBe(true);
  expect(g.validateMcpGovernanceRecheck(f.governanceRecheck())).toBe(true);
});
it('rejects raw paths, commands, freeform selection identity and malformed opaque ids', () => {
  for (const extra of [
    { path: '/private/SECRET' },
    { command: 'node hidden' },
    { name: 'notes', channel: 'mcp-proxy' },
  ]) {
    expect(g.validateMcpGovernanceCapture({ ...f.governanceCapture(), ...extra })).toBe(false);
    expect(
      g.validateMcpGovernancePreviewRequest({
        captureId: f.governanceId(1),
        binding: f.governanceBinding(),
        selected: [{ id: 'choice-' + '1'.repeat(64), expectedSha256: '2'.repeat(64), ...extra }],
      }),
    ).toBe(false);
  }
});
it('requires coalesced unique identities, known reasons and opaque eligible choices', () => {
  const c = f.governanceCapture();
  expect(g.validateMcpGovernanceCapture({ ...c, choices: [...c.choices, ...c.choices] })).toBe(
    false,
  );
  expect(
    g.validateMcpGovernanceCapture({
      ...c,
      choices: [f.governanceChoice({ pair: f.governancePair({ redacted: true }) })],
    }),
  ).toBe(true);
  expect(
    g.validateMcpGovernanceCapture({
      ...c,
      choices: [f.governanceChoice({ eligibility: 'unsupported', reason: null })],
    }),
  ).toBe(false);
  expect(
    g.validateMcpGovernanceCapture({
      ...c,
      choices: [f.governanceChoice({ sourceRefs: [], kind: 'retained', inAllowSet: true })],
    }),
  ).toBe(true);
});
it('empty allowset has a non-applicable listed case, never a fabricated passing case', () => {
  const p = f.governancePreview();
  p.selected = [];
  p.diff.added = [];
  p.gateChecks.cases[0]!.status = 'not-applicable';
  expect(g.validateMcpGovernancePreview(p)).toBe(true);
  p.gateChecks.cases[0]!.status = 'passed';
  expect(g.validateMcpGovernancePreview(p)).toBe(false);
  p.gateChecks.cases[0]!.status = 'not-applicable';
  p.gateChecks.cases[1]!.status = 'not-applicable';
  expect(g.validateMcpGovernancePreview(p)).toBe(false);
});
it('binds exact gate/runtime/expiry, replacement diff and weakening flags', () => {
  const p = f.governancePreview();
  for (const patch of [
    { hostEnforcement: true },
    { registrationPinned: true },
    { policyVersion: 1 },
    { expiresAt: p.createdAt },
    { current: { policyVersion: 2, gate: 'enforced', allowed: [] } },
  ])
    expect(g.validateMcpGovernancePreview({ ...p, ...patch })).toBe(false);
  expect(
    g.validateMcpGovernancePreview({
      ...p,
      current: { policyVersion: 2, gate: 'enforced', allowed: [] },
      requiresWeakening: true,
    }),
  ).toBe(true);
  expect(
    g.validateMcpGovernancePreview({
      ...p,
      gateChecks: { ...p.gateChecks, runtimeSha256: '0'.repeat(64) },
    }),
  ).toBe(false);
  expect(
    g.validateMcpGovernancePreview({ ...p, diff: { ...p.diff, retained: [f.governancePair()] } }),
  ).toBe(false);
});
it('unknown and authoritative not-applied are distinct from confirmed publication', () => {
  const r = f.governanceReceipt();
  expect(
    g.validateMcpGovernanceReceipt({
      ...r,
      writeConfirmed: false,
      record: f.governanceRecord({ status: 'not-applied', historyRef: null }),
    }),
  ).toBe(true);
  expect(
    g.validateMcpGovernanceReceipt({
      ...r,
      writeConfirmed: false,
      record: f.governanceRecord({ status: 'unknown', historyRef: null }),
    }),
  ).toBe(true);
  expect(
    g.validateMcpGovernanceReceipt({ ...r, record: f.governanceRecord({ status: 'not-applied' }) }),
  ).toBe(false);
  expect(g.validateMcpGovernanceReceipt({ ...r, operationId: f.governanceId(99) })).toBe(false);
  expect(
    g.validateMcpGovernanceReceipt({ ...r, record: f.governanceRecord({ historyRef: null }) }),
  ).toBe(false);
});
it('preview requests carry only capture/binding and at most64 unique opaque selections', () => {
  const c = f.governanceCapture(),
    selected = c.choices.map(({ id, expectedSha256 }) => ({ id, expectedSha256 })),
    request = { captureId: c.captureId, binding: c.binding, selected };
  expect(g.validateMcpGovernancePreviewRequest(request)).toBe(true);
  expect(
    g.validateMcpGovernancePreviewRequest({ ...request, selected: [...selected, ...selected] }),
  ).toBe(false);
  expect(
    g.validateMcpGovernancePreviewRequest({
      ...request,
      selected: Array.from({ length: 65 }, (_, i) => ({
        id: 'choice-' + i.toString(16).padStart(64, '0'),
        expectedSha256: 'a'.repeat(64),
      })),
    }),
  ).toBe(false);
});
it('whole-policy Restore explicitly binds current/candidate gate and pair changes', () => {
  const absent = { policyVersion: 1, gate: 'absent', allowed: [] },
    enforced = { policyVersion: 2, gate: 'enforced', allowed: [f.governancePair()] },
    diff = {
      current: enforced,
      candidate: absent,
      diff: { added: [], removed: [f.governancePair()], retained: [] },
      selectedEffect: 'continue-existing-checks',
      registrationPinned: false,
      hostEnforcement: false,
    };
  expect(g.validateMcpGovernanceRestoreDiff(diff)).toBe(true);
  expect(
    g.validateMcpGovernanceRestoreDiff({ ...diff, diff: { added: [], removed: [], retained: [] } }),
  ).toBe(false);
});
it('nullable identities have no invented channel and only noneligible registrations may use null', () => {
  const c = f.governanceCapture();
  const row = f.governanceChoice({
    pair: null,
    eligibility: 'unsupported',
    reason: 'unsupported-agent',
  });
  expect(g.validateMcpGovernanceCapture({ ...c, choices: [row] })).toBe(true);
  for (const patch of [
    { eligibility: 'eligible', reason: null },
    { kind: 'retained', sourceRefs: [], inAllowSet: true },
    { kind: 'both', inAllowSet: true },
  ])
    expect(g.validateMcpGovernanceCapture({ ...c, choices: [{ ...row, ...patch }] })).toBe(false);
});
it('recovery review binds exact historical operations and cannot replay one as a fresh operation', () => {
  const p = f.governancePreview();
  p.unconfirmedRecords = [
    { id: f.governanceId(8), revision: '8'.repeat(64), operationId: f.governanceId(9) },
  ];
  expect(g.validateMcpGovernancePreview(p)).toBe(false);
  p.requiresRecoveryReview = true;
  expect(g.validateMcpGovernancePreview(p)).toBe(true);
  p.unconfirmedRecords[0]!.operationId = p.operationId;
  expect(g.validateMcpGovernancePreview(p)).toBe(false);
});
it('keeps partial discovery gaps visible without removing authority from proven eligible choices', () => {
  const c = f.governanceCapture();
  c.gaps = [
    { code: 'partial-capture', agent: null, scope: 'unknown', sourceId: null },
    { code: 'identity-unknown', agent: 'codex', scope: 'user', sourceId: 'codex-user' },
  ];
  expect(g.validateMcpGovernanceCapture(c)).toBe(true);
  expect(c.canPreview).toBe(true);
});
