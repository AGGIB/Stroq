import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

const html = read('index.html');
const css = read('styles.css') + '\n' + read('home.css');

// The landing page keeps its 36 incidents in one hand-written list. Everything
// else on the page (the tile wall, the effect chart, the provenance strip, the
// headline) is a view of that list, so the tests derive each view from the list
// and fail when a number is edited in one place only.

interface Incident {
  n: string;
  verdict: 'deny' | 'ask';
  effect: string;
  source: 'reported' | 'modelled' | 'own';
}

const ROW =
  /<li id="atk-(\d\d)" class="atk atk-(deny|ask)" data-effect="([^"]+)" data-source="(reported|modelled|own)">/g;

const incidents: Incident[] = [...html.matchAll(ROW)].map((m) => ({
  n: m[1],
  verdict: m[2] as Incident['verdict'],
  effect: m[3],
  source: m[4] as Incident['source'],
}));

const EFFECTS: Record<string, [blocked: number, asked: number]> = {
  'code execution': [7, 3],
  'credential theft': [7, 2],
  'data loss': [0, 10],
  persistence: [1, 3],
  'guard removal': [2, 0],
  'memory poisoning': [0, 1],
};

const countBy = (pick: (i: Incident) => string) => {
  const out: Record<string, number> = {};
  for (const i of incidents) out[pick(i)] = (out[pick(i)] ?? 0) + 1;
  return out;
};

describe('the 36 incidents', () => {
  it('lists exactly 36, numbered 01 to 36 with no gaps', () => {
    // The rows sit in groups by effect, so document order is not numeric order.
    expect(incidents.map((i) => i.n).sort()).toEqual(
      Array.from({ length: 36 }, (_, k) => String(k + 1).padStart(2, '0')),
    );
  });

  it('blocks 17 and asks 19, which is what the headline and the bar print', () => {
    const tally = countBy((i) => i.verdict);
    expect(tally).toEqual({ deny: 17, ask: 19 });
    expect(html).toMatch(/<h2 id="score-title">36 attacks replayed\./);
    expect(html).toContain('<span class="hi-deny">17 blocked</span>');
    expect(html).toContain('<span class="hi-ask">19 asked</span>');
  });

  it('groups them by effect with the counts the chart claims', () => {
    for (const [effect, [blocked, asked]] of Object.entries(EFFECTS)) {
      const rows = incidents.filter((i) => i.effect === effect);
      expect(rows.filter((i) => i.verdict === 'deny'), `${effect} blocked`).toHaveLength(blocked);
      expect(rows.filter((i) => i.verdict === 'ask'), `${effect} asked`).toHaveLength(asked);
    }
    expect(Object.keys(countBy((i) => i.effect)).sort()).toEqual(Object.keys(EFFECTS).sort());
  });

  it('draws one unit-chart row per effect, with the same two numbers as the list', () => {
    const rows = [
      ...html.matchAll(/<li class="unit-row" data-effect="([^"]+)" data-deny="(\d+)" data-ask="(\d+)">/g),
    ];
    expect(rows).toHaveLength(Object.keys(EFFECTS).length);
    for (const [, effect, deny, ask] of rows) {
      const mine = incidents.filter((i) => i.effect === effect);
      expect(Number(deny), `${effect} blocked`).toBe(mine.filter((i) => i.verdict === 'deny').length);
      expect(Number(ask), `${effect} asked`).toBe(mine.filter((i) => i.verdict === 'ask').length);
    }
  });

  it('prints a group header count that matches the rows inside the group', () => {
    const groups = [
      ...html.matchAll(
        /<details class="grp" data-effect="([^"]+)">\s*<summary>[\s\S]*?<span class="grp-n">(\d+)<\/span>/g,
      ),
    ];
    expect(groups).toHaveLength(Object.keys(EFFECTS).length);
    for (const [, effect, printed] of groups) {
      expect(Number(printed), effect).toBe(incidents.filter((i) => i.effect === effect).length);
    }
  });

  it('draws one tile per incident, pointing at its row', () => {
    const tiles = [
      ...html.matchAll(/<button class="tile tile-(deny|ask)" type="button" data-for="atk-(\d\d)"/g),
    ];
    expect(tiles).toHaveLength(36);
    for (const [, verdict, n] of tiles) {
      const row = incidents.find((i) => i.n === n);
      expect(row, `tile ${n} has no row`).toBeDefined();
      expect(verdict, `tile ${n}`).toBe(row?.verdict);
    }
  });

  it('makes the wall a radio group of 36 buttons, one per incident', () => {
    expect(html).toMatch(/<div class="wall"[^>]*role="radiogroup"/);
    expect(html.match(/<button class="tile [^>]*role="radio"/g) ?? []).toHaveLength(36);
    expect(html).not.toMatch(/aria-pressed/);
    expect(html).toMatch(/<div class="viewer" id="viewer" role="region" aria-label="[^"]+">/);
  });

  it('keeps the provenance strip in step with the rows: 20 reported, 6 modelled, 10 ours', () => {
    expect(countBy((i) => i.source)).toEqual({ reported: 20, modelled: 6, own: 10 });
    for (const [kind, n] of [['reported', 20], ['modelled', 6], ['own', 10]] as const) {
      expect(html, kind).toContain(`<span class="prov-n" data-kind="${kind}">${n}</span>`);
    }
  });

  it('draws the 25 x 20 evasion matrix to the size its caption prints', () => {
    const pattern = /<pattern id="held" width="(\d+)" height="(\d+)"/.exec(html);
    const field = /<rect class="matrix-field" width="(\d+)" height="(\d+)"/.exec(html);
    expect(pattern, 'no matrix pattern').not.toBeNull();
    expect(field, 'no matrix field').not.toBeNull();
    const columns = Number(field?.[1]) / Number(pattern?.[1]);
    const rows = Number(field?.[2]) / Number(pattern?.[2]);
    expect([columns, rows]).toEqual([25, 20]);
    expect(columns * rows).toBe(500);
    expect(html).toMatch(/20 scenarios[^<]*25 evasions[^<]*500/);
  });
});

describe('the list is the source of truth for the corpus', () => {
  const corpus = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../packages/cli/src/attack/scenarios/corpus.json', import.meta.url),
      ),
      'utf8',
    ),
  ) as { id: string; effect: string }[];
  // Scenario 13 is generated at load time (a 2 MiB fixture), not stored in the JSON.
  const ids = new Set([...corpus.map((s) => s.id.slice(0, 2)), '13']);

  it('has a row for every scenario the CLI replays, and no extra', () => {
    expect([...ids].sort()).toEqual(incidents.map((i) => i.n).sort());
  });

  it('gives each scenario the verdict the corpus expects of its last step', () => {
    const full = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL('../../packages/cli/src/attack/scenarios/corpus.json', import.meta.url),
        ),
        'utf8',
      ),
    ) as { id: string; steps: { expect: string }[] }[];
    for (const s of full) {
      const last = s.steps[s.steps.length - 1].expect;
      const row = incidents.find((i) => i.n === s.id.slice(0, 2));
      expect(row?.verdict, `${s.id} expects ${last}`).toBe(last);
    }
    // Scenario 13 is generated at load time (a 2 MiB fixture) and is denied.
    expect(incidents.find((i) => i.n === '13')?.verdict).toBe('deny');
  });

  it('labels each effect the way the corpus classifies it', () => {
    const label: Record<string, string[]> = {
      exec: ['code execution'],
      'credential-exfil': ['credential theft'],
      'self-tamper': ['guard removal'],
      'policy-weakening': ['guard removal'],
      destructive: ['data loss'],
      'data-poisoning': ['memory poisoning'],
      // Persistence through a supply chain is shown as either, depending on what ran.
      'supply-chain-persistence': ['persistence', 'code execution'],
    };
    for (const s of corpus) {
      const row = incidents.find((i) => i.n === s.id.slice(0, 2));
      expect(label[s.effect], `${s.id}: unknown corpus effect ${s.effect}`).toBeDefined();
      expect(label[s.effect], `${s.id}`).toContain(row?.effect);
    }
  });
});

describe('main.js and the markup agree', () => {
  it('has every part of a row that the viewer and tile names read, in every row', () => {
    const rows = html.split('<li id="atk-').slice(1).map((r) => r.slice(0, r.indexOf('</li>')));
    expect(rows).toHaveLength(36);
    for (const row of rows) {
      for (const part of ['class="atk-n"', 'class="chip ', 'class="atk-src', 'class="atk-what"']) {
        expect(row, `a row lacks ${part}: main.js would stop at it`).toContain(part);
      }
    }
  });

  it('finds every element it looks up', () => {
    const main = read('main.js');
    const wanted: [script: string, markup: RegExp][] = [
      ["getElementById('viewer')", /id="viewer"/],
      ["getElementById('all-incidents')", /id="all-incidents"/],
      ["getElementById('live-status')", /id="live-status"/],
      ["'[data-expand-all]'", /data-expand-all/],
      ["'[data-nav-install]'", /data-nav-install/],
      ["'[data-installs]'", /data-installs/],
      ["'.hero-installs-n'", /class="hero-installs-n"/],
      ["'.hero .install-pill'", /hero-grid"[\s\S]*class="install-pill"/],
      ["'.nav-toggle'", /class="nav-toggle"/],
      ["'.wall'", /class="wall"/],
      ["'[data-draw]'", /data-draw/],
    ];
    for (const [script, markup] of wanted) {
      expect(main, `main.js no longer mentions ${script}`).toContain(script);
      expect(html, `the markup has nothing for ${script}`).toMatch(markup);
    }
  });
});

describe('the page stays short and readable', () => {
  // Words a visitor reads before opening anything: markup, scripts, the icon
  // sprite, SVG titles and everything inside a closed <details> body removed.
  function visibleWords(): number {
    let page = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    page = page.replace(/<!--[\s\S]*?-->/g, ' ');
    // <main> carries no script of its own (they are in <head> and after </main>);
    // say so rather than strip them with a pattern that can never match every end tag.
    expect(page, 'a <script> inside <main> would be counted as words').not.toMatch(/<script/i);
    page = page.replace(/<svg[\s\S]*?<\/svg[^>]*>/gi, ' ');
    // Keep a <details>' own <summary>; drop what sits behind it. Innermost first, so
    // a closed group inside a closed list is removed before the list's own body is.
    const innermost = /(<details\b[^>]*>\s*<summary[\s\S]*?<\/summary>)(?:(?!<details\b)[\s\S])*?<\/details>/g;
    for (let before = ''; before !== page; ) {
      before = page;
      page = page.replace(innermost, '$1');
    }
    const text = page.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ');
    return text.split(/\s+/).filter(Boolean).length;
  }

  it('shows at most 1,000 words before anything is opened (it was 2,463)', () => {
    expect(visibleWords()).toBeLessThanOrEqual(1000);
  });

  it('ships every <details> closed', () => {
    const opened = html.match(/<details\b[^>]*\bopen\b/g) ?? [];
    expect(opened).toEqual([]);
  });

  it('has the long list inside a <details>, not open on the page', () => {
    const start = html.indexOf('<details class="all"');
    const firstRow = html.indexOf('<li id="atk-01"');
    expect(start, 'no <details class="all"> wrapper').toBeGreaterThan(-1);
    expect(firstRow).toBeGreaterThan(start);
  });
});

describe('content is visible without scripts or scroll', () => {
  it('has no scroll-reveal hook left in the markup or the stylesheets', () => {
    expect(html).not.toMatch(/class="[^"]*\breveal\b/);
    expect(css).not.toMatch(/\.reveal\b/);
  });

  it('hides the thread only when a script will draw it', () => {
    const hidden = [...css.matchAll(/([^{}]*)\{[^{}]*stroke-dashoffset:\s*1\b[^{}]*\}/g)];
    expect(hidden.length, 'no hidden thread rule found: was the stylesheet reformatted?').toBeGreaterThan(0);
    for (const [, selector] of hidden) {
      expect(selector, 'a hidden thread must be gated on .js').toMatch(/\.js\b/);
    }
  });

  it('gates every other starting state that hides content on a script', () => {
    // Anything that starts invisible or collapsed (opacity 0, scale 0, visibility
    // hidden) must sit under .js, so a visitor without the script sees it. Keyframe
    // steps are not starting states, and the focus-visibility rule below is not one.
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let seen = 0;
    for (const [, selector, body] of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = selector.trim();
      if (/^(from|to|\d+%)$/.test(sel)) continue;
      // Pseudo-element decorations (a hover underline, the header's progress hairline,
      // which a CSS scroll timeline drives with no script) carry no content.
      if (/::(before|after)$/.test(sel)) continue;
      if (!/(opacity:\s*0\s*[;}]|opacity:\s*0$|scale[XY]\(0\)|visibility:\s*hidden)/.test(body)) continue;
      seen += 1;
      expect(sel, `"${sel}" hides content and is not gated on .js`).toMatch(/\.js\b/);
    }
    expect(seen, 'found no hidden starting state at all: did the matcher break?').toBeGreaterThanOrEqual(3);
  });

  it('shows the wall only once its script has finished, and the list stays the fallback', () => {
    expect(css).toMatch(/\.wall-grid\s*\{\s*display:\s*none;?\s*\}/);
    expect(css).toMatch(/\.js-ready\s+\.wall-grid\s*\{\s*display:\s*grid;?\s*\}/);
    expect(read('main.js')).toContain("classList.add('js-ready')");
  });

  it('links to sections that exist', () => {
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(4);
    for (const id of hrefs) expect(ids.has(id), `#${id} is linked but never defined`).toBe(true);
  });
});

describe('one type system across the site', () => {
  const pages = ['index.html', 'docs/index.html', 'session-secret-scan/index.html'];
  const fontLink = (page: string) =>
    /<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com\/css2[^"]+)">/.exec(
      read(page),
    )?.[1];

  it('loads the same fonts everywhere, and not Space Grotesk', () => {
    const links = pages.map(fontLink);
    for (const link of links) expect(link, 'a page has no font link').toBeDefined();
    expect(new Set(links).size).toBe(1);
    expect(links[0]).not.toMatch(/Space\+Grotesk/);
  });

  it('does not name Space Grotesk in a stylesheet either', () => {
    expect(css).not.toMatch(/Space Grotesk/);
    expect(read('docs/docs.css')).not.toMatch(/Space Grotesk/);
  });
});
