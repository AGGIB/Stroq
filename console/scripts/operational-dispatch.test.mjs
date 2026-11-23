import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { routeOperational } from './operational-http.mjs';
import { routeMcpCallControls } from './mcp-containment-http.mjs';

const origin = 'http://127.0.0.1:47813';
const routes = [
  ['/api/workspace-review', 'workspaceReview', ['check', 'cancel', 'review']],
  ['/api/hook-checks', 'hookChecks', ['preview', 'start', 'cancel']],
  ['/api/secrets', 'secrets', ['preview', 'start', 'cancel']],
  ['/api/mcp-call-controls', 'mcpCallControls', ['inspect', 'preview', 'apply', 'recheck']],
];

function request(path, { method = 'POST', headers = {}, body = '{}' } = {}) {
  const req = new PassThrough();
  req.url = path;
  req.method = method;
  req.headers = { origin, 'content-type': 'application/json', ...headers };
  queueMicrotask(() => req.end(body));
  return req;
}

function fixture(key, names) {
  const calls = [];
  const record = (name) => (input) => {
    calls.push({ name, input });
    return { status: 200, body: { accepted: name } };
  };
  const service = Object.assign(
    Object.create({ inherited: record('inherited') }),
    Object.fromEntries([...names, 'close', 'getState'].map((name) => [name, record(name)])),
  );
  const route = (path, options) => {
    const req = request(path, options);
    return key === 'mcpCallControls'
      ? routeMcpCallControls(req, path, origin, service)
      : routeOperational(req, path, origin, { [key]: service });
  };
  return { calls, route };
}

for (const [base, key, names] of routes) {
  test(`${base} dispatches only its fixed actions after the JSON gate`, async () => {
    const f = fixture(key, names);
    for (const name of names) {
      const path = `${base}/${name}`;
      for (const [options, status] of [
        [{ method: 'GET' }, 405],
        [{ headers: { origin: 'https://foreign.invalid' } }, 403],
        [{ headers: { 'content-type': 'text/plain' } }, 415],
        [{ body: '{broken' }, 400],
        [{ body: ' '.repeat(4097) }, 413],
      ]) {
        assert.equal((await f.route(path, options)).status, status);
        assert.equal(f.calls.length, 0);
      }
    }
    for (const name of names) {
      const result = await f.route(`${base}/${name}`);
      assert.deepEqual(result, { status: 200, body: { accepted: name } });
      assert.deepEqual(f.calls.at(-1), { name, input: {} });
    }
    assert.equal(f.calls.length, names.length);
  });

  test(`${base} does not expose service internals or inherited methods`, async () => {
    const f = fixture(key, names);
    for (const suffix of [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'inherited',
      'close',
      'getState',
      'unknown',
      `${names[0]}/extra`,
      `${names[0]}-extra`,
      '',
    ]) {
      assert.equal((await f.route(`${base}/${suffix}`)).status, 404, suffix);
    }
    assert.equal((await f.route(`/other${base}/${names[0]}`)).status, 404);
    assert.deepEqual(f.calls, []);
  });
}
