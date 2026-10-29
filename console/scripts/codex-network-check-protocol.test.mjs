import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'smol-toml';
import { tsImport } from 'tsx/esm/api';
const api = await tsImport('./codex-network-check-protocol.ts', { parentURL: import.meta.url });
const copy = {
  kind: 'profile',
  selectedProfile: 'selected',
  profiles: {
    base: {
      filesystem: { ':root': 'read', ':workspace_roots': { '.': 'write', '**/*.env': 'deny' } },
      network: { enabled: true, unix_sockets: { '/owned/socket': 'allow' } },
    },
    selected: { extends: 'base', network: { enabled: false } },
  },
  networkOff: true,
};
const nonce = 'a'.repeat(64);
const wire = (a = 'EPERM', b = 'EACCES') =>
  JSON.stringify({
    schema: api.NETWORK_CHECK_PROTOCOL_VERSION,
    nonce,
    results: [
      { id: 'tcp', attempted: true, code: a },
      { id: 'unix', attempted: true, code: b },
    ],
  });
test('copy hashes canonical policy only and suite hash is independent of native/context', () => {
  const reordered = {
    ...copy,
    profiles: { selected: copy.profiles.selected, base: copy.profiles.base },
    native: { path: '/not-part-of-copy' },
    sourcePins: [],
  };
  assert.equal(api.getProfileCopySha(copy), api.getProfileCopySha(reordered));
  assert.match(api.getSuiteSha(), /^[a-f0-9]{64}$/);
  assert.equal(api.getSuiteSha(), api.getSuiteSha());
  assert.notEqual(
    api.getProfileCopySha(copy),
    api.getProfileCopySha({ ...copy, kind: 'legacy-translated' }),
  );
  assert.throws(() => api.canonicalJSON({ bad: NaN }));
  assert.throws(() => api.canonicalJSON(Array(1)));
});
test('closed graph preserves maps and rejects on, cycles, missing parents and unrestricted builtin', () => {
  assert.equal(api.validateNetworkCopy(copy), true);
  const config = api.serializeProfileCopy(copy);
  assert.match(config, /\*\*\/\*\.env/);
  assert.match(config, /unix_sockets/);
  assert.match(config, /"enabled" = false/);
  assert.deepEqual(JSON.parse(JSON.stringify(parse(config).permissions)), copy.profiles);
  assert.equal(
    api.validateNetworkCopy({ ...copy, profiles: { selected: { network: { enabled: true } } } }),
    false,
  );
  assert.equal(
    api.validateNetworkCopy({
      ...copy,
      profiles: { selected: { extends: 'missing', network: { enabled: false } } },
    }),
    false,
  );
  assert.equal(
    api.validateNetworkCopy({
      ...copy,
      profiles: { selected: { extends: 'selected', network: { enabled: false } } },
    }),
    false,
  );
  assert.equal(api.validateNetworkCopy({ ...copy, selectedProfile: ':danger-full-access' }), false);
});
test('wire requires exact two reached probes, current nonce and finite errno; bootstrap cannot pass', () => {
  const decoded = api.decodeCanaryWire(wire(), nonce);
  assert.ok(decoded);
  assert.equal(api.decodeCanaryWire(wire(), 'b'.repeat(64)), null);
  assert.equal(api.decodeCanaryWire(wire().replace('"unix"', '"tcp"'), nonce), null);
  assert.equal(
    api.decodeCanaryWire(wire().replace('"code":"EPERM"', '"code":"EPERM","extra":true'), nonce),
    null,
  );
  assert.equal(api.decodeCanaryWire('{"error":"bootstrap"}', nonce), null);
  assert.equal(
    api.decodeCanaryWire(wire().replace('\"nonce\":', '\"nonce\":\"wrong\",\"nonce\":'), nonce),
    null,
  );
  assert.equal(api.decodeCanaryWire(wire('ECONNREFUSED'), nonce), null);
  const checks = api.projectNetworkChecks(decoded, [1, 1], [0, 0]);
  assert.deepEqual(
    checks.map((c) => [c.effect, c.errno]),
    [
      ['denied', 'EPERM'],
      ['denied', 'EACCES'],
    ],
  );
  assert.throws(() => api.projectNetworkChecks(decoded, [1, 1], [1, 0]));
  assert.deepEqual(
    api.projectNetworkChecks(null, [1, 1], [0, 0]).map((c) => c.effect),
    ['unreached', 'unreached'],
  );
});
