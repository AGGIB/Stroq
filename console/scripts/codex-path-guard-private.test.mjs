import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPathGuardPrivatePlanFixture as fixture,
  privateSchema as s,
} from './codex-path-guard-private.test-helpers.mjs';
test('real private schema accepts both guard and Restore with independent preview operation identity', () => {
  for (const operation of ['guard', 'restore']) {
    const p = fixture({ operation });
    assert.equal(s.validateCodexPathGuardPrivatePlan(p), true);
    assert.ok(s.codexPathGuardPrivatePlanBytes(p) < 8 * 1024 * 1024);
    assert.notEqual(p.preview.id, p.preview.operationId);
  }
});
test('closed private plans reject extra authority, mismatched preset, source/runtime and raw ownership', () => {
  const checks = [
    (p) => (p.extra = true),
    (p) => (p.capture.extra = true),
    (p) => (p.owned.extra = true),
    (p) => (p.context.target = '/outside/config.toml'),
    (p) => (p.owned.targetPath = '/fixture/user/other'),
    (p) => (p.request.presetId = 'npmrc'),
    (p) => (p.capture.profileName = 'other'),
    (p) => (p.capture.dependencySha256 = null),
    (p) => (p.capture.binding.runtimeSha256 = 'b'.repeat(64)),
    (p) => (p.capture.targets.targets[0].path = '/outside'),
    (p) => (p.capture.targets.targets[0].file = { untrusted: true }),
    (p) => p.capture.targets.targets.reverse(),
    (p) => (p.capture.base.sources[0].path = '/different'),
    (p) => (p.owned.kind = 'profile-child'),
    (p) => (p.owned.operationId = p.preview.operationId),
    (p) => (p.candidate = Buffer.from('different')),
    (p) => p.before.file.size++,
    (p) => (p.capture.before.bytes = Buffer.from('different')),
    (p) => (p.capture.native.file.nlink = 2),
  ];
  for (const edit of checks) {
    const p = fixture();
    edit(p);
    assert.equal(s.validateCodexPathGuardPrivatePlan(p), false, edit.toString());
    assert.equal(s.codexPathGuardPrivatePlanBytes(p), Infinity);
  }
});
test('Restore accepts a later selector but must retain exact record, current snapshot and fixed target', () => {
  const p = fixture({ operation: 'restore' });
  p.capture.profileName = 'later';
  assert.equal(s.validateCodexPathGuardPrivatePlan(p), true);
  for (const edit of [
    (p) => (p.request.recordRevision = 'b'.repeat(64)),
    (p) => (p.request.recordId = p.preview.id),
    (p) => (p.preview.presetId = 'npmrc'),
    (p) => (p.before.sha256 = 'b'.repeat(64)),
  ]) {
    const q = fixture({ operation: 'restore' });
    edit(q);
    assert.equal(s.validateCodexPathGuardPrivatePlan(q), false);
  }
});
test('reserved filesystem profile is refused by owned and captured private profile fields', () => {
  const p = fixture();
  p.owned.profileName = 'filesystem';
  p.capture.profileName = 'filesystem';
  assert.equal(s.validateCodexPathGuardPrivatePlan(p), false);
  const restored = fixture({ operation: 'restore' });
  restored.capture.profileName = 'filesystem';
  assert.equal(s.validateCodexPathGuardPrivatePlan(restored), false);
});
test('config-only Restore accepts seven unobserved targets but cannot authorize Guard or fake safe metadata', () => {
  const unobserved = (p) => {
    p.capture.targets.targets = p.capture.targets.targets.map((t) => ({
      ...t,
      status: 'unavailable',
      file: null,
      directories: [],
    }));
    p.capture.public.presets = p.capture.public.presets.map((t) => ({
      ...t,
      target: 'unavailable',
      canGuard: false,
      reason: 'codex-path-guard-target-unavailable',
    }));
    return p;
  };
  const restored = unobserved(fixture({ operation: 'restore' }));
  assert.equal(s.validateCodexPathGuardPrivatePlan(restored), true);
  const guard = unobserved(fixture());
  assert.equal(s.validateCodexPathGuardPrivatePlan(guard), false);
  guard.capture.public.presets[0] = {
    ...guard.capture.public.presets[0],
    target: 'absent',
    canGuard: true,
    reason: null,
  };
  assert.equal(s.validateCodexPathGuardPrivatePlan(guard), false);
  for (const status of ['unsafe', 'unavailable']) {
    const bad = unobserved(fixture({ operation: 'restore' }));
    bad.capture.targets.targets[0].status = status;
    bad.capture.public.presets[0].target = status;
    bad.capture.targets.targets[0].directories = [{ ...bad.context.user }];
    assert.equal(s.validateCodexPathGuardPrivatePlan(bad), false);
  }
});
test('credential metadata never carries raw bodies and bounded source graphs reject oversize/cycles', () => {
  let p = fixture();
  p.capture.targets.targets[0].bytes = Buffer.from('secret');
  assert.equal(s.validateCodexPathGuardPrivatePlan(p), false);
  p = fixture();
  p.capture.sources = Array(65).fill(p.capture.sources[0]);
  assert.equal(s.validateCodexPathGuardPrivatePlan(p), false);
  p = fixture();
  p.candidate = new Uint8Array(256 * 1024 + 1);
  assert.equal(s.validateCodexPathGuardPrivatePlan(p), false);
  p = fixture();
  p.capture.targets.targets[0].file = p.capture.targets.targets[0];
  assert.equal(s.validateCodexPathGuardPrivatePlan(p), false);
});
