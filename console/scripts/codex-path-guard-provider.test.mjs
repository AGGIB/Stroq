import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { build } from 'tsup';
const repo = join(import.meta.dirname, '../..'),
  out = await realpath(await mkdtemp(join(tmpdir(), 'stroq-path-provider-')));
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
  `export{PlatformProvider}from${JSON.stringify(join(repo, 'console/components/platform-provider.tsx'))};export{CODEX_PATH_GUARD_MESSAGES}from${JSON.stringify(join(repo, 'console/lib/codex-path-guard-client.ts'))};export{CODEX_PATH_GUARD_ERRORS}from${JSON.stringify(join(repo, 'console/lib/codex-path-guard.ts'))};`,
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
async function requestWith(path, status, body) {
  const before = globalThis.fetch,
    calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return { ok: status === 200, status, json: async () => body };
  };
  try {
    const request = api.PlatformProvider({ children: null }).props.value.requestLocal;
    try {
      return { value: await request(path, path.endsWith('guard') ? undefined : {}), calls };
    } catch (error) {
      return { error, calls };
    }
  } finally {
    globalThis.fetch = before;
  }
}
test('actual provider maps every finite path-guard error on all five implemented routes', async () => {
  for (const suffix of ['', '/capture', '/preview', '/apply', '/recheck'])
    for (const code of api.CODEX_PATH_GUARD_ERRORS) {
      const { error, calls } = await requestWith('/api/codex-path-guard' + suffix, 409, {
        error: code,
      });
      assert.equal(calls.length, 1);
      assert.equal(error.message, api.CODEX_PATH_GUARD_MESSAGES[code]);
    }
});
test('actual provider never sends local tokens to lookalike path-guard operations', async () => {
  for (const path of [
    '/api/codex-path-guard/',
    '/api/codex-path-guard/preview/extra',
    '/api/codex-path-guard?path=/private/path',
    '/api/codex-path-guard/check',
    'https://foreign.invalid/api/codex-path-guard',
  ]) {
    const { error, calls } = await requestWith(path, 200, {});
    assert.equal(calls.length, 0);
    assert.equal(error.message, 'Unsupported local operation.');
  }
});
test('unknown backend error text and cross-feature codes do not escape the provider boundary', async () => {
  for (const [path, body] of [
    ['/api/codex-path-guard', { error: '/private/SECRET' }],
    ['/api/codex-path-guard', null],
    ['/api/agents', { error: 'codex-path-guard-conflict' }],
  ]) {
    const { error } = await requestWith(path, 409, body);
    assert.doesNotMatch(error.message, /SECRET|owned path rule/);
  }
});
test('real backend success passes through without manufacturing a configured or protected state', async () => {
  const body = { schema: 'backend-sentinel', available: false };
  const { value, calls } = await requestWith('/api/codex-path-guard', 200, body);
  assert.equal(value, body);
  assert.equal(calls[0][1].method, 'GET');
});
