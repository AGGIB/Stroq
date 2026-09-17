/* Install count for the landing page.
 *
 * The page's CSP is `connect-src 'self'`, so the browser never talks to
 * npm — this function does, server-side, and hands back one number. That
 * keeps every visitor's IP off a third-party service, which matters more
 * than usual for a security tool.
 *
 * npm's `point` endpoints have been stale for days (they still report the
 * week ending 2026-09-11 while `range` has data through yesterday), so the
 * total is summed from the daily range instead. The package's first
 * publish was 2026-09-04; npm serves at most 18 months per range request,
 * which this is comfortably inside.
 */
const PACKAGE = '@stroq/cli';
const FIRST_PUBLISH = '2026-09-04';
const CACHE_SECONDS = 3600;
const TIMEOUT_MS = 4000;

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function totalDownloads() {
  const url = `https://api.npmjs.org/downloads/range/${FIRST_PUBLISH}:${today()}/${encodeURIComponent(PACKAGE)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`npm responded ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.downloads)) throw new Error('npm returned an unexpected shape');
  return body.downloads.reduce((sum, day) => sum + (Number(day.downloads) || 0), 0);
}

export default async function handler(_req, res) {
  try {
    const installs = await totalDownloads();
    /* Stale-while-revalidate: a visitor never waits on npm, and a slow or
       failing npm keeps serving the last good number for a day. */
    res.setHeader(
      'cache-control',
      `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`,
    );
    res.status(200).json({ installs, since: FIRST_PUBLISH });
  } catch (err) {
    /* The number is decoration; the page is complete without it. Fail
       loudly in the log, quietly on the page.
       `no-store` matters: a cacheable failure is worse than a slow one.
       One bad minute at npm used to be enough for a visitor's browser to
       hold the 503 and skip the count on every reload until it expired. */
    console.error('stats: could not read npm downloads —', err.message);
    res.setHeader('cache-control', 'no-store');
    res.status(503).json({ error: 'upstream unavailable' });
  }
}
