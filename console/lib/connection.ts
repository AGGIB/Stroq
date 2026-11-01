import { AGENTS, KEYS, TODAY, type Agent, type KeyFinding, type ToolCall } from './data';
import { DEMO_CALLS } from './platform';

/**
 * Where the numbers on a page come from.
 * - `none`: nothing is connected. There is nothing to show, and nothing is invented.
 * - `local`: read from this machine's Stroq journal through the private link.
 * - `demo`: the example below, only after the user chose it.
 */
export type PlatformSource = 'none' | 'local' | 'demo';

export interface Snapshot {
  readonly source: PlatformSource;
  readonly generatedAt: string;
  readonly calls: readonly ToolCall[];
  readonly agents: readonly Agent[];
  readonly keys: readonly KeyFinding[];
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

/** Made-up events, shown only after an explicit choice and always labelled as an example. */
export const EXAMPLE: Snapshot = {
  source: 'demo',
  generatedAt: `${TODAY}T14:30:00Z`,
  calls: DEMO_CALLS,
  agents: AGENTS,
  keys: KEYS,
  limitations: [
    'Example workspace with synthetic events. These are not results from your machine.',
  ],
};
