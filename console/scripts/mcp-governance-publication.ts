import { randomUUID } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { rootIdentity, snapshotFile } from './agent-setup-files.mjs';
import { readPolicyState, restorePolicyBytes } from './policy-files.mjs';
import { readPolicyHistory } from './policy-history-files.mjs';
import { parseStrictJson } from '../../packages/core/src/scope/strict-json';
import {
  fail,
  filePin,
  parentsPin,
  publicRecord,
  success,
  unconfirmed,
} from './mcp-governance-service-support';
import {
  validateMcpGovernanceReceipt,
  validateMcpGovernanceRecheck,
  validateMcpGovernanceRecheckRequest,
} from '../lib/mcp-governance';
import type { McpGovernanceIntent, McpGovernanceStoreEntry } from './mcp-governance-store-types';

/** Exact source identity is persisted before the only publication point (atomic rename). */
export function createGovernancePublication(options: any, context: any, signal: AbortSignal) {
  async function historyRef(id: string) {
    const history = await readPolicyHistory(context.home, { parseJson: parseStrictJson });
    const row = history.captured?.get(id)?.row;
    if (history.history.status === 'unavailable' || !row) fail('mcp-governance-store-unavailable');
    return { entryId: row.id, recordSha256: row.recordSha256 };
  }
  async function apply(plan: any) {
    const c = plan.context,
      store = c.store,
      body = plan.body;
    return options.caseStore.withSnapshotLock(
      plan.snapshot,
      async (locked: any, _replace: unknown, metadata: any) =>
        store.withLease({ operationId: body.operationId }, async (lease: any) => {
          await context.bindCreatedHome(c, metadata?.createdHome ?? lease.createdHome);
          await context.assertContext(c, body.binding.captureSha256);
          await context.assertPolicy(c);
          const initial = await store.read();
          if (initial.status === 'unavailable') fail('mcp-governance-store-unavailable');
          const matching = initial.records.filter(
            (r: McpGovernanceStoreEntry) => r.intent.binding.contextId === c.contextId,
          );
          if (!isDeepStrictEqual(unconfirmed(matching), body.unconfirmedRecords))
            fail('mcp-governance-recovery-required');
          const now = new Date(options.now()).toISOString();
          const intent: McpGovernanceIntent = {
            schema: 'stroq-mcp-governance-intent/1',
            id: randomUUID(),
            operationId: body.operationId,
            binding: body.binding,
            createdAt: now,
            updatedAt: now,
            candidateRawSha256: body.candidateRawSha256,
            candidateFingerprint: body.candidateFingerprint,
            beforePolicy: {
              rawSha256: c.policy.rawSha,
              fingerprint: body.binding.policyFingerprint,
              file: filePin(c.policy.capture.file),
              parents: parentsPin(c.policy.capture),
            },
            phase: 'prepared',
            staged: null,
            historyRef: null,
            terminalSource: null,
          };
          let entry = await store.create(intent, lease),
            committed = false;
          const update = async (patch: any) => {
            entry = await store.update(entry.intent.id, entry.revision, patch, lease);
          };
          try {
            const assertCurrent = async () => {
              await lease.assertCurrent();
              await context.assertContext(c, body.binding.captureSha256);
              await options.caseStore.assertSnapshot(locked);
            };
            await assertCurrent();
            await restorePolicyBytes(
              c.policy,
              plan.candidateBytes,
              body.candidateFingerprint,
              options.now(),
              {
                assertCurrent,
                verifySemantic: async (text: string, expected: string) => {
                  const inspection = await options.adapter(
                    'mcp-governance-inspect',
                    text,
                    undefined,
                    { signal },
                  );
                  if (inspection.policyFingerprint !== expected)
                    fail('mcp-governance-write-unconfirmed');
                },
                fault: async (stage: string, details: any) => {
                  if (stage === 'after-backup')
                    await update({ historyRef: await historyRef(details.receiptId) });
                  if (stage === 'before-rename') {
                    if (
                      typeof details.temporary !== 'string' ||
                      dirname(details.temporary) !== context.home ||
                      !/^\.stroq-[a-f0-9-]{36}\.tmp$/.test(basename(details.temporary))
                    )
                      fail('mcp-governance-write-unconfirmed');
                    const snapshot = await snapshotFile(
                      await rootIdentity(context.home),
                      details.temporary,
                      256 * 1024,
                    );
                    if (snapshot.sha256 !== body.candidateRawSha256 || snapshot.file === null)
                      fail('mcp-governance-write-unconfirmed');
                    await update({
                      phase: 'staged',
                      staged: {
                        file: filePin(snapshot.file, true),
                        parents: parentsPin(snapshot),
                        sha256: snapshot.sha256,
                      },
                    });
                  }
                  if (stage === 'after-rename') committed = true;
                  await options.fault?.(stage, details);
                },
              },
            );
            await assertCurrent();
            const current = await readPolicyState(context.home);
            if (!published(entry, current)) fail('mcp-governance-write-unconfirmed');
            await update({ phase: 'applied', terminalSource: 'apply' });
          } catch (error) {
            // No retry or rollback after publication; retain its staged physical proof for explicit Recheck.
            if (!committed) {
              try {
                await update({ phase: 'not-applied', terminalSource: 'apply' });
              } catch {
                /* Preserve unknown durable intent. */
              }
            }
            if (committed || entry.intent.phase !== 'not-applied') {
              const current = await currentOrNull();
              return receipt(body.id, entry, current);
            }
            throw error;
          }
          return receipt(body.id, entry, await currentOrNull());
        }),
    );
  }
  async function currentOrNull() {
    try {
      return await context.load();
    } catch {
      return null;
    }
  }
  function receipt(previewId: string, entry: McpGovernanceStoreEntry, current: any) {
    const record = publicRecord(entry, current);
    const body = {
      schema: 'stroq-mcp-governance-receipt/1',
      previewId,
      operationId: entry.intent.operationId,
      binding: entry.intent.binding,
      completedAt: new Date(options.now()).toISOString(),
      writeConfirmed: record.status === 'applied',
      record,
      hostEnforcement: false,
    };
    if (!validateMcpGovernanceReceipt(body)) fail('mcp-governance-unavailable');
    return success(body);
  }
  async function recheck(input: unknown) {
    if (!validateMcpGovernanceRecheckRequest(input)) fail('mcp-governance-invalid');
    const c = await context.load();
    if (c.contextId !== input.contextId) fail('mcp-governance-stale');
    return c.store.withLease(
      { operationId: input.operationId, explicitRecovery: true },
      async (lease: any) => {
        await context.assertContext(c);
        const state = await c.store.read();
        let entry = state.records.find(
          (r: McpGovernanceStoreEntry) => r.intent.id === input.recordId,
        );
        if (state.status === 'unavailable') fail('mcp-governance-store-unavailable');
        if (
          !entry ||
          entry.revision !== input.recordRevision ||
          entry.intent.operationId !== input.operationId ||
          entry.intent.binding.contextId !== c.contextId ||
          entry.intent.binding.workspaceId !== options.workspaceId
        )
          fail('mcp-governance-stale');
        if (entry.intent.phase === 'prepared') {
          // Under the exclusive writer lease, an unstaged operation could not have reached rename.
          entry = await c.store.update(
            entry.intent.id,
            entry.revision,
            { phase: 'not-applied', terminalSource: 'recheck' },
            lease,
          );
        } else if (entry.intent.phase === 'staged') {
          const policy = await readPolicyState(context.home);
          if (
            published(entry, policy) &&
            c.inspection.policyFingerprint === entry.intent.candidateFingerprint &&
            entry.intent.historyRef
          ) {
            const actualRef = await historyRef(entry.intent.historyRef.entryId);
            if (isDeepStrictEqual(actualRef, entry.intent.historyRef))
              entry = await c.store.update(
                entry.intent.id,
                entry.revision,
                { phase: 'applied', terminalSource: 'recheck' },
                lease,
              );
          }
        }
        const record = publicRecord(entry, await currentOrNull());
        const body = {
          schema: 'stroq-mcp-governance-recheck/1',
          operationId: input.operationId,
          binding: entry.intent.binding,
          checkedAt: new Date(options.now()).toISOString(),
          writeConfirmed: record.status === 'applied',
          record,
          hostEnforcement: false,
        };
        if (!validateMcpGovernanceRecheck(body)) fail('mcp-governance-unavailable');
        return success(body);
      },
    );
  }
  return { apply, recheck };
}
function published(entry: McpGovernanceStoreEntry, policy: any) {
  const stage = entry.intent.staged;
  return (
    stage !== null &&
    policy.rawSha === entry.intent.candidateRawSha256 &&
    stage.sha256 === policy.rawSha &&
    isDeepStrictEqual(stage.file, filePin(policy.capture.file, true)) &&
    isDeepStrictEqual(stage.parents, parentsPin(policy.capture))
  );
}
