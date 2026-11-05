import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = await realpath(await mkdtemp(join(tmpdir(), 'stroq-client-boundary-')));
after(() => rm(output, { recursive: true, force: true }));
await writeFile(
  join(output, 'react.ts'),
  `export const effects=[];
export const createContext=(value)=>({Provider:'Provider',value});
export const useContext=(context)=>context.value;
export const useCallback=(value)=>value;
export const useRef=(value)=>({current:value});
export const useState=(value)=>[typeof value==='function'?value():value,()=>{}];
export const useEffect=(effect)=>{effects.push(effect)};`,
);
await writeFile(
  join(output, 'jsx.ts'),
  `export const jsx=(type,props)=>({type,props});export const jsxs=jsx;`,
);
await writeFile(
  join(output, 'entry.ts'),
  `export {PlatformProvider} from ${JSON.stringify(join(repository, 'console/components/platform-provider.tsx'))};export {effects} from './react';`,
);
await build({
  entry: { client: join(output, 'entry.ts') },
  outDir: output,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  config: false,
  dts: false,
  splitting: false,
  noExternal: ['react'],
  silent: true,
  esbuildOptions(options) {
    options.alias = {
      '@': join(repository, 'console'),
      react: join(output, 'react.ts'),
      'react/jsx-runtime': join(output, 'jsx.ts'),
    };
    options.jsx = 'automatic';
  },
});
const { PlatformProvider, effects } = await import(pathToFileURL(join(output, 'client.mjs')).href);

/** The operations a test asked for; the provider also reads its own snapshot and workspace context. */
const operationCalls = (f) =>
  f.calls.filter((call) => !['/api/snapshot', '/api/context'].includes(call.path));

/** Exercises the actual provider callback, with React lifecycle and transport stubs. */
async function client(t) {
  const globals = ['window', 'sessionStorage', 'fetch'].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]);
  t.after(() => {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const token = 'fixture-private-local-token';
  globalThis.window = { location: { hash: '' } };
  globalThis.sessionStorage = {
    getItem: (key) => (key === 'stroq-console-token' ? token : 'demo'),
    setItem() {},
  };
  const calls = [];
  let error = null;
  globalThis.fetch = async (path, options) => {
    calls.push({ path, ...options });
    return error
      ? { ok: false, status: error.status, json: async () => ({ error: error.code }) }
      : { ok: true, json: async () => ({ accepted: true }) };
  };
  effects.length = 0;
  const tree = PlatformProvider({ children: null });
  const cleanups = effects.map((effect) => effect());
  t.after(() => cleanups.forEach((cleanup) => typeof cleanup === 'function' && cleanup()));
  return {
    request: tree.props.value.requestLocal,
    calls,
    token,
    fail: (code, status = 422) => {
      error = { code, status };
    },
  };
}

test('the actual client can reach the implemented hook-check operations', async (t) => {
  const f = await client(t);
  const operations = [
    ['/api/hook-checks'],
    ['/api/hook-checks/preview', { agent: 'claude-code' }],
    ['/api/hook-checks/start', { previewId: 'fixture' }],
    ['/api/hook-checks/cancel', { jobId: 'fixture' }],
    ['/api/hook-checks/jobs/11111111-1111-4111-8111-111111111111'],
  ];
  for (const [path, input] of operations) {
    const controller = new AbortController();
    assert.deepEqual(await f.request(path, input, controller.signal), { accepted: true });
    const call = f.calls.at(-1);
    assert.equal(call.path, path);
    assert.equal(call.method, input === undefined ? 'GET' : 'POST');
    assert.equal(call.headers.Authorization, `Bearer ${f.token}`);
    assert.equal(call.signal, controller.signal);
    assert.equal(call.cache, 'no-store');
    assert.equal(call.body, input === undefined ? undefined : JSON.stringify(input));
  }
  assert.equal(operationCalls(f).length, operations.length);
});

test('the actual client refuses unbounded paths without sending the private token', async (t) => {
  const f = await client(t);
  for (const path of [
    'https://foreign.invalid/api/hook-checks',
    '//foreign.invalid/api/hook-checks',
    '/api/task-locks',
    '/api/task-locks/page',
    '/api/task-locks/access/issue',
    '/api/live/start',
    '/api/credential-filters/apply',
    '/api/threats',
    '/api/hook-checks/jobs/../../private',
    '/api/session-taint/clear?session=private',
    '/api/session-taint/../clear',
    '/api/session-taint/all',
  ])
    await assert.rejects(f.request(path), { message: 'Unsupported local operation.' });
  assert.equal(operationCalls(f).length, 0);
});

test('the actual client does not send its token to the routes of the pages the console no longer has', async (t) => {
  const f = await client(t);
  for (const path of [
    '/api/session-taint',
    '/api/session-taint/clear',
    '/api/incident-assessments',
    '/api/workspace-task-controls/apply',
    '/api/workspace-review/check',
    '/api/workspace-monitor',
    '/api/inventory-monitor/apply',
    '/api/secrets/start',
  ])
    await assert.rejects(f.request(path, {}), { message: 'Unsupported local operation.' }, path);
  assert.equal(operationCalls(f).length, 0);
});
