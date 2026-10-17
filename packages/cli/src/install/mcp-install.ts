import { assertWriteAllowed } from '../harden/atomic.js';
import { confirm, confirmTyped } from '../ui/prompt.js';
import { outsideLine } from '../ui/layout.js';
import { styleFor } from '../ui/style.js';
import { stroqVersion } from '../version.js';
import { readPassports, withPassports, writePassports } from './lock.js';
import type { Receipt } from './lock.js';
import { auditReceipt } from './receipt.js';
import { commitMcpConfig } from './mcp-config-transaction.js';
import { currentEntry, jsonEqual, loadConfig, withServer } from './mcp-client-config.js';
import { prepareMcp, type PreparedMcp } from './mcp-prepare.js';
import {
  nameOf,
  recordOf,
  requirePerson,
  subjectOf,
  type McpInstallOptions,
  type McpRecord,
} from './mcp-record.js';
import { showMcpScreen } from './mcp-screen.js';
import { recordedTarget, targetRules } from './mcp-target.js';
import { collectMcpStore, tidyStore } from './store-gc.js';
import { putStore, readStoredTreeOf } from './store.js';

export { entrypointOf } from '../mcp/entrypoint.js';
export type { McpInstallOptions, McpRecord } from './mcp-record.js';

/** The question: the digest to type when anything but the confirmed state would be written, else a y/N. */
async function confirmed(options: McpInstallOptions, prepared: PreparedMcp): Promise<boolean> {
  return prepared.material
    ? confirmTyped(options.terminal, prepared.digest)
    : confirm(options.terminal, styleFor(options.terminal), 'Nothing changed; re-apply?', false);
}

export async function addMcp(sourceOrName: string, options: McpInstallOptions): Promise<McpRecord> {
  requirePerson(options);
  const initial = await readPassports(options.stroqHome);
  const prepared = await prepareMcp(sourceOrName, options, initial);
  const { name, previous, made, digest, selected, current, written, material } = prepared;
  showMcpScreen(options.terminal, prepared);
  if (!(await confirmed(options, prepared))) throw new Error('not confirmed; nothing was changed');
  const { file, label, root } = selected;
  return withPassports(options.stroqHome, async (lock) => {
    if (!jsonEqual(lock.mcp?.[name], initial.mcp?.[name]))
      throw new Error('the lock changed while confirming; read and confirm again');
    if (previous !== undefined)
      await readStoredTreeOf(options.stroqHome, previous.digest, subjectOf(name, previous));
    await putStore(options.stroqHome, made.tree, digest);
    assertWriteAllowed(file, targetRules(selected));
    const fresh = loadConfig(file);
    if (!jsonEqual(currentEntry(fresh.config, name), current))
      throw new Error('the client config changed while confirming; read and confirm again');
    const receipt: Receipt = {
      v: 1,
      at: new Date().toISOString(),
      name,
      action: options.restore ? 'restore' : previous === undefined ? 'add' : 'update',
      from: previous?.digest ?? null,
      to: digest,
      material,
      confirmed: true,
      stroq: stroqVersion(),
    };
    const record: McpRecord = {
      kind: 'mcp',
      status: 'confirmed',
      digest,
      grant: { pin: `sha256:${digest}` },
      source: prepared.source,
      config: file,
      configRoot: root,
      client: label,
      cwd: prepared.cwd,
      entrypoint: prepared.entrypoint,
      passEnv: prepared.passEnv,
      passport: made.passport,
      written,
      original: prepared.original,
      history: [...prepared.history, receipt],
    };
    const next = { ...lock, mcp: { ...(lock.mcp ?? {}), [name]: record } };
    await commitMcpConfig(
      file,
      withServer(fresh.config, name, written),
      () => writePassports(options.stroqHome, next),
      { ...targetRules(selected), before: fresh.text },
    );
    await auditReceipt(options.stroqHome, receipt, 'mcp');
    if (previous !== undefined)
      await tidyStore(options.terminal, previous.digest, () =>
        collectMcpStore(options.stroqHome, next, previous.digest),
      );
    return record;
  });
}

export async function removeMcp(name: string, options: McpInstallOptions): Promise<void> {
  requirePerson(options);
  nameOf(name);
  const initial = await readPassports(options.stroqHome);
  const previous = recordOf(initial, name);
  if (previous === undefined) throw new Error('the MCP server is not installed');
  // Removing needs the digest from the lock and the entry in the client config, never the stored bytes: a
  // damaged store must not make a server impossible to take out.
  const selected = recordedTarget(previous);
  const { file } = selected;
  assertWriteAllowed(file, targetRules(selected));
  const current = currentEntry(loadConfig(file).config, name);
  const drifted = !jsonEqual(current, previous.written);
  if (drifted && options.force !== true)
    throw new Error(
      'the client config entry changed outside Stroq; it was kept (use --force to remove it)',
    );
  options.terminal.write(
    `Remove MCP server ${name} from ${outsideLine(JSON.stringify(file))}\nPrevious sha256:${previous.digest}\n${previous.original === null ? 'The entry is deleted.' : 'The original entry is restored.'}\n`,
  );
  const yes = await confirm(
    options.terminal,
    styleFor(options.terminal),
    `Remove ${name}${drifted ? ' including outside edits' : ''}?`,
    false,
  );
  if (!yes) throw new Error('removal not confirmed');
  await withPassports(options.stroqHome, async (lock) => {
    if (!jsonEqual(lock.mcp?.[name], initial.mcp?.[name]))
      throw new Error('the lock changed while confirming; read and confirm again');
    assertWriteAllowed(file, targetRules(selected));
    const fresh = loadConfig(file);
    if (!jsonEqual(currentEntry(fresh.config, name), current))
      throw new Error('the client config changed while confirming; read and confirm again');
    const receipt: Receipt = {
      v: 1,
      at: new Date().toISOString(),
      name,
      action: 'remove',
      from: previous.digest,
      to: null,
      material: false,
      confirmed: true,
      stroq: stroqVersion(),
    };
    const rest = {
      ...(lock.mcp ?? {}),
      [name]: { kind: 'mcp', status: 'revoked', history: [...previous.history, receipt] },
    };
    const next = { ...lock, mcp: rest };
    await commitMcpConfig(
      file,
      withServer(fresh.config, name, previous.original ?? undefined),
      () => writePassports(options.stroqHome, next),
      { ...targetRules(selected), before: fresh.text },
    );
    await auditReceipt(options.stroqHome, receipt, 'mcp');
    await tidyStore(options.terminal, previous.digest, () =>
      collectMcpStore(options.stroqHome, next, previous.digest),
    );
  });
}
