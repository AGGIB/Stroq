import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createCodexNetworkCheckService,
  preparation,
  result,
  context,
  workspace,
  sha,
  deferred,
} from './codex-network-check-ownership-fixtures.mjs';

for (const mode of [
  'released-before-poll',
  'release-during-owner-assert',
  'released-before-poll-and-reject',
])
  test('terminal history stays verified: ' + mode, async (t) => {
    let rows = [],
      owned = true,
      blockReadAssert = false;
    const releasing = deferred(),
      finishRelease = deferred(),
      runReady = deferred(),
      finishRun = deferred(),
      readAsserting = deferred(),
      finishReadAssert = deferred();
    const lease = {
      assertCurrent: async () => {
        if (blockReadAssert) {
          blockReadAssert = false;
          readAsserting.resolve();
          await finishReadAssert.promise;
        }
        if (!owned) throw Error('released');
      },
      release: async () => {
        owned = false;
        releasing.resolve();
        await finishRelease.promise;
        if (mode.endsWith('reject')) throw Error('release-failed');
      },
    };
    const store = {
      runs: [],
      state: () => ({ status: 'ready' }),
      prepare: async () => true,
      refresh: async () => structuredClone(rows),
      write: async (value) => {
        rows = structuredClone(value);
        return true;
      },
    };
    const inventory = {
      codexNetworkRuntime: async () => sha,
      codexNetworkOperation: async (op) => ({
        status: 200,
        body:
          op === 'codex-network-state'
            ? { controlContextId: context }
            : structuredClone(preparation),
      }),
    };
    const service = await createCodexNetworkCheckService({
      inventory,
      workspaceId: workspace,
      store,
      acquireLease: async () => lease,
      run: async () => {
        runReady.resolve();
        await finishRun.promise;
        return result();
      },
    });
    t.after(async () => {
      finishRun.resolve();
      finishReadAssert.resolve();
      finishRelease.resolve();
      await service.close();
    });
    const preview = await service.preview({ controlContextId: context, captureSha256: sha });
    assert.equal(preview.status, 200);
    await service.start({ previewId: preview.body.id, controlContextId: context });
    await runReady.promise;
    let reading;
    if (mode === 'release-during-owner-assert') {
      blockReadAssert = true;
      reading = service.read();
      await readAsserting.promise;
    }
    finishRun.resolve();
    await releasing.promise;
    assert.equal(rows[0].status, 'completed');
    assert.equal(rows[0].result.outcome, 'passed');
    finishReadAssert.resolve();
    const during = await (reading ?? service.read());
    assert.equal(during.body.history, 'ready');
    assert.equal(during.body.jobs[0].status, 'completed');
    assert.equal(during.body.ownedJobId, null);
    finishRelease.resolve();
    await service.wait();
    const after = await service.read();
    if (mode.endsWith('reject')) {
      assert.equal(after.body.history, 'unavailable');
      assert.equal(after.body.jobs[0].status, 'failed');
      assert.equal(after.body.jobs[0].result, null);
    } else {
      assert.equal(after.body.history, 'ready');
      assert.equal(after.body.jobs[0].result.outcome, 'passed');
    }
  });
