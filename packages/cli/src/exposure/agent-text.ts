import { agentDefinitionHasHooks } from '@stroq/core';
import { isPlainObject } from '../commands/config-file.js';
import { readFrontmatter } from '../install/inspect/frontmatter.js';
import type { JsonObject } from '../install/inspect/json.js';
import { firstEntries, hookEntries, MAX_HOOKS, mcpServerHits, tooMany } from './agent-json.js';
import { boundedJson, byLine, digestOf, hit, type AgentHit } from './agent-kinds.js';
import { claudeRuleIsBroad } from './allow-rules.js';
import { lineAt } from './jsonc.js';

type KeyLines = ReadonlyMap<string, number>;

/**
 * Text files an agent loads by itself: the instruction files it reads in every session, and
 * the skills, subagents and commands whose front matter can declare hooks.
 */

/**
 * Characters that show nothing and can carry text a reviewer does not see (TrapDoor, 2026-05):
 * every character Unicode lists as default ignorable, which a renderer may show as nothing.
 * Among them are the zero-width spaces and joiners, the direction marks, overrides and
 * isolates, the fillers, the variation selectors, and the tag characters U+E0000 to U+E007F,
 * which spell out a whole hidden message in what looks like an empty line. A NUL is one too in
 * a file a host reads by its name: it reads the file as text past it, while many viewers stop at
 * it or call the file binary. Matched as single characters, so the scan stays linear.
 */
const HIDDEN = /[\u0000\p{Default_Ignorable_Code_Point}]/gu;

const ZERO_WIDTH_JOINER = 0x200d;
const BYTE_ORDER_MARK = 0xfeff;
/** The two variation selectors that choose how an emoji is drawn: as text, or as a picture. */
const EMOJI_STYLE: ReadonlySet<number> = new Set([0xfe0e, 0xfe0f]);
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const EMOJI = /^\p{Emoji}$/u;
const SKIN_TONE = /^\p{Emoji_Modifier}$/u;
const matches = (re: RegExp, code: number | undefined): boolean =>
  code !== undefined && re.test(String.fromCodePoint(code));

/** The code point that ends just before `at`, and where it starts. */
function before(
  text: string,
  at: number,
): { readonly code: number | undefined; readonly at: number } {
  if (at <= 0) return { code: undefined, at: 0 };
  const start = at >= 2 && (text.codePointAt(at - 2) ?? 0) > 0xffff ? at - 2 : at - 1;
  return { code: text.codePointAt(start), at: start };
}

/**
 * Whether the hidden character at `at` is part of how an emoji is spelled, and so hides nothing:
 * one style selector right after an emoji, or a joiner between two pictographs (a family, a
 * flag), the first of which may carry a style selector or a skin tone.
 */
function spellsEmoji(text: string, at: number, code: number): boolean {
  const prev = before(text, at);
  if (EMOJI_STYLE.has(code)) return matches(EMOJI, prev.code);
  if (code !== ZERO_WIDTH_JOINER) return false;
  const base =
    prev.code !== undefined && (EMOJI_STYLE.has(prev.code) || matches(SKIN_TONE, prev.code))
      ? before(text, prev.at).code
      : prev.code;
  return matches(PICTOGRAPH, base) && matches(PICTOGRAPH, text.codePointAt(at + 1));
}

const codeName = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * The hidden characters of `text`, counted by code point, in the order they come, and the offset
 * of the first. A byte order mark at the very start is how some editors save a file.
 */
function hiddenCharacters(text: string): {
  counts: Map<number, number>;
  order: string;
  first: number;
} {
  const counts = new Map<number, number>();
  const order: string[] = [];
  let first = -1;
  for (const match of text.matchAll(HIDDEN)) {
    const at = match.index;
    const code = match[0].codePointAt(0) ?? 0;
    if ((at === 0 && code === BYTE_ORDER_MARK) || spellsEmoji(text, at, code)) continue;
    counts.set(code, (counts.get(code) ?? 0) + 1);
    order.push(match[0]);
    if (first === -1) first = at;
  }
  return { counts, order: order.join(''), first };
}

/** Base names a host reads as instructions wherever they are. */
const READ_BY_NAME: ReadonlySet<string> = new Set([
  'claude.md',
  'claude.local.md',
  'agents.md',
  'agents.override.md',
  'gemini.md',
  'skill.md',
  '.cursorrules',
  '.windsurfrules',
]);

/**
 * Whether a host reads this file as instructions because of its name or its folder: CLAUDE.md
 * and the like, Copilot's instructions, Cursor's rules, Claude Code's commands and subagents.
 * Other files of an agent folder (a skill's references, its data) are read only when asked for.
 */
export function isReadByName(path: string): boolean {
  const lower = `/${path.toLowerCase()}`;
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  return (
    READ_BY_NAME.has(base) ||
    lower.endsWith('/.github/copilot-instructions.md') ||
    lower.includes('/.cursor/rules/') ||
    ((lower.includes('/.claude/commands/') || lower.includes('/.claude/agents/')) &&
      base.endsWith('.md'))
  );
}

/**
 * An instruction file: a notice that it is there (which the report shows only when it is new
 * or changed), and an error when it holds characters nobody reading it would see. The error's
 * value counts them and ends with a digest of them in order: a hidden message swapped for
 * another made of the same characters is a change.
 *
 * A file that holds a NUL and that no host reads by its name is a binary file: a skill's picture
 * or archive without the usual name. It gets a notice that says so, and nothing more, since an
 * agent does not read it as instructions.
 */
export function instructionFile(path: string, text: string): AgentHit[] {
  if (text.includes('\u0000') && !isReadByName(path))
    return [hit('binary-file', path, 1, 'binary', digestOf(text))];
  const { counts, order, first } = hiddenCharacters(text);
  const notice = hit('instruction-file', path, 1, 'content', digestOf(text));
  if (counts.size === 0) return [notice];
  const value = [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([code, count]) => `${codeName(code)} x${count}`)
    .join(', ');
  const hidden = `${value} (${digestOf(order)})`;
  return [hit('instruction-hidden-text', path, lineAt(text, first), 'hidden', hidden), notice];
}

/** The hooks a definition's front matter declares. */
function definitionHooks(path: string, data: JsonObject, keyLines: KeyLines): AgentHit[] {
  if (!Object.hasOwn(data, 'hooks')) return [];
  const hooks: unknown = data['hooks'];
  const line = keyLines.get('hooks') ?? 1;
  const { entries, cut } = hookEntries(hooks);
  if (entries.length === 0) {
    // A hooks block with no command this reader can find is still a hooks block.
    const declared = boundedJson(hooks);
    return declared === '{}' || declared === 'null' || declared === '[]'
      ? []
      : [hit('agent-definition-hook', path, line, 'hooks', declared)];
  }
  const hits = entries
    .slice(0, MAX_HOOKS)
    .map((e) => hit('agent-definition-hook', path, line, e.event, e.runs));
  return cut ? [...hits, { ...tooMany(path, 'hooks', MAX_HOOKS, hooks), line }] : hits;
}

/** The keys a skill or a command allows tools under, which it may then use without asking. */
const GRANT_KEYS = ['allowed-tools', 'allowedTools', 'allowed_tools'] as const;
/** The tools whose grant hands over the shell: Claude Code's, Copilot's and Gemini's. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['bash', 'shell', 'run_shell_command']);

/** The rules of a grant: a list, or one string of them split at commas and blanks outside `()`. */
function grantRules(value: unknown): string[] {
  const parts = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  const rules: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') {
      rules.push(boundedJson(part));
      continue;
    }
    let depth = 0;
    let start = 0;
    for (let i = 0; i <= part.length; i += 1) {
      const c = part[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth = Math.max(0, depth - 1);
      else if (c === undefined || (depth === 0 && (c === ',' || /\s/.test(c)))) {
        const rule = part.slice(start, i).trim();
        if (rule !== '') rules.push(rule);
        start = i + 1;
      }
    }
  }
  return rules;
}

/** The grants of the shell, of files outside or of the network a definition's front matter makes. */
function definitionGrants(path: string, data: JsonObject, keyLines: KeyLines): AgentHit[] {
  const hits: AgentHit[] = [];
  for (const key of GRANT_KEYS) {
    if (!Object.hasOwn(data, key)) continue;
    const value: unknown = data[key];
    // A value that is neither a string nor a list is not a grant this reads, and the host may: it
    // counts as one that hands over the shell.
    const readable = typeof value === 'string' || Array.isArray(value);
    const rules = readable ? grantRules(value) : [boundedJson(value)];
    const broad = [...new Set(rules)].filter(
      (rule) => !readable || claudeRuleIsBroad(rule, SHELL_TOOLS),
    );
    const list = firstEntries(path, 'allowed tools', broad);
    const line = keyLines.get(key) ?? 1;
    hits.push(
      ...list.cut.map((h) => ({ ...h, line })),
      ...list.items.map((rule) => hit('agent-broad-allow', path, line, 'allowed-tools', rule)),
    );
  }
  return hits;
}

/** The keys a subagent or an agent profile starts its own MCP servers under. */
const SERVER_KEYS = ['mcpServers', 'mcp-servers', 'mcp_servers'] as const;

/**
 * The servers a definition's front matter starts: a table of them, or a list whose items are
 * tables of them or the names of servers configured elsewhere (reported where they are). Any
 * other shape is not read, and fails.
 */
function definitionServers(
  path: string,
  text: string,
  data: JsonObject,
  keyLines: KeyLines,
): AgentHit[] {
  const hits: AgentHit[] = [];
  for (const key of SERVER_KEYS) {
    if (!Object.hasOwn(data, key)) continue;
    const value: unknown = data[key];
    const line = keyLines.get(key) ?? 1;
    const tables = isPlainObject(value)
      ? [value]
      : Array.isArray(value)
        ? value.filter((item) => typeof item !== 'string')
        : [value];
    for (const table of tables) {
      if (!isPlainObject(table)) {
        hits.push(hit('unreadable-config', path, line, key, boundedJson(table)));
        continue;
      }
      const f = { path, text, value: { [key]: table } };
      hits.push(...mcpServerHits(f, f.value, key).map((h) => ({ ...h, line })));
    }
  }
  return hits;
}

/**
 * A skill, subagent or command whose front matter declares hooks, allows the shell or starts MCP
 * servers. Front matter that cannot be read fails: the host may read the YAML more leniently than
 * this does, so what it declares is not known. A `hooks:` key the gate's own test finds in it is
 * named so.
 */
export function agentDefinition(path: string, text: string): AgentHit[] {
  const front = readFrontmatter({ text });
  if (front.status === 'absent') return [];
  if (front.status === 'broken') {
    return agentDefinitionHasHooks(path, text)
      ? [hit('agent-definition-hook', path, 1, 'hooks (unread)', digestOf(text))]
      : [hit('unreadable-config', path, 1, 'front matter', digestOf(text))];
  }
  const { data, keyLines } = front;
  return byLine([
    ...definitionHooks(path, data, keyLines),
    ...definitionGrants(path, data, keyLines),
    ...definitionServers(path, text, data, keyLines),
  ]);
}
