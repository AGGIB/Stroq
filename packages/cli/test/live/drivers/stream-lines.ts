import { parseClaudeStream, type ParsedStream } from '../../../src/live/drivers/claude-stream.js';

// The lines of a stream of `claude -p`, as the tests of the parser and of what it reads write them.
/** A line of a stream, as the host prints it. */
export const line = (value: unknown): string => `${JSON.stringify(value)}\n`;

export const init = (over: Record<string, unknown> = {}): string =>
  line({
    type: 'system',
    subtype: 'init',
    cwd: '/project',
    tools: ['Bash'],
    apiKeySource: 'none',
    permissionMode: 'acceptEdits',
    ...over,
  });

export const rate = (over: Record<string, unknown> = {}): string =>
  line({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'allowed',
      overageStatus: 'rejected',
      isUsingOverage: false,
      ...over,
    },
  });

export const result = (over: Record<string, unknown> = {}): string =>
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'DONE',
    modelUsage: { 'claude-haiku-4-5': { provider: 'firstParty' } },
    ...over,
  });

export const assistant = (...content: unknown[]): string =>
  line({ type: 'assistant', message: { content } });
export const toolUse = (command: string): unknown => ({
  type: 'tool_use',
  id: 'toolu_1',
  name: 'Bash',
  input: { command },
});
export const toolResult = (content: unknown, isError?: boolean): string =>
  line({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content,
          ...(isError === undefined ? {} : { is_error: isError }),
        },
      ],
    },
  });

export const parse = (text: string): ParsedStream => parseClaudeStream(text).parsed;
