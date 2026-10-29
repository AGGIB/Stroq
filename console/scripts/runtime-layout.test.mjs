import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeLayout } from './runtime-layout.mjs';

test('fixed source and package layouts resolve every runtime without a source fallback', () => {
  const source = runtimeLayout('file:///repo/console/scripts/runtime-layout.mjs');
  assert.equal(source.cli, '/repo/packages/cli/dist/index.js');
  assert.equal(source.core, '/repo/packages/core/dist/index.js');
  assert.equal(
    source.adapter('live-proof-engine.js'),
    '/repo/console/.local-engine/live-proof-engine.js',
  );
  assert.equal(source.manifest, '/repo/console/.local-engine/runtime-manifest.json');
  const packed = runtimeLayout(
    'file:///install/node_modules/@stroq/cli/platform/scripts/runtime-layout.mjs',
  );
  assert.equal(packed.cli, '/install/node_modules/@stroq/cli/dist/index.js');
  assert.equal(packed.core, '/install/node_modules/@stroq/cli/platform/core/index.js');
  assert.equal(packed.package, '/install/node_modules/@stroq/cli/package.json');
  assert.equal(
    packed.adapter('policy-engine.js'),
    '/install/node_modules/@stroq/cli/platform/.local-engine/policy-engine.js',
  );
  assert.equal(packed.manifest, '/install/node_modules/@stroq/cli/platform/runtime-manifest.json');
  for (const name of ['../index.js', '/tmp/evil.js', 'x\\evil.js', 'index.ts', '.hidden.js'])
    assert.throws(() => packed.adapter(name), /invalid-adapter/);
});
