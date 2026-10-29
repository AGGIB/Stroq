import { closed, count, hash, list, member, stamp, text } from './local-guards';
import {
  isSkillSourceId,
  skillSourceOf,
  type SkillAgent,
  type SkillSourceId,
} from './skill-sources';

export const INVENTORY_EVIDENCE_GAPS = [
  'capture-omissions',
  'static-analysis-incomplete',
  'invalid-utf8',
  'scan-timeout',
  'scan-deadline',
  'executable-bit-unavailable',
  'source-unreadable-text',
  'partial-source-inspection',
  'dependencies-uninspected',
  'obfuscated-source',
  'shell-inspection-limit',
  'untagged-shell-uninspected',
  'native-code-uninspected',
  'lfs-content-uninspected',
  'frontmatter-unparsed-or-limited',
  'inspector-lists-truncated',
  'inspector-findings-truncated',
  'inspector-places-truncated',
  'frontend-parser-differences',
  'external-imports-uninspected',
  'prose-capabilities-uninspected',
  'unknown-static-limit',
] as const;
export const INVENTORY_EVIDENCE_LIMITATIONS = [
  'This report describes captured bytes, not an atomic filesystem snapshot or a guarantee about later changes.',
  'Markdown was scanned with bundled rules at threshold 0.6; matching signals below that threshold remain clean.',
  'Static capabilities are source and declaration signals, not observed behavior or proof that an action occurred.',
  'Nothing from this artifact was executed, installed, enabled, fetched or sent to a model.',
  'MCP evidence covers one configured entry and its configuration file only; server code, tool descriptions and runtime behavior were not scanned.',
  'Skill discovery covers bounded selected Claude, shared agents, Codex, Cursor, Windsurf and Devin roots; additional custom, ancestor, nested workspace, managed/system and plugin locations are outside this inventory.',
  'File labels may be hidden to avoid revealing credentials or unsafe names; raw content, commands, environment values and snippets are not returned.',
  'Review records a fingerprint and bounded derived evidence; it does not trust, pin or activate an artifact.',
] as const;
export const LEGACY_INVENTORY_EVIDENCE_LIMITATIONS = INVENTORY_EVIDENCE_LIMITATIONS.map(
  (line, index) =>
    index === 5
      ? 'Skill discovery covers Claude Code project and user folders only; plugin caches and other agents are outside this inventory.'
      : line,
);
const CAPABILITIES = [
  'fs.read',
  'fs.write',
  'net',
  'cred.env',
  'cred.file',
  'exec',
  'hook',
  'install-script',
  'tool',
  'allowed-tools',
  'signal',
] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
const VARIANTS = ['raw', 'normalized', 'base64', 'hex', 'url'] as const;
type Gap = (typeof INVENTORY_EVIDENCE_GAPS)[number];
type ScanStatus = 'clean' | 'suspect' | 'not-scanned' | 'invalid-utf8' | 'timed-out';
export interface InventoryEvidenceFile {
  id: string;
  label: string;
  labelHidden: boolean;
  sha256: string;
  bytes: number;
  markdown: boolean;
  scan: { status: ScanStatus; score: number | null; findings: number };
}
export interface InventoryEvidenceMatch {
  fileId: string;
  ruleId: string;
  title: string;
  severity: (typeof SEVERITIES)[number];
  category: string;
  variant: (typeof VARIANTS)[number];
}
export interface InventoryEvidence {
  schema: 'stroq-inventory-evidence/1';
  source: 'local';
  generatedAt: string;
  workspaceId: string;
  artifact: {
    id: string;
    kind: 'skill' | 'mcp';
    agent: SkillAgent | 'claude-desktop';
    skillSource?: SkillSourceId;
    scope: 'project' | 'user';
    name: string;
    sha256: string;
    digestFormat: 'stroq-tree/1' | 'mcp-entry-canonical-json/1';
  };
  engine: {
    version: string;
    rulesSha256: string;
    ruleCount: number;
    inspectorRulesId: 'stroq-vet-rules/2';
    threshold: 0.6;
    target: 'instruction_file';
  };
  scan: {
    status: 'clean' | 'suspect' | 'incomplete' | 'not-scanned';
    score: number | null;
    findings: number;
    timedOut: boolean;
  };
  capabilities: { kind: (typeof CAPABILITIES)[number]; count: number }[];
  files: InventoryEvidenceFile[];
  matches: InventoryEvidenceMatch[];
  coverage: {
    capturedFiles: number;
    markdownFiles: number;
    scannedMarkdownFiles: number;
    omittedFileDetails: number;
    omittedMatchDetails: number;
    incomplete: boolean;
    gaps: Gap[];
  };
  mcp: null | {
    transport: 'stdio' | 'http';
    wrapper: 'configured' | 'not-configured';
    strict: boolean;
  };
  capture: { startedAt: string; completedAt: string; atomicSnapshot: false };
  limitations: string[];
}

const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  closed(value, keys) && Object.keys(value).length === keys.length;
const artifactKeys = ['id', 'kind', 'agent', 'scope', 'name', 'sha256', 'digestFormat'] as const;
function artifactShape(value: unknown): value is Record<string, unknown> {
  if (!closed(value, [...artifactKeys, 'skillSource'])) return false;
  return exact(
    value,
    Object.hasOwn(value, 'skillSource') ? [...artifactKeys, 'skillSource'] : artifactKeys,
  );
}
const score = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const safeText = (value: unknown, max: number): value is string =>
  text(value, max) && !/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(value);
const sensitiveName = (value: string) =>
  /(?:^|\/)\.env|(?:^|[ \/_.-])(?:env|secrets?|passwords?|credentials?|tokens?|id_rsa|id_ed25519)(?:$|[ \/_.-])|api[_.-]?key|private[_.-]?key|[A-Za-z0-9_-]{24}/i.test(
    value,
  ) || /(?:^|[\/ .-])[A-Z][A-Z0-9]*_[A-Z0-9_]+(?:$|[\/ .-])/.test(value);
const unique = (values: readonly unknown[]) => new Set(values).size === values.length;
const id = (value: unknown, prefix: string) =>
  typeof value === 'string' && new RegExp(`^${prefix}-[a-f0-9]{24}$`).test(value);

function file(value: unknown): value is InventoryEvidenceFile {
  if (
    !exact(value, ['id', 'label', 'labelHidden', 'sha256', 'bytes', 'markdown', 'scan']) ||
    !id(value.id, 'file') ||
    !safeText(value.label, 160) ||
    typeof value.labelHidden !== 'boolean' ||
    !hash(value.sha256) ||
    !count(value.bytes, 262_144) ||
    typeof value.markdown !== 'boolean' ||
    !exact(value.scan, ['status', 'score', 'findings']) ||
    !member(value.scan.status, ['clean', 'suspect', 'not-scanned', 'invalid-utf8', 'timed-out']) ||
    !count(value.scan.findings, 100_000)
  )
    return false;
  if (value.labelHidden && !/^File (?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/.test(value.label))
    return false;
  const scan = value.scan as InventoryEvidenceFile['scan'];
  if (scan.status === 'not-scanned' || scan.status === 'invalid-utf8')
    return (
      scan.score === null &&
      scan.findings === 0 &&
      (scan.status !== 'invalid-utf8' || value.markdown === true)
    );
  if (!value.markdown || !score(scan.score) || (scan.findings === 0 && scan.score !== 0))
    return false;
  return scan.status === 'clean'
    ? scan.score < 0.6
    : scan.status === 'suspect'
      ? scan.score >= 0.6
      : scan.score === 1 && scan.findings > 0;
}

function match(value: unknown): value is InventoryEvidenceMatch {
  return (
    exact(value, ['fileId', 'ruleId', 'title', 'severity', 'category', 'variant']) &&
    id(value.fileId, 'file') &&
    typeof value.ruleId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.ruleId) &&
    safeText(value.title, 240) &&
    member(value.severity, SEVERITIES) &&
    typeof value.category === 'string' &&
    /^[a-z][a-z0-9-]{0,99}$/.test(value.category) &&
    member(value.variant, VARIANTS)
  );
}

function common(value: unknown): value is InventoryEvidence {
  if (
    !exact(value, [
      'schema',
      'source',
      'generatedAt',
      'workspaceId',
      'artifact',
      'engine',
      'scan',
      'capabilities',
      'files',
      'matches',
      'coverage',
      'mcp',
      'capture',
      'limitations',
    ]) ||
    value.schema !== 'stroq-inventory-evidence/1' ||
    value.source !== 'local' ||
    !stamp(value.generatedAt) ||
    !id(value.workspaceId, 'workspace') ||
    !artifactShape(value.artifact) ||
    !id(value.artifact.id, 'item') ||
    !member(value.artifact.kind, ['skill', 'mcp']) ||
    !member(value.artifact.agent, [
      'claude-code',
      'claude-desktop',
      'cursor',
      'windsurf',
      'codex',
      'shared',
    ]) ||
    (Object.hasOwn(value.artifact, 'skillSource') &&
      !isSkillSourceId(value.artifact.skillSource)) ||
    !member(value.artifact.scope, ['project', 'user']) ||
    typeof value.artifact.name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(value.artifact.name) ||
    sensitiveName(value.artifact.name) ||
    !hash(value.artifact.sha256) ||
    !member(value.artifact.digestFormat, ['stroq-tree/1', 'mcp-entry-canonical-json/1']) ||
    !exact(value.engine, [
      'version',
      'rulesSha256',
      'ruleCount',
      'inspectorRulesId',
      'threshold',
      'target',
    ]) ||
    typeof value.engine.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value.engine.version) ||
    value.engine.version.length > 80 ||
    !hash(value.engine.rulesSha256) ||
    !count(value.engine.ruleCount, 10_000) ||
    value.engine.ruleCount === 0 ||
    value.engine.inspectorRulesId !== 'stroq-vet-rules/2' ||
    value.engine.threshold !== 0.6 ||
    value.engine.target !== 'instruction_file' ||
    !exact(value.scan, ['status', 'score', 'findings', 'timedOut']) ||
    !member(value.scan.status, ['clean', 'suspect', 'incomplete', 'not-scanned']) ||
    !count(value.scan.findings, 10_000_000) ||
    typeof value.scan.timedOut !== 'boolean' ||
    !list(
      value.capabilities,
      11,
      (item): item is InventoryEvidence['capabilities'][number] =>
        exact(item, ['kind', 'count']) &&
        member(item.kind, CAPABILITIES) &&
        count(item.count, 500) &&
        item.count > 0,
    ) ||
    !list(value.files, 32, file) ||
    !list(value.matches, 100, match) ||
    !exact(value.coverage, [
      'capturedFiles',
      'markdownFiles',
      'scannedMarkdownFiles',
      'omittedFileDetails',
      'omittedMatchDetails',
      'incomplete',
      'gaps',
    ]) ||
    !count(value.coverage.capturedFiles, 128) ||
    value.coverage.capturedFiles === 0 ||
    !count(value.coverage.markdownFiles, 128) ||
    !count(value.coverage.scannedMarkdownFiles, 128) ||
    !count(value.coverage.omittedFileDetails, 128) ||
    !count(value.coverage.omittedMatchDetails, 10_000_000) ||
    typeof value.coverage.incomplete !== 'boolean' ||
    !Array.isArray(value.coverage.gaps) ||
    value.coverage.gaps.length > INVENTORY_EVIDENCE_GAPS.length ||
    !value.coverage.gaps.every((gap) => member(gap, INVENTORY_EVIDENCE_GAPS)) ||
    !unique(value.coverage.gaps) ||
    !exact(value.capture, ['startedAt', 'completedAt', 'atomicSnapshot']) ||
    !stamp(value.capture.startedAt) ||
    !stamp(value.capture.completedAt) ||
    value.capture.atomicSnapshot !== false ||
    value.capture.startedAt > value.capture.completedAt ||
    value.generatedAt < value.capture.startedAt ||
    value.generatedAt > value.capture.completedAt ||
    !Array.isArray(value.limitations) ||
    !(
      (value.limitations.length === INVENTORY_EVIDENCE_LIMITATIONS.length &&
        value.limitations.every((line, index) => line === INVENTORY_EVIDENCE_LIMITATIONS[index])) ||
      (!Object.hasOwn(value.artifact, 'skillSource') &&
        (value.artifact.kind === 'mcp' || value.artifact.agent === 'claude-code') &&
        value.limitations.length === LEGACY_INVENTORY_EVIDENCE_LIMITATIONS.length &&
        value.limitations.every(
          (line, index) => line === LEGACY_INVENTORY_EVIDENCE_LIMITATIONS[index],
        ))
    )
  )
    return false;
  return true;
}

function references(report: InventoryEvidence) {
  const { files, matches, coverage, scan } = report;
  if (
    !files.length ||
    !unique(files.map((item) => item.id)) ||
    !unique(report.capabilities.map((item) => item.kind)) ||
    report.capabilities.reduce((sum, item) => sum + item.count, 0) > 500 ||
    !unique(matches.map((item) => `${item.fileId}\0${item.ruleId}\0${item.variant}`)) ||
    coverage.capturedFiles !== files.length + coverage.omittedFileDetails ||
    coverage.markdownFiles > coverage.capturedFiles ||
    coverage.scannedMarkdownFiles > coverage.markdownFiles ||
    coverage.omittedMatchDetails !== scan.findings - matches.length ||
    coverage.incomplete !== coverage.gaps.length > 0
  )
    return false;
  const shownMarkdown = files.filter((item) => item.markdown);
  const shownScanned = files.filter((item) =>
    ['clean', 'suspect', 'timed-out'].includes(item.scan.status),
  );
  if (
    shownMarkdown.length > coverage.markdownFiles ||
    shownScanned.length > coverage.scannedMarkdownFiles ||
    coverage.markdownFiles - shownMarkdown.length > coverage.omittedFileDetails ||
    coverage.scannedMarkdownFiles - shownScanned.length > coverage.omittedFileDetails ||
    files.reduce((sum, item) => sum + item.scan.findings, 0) > scan.findings
  )
    return false;
  if (
    coverage.omittedFileDetails === 0 &&
    files.reduce((sum, item) => sum + item.scan.findings, 0) !== scan.findings
  )
    return false;
  const byId = new Map(files.map((item) => [item.id, item]));
  const found = new Map<string, number>();
  for (const item of matches) {
    const source = byId.get(item.fileId);
    if (
      !source ||
      !source.markdown ||
      !['clean', 'suspect', 'timed-out'].includes(source.scan.status)
    )
      return false;
    const count = (found.get(item.fileId) ?? 0) + 1;
    if (count > source.scan.findings) return false;
    found.set(item.fileId, count);
  }
  return true;
}

function skill(report: InventoryEvidence) {
  const { scan, coverage } = report;
  if (
    report.artifact.digestFormat !== 'stroq-tree/1' ||
    skillSourceOf(report.artifact) === null ||
    report.mcp !== null ||
    scan.status === 'not-scanned' ||
    !score(scan.score) ||
    !coverage.markdownFiles ||
    report.files.some(
      (item) =>
        item.bytes > 200_000 ||
        (!item.labelHidden &&
          (sensitiveName(item.label) ||
            !item.label
              .split('/')
              .every(
                (part) => part !== '.' && part !== '..' && /^[A-Za-z0-9_.-]{1,80}$/.test(part),
              ) ||
            item.markdown !== item.label.toLowerCase().endsWith('.md'))),
    )
  )
    return false;
  if (report.files.reduce((sum, item) => sum + item.bytes, 0) > 512 * 1024) return false;
  const incomplete = coverage.gaps.some((gap) =>
    [
      'capture-omissions',
      'static-analysis-incomplete',
      'invalid-utf8',
      'scan-timeout',
      'scan-deadline',
    ].includes(gap),
  );
  if (
    (scan.status === 'incomplete') !== incomplete ||
    scan.timedOut !== coverage.gaps.includes('scan-timeout') ||
    (!incomplete && coverage.scannedMarkdownFiles !== coverage.markdownFiles) ||
    (scan.findings === 0 && scan.score !== 0) ||
    (scan.status === 'clean' && scan.score >= 0.6) ||
    (scan.status === 'suspect' && scan.score < 0.6)
  )
    return false;
  for (const item of report.files) {
    if (
      (item.scan.status === 'invalid-utf8' && !coverage.gaps.includes('invalid-utf8')) ||
      (item.scan.status === 'timed-out' && !scan.timedOut) ||
      (item.markdown &&
        item.scan.status === 'not-scanned' &&
        !coverage.gaps.includes('scan-deadline')) ||
      (item.scan.score !== null && item.scan.score > scan.score)
    )
      return false;
  }
  return (
    coverage.omittedFileDetails > 0 ||
    Math.max(0, ...report.files.map((item) => item.scan.score ?? 0)) === scan.score
  );
}

function mcp(report: InventoryEvidence) {
  const value = report.mcp;
  const { scan, coverage } = report;
  return (
    !Object.hasOwn(report.artifact, 'skillSource') &&
    member(report.artifact.agent, ['claude-code', 'claude-desktop', 'cursor', 'windsurf']) &&
    report.artifact.digestFormat === 'mcp-entry-canonical-json/1' &&
    exact(value, ['transport', 'wrapper', 'strict']) &&
    member(value.transport, ['stdio', 'http']) &&
    member(value.wrapper, ['configured', 'not-configured']) &&
    typeof value.strict === 'boolean' &&
    (!value.strict || value.wrapper === 'configured') &&
    (value.transport !== 'http' || (value.wrapper === 'not-configured' && !value.strict)) &&
    scan.status === 'not-scanned' &&
    scan.score === null &&
    scan.findings === 0 &&
    scan.timedOut === false &&
    report.capabilities.length === 0 &&
    report.matches.length === 0 &&
    report.files.length === 1 &&
    report.files[0]!.label === 'Configuration' &&
    !report.files[0]!.labelHidden &&
    !report.files[0]!.markdown &&
    report.files[0]!.scan.status === 'not-scanned' &&
    coverage.capturedFiles === 1 &&
    coverage.markdownFiles === 0 &&
    coverage.scannedMarkdownFiles === 0 &&
    coverage.omittedFileDetails === 0 &&
    coverage.omittedMatchDetails === 0 &&
    !coverage.incomplete
  );
}

/** Validates bounded derived evidence; callers also bind ID, workspace and digest to their request. */
export function validateInventoryEvidence(value: unknown): value is InventoryEvidence {
  return (
    common(value) &&
    references(value) &&
    (value.artifact.kind === 'skill' ? skill(value) : mcp(value))
  );
}
