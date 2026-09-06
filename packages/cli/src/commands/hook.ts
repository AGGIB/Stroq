import type { StroqEngine } from '@stroq/core';
import {
  NO_OUTPUT,
  denyOutput,
  failClosedOutput,
  handleClaudeHook,
  type HookOutput,
} from '../adapters/claude-code.js';
import { codexBlockOutput, codexFailClosedOutput, handleCodexHook } from '../adapters/codex.js';
import {
  copilotBadPhaseOutput,
  copilotBlockOutput,
  copilotFailClosedOutput,
  handleCopilotHook,
  isCopilotPhase,
} from '../adapters/copilot.js';
import { cursorDenyOutput, cursorFailClosedOutput, handleCursorHook } from '../adapters/cursor.js';
import { createEngine } from '../engine-factory.js';
import { logError } from '../log.js';

export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  let data = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) data += chunk;
  return data;
}

interface HookAdapter {
  /** `arg` is the extra word on the command line; only Copilot reads it. */
  readonly handle: (engine: StroqEngine, raw: unknown, arg: string) => Promise<HookOutput>;
  /** Answer to an internal error, given the raw event: fail-closed where it matters. */
  readonly failClosed: (raw: unknown, err: unknown, arg: string) => HookOutput;
  /** Answer when stdin was not JSON at all — or could not be read — so there is no event to inspect. */
  readonly badJson: (reason: string, arg: string) => HookOutput;
  /**
   * Validates the extra word `stroq hook <agent> <arg>` carries; `null` when it is
   * usable. Only Copilot defines it: its events do not name themselves, so the phase
   * is the only thing that says whether a deny is even possible.
   */
  readonly checkArg?: (arg: string) => HookOutput | null;
  /**
   * True when a stdin read that REJECTS (a closed or broken stdin, an out-of-memory
   * payload) must still be answered with this adapter's fail-closed output rather
   * than re-thrown. Codex and Copilot both read a non-zero exit that is not 2 as a
   * hook failure and continue past it, so for them the unhandled path is fail-open on
   * exactly the events Stroq exists to block. Claude Code and Cursor do not, so they
   * keep today's behaviour and `main`'s exit-1 handler.
   */
  readonly stdinFailClosed?: true;
}

const ADAPTERS: Readonly<Record<string, HookAdapter>> = {
  'claude-code': { handle: handleClaudeHook, failClosed: failClosedOutput, badJson: denyOutput },
  cursor: {
    handle: handleCursorHook,
    failClosed: cursorFailClosedOutput,
    badJson: cursorDenyOutput,
  },
  // Codex answers a block with exit code 2 and the reason on stderr, not with JSON:
  // stdin that was not JSON at all is exactly the case where a JSON deny would be
  // dropped as an unsupported/unparseable payload, i.e. fail open.
  codex: {
    handle: handleCodexHook,
    failClosed: codexFailClosedOutput,
    badJson: codexBlockOutput,
    stdinFailClosed: true,
  },
  // Copilot's events carry no event name, so the phase rides on the command line and
  // every entry here takes it. `checkArg` has already rejected anything but `pre` and
  // `post` by the time `handle` or `failClosed` runs, which is why the narrowing
  // below is a ternary and not a parse.
  copilot: {
    handle: (engine, raw, arg) => handleCopilotHook(engine, arg === 'post' ? 'post' : 'pre', raw),
    failClosed: (raw, err, arg) =>
      copilotFailClosedOutput(arg === 'post' ? 'post' : 'pre', raw, err),
    // On `post` there is nothing left to block and a non-zero exit fails open anyway.
    badJson: (reason, arg) => (arg === 'post' ? NO_OUTPUT : copilotBlockOutput(reason)),
    checkArg: (arg) => (isCopilotPhase(arg) ? null : copilotBadPhaseOutput(arg)),
    stdinFailClosed: true,
  },
};

/** Agent names `stroq hook <agent>` accepts, in the order the error message lists them. */
export const SUPPORTED_AGENTS: readonly string[] = Object.keys(ADAPTERS);

const BAD_JSON = 'Stroq internal error (fail-closed): hook input is not valid JSON';

const lookup = (agent: string): HookAdapter | undefined =>
  // A plain lookup resolves inherited Object.prototype members too
  // (`ADAPTERS['constructor']`, `ADAPTERS['__proto__']`), which are truthy and would
  // then crash downstream with "adapter.handle is not a function" instead of the
  // unknown-agent message below. Object.hasOwn restricts the lookup to agents this
  // module actually registered.
  Object.hasOwn(ADAPTERS, agent) ? ADAPTERS[agent] : undefined;

export async function runHook(agent: string, rawJson: string, arg = ''): Promise<HookOutput> {
  const adapter = lookup(agent);
  if (!adapter)
    return {
      stdout: `unknown agent "${agent}" (supported: ${SUPPORTED_AGENTS.join(', ')})\n`,
      exitCode: 1,
    };
  const context = `hook ${agent}`;
  const badArg = adapter.checkArg?.(arg);
  if (badArg) {
    logError(context, new Error(`missing or unknown phase argument "${arg}"`));
    return badArg;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(rawJson);
  } catch (err) {
    logError(context, err);
    return adapter.badJson(BAD_JSON, arg);
  }
  try {
    return await adapter.handle(createEngine(), raw, arg);
  } catch (err) {
    logError(context, err);
    return adapter.failClosed(raw, err, arg);
  }
}

/**
 * The whole `stroq hook` command, stdin included. `runHook` above answers every
 * failure it can see, but the read itself can still reject — and for the agents that
 * treat an arbitrary non-zero exit as a hook failure, the unhandled path is fail-open
 * on exactly the events Stroq exists to block. Those adapters answer such a rejection
 * with their own fail-closed output (`stdinFailClosed`); the others re-throw and keep
 * today's behaviour, where `main`'s top-level handler prints the error and exits 1.
 */
export async function runHookCommand(
  agent: string,
  arg = '',
  read: () => Promise<string> = readStdin,
): Promise<HookOutput> {
  try {
    return await runHook(agent, await read(), arg);
  } catch (err) {
    const adapter = lookup(agent);
    if (!adapter?.stdinFailClosed) throw err;
    logError(`hook ${agent}`, err);
    const message = err instanceof Error ? err.message : String(err);
    return adapter.badJson(`Stroq internal error (fail-closed): ${message}`, arg);
  }
}
