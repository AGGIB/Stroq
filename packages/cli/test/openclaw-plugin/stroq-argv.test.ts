import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * How the plugin decides which Stroq to spawn. Split from the other two plugin test
 * files (the 400-line-per-test-file budget) and re-declaring its own fixtures the way
 * they do, because this is the one part of the plugin that has to keep working when
 * the install around it has rotted: `npx @stroq/cli init --agent openclaw` records a
 * path inside the npx cache, and pruning that cache used to make every tool call
 * block with an unreadable ENOENT — a firewall bricking the agent it protects.
 *
 * `resolveStroqArgv` is pure (config, environment, recorded command and the existence
 * check are all parameters), so the order below is tested with fakes rather than by
 * planting binaries on PATH — which cannot be done here anyway: a PATH lookup only
 * finds an executable, and a Node script without a shebang is not one.
 */

const pluginDir = join(import.meta.dirname, '../../openclaw-plugin');
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

interface Resolution {
  readonly argv: readonly string[];
  readonly staleEntry: string | null;
}
type ResolveStroqArgv = (options: {
  readonly config?: Record<string, unknown>;
  readonly env?: Record<string, string | undefined>;
  readonly recorded?: unknown;
  readonly exists: (path: string) => boolean;
}) => Resolution;

/**
 * The module under test, imported through a computed `file://` URL: a literal
 * specifier would make TypeScript resolve a `.js` outside `src`/`test` that has no
 * declarations, while the URL keeps it a runtime import, exactly as the Gateway does.
 */
const loadResolve = async (dir: string = pluginDir): Promise<ResolveStroqArgv> =>
  (
    (await import(/* @vite-ignore */ pathToFileURL(join(dir, 'run-stroq.js')).href)) as {
      resolveStroqArgv: ResolveStroqArgv;
    }
  ).resolveStroqArgv;

const NODE = '/usr/bin/node';
const ENTRY = '/opt/stroq/dist/index.js';
const never = () => false;
const always = () => true;

describe('resolveStroqArgv', () => {
  it('prefers the plugin config, then STROQ_BIN, then the recorded command', async () => {
    const resolve = await loadResolve();
    const recorded = [NODE, ENTRY];
    expect(
      resolve({
        config: { stroqBin: '/opt/config/stroq' },
        env: { STROQ_BIN: '/opt/env/stroq' },
        recorded,
        exists: always,
      }).argv,
    ).toEqual(['/opt/config/stroq']);
    expect(
      resolve({ env: { STROQ_BIN: '/opt/env/stroq' }, recorded, exists: always }).argv,
    ).toEqual(['/opt/env/stroq']);
    expect(resolve({ recorded, exists: always }).argv).toEqual(recorded);
    expect(resolve({ exists: always }).argv).toEqual(['stroq']);
  });

  it('never splits a configured path, even one containing a space', async () => {
    // A real install path (a macOS "Jane Doe" home, an nvm path) can contain one, and
    // splitting would silently spawn a truncated binary instead of failing loudly.
    const resolve = await loadResolve();
    const spaced = '/Users/Jane Doe/.local/bin/stroq';
    expect(resolve({ config: { stroqBin: spaced }, exists: never }).argv).toEqual([spaced]);
    expect(resolve({ env: { STROQ_BIN: spaced }, exists: never }).argv).toEqual([spaced]);
  });

  it('is not existence-checked when it was configured explicitly', async () => {
    // An operator who named a binary must see it fail, not be silently redirected to
    // a different Stroq that happens to be on PATH.
    const resolve = await loadResolve();
    expect(resolve({ config: { stroqBin: '/gone/stroq' }, exists: never })).toEqual({
      argv: ['/gone/stroq'],
      staleEntry: null,
    });
  });

  it('skips a recorded command whose entry file is gone, and says which', async () => {
    const resolve = await loadResolve();
    expect(resolve({ recorded: [NODE, ENTRY], exists: (p) => p !== ENTRY })).toEqual({
      argv: ['stroq'],
      staleEntry: ENTRY,
    });
  });

  it('checks the LAST absolute path, which is the entry and not the interpreter', async () => {
    const resolve = await loadResolve();
    const source = '/opt/stroq/src/index.ts';
    const recorded = [NODE, '--import', 'tsx', source];
    const checked: string[] = [];
    const result = resolve({
      recorded,
      exists: (p) => {
        checked.push(p);
        return true;
      },
    });
    expect(checked).toEqual([source]);
    expect(result.argv).toEqual(recorded);
  });

  it('uses a recorded command that names no absolute path at all', async () => {
    // `['stroq', '--flag']` has nothing this module can check; there is no entry file
    // to have gone stale, so it is used as recorded rather than thrown away.
    const resolve = await loadResolve();
    expect(resolve({ recorded: ['stroq', '--flag'], exists: never })).toEqual({
      argv: ['stroq', '--flag'],
      staleEntry: null,
    });
  });

  it.each([
    ['nothing recorded', null],
    ['an empty array', []],
    ['a non-array', { command: NODE }],
    ['an array with a non-string in it', [NODE, 7]],
  ])('falls back to PATH for %s', async (_label, recorded) => {
    const resolve = await loadResolve();
    expect(resolve({ recorded, exists: always })).toEqual({ argv: ['stroq'], staleEntry: null });
  });
});

interface Handler {
  readonly handle: (event: unknown, ctx: unknown) => Promise<unknown>;
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
  on(event: string, handle: Handler['handle']): void {
    this.handlers.set(event, { handle });
  }
}

const event = { toolName: 'exec', params: { command: 'ls -la' }, toolKind: 'shell' };
const ctx = { sessionKey: 'session-key-1' };

describe('a pruned npx cache does not brick the agent', () => {
  it('falls back to PATH, warns once per process, and still fails closed', async () => {
    const dir = tmp('stroq-openclaw-stale-');
    cpSync(pluginDir, dir, { recursive: true });
    const gone = join(tmp('stroq-openclaw-npx-'), '_npx', 'abc123', 'dist', 'index.js');
    writeFileSync(join(dir, 'stroq.json'), JSON.stringify({ command: [process.execPath, gone] }));

    // A PATH with no `stroq` on it, so the fallback is deterministic here and never
    // reaches a Stroq that happens to be installed on the machine running this suite.
    const originalPath = process.env['PATH'];
    process.env['PATH'] = tmp('stroq-openclaw-emptypath-');
    try {
      const api = new FakeApi({});
      const plugin = (await import(
        /* @vite-ignore */ pathToFileURL(join(dir, 'index.js')).href
      )) as { register: (api: FakeApi) => void };
      plugin.register(api);
      const pre = api.handlers.get('before_tool_call');
      if (!pre) throw new Error('the plugin did not register the gate');

      const first = (await pre.handle(event, ctx)) as { block: boolean; blockReason: string };
      // The recorded (missing) entry was skipped: what was spawned is bare `stroq`.
      expect(first.blockReason).toContain('cannot run stroq');
      expect(first.blockReason).not.toContain(gone);
      // Still fail-closed — falling back is about being able to answer at all, not
      // about answering allow when there is no Stroq to ask.
      expect(first.block).toBe(true);

      await pre.handle(event, ctx);
      const stale = api.logs.filter((line) => line.includes('stroq.json'));
      expect(stale).toHaveLength(1);
      expect(stale[0]).toContain('warn ');
      expect(stale[0]).toContain(gone);
    } finally {
      if (originalPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = originalPath;
    }
  }, 30_000);
});
