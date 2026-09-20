import type { StroqEngine } from '@stroq/core';
import {
  NO_OUTPUT,
  denyOutput,
  failClosedOutput,
  handleClaudeHook,
  type HookOutput,
} from '../adapters/claude-code.js';
import {
  antigravityBadJsonOutput,
  antigravityBadPhaseOutput,
  antigravityFailClosedOutput,
  handleAntigravityHook,
  isAntigravityPhase,
  toAntigravityPhase,
} from '../adapters/antigravity.js';
import { codexBlockOutput, codexFailClosedOutput, handleCodexHook } from '../adapters/codex.js';
import {
  copilotBadPhaseOutput,
  copilotBlockOutput,
  copilotFailClosedOutput,
  handleCopilotHook,
  isCopilotPhase,
} from '../adapters/copilot.js';
import { cursorDenyOutput, cursorFailClosedOutput, handleCursorHook } from '../adapters/cursor.js';
import {
  handleOpenClawHook,
  isOpenClawPhase,
  openclawBadPhaseOutput,
  openclawBlockOutput,
  openclawFailClosedOutput,
  openclawPostErrorOutput,
} from '../adapters/openclaw.js';
import {
  handleWindsurfHook,
  windsurfBlockOutput,
  windsurfFailClosedOutput,
} from '../adapters/windsurf.js';
import { createEngine } from '../engine-factory.js';
import { ANTIGRAVITY_HOOK_TIMEOUT_SECONDS } from './antigravity-hooks.js';
import { COPILOT_HOOK_TIMEOUT_SECONDS } from './copilot-hooks.js';
import { HOOK_TIMEOUT_SECONDS, hookDeadlineMs } from './config-file.js';
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
   * than re-thrown. Codex reads a non-zero exit that is not 2 as a hook failure and
   * continues past it, so for Codex the unhandled path is fail-open on exactly the
   * events Stroq exists to block. Copilot is the other way round on `preToolUse`,
   * where ANY non-zero exit denies (`Denied by preToolUse hook (hook errored)`) and
   * only the other events fail open — but the reason still has to reach the user, and
   * only exit 2 surfaces stderr, so both adapters answer with their own output rather
   * than with `main`'s exit-1 handler. Claude Code and Cursor keep today's behaviour.
   * OpenClaw is the third: its plugin blocks the call on any non-zero exit, so the
   * exit-1 path would block with no explanation instead of the reason exit 2 carries.
   * Windsurf is the fourth, and the strictest of the four: Cascade reads ONLY exit 2
   * as a block, with the reason on stderr, and treats every OTHER non-zero exit —
   * exit 1 included — as an allow, so `main`'s exit-1 handler would silently let a
   * real deny through rather than merely losing the explanation.
   */
  readonly stdinFailClosed?: true;
  /**
   * How long this agent's hook may take before Stroq answers with its own fail-closed
   * verdict. Derived from the timeout the installer writes for the same agent, so the
   * two cannot drift apart.
   */
  readonly deadlineMs: number;
}

/**
 * Windsurf's hook format carries no timeout key, so Cascade never gives up on its own
 * and this deadline is the only one there is. OpenClaw's is the budget the plugin
 * wrapper enforces (`run-stroq.js`), which is shorter than the other agents'.
 */
const WINDSURF_NOTIONAL_TIMEOUT_SECONDS = 15;
const OPENCLAW_WRAPPER_TIMEOUT_SECONDS = 10;

const ADAPTERS: Readonly<Record<string, HookAdapter>> = {
  'claude-code': {
    handle: handleClaudeHook,
    failClosed: failClosedOutput,
    badJson: denyOutput,
    deadlineMs: hookDeadlineMs(HOOK_TIMEOUT_SECONDS),
  },
  cursor: {
    handle: handleCursorHook,
    failClosed: cursorFailClosedOutput,
    badJson: cursorDenyOutput,
    deadlineMs: hookDeadlineMs(HOOK_TIMEOUT_SECONDS),
  },
  // Codex answers a block with exit code 2 and the reason on stderr, not with JSON:
  // stdin that was not JSON at all is exactly the case where a JSON deny would be
  // dropped as an unsupported/unparseable payload, i.e. fail open.
  codex: {
    handle: handleCodexHook,
    failClosed: codexFailClosedOutput,
    badJson: codexBlockOutput,
    stdinFailClosed: true,
    deadlineMs: hookDeadlineMs(HOOK_TIMEOUT_SECONDS),
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
    deadlineMs: hookDeadlineMs(COPILOT_HOOK_TIMEOUT_SECONDS),
  },
  // Same shape as Copilot's — the phase rides on the command line — but the answers
  // are Stroq's own JSON, because the only consumer is the plugin in this repository.
  // A `post` that fails still replies: the plugin logs it, and there is nothing left
  // to block once the tool has run.
  openclaw: {
    handle: (engine, raw, arg) => handleOpenClawHook(engine, arg === 'post' ? 'post' : 'pre', raw),
    failClosed: (raw, err, arg) =>
      openclawFailClosedOutput(arg === 'post' ? 'post' : 'pre', raw, err),
    badJson: (reason, arg) =>
      arg === 'post' ? openclawPostErrorOutput(reason) : openclawBlockOutput(reason),
    checkArg: (arg) => (isOpenClawPhase(arg) ? null : openclawBadPhaseOutput(arg)),
    stdinFailClosed: true,
    deadlineMs: hookDeadlineMs(OPENCLAW_WRAPPER_TIMEOUT_SECONDS),
  },
  // Windsurf's payload names its own event (`agent_action_name`), so there is no
  // phase argument and no `checkArg`: one command answers all six installed events,
  // and any other event — including a future one — is answered with silence. A block
  // is exit code 2 with the reason on stderr, the only channel Cascade reads; any
  // OTHER non-zero exit is an allow on Windsurf, so a stdin rejection has to be
  // answered here rather than by `main`'s exit-1 path, which would fail open.
  windsurf: {
    handle: handleWindsurfHook,
    failClosed: windsurfFailClosedOutput,
    badJson: windsurfBlockOutput,
    stdinFailClosed: true,
    deadlineMs: hookDeadlineMs(WINDSURF_NOTIONAL_TIMEOUT_SECONDS),
  },
  // Antigravity has three phases rather than two — `PreInvocation` is the only place
  // in any supported agent where Stroq can put a taint note into the model's context
  // — and none of the three payloads names its own event, so the phase rides on the
  // command line as it does for Copilot and OpenClaw. What is different here is the
  // ANSWER: Antigravity documents its stdout contract and says nothing about what a
  // non-zero exit means, so every verdict this adapter produces — a deny, an internal
  // error, stdin that was not JSON — is the documented deny object on stdout with
  // exit 0, never an exit code. `stdinFailClosed` therefore routes a stdin rejection
  // here rather than to `main`'s exit 1, whose meaning is equally undocumented.
  antigravity: {
    handle: (engine, raw, arg) => handleAntigravityHook(engine, toAntigravityPhase(arg), raw),
    failClosed: (raw, err, arg) => antigravityFailClosedOutput(toAntigravityPhase(arg), raw, err),
    badJson: (reason, arg) => antigravityBadJsonOutput(toAntigravityPhase(arg), reason),
    checkArg: (arg) => (isAntigravityPhase(arg) ? null : antigravityBadPhaseOutput(arg)),
    stdinFailClosed: true,
    deadlineMs: hookDeadlineMs(ANTIGRAVITY_HOOK_TIMEOUT_SECONDS),
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

export async function runHook(
  agent: string,
  rawJson: string,
  arg = '',
  opts: { readonly deadlineMs?: number } = {},
): Promise<HookOutput> {
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
    return await withDeadline(
      adapter.handle(createEngine(), raw, arg),
      opts.deadlineMs ?? adapter.deadlineMs,
      () => {
        const err = new Error(
          `hook did not answer within ${opts.deadlineMs ?? adapter.deadlineMs} ms; answering fail-closed`,
        );
        logError(context, err);
        return { ...adapter.failClosed(raw, err, arg), timedOut: true };
      },
    );
  } catch (err) {
    logError(context, err);
    return adapter.failClosed(raw, err, arg);
  }
}

/**
 * Resolves with `onTimeout()` if `work` has not settled within `ms`.
 *
 * The work is not cancellable and keeps running; that is deliberate and is why the
 * result is marked `timedOut`. What matters is that an answer exists before the host
 * agent's own timeout fires, because every agent treats its own timeout as an allow.
 * A rejection from `work` after the deadline has already been answered is swallowed
 * here rather than left to become an unhandled rejection that outlives the verdict.
 */
export async function withDeadline(
  work: Promise<HookOutput>,
  ms: number,
  onTimeout: () => HookOutput,
): Promise<HookOutput> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<HookOutput>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
      }),
    ]);
  } finally {
    // The timer is the only thing here that would hold the event loop open after an
    // answer. The work itself is not cancellable and keeps running, which is what
    // `timedOut` tells the caller; `Promise.race` has already subscribed to it, so a
    // rejection arriving after the deadline is handled rather than unhandled.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The whole `stroq hook` command, stdin included. `runHook` above answers every
 * failure it can see, but the read itself can still reject, and `main`'s exit-1 path
 * is the wrong answer for four of the six agents: Codex reads an arbitrary non-zero
 * exit as a hook failure and continues past it, so exit 1 is fail-open on exactly the
 * events Stroq exists to block; Copilot denies on any non-zero exit from a
 * `preToolUse` but surfaces the reason only on exit 2; OpenClaw's plugin reads exit 2
 * with a reason on stderr as a block and anything else as an internal error; and
 * Windsurf's Cascade reads ONLY exit 2 as a block and every other non-zero exit —
 * exit 1 included — as an allow, so exit 1 there would silently let a real deny
 * through rather than merely losing the explanation. Those four answer such a
 * rejection with their own fail-closed output (`stdinFailClosed`); the other two
 * re-throw and keep today's behaviour, where `main` prints the error and exits 1.
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
