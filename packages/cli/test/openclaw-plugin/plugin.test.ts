import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Registration and ordinary decisions. Fail-closed paths, the observe-only
 * `after_tool_call` contract, and Stroq-binary resolution live in
 * `plugin-fail-closed.test.ts` (the 400-line-per-test-file budget) — each file
 * re-declares its own small fixtures rather than importing them from the other, the
 * way `copilot.test.ts` / `copilot-shapes.test.ts` / `copilot-decisions.test.ts` do.
 */

const pluginDir = join(import.meta.dirname, '../../openclaw-plugin');

interface Handler {
  readonly handle: (event: unknown, ctx: unknown) => Promise<unknown>;
  readonly options: Record<string, unknown> | undefined;
}

/** The slice of OpenClaw's plugin API this entry actually touches. */
class FakeApi {
  readonly handlers = new Map<string, Handler>();
  readonly logs: string[] = [];
  readonly logger = {
    info: (m: string) => this.logs.push(`info ${m}`),
    warn: (m: string) => this.logs.push(`warn ${m}`),
    debug: (m: string) => this.logs.push(`debug ${m}`),
  };
  constructor(readonly pluginConfig: Record<string, unknown> = {}) {}
  on(event: string, handle: Handler['handle'], options?: Record<string, unknown>): void {
    this.handlers.set(event, { handle, options });
  }
}

/**
 * The module under test, imported through a computed `file://` URL. A literal
 * specifier would make TypeScript resolve a `.js` that lives outside `src`/`test` and
 * has no declarations; the URL keeps it a runtime import, which is exactly how the
 * Gateway loads it.
 */
const loadPlugin = async (dir: string = pluginDir) =>
  (await import(/* @vite-ignore */ pathToFileURL(join(dir, 'index.js')).href)) as {
    register: (api: FakeApi) => void;
    default: unknown;
  };

/**
 * A `stroq` the plugin can really spawn: a plain Node script — never a POSIX shell
 * script, which would hang this sandbox — that records the argv and stdin it was
 * given and then behaves as `script` says. It is always launched through
 * `stroq.json`'s `command` array (see `installedWith`), never through `stroqBin`:
 * Task 3 review found that a real `stroqBin` path can contain a space, so the plugin
 * treats it as one opaque, unsplit path, and only `stroq.json`'s already-array-shaped
 * `command` may carry more than one argv element.
 */
function stubStroq(script: string): { readonly argv: string[]; readonly log: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-openclaw-stub-'));
  const file = join(dir, 'stroq-stub.js');
  const log = join(dir, 'call.log');
  writeFileSync(
    file,
    "const fs = require('node:fs');\n" +
      "let input = '';\n" +
      "process.stdin.setEncoding('utf8');\n" +
      "process.stdin.on('data', (chunk) => { input += chunk; });\n" +
      "process.stdin.on('end', () => {\n" +
      `  fs.writeFileSync(${JSON.stringify(log)}, 'ARGS: ' + process.argv.slice(2).join(' ') + '\\n' + input);\n` +
      `  ${script}\n` +
      '});\n',
  );
  return { argv: [process.execPath, file], log };
}

/**
 * A copy of the plugin with a `stroq.json` beside it recording `argv` as the launch
 * command — exactly what `stroq init --agent openclaw` materialises. `index.js`'s
 * ESM `import` syntax needs the copy's own `package.json` (`"type": "module"`) to
 * load at all, so the whole directory is copied rather than just the entry.
 */
function installedWith(argv: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'stroq-openclaw-copy-'));
  cpSync(pluginDir, dir, { recursive: true });
  writeFileSync(join(dir, 'stroq.json'), JSON.stringify({ command: [...argv] }));
  return dir;
}

const ALLOW = `process.stdout.write('{"decision":"allow"}');`;
const DENY =
  'process.stdout.write(\'{"decision":"deny","ruleId":"deny-self-tamper",' +
  '"reason":"Modifying agent security configuration is blocked"}\');';
const ASK =
  'process.stdout.write(\'{"decision":"ask","ruleId":"ask-destructive",' +
  '"reason":"Destructive command requires confirmation"}\');';

const event = (fields: Record<string, unknown> = {}) => ({
  toolName: 'exec',
  params: { command: 'ls -la' },
  toolKind: 'shell',
  ...fields,
});
const ctx = (fields: Record<string, unknown> = {}) => ({
  agentId: 'main',
  sessionKey: 'session-key-1',
  sessionId: 'session-id-1',
  runId: 'run-1',
  toolCallId: 'call-1',
  requester: { channel: 'cli', senderIsOwner: true },
  ...fields,
});

/** Registers the plugin against a fresh fake api and returns both handlers. */
async function wire(config: Record<string, unknown>, dir?: string) {
  const api = new FakeApi(config);
  const plugin = await loadPlugin(dir);
  plugin.register(api);
  const pre = api.handlers.get('before_tool_call');
  const post = api.handlers.get('after_tool_call');
  if (!pre || !post) throw new Error('the plugin did not register both hooks');
  return { api, pre, post };
}

/** `wire`, against a fresh copy of the plugin running `script` as its Stroq CLI. */
async function wireWithStub(script: string, config: Record<string, unknown> = {}) {
  const { argv, log } = stubStroq(script);
  const wired = await wire(config, installedWith(argv));
  return { ...wired, log };
}

beforeEach(() => {
  delete process.env['STROQ_BIN'];
});

describe('registration', () => {
  it('registers both hooks, the gate first and with no matcher', async () => {
    const { api, pre, post } = await wire({ stroqBin: '/nonexistent' });
    expect([...api.handlers.keys()]).toEqual(['before_tool_call', 'after_tool_call']);
    // Priority 100 so Stroq answers before ordinary hooks; no matcher, because a
    // matcher is a list of the tools Stroq already knows about and the one it has
    // never heard of would be the one that skipped the gate.
    expect(pre.options).toEqual({ priority: 100 });
    expect(post.options).toBeUndefined();
  });

  it('exports a default entry and a bare register, so either loader works', async () => {
    const plugin = await loadPlugin();
    expect(typeof plugin.register).toBe('function');
    // `definePluginEntry` is not resolvable outside a Gateway, so the default export
    // falls back to `register` itself — which OpenClaw also accepts.
    expect(plugin.default).toBe(plugin.register);
  });
});

describe('a decision the CLI made', () => {
  it('allows by returning nothing at all', async () => {
    const { pre } = await wireWithStub(ALLOW);
    expect(await pre.handle(event(), ctx())).toBeUndefined();
  });

  it('composes the block sentence from the rule id and the reason', async () => {
    const { api, pre } = await wireWithStub(DENY);
    expect(await pre.handle(event({ toolName: 'write' }), ctx())).toEqual({
      block: true,
      blockReason:
        'Stroq blocked this action (deny-self-tamper): Modifying agent security configuration is blocked',
    });
    expect(api.logs).toEqual([]);
  });

  it('asks for real, inside OpenClaw’s documented caps', async () => {
    const { api, pre } = await wireWithStub(ASK, { askTimeoutMs: 60_000 });
    const answer = (await pre.handle(event(), ctx())) as {
      requireApproval: Record<string, unknown> & { onResolution: (d: string) => void };
    };
    const approval = answer.requireApproval;
    expect(approval['title']).toBe('Stroq: ask-destructive');
    expect(approval['description']).toBe('Destructive command requires confirmation');
    expect(approval['severity']).toBe('warning');
    // `allow-always` is deliberately absent: Stroq audits every ask, and a remembered
    // allow is one it would never be asked about again.
    expect(approval['allowedDecisions']).toEqual(['allow-once', 'deny']);
    expect(approval['timeoutMs']).toBe(60_000);
    approval.onResolution('allow-once');
    expect(api.logs).toContain('info stroq: approval allow-once for exec');
  });

  it('clips an over-long title and description rather than being rejected', async () => {
    const rule = 'r'.repeat(200);
    const reason = 'x'.repeat(900);
    const { pre } = await wireWithStub(
      `process.stdout.write(JSON.stringify({ decision: 'ask', ruleId: ${JSON.stringify(
        rule,
      )}, reason: ${JSON.stringify(reason)} }));`,
    );
    const answer = (await pre.handle(event(), ctx())) as {
      requireApproval: { title: string; description: string };
    };
    expect(answer.requireApproval.title).toHaveLength(80);
    expect(answer.requireApproval.description).toHaveLength(512);
    expect(answer.requireApproval.description.endsWith('...')).toBe(true);
  });

  it('sends the session key, the tool and the params, and its own cwd — never the tool’s', async () => {
    const { pre, log } = await wireWithStub(ALLOW, { workspace: '/srv/fallback' });
    await pre.handle(
      event({ toolName: 'exec', params: { command: 'ls', cwd: '/srv/app' } }),
      ctx(),
    );
    const written = readFileSync(log, 'utf8');
    const [argv, ...body] = written.split('\n');
    expect(argv).toBe('ARGS: hook openclaw pre');
    const payload = JSON.parse(body.join('\n')) as Record<string, unknown>;
    // `sessionKey` wins over `sessionId`: it is the stable one across a run.
    expect(payload['sessionId']).toBe('session-key-1');
    expect(payload['toolName']).toBe('exec');
    // The whole params object, cwd included, is still forwarded — see the
    // "cwd never comes from the tool call" tests below for why that is safe.
    expect(payload['params']).toEqual({ command: 'ls', cwd: '/srv/app' });
    expect(payload['cwd']).toBe('/srv/fallback');
    expect(payload['agentId']).toBe('main');
    expect(payload['requester']).toEqual({ channel: 'cli', senderIsOwner: true });
  });

  it('falls back to the configured workspace, then to a session id it can use', async () => {
    const { pre, log } = await wireWithStub(ALLOW, { workspace: '/srv/fallback' });
    await pre.handle(event(), { sessionId: 'only-session-id' });
    const payload = JSON.parse(readFileSync(log, 'utf8').split('\n').slice(1).join('\n')) as Record<
      string,
      unknown
    >;
    expect(payload['cwd']).toBe('/srv/fallback');
    expect(payload['sessionId']).toBe('only-session-id');

    // Stroq requires a non-empty session id, and a rejected payload would block every
    // call in the session, so a ctx with neither key gets a stable fallback.
    await pre.handle(event(), {});
    const second = JSON.parse(readFileSync(log, 'utf8').split('\n').slice(1).join('\n')) as Record<
      string,
      unknown
    >;
    expect(second['sessionId']).toBe('openclaw');
  });
});

describe('cwd never comes from the tool call (Task 3 review, Critical)', () => {
  it('ignores params.cwd on a non-exec tool, so it cannot redirect the secret index', async () => {
    // A model-supplied `cwd` on `write` (or `message`, `browser`, any MCP call) must
    // never move the directory the secret index and path rules use: pointing it at
    // an empty directory is exactly how a `deny-secret-egress` probe turned into an
    // `allow`. `exec` loses nothing — see the next test.
    const { pre, log } = await wireWithStub(ALLOW, { workspace: '/srv/fallback' });
    await pre.handle(
      event({ toolName: 'write', params: { file_path: '/tmp/x', cwd: '/somewhere/else' } }),
      ctx(),
    );
    const payload = JSON.parse(readFileSync(log, 'utf8').split('\n').slice(1).join('\n')) as Record<
      string,
      unknown
    >;
    expect(payload['cwd']).toBe('/srv/fallback');
    // The whole params object is still forwarded, cwd included: nothing is hidden
    // from the CLI, only the plugin's OWN top-level cwd stops trusting it.
    expect(payload['params']).toEqual({ file_path: '/tmp/x', cwd: '/somewhere/else' });
  });

  it('ignores params.cwd on exec too, falling back to process.cwd() with no workspace', async () => {
    // The CLI adapter does not recover exec's own directory from `params.cwd` either
    // (Task 4.5 review, Critical — it used to, via `openclawExecCwd`, which read
    // `params.cwd` for `exec` ahead of this very field and was the actual bypass:
    // an attacker-chosen `params.cwd` won over the trusted `cwd` the plugin sends).
    // Only this top-level, plugin-resolved `cwd` ever feeds the CLI's secret index
    // and path classification, for every tool including `exec`.
    const { pre, log } = await wireWithStub(ALLOW);
    await pre.handle(
      event({ toolName: 'exec', params: { command: 'ls', cwd: '/srv/app' } }),
      ctx(),
    );
    const payload = JSON.parse(readFileSync(log, 'utf8').split('\n').slice(1).join('\n')) as Record<
      string,
      unknown
    >;
    expect(payload['cwd']).toBe(process.cwd());
    expect(payload['params']).toEqual({ command: 'ls', cwd: '/srv/app' });
  });
});
