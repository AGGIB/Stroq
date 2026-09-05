import type { StroqEngine } from '@stroq/core';
import {
  denyOutput,
  failClosedOutput,
  handleClaudeHook,
  type HookOutput,
} from '../adapters/claude-code.js';
import { codexBlockOutput, codexFailClosedOutput, handleCodexHook } from '../adapters/codex.js';
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
  readonly handle: (engine: StroqEngine, raw: unknown) => Promise<HookOutput>;
  /** Answer to an internal error, given the raw event: fail-closed where it matters. */
  readonly failClosed: (raw: unknown, err: unknown) => HookOutput;
  /** Answer when stdin was not JSON at all, so there is no event to inspect. */
  readonly badJson: (reason: string) => HookOutput;
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
  },
};

/** Agent names `stroq hook <agent>` accepts, in the order the error message lists them. */
export const SUPPORTED_AGENTS: readonly string[] = Object.keys(ADAPTERS);

const BAD_JSON = 'Stroq internal error (fail-closed): hook input is not valid JSON';

export async function runHook(agent: string, rawJson: string): Promise<HookOutput> {
  // A plain lookup resolves inherited Object.prototype members too
  // (`ADAPTERS['constructor']`, `ADAPTERS['__proto__']`), which are truthy and would
  // then crash downstream with "adapter.handle is not a function" instead of the
  // unknown-agent message below. Object.hasOwn restricts the lookup to agents this
  // module actually registered.
  const adapter = Object.hasOwn(ADAPTERS, agent) ? ADAPTERS[agent] : undefined;
  if (!adapter)
    return {
      stdout: `unknown agent "${agent}" (supported: ${SUPPORTED_AGENTS.join(', ')})\n`,
      exitCode: 1,
    };
  const context = `hook ${agent}`;
  let raw: unknown;
  try {
    raw = JSON.parse(rawJson);
  } catch (err) {
    logError(context, err);
    return adapter.badJson(BAD_JSON);
  }
  try {
    return await adapter.handle(createEngine(), raw);
  } catch (err) {
    logError(context, err);
    return adapter.failClosed(raw, err);
  }
}
