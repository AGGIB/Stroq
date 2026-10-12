// What the source of an artifact reaches for, as lines of the passport.
//
// For each JavaScript, TypeScript and Python file: the environment variables it reads, the addresses
// it writes out (and the calls whose address it does not), the programs it starts and the code it
// runs from text. All of it is `observed` and none of it is a verdict: it is a reading of text, which
// sees what is written and not what is computed. A name built at run time, or code in another
// language, does not appear, and the blind spots say so.
import type { Findings } from './findings.js';
import type { InspectInput } from './input.js';
import { obfuscationReasons } from './obfuscation.js';
import { shebangInterpreter } from './shell-sources.js';
import {
  CommentLines,
  ENV_DESTRUCTURED,
  ENV_NAMED,
  ENV_WHOLE,
  EXEC_PATTERNS,
  NETWORK_CALL_WITH_NAME,
  URL_LITERAL,
  URL_PARTIAL,
  destructuredNames,
  type Language,
} from './source-patterns.js';
import type { TextFile } from './text-files.js';

/** The most places one pattern is followed in a file; a file with more is cut, and it is said. */
const MAX_MATCHES = 2000;
/** The most distinct addresses one file is listed for. */
const MAX_ADDRESSES = 200;

const SIGNAL_NOTE = 'a signal to look at, not a verdict';
const ENV_DETECTOR = `an environment variable read in source, found by reading the text; ${SIGNAL_NOTE}`;
const WHOLE_ENV_DETECTOR = `the whole environment used in source, found by reading the text; ${SIGNAL_NOTE}`;
const URL_DETECTOR = `an address written as a string in source, found by reading the text; ${SIGNAL_NOTE}`;
const DYNAMIC_URL_DETECTOR = `a network call in source whose address is not written out, found by reading the text; ${SIGNAL_NOTE}`;
const EXEC_DETECTOR = `a use of a program or of code run from text, found by reading the text; ${SIGNAL_NOTE}`;

const JS_EXTENSION = /\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i;
const JS_INTERPRETERS: ReadonlySet<string> = new Set([
  'node',
  'nodejs',
  'deno',
  'bun',
  'tsx',
  'ts-node',
]);

/** The language of a file by its name, or by the interpreter it names when it has no extension that says. */
export function languageOf(file: TextFile): Language | null {
  if (JS_EXTENSION.test(file.path)) return 'js';
  if (/\.py$/i.test(file.path)) return 'py';
  const interpreter = shebangInterpreter(file.text);
  if (interpreter === null) return null;
  if (JS_INTERPRETERS.has(interpreter)) return 'js';
  return /^python[\d.]*$/.test(interpreter) ? 'py' : null;
}

/** Names that are credentials, or very likely carry one. */
const CREDENTIAL_WORDS = /key|token|secret|password|passwd|credential/i;
const CREDENTIAL_PREFIX = /^(?:aws_|github_|openai_|anthropic_)/i;
export const looksLikeCredential = (name: string): boolean =>
  CREDENTIAL_WORDS.test(name) || CREDENTIAL_PREFIX.test(name);

/** Hosts that name this machine or a place documentation points at, which are listed and not sensitive. */
const BENIGN_HOSTS: ReadonlySet<string> = new Set([
  'localhost',
  '[::1]',
  'w3.org',
  'www.w3.org',
  'json-schema.org',
  'schema.org',
  'schemas.xmlsoap.org',
]);
const BENIGN_HOST_SUFFIX = /(?:^|\.)example\.(?:com|org|net)$|^127\.\d+\.\d+\.\d+$|\.localhost$/;
const isBenignHost = (host: string): boolean =>
  BENIGN_HOSTS.has(host) || BENIGN_HOST_SUFFIX.test(host);

/** The host of an address as written, or 'unknown' when it is made at run time or cannot be read. */
function hostOfLiteral(literal: string): string {
  const schemeEnd = literal.indexOf('//') + 2;
  const afterScheme = literal.slice(schemeEnd);
  if (/^[${%]/.test(afterScheme)) return 'unknown';
  // A `]` closes an IPv6 host (`[::1]`), and anywhere else it ends the address.
  const close = afterScheme.indexOf(']');
  const kept =
    close === -1
      ? afterScheme
      : afterScheme.slice(0, afterScheme.startsWith('[') ? close + 1 : close);
  try {
    const host = new URL(`${literal.slice(0, schemeEnd)}${kept}`).hostname.toLowerCase();
    return host === '' ? 'unknown' : host;
  } catch {
    // An address that does not parse names no host that can be said.
    return 'unknown';
  }
}

interface Scan {
  readonly file: TextFile;
  readonly language: Language;
  readonly comments: CommentLines;
  readonly findings: Findings;
}

/** The matches of a pattern that are not in a comment, up to the most that are followed. */
function* matchesOf(
  scan: Scan,
  pattern: RegExp,
): Generator<{ readonly match: RegExpMatchArray; readonly index: number }> {
  let seen = 0;
  for (const match of scan.file.text.matchAll(pattern)) {
    const index = match.index;
    if (index === undefined) continue;
    if (seen >= MAX_MATCHES) {
      scan.findings.tally('list-cut');
      return;
    }
    if (!scan.comments.isComment(index)) {
      seen += 1;
      yield { match, index };
    }
  }
}

function envLine(scan: Scan, name: string, index: number, whole = false): void {
  scan.findings.line({
    kind: 'cred.env',
    subject: whole
      ? `${scan.language === 'js' ? 'process.env' : 'os.environ'} (the whole environment)`
      : name,
    basis: 'observed',
    sensitive: whole || looksLikeCredential(name),
    file: scan.file.path,
    line: scan.file.lines.lineAt(index),
    detector: whole ? WHOLE_ENV_DETECTOR : ENV_DETECTOR,
  });
}

function envLines(scan: Scan): void {
  for (const pattern of ENV_NAMED[scan.language]) {
    for (const { match, index } of matchesOf(scan, pattern)) {
      const name = match[2] ?? match[1];
      if (name !== undefined) envLine(scan, name, index);
    }
  }
  const destructured: [number, number][] = [];
  if (scan.language === 'js') {
    for (const { match, index } of matchesOf(scan, ENV_DESTRUCTURED)) {
      destructured.push([index, index + match[0].length]);
      for (const name of destructuredNames(match[1] ?? '')) envLine(scan, name, index);
    }
  }
  for (const { index } of matchesOf(scan, ENV_WHOLE[scan.language])) {
    const inside = destructured.some(([from, to]) => index >= from && index < to);
    if (!inside) envLine(scan, '', index, true);
  }
}

function addressLines(scan: Scan): void {
  const hosts = new Set<string>();
  const add = (host: string, index: number): void => {
    if (host !== 'unknown' && !hosts.has(host)) {
      if (hosts.size >= MAX_ADDRESSES) {
        scan.findings.tally('list-cut');
        return;
      }
      hosts.add(host);
    }
    const unknown = host === 'unknown';
    scan.findings.line({
      kind: 'net',
      subject: host,
      basis: unknown ? 'unknown' : 'observed',
      sensitive: unknown || !isBenignHost(host),
      file: scan.file.path,
      line: scan.file.lines.lineAt(index),
      detector: unknown ? DYNAMIC_URL_DETECTOR : URL_DETECTOR,
    });
  };
  for (const { match, index } of matchesOf(scan, URL_LITERAL)) add(hostOfLiteral(match[0]), index);
  for (const { index } of matchesOf(scan, URL_PARTIAL)) add('unknown', index);
  for (const { index } of matchesOf(scan, NETWORK_CALL_WITH_NAME)) add('unknown', index);
}

function execLines(scan: Scan): void {
  for (const { pattern, api, rule } of EXEC_PATTERNS[scan.language]) {
    for (const { match, index } of matchesOf(scan, pattern)) {
      const name = api ?? match[1] ?? match[0];
      const line = scan.file.lines.lineAt(index);
      scan.findings.line({
        kind: 'exec',
        subject: name,
        basis: 'observed',
        sensitive: true,
        file: scan.file.path,
        line,
        detector: EXEC_DETECTOR,
      });
      scan.findings.signal({
        ruleId: rule,
        file: scan.file.path,
        line,
        sensitive: true,
        detail: name,
        detector: EXEC_DETECTOR,
      });
    }
  }
}

/** Reads the source files of the tree. */
export function inspectSource(input: InspectInput, findings: Findings): void {
  for (const file of input.texts) {
    const language = languageOf(file);
    if (language === null) continue;
    const scan: Scan = {
      file,
      language,
      comments: new CommentLines(file.text, file.lines, language),
      findings,
    };
    envLines(scan);
    addressLines(scan);
    execLines(scan);
  }
}

/** Reads every file that could be minified or obfuscated, which is every file of code. */
export function inspectObfuscation(input: InspectInput, findings: Findings): void {
  for (const file of input.texts) {
    if (languageOf(file) === null && !/\.(?:sh|bash|zsh|ps1|bat|cmd)$/i.test(file.path)) continue;
    const reasons = obfuscationReasons(file.text);
    if (reasons.length === 0) continue;
    findings.tally('obfuscated-file');
    findings.signal({
      ruleId: 'obfuscated',
      file: file.path,
      line: null,
      sensitive: true,
      detail: reasons.join(', '),
      detector: `the file looks minified or obfuscated, so what it does is not understood; ${SIGNAL_NOTE}`,
    });
  }
}
