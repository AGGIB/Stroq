import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

const html = read('index.html');
const css = read('styles.css');
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

  it('animates only elements the markup actually ships', () => {
    // A rule that animates a class no longer in the HTML is dead motion, and the
    // reverse — markup expecting an animation that was deleted — is a frozen hero.
    const animated = [...css.matchAll(/^\s*\.([\w-]+)[^{\n]*\{[^}]*animation:/gm)].map(
      (m) => m[1],
    );
    for (const cls of new Set(animated)) {
      expect(html, `.${cls} is animated but never used in the markup`).toContain(cls);
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
