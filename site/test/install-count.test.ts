import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

const html = read('index.html');
const css = read('styles.css');
const main = read('main.js');
const api = read('api/stats.js');
const vercel = JSON.parse(read('vercel.json')) as {
  headers?: { headers?: { key: string; value: string }[] }[];
};

const csp = (): string => {
  for (const rule of vercel.headers ?? []) {
    for (const h of rule.headers ?? []) {
      if (h.key.toLowerCase() === 'content-security-policy') return h.value;
    }
  }
  throw new Error('no Content-Security-Policy in site/vercel.json');
};

describe('the hero install count', () => {
  // The whole reason the number goes through our own function rather than a
  // fetch to api.npmjs.org: a visitor to a security tool's page should not have
  // their IP handed to a third party to render a decoration. If connect-src ever
  // grows an npm origin, that decision was made — and this test says so.
  it('never requires the browser to reach a third-party origin', () => {
    expect(csp()).toMatch(/connect-src 'self'(;|$)/);
    expect(main).not.toMatch(/api\.npmjs\.org|api\.github\.com/);
  });

  it('reads npm from the server side instead', () => {
    expect(api).toMatch(/api\.npmjs\.org/);
  });

  // npm's `point` endpoints served a week-old number for days in September 2026
  // while `range` stayed current, which is why the total is summed by hand.
  it('sums the daily range rather than trusting a point endpoint', () => {
    expect(api).toMatch(/downloads\/range\//);
    expect(api).not.toMatch(/downloads\/point\//);
  });

  // `hidden` on an inline element is only honoured while no later rule sets
  // `display`. `.hero-installs { display: inline }` overrides it unless the
  // `[hidden]` rule comes after — so a reordering would leak "installs since
  // launch" with no number in front of it, on every page load.
  it('keeps the [hidden] rule after the rule that sets display', () => {
    const shown = css.indexOf('.hero-installs { display: inline; }');
    const hidden = css.indexOf('.hero-installs[hidden]');
    expect(shown).toBeGreaterThan(-1);
    expect(hidden).toBeGreaterThan(shown);
  });

  // The line has to read correctly with the count missing, because a failed
  // fetch is the normal case for anyone with JS off or npm having a bad day.
  it('ships the licence line in the markup, not from JavaScript', () => {
    expect(html).toMatch(/Apache-2\.0 · runs locally · no telemetry/);
    expect(html).toMatch(/data-installs hidden/);
  });

  // A cacheable failure outlives the outage that caused it: a minute of npm
  // trouble would otherwise have every CDN edge serving 503 long after npm
  // recovered, and the count would stay missing for no reason.
  it('never lets a failure be cached', () => {
    const fail = api.slice(api.indexOf('catch (err)'));
    expect(fail).toMatch(/cache-control['"],\s*['"]no-store/);
    expect(fail).not.toMatch(/s-maxage/);
  });

  it('starts hidden so a failed fetch shifts nothing', () => {
    const el = html.match(/<span class="hero-installs"[^>]*>/)?.[0] ?? '';
    expect(el).toMatch(/\bhidden\b/);
  });
});
