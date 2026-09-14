import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadBundledRules, scanContent } from '@stroq/core';
import { isStroqHandler, readSettings, settingsPath } from '../commands/init.js';
import type { Finding } from './findings.js';

/**
 * A real machine can carry thousands of these — 4,824 were measured on the author's
 * on 2026-09-13 — and `exposure` must stay fast enough to run casually, so discovery
 * is bounded rather than exhaustive. The report states the cap when it is reached.
 */
export const MAX_CONTEXT_FILES = 5_000;
/** Files larger than this are counted but not scanned; instruction files are small. */
const MAX_SCAN_BYTES = 256 * 1024;

export interface ContextSurface {
  readonly instructionFiles: number;
  readonly skills: number;
  readonly subagents: number;
  readonly commands: number;
  readonly bytes: number;
  /** Paths of files that tripped at least one rule. See `contextFindings` for the caveat. */
  readonly flagged: readonly string[];
  /** Non-Stroq hook handlers configured for Claude Code: arbitrary code on every tool call. */
  readonly foreignHooks: number;
  /** True when discovery stopped at `MAX_CONTEXT_FILES`, so every count is a lower bound. */
  readonly capped: boolean;
}

const INSTRUCTION_NAMES = [
  'CLAUDE.md',
  'AGENTS.md',
  'GEMINI.md',
  '.cursorrules',
  '.windsurfrules',
] as const;

/**
 * Collects absolute paths, never the same one twice. The project directory IS the home
 * directory often enough (a dotfiles repo, `cd ~`) that without this every user-scope
 * file would be counted a second time and every finding would double.
 */
class FileSet {
  private readonly seen = new Set<string>();
  readonly paths: string[] = [];

  add(path: string): void {
    if (this.seen.has(path) || this.full) return;
    this.seen.add(path);
    this.paths.push(path);
  }

  get full(): boolean {
    return this.seen.size >= MAX_CONTEXT_FILES;
  }

  get size(): number {
    return this.paths.length;
  }
}

function walk(dir: string, match: (name: string) => boolean, out: FileSet): void {
  if (out.full || !existsSync(dir)) return;
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.full) return;
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) walk(full, match, out);
    else if (match(name)) out.add(full);
  }
}

function countForeignHooks(cwd: string): number {
  let count = 0;
  const seen = new Set<string>();
  for (const scope of ['project', 'user'] as const) {
    const file = settingsPath(scope, cwd);
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      for (const group of Object.values(readSettings(file).hooks ?? {}).flat()) {
        if (!Array.isArray(group.hooks)) continue;
        count += group.hooks.filter((h) => !isStroqHandler(h)).length;
      }
    } catch {
      continue;
    }
  }
  return count;
}

const isMarkdown = (name: string): boolean => name.endsWith('.md');

export function contextSurface(cwd: string, home: string = homedir()): ContextSurface {
  const skills = new FileSet();
  walk(join(home, '.claude', 'skills'), isMarkdown, skills);
  walk(join(cwd, '.claude', 'skills'), isMarkdown, skills);
  walk(join(home, '.claude', 'plugins'), (n) => n === 'SKILL.md', skills);

  const subagents = new FileSet();
  walk(join(home, '.claude', 'agents'), isMarkdown, subagents);
  walk(join(cwd, '.claude', 'agents'), isMarkdown, subagents);

  const commands = new FileSet();
  walk(join(home, '.claude', 'commands'), isMarkdown, commands);
  walk(join(cwd, '.claude', 'commands'), isMarkdown, commands);

  const instruction = new FileSet();
  for (const base of [cwd, home])
    for (const name of INSTRUCTION_NAMES) {
      const full = join(base, name);
      if (existsSync(full)) instruction.add(full);
    }

  const rules = loadBundledRules();
  const flagged: string[] = [];
  let bytes = 0;
  for (const file of [
    ...skills.paths,
    ...subagents.paths,
    ...commands.paths,
    ...instruction.paths,
  ]) {
    let text: string;
    try {
      const size = statSync(file).size;
      bytes += size;
      if (size > MAX_SCAN_BYTES) continue;
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (scanContent(rules, text).verdict === 'suspect') flagged.push(file);
  }

  return {
    instructionFiles: instruction.size,
    skills: skills.size,
    subagents: subagents.size,
    commands: commands.size,
    bytes,
    flagged,
    foreignHooks: countForeignHooks(cwd),
    capped: skills.full || subagents.full || commands.full,
  };
}

export function contextFindings(surface: ContextSurface): readonly Finding[] {
  const findings: Finding[] = [];
  if (surface.flagged.length > 0) {
    findings.push({
      class: 'context-flagged',
      severity: 'medium',
      detail:
        `${surface.flagged.length} of the instruction files this agent reads trip a content rule. ` +
        `Expect false positives: documentation that discusses credentials, prompts or shell ` +
        `commands matches the same rules as an attack, and rules are not yet scoped to the ` +
        `surface they were written for. Review with --verbose rather than acting on the count.`,
      fix: null,
    });
  }
  if (surface.foreignHooks > 0) {
    findings.push({
      class: 'hook-foreign',
      severity: 'high',
      detail: `${surface.foreignHooks} non-Stroq hook handler(s) are configured for Claude Code; each runs arbitrary code on every matching tool call`,
      fix: null,
    });
  }
  return findings;
}
