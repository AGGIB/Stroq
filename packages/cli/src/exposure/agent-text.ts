import { agentDefinitionHasHooks } from '@stroq/core';
import { readFrontmatter } from '../install/inspect/frontmatter.js';
import { hookEntries, MAX_HOOKS, tooMany } from './agent-json.js';
import { boundedJson, digestOf, hit, type AgentHit } from './agent-kinds.js';
import { lineAt } from './jsonc.js';

/**
 * Text files an agent loads by itself: the instruction files it reads in every session, and
 * the skills, subagents and commands whose front matter can declare hooks.
 */

/**
 * Characters that show nothing and can carry text a reviewer does not see (TrapDoor, 2026-05):
 * zero-width spaces and joiners, the word joiner, a byte order mark that is not at the start,
 * the direction overrides and isolates, and the tag characters U+E0000 to U+E007F, which spell
 * out a whole hidden message in what looks like an empty line. A NUL byte is one too: hosts
 * read the file as text past it, while many viewers stop at it or call the file binary.
 */
const isHidden = (code: number): boolean =>
  code === 0 ||
  (code >= 0x200b && code <= 0x200d) ||
  code === 0x2060 ||
  code === 0xfeff ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069) ||
  (code >= 0xe0000 && code <= 0xe007f);

const ZERO_WIDTH_JOINER = 0x200d;
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const isPictograph = (code: number | undefined): boolean =>
  code !== undefined && PICTOGRAPH.test(String.fromCodePoint(code));

const codeName = (code: number): string => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

/**
 * The hidden characters of `text`, counted by code point, in the order they come, and the offset
 * of the first. A joiner
 * between two pictographs is how an emoji like a family is spelled and carries nothing hidden,
 * since the characters on both sides of it show; a byte order mark at the very start is how
 * some editors save a file.
 */
function hiddenCharacters(text: string): {
  counts: Map<number, number>;
  order: string;
  first: number;
} {
  const counts = new Map<number, number>();
  const order: string[] = [];
  let first = -1;
  let previous: number | undefined;
  for (let at = 0; at < text.length;) {
    const code = text.codePointAt(at) ?? 0;
    const width = code > 0xffff ? 2 : 1;
    const isLeadingMark = at === 0 && code === 0xfeff;
    const isEmojiJoiner =
      code === ZERO_WIDTH_JOINER &&
      isPictograph(previous) &&
      isPictograph(text.codePointAt(at + width));
    if (isHidden(code) && !isLeadingMark && !isEmojiJoiner) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
      order.push(String.fromCodePoint(code));
      if (first === -1) first = at;
    }
    previous = code;
    at += width;
  }
  return { counts, order: order.join(''), first };
}

/**
 * An instruction file: a notice that it is there (which the report shows only when it is new
 * or changed), and an error when it holds characters nobody reading it would see. The error's
 * value counts them and ends with a digest of them in order: a hidden message swapped for
 * another made of the same characters is a change.
 */
export function instructionFile(path: string, text: string): AgentHit[] {
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

/**
 * A skill, subagent or command whose front matter declares hooks. Front matter that cannot be
 * read is read again as text by the gate's own test, and a `hooks:` key found that way is an
 * error: the host may read the YAML more leniently than this does.
 */
export function agentDefinition(path: string, text: string): AgentHit[] {
  const front = readFrontmatter({ text });
  if (front.status === 'absent') return [];
  if (front.status === 'broken') {
    return agentDefinitionHasHooks(path, text)
      ? [hit('agent-definition-hook', path, 1, 'hooks (unread)', digestOf(text))]
      : [];
  }
  if (!Object.hasOwn(front.data, 'hooks')) return [];
  const hooks: unknown = front.data['hooks'];
  const line = front.keyLines.get('hooks') ?? 1;
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
    .map((e) => hit('agent-definition-hook', path, line, e.event, e.command));
  return cut ? [...hits, { ...tooMany(path, 'hooks', MAX_HOOKS, hooks), line }] : hits;
}
