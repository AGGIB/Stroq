import { toolResultToText } from './claude-code.js';

/**
 * The text of a completed action, for the agents that wrap it in a result object.
 * Codex puts the unified shell result in `output`; some builds (and Copilot, once
 * past its own `textResultForLlm`) still send `stdout`/`stderr`. An empty `output`
 * is not the official field being in play — an agent or a proxy can send
 * `output: ''` — so it must not shadow the streams that carry the real, possibly
 * poisoned, result.
 */
export function streamResultText(response: unknown): string {
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const record = response as Record<string, unknown>;
    const output = record['output'];
    if (typeof output === 'string' && output !== '') return toolResultToText(output);
    const streams = [record['stdout'], record['stderr']].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    if (streams.length > 0) return toolResultToText(streams.join('\n'));
  }
  return toolResultToText(response);
}
