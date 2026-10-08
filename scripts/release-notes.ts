import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * The text of the GitHub release page of a version, taken from CHANGELOG.md, so that nobody writes it twice.
 *
 * A section that is short enough is the page as it is. The section of a big release is not (0.23.0 has 56 changes
 * and 89,000 characters, and a page is read, not scrolled for an hour), so it is condensed to what each change
 * leads with, under its own heading, with a link to the whole of it.
 *
 *     node scripts/release-notes.ts 0.23.0 > notes.md
 *
 * Plain TypeScript that Node runs as it is (22.18 and later), with nothing to install first: the job that runs it
 * has write access to the repository's releases.
 */

/** A section longer than this (in characters) is condensed. 0.22.0 was 11,000 and was copied whole. */
export const VERBATIM_LIMIT = 24_000;
/** A paragraph that is not a list is cut to this when a section is condensed. */
const PARAGRAPH_LIMIT = 1_500;
/** A change without a bold lead is cut to this. */
const LEAD_LIMIT = 200;

export interface Section {
  /** The heading without its `## `: `[0.23.0] - 2026-10-08`. */
  readonly heading: string;
  /** What stands under it up to the next `## ` heading. */
  readonly body: string;
}

/** The section of `version`, or null where there is none. `## [Unreleased]` is never one. */
export function findSection(changelog: string, version: string): Section | null {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) return null;
  const next = lines.findIndex((line, i) => i > start && line.startsWith('## '));
  return {
    heading: (lines[start] as string).slice(3).trim(),
    body: lines
      .slice(start + 1, next === -1 ? lines.length : next)
      .join('\n')
      .trim(),
  };
}

/** The anchor GitHub gives a heading: `[0.23.0] - 2026-10-08` is `0230---2026-10-08`. */
export const anchorOf = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/ /g, '-');

/** `text` cut at the last end of a sentence before `limit`, or at `limit`. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const sentence = head.lastIndexOf('. ');
  return sentence > limit / 2 ? head.slice(0, sentence + 1) : `${head.trimEnd()}…`;
}

/** What a change leads with: its bold opening, or its first sentence. */
export function leadOf(bullet: string): string {
  const bold = /^- \*\*(.+?)\*\*/.exec(bullet);
  if (bold !== null) return (bold[1] as string).trim();
  const text = bullet.replace(/^- /, '');
  return (/^(.+?[.!?])(\s|$)/.exec(text)?.[1] ?? text).slice(0, LEAD_LIMIT).trim();
}

/** A section with one line to a change under its heading, and its paragraphs cut. */
export function condense(body: string): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) out.push('', cut(paragraph.join(' '), PARAGRAPH_LIMIT), '');
    paragraph = [];
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('### ')) {
      flush();
      out.push('', line, '');
    } else if (line.startsWith('- ')) {
      flush();
      out.push(`- ${leadOf(line)}`);
    } else if (line.trim() === '') {
      flush();
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The page of the release of `version`. Throws where CHANGELOG.md has nothing to say for it. */
export function releaseNotes(
  changelog: string,
  version: string,
  repository = 'AGGIB/Stroq',
): string {
  const section = findSection(changelog, version);
  if (section === null)
    throw new Error(`CHANGELOG.md has no section for ${version}: a release needs one`);
  if (section.body === '') throw new Error(`The section of ${version} in CHANGELOG.md is empty`);
  const link = `https://github.com/${repository}/blob/main/CHANGELOG.md#${anchorOf(section.heading)}`;
  const intro = `Install: \`npm i -g @stroq/cli@${version}\`, or \`npx @stroq/cli@latest init\`. Every change, with the reasons, is in the [changelog](${link}).`;
  const body = section.body.length <= VERBATIM_LIMIT ? section.body : condense(section.body);
  return `${intro}\n\n${body}\n`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2];
  if (version === undefined || version === '') {
    process.stderr.write('usage: node scripts/release-notes.ts <version>\n');
    process.exit(2);
  }
  try {
    process.stdout.write(releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), version));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
