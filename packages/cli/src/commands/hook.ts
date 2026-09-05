import type { StroqEngine } from '@stroq/core';
import {
  denyOutput,
  failClosedOutput,
  handleClaudeHook,
  type HookOutput,
} from '../adapters/claude-code.js';
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
};

/** Agent names `stroq hook <agent>` accepts, in the order the error message lists them. */
export const SUPPORTED_AGENTS: readonly string[] = Object.keys(ADAPTERS);

const BAD_JSON = 'Stroq internal error (fail-closed): hook input is not valid JSON';

export async function runHook(agent: string, rawJson: string): Promise<HookOutput> {
  const adapter = ADAPTERS[agent];
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
