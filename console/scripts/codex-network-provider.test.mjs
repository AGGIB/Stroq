import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { build } from 'tsup';
const repo = join(import.meta.dirname, '../..'),
  out = await realpath(await mkdtemp(join(tmpdir(), 'stroq-network-provider-')));
after(() => rm(out, { recursive: true, force: true }));
await writeFile(
  join(out, 'react.mjs'),
  `export const createContext=()=>({Provider:'context'}),useCallback=f=>f,useContext=()=>null,useEffect=()=>{},useRef=v=>({current:v===''?'private-fixture-token':v}),useState=v=>[typeof v==='function'?v():v,()=>{}];`,
);
await writeFile(
  join(out, 'jsx.mjs'),
  `export const jsx=(type,props)=>({type,props}),jsxs=jsx,Fragment='fragment';`,
);
await writeFile(
  join(out, 'entry.ts'),
  `export{PlatformProvider}from${JSON.stringify(join(repo, 'console/components/platform-provider.tsx'))};export{CodexNetworkCheckStartRefusal}from${JSON.stringify(join(repo, 'console/lib/codex-network-client.ts'))};`,
);
await build({
  entry: { provider: join(out, 'entry.ts') },
  outDir: out,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  config: false,
  dts: false,
  splitting: false,
  silent: true,
  // tsup keeps every package named in the working directory's package.json outside the bundle,
  // so run from console/ it would leave `react` unresolved. The fakes below must be bundled.
  noExternal: ['react', 'react/jsx-runtime'],
  esbuildOptions(o) {
    o.alias = {
      '@': join(repo, 'console'),
      react: join(out, 'react.mjs'),
      'react/jsx-runtime': join(out, 'jsx.mjs'),
    };
  },
});
const api = await import(pathToFileURL(join(out, 'provider.mjs')).href);
async function rejectFor(t, path, status, body) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status, json: async () => body });
  t.after(() => {
    globalThis.fetch = original;
  });
  const request = api.PlatformProvider({ children: null }).props.value.requestLocal;
  try {
    await request(path, {});
  } catch (e) {
    return e;
  }
  throw Error('Expected refusal');
}
test('actual provider creates definitive Start refusal only from a closed409 error response', async (t) => {
  for (const code of [
    'codex-network-check-busy',
    'codex-network-check-stale',
    'codex-network-check-expired',
  ])
    await t.test(code, async (t) => {
      const error = await rejectFor(t, '/api/codex-network-checks/start', 409, { error: code });
      assert.ok(error instanceof api.CodexNetworkCheckStartRefusal);
      assert.equal(error.code, code);
    });
});
test('other paths/status/errors and malformed bodies cannot create definitive admission proof', async (t) => {
  for (const [path, status, body] of [
    ['/api/codex-network-checks/preview', 409, { error: 'codex-network-check-busy' }],
    ['/api/codex-network-checks/start', 503, { error: 'codex-network-check-busy' }],
    ['/api/codex-network-checks/start', 409, { error: 'codex-network-check-history-unavailable' }],
    ['/api/codex-network-checks/start', 409, { error: 'codex-network-check-busy', extra: true }],
    ['/api/codex-network-checks/start', 409, null],
  ])
    await t.test(path + status + JSON.stringify(body), async (t) => {
      const error = await rejectFor(t, path, status, body);
      assert.ok(error instanceof Error);
      assert.equal(error instanceof api.CodexNetworkCheckStartRefusal, false);
    });
});
