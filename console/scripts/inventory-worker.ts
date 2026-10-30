import { runCodexNetworkGuardOperation } from './codex-network-guard-operations.ts';
import { CODEX_NETWORK_GUARD_ERRORS } from '../lib/codex-network-guard.ts';
import { runCodexPathGuardOperation } from './codex-path-guard-operations.ts';
import { CODEX_PATH_GUARD_ERRORS } from '../lib/codex-path-guard.ts';
import { skillLocation, type SkillLocation } from '../lib/skill-location.ts';
import type { InventoryQuarantineReason } from '../lib/inventory.ts';
import { quarantineEligibility } from './skill-quarantine-source.ts';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { loadBundledRules, scanContent } from '@stroq/core';
import { readDirTree, READ_DIR_BLIND_SPOTS } from '../../packages/cli/src/install/read-dir.ts';
import {
  inspectTree,
  INSPECT_RULES_ID,
  passportIsIncomplete,
} from '../../packages/cli/src/install/inspect/index.ts';
import { treeDigest } from '../../packages/cli/src/install/tree.ts';
import { isDeepStrictEqual } from 'node:util';
import { validateInventoryEvidence } from '../lib/inventory-evidence.ts';
import {
  deriveInventoryChanges,
  INVENTORY_COMPARISON_LIMITATIONS,
} from '../lib/inventory-changes.ts';
import {
  assertInventoryBaseline,
  inventoryMeta,
  readInventoryBaseline,
  writeInventoryBaseline,
  type InventoryBaseline,
  type InventoryStored,
} from './inventory-baseline.ts';
import { safeLocation } from './inventory-safe.mjs';
import {
  inspectInventoryEvidence,
  inventoryEngineProfile,
  safeInventoryName,
} from './inventory-evidence.ts';
import type { InventoryEvidence } from '../lib/inventory-evidence.ts';
import type {
  InventorySignalProjection,
  InventorySignalBinding,
} from '../lib/inventory-signal-decision.ts';
import {
  inventorySignalAnalysis,
  inventorySignalSource,
  validSignalSha,
} from './inventory-signal-binding.ts';
import {
  inventorySignalCatalog,
  runInventorySignalOperation,
  signalProjection,
  type CompactSignalBinding,
} from './inventory-signal-engine.ts';
import type { SkillSourceId } from '../lib/skill-sources.ts';
import { discoverSkillArtifacts, skillArtifactMeta, skillSourcePath } from './skill-sources.ts';
import {
  discoverMcpSources,
  mcpArtifactId,
  mcpEntryMetadata,
  readMcpSource,
} from './mcp-sources.ts';
import { runCodexSkillControlOperation } from './codex-skill-control-operations.ts';
import { CODEX_SKILL_CONTROL_ERRORS } from '../lib/codex-skill-controls.ts';
import { captureCodexSkillSources } from './codex-skill-source-capture.ts';
import { assertCodexSkillRootBinding } from './codex-skill-source-binding.ts';

type Scope = 'project' | 'user';
type Agent = 'claude-code' | 'claude-desktop' | 'cursor' | 'windsurf' | 'codex' | 'shared';
type Kind = 'skill' | 'mcp';
type Meta = {
  id: string;
  kind: Kind;
  name: string;
  agent: Agent;
  scope: Scope;
  fileType: 'skill-tree' | 'mcp-config';
  skillSource?: SkillSourceId;
  location?: SkillLocation;
};
type Item = Meta & {
  quarantineSupported?: boolean;
  quarantineReason?: InventoryQuarantineReason;
  signalDecision?: InventorySignalProjection;
  sha256: string | null;
  capabilities?: { kind: string; count: number }[];
  scan: { status: 'clean' | 'suspect' | 'incomplete' | 'not-scanned'; findings: number };
  mcp?: {
    transport: 'stdio' | 'http' | 'unknown';
    wrapper: 'configured' | 'not-configured' | 'unknown';
    strict: boolean;
  };
};
type Gap = { code: string; agent: Agent; scope: Scope; kind: Kind; skillSource?: SkillSourceId };
type Baseline = InventoryBaseline;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const safeName = safeInventoryName;
const gapFor = (kind: Kind, agent: Agent, scope: Scope, code: string): Gap => ({
  kind,
  agent,
  scope,
  code,
});
const emptyScan = () => ({ status: 'incomplete' as const, findings: 0 });

async function skills(
  project: string,
  userHome: string,
  budget: { bytes: number; deadline: number },
  rules: ReturnType<typeof loadBundledRules>,
  runtimeSha256?: string,
) {
  const items: Item[] = [];
  const bindings = new Map<string, CompactSignalBinding>();
  const profile = inventoryEngineProfile(rules);
  const discovered = await discoverSkillArtifacts({ project, userHome, deadline: budget.deadline });
  const gaps: Gap[] = [...discovered.gaps];
  const sources = discovered.sources.map((source) => ({ ...source }));
  for (const artifact of discovered.artifacts) {
    const { root, path } = artifact;
    const meta: Meta = {
      ...skillArtifactMeta(artifact),
      fileType: 'skill-tree',
      location: skillLocation(artifact.locator),
    };
    const gap = (code: string) => {
      const source = sources.find(
        (entry) => entry.id === artifact.skillSource && entry.scope === artifact.scope,
      );
      if (source) source.status = 'partial';
      if (
        !gaps.some(
          (entry) =>
            entry.skillSource === artifact.skillSource &&
            entry.scope === artifact.scope &&
            entry.code === code,
        )
      )
        gaps.push({
          ...gapFor('skill', artifact.agent, artifact.scope, code),
          skillSource: artifact.skillSource,
        });
    };
    if (budget.bytes >= 4 * 1024 * 1024 || Date.now() >= budget.deadline) {
      items.push({
        ...meta,
        sha256: null,
        scan: emptyScan(),
        capabilities: [],
        quarantineSupported: false,
        quarantineReason: 'incomplete',
      });
      gap('limit');
      continue;
    }
    try {
      if ((await safeLocation(root, path, true)).kind !== 'ok') throw new Error('path-refused');
      const read = await readDirTree(path, {
        limits: {
          maxEntries: 128,
          maxDepth: 8,
          maxFileBytes: 200_000,
          maxExpanded: Math.min(512 * 1024, 4 * 1024 * 1024 - budget.bytes),
        },
      });
      const directory = await safeLocation(root, path, true);
      if (directory.kind !== 'ok' || !directory.stat) throw new Error('path-refused');
      if (read.tree.entries.some((entry) => entry.kind !== 'file')) throw new Error('path-refused');
      const filePins = [];
      for (const entry of read.tree.entries) {
        const located = await safeLocation(root, join(path, entry.path));
        if (located.kind !== 'ok' || !located.stat) throw new Error('path-refused');
        filePins.push({ path: entry.path, stat: located.stat });
      }
      if (!read.tree.entries.some((entry) => entry.path === 'SKILL.md'))
        throw new Error('unsupported-entry');
      budget.bytes += read.tree.entries.reduce((sum, entry) => sum + entry.size, 0);
      const passport = inspectTree(read.tree, {
        kind: 'skill',
        source: { type: 'dir', label: 'local-skill' },
        extraBlindSpots: read.blindSpots,
        stroqVersion: 'console-adapter',
        rulesId: INSPECT_RULES_ID,
      });
      const groups = new Map<string, number>();
      for (const line of passport.lines) groups.set(line.kind, (groups.get(line.kind) ?? 0) + 1);
      const capabilities = [...groups].map(([kind, count]) => ({ kind, count }));
      let incomplete =
        passportIsIncomplete(passport) ||
        read.blindSpots.some((spot) => spot !== READ_DIR_BLIND_SPOTS.noExecutableBit);
      let suspect = false;
      let findings = 0;
      let score = 0;
      let timedOut = false;
      for (const entry of read.tree.entries.filter((entry) =>
        entry.path.toLowerCase().endsWith('.md'),
      )) {
        if (Date.now() >= budget.deadline) {
          incomplete = true;
          break;
        }
        let text: string;
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes);
        } catch {
          incomplete = true;
          continue;
        }
        const scan = scanContent(
          rules,
          text,
          {
            budgetMs: Math.max(1, Math.min(1000, budget.deadline - Date.now())),
            maxChars: text.length,
          },
          { target: 'instruction_file' },
        );
        findings += scan.matches.length;
        score = Math.max(score, scan.score);
        timedOut ||= scan.timedOut === true;
        incomplete ||= scan.timedOut === true;
        suspect ||= scan.verdict === 'suspect';
      }
      const scan = {
        status: incomplete
          ? ('incomplete' as const)
          : suspect
            ? ('suspect' as const)
            : ('clean' as const),
        findings,
      };
      const sha256 = treeDigest(read.tree);
      if (!incomplete && validSignalSha(runtimeSha256)) {
        const binding: InventorySignalBinding = {
          workspaceId: `workspace-${hash(project).slice(0, 24)}`,
          itemId: artifact.id,
          agent: artifact.agent,
          skillSource: artifact.skillSource,
          scope: artifact.scope,
          artifactSha256: sha256,
          sourceSha256: inventorySignalSource(directory.stat, filePins),
          analysisSha256: inventorySignalAnalysis(
            runtimeSha256,
            sha256,
            profile,
            { ...scan, score, timedOut },
            capabilities as InventoryEvidence['capabilities'],
          ),
        };
        bindings.set(artifact.id, {
          binding,
          eligible:
            scan.status === 'suspect' &&
            findings > 0 &&
            read.tree.entries.length <= 32 &&
            findings <= 100,
        });
      }
      const quarantineReason = incomplete
        ? 'incomplete'
        : await quarantineEligibility(
            skillSourcePath(root, artifact.scope, artifact.skillSource),
            artifact.locator,
            read.tree.entries,
            budget.deadline,
          );
      items.push({
        ...meta,
        sha256,
        scan,
        capabilities,
        quarantineSupported: quarantineReason === 'supported',
        quarantineReason,
      });
      if (incomplete) gap('incomplete-scan');
    } catch (error) {
      items.push({
        ...meta,
        sha256: null,
        scan: emptyScan(),
        capabilities: [],
        quarantineSupported: false,
        quarantineReason: 'incomplete',
      });
      const code = ['path-refused', 'unsupported-entry'].includes((error as Error).message)
        ? (error as Error).message
        : (error as { code?: string }).code === 'limit'
          ? 'limit'
          : 'unreadable';
      gap(code);
    }
  }
  return { items, gaps, sources, bindings };
}

async function mcp(
  project: string,
  userHome: string,
  mcpEnvironment: Record<string, string | undefined>,
) {
  const items: Item[] = [];
  const gaps: Gap[] = [];
  for (const source of await discoverMcpSources({
    project,
    userHome,
    platform: process.platform,
    environment: mcpEnvironment,
  })) {
    const { agent, scope } = source;
    let read;
    try {
      read = await readMcpSource(source);
    } catch (error) {
      const message = (error as Error).message;
      if (message === 'mcp-source-missing') continue;
      gaps.push(
        gapFor(
          'mcp',
          agent,
          scope,
          message === 'mcp-source-invalid'
            ? 'invalid-config'
            : message === 'mcp-source-limit'
              ? 'limit'
              : 'path-refused',
        ),
      );
      continue;
    }
    const config = read.doc;
    const entries = Object.entries(config.mcpServers ?? {}).sort(([a], [b]) => a.localeCompare(b));
    for (const [name, entry] of entries) {
      if (items.length >= 128) {
        gaps.push(gapFor('mcp', agent, scope, 'limit'));
        break;
      }
      const id = mcpArtifactId(source, name);
      const meta: Meta = {
        id,
        kind: 'mcp',
        agent,
        scope,
        fileType: 'mcp-config',
        name: safeName(name, `MCP server ${id.slice(-8)}`),
      };
      const metadataEntry = mcpEntryMetadata(entry);
      items.push({
        ...meta,
        sha256: metadataEntry.sha256,
        scan: { status: 'not-scanned', findings: 0 },
        mcp: metadataEntry.mcp,
      });
      if (!metadataEntry.valid) gaps.push(gapFor('mcp', agent, scope, 'unsupported-entry'));
    }
  }
  return { items, gaps };
}

async function collect(
  project: string,
  userHome: string,
  mcpEnvironment: Record<string, string | undefined>,
) {
  const budget = { bytes: 0, deadline: Math.min(Date.now() + 15_000, workerData.deadline) };
  const rules = loadBundledRules();
  const a = await skills(project, userHome, budget, rules, workerData.runtimeSha256);
  const c = await mcp(project, userHome, mcpEnvironment);
  const signals = await inventorySignalCatalog({
    project,
    userHome,
    home: resolve(workerData.home),
    deadline: workerData.deadline,
    runtimeSha256: workerData.runtimeSha256,
  });
  return {
    items: [
      ...a.items.map((item) => ({
        ...item,
        signalDecision: signalProjection(signals, item.id, a.bindings.get(item.id)),
      })),
      ...c.items,
    ],
    gaps: [...a.gaps, ...c.gaps],
    skillSources: a.sources,
    signalDecisions: { status: signals.status },
  };
}

function snapshot(
  project: string,
  current: Awaited<ReturnType<typeof collect>>,
  before: Pick<Baseline, 'entries' | 'status' | 'reviewedAt'>,
) {
  const reviewed = new Map(before.entries.map((item) => [item.id, item]));
  const present = new Set(current.items.map((item) => item.id));
  const absent = before.entries.filter((item) => !present.has(item.id));
  const gaps = [...current.gaps];
  const sources = current.skillSources.map((source) => ({ ...source }));
  for (const omitted of absent.slice(Math.max(0, 512 - current.items.length))) {
    const skillSource =
      omitted.kind === 'skill' ? (omitted.skillSource ?? 'claude-skills') : undefined;
    if (
      !gaps.some(
        (gap) =>
          gap.kind === omitted.kind &&
          gap.agent === omitted.agent &&
          gap.scope === omitted.scope &&
          gap.skillSource === skillSource &&
          gap.code === 'limit',
      )
    )
      gaps.push({
        ...gapFor(omitted.kind, omitted.agent, omitted.scope, 'limit'),
        ...(skillSource ? { skillSource } : {}),
      });
    const source = sources.find(
      (entry) => entry.id === skillSource && entry.scope === omitted.scope,
    );
    if (source) source.status = 'partial';
  }
  const items = current.items.map((item) => ({
    ...item,
    reviewedSha256: reviewed.get(item.id)?.sha256 ?? null,
    state:
      item.sha256 === null || item.scan.status === 'incomplete'
        ? 'unverifiable'
        : !reviewed.has(item.id)
          ? 'unreviewed'
          : reviewed.get(item.id)?.sha256 === item.sha256
            ? 'unchanged'
            : 'changed',
  }));
  const missing = absent.map((item) => ({
    ...inventoryMeta(item),
    sha256: null,
    reviewedSha256: item.sha256,
    state:
      gaps.some(
        (gap) =>
          gap.agent === item.agent &&
          gap.scope === item.scope &&
          gap.kind === item.kind &&
          (!gap.skillSource || gap.skillSource === (item.skillSource ?? 'claude-skills')),
      ) ||
      (item.kind === 'skill' &&
        !sources.some(
          (source) =>
            source.id === (item.skillSource ?? 'claude-skills') &&
            source.scope === item.scope &&
            source.status !== 'partial',
        ))
        ? 'unverifiable'
        : 'missing',
    scan: { status: 'not-scanned', findings: 0 },
    ...(item.kind === 'mcp'
      ? { mcp: { transport: 'unknown', wrapper: 'unknown', strict: false } }
      : { capabilities: [], quarantineSupported: false, quarantineReason: 'incomplete' }),
  }));
  return {
    schema: 'stroq-inventory/1',
    source: 'local',
    generatedAt: new Date().toISOString(),
    workspace: {
      id: `workspace-${hash(project).slice(0, 24)}`,
      label: safeName(basename(project), 'Local workspace'),
    },
    baseline: { status: before.status, reviewedAt: before.reviewedAt },
    items: [...items, ...missing].slice(0, 512),
    gaps,
    skillSources: sources,
    signalDecisions: current.signalDecisions,
    limitations: [
      'Skills: bounded selected Claude, shared agents, Codex, Cursor, Windsurf and Devin project and user roots. Shared and compatibility roots do not establish active host loading.',
      'Skill discovery excludes custom roots, ancestor and nested workspace roots, main-checkout fallbacks, system roots and plugin caches; symbolic links are reported as incomplete coverage.',
      'Skill content scans cover Markdown. Static capability signals cover source and declarations; they are not observed runtime behavior.',
      'MCP: supported JSON configurations only; Codex TOML and VS Code servers are not inventoried.',
      'MCP entries are configuration evidence. No server was started and no tool description was scanned.',
      'Windsurf inventory includes selected legacy .codeium and current Devin Cascade JSON sources; active client mode and source loading are unverified. Rejected config locations remain coverage gaps.',
      'Review records a fingerprint and sanitized evidence; it does not trust, pin, install or enable an artifact.',
    ],
  };
}

async function run() {
  if (
    workerData.operation === 'codex-sources' ||
    String(workerData.operation).startsWith('codex-control-') ||
    String(workerData.operation).startsWith('codex-network-') ||
    String(workerData.operation).startsWith('codex-path-')
  )
    await assertCodexSkillRootBinding(
      workerData.project,
      workerData.userHome,
      workerData.codexExpectedRoots,
    );
  const project = await realpath(workerData.project);
  const userHome = await realpath(workerData.userHome);
  const home = resolve(workerData.home);
  const mcpEnvironment = workerData.mcpEnvironment ?? {};
  if (
    [
      'codex-path-state',
      'codex-path-capture',
      'codex-path-preview',
      'codex-path-apply',
      'codex-path-recheck',
    ].includes(workerData.operation)
  ) {
    const result = await runCodexPathGuardOperation(
      workerData.operation,
      {
        project,
        userHome,
        codexEnvironment: workerData.codexEnvironment ?? {},
        deadline: workerData.deadline,
        runtimeSha256: workerData.runtimeSha256,
        runtimePaths: workerData.runtimePaths,
      },
      workerData.pathGuardData ?? {},
    );
    await assertCodexSkillRootBinding(project, userHome, workerData.codexExpectedRoots);
    return result;
  }
  if (
    [
      'codex-network-state',
      'codex-network-capture',
      'codex-network-preview',
      'codex-network-apply',
      'codex-network-recheck',
      'codex-network-check-prepare',
    ].includes(workerData.operation)
  ) {
    const result = await runCodexNetworkGuardOperation(
      workerData.operation,
      {
        project,
        userHome,
        codexEnvironment: workerData.codexEnvironment ?? {},
        deadline: workerData.deadline,
        runtimeSha256: workerData.runtimeSha256,
        runtimePaths: workerData.runtimePaths,
        nativeBinaryPath: workerData.nativeBinaryPath,
      },
      workerData.networkGuardData ?? {},
    );
    await assertCodexSkillRootBinding(project, userHome, workerData.codexExpectedRoots);
    return result;
  }
  if (
    [
      'codex-control-state',
      'codex-control-preview',
      'codex-control-apply',
      'codex-control-recheck',
    ].includes(workerData.operation)
  ) {
    const result = await runCodexSkillControlOperation(
      workerData.operation,
      {
        project,
        userHome,
        codexEnvironment: workerData.codexEnvironment ?? {},
        deadline: workerData.deadline,
        runtimeSha256: workerData.runtimeSha256,
        runtimePaths: workerData.runtimePaths,
      },
      workerData.controlData ?? {},
    );
    await assertCodexSkillRootBinding(project, userHome, workerData.codexExpectedRoots);
    return result;
  }
  if (workerData.operation === 'codex-sources') {
    const report = await captureCodexSkillSources({
      project,
      userHome,
      codexEnvironment: workerData.codexEnvironment ?? {},
      deadline: workerData.deadline,
      runtimeSha256: workerData.runtimeSha256,
    });
    await assertCodexSkillRootBinding(project, userHome, workerData.codexExpectedRoots);
    return report;
  }
  if (['signal-state', 'signal-preview', 'signal-apply'].includes(workerData.operation))
    return runInventorySignalOperation(
      workerData.operation,
      {
        project,
        userHome,
        home,
        deadline: workerData.deadline,
        runtimeSha256: workerData.runtimeSha256,
        runtimePaths: workerData.runtimePaths,
        previewExpiresAt: workerData.previewExpiresAt,
      },
      workerData,
    );
  if (workerData.operation === 'inspect')
    return inspectInventoryEvidence({
      project,
      userHome,
      id: workerData.id,
      expectedSha256: workerData.expectedSha256,
      deadline: workerData.deadline,
      mcpEnvironment,
    });
  const workspace = `workspace-${hash(project).slice(0, 24)}`;
  const capture = async (id: string, sha256: string) => {
    const value = await inspectInventoryEvidence({
      project,
      userHome,
      id,
      expectedSha256: sha256,
      deadline: workerData.deadline,
      mcpEnvironment,
    });
    if (!validateInventoryEvidence(value)) throw new Error('inventory-unavailable');
    return value;
  };
  if (workerData.operation === 'compare') {
    const current = await capture(workerData.id, workerData.expectedSha256);
    const latest = await readInventoryBaseline(home, workspace);
    const selected = latest.entries.find((entry) => entry.id === workerData.id);
    if ((selected?.sha256 ?? null) !== workerData.expectedReviewedSha256)
      throw new Error('inspect-conflict');
    const status =
      latest.status === 'invalid'
        ? 'invalid'
        : !selected
          ? 'missing'
          : selected.evidence
            ? 'available'
            : 'legacy';
    const evidence = status === 'available' ? selected!.evidence : null;
    let changes = null;
    if (evidence) {
      try {
        changes = deriveInventoryChanges(current, evidence);
      } catch {
        throw new Error('inspect-conflict');
      }
    }
    try {
      await assertInventoryBaseline(home, workspace, latest);
    } catch {
      throw new Error('inspect-conflict');
    }
    return {
      schema: 'stroq-inventory-comparison/1',
      source: 'local',
      generatedAt: new Date().toISOString(),
      workspaceId: workspace,
      current,
      baseline: {
        status,
        reviewedAt: evidence ? selected!.reviewedAt : null,
        sha256: selected?.sha256 ?? null,
        evidence,
      },
      changes,
      limitations: [...INVENTORY_COMPARISON_LIMITATIONS],
    };
  }
  // A background observation must describe collected sources independently of
  // review ghosts, baseline corruption and baseline-derived overflow gaps.
  if (workerData.operation === 'observe')
    return snapshot(project, await collect(project, userHome, mcpEnvironment), {
      status: 'missing',
      reviewedAt: null,
      entries: [],
    });
  if (workerData.operation !== 'review')
    return snapshot(
      project,
      await collect(project, userHome, mcpEnvironment),
      await readInventoryBaseline(home, workspace),
    );
  // The main thread holds the review lock until this worker has terminated.
  if (workerData.reviewLockHeld !== true) throw new Error('inventory-unavailable');
  if ((await safeLocation(home, join(home, 'console'), true)).kind !== 'ok')
    throw new Error('baseline-invalid');
  const latest = await readInventoryBaseline(home, workspace);
  if (latest.status === 'invalid') throw new Error('baseline-invalid');
  if (
    (latest.entries.find((entry) => entry.id === workerData.itemId)?.sha256 ?? null) !==
    workerData.expectedReviewedSha256
  )
    throw new Error('review-conflict');
  const fresh = await collect(project, userHome, mcpEnvironment);
  const currentItem = fresh.items.find((item) => item.id === workerData.itemId);
  if (!currentItem || currentItem.sha256 !== workerData.sha256) throw new Error('review-conflict');
  if (currentItem.scan.status === 'incomplete' || currentItem.sha256 === null)
    throw new Error('review-incomplete');
  const evidence = await capture(workerData.itemId, workerData.sha256);
  if (evidence.scan.status === 'incomplete') throw new Error('review-incomplete');
  const reviewedAt = new Date().toISOString();
  const meta: InventoryStored = {
    ...inventoryMeta(currentItem),
    sha256: currentItem.sha256,
    reviewedAt,
    evidence,
  };
  const entries = [...latest.entries.filter((entry) => entry.id !== meta.id), meta];
  const stable = (value: typeof evidence) => {
    const { generatedAt: _generatedAt, capture: _capture, ...rest } = value;
    return rest;
  };
  const written = await writeInventoryBaseline(
    home,
    workspace,
    latest,
    entries,
    reviewedAt,
    async () => {
      const rechecked = await capture(workerData.itemId, workerData.sha256);
      if (
        rechecked.scan.status === 'incomplete' ||
        !isDeepStrictEqual(stable(evidence), stable(rechecked))
      )
        throw new Error('review-conflict');
    },
  );
  return snapshot(project, fresh, written);
}

run()
  .then((result) => parentPort?.postMessage(result))
  .catch((error: Error) => {
    const code = [
      ...CODEX_SKILL_CONTROL_ERRORS,
      ...CODEX_NETWORK_GUARD_ERRORS,
      ...CODEX_PATH_GUARD_ERRORS,
      'baseline-invalid',
      'review-conflict',
      'review-incomplete',
      'inspect-conflict',
      'signal-conflict',
      'signal-incomplete',
      'signal-store-unavailable',
      'signal-store-full',
    ].includes(error.message)
      ? error.message
      : 'inventory-unavailable';
    parentPort?.postMessage({ error: code });
  });
