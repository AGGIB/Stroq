import { failClosedOutput, handleClaudeHook, type HookOutput } from '../adapters/claude-code.js';
import { createEngine } from '../engine-factory.js';
import { logError } from '../log.js';

export async function readStdin(stream: NodeJS.ReadableStream = process.stdin): Promise<string> {
  let data = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) data += chunk;
  return data;
}

export async function runHook(agent: string, rawJson: string): Promise<HookOutput> {
  if (agent !== 'claude-code')
    return { stdout: `unknown agent "${agent}" (supported: claude-code)\n`, exitCode: 1 };
  let raw: unknown = null;
  try {
    raw = JSON.parse(rawJson);
    return await handleClaudeHook(createEngine(), raw);
  } catch (err) {
    logError('hook claude-code', err);
    return failClosedOutput(raw, err);
  }
}
