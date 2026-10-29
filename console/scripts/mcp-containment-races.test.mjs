import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, config, preview, apply, vault } from './mcp-containment-test-helpers.mjs';

async function untilPhase(path, phase) {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      if (JSON.parse(await readFile(path, 'utf8')).phase === phase) return;
    } catch {
      /* Wait for durable fixture phase. */
    }
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail('expected final fixture phase');
}
for (const action of ['remove-registration', 'restore-registration']) {
  test(`a late sibling edit during ${action} cannot receive a receipt for different bytes`, async (t) => {
    const f = await fixture(t),
      installed = await config(f);
    let recordId;
    if (action === 'restore-registration') {
      const removed = await apply(f.containment, (await preview(f.containment, installed)).body);
      assert.equal(removed.status, 200);
      recordId = removed.body.recordId;
    }
    const writer = f.service({ fault: 'pause-before-final-evidence' });
    const p =
      action === 'remove-registration'
        ? await preview(writer, installed)
        : await writer.preview({ action, recordId });
    assert.equal(p.status, 200);
    recordId = p.body.recordId;
    const applying = apply(writer, p.body);
    await untilPhase(
      join(vault(f, recordId), 'manifest.json'),
      action === 'remove-registration' ? 'removed' : 'restored',
    );
    const current = JSON.parse(await readFile(installed.file, 'utf8'));
    current.lateSibling = 'preserve-external-editor';
    const external = JSON.stringify(current, null, 2) + '\n';
    await writeFile(installed.file, external);
    const result = await applying;
    assert.equal(result.status, 422);
    assert.equal(result.body.error, 'mcp-containment-recovery-required');
    assert.equal(await readFile(installed.file, 'utf8'), external);
  });
}
