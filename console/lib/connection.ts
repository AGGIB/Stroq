import type { Agent, ToolCall } from './platform-types';

/**
 * Where the numbers on a page come from.
 * - `none`: nothing is connected. There is nothing to show, and nothing is invented.
 * - `local`: read from this machine's Stroq journal through the private link.
 */
export type PlatformSource = 'none' | 'local';

export interface Snapshot {
  readonly source: PlatformSource;
  readonly generatedAt: string;
  readonly calls: readonly ToolCall[];
  readonly agents: readonly Agent[];
  readonly keys: readonly [];
  readonly limitations: readonly string[];
}

/** What every page starts with: no events, agents or keys, and no time they were read. */
export const NOT_CONNECTED: Snapshot = {
  source: 'none',
  generatedAt: '',
  calls: [],
  agents: [],
  keys: [],
  limitations: [],
};
