import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadBundledRules, redact, scanContent, stableStringify } from '@stroq/core';
import corePackage from '../../packages/core/package.json' with { type: 'json' };
import {
  inspectTree,
  INSPECT_RULES_ID,
  passportIsIncomplete,
} from '../../packages/cli/src/install/inspect/index.ts';
import { ALWAYS_BLIND_SPOTS } from '../../packages/cli/src/install/inspect/blind-spots.ts';
import { readDirTree, READ_DIR_BLIND_SPOTS } from '../../packages/cli/src/install/read-dir.ts';
import { treeDigest } from '../../packages/cli/src/install/tree.ts';
import type { Tree } from '../../packages/cli/src/install/types.ts';
import { safeLocation } from './inventory-safe.mjs';
import { resolveMcpArtifactById } from './mcp-sources.ts';
import type { SkillSourceId } from '../lib/skill-sources.ts';
import {
  INVENTORY_EVIDENCE_GAPS,
  INVENTORY_EVIDENCE_LIMITATIONS,
  type InventoryEvidence,
} from '../lib/inventory-evidence.ts';
import { discoverSkillArtifacts, skillArtifactMeta } from './skill-sources.ts';
import { inventorySignalSource } from './inventory-signal-binding.ts';
export { safeInventoryName } from './skill-sources.ts';
export {
  INVENTORY_EVIDENCE_GAPS,
  INVENTORY_EVIDENCE_LIMITATIONS,
} from '../lib/inventory-evidence.ts';

type Gap = (typeof INVENTORY_EVIDENCE_GAPS)[number];

type Scope = 'project' | 'user';
type Agent = 'claude-code' | 'claude-desktop' | 'cursor' | 'windsurf' | 'codex' | 'shared';
type Meta = {
  id: string;
  kind: 'skill' | 'mcp';
  agent: Agent;
  scope: Scope;
  name: string;
  skillSource?: SkillSourceId;
};
type FileScan = {
  status: 'clean' | 'suspect' | 'not-scanned' | 'invalid-utf8' | 'timed-out';
  score: number | null;
  findings: number;
};
type FileDetail = {
  id: string;
  label: string;
  labelHidden: boolean;
  sha256: string;
  bytes: number;
  markdown: boolean;
  scan: FileScan;
};
type Match = {
  fileId: string;
  ruleId: string;
  title: string;
  severity: string;
  category: string;
  variant: string;
};
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sensitiveName = (value: string) =>
  /(?:^|[\/ .-])[A-Z][A-Z0-9]*_[A-Z0-9_]+(?:$|[\/ .-])/.test(value) ||
  /(?:^|\/)\.env|(?:^|[ \/_.-])(?:env|secrets?|passwords?|credentials?|tokens?|id_rsa|id_ed25519)(?:$|[ \/_.-])|api[_.-]?key|private[_.-]?key|[A-Za-z0-9_-]{24}/i.test(
    value,
  );

function fileLabel(value: string, index: number) {
  const valid =
    value.length <= 160 &&
    value
      .split('/')
      .every((part) => part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]{1,80}$/.test(part));
  return valid && !sensitiveName(value) && redact(value) === value
    ? { label: value, labelHidden: false }
    : { label: `File ${index + 1}`, labelHidden: true };
}

function staticGap(spot: string): Gap | null {
  if (ALWAYS_BLIND_SPOTS.includes(spot)) return null;
  const mappings: [RegExp, Gap][] = [
    [/binary or .*valid UTF-8/, 'source-unreadable-text'],
    [/file.*not read in full/, 'partial-source-inspection'],
    [/dependencies were/, 'dependencies-uninspected'],
    [/minified or obfuscated/, 'obfuscated-source'],
    [/shell text.*not read/, 'shell-inspection-limit'],
    [/without a language tag/, 'untagged-shell-uninspected'],
    [/native code/, 'native-code-uninspected'],
    [/LFS pointer/, 'lfs-content-uninspected'],
    [/front matter.*not read/, 'frontmatter-unparsed-or-limited'],
    [/list of tools, hooks or entries was cut/, 'inspector-lists-truncated'],
    [/more findings? (?:was|were) found/, 'inspector-findings-truncated'],
    [/more places than are listed/, 'inspector-places-truncated'],
    [/one YAML reader/, 'frontend-parser-differences'],
    [/imports resolve outside the pin/, 'external-imports-uninspected'],
    [/prose of documents/, 'prose-capabilities-uninspected'],
    [/the reading .* failed/, 'static-analysis-incomplete'],
  ];
  return mappings.find(([pattern]) => pattern.test(spot))?.[1] ?? 'unknown-static-limit';
}

export const inventoryEngineProfile = (
  rules: ReturnType<typeof loadBundledRules>,
): InventoryEvidence['engine'] => ({
  version: corePackage.version,
  rulesSha256: hash(
    stableStringify(
      rules.map((rule) => ({
        ...rule,
        tests: rule.tests.map((test) => ({
          ...test,
          regex: test.regex ? { source: test.regex.source, flags: test.regex.flags } : null,
        })),
      })),
    ),
  ),
  ruleCount: rules.length,
  inspectorRulesId: INSPECT_RULES_ID,
  threshold: 0.6,
  target: 'instruction_file',
});

function scanTree(tree: Tree, rules: ReturnType<typeof loadBundledRules>, deadline: number) {
  const files: FileDetail[] = [];
  const matches: Match[] = [];
  const gaps = new Set<Gap>();
  const trustedRules = new Map(rules.map((rule) => [rule.id, rule]));
  let score = 0;
  let timedOut = false;
  let scannedMarkdownFiles = 0;
  let findings = 0;
  for (const [index, entry] of tree.entries.entries()) {
    const file: FileDetail = {
      id: `file-${hash(entry.path).slice(0, 24)}`,
      ...fileLabel(entry.path, index),
      sha256: entry.sha256,
      bytes: entry.size,
      markdown: entry.path.toLowerCase().endsWith('.md'),
      scan: { status: 'not-scanned', score: null, findings: 0 },
    };
    files.push(file);
    if (!file.markdown) continue;
    if (Date.now() >= deadline) {
      gaps.add('scan-deadline');
      continue;
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes);
    } catch {
      file.scan = { status: 'invalid-utf8', score: null, findings: 0 };
      gaps.add('invalid-utf8');
      continue;
    }
    const scan = scanContent(
      rules,
      text,
      {
        threshold: 0.6,
        maxChars: text.length,
        budgetMs: Math.max(1, Math.min(1000, deadline - Date.now())),
      },
      { target: 'instruction_file' },
    );
    scannedMarkdownFiles++;
    findings += scan.matches.length;
    score = Math.max(score, scan.score);
    file.scan = {
      status: scan.timedOut ? 'timed-out' : scan.verdict,
      score: scan.score,
      findings: scan.matches.length,
    };
    if (scan.timedOut) {
      timedOut = true;
      gaps.add('scan-timeout');
    }
    for (const match of scan.matches.slice(0, 100)) {
      const rule = trustedRules.get(match.ruleId);
      if (rule)
        matches.push({
          fileId: file.id,
          ruleId: rule.id,
          title: rule.title,
          severity: rule.severity,
          category: rule.category,
          variant: match.variant,
        });
      // The fail-closed budget match is a fixed internal signal, not artifact text.
      else if (match.ruleId === 'STROQ-SCAN-BUDGET')
        matches.push({
          fileId: file.id,
          ruleId: 'STROQ-SCAN-BUDGET',
          title: 'scan budget exceeded',
          severity: 'critical',
          category: 'internal',
          variant: 'raw',
        });
    }
  }
  return { files, matches, findings, score, timedOut, scannedMarkdownFiles, gaps };
}

function keepDetails(files: FileDetail[], matches: Match[], totalMatches: number) {
  const matched = new Set(files.filter((file) => file.scan.findings > 0).map((file) => file.id));
  const keptFiles = [
    ...files.filter((file) => matched.has(file.id)),
    ...files.filter((file) => !matched.has(file.id)),
  ].slice(0, 32);
  const ids = new Set(keptFiles.map((file) => file.id));
  const keptMatches = matches.filter((match) => ids.has(match.fileId)).slice(0, 100);
  return {
    files: keptFiles,
    matches: keptMatches,
    omittedFileDetails: files.length - keptFiles.length,
    omittedMatchDetails: totalMatches - keptMatches.length,
  };
}

async function skillEvidence(
  root: string,
  path: string,
  meta: Meta,
  expected: string,
  deadline: number,
  onSkillCapture?: (sourceSha256: string) => void,
) {
  if ((await safeLocation(root, path, true)).kind !== 'ok') throw new Error('inspect-conflict');
  const read = await readDirTree(path, {
    limits: { maxEntries: 128, maxDepth: 8, maxFileBytes: 200_000, maxExpanded: 512 * 1024 },
  });
  const directory = await safeLocation(root, path, true);
  if (
    directory.kind !== 'ok' ||
    !directory.stat ||
    read.tree.entries.some((entry) => entry.kind !== 'file') ||
    !read.tree.entries.some((entry) => entry.path === 'SKILL.md')
  )
    throw new Error('inspect-conflict');
  const filePins = [];
  for (const entry of read.tree.entries) {
    const located = await safeLocation(root, join(path, entry.path));
    if (located.kind !== 'ok' || !located.stat) throw new Error('inspect-conflict');
    filePins.push({ path: entry.path, stat: located.stat });
  }
  const sha256 = treeDigest(read.tree);
  if (sha256 !== expected) throw new Error('inspect-conflict');
  onSkillCapture?.(inventorySignalSource(directory.stat, filePins));
  const passport = inspectTree(read.tree, {
    kind: 'skill',
    source: { type: 'dir', label: 'local-skill' },
    extraBlindSpots: [],
    stroqVersion: corePackage.version,
    rulesId: INSPECT_RULES_ID,
  });
  const groups = new Map<string, number>();
  for (const line of passport.lines) groups.set(line.kind, (groups.get(line.kind) ?? 0) + 1);
  const rules = loadBundledRules();
  const scanned = scanTree(read.tree, rules, deadline);
  const scanIncomplete =
    passportIsIncomplete(passport) ||
    scanned.gaps.size > 0 ||
    read.blindSpots.some((spot) => spot !== READ_DIR_BLIND_SPOTS.noExecutableBit);
  const gaps = new Set<Gap>(scanned.gaps);
  if (passportIsIncomplete(passport)) gaps.add('static-analysis-incomplete');
  for (const spot of read.blindSpots)
    gaps.add(
      spot === READ_DIR_BLIND_SPOTS.noExecutableBit
        ? 'executable-bit-unavailable'
        : 'capture-omissions',
    );
  for (const spot of passport.blindSpots) {
    const code = staticGap(spot);
    if (code) gaps.add(code);
  }
  const details = keepDetails(scanned.files, scanned.matches, scanned.findings);
  return {
    artifact: { ...meta, sha256, digestFormat: 'stroq-tree/1' },
    engine: inventoryEngineProfile(rules),
    scan: {
      status: scanIncomplete ? 'incomplete' : scanned.score >= 0.6 ? 'suspect' : 'clean',
      score: scanned.score,
      findings: scanned.findings,
      timedOut: scanned.timedOut,
    },
    capabilities: [...groups].map(([kind, count]) => ({ kind, count })),
    files: details.files,
    matches: details.matches,
    coverage: {
      capturedFiles: scanned.files.length,
      markdownFiles: scanned.files.filter((file) => file.markdown).length,
      scannedMarkdownFiles: scanned.scannedMarkdownFiles,
      omittedFileDetails: details.omittedFileDetails,
      omittedMatchDetails: details.omittedMatchDetails,
      incomplete: gaps.size > 0,
      gaps: [...gaps].sort(),
    },
    mcp: null,
  };
}

async function mcpEvidence(
  project: string,
  userHome: string,
  id: string,
  expected: string,
  mcpEnvironment: Record<string, string | undefined>,
) {
  const selected = await resolveMcpArtifactById({
    project,
    userHome,
    id,
    expectedSha256: expected,
    platform: process.platform,
    environment: mcpEnvironment,
  });
  return {
    artifact: {
      ...selected.artifact,
      kind: 'mcp' as const,
      digestFormat: 'mcp-entry-canonical-json/1',
    },
    engine: inventoryEngineProfile(loadBundledRules()),
    scan: { status: 'not-scanned', score: null, findings: 0, timedOut: false },
    capabilities: [],
    files: [
      {
        id: `file-${hash('configuration').slice(0, 24)}`,
        label: 'Configuration',
        labelHidden: false,
        sha256: selected.fileSha256,
        bytes: selected.byteLength,
        markdown: false,
        scan: { status: 'not-scanned', score: null, findings: 0 },
      },
    ],
    matches: [],
    coverage: {
      capturedFiles: 1,
      markdownFiles: 0,
      scannedMarkdownFiles: 0,
      omittedFileDetails: 0,
      omittedMatchDetails: 0,
      incomplete: false,
      gaps: [],
    },
    mcp: selected.mcp,
  };
}

/** Server-selected roots and bounded IDs only; all returned evidence comes from one captured artifact. */
export async function inspectInventoryEvidence({
  project,
  userHome,
  id,
  expectedSha256,
  deadline,
  mcpEnvironment = {},
  onSkillCapture,
}: {
  project: string;
  userHome: string;
  id: string;
  expectedSha256: string;
  deadline: number;
  mcpEnvironment?: Record<string, string | undefined>;
  onSkillCapture?: (sourceSha256: string) => void;
}) {
  const startedAt = new Date().toISOString();
  let evidence;
  try {
    const discovered = await discoverSkillArtifacts({ project, userHome, deadline });
    const selected = discovered.artifacts.find((artifact) => artifact.id === id);
    if (selected)
      evidence = await skillEvidence(
        selected.root,
        selected.path,
        skillArtifactMeta(selected),
        expectedSha256,
        deadline,
        onSkillCapture,
      );
    evidence ??= await mcpEvidence(project, userHome, id, expectedSha256, mcpEnvironment);
  } catch {
    throw new Error('inspect-conflict');
  }
  if (!evidence) throw new Error('inspect-conflict');
  return {
    schema: 'stroq-inventory-evidence/1',
    source: 'local',
    generatedAt: new Date().toISOString(),
    workspaceId: `workspace-${hash(project).slice(0, 24)}`,
    ...evidence,
    capture: { startedAt, completedAt: new Date().toISOString(), atomicSnapshot: false },
    limitations: [...INVENTORY_EVIDENCE_LIMITATIONS],
  };
}
