import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const demoScript = resolve(root, 'examples/demo/run-demo.sh');
const outFile = resolve(root, 'docs/assets/demo.svg');

const PLACEHOLDER_HOME = '/tmp/stroq-demo';
const MAX_CHARS = 110;
const FONT_SIZE = 13;
const LINE_HEIGHT = 18;
const CARD_WIDTH = 920;
const PADDING_X = 24;
const HEADER_HEIGHT = 40;
const PADDING_TOP = 20;
const PADDING_BOTTOM = 20;

const COLORS = {
  background: '#0d1117',
  chrome: '#161b22',
  border: '#30363d',
  text: '#c9d1d9',
  dim: '#6e7681',
  header: '#79c0ff',
  red: '#ff7b72',
  amber: '#e3b341',
  green: '#56d364',
  prompt: '#56d364',
  dotRed: '#ff5f56',
  dotYellow: '#ffbd2e',
  dotGreen: '#27c93f',
  title: '#8b949e',
} as const;

type Color = keyof typeof COLORS;

/** Runs the demo script and returns its stdout (the script creates its own temp STROQ_HOME). */
function runDemo(): string {
  return execFileSync('bash', [demoScript], {
    encoding: 'utf8',
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** Replaces the machine-specific temp STROQ_HOME path printed by the demo with a stable placeholder. */
function stripTempPath(output: string): string {
  const match = /^STROQ_HOME=(.+)$/m.exec(output);
  if (!match) return output;
  const [, tempPath] = match;
  return output.split(tempPath).join(PLACEHOLDER_HOME);
}

/** Greedy word-wraps a line to maxChars, hard-splitting any single token that is itself too long. */
function wrapLine(line: string, maxChars: number): readonly string[] {
  if (line.length <= maxChars) return [line];
  const words = line.split(' ');
  const rows: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current.length > 0) rows.push(current);
    let rest = word;
    while (rest.length > maxChars) {
      rows.push(rest.slice(0, maxChars));
      rest = rest.slice(maxChars);
    }
    current = rest;
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

/** Picks a color for a line: deny beats suspect/warn beats allow/OK beats a JSON blob beats plain text. */
function classify(line: string): Color {
  if (/\bdeny/i.test(line)) return 'red';
  if (/\bsuspect\b|\bwarn|⚠/i.test(line)) return 'amber';
  if (/\ballow|\bOK\b|✔/i.test(line)) return 'green';
  if (line.startsWith('==')) return 'header';
  if (line.trimStart().startsWith('{')) return 'dim';
  return 'text';
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface Row {
  readonly text: string;
  readonly color: Color;
}

function buildRows(rawOutput: string): readonly Row[] {
  const cleaned = stripTempPath(rawOutput).replace(/\s+$/, '');
  const sourceLines = ['$ ./examples/demo/run-demo.sh', ...cleaned.split('\n')];
  return sourceLines.flatMap((line, index) => {
    const color: Color = index === 0 ? 'prompt' : classify(line);
    return wrapLine(line, MAX_CHARS).map((text) => ({ text, color }));
  });
}

function render(rows: readonly Row[]): string {
  const height = HEADER_HEIGHT + PADDING_TOP + rows.length * LINE_HEIGHT + PADDING_BOTTOM;
  const textStartY = HEADER_HEIGHT + PADDING_TOP + FONT_SIZE;

  const lines = rows
    .map((row, i) => {
      const y = textStartY + i * LINE_HEIGHT;
      const weight = row.color === 'header' || row.color === 'prompt' ? '600' : '400';
      const content = escapeXml(row.text) || ' ';
      return `<text x="${PADDING_X}" y="${y}" fill="${COLORS[row.color]}" font-weight="${weight}">${content}</text>`;
    })
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${height}" viewBox="0 0 ${CARD_WIDTH} ${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="${FONT_SIZE}">
  <title>Stroq demo: blocking a poisoned dependency README</title>
  <rect x="0" y="0" width="${CARD_WIDTH}" height="${height}" rx="10" fill="${COLORS.background}" />
  <rect x="0" y="${HEADER_HEIGHT - 10}" width="${CARD_WIDTH}" height="10" fill="${COLORS.chrome}" />
  <rect x="0" y="0" width="${CARD_WIDTH}" height="${HEADER_HEIGHT}" rx="10" fill="${COLORS.chrome}" />
  <rect x="0.5" y="0.5" width="${CARD_WIDTH - 1}" height="${height - 1}" rx="10" fill="none" stroke="${COLORS.border}" />
  <circle cx="24" cy="${HEADER_HEIGHT / 2}" r="6" fill="${COLORS.dotRed}" />
  <circle cx="44" cy="${HEADER_HEIGHT / 2}" r="6" fill="${COLORS.dotYellow}" />
  <circle cx="64" cy="${HEADER_HEIGHT / 2}" r="6" fill="${COLORS.dotGreen}" />
  <text x="${CARD_WIDTH / 2}" y="${HEADER_HEIGHT / 2 + 4}" fill="${COLORS.title}" text-anchor="middle" font-size="12">stroq — examples/demo/run-demo.sh</text>
  <g>
    ${lines}
  </g>
</svg>
`;
}

const rows = buildRows(runDemo());
const svg = render(rows);
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, svg);
console.log(`wrote ${outFile} (${svg.length} bytes, ${rows.length} terminal lines)`);
