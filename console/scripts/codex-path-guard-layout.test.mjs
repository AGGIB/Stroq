import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../app/codex-path-guard.css', import.meta.url), 'utf8');
const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    body = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'))?.[1];
  assert(body, `Missing scoped rule ${selector}`);
  return body;
};
test('scoped sticky header keeps title and 44px Close in one horizontal row', () => {
  const h = rule('.codex-path-dialog .dialog-header'),
    close = rule('.codex-path-dialog .dialog-header > .icon-button');
  assert(/position:\s*sticky/.test(h));
  assert(/flex-direction:\s*row/.test(h));
  assert(/justify-content:\s*space-between/.test(h));
  assert(/min-width:\s*44px/.test(close));
  assert(/min-height:\s*44px/.test(close));
  assert(/flex:\s*0 0 44px/.test(close));
});
test('preset grid uses two desktop columns and one narrow-screen column with readable touch rows', () => {
  const grid = rule('.codex-path-presets'),
    row = rule('.codex-path-preset');
  assert(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/.test(grid));
  assert(/min-height:\s*68px/.test(row));
  assert(
    /@media\s*\(max-width:\s*520px\)[\s\S]*\.codex-path-presets\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(
      css,
    ),
  );
  assert(/font-size:\s*var\(--text-secondary\)/.test(rule('.codex-path-preset-status')));
});
