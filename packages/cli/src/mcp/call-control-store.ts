import {
  callControlError,
  type McpCallControlDecision,
  type McpCallControlSnapshot,
  type McpCallControlEvent,
} from './call-control-types.js';
import { encodeCallControlState, nextCallControlEvent } from './call-control-state.js';
import { ensureStateMacKeySync } from '../state-mac.js';
import {
  publishCallControlAuthority,
  readCallControlAuthority,
  readCallControlAuthorityFileSync,
  withCallControlLease,
} from './call-control-files.js';

export function createMcpCallControlsStore(options: {
  readonly home: string;
  readonly now?: () => Date;
  readonly lockTimeoutMs?: number;
  readonly fault?: (
    stage: 'before-publish' | 'after-publish' | 'before-readback',
  ) => void | Promise<void>;
}): {
  read(): Promise<McpCallControlSnapshot>;
  decide(
    input: McpCallControlDecision,
    guards?: { beforeCommit?: () => Promise<void> },
  ): Promise<{ state: McpCallControlSnapshot; event: McpCallControlEvent }>;
} {
  return {
    read: () => readCallControlAuthority(options.home),
    decide: async (input, guards) => {
      let published = false;
      try {
        return await withCallControlLease(
          options.home,
          true,
          async (lease) => {
            const before = readCallControlAuthorityFileSync(options.home);
            if (!before.context) return callControlError('mcp-call-control-unavailable');
            const event = nextCallControlEvent(
              before.state,
              input,
              (options.now ?? (() => new Date()))(),
            );
            const bytes = encodeCallControlState(
              [...before.state.events, event],
              before.context.homeBinding,
              before.context.key ?? ensureStateMacKeySync(before.context.home),
            );
            const state = await publishCallControlAuthority(
              options.home,
              before,
              bytes,
              lease,
              guards?.beforeCommit,
              options.fault,
            );
            published = true;
            return { state, event };
          },
          options.lockTimeoutMs,
        );
      } catch (e) {
        if (published) callControlError('mcp-call-control-write-unconfirmed');
        throw e;
      }
    },
  };
}
