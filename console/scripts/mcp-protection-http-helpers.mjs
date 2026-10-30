import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './serve.mjs';

// An inert fixture under a fresh profile. It records received calls and environment
// facts, but performs no tool action, network access or model request.
const SERVER = `import {appendFileSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const [calls, environment] = process.argv.slice(2);
writeFileSync(environment, JSON.stringify({home:process.env.HOME, userProfile:process.env.USERPROFILE, declared:process.env.FIXTURE_DECLARED, ambient:process.env.UNDECLARED_SENTINEL, stroqHome:process.env.STROQ_HOME}));
createInterface({input:process.stdin}).on('line', line => {
 const message=JSON.parse(line); appendFileSync(calls, line+'\\n');
 if (message.id===undefined) return;
 const result=message.method==='initialize' ? {protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'0.0.0'}} : {content:[{type:'text',text:'fixture result'}],isError:false};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
});`;

export async function protectionFixture(t, scope = 'project') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'stroq-proxy-http-')));
  const project = join(dir, 'workspace'),
    userHome = join(dir, 'user');
  const home = join(dir, 'selected-policy'),
    ambientHome = join(dir, 'ambient-policy');
  const root = join(dir, 'out'),
    server = join(dir, 'inert-server.mjs');
  const calls = join(dir, 'calls.jsonl'),
    environment = join(dir, 'environment.json');
  for (const path of [project, userHome, home, ambientHome, root]) await mkdir(path);
  await writeFile(join(root, 'index.html'), 'fixture');
  await writeFile(server, SERVER);
  await writeFile(
    join(home, 'policy.yaml'),
    'version: 1\ndefault: allow\nrules:\n  - id: fixture-side-effects\n    effect: ask\n    reason: Fixture review\n    when:\n      classes: [mcp.side_effect]\n',
  );
  await writeFile(join(ambientHome, 'policy.yaml'), 'version: 1\ndefault: deny\nrules: []\n');
  const configRoot = scope === 'user' ? userHome : project;
  await mkdir(join(configRoot, '.cursor'));
  const config = join(configRoot, '.cursor', 'mcp.json');
  const document = {
    mcpServers: {
      notes: {
        command: process.execPath,
        args: [server, calls, environment],
        env: { FIXTURE_DECLARED: 'fixture-declared-value' },
        future: { preserve: true },
      },
      sibling: { url: 'https://fixture.invalid/mcp' },
    },
    preferences: { keep: true },
  };
  const original = Buffer.from(
    '\uFEFF' + JSON.stringify(document, null, '\t').replaceAll('\n', '\r\n') + '\r\n',
  );
  await writeFile(config, original, { mode: 0o640 });
  const apps = [],
    children = new Set();
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      await child.finished;
    }
    for (const app of apps.reverse()) await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const connect = async (workspace = project) => {
    const app = await startServer({ root, project: workspace, userHome, home, port: 0 });
    apps.push(app);
    const origin = new URL(app.url).origin;
    return async (path, body) => {
      const response = await fetch(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: 'Bearer ' + app.token,
          Origin: origin,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
  };
  const request = await connect();
  const item = async () => {
    const response = await request('/api/inventory');
    assert.equal(response.status, 200);
    const item = response.body.items.find((item) => item.name === 'notes');
    assert.ok(item?.sha256);
    return item;
  };
  const preview = async () => {
    const target = await item();
    return request('/api/mcp-containment/preview', {
      action: 'protect-registration',
      id: target.id,
      expectedSha256: target.sha256,
    });
  };
  const schema = await import('../.local-engine/local-api-schema.js');
  return {
    dir,
    project,
    userHome,
    home,
    ambientHome,
    config,
    original,
    document,
    calls,
    environment,
    request,
    connect,
    item,
    preview,
    schema,
    children,
  };
}

export const proxyApply = (preview, shared = false) => ({
  previewId: preview.id,
  confirm: true,
  acknowledgeSessionLimits: true,
  acknowledgePrivateRetention: true,
  acknowledgeProxyEffects: true,
  ...(shared ? { acknowledgeSharedPolicyContext: true } : {}),
});

/** Executes only the wrapper generated for the inert fixture above. */
export async function exerciseFixtureProxy(f) {
  const config = JSON.parse((await readFile(f.config, 'utf8')).replace(/^\uFEFF/, ''));
  const entry = config.mcpServers.notes;
  assert.equal(entry.command, process.execPath);
  assert.ok(entry.args.includes('--strict'));
  const child = spawn(entry.command, entry.args, {
    cwd: f.project,
    env: {
      PATH: process.env.PATH,
      HOME: f.ambientHome,
      USERPROFILE: f.ambientHome,
      STROQ_HOME: f.ambientHome,
      UNDECLARED_SENTINEL: 'fixture-ambient-value',
      ...entry.env,
    },
    shell: false,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  f.children.add(child);
  child.finished = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  let buffer = '',
    bytes = 0;
  const waiters = new Map();
  const rejectAll = () => {
    for (const { reject, timer } of waiters.values()) {
      clearTimeout(timer);
      reject(new Error('Fixture proxy ended before a response'));
    }
    waiters.clear();
  };
  child.stderr.resume();
  child.once('error', rejectAll);
  child.once('close', rejectAll);
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) {
      rejectAll();
      child.kill('SIGKILL');
      return;
    }
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const response = JSON.parse(line),
          waiter = waiters.get(response.id);
        if (waiter) {
          waiters.delete(response.id);
          clearTimeout(waiter.timer);
          waiter.resolve(response);
        }
      } catch {
        rejectAll();
      }
    }
  });
  const send = (message) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(message.id);
        reject(new Error('Fixture proxy response deadline'));
      }, 15000);
      waiters.set(message.id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify(message) + '\n');
    });
  try {
    const initialized = await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'fixture', version: '0.0.0' },
      },
    });
    assert.equal(initialized.result?.serverInfo?.name, 'fixture');
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );
    const allowed = await send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_time', arguments: {} },
    });
    assert.equal(
      allowed.result?.isError,
      false,
      'Selected policy must allow the ordinary fixture call even when ambient policy denies all',
    );
    const blocked = await send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'send_message', arguments: { body: 'inert fixture' } },
    });
    assert.equal(blocked.result?.isError, true);
    assert.match(JSON.stringify(blocked), /fixture-side-effects/);
    const received = (await readFile(f.calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(received.some((message) => message.id === 2));
    assert.equal(
      received.some((message) => message.id === 3),
      false,
      'A blocked fixture call must not reach the server',
    );
    assert.deepEqual(JSON.parse(await readFile(f.environment, 'utf8')), {
      home: f.userHome,
      userProfile: f.userHome,
      declared: 'fixture-declared-value',
    });
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, 5000);
    const ended = await child.finished;
    clearTimeout(timer);
    assert.equal(ended.code, 0, 'Fixture proxy and its child must close cleanly');
  }
}
