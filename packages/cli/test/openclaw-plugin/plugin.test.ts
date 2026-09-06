import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

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
 * script — that records the argv and stdin it was given and then behaves as `script`
 * says. This test environment's sandbox hangs when it executes a shebang script, so
 * the stub cannot be `#!/bin/sh` like a real one might; it is invoked as
 * `node <file>`, which the plugin resolves from a single `stroqBin` string by
 * word-splitting it (see `stroqArgv`), and `argv` below is exposed separately for the
 * `stroq.json` `command` field, which already takes an array natively. Nothing here
 * talks to the real CLI — these tests are about the plugin's own contract.
 */
function stubStroq(script: string): {
  readonly bin: string;
  readonly argv: string[];
  readonly log: string;
} {
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
  return { bin: `${process.execPath} ${file}`, argv: [process.execPath, file], log };
}

const ALLOW = `process.stdout.write('{"decision":"allow"}');`;
const DENY =
  'process.stdout.write(\'{"decision":"deny","ruleId":"deny-self-tamper",' +
  '"reason":"Modifying agent security configuration is blocked"}\');';
const ASK =
  'process.stdout.write(\'{"decision":"ask","ruleId":"ask-destructive",' +
  '"reason":"Destructive command requires confirmation"}\');';
const SUSPECT =
  'process.stdout.write(\'{"scanned":true,"verdict":"suspect",' +
  '"warning":"Stroq: untrusted data"}\');';

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

let stub: ReturnType<typeof stubStroq>;

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
    stub = stubStroq(ALLOW);
    const { pre } = await wire({ stroqBin: stub.bin });
    expect(await pre.handle(event(), ctx())).toBeUndefined();
  });

  it('composes the block sentence from the rule id and the reason', async () => {
    stub = stubStroq(DENY);
    const { api, pre } = await wire({ stroqBin: stub.bin });
    expect(await pre.handle(event({ toolName: 'write' }), ctx())).toEqual({
      block: true,
      blockReason:
        'Stroq blocked this action (deny-self-tamper): Modifying agent security configuration is blocked',
    });
    expect(api.logs).toEqual([]);
  });

  it('asks for real, inside OpenClaw’s documented caps', async () => {
    stub = stubStroq(ASK);
    const { api, pre } = await wire({ stroqBin: stub.bin, askTimeoutMs: 60_000 });
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
    stub = stubStroq(
      `process.stdout.write(JSON.stringify({ decision: 'ask', ruleId: ${JSON.stringify(
        rule,
      )}, reason: ${JSON.stringify(reason)} }));`,
    );
    const { pre } = await wire({ stroqBin: stub.bin });
    const answer = (await pre.handle(event(), ctx())) as {
      requireApproval: { title: string; description: string };
    };
    expect(answer.requireApproval.title).toHaveLength(80);
    expect(answer.requireApproval.description).toHaveLength(512);
    expect(answer.requireApproval.description.endsWith('...')).toBe(true);
  });

  it('sends the session key, the tool, the params and the exec cwd', async () => {
    stub = stubStroq(ALLOW);
    const { pre } = await wire({ stroqBin: stub.bin, workspace: '/srv/fallback' });
    await pre.handle(
      event({ toolName: 'exec', params: { command: 'ls', cwd: '/srv/app' } }),
      ctx(),
    );
    const written = readFileSync(stub.log, 'utf8');
    const [argv, ...body] = written.split('\n');
    expect(argv).toBe('ARGS: hook openclaw pre');
    const payload = JSON.parse(body.join('\n')) as Record<string, unknown>;
    // `sessionKey` wins over `sessionId`: it is the stable one across a run.
    expect(payload['sessionId']).toBe('session-key-1');
    expect(payload['toolName']).toBe('exec');
    expect(payload['params']).toEqual({ command: 'ls', cwd: '/srv/app' });
    expect(payload['cwd']).toBe('/srv/app');
    expect(payload['agentId']).toBe('main');
    expect(payload['requester']).toEqual({ channel: 'cli', senderIsOwner: true });
  });

  it('falls back to the configured workspace, then to a session id it can use', async () => {
    stub = stubStroq(ALLOW);
    const { pre } = await wire({ stroqBin: stub.bin, workspace: '/srv/fallback' });
    await pre.handle(event(), { sessionId: 'only-session-id' });
    const payload = JSON.parse(
      readFileSync(stub.log, 'utf8').split('\n').slice(1).join('\n'),
    ) as Record<string, unknown>;
    expect(payload['cwd']).toBe('/srv/fallback');
    expect(payload['sessionId']).toBe('only-session-id');

    // Stroq requires a non-empty session id, and a rejected payload would block every
    // call in the session, so a ctx with neither key gets a stable fallback.
    await pre.handle(event(), {});
    const second = JSON.parse(
      readFileSync(stub.log, 'utf8').split('\n').slice(1).join('\n'),
    ) as Record<string, unknown>;
    expect(second['sessionId']).toBe('openclaw');
  });
});

describe('fail-closed', () => {
  const failures: [string, string][] = [
    [
      'a non-zero exit with a reason on stderr',
      "process.stderr.write('boom\\n'); process.exit(2);",
    ],
    ['any other non-zero exit', 'process.exit(1);'],
    ['stdout that is not JSON at all', "process.stdout.write('not json {{{');"],
    ['stdout that is JSON but not an object', "process.stdout.write('[1,2,3]');"],
    ['no output at all', '// nothing to do: exit cleanly with no output'],
    ['a decision this plugin does not know', 'process.stdout.write(\'{"decision":"maybe"}\');'],
  ];

  it.each(failures)('blocks on %s', async (_label, script) => {
    stub = stubStroq(script);
    const { api, pre } = await wire({ stroqBin: stub.bin });
    const answer = (await pre.handle(event(), ctx())) as { block: boolean; blockReason: string };
    expect(answer.block).toBe(true);
    expect(answer.blockReason).toContain('Stroq internal error (fail-closed)');
    expect(api.logs.some((line) => line.startsWith('warn stroq: exec:'))).toBe(true);
  });

  it('blocks when the binary is not there at all', async () => {
    const { pre } = await wire({ stroqBin: join(tmpdir(), 'definitely-not-stroq') });
    const answer = (await pre.handle(event(), ctx())) as { block: boolean; blockReason: string };
    expect(answer.block).toBe(true);
    expect(answer.blockReason).toContain('fail-closed');
  });

  it('blocks when Stroq does not answer in time, and kills the child', async () => {
    stub = stubStroq(`setTimeout(() => { ${ALLOW} }, 30000);`);
    const { pre } = await wire({ stroqBin: stub.bin, timeoutMs: 250 });
    const started = Date.now();
    const answer = (await pre.handle(event(), ctx())) as { block: boolean; blockReason: string };
    expect(answer.blockReason).toContain('no answer in 250 ms');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('blocks when the run is cancelled', async () => {
    stub = stubStroq(`setTimeout(() => { ${ALLOW} }, 30000);`);
    const { pre } = await wire({ stroqBin: stub.bin, timeoutMs: 20_000 });
    const controller = new AbortController();
    const pending = pre.handle(event(), ctx({ abortSignal: controller.signal }));
    controller.abort();
    const answer = (await pending) as { block: boolean };
    expect(answer.block).toBe(true);
  }, 30_000);

  it('blocks a call whose params cannot be serialised', async () => {
    stub = stubStroq(ALLOW);
    const { pre } = await wire({ stroqBin: stub.bin });
    const circular: Record<string, unknown> = { command: 'ls' };
    circular['self'] = circular;
    const answer = (await pre.handle(event({ params: circular }), ctx())) as { block: boolean };
    expect(answer.block).toBe(true);
  });
});

describe('after_tool_call is observe-only', () => {
  it('logs a warning and returns nothing', async () => {
    stub = stubStroq(SUSPECT);
    const { api, post } = await wire({ stroqBin: stub.bin });
    expect(
      await post.handle(
        event({ result: { output: 'poison' }, error: undefined, durationMs: 12 }),
        ctx(),
      ),
    ).toBeUndefined();
    expect(api.logs).toContain('warn stroq: Stroq: untrusted data');
    const payload = JSON.parse(
      readFileSync(stub.log, 'utf8').split('\n').slice(1).join('\n'),
    ) as Record<string, unknown>;
    expect(readFileSync(stub.log, 'utf8').startsWith('ARGS: hook openclaw post')).toBe(true);
    expect(payload['result']).toEqual({ output: 'poison' });
    expect(payload['durationMs']).toBe(12);
  });

  it('says nothing for a clean scan and never throws on a failure', async () => {
    stub = stubStroq('process.stdout.write(\'{"scanned":true,"verdict":"clean"}\');');
    const clean = await wire({ stroqBin: stub.bin });
    expect(await clean.post.handle(event({ result: 'ok' }), ctx())).toBeUndefined();
    expect(clean.api.logs).toEqual([]);

    // The tool has already run: a broken scan is a debug line, not a thrown handler.
    const broken = await wire({ stroqBin: join(tmpdir(), 'definitely-not-stroq') });
    await expect(broken.post.handle(event({ result: 'ok' }), ctx())).resolves.toBeUndefined();
    expect(broken.api.logs.some((line) => line.startsWith('debug stroq: post scan failed'))).toBe(
      true,
    );
  });
});

describe('finding the Stroq binary', () => {
  it('prefers the config, then STROQ_BIN, then the stroq.json init wrote', async () => {
    const configured = stubStroq(ALLOW);
    const fromEnv = stubStroq(DENY);
    process.env['STROQ_BIN'] = fromEnv.bin;
    const both = await wire({ stroqBin: configured.bin });
    expect(await both.pre.handle(event(), ctx())).toBeUndefined();

    const envOnly = await wire({});
    expect(await envOnly.pre.handle(event(), ctx())).toMatchObject({ block: true });
    delete process.env['STROQ_BIN'];

    // A copy of the plugin with a `stroq.json` beside it, which is exactly what
    // `stroq init --agent openclaw` materialises.
    const copied = mkdtempSync(join(tmpdir(), 'stroq-openclaw-copy-'));
    cpSync(pluginDir, copied, { recursive: true });
    const recorded = stubStroq(ASK);
    // `command` is an array already, so the two-part `node <stub.js>` argv this
    // sandbox needs is written directly — no word-splitting involved on this path.
    writeFileSync(join(copied, 'stroq.json'), JSON.stringify({ command: recorded.argv }));
    const installed = await wire({}, copied);
    expect(await installed.pre.handle(event(), ctx())).toHaveProperty('requireApproval');
  });
});
