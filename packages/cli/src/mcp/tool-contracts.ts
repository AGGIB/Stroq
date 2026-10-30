import { join } from 'node:path';
import {
  contractDirectory,
  contractDirectoryIdentity,
  contractFiles,
  contractLock,
  canonicalContractPath,
  readContractFile,
  writeContractFile,
  type ContractFile,
} from './tool-contract-files.js';
import {
  contractError,
  TOOL_CONTRACT_ERRORS,
  TOOL_CONTRACT_LIMITS as LIMIT,
  type ToolContractBinding,
  type ToolContractDecisionRequest,
  type ToolContractRecord,
  type ToolContractSnapshot,
} from './tool-contract-types.js';
import { contractDecisionRequest, contractHash, contractId } from './tool-contract-canonical.js';
import {
  boundContractCapture,
  decodeContractRecord,
  encodeContractRecord,
} from './tool-contract-record.js';
import {
  validateToolContractBinding,
  assertToolContractWorkspace,
} from './tool-contract-binding.js';
import { hashToolContractRuntime } from './tool-contract-runtime.js';
import { createContractSequences } from './tool-contract-sequence.js';
import { ensureStateMacKeySync, readStateMacKeySync } from '../state-mac.js';

export * from './tool-contract-types.js';
export {
  createMcpToolContractBinding,
  type ToolContractBindingInput,
} from './tool-contract-binding.js';
export { canonicalizeToolsList, parseToolContractJson } from './tool-contract-canonical.js';
export { boundContractCapture } from './tool-contract-record.js';

export interface McpToolContractsStoreOptions {
  readonly home: string;
  readonly now?: () => Date;
  readonly lockTimeoutMs?: number;
}
interface Loaded {
  readonly record: ToolContractRecord;
  readonly file: ContractFile;
}
/** A record file. `record` is null for one written before records were signed: it counts as absent. */
interface Found {
  readonly id: string;
  readonly record: ToolContractRecord | null;
  readonly file: ContractFile;
}
const verified = (v: Found | null): Loaded | null =>
  v?.record ? { record: v.record, file: v.file } : null;
/**
 * A single atomic private record per binding is both observation and decision authority. Each is
 * signed under the home's state key (`tool-contract-record.ts`): one rewritten without the key is
 * refused, never approved and never overwritten.
 */
export function createMcpToolContractsStore(options: McpToolContractsStoreOptions) {
  const now = options.now ?? (() => new Date());
  const timeout = Math.min(3000, Math.max(1, options.lockTimeoutMs ?? 3000));
  let homePromise: Promise<string> | undefined;
  const selectedHome = (): Promise<string> => (homePromise ??= canonicalContractPath(options.home));
  const timestamp = (): string => {
    const d = now();
    if (!Number.isFinite(d.getTime())) return contractError('tool-contract-invalid');
    return d.toISOString();
  };
  async function fixed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Error && TOOL_CONTRACT_ERRORS.some((code) => code === e.message)) throw e;
      return contractError('tool-contract-unavailable');
    }
  }
  async function context(binding?: ToolContractBinding): Promise<string> {
    const home = await selectedHome();
    if (binding && (!validateToolContractBinding(binding) || binding.home !== home))
      contractError('tool-contract-stale');
    if (binding) await assertToolContractWorkspace(binding);
    return home;
  }
  async function assertCurrent(binding: ToolContractBinding): Promise<void> {
    if ((await hashToolContractRuntime(binding.runtime.entry)) !== binding.runtime.sha256)
      contractError('tool-contract-stale');
    await assertToolContractWorkspace(binding);
  }
  // Per binding, the newest record this store has accepted: an older one put back is refused.
  const sequences = createContractSequences();
  /** `key` is the home's state key, or null when it has none (then any signed record is refused). */
  async function load(directory: string, id: string, key: Buffer | null): Promise<Found | null> {
    if (!contractId(id)) contractError('tool-contract-invalid');
    const file = await readContractFile(join(directory, id + '.json'));
    if (!file) return null;
    const record = decodeContractRecord(file.bytes, key);
    if (record && (record.binding.id !== id || record.binding.home !== (await selectedHome())))
      contractError('tool-contract-invalid');
    if (record) sequences.accept(record);
    return { id, record, file };
  }
  const snapshot = (v: Loaded): ToolContractSnapshot => ({ ...v.record, revision: v.file.sha256 });
  async function all(directory: string, key: Buffer | null): Promise<Found[]> {
    const files = await contractFiles(directory);
    let bytes = 0;
    const result: Found[] = [];
    for (const name of files) {
      const file = await readContractFile(
        join(directory, name),
        Math.min(LIMIT.recordBytes, LIMIT.totalBytes - bytes),
      );
      if (!file) contractError('tool-contract-stale');
      bytes += file.bytes.length;
      const record = decodeContractRecord(file.bytes, key);
      if (
        record &&
        (name !== record.binding.id + '.json' || record.binding.home !== (await selectedHome()))
      )
        contractError('tool-contract-invalid');
      if (record) sequences.accept(record);
      result.push({ id: name.slice(0, -'.json'.length), record, file });
    }
    return result;
  }
  async function save(
    home: string,
    directory: string,
    record: ToolContractRecord,
    before: ContractFile | null,
    beforeCommit?: () => Promise<void>,
  ): Promise<ToolContractSnapshot> {
    // Every record is checked under the key that exists before one is made, so a home whose key
    // went missing does not get a new key over signed records that nothing could check any more.
    const existing = readStateMacKeySync(home);
    const records = await all(directory, existing);
    const key = existing ?? ensureStateMacKeySync(home);
    if (!before && records.length >= LIMIT.bindings) contractError('tool-contract-limit');
    const bytes = encodeContractRecord({ ...record, sequence: sequences.next(record) }, key);
    // Validate the exact serialized representation BEFORE publishing; no failed decoder may
    // leave a record which this same authority reader cannot subsequently understand.
    const checked = decodeContractRecord(bytes, key);
    if (!checked) return contractError('tool-contract-invalid');
    if (
      records.reduce(
        (sum, r) => sum + (r.id === record.binding.id ? 0 : r.file.bytes.length),
        bytes.length,
      ) > LIMIT.totalBytes
    )
      contractError('tool-contract-limit');
    const file = await writeContractFile(
      home,
      join(directory, record.binding.id + '.json'),
      bytes,
      before,
      beforeCommit,
    );
    sequences.accept(checked);
    return snapshot({ record: checked, file });
  }
  async function read(binding: ToolContractBinding): Promise<ToolContractSnapshot | null> {
    return fixed(async () => {
      const home = await context(binding);
      const directory = await contractDirectory(home, false);
      if (!directory) return null;
      const identity = await contractDirectoryIdentity(home);
      const v = verified(await load(directory, binding.id, readStateMacKeySync(home)));
      if ((await contractDirectoryIdentity(home)) !== identity)
        contractError('tool-contract-stale');
      return v ? snapshot(v) : null;
    });
  }
  async function list(
    input: { readonly cwd?: string } = {},
  ): Promise<{ records: ToolContractSnapshot[]; limited: false }> {
    return fixed(async () => {
      const home = await context();
      const directory = await contractDirectory(home, false);
      if (!directory) return { records: [], limited: false };
      const identity = await contractDirectoryIdentity(home);
      const cwd = input.cwd === undefined ? null : await canonicalContractPath(input.cwd);
      const records = (await all(directory, readStateMacKeySync(home))).flatMap((found) => {
        const v = verified(found);
        return v && (cwd === null || v.record.binding.cwd === cwd) ? [snapshot(v)] : [];
      });
      if ((await contractDirectoryIdentity(home)) !== identity)
        contractError('tool-contract-stale');
      return { records, limited: false };
    });
  }
  async function observe(
    binding: ToolContractBinding,
    value: unknown,
  ): Promise<ToolContractSnapshot> {
    return fixed(async () => {
      const home = await context(binding);
      const capture = boundContractCapture(binding, value);
      const result = await contractLock(
        home,
        true,
        async (directory) => {
          await context(binding);
          await assertCurrent(binding);
          const found = await load(directory, binding.id, readStateMacKeySync(home));
          const before = verified(found);
          if (
            before?.record.observation === 'complete' &&
            before.record.capture?.sha256 === capture.sha256
          )
            return snapshot(before);
          return save(
            home,
            directory,
            {
              schema: 'stroq-mcp-tool-contracts/3',
              sequence: before?.record.sequence ?? 0,
              binding,
              observedAt: timestamp(),
              observation: 'complete',
              capture,
              approvals: before?.record.approvals ?? [],
              history: before?.record.history ?? [],
              approvedBaselines: before?.record.approvedBaselines ?? [],
            },
            found?.file ?? null,
          );
        },
        timeout,
      );
      if (!result) return contractError('tool-contract-unavailable');
      return result;
    });
  }
  async function invalidate(binding: ToolContractBinding, _reason?: string): Promise<void> {
    return fixed(async () => {
      const home = await context(binding);
      await contractLock(
        home,
        true,
        async (directory) => {
          await context(binding);
          const found = await load(directory, binding.id, readStateMacKeySync(home));
          const before = verified(found);
          if (before?.record.observation === 'invalidated') return;
          await save(
            home,
            directory,
            before
              ? { ...before.record, observation: 'invalidated', observedAt: timestamp() }
              : {
                  schema: 'stroq-mcp-tool-contracts/3',
                  sequence: 0,
                  binding,
                  observedAt: timestamp(),
                  observation: 'invalidated',
                  capture: null,
                  approvals: [],
                  history: [],
                  approvedBaselines: [],
                },
            found?.file ?? null,
          );
        },
        timeout,
      );
    });
  }
  async function decide(
    input: ToolContractDecisionRequest,
    guards: { readonly beforeCommit?: () => Promise<void> } = {},
  ): Promise<ToolContractSnapshot> {
    return fixed(async () => {
      if (!contractDecisionRequest(input)) contractError('tool-contract-invalid');
      const home = await context();
      const result = await contractLock(
        home,
        false,
        async (directory) => {
          // A record from before signing counts as absent: there is nothing to decide on.
          const before = verified(
            await load(directory, input.bindingId, readStateMacKeySync(home)),
          );
          if (
            !before ||
            before.file.sha256 !== input.expectedRevision ||
            before.record.observation !== 'complete' ||
            before.record.capture?.sha256 !== input.expectedCaptureSha256
          )
            contractError('tool-contract-stale');
          await context(before.record.binding);
          await assertCurrent(before.record.binding);
          const tool = before.record.capture.tools.find(
            (t) => t.id === input.toolId && t.sha256 === input.expectedContractSha256,
          );
          if (!tool) contractError('tool-contract-stale');
          const approved = input.action === 'approve';
          const existing = before.record.approvals.find((a) => a.toolId === tool.id);
          if (existing?.approved === approved && existing.contractSha256 === tool.sha256)
            return snapshot(before);
          if (before.record.history.length >= LIMIT.history) contractError('tool-contract-limit');
          const at = timestamp();
          const approvals = [
            ...before.record.approvals.filter((a) => a.toolId !== tool.id),
            { toolId: tool.id, contractSha256: tool.sha256, approved, decidedAt: at },
          ];
          if (approvals.length > LIMIT.tools) contractError('tool-contract-limit');
          return save(
            home,
            directory,
            {
              ...before.record,
              approvals,
              approvedBaselines: approved
                ? [
                    ...before.record.approvedBaselines.filter((a) => a.toolId !== tool.id),
                    {
                      toolId: tool.id,
                      contractSha256: tool.sha256,
                      decidedAt: at,
                      contract: tool.contract,
                    },
                  ]
                : before.record.approvedBaselines,
              history: [
                ...before.record.history,
                { action: input.action, toolId: tool.id, contractSha256: tool.sha256, at },
              ],
            },
            before.file,
            guards.beforeCommit,
          );
        },
        timeout,
      );
      if (!result) return contractError('tool-contract-stale');
      return result;
    });
  }
  async function withApproved(
    binding: ToolContractBinding,
    captureSha256: string,
    rawToolName: string | null,
    callback: () => void,
  ): Promise<boolean> {
    return fixed(async () => {
      const home = await context(binding);
      if (!contractHash(captureSha256) || (rawToolName !== null && typeof rawToolName !== 'string'))
        contractError('tool-contract-invalid');
      const result = await contractLock(
        home,
        false,
        async (directory) => {
          await context(binding);
          const identity = await contractDirectoryIdentity(home);
          const v = verified(await load(directory, binding.id, readStateMacKeySync(home)));
          if (
            !v ||
            v.record.observation !== 'complete' ||
            v.record.capture?.sha256 !== captureSha256
          )
            return false;
          const tools =
            rawToolName === null
              ? v.record.capture.tools
              : v.record.capture.tools.filter((t) => t.name === rawToolName);
          if (rawToolName !== null && tools.length !== 1) return false;
          if (
            !tools.every((t) =>
              v.record.approvals.some(
                (a) => a.toolId === t.id && a.contractSha256 === t.sha256 && a.approved,
              ),
            )
          )
            return false;
          await assertCurrent(binding);
          if ((await contractDirectoryIdentity(home)) !== identity)
            contractError('tool-contract-stale');
          // The caller must perform its synchronous stdin.write here. Never await stream drain under this lock.
          const returned: unknown = callback();
          if (returned && typeof (returned as { then?: unknown }).then === 'function')
            contractError('tool-contract-invalid');
          return true;
        },
        timeout,
      );
      return result ?? false;
    });
  }
  return { read, list, observe, invalidate, decide, withApproved };
}
