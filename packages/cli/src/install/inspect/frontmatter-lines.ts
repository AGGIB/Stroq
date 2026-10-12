// What the front matter of a skill declares, as lines of the passport.
//
// `allowed-tools` becomes a line per tool and `hooks` a line per hook, all of them `declared`: the
// artifact says so about itself. The text of a hook is also put to the shell reader, which says what
// the command would do. A front matter that cannot be read is a signal.
import {
  FRONTMATTER_CAP_BYTES,
  FRONTMATTER_FILES_MAX,
  FRONTMATTER_TOTAL_MAX,
} from './blind-spots.js';
import type { Findings } from './findings.js';
import { readFrontmatter } from './frontmatter.js';
import type { Identity } from './identity.js';
import type { InspectInput } from './input.js';
import { addHookLines } from './hook-lines.js';
import { own, ownObject, ownString, type JsonObject } from './json.js';
import type { ShellQueue } from './shell-queue.js';
import { isRootSkillFile, isSkillFile } from './skill-files.js';
import type { TextFile } from './text-files.js';
import { splitToolList, toolIsSensitive } from './tool-spec.js';

const TOOLS_DETECTOR =
  'allowed-tools in front matter: what the skill asks to be allowed to use without asking, as the skill declares it';
/** A file that begins with the delimiter of front matter, after a byte order mark if there is one. */
const OPENS_FRONT_MATTER = /^\ufeff?---/;
const UNREADABLE_DETECTOR =
  'the front matter could not be read, so what it declares (allowed-tools, hooks) is not known; a signal to look at, not a verdict';

/** Whether a file has front matter that declares things: a SKILL.md anywhere, or a command of a plugin. */
export function hasDeclaringFrontmatter(path: string): boolean {
  return isSkillFile(path) || /(?:^|\/)commands\/[^/]+\.md$/.test(path);
}

function toolLines(file: TextFile, value: unknown, line: number, findings: Findings): boolean {
  const lists = Array.isArray(value) ? (value as unknown[]) : [value];
  if (!lists.every((item) => typeof item === 'string')) return false;
  for (const item of lists as string[]) {
    const { tools, cut } = splitToolList(item);
    if (cut) findings.tally('list-cut');
    for (const tool of tools) {
      findings.line({
        kind: 'allowed-tools',
        subject: tool,
        basis: 'declared',
        sensitive: toolIsSensitive(tool),
        file: file.path,
        line,
        detector: TOOLS_DETECTOR,
      });
    }
  }
  return true;
}

function unreadable(file: TextFile, reason: string, tooLong: boolean, findings: Findings): void {
  if (tooLong) findings.tally('frontmatter-too-long');
  findings.signal({
    ruleId: 'frontmatter-unreadable',
    file: file.path,
    line: 1,
    sensitive: true,
    detail: `the front matter ${reason}`,
    detector: UNREADABLE_DETECTOR,
  });
}

/** The version a skill declares: `version`, or `version` under `metadata`; text or a number. */
function versionOf(data: JsonObject): string | null {
  const asText = (value: unknown): string | null =>
    typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
  const metadata = ownObject(data, 'metadata');
  return (
    asText(own(data, 'version')) ?? (metadata === null ? null : asText(own(metadata, 'version')))
  );
}

/**
 * Reads the front matter of every file that declares things, adds its lines, and says what the skill
 * at the root calls itself.
 */
export function inspectFrontmatter(
  input: InspectInput,
  findings: Findings,
  shell: ShellQueue,
): Partial<Identity> {
  let identity: Partial<Identity> = {};
  let read = 0;
  let bytes = 0;
  for (const file of input.texts) {
    if (!hasDeclaringFrontmatter(file.path)) continue;
    if (!OPENS_FRONT_MATTER.test(file.text.slice(0, 8))) continue;
    // Parsing is the dearest thing done to a file, and a tree can hold thousands of skills.
    if (read >= FRONTMATTER_FILES_MAX || bytes >= FRONTMATTER_TOTAL_MAX) {
      findings.tally('frontmatter-over-budget');
      continue;
    }
    read += 1;
    bytes += Math.min(file.size, FRONTMATTER_CAP_BYTES);
    const front = readFrontmatter(file);
    if (front.status === 'absent') continue;
    if (front.status === 'broken') {
      unreadable(file, front.reason, front.tooLong, findings);
      continue;
    }
    const { data, keyLines } = front;
    const tools = own(data, 'allowed-tools');
    if (tools !== undefined && tools !== null) {
      const line = keyLines.get('allowed-tools') ?? 1;
      if (!toolLines(file, tools, line, findings)) {
        unreadable(
          file,
          'declares allowed-tools that is neither text nor a list of text',
          false,
          findings,
        );
      }
    }
    const hooks = own(data, 'hooks');
    if (hooks !== undefined && hooks !== null) {
      addHookLines(file.path, hooks, keyLines.get('hooks') ?? 1, 'front matter', findings, shell);
    }
    if (isRootSkillFile(file.path)) {
      const name = ownString(data, 'name');
      const version = versionOf(data);
      identity = {
        ...(name === null ? {} : { name }),
        ...(version === null ? {} : { version }),
      };
    }
  }
  if (read > 0) findings.tally('frontmatter-reader');
  return identity;
}
