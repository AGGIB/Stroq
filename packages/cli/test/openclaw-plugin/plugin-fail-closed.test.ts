import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * Split out of `plugin.test.ts` (the 400-line-per-test-file budget): the fail-closed
 * paths, the observe-only `after_tool_call` contract, and Stroq-binary resolution.
 * Registration and ordinary decisions live in `plugin.test.ts`. Each file re-declares
 * its own small fixtures rather than importing them from the other, the way
 * `copilot.test.ts` / `copilot-shapes.test.ts` / `copilot-decisions.test.ts` do.
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

/** `wire`, against a fresh copy of the plugin running `script` as its Stroq CLI. */
async function wireWithStub(script: string, config: Record<string, unknown> = {}) {
  const { argv, log } = stubStroq(script);
  const wired = await wire(config, installedWith(argv));
  return { ...wired, log };
}

beforeEach(() => {
  delete process.env['STROQ_BIN'];
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
    const { api, pre } = await wireWithStub(script);
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

  it('names the full stroqBin path in the reason, even one containing a space', async () => {
    // Task 3 review, Important: `stroqBin`/`STROQ_BIN` must stay ONE unsplit path.
    // A real install path (a macOS "Jane Doe" home directory, an nvm path) can
    // legitimately contain a space, and splitting on it would silently spawn the
    // wrong (truncated) binary instead of failing loudly on the real one.
    const spaced = join(tmpdir(), 'stroq bin dir', 'stroq');
    const { pre } = await wire({ stroqBin: spaced });
    const answer = (await pre.handle(event(), ctx())) as { block: boolean; blockReason: string };
    expect(answer.block).toBe(true);
    expect(answer.blockReason).toContain(spaced);
  });

  it('clips an oversized internal-error detail the same way stderr already is', async () => {
    // Task 3 review, minor: `String(err)` (or any other detail `block()` receives)
    // can be arbitrarily long; the reason shown to a user must stay bounded the same
    // way a child's own stderr already is.
    const { pre } = await wireWithStub(
      `process.stdout.write(JSON.stringify({ decision: ${JSON.stringify('x'.repeat(5000))} }));`,
    );
    const answer = (await pre.handle(event(), ctx())) as { block: boolean; blockReason: string };
    expect(answer.block).toBe(true);
    expect(answer.blockReason.length).toBeLessThan(400);
  });

  it('blocks when Stroq does not answer in time, and kills the child', async () => {
    const { pre } = await wireWithStub(`setTimeout(() => { ${ALLOW} }, 30000);`, {
      timeoutMs: 250,
    });
    const started = Date.now();
    const answer = (await pre.handle(event(), ctx())) as { block: boolean; blockReason: string };
    expect(answer.blockReason).toContain('no answer in 250 ms');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('blocks when the run is cancelled', async () => {
    const { pre } = await wireWithStub(`setTimeout(() => { ${ALLOW} }, 30000);`, {
      timeoutMs: 20_000,
    });
    const controller = new AbortController();
    const pending = pre.handle(event(), ctx({ abortSignal: controller.signal }));
    controller.abort();
    const answer = (await pending) as { block: boolean };
    expect(answer.block).toBe(true);
  }, 30_000);

  it('blocks a call whose params cannot be serialised', async () => {
    const { pre } = await wireWithStub(ALLOW);
    const circular: Record<string, unknown> = { command: 'ls' };
    circular['self'] = circular;
    const answer = (await pre.handle(event({ params: circular }), ctx())) as { block: boolean };
    expect(answer.block).toBe(true);
  });

  it('kills the child and blocks when its reply is larger than 1 MiB', async () => {
    // Task 3 review, minor: an unbounded reply is not a decision, it is a hung or
    // misbehaving CLI, and it must not be buffered forever.
    const { pre } = await wireWithStub(
      "process.stdout.write('x'.repeat(1024 * 1024 + 10)); setTimeout(() => {}, 30000);",
    );
    const answer = (await pre.handle(event(), ctx())) as { block: boolean; blockReason: string };
    expect(answer.block).toBe(true);
    expect(answer.blockReason).toContain('exceeded');
  }, 30_000);
});

describe('after_tool_call is observe-only', () => {
  it('logs a warning and returns nothing', async () => {
    const { api, post, log } = await wireWithStub(SUSPECT);
    expect(
      await post.handle(
        event({ result: { output: 'poison' }, error: undefined, durationMs: 12 }),
        ctx(),
      ),
    ).toBeUndefined();
    expect(api.logs).toContain('warn stroq: Stroq: untrusted data');
    const payload = JSON.parse(readFileSync(log, 'utf8').split('\n').slice(1).join('\n')) as Record<
      string,
      unknown
    >;
    expect(readFileSync(log, 'utf8').startsWith('ARGS: hook openclaw post')).toBe(true);
    expect(payload['result']).toEqual({ output: 'poison' });
    expect(payload['durationMs']).toBe(12);
  });

  it('says nothing for a clean scan and never throws on a failure', async () => {
    const clean = await wireWithStub(
      'process.stdout.write(\'{"scanned":true,"verdict":"clean"}\');',
    );
    expect(await clean.post.handle(event({ result: 'ok' }), ctx())).toBeUndefined();
    expect(clean.api.logs).toEqual([]);

    // The tool has already run: a broken scan is a log line, not a thrown handler —
    // and a `warn` one, not `debug`. A scan that failed is a result nobody looked at,
    // so the session is not tainted by it and the follow-up action sails through;
    // nothing can be blocked here, which is exactly why it has to be visible.
    const broken = await wire({ stroqBin: join(tmpdir(), 'definitely-not-stroq') });
    await expect(broken.post.handle(event({ result: 'ok' }), ctx())).resolves.toBeUndefined();
    expect(broken.api.logs.some((line) => line.startsWith('warn stroq: post scan failed'))).toBe(
      true,
    );
  });

  it('still scans a cancelled run: the abort signal is not forwarded to the spawn', async () => {
    // Task 3 review, minor: the tool has already produced its result by the time
    // `after_tool_call` fires, so a run the Gateway cancelled must still be scanned
    // and tainted — forwarding `ctx.abortSignal` here would drop that scan for no
    // safety benefit, since there is nothing left to block.
    const { post, log } = await wireWithStub(SUSPECT);
    const controller = new AbortController();
    controller.abort();
    await post.handle(event({ result: 'ok' }), ctx({ abortSignal: controller.signal }));
    expect(readFileSync(log, 'utf8').startsWith('ARGS: hook openclaw post')).toBe(true);
  });
});

describe('finding the Stroq binary', () => {
  it('prefers the config, then STROQ_BIN, then the stroq.json init wrote', async () => {
    // Each tier is proven by which UNSPLIT path shows up in the block reason
    // (`cannot run <bin>: ...`), rather than by a specific decision: that keeps this
    // test honest about `stroqBin`/`STROQ_BIN` staying one opaque path (Important #2)
    // while still using a real, spawnable `node <stub.js>` for the third tier, which
    // only `stroq.json`'s array-shaped `command` can carry.
    const configPath = join(tmpdir(), 'definitely-not-stroq-config');
    const envPath = join(tmpdir(), 'definitely-not-stroq-env');
    process.env['STROQ_BIN'] = envPath;

    const configWired = await wire({ stroqBin: configPath });
    const configResult = (await configWired.pre.handle(event(), ctx())) as {
      blockReason: string;
    };
    expect(configResult.blockReason).toContain(configPath);
    expect(configResult.blockReason).not.toContain(envPath);

    const envWired = await wire({});
    const envResult = (await envWired.pre.handle(event(), ctx())) as { blockReason: string };
    expect(envResult.blockReason).toContain(envPath);
    delete process.env['STROQ_BIN'];

    // A copy of the plugin with a `stroq.json` beside it, which is exactly what
    // `stroq init --agent openclaw` materialises.
    const { argv } = stubStroq(ASK);
    const installed = await wire({}, installedWith(argv));
    expect(await installed.pre.handle(event(), ctx())).toHaveProperty('requireApproval');
  });
});
