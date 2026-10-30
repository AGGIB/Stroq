import test from 'node:test';
import assert from 'node:assert/strict';
import { networkUI } from './codex-network-ui-harness.mjs';
import * as f from './codex-network-client-fixtures.mjs';
const link = `codexNetwork=history&context=${f.context}&record=${f.id(1)}`;
test('exact record link waits for its data then focuses and centers only that article once', () => {
  const h = networkUI(link, { effects: true });
  h.guard.state = null;
  h.render();
  h.commit();
  assert.equal(h.focused.length, 0);
  h.guard.state = f.state([f.record({ standing: 'changed', canRestore: false })]);
  h.render();
  h.commit();
  assert.deepEqual(h.focused, [{ label: `record:${f.id(1)}`, options: { preventScroll: true } }]);
  assert.deepEqual(h.scrolled, [
    { label: `record:${f.id(1)}`, options: { block: 'center', behavior: 'auto' } },
  ]);
  h.checks.job = f.job('completed');
  h.checks.state = f.checkState([h.checks.job]);
  h.render();
  h.commit();
  assert.equal(h.focused.length, 1, 'late native history must not steal focus');
  assert.equal(h.scrolled.length, 1);
  h.guard.state = f.state([
    f.record({ revision: '8'.repeat(64), standing: 'changed', canRestore: false }),
  ]);
  h.render();
  h.commit();
  assert.equal(h.focused.length, 1, 'refresh of same exact record does not recenter');
});
test('missing and foreign record destinations never focus a substitute or expose its Restore', () => {
  for (const foreign of [false, true]) {
    const h = networkUI(
      foreign ? link.replace(f.context, 'codex-context-' + '9'.repeat(64)) : link,
      { effects: true },
    );
    h.guard.state = f.state(foreign ? [f.record()] : []);
    h.checks.job = f.job('completed');
    const html = h.render();
    h.commit();
    assert.equal(h.focused.length, 0);
    assert.equal(h.scrolled.length, 0);
    assert.doesNotMatch(html, /Preview restore/);
  }
});
test('explicit View check releases record focus and focuses the exact native selection, including running checks', () => {
  const h = networkUI(link, { effects: true });
  h.guard.state = f.state([f.record()]);
  h.checks.job = f.job('completed');
  h.checks.state = f.checkState([f.job()]);
  h.render();
  h.commit();
  assert.equal(h.focused.at(-1)?.label, `record:${f.id(1)}`);
  h.button('View check').props.onClick();
  h.render();
  h.commit();
  assert.equal(h.checks.job.status, 'running');
  assert.equal(h.focused.at(-1)?.label, 'Native profile-copy check');
  assert.equal(h.scrolled.length, 2);
  h.button('View check').props.onClick();
  h.render();
  h.commit();
  assert.equal(
    h.focused.filter((v) => v.label === 'Native profile-copy check').length,
    2,
    'each explicit selection may request focus',
  );
});
test('terminal update of explicitly viewed job never refocuses or moves scroll; repeated View remains intentional', () => {
  const h = networkUI(link, { effects: true });
  h.guard.state = f.state([f.record()]);
  h.checks.state = f.checkState([f.job()]);
  h.render();
  h.commit();
  h.button('View check').props.onClick();
  h.render();
  h.commit();
  assert.equal(h.focused.length, 2);
  assert.deepEqual(h.focused.at(-1)?.options, { preventScroll: true });
  const scrolls = h.scrolled.length;
  h.checks.job = f.job('completed');
  h.checks.state = f.checkState([h.checks.job]);
  h.render();
  h.commit();
  assert.equal(h.focused.length, 2, 'terminal status alone is not navigation');
  assert.equal(h.scrolled.length, scrolls, 'terminal status preserves user scroll');
  h.button('View check').props.onClick();
  h.render();
  h.commit();
  assert.equal(h.focused.length, 3);
  assert.equal(
    h.scrolled.length,
    scrolls + 1,
    'explicit repeated selection may scroll to its heading',
  );
});
test('preview and first running-job navigation still focus without incidental scrolling', () => {
  const h = networkUI('codexNetwork=history', { effects: true });
  h.render();
  h.commit();
  h.checks.preview = f.checkPreview();
  h.render();
  h.commit();
  assert.equal(h.focused.at(-1)?.label, 'Native profile-copy check');
  assert.deepEqual(h.focused.at(-1)?.options, { preventScroll: true });
  h.checks.preview = null;
  h.checks.job = f.job();
  h.checks.state = f.checkState([h.checks.job]);
  h.render();
  h.commit();
  assert.equal(h.focused.length, 2, 'new running job identity is an actual navigation target');
  const count = h.focused.length;
  h.checks.job = f.job('completed');
  h.render();
  h.commit();
  assert.equal(h.focused.length, count);
  assert.equal(h.scrolled.length, 0);
});
test('initial record centering waits for shared history admission and late native layout, then runs once', () => {
  const h = networkUI(link, { effects: true });
  h.guard.state = null;
  h.action.busy = 'load';
  h.render();
  h.commit();
  h.guard.state = f.state([f.record({ standing: 'changed', canRestore: false })]);
  h.action.busy = 'check-load';
  h.render();
  h.commit();
  assert.equal(h.focused.length, 0, 'early guard data does not consume one-shot focus');
  assert.equal(h.scrolled.length, 0);
  h.checks.job = f.job('completed');
  h.checks.state = f.checkState([h.checks.job]);
  h.render();
  h.commit();
  assert.equal(h.focused.length, 0, 'late native card is laid out before centering');
  h.action.busy = null;
  h.render();
  h.commit();
  assert.deepEqual(h.focused, [{ label: `record:${f.id(1)}`, options: { preventScroll: true } }]);
  assert.deepEqual(h.scrolled, [
    { label: `record:${f.id(1)}`, options: { block: 'center', behavior: 'auto' } },
  ]);
  h.action.busy = 'check-load';
  h.render();
  h.commit();
  h.checks.job = { ...f.job('completed'), id: f.id(8) };
  h.action.busy = null;
  h.render();
  h.commit();
  assert.equal(h.focused.length, 1, 'future history refresh must not snap focus again');
  assert.equal(h.scrolled.length, 1);
});
test('record still centers after admission when native history is unavailable', () => {
  const h = networkUI(link, { effects: true });
  h.guard.state = f.state([f.record()]);
  h.action.busy = 'check-load';
  h.checks.state = null;
  h.render();
  h.commit();
  assert.equal(h.scrolled.length, 0);
  h.action.busy = null;
  h.action.error = 'Native check history could not be verified.';
  h.render();
  h.commit();
  assert.equal(h.focused.at(-1)?.label, `record:${f.id(1)}`);
  assert.equal(h.scrolled.length, 1);
});
