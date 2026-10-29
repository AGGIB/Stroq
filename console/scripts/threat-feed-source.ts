import {
  INVISIBLE,
  PATCH_STATES,
  SEVERITIES,
  THREAT_CATEGORIES,
  isSlug,
  type PatchState,
  type Severity,
  type ThreatCategory,
  type ThreatProblem,
} from '../lib/threat-feed';

/**
 * Downloads pwn.watch's list of incidents for the threat feed: one fixed address over HTTPS, no
 * redirects, at most 4 MiB in 20 seconds, at most once every 15 minutes (a list that has not changed is
 * answered by its ETag, without the body), and after a failure at most once a minute, then less often. The request names nothing about this machine or project.
 * Every incident is checked field by field; one that does not fit is left out and counted, and a list
 * where most do not fit is refused whole, since its format has changed.
 */

export const FEED_URL = 'https://pwn.watch/incidents.json';
export const FEED_SITE = 'https://pwn.watch';
/** The list is about 1 MB; parsing a hostile body this size costs tens of times its size in memory. */
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
/** How long a downloaded list is used before it is checked again. */
export const REFRESH_MS = 15 * 60_000;
/** How long after a failed download the next one is tried; it doubles with each failure, up to `REFRESH_MS`. */
export const RETRY_MS = 60_000;
const MAX_INCIDENTS = 5_000;
const MAX_WORDS = 40;
const MAX_AFFECTED = 30;
const TAG = /^[a-z0-9][a-z0-9.+-]{0,47}$/;
const DAY = /^(\d{4}-\d{2}-\d{2})(?:T[\d:.]+Z)?$/;
const ETAG = /^(?:W\/)?"[\x21\x23-\x7e]{1,200}"$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

export interface Incident {
  readonly slug: string;
  readonly title: string;
  readonly category: ThreatCategory;
  readonly severity: Severity;
  readonly live: boolean;
  readonly patch: PatchState;
  readonly product: string;
  readonly stacks: readonly string[];
  readonly tags: readonly string[];
  /** pwn.watch's words on the versions affected: prose, read only for package names. */
  readonly affected: readonly string[];
  /** `YYYY-MM-DD`. */
  readonly startedAt: string;
  /** Milliseconds since the epoch. */
  readonly updatedAt: number;
}

export interface FeedCopy {
  readonly incidents: readonly Incident[];
  readonly fetchedAt: Date;
  readonly etag: string | null;
  /** Incidents left out because a field did not fit. */
  readonly skipped: number;
}

export interface FeedRead {
  readonly copy: FeedCopy | null;
  /** Why the latest download failed, or null when it did not. */
  readonly problem: ThreatProblem | null;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * One line of text as the page may show it: no control or invisible character, at most `max` UTF-16
 * units long (what the page's schema counts), cut between characters, never inside one.
 */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const flat = value
    .replace(CONTROL, ' ')
    .replace(new RegExp(INVISIBLE.source, 'gu'), '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length === 0) return null;
  if (flat.length <= max) return flat;
  let cut = '';
  for (const point of flat) {
    if (cut.length + point.length > max - 1) break;
    cut += point;
  }
  return `${cut.trimEnd()}…`;
}

const words = (value: unknown): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.toLowerCase())
            .filter((item) => TAG.test(item)),
        ),
      ].slice(0, MAX_WORDS)
    : [];

const pick = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
  typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : fallback;

function dayOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = DAY.exec(value);
  if (match === null) return null;
  const day = match[1] as string;
  const at = new Date(`${day}T00:00:00.000Z`);
  return Number.isFinite(at.getTime()) && at.toISOString().startsWith(day) ? day : null;
}

/** One incident, or null when a field it cannot do without does not fit. */
export function parseIncident(raw: unknown): Incident | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (!isSlug(item.slug) || item.url !== `${FEED_SITE}/i/${item.slug}`) return null;
  const title = cleanText(item.title, 200);
  const startedAt = dayOf(item.startedAt);
  if (title === null || startedAt === null) return null;
  if (
    typeof item.category !== 'string' ||
    !(THREAT_CATEGORIES as readonly string[]).includes(item.category)
  )
    return null;
  if (item.status !== 'live' && item.status !== 'closed') return null;
  const updated = typeof item.updatedAt === 'string' ? Date.parse(item.updatedAt) : Number.NaN;
  return {
    slug: item.slug,
    title,
    category: item.category as ThreatCategory,
    severity: pick(item.severity, SEVERITIES, 'unknown'),
    live: item.status === 'live',
    patch: pick(item.patchStatus, PATCH_STATES, 'unknown'),
    product: cleanText(item.product, 200) ?? '',
    stacks: words(item.stacks),
    tags: words(item.tags),
    affected: Array.isArray(item.affectedVersions)
      ? item.affectedVersions
          .map((entry) => cleanText(entry, 400))
          .filter((entry): entry is string => entry !== null)
          .slice(0, MAX_AFFECTED)
      : [],
    startedAt,
    updatedAt: Number.isFinite(updated) ? updated : Date.parse(`${startedAt}T00:00:00.000Z`),
  };
}

/** The incidents of the list, or null when it is not pwn.watch's list or most of it does not fit. */
export function parseFeed(body: string): { incidents: Incident[]; skipped: number } | null {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return null;
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return null;
  const { site, incidents } = root as Record<string, unknown>;
  if (site !== FEED_SITE || !Array.isArray(incidents) || incidents.length > MAX_INCIDENTS)
    return null;
  const seen = new Set<string>();
  const kept: Incident[] = [];
  for (const raw of incidents) {
    const incident = parseIncident(raw);
    if (incident === null || seen.has(incident.slug)) continue;
    seen.add(incident.slug);
    kept.push(incident);
  }
  const skipped = incidents.length - kept.length;
  // An empty list, or one most of which does not fit, is not pwn.watch's list as this reads it.
  if (kept.length === 0 || kept.length * 2 < incidents.length) return null;
  return { incidents: kept, skipped };
}

/** The body, or a problem: past `MAX_BYTES` the download stops. */
async function readBody(response: Response): Promise<string | ThreatProblem> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    return 'too-large';
  }
  if (response.body === null) return 'invalid';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      return 'too-large';
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return 'invalid';
  }
}

export interface FeedSource {
  read(): Promise<FeedRead>;
}

export function createFeedSource({
  fetch: fetchList = globalThis.fetch as Fetch,
  now = () => new Date(),
  clock = () => performance.now(),
  timeoutMs = TIMEOUT_MS,
}: {
  fetch?: Fetch;
  /** The time a copy is stamped with. */
  now?: () => Date;
  /** Milliseconds that only go forward, for how long to wait: a clock set back does not stop refreshes. */
  clock?: () => number;
  timeoutMs?: number;
} = {}): FeedSource {
  let copy: FeedCopy | null = null;
  let problem: ThreatProblem | null = null;
  let checkedAt: number | null = null;
  let failures = 0;
  let pending: Promise<void> | null = null;

  async function download(): Promise<ThreatProblem | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const asked = copy?.etag ?? null;
    try {
      const response = await fetchList(FEED_URL, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'stroq-console',
          ...(asked !== null ? { 'if-none-match': asked } : {}),
        },
      });
      // "Not modified" answers a question that was asked, about the copy that was asked about.
      if (response.status === 304 && copy !== null && asked !== null) {
        await response.body?.cancel().catch(() => {});
        copy = { ...copy, fetchedAt: now() };
        return null;
      }
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        return 'network';
      }
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel().catch(() => {});
        return 'invalid';
      }
      const body = await readBody(response);
      if (body === 'too-large' || body === 'invalid') return body;
      const parsed = parseFeed(body);
      if (parsed === null) return 'invalid';
      // A list less than half the one it would replace has lost most of itself on the way.
      if (copy !== null && parsed.incidents.length * 2 < copy.incidents.length) return 'invalid';
      const etag = response.headers.get('etag');
      copy = {
        incidents: parsed.incidents,
        fetchedAt: now(),
        etag: etag !== null && ETAG.test(etag) ? etag : null,
        skipped: parsed.skipped,
      };
      return null;
    } catch {
      return controller.signal.aborted ? 'timeout' : 'network';
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async read() {
      const wait =
        problem === null ? REFRESH_MS : Math.min(REFRESH_MS, RETRY_MS * 2 ** (failures - 1));
      if (checkedAt === null || clock() - checkedAt >= wait) {
        // Readers at the same moment share one download.
        pending ??= download().then((found) => {
          problem = found;
          failures = found === null ? 0 : failures + 1;
          checkedAt = clock();
          pending = null;
        });
        await pending;
      }
      return { copy, problem };
    },
  };
}
