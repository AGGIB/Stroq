// The patterns that read the source of JavaScript, TypeScript and Python for what they reach for.
//
// These are heuristics over text, not a parse: they find `process.env.NAME`, an address written as a
// string, a call that starts another program, and a call that runs text as code. They are signals to a
// person and never verdicts, and the lines they make say so. Every pattern starts with a fixed word
// or character and has no part that can match the same text two ways, so the work is linear in the text
// and a hostile file cannot make it worse; `source-redos-gate.test.ts` holds each of them to it.
import type { LineIndex } from './text-files.js';

export type Language = 'js' | 'py';

/** One thing found: what it is, the name it gave, and where it starts in the text. */
export interface Hit {
  readonly name: string;
  readonly index: number;
}

const NAME = '[A-Za-z_][A-Za-z0-9_]{0,99}';

// ---------------------------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------------------------

export const ENV_NAMED: Readonly<Record<Language, readonly RegExp[]>> = {
  js: [
    new RegExp(`process\\.env\\??\\.(${NAME})`, 'g'),
    new RegExp(`process\\.env\\??\\.?\\[\\s*(['"\`])(${NAME})\\1\\s*\\]`, 'g'),
    new RegExp(`Deno\\.env\\.get\\(\\s*(['"\`])(${NAME})\\1`, 'g'),
    new RegExp(`(?:Bun|import\\.meta)\\.env\\.(${NAME})`, 'g'),
  ],
  py: [
    new RegExp(`\\b(?:os\\.)?environ\\s*\\[\\s*(['"])(${NAME})\\1\\s*\\]`, 'g'),
    new RegExp(`\\b(?:os\\.)?environ\\.(?:get|pop|setdefault)\\s*\\(\\s*(['"])(${NAME})\\1`, 'g'),
    new RegExp(`\\b(?:os\\.)?getenv\\s*\\(\\s*(['"])(${NAME})\\1`, 'g'),
  ],
};

/** `const { A, B: b, C = 1 } = process.env`: the names are inside the braces. */
export const ENV_DESTRUCTURED = /\b(?:const|let|var)\s*\{([^{}]{0,1000})\}\s*=\s*process\.env\b/g;
const DESTRUCTURED_NAME = new RegExp(`^\\s*(${NAME})`);

/** `process.env` or `os.environ` used as a whole: not followed by a name, a bracket or a method that takes one. */
export const ENV_WHOLE: Readonly<Record<Language, RegExp>> = {
  js: /process\.env(?!\??\.?[\w$[])/g,
  py: /\bos\.environ\b(?!\s*\[|\.(?:get|pop|setdefault)\s*\()/g,
};

/** The names a destructuring takes, or an empty list when it has a rest element or none. */
export function destructuredNames(inside: string): string[] {
  return inside
    .split(',')
    .map((part) => DESTRUCTURED_NAME.exec(part)?.[1])
    .filter((name): name is string => name !== undefined);
}

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

/**
 * An address written as a string: the run after the scheme stops at a quote, a blank or a closing
 * bracket. A `]` does not stop it, because an address on IPv6 has one (`http://[::1]/`); the host is
 * cut at it when the address is read.
 */
export const URL_LITERAL = /https?:\/\/[^\s'"`<>\\)}|^]{1,300}/gi;
/** The start of an address whose host is made at run time: `${`, `{`, `%s`, or a quote and a plus. */
export const URL_PARTIAL = /['"`]https?:\/\/(?:\$\{|\{|%s|%\(|['"`]\s*\+)/g;
/** A call that fetches an address, whose first argument is a name and not a string. */
export const NETWORK_CALL_WITH_NAME = new RegExp(
  '\\b(?:fetch|axios(?:\\.(?:get|post|put|patch|delete|head|request))?|got(?:\\.(?:get|post))?|ky(?:\\.(?:get|post))?|' +
    'superagent\\.\\w+|undici\\.(?:request|fetch)|https?\\.(?:get|request)|' +
    'requests\\.(?:get|post|put|patch|delete|head|request)|httpx\\.(?:get|post|put|patch|delete|request)|' +
    'urlopen|urlretrieve)\\s*\\(\\s*[A-Za-z_$][\\w$.]*',
  'g',
);

// ---------------------------------------------------------------------------------------------
// Programs and code
// ---------------------------------------------------------------------------------------------

export interface ExecPattern {
  readonly pattern: RegExp;
  /** What to call it in the passport; a pattern with a group of its own names the API with it. */
  readonly api: string | null;
  readonly rule: 'process-spawn' | 'dynamic-code';
}

export const EXEC_PATTERNS: Readonly<Record<Language, readonly ExecPattern[]>> = {
  js: [
    {
      pattern:
        /(?:require\(\s*|from\s+)['"](?:node:)?(?:child_process|execa|cross-spawn|shelljs)['"]/g,
      api: 'child_process',
      rule: 'process-spawn',
    },
    { pattern: /\bchild_process\b/g, api: 'child_process', rule: 'process-spawn' },
    {
      pattern: /\b(?:Bun\.spawn|Deno\.Command|Deno\.run)\b/g,
      api: 'child_process',
      rule: 'process-spawn',
    },
    { pattern: /(?<![\w$.])eval\s*\(/g, api: 'eval()', rule: 'dynamic-code' },
    { pattern: /(?<![\w$.])exec\s*\(/g, api: 'exec()', rule: 'dynamic-code' },
    { pattern: /(?<![\w$.])Function\s*\(/g, api: 'Function()', rule: 'dynamic-code' },
    { pattern: /\bvm\.(?:runIn\w+|Script|compileFunction)\b/g, api: 'vm', rule: 'dynamic-code' },
  ],
  py: [
    { pattern: /\bsubprocess\b/g, api: 'subprocess', rule: 'process-spawn' },
    {
      pattern: /\b(os\.(?:system|popen|exec[lv]\w*|spawn[lv]\w*|posix_spawnp?))\s*\(/g,
      api: null,
      rule: 'process-spawn',
    },
    { pattern: /\bpty\.spawn\b/g, api: 'pty.spawn', rule: 'process-spawn' },
    {
      pattern: /\basyncio\.create_subprocess_(?:exec|shell)\b/g,
      api: 'asyncio.create_subprocess',
      rule: 'process-spawn',
    },
    { pattern: /(?<![\w.])eval\s*\(/g, api: 'eval()', rule: 'dynamic-code' },
    { pattern: /(?<![\w.])exec\s*\(/g, api: 'exec()', rule: 'dynamic-code' },
  ],
};

// ---------------------------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------------------------

// Whether a place in a text is on a line that is a comment, by the one rule that cannot be turned
// against the reading: the first thing on the line is two slashes (JavaScript) or a hash (Python),
// so the whole line is a comment and no code can be on it. A mention there is documentation and not a
// use. Block comments are not skipped: a line that begins with a block comment may go on with code, and
// a line that begins with a star may be a product continued from the line before, so a rule that
// skipped them would be a way to hide a use from the passport. The price is that the addresses in the
// comments of a header are listed. The answer is kept for each line, so a line with many places on it
// is looked at once.
export class CommentLines {
  private readonly known = new Map<number, boolean>();

  constructor(
    private readonly text: string,
    private readonly lines: LineIndex,
    private readonly language: Language,
  ) {}

  isComment(index: number): boolean {
    const line = this.lines.lineAt(index);
    const cached = this.known.get(line);
    if (cached !== undefined) return cached;
    const answer = this.read(this.lines.lineStart(line));
    this.known.set(line, answer);
    return answer;
  }

  private read(start: number): boolean {
    let at = start;
    while (
      at < this.text.length &&
      (this.text.charCodeAt(at) === 0x20 || this.text.charCodeAt(at) === 0x09)
    ) {
      at += 1;
    }
    if (this.language === 'py') return this.text.charAt(at) === '#';
    return this.text.charAt(at) === '/' && this.text.charAt(at + 1) === '/';
  }
}
