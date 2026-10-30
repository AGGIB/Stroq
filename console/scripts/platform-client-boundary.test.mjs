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

test('the actual client can reach implemented task, hook-check and incident operations', async (t) => {
  const f = await client(t);
  const operations = [
    ['/api/session-taint'],
    ['/api/session-taint/inspect', { id: 'fixture', expectedEvidenceSha: 'fixture' }],
    ['/api/session-taint/preview', { expectedRevisionSha256: 'fixture' }],
    ['/api/session-taint/clear', { previewId: 'fixture' }],
    ['/api/session-taint/recheck', { recordId: 'fixture' }],
    ['/api/task-locks'],
    ['/api/task-locks/page'],
    ['/api/task-locks/page', { cursor: '11111111-1111-4111-8111-111111111111' }],
    [
      '/api/task-locks/page',
      { id: `task-${'a'.repeat(64)}`, expectedPermitSha256: 'b'.repeat(64) },
    ],
    ['/api/task-locks/preview', { id: 'fixture' }],
    ['/api/task-locks/apply', { previewId: 'fixture' }],
    ['/api/task-locks/access/preview', { id: 'fixture' }],
    ['/api/task-locks/access/issue', { previewId: 'fixture' }],
    [`/api/task-locks/access/task-${'a'.repeat(64)}/${'b'.repeat(64)}`],
    ['/api/incidents/task', { id: 'fixture' }],
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
  assert.equal(f.calls.length, operations.length);
});

test('the actual client refuses unbounded paths without sending the private token', async (t) => {
  const f = await client(t);
  for (const path of [
    'https://foreign.invalid/api/task-locks',
    '//foreign.invalid/api/task-locks',
    '/api/task-locks/access/issue?token=private',
    '/api/task-locks/access/../issue',
    '/api/task-locks/page?cursor=private',
    '/api/task-locks/page/extra',
    '/api/hook-checks/jobs/../../private',
    '/api/session-taint/clear?session=private',
    '/api/session-taint/../clear',
    '/api/session-taint/all',
  ])
    await assert.rejects(f.request(path), { message: 'Unsupported local operation.' });
  assert.equal(f.calls.length, 0);
});

test('Codex skill control refusals use finite scoped messages without exposing arbitrary server text', async (t) => {
  const f = await client(t);
  f.fail('codex-control-write-unconfirmed', 503);
  await assert.rejects(f.request('/api/inventory/codex-control-apply', {}), {
    message: 'Completion is unknown. Recheck this exact change.',
  });
  f.fail('codex-control-conflict', 409);
  await assert.rejects(f.request('/api/inventory/codex-control-preview', {}), {
    message: 'The owned declaration changed. Review the current configuration.',
  });
  f.fail('/private/config/SECRET_SENTINEL', 503);
  await assert.rejects(
    f.request('/api/inventory/codex-controls'),
    (error) =>
      !error.message.includes('SECRET_SENTINEL') && !error.message.includes('/private/config'),
  );
});

test('task page gaps use finite recovery messages without exposing private cursor details', async (t) => {
  const f = await client(t);
  for (const [code, expected] of [
    ['task-page-stale', /catalog changed.*first page/],
    ['task-page-expired', /page link expired.*first page/],
    ['task-lookup-limit', /catalog limit.*absence/],
  ]) {
    f.fail(code);
    await assert.rejects(
      f.request('/api/task-locks/page', { cursor: '11111111-1111-4111-8111-111111111111' }),
      expected,
    );
  }
});

test('task file controls use finite recovery errors without forwarding server text', async (t) => {
  const f = await client(t);
  for (const [code, expected] of [
    ['recovery-full', /Recovery storage is full/],
    ['recovery-required', /Recheck the previous change/],
    ['unsupported-task-config', /cannot be safely edited automatically/],
    ['no-automatic-tasks', /No supported automatic task triggers/],
    ['history-unavailable', /Recovery storage could not be verified/],
  ]) {
    f.fail(code, 503);
    await assert.rejects(f.request('/api/workspace-task-controls/preview', {}), expected);
  }
  f.fail('PRIVATE_SERVER_DETAIL', 503);
  await assert.rejects(
    f.request('/api/workspace-task-controls/preview', {}),
    (error) => !error.message.includes('PRIVATE_SERVER_DETAIL'),
  );
});

test('taint controls show scoped finite errors and never raw session or storage details', async (t) => {
  const f = await client(t);
  for (const [code, expected] of [
    ['stale-state', /session state changed.*fresh preview/],
    ['not-tainted', /No stored session taint/],
    ['provenance-unavailable', /Learned-origin state could not be verified/],
    ['write-unconfirmed', /Clear completion is unknown.*recorded change/],
    ['recovery-full', /private recovery limit/],
  ]) {
    f.fail(code);
    await assert.rejects(f.request('/api/session-taint/clear', { previewId: 'fixture' }), expected);
  }
  f.fail('/PRIVATE/session-raw/provenance', 503);
  await assert.rejects(
    f.request('/api/session-taint/inspect', {}),
    (error) => !error.message.includes('PRIVATE') && !error.message.includes('session-raw'),
  );
});

test('only exact finite taint refusal codes and statuses carry a no-write error identity', async (t) => {
  const f = await client(t);
  f.fail('stale-state', 409);
  await assert.rejects(
    f.request('/api/session-taint/clear', { previewId: 'fixture' }),
    (error) => error.code === 'stale-state' && error.status === 409,
  );
  for (const [code, status] of [
    ['stale-state', 500],
    ['write-unconfirmed', 422],
    ['PRIVATE', 409],
  ]) {
    f.fail(code, status);
    await assert.rejects(
      f.request('/api/session-taint/clear', { previewId: 'fixture' }),
      (error) => error.code === undefined && error.status === undefined,
    );
  }
});

test('uncertain writes and unavailable signed evidence have fixed actionable errors', async (t) => {
  const f = await client(t);
  for (const [code, expected] of [
    ['write-unconfirmed', /completion is unknown.*Recheck existing permissions/],
    ['legacy-refusal', /No signed request is available/],
    ['permission-active', /extension file already exists/],
    ['signing-key-unavailable', /signing key is unavailable/],
    ['task-unavailable', /current task permit is unavailable/],
  ]) {
    f.fail(code);
    await assert.rejects(
      f.request('/api/task-locks/access/issue', { previewId: 'fixture' }),
      expected,
    );
  }
});
