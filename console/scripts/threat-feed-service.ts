import {
  MAX_THREATS,
  THREAT_FEED_SCHEMA,
  THREAT_SOURCE,
  validateThreatFeed,
  validateThreatFeedRequest,
  type ThreatFeed,
} from '../lib/threat-feed';
import { matchThreats } from './threat-feed-match';
import { createFeedSource, type FeedSource } from './threat-feed-source';
import { readStack } from './threat-feed-stack';

type Response = { status: number; body: unknown };

/** A list older than this, because every download since failed, is not shown at all. */
const STALE_MS = 24 * 60 * 60_000;

interface Dependencies {
  /** Your home folder: where the coding agents' settings folders are looked for. */
  readonly userHome: string;
  /** The workspace the console was started for. */
  readonly project: string;
  /** `CODEX_HOME` when set. */
  readonly codexHome?: string | null;
  readonly now?: () => Date;
  readonly feed?: FeedSource;
}

/**
 * The threat feed: pwn.watch's incidents that match this project. It downloads only when the page
 * asks, which the page does only once the feed is turned on in Settings; it writes nothing.
 */
export function createThreatFeedService({
  userHome,
  project,
  codexHome = null,
  now = () => new Date(),
  feed = createFeedSource({ now }),
}: Dependencies) {
  let closed = false;
  return {
    async read(input: unknown): Promise<Response> {
      if (closed) return { status: 503, body: { error: 'engine-unavailable' } };
      if (!validateThreatFeedRequest(input))
        return { status: 400, body: { error: 'invalid-request' } };
      const [{ copy, problem }, stack] = await Promise.all([
        feed.read(),
        readStack({ userHome, project, codexHome }),
      ]);
      const at = now();
      // A day-old list is not "now": with no download since, there is no list to show.
      const usable =
        copy !== null && at.getTime() - copy.fetchedAt.getTime() <= STALE_MS ? copy : null;
      const found = usable === null ? [] : matchThreats(usable.incidents, stack, at);
      const body: ThreatFeed = {
        schema: THREAT_FEED_SCHEMA,
        source: THREAT_SOURCE,
        generatedAt: at.toISOString(),
        state: usable === null ? 'unavailable' : 'ready',
        problem: usable === null ? (problem ?? 'network') : problem,
        fetchedAt: usable === null ? null : usable.fetchedAt.toISOString(),
        compared: {
          incidents: usable?.incidents.length ?? 0,
          packages: stack.npm.size + stack.pypi.size,
          ecosystems: [...stack.ecosystems],
          agents: [...stack.agents],
          unread: [...stack.unread],
          skipped: usable?.skipped ?? 0,
        },
        matches: found.slice(0, MAX_THREATS),
        more: Math.max(0, found.length - MAX_THREATS),
      };
      // What leaves is checked against the same closed schema the page checks.
      return validateThreatFeed(body)
        ? { status: 200, body }
        : { status: 500, body: { error: 'invalid-response' } };
    },

    async close(): Promise<void> {
      closed = true;
    },
  };
}
