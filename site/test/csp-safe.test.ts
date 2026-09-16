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
    // because there is nowhere else left to set it.
    for (const prop of ['--dx', '--dy', '--pd']) {
      const declared = new RegExp(`${prop}\\s*:`).test(css);
      expect(declared, `${prop} is read by a keyframe but never declared`).toBe(true);
    }
    for (const cls of ['hs-pk-r1', 'hs-pk-r2', 'hs-pk-r3', 'hs-pk-r4', 'hs-pk-r5']) {
      expect(html, `${cls} is styled but not used`).toContain(cls);
      expect(css, `${cls} is used but not styled`).toContain(`.${cls}`);
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
