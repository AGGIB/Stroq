import { createHash } from 'node:crypto';
import { agentDefinitionHasHooks } from '@stroq/core';
import { isPlainObject } from '../commands/config-file.js';
import { readFrontmatter } from '../install/inspect/frontmatter.js';
import type { JsonObject } from '../install/inspect/json.js';
import {
  allowRuleHits,
  hookEntries,
  MAX_HOOKS,
  mcpServerHits,
  opaqueHandlers,
  tooMany,
} from './agent-json.js';
import { asProtection, boundedJson, byLine, digestOf, hit, type AgentHit } from './agent-kinds.js';

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
 * which spell out a whole hidden message in what looks like an empty line. With them, the
 * controls but a tab and a line feed: the C0 controls (NUL, which a host reads past while many
 * viewers stop at it, and ESC, which starts a terminal's sequences that hide or move text), DEL
 * and the C1 controls. A carriage return passes only before a line feed. Matched as single
 * characters, so the scan stays linear.
 */
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\p{Default_Ignorable_Code_Point}]/gu;

const ZERO_WIDTH_JOINER = 0x200d;
const BYTE_ORDER_MARK = 0xfeff;
const CARRIAGE_RETURN = 0x0d;
const LINE_FEED = 0x0a;
/** The two variation selectors that choose how an emoji is drawn: as text, or as a picture. */
const EMOJI_STYLE: ReadonlySet<number> = new Set([0xfe0e, 0xfe0f]);
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const SKIN_TONE = /^\p{Emoji_Modifier}$/u;
/** What a keycap emoji is made of: a digit, `#` or `*`, a style selector, then U+20E3. */
const KEYCAP_BASE = /^[0-9#*]$/;
const KEYCAP = 0x20e3;
/** The most joiners one emoji is spelled with: a family of four has three. */
const MAX_JOINS = 3;
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

/** Whether a style selector at `at` styles an emoji: right after a pictograph, or a keycap's. */
function stylesEmoji(text: string, at: number): boolean {
  const prev = before(text, at).code;
  if (matches(PICTOGRAPH, prev)) return true;
  return matches(KEYCAP_BASE, prev) && text.codePointAt(at + 1) === KEYCAP;
}

/**
 * Where the pictograph a joiner at `at` joins from starts, past one style selector or skin tone
 * on it; -1 when the joiner is not between two pictographs.
 */
function joinedFrom(text: string, at: number): number {
  const prev = before(text, at);
  const base =
    prev.code !== undefined && (EMOJI_STYLE.has(prev.code) || matches(SKIN_TONE, prev.code))
      ? before(text, prev.at)
      : prev;
  return matches(PICTOGRAPH, base.code) && matches(PICTOGRAPH, text.codePointAt(at + 1))
    ? base.at
    : -1;
}

const codeName = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

const countNewlines = (text: string, from: number, to: number): number => {
  let count = 0;
  for (let i = text.indexOf('\n', from); i !== -1 && i < to; i = text.indexOf('\n', i + 1))
    count += 1;
  return count;
};
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

/** Units of text kept before the part not yet examined: the emoji checks look back at most four. */
const CONTEXT = 8;
/** Units of text at the end of what is fed that wait for the next piece: the checks look ahead at most two. */
const HOLD = 8;

/**
 * The scan for the hidden characters of a text, which can take its text in pieces. A piece may end
 * anywhere that is not inside a code point. The hidden characters are counted by code point, in the
 * order they come, with the offset of the first. A byte order mark at the very start is how some
 * editors save a file, a carriage return before a line feed ends a line, and a style selector or a
 * joiner that spells an emoji hides nothing; anything else this cannot place as one of those counts.
 *
 * A few characters before and after each piece are kept to decide those, and nothing else of the
 * text is: the counts, a running digest of the characters in order and the line of the first are all
 * it holds, so a file of any size is scanned in constant memory. Given a `limit` it stops counting
 * at that many hidden characters, the first ones, whatever the pieces were.
 */
export class HiddenScan {
  private readonly counts = new Map<number, number>();
  private readonly order = createHash('sha256');
  private total = 0;
  /** The text kept from the pieces so far: context already examined, then what waits. */
  private tail = '';
  /** How many units at the start of `tail` were examined already. */
  private seen = 0;
  /** The offset in the whole text of `tail[0]`. */
  private start = 0;
  /** The newlines in the whole text before the part examined. */
  private newlines = 0;
  private first = -1;
  private line = 1;
  /** The joiners of the emoji being spelled: where its next pictograph starts, and how many. */
  private next = -1;
  private joins = 0;

  constructor(private readonly limit: number = Number.POSITIVE_INFINITY) {}

  /** Whether any hidden character was counted. */
  get found(): boolean {
    return this.total > 0;
  }

  /** Whether the limit was reached: nothing more is counted. */
  get full(): boolean {
    return this.total >= this.limit;
  }

  /** How many units of text are kept: a few, however much was fed. */
  get kept(): number {
    return this.tail.length;
  }

  feed(text: string): void {
    if (!this.full) this.examine(this.tail + text, false);
  }

  /** The end of the text: the finding, or none. Call once. */
  finish(path: string): AgentHit | undefined {
    if (!this.full) this.examine(this.tail, true);
    if (this.counts.size === 0) return undefined;
    const value = [...this.counts.entries()]
      .sort(([a], [b]) => a - b)
      .map(([code, count]) => `${codeName(code)} x${count}`)
      .join(', ');
    const digest = `sha256:${this.order.digest('hex').slice(0, 16)}`;
    return hit('instruction-hidden-text', path, this.line, 'hidden', `${value} (${digest})`);
  }

  /** Examines `window`, which is the kept text and then the new, up to the units that wait. */
  private examine(window: string, final: boolean): void {
    const end = final ? window.length : Math.max(this.seen, window.length - HOLD);
    const picked: string[] = [];
    for (const match of window.matchAll(HIDDEN)) {
      const at = match.index;
      if (at < this.seen) continue;
      if (at >= end) break;
      const absolute = this.start + at;
      const code = match[0].codePointAt(0) ?? 0;
      if (absolute === 0 && code === BYTE_ORDER_MARK) continue;
      if (code === CARRIAGE_RETURN && window.charCodeAt(at + 1) === LINE_FEED) continue;
      if (EMOJI_STYLE.has(code) && stylesEmoji(window, at)) continue;
      if (code === ZERO_WIDTH_JOINER) {
        const from = joinedFrom(window, at);
        if (from !== -1) {
          this.joins = this.start + from === this.next ? this.joins + 1 : 1;
          this.next = absolute + 1;
          if (this.joins <= MAX_JOINS) continue;
        }
      }
      this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
      picked.push(match[0]);
      this.total += 1;
      if (this.first === -1) {
        this.first = absolute;
        this.line = 1 + this.newlines + countNewlines(window, this.seen, at);
      }
      if (this.full) break;
    }
    if (picked.length > 0) this.order.update(picked.join(''));
    if (this.first === -1) this.newlines += countNewlines(window, this.seen, end);
    // Keep the context of what comes next, from a whole code point.
    let from = Math.max(0, end - CONTEXT);
    if (from > 0 && isLowSurrogate(window.charCodeAt(from))) from -= 1;
    this.tail = window.slice(from);
    this.seen = end - from;
    this.start += from;
  }
}

/**
 * A finding for what `text` hides, or none: its value counts the hidden characters and ends with
 * a digest of them in order, so a hidden message swapped for another of the same characters is a
 * change.
 */
export function hiddenTextHit(path: string, text: string): AgentHit | undefined {
  const scan = new HiddenScan();
  scan.feed(text);
  return scan.finish(path);
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
  const notice = hit('instruction-file', path, 1, 'content', digestOf(text));
  const hidden = hiddenTextHit(path, text);
  return hidden === undefined ? [notice] : [hidden, notice];
}

/** The hooks a definition's front matter declares. */
function definitionHooks(path: string, data: JsonObject, keyLines: KeyLines): AgentHit[] {
  if (!Object.hasOwn(data, 'hooks')) return [];
  const hooks: unknown = data['hooks'];
  const line = keyLines.get('hooks') ?? 1;
  const { entries, cut, opaque } = hookEntries(hooks, undefined, true);
  if (entries.length === 0) {
    // A hooks block with no command this reader can find is still a hooks block.
    const declared = boundedJson(hooks);
    return declared === '{}' || declared === 'null' || declared === '[]'
      ? []
      : [hit('agent-definition-hook', path, line, 'hooks', declared)];
  }
  const hits = [
    ...entries
      .slice(0, MAX_HOOKS)
      .map((e) => hit('agent-definition-hook', path, line, e.event, e.runs)),
    ...opaqueHandlers(path, line, opaque),
  ];
  return cut ? [...hits, { ...tooMany(path, 'hooks', MAX_HOOKS, hooks), line }] : hits;
}

/** The keys a skill or a command allows tools under, which it may then use without asking. */
const GRANT_KEYS = ['allowed-tools', 'allowedTools', 'allowed_tools'] as const;

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

/**
 * Every tool a definition's front matter allows, whatever it is: which grants are harmless is not
 * worked out. A value that is neither a string nor a list is reported as it is.
 */
function definitionGrants(path: string, data: JsonObject, keyLines: KeyLines): AgentHit[] {
  const hits: AgentHit[] = [];
  for (const key of GRANT_KEYS) {
    if (!Object.hasOwn(data, key)) continue;
    const value: unknown = data[key];
    const readable = typeof value === 'string' || Array.isArray(value);
    const rules = readable ? grantRules(value) : [boundedJson(value)];
    const line = keyLines.get(key) ?? 1;
    hits.push(...allowRuleHits({ path, text: '' }, rules, 'allowed-tools', () => line));
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
  // The mode a subagent runs in: one that asks less fails wherever it is; any change fails.
  const mode: unknown = Object.hasOwn(data, 'permissionMode') ? data['permissionMode'] : undefined;
  const modes =
    mode === undefined
      ? []
      : [
          asProtection(
            hit(
              typeof mode === 'string' && ['default', 'plan', 'dontAsk'].includes(mode)
                ? 'agent-broad-allow'
                : 'agent-permission-bypass',
              path,
              keyLines.get('permissionMode') ?? 1,
              'permissionMode',
              typeof mode === 'string' ? mode : boundedJson(mode),
            ),
          ),
        ];
  return byLine([
    ...modes,
    ...definitionHooks(path, data, keyLines),
    ...definitionGrants(path, data, keyLines),
    ...definitionServers(path, text, data, keyLines),
  ]);
}
