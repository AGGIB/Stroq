import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

const html = read('index.html');
// The landing page's rules live in home.css and the shared ones in styles.css; the
// checks below hold for both, so they read the two as one.
const cssFiles = ['styles.css', 'home.css'];
const css = cssFiles.map(read).join('\n');
const vercel = JSON.parse(read('vercel.json')) as {
  headers?: { headers?: { key: string; value: string }[] }[];
};

function cspValue(): string {
  for (const rule of vercel.headers ?? []) {
    for (const h of rule.headers ?? []) {
      if (h.key.toLowerCase() === 'content-security-policy') return h.value;
    }
  }
  throw new Error('no Content-Security-Policy in site/vercel.json');
}

describe('the site survives its own Content-Security-Policy', () => {
  // The policy that makes the rest of this file necessary. If 'unsafe-inline' is
  // ever added to style-src, these assertions stop being load-bearing — but adding
  // it to the site of a tool that exists to keep untrusted content from executing
  // is a decision to take deliberately, so the test states the expectation.
  it('serves style-src without unsafe-inline', () => {
    const csp = cspValue();
    expect(csp).toMatch(/style-src[^;]*'self'/);
    expect(csp).not.toMatch(/style-src[^;]*'unsafe-inline'/);
  });

  // This is the bug this file exists for. Under that policy a style="" attribute is
  // dropped, silently: no console error the author will see, and the page still
  // renders. The hero animation shipped for days with every packet frozen at the
  // start of its line, because --dx/--dy/--pd were set in style attributes that
  // production never applied while every local preview did.
  it('has no inline style attribute anywhere in the markup', () => {
    const found = html.match(/style="[^"]*"/g) ?? [];
    expect(found).toEqual([]);
  });

  it('has no inline <style> block either, which the same directive blocks', () => {
    expect(html).not.toMatch(/<style[\s>]/i);
  });

  it('defines every custom property the keyframes read', () => {
    // Each `var(--x)` a keyframe uses must be set by a rule in the stylesheet,
    // because under this policy there is nowhere else left to set it. The list is
    // derived from the CSS rather than written down, so the check keeps holding
    // when the hero animation is replaced — which is exactly when it last broke.
    const keyframes = [...css.matchAll(/@keyframes\s+[\w-]+\s*\{/g)].map((m) => {
      let depth = 0;
      let i = m.index + m[0].length - 1;
      const from = i;
      do {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') depth -= 1;
        i += 1;
      } while (depth > 0 && i < css.length);
      return css.slice(from, i);
    });
    expect(keyframes.length, 'no @keyframes found — did the stylesheet move?').toBeGreaterThan(0);

    const read = new Set<string>();
    for (const block of keyframes) {
      for (const use of block.matchAll(/var\(\s*(--[\w-]+)/g)) read.add(use[1]);
    }
    for (const prop of read) {
      const declared = new RegExp(`${prop}\\s*:`).test(css);
      expect(declared, `${prop} is read by a keyframe but never declared`).toBe(true);
    }
  });

  it('parses as stylesheets with every brace closed', () => {
    for (const file of cssFiles) {
      const text = read(file);
      const opens = (text.match(/\{/g) ?? []).length;
      const closes = (text.match(/\}/g) ?? []).length;
      expect(opens, `${file}: ${opens} "{" but ${closes} "}"`).toBe(closes);
    }
  });

  it('parses as one stylesheet, with every brace closed', () => {
    // An orphaned `}` is not a syntax error the browser reports: CSS error
    // recovery swallows whatever follows it up to the next balanced block, which
    // once ate the first @keyframes of the hero and left its packet frozen at
    // opacity 0 while every other packet moved.
    const opens = (css.match(/\{/g) ?? []).length;
    const closes = (css.match(/\}/g) ?? []).length;
    expect(opens, `${opens} "{" but ${closes} "}"`).toBe(closes);
  });

  it('defines a @keyframes for every animation name a rule uses', () => {
    const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
    const used = [...css.matchAll(/animation:\s*([\w-]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of new Set(used)) {
      if (name === 'none') continue;
      expect(defined.has(name), `animation "${name}" is used but never defined`).toBe(true);
    }
  });

  it('animates only elements the markup actually ships', () => {
    // A rule that animates a class no longer in the HTML is dead motion, and the
    // reverse — markup expecting an animation that was deleted — is a frozen hero.
    // Every class in an animated selector is checked, not only the first, except the
    // state classes a script adds (`js`, `is-*`).
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    let checked = 0;
    for (const [, selector, body] of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(^|[\s;])animation:/.test(body)) continue;
      for (const [, cls] of selector.matchAll(/\.([\w-]+)/g)) {
        if (cls === 'js' || cls.startsWith('is-')) continue;
        checked += 1;
        expect(html, `.${cls} is animated but never used in the markup`).toMatch(
          new RegExp(`class="[^"]*\\b${cls}\\b`),
        );
      }
    }
    expect(checked, 'no animated selector was checked').toBeGreaterThan(0);
  });

  it('declares every custom property any rule reads', () => {
    // Under this policy there is nowhere but the stylesheet to set a variable, so a
    // `var(--x)` with no `--x:` anywhere is a silent fallback to nothing.
    const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(10);
    for (const prop of used) {
      expect(new RegExp(`${prop}\\s*:`).test(css), `${prop} is read but never declared`).toBe(true);
    }
  });

  it('sizes the scoreboard bar in proportion to the tally it prints', () => {
    const labels = [...html.matchAll(/<span class="sc-seg sc-seg-(deny|ask)"><b>(\d+)<\/b>/g)];
    expect(labels).toHaveLength(2);
    for (const [, kind, printed] of labels) {
      const rule = new RegExp(`\\.sc-seg-${kind}\\s*\\{[^}]*flex-grow:\\s*(\\d+)`).exec(css);
      expect(rule, `no flex-grow for .sc-seg-${kind}`).not.toBeNull();
      expect(rule?.[1], `.sc-seg-${kind} is sized ${rule?.[1]} but prints ${printed}`).toBe(printed);
    }
  });
});
