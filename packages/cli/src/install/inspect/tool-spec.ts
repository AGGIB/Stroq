// The tools a skill asks to be allowed to use without asking (`allowed-tools`), and which of them matter.
//
// A tool is written as a name, with a pattern in parentheses that narrows it: `Read`, `Bash(git status:*)`,
// `Write(src/**)`, `mcp__github__create_issue`. The list is a string (separated by commas or by blanks)
// or a YAML list. Whether a tool is sensitive is judged from the text alone: a shell with nothing to
// narrow it, a wildcard, a tool that reaches the network, a tool of an MCP server, or one that writes
// (or reads) outside the project or in the places an agent keeps its own settings. A narrow
// pattern is not a promise, only a smaller ask; the judgement is to look, never a verdict.

/** The most tools one list is read for. */
export const MAX_TOOLS = 100;
/** The longest tool written out in full: a pattern longer than this is cut, and read as far as it goes. */
const SPEC_MAX = 300;

/** Splits a list of tools at commas and blanks that are not inside parentheses. */
export function splitToolList(text: string): { tools: string[]; cut: boolean } {
  const tools: string[] = [];
  let depth = 0;
  let start = -1;
  /** Ends the tool being read; false once there is one more than a reading takes, which is the sign of a cut. */
  const flush = (end: number): boolean => {
    if (start !== -1) tools.push(text.slice(start, Math.min(end, start + SPEC_MAX)));
    start = -1;
    return tools.length <= MAX_TOOLS;
  };
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charCodeAt(at);
    if (depth === 0 && (char === 0x2c || char <= 0x20)) {
      if (!flush(at)) break;
      continue;
    }
    if (start === -1) start = at;
    if (char === 0x28) depth += 1;
    else if (char === 0x29 && depth > 0) depth -= 1;
  }
  flush(text.length);
  return { tools: tools.slice(0, MAX_TOOLS), cut: tools.length > MAX_TOOLS };
}

const WRITING = new Set(['write', 'edit', 'multiedit', 'notebookedit']);
const NETWORK = new Set(['webfetch', 'websearch']);
/** Programs that run anything else, or reach the network, or fetch and run a package. */
const RISKY_PROGRAMS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'env',
  'sudo',
  'su',
  'doas',
  'eval',
  'exec',
  'xargs',
  'node',
  'nodejs',
  'deno',
  'bun',
  'python',
  'python2',
  'python3',
  'perl',
  'ruby',
  'php',
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'npx',
  'pnpx',
  'bunx',
  'uvx',
  'pipx',
  'powershell',
  'pwsh',
  'cmd',
]);
/** A pattern that narrows nothing: empty, or only stars, colons and blanks. */
const NARROWS_NOTHING = /^[\s:*]*$/;
/** A place that is outside the project, or where an agent keeps what governs it. */
const OUTSIDE = /^(?:[/\\~]|[A-Za-z]:)/;
const SENSITIVE_FOLDER =
  /(?:^|\/)(?:\.git|\.claude|\.ssh|\.aws|\.gnupg|\.stroq|\.cursor|\.codex|\.env[^/]*|\.npmrc|\.netrc)(?:\/|$)/;

interface ParsedSpec {
  readonly name: string;
  /** The text inside the parentheses, or null when there are none. */
  readonly pattern: string | null;
}

function parseSpec(spec: string): ParsedSpec {
  const open = spec.indexOf('(');
  if (open === -1) return { name: spec.trim().toLowerCase(), pattern: null };
  const close = spec.lastIndexOf(')');
  return {
    name: spec.slice(0, open).trim().toLowerCase(),
    pattern: spec.slice(open + 1, close > open ? close : spec.length),
  };
}

function pathIsOutside(pattern: string): boolean {
  const path = pattern.trim().replace(/\\/g, '/');
  return (
    OUTSIDE.test(path) ||
    path.split('/').includes('..') ||
    NARROWS_NOTHING.test(path) ||
    SENSITIVE_FOLDER.test(path)
  );
}

function shellIsBroad(pattern: string | null): boolean {
  if (pattern === null || NARROWS_NOTHING.test(pattern)) return true;
  const program = pattern.trim().split(/[\s:]/, 1)[0] ?? '';
  return RISKY_PROGRAMS.has(program.toLowerCase());
}

/** Whether a tool is one to look at twice. */
export function toolIsSensitive(spec: string): boolean {
  const { name, pattern } = parseSpec(spec);
  if (name === '' || name.includes('*') || name.startsWith('mcp__')) return true;
  if (NETWORK.has(name)) return true;
  if (name === 'bash') return shellIsBroad(pattern);
  if (WRITING.has(name)) return pattern === null || pathIsOutside(pattern);
  if (name === 'read')
    return pattern !== null && pathIsOutside(pattern) && !NARROWS_NOTHING.test(pattern);
  return false;
}
