import type { CodexSkillSourceItem } from '../lib/codex-skill-sources.ts';
import { createHash } from 'node:crypto';
import { loadBundledRules, scanContent } from '@stroq/core';
import { readFrontmatter } from '../../packages/cli/src/install/inspect/frontmatter.ts';
import {
  inspectTree,
  INSPECT_RULES_ID,
  passportIsIncomplete,
} from '../../packages/cli/src/install/inspect/index.ts';

let rules: ReturnType<typeof loadBundledRules> | undefined;
const kinds = new Set([
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
]);
// Match the pinned native scalar normalization, without claiming YAML parser parity.
const singleLine = (value: string) =>
  value
    .split(/\p{White_Space}+/u)
    .filter(Boolean)
    .join(' ');

export function analyzeCodexSkillEntrypoint(
  text: string,
  deadline: number,
  folderName = 'skill',
): {
  declaredName: string | null;
  metadata: CodexSkillSourceItem['metadata'];
  scan: CodexSkillSourceItem['scan'];
  capabilities: NonNullable<CodexSkillSourceItem['capabilities']>;
} {
  const frontmatter = readFrontmatter({ text });
  const rawName = frontmatter.status === 'ok' ? frontmatter.data.name : null;
  const description = frontmatter.status === 'ok' ? frontmatter.data.description : null;
  const fallback = singleLine(folderName) || 'skill';
  const name =
    rawName === null || rawName === undefined
      ? fallback
      : typeof rawName === 'string'
        ? singleLine(rawName) || fallback
        : null;
  const valid =
    frontmatter.status === 'ok' &&
    name !== null &&
    [...name].length <= 64 &&
    typeof description === 'string' &&
    singleLine(description).length > 0;
  const base = {
    declaredName: valid ? name : null,
    metadata: valid ? ('valid' as const) : ('invalid' as const),
  };
  if (Date.now() >= deadline)
    return {
      ...base,
      scan: { status: 'incomplete', findings: 0, matches: [], omitted: 0 },
      capabilities: [],
    };
  const bytes = Buffer.from(text),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  const capabilities: NonNullable<CodexSkillSourceItem['capabilities']> = [];
  let incomplete = false;
  try {
    const passport = inspectTree(
      {
        entries: [
          { path: 'SKILL.md', kind: 'file', exec: false, size: bytes.length, bytes, sha256 },
        ],
      },
      {
        kind: 'skill',
        source: { type: 'dir', label: 'manual-entrypoint' },
        extraBlindSpots: [],
        stroqVersion: 'console-adapter',
        rulesId: INSPECT_RULES_ID,
      },
    );
    const counts = new Map<string, number>();
    for (const line of passport.lines)
      if (kinds.has(line.kind))
        counts.set(line.kind, Math.min(10000, (counts.get(line.kind) ?? 0) + 1));
    capabilities.push(...[...counts].map(([kind, count]) => ({ kind, count })));
    incomplete = passportIsIncomplete(passport);
  } catch {
    incomplete = true;
  }
  if (Date.now() >= deadline)
    return {
      ...base,
      capabilities,
      scan: { status: 'incomplete', findings: 0, matches: [], omitted: 0 },
    };
  rules ??= loadBundledRules();
  const scan = scanContent(
    rules,
    text,
    { maxChars: text.length, budgetMs: Math.max(1, Math.min(1000, deadline - Date.now())) },
    { target: 'instruction_file' },
  );
  const trusted = new Map(rules.map((rule) => [rule.id, rule]));
  const matches: CodexSkillSourceItem['scan']['matches'] = [];
  for (const match of scan.matches) {
    if (matches.length >= 32) break;
    const rule = trusted.get(match.ruleId);
    if (rule)
      matches.push({
        ruleId: rule.id,
        severity: rule.severity === 'informational' ? 'info' : rule.severity,
        title: rule.title,
      });
    else if (match.ruleId === 'STROQ-SCAN-BUDGET')
      matches.push({ ruleId: match.ruleId, severity: 'critical', title: 'Scan budget exceeded' });
  }
  const findings = Math.min(scan.matches.length, 10000);
  return {
    ...base,
    capabilities,
    scan: {
      status:
        incomplete || scan.timedOut || Date.now() >= deadline
          ? 'incomplete'
          : findings > 0
            ? 'suspect'
            : 'clean',
      findings,
      matches,
      omitted: findings - matches.length,
    },
  };
}
