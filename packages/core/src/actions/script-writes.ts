import { basename, dirname, isAbsolute } from 'node:path';
import { commandWord } from './shell-segments.js';
import { resolve, withoutRedirects } from './shell-words.js';

/**
 * What a command line writes before it runs one of the files as a script.
 *
 * The script reader reads a script from disk at the moment of the decision (`script-exec.ts`). A file
 * the same line writes first is not only what is on disk then: `curl -o x.sh … && sh x.sh` runs what
 * was fetched, and `printf '…' > t.sh; bash t.sh` runs text the line holds in quotes, which is not read
 * as commands. So a write is remembered with where its text comes from, and judged as well as the file
 * on disk, never instead of it (an append keeps what the file held):
 *
 * - `fetched`: a download (`curl -o`, `curl -O`, `wget`) or a redirect of a fetch (`curl … > x.sh`):
 *   running it as a script is `curl | sh` by another road;
 * - `decoded`: a redirect of a decode (`base64 -d > f`): running it, by any name, is an encoded payload;
 * - `text`: `echo`, `printf` or a here-string of words written out, read as the script;
 * - `heredoc`: a here-document, whose lines the line's own reading already reads as commands;
 * - `varies`: `echo` or `printf` of a variable or a substitution, whose text nobody can read;
 * - `copy`: a copy, a move or a link of one file, which runs what that file holds and what the line
 *   wrote to it (`curl -o a … && mv a x.sh`);
 * - `unknown`: anything else (a copy of many files, `tee`, another program's output), judged by the
 *   disk.
 *
 * A segment also says whether it fetched, decoded, unpacked or ran an inline program, after which a
 * script that is not on disk yet is a question: something in the line made it, and where it unpacked
 * or cloned what it brought in. Reading is word by word, with no pattern that backtracks over the
 * command.
 */

export type WrittenSource =
  | { readonly kind: 'fetched' }
  | { readonly kind: 'decoded' }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'heredoc' }
  | { readonly kind: 'varies' }
  | { readonly kind: 'copy'; readonly from: string }
  | { readonly kind: 'unknown' };

export interface Write {
  /** The path as written: a plain path, or a word the shell expands as it runs (`"$tmp"`). */
  readonly path: string;
  readonly source: WrittenSource;
}

export interface SegmentWrites {
  readonly writes: readonly Write[];
  /** The segment fetches, decodes, unpacks, clones or runs an inline program: it may make files. */
  readonly makes: boolean;
  /**
   * The folders it unpacks an archive or clones a repository into, as written (`.` for the one it runs
   * in), or null for one it cannot say: what it brings in may be anywhere below them. A download or a
   * decode written to a file is a write, judged by its path.
   */
  readonly into: readonly (string | null)[];
}

const MAX_SEGMENT = 64 * 1024;
const DEVICE = /^\/dev\/(?:null|stderr|stdout|tty|fd\/\d+)$/;
const FETCHERS: ReadonlySet<string> = new Set([
  'curl',
  'curl.exe',
  'wget',
  'wget.exe',
  'aria2c',
  'http',
  'https',
  'xh',
  'fetch',
]);
const DECODERS: ReadonlySet<string> = new Set(['base64', 'base32', 'xxd', 'uudecode', 'openssl']);
const UNPACKERS: ReadonlySet<string> = new Set([
  'unzip',
  '7z',
  '7za',
  'unrar',
  'cpio',
  'ditto',
  'gunzip',
  'bunzip2',
  'unxz',
]);
const INTERPRETERS: ReadonlySet<string> = new Set([
  'python',
  'python3',
  'node',
  'perl',
  'ruby',
  'php',
  'deno',
  'bun',
]);
const MAX_WORD = 1024;
/** The programs that copy one local file to another name; `rsync` and `scp` may copy a remote one. */
const COPIERS: ReadonlySet<string> = new Set(['cp', 'mv', 'install', 'ln']);
/** Where a word of the shell ends, outside quotes. */
const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);

/**
 * The words of a stretch of a segment, quotes removed, read by hand, up to `max` of them; null when one
 * is too long.
 */
function wordsOf(text: string, max = Number.POSITIVE_INFINITY): string[] | null {
  const out: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (word.length > MAX_WORD) return null;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) word += text.charAt(++i);
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === '\\' && i + 1 < text.length) {
      word += text.charAt(++i);
      inWord = true;
    } else if (WORD_END.has(ch)) {
      if (inWord) out.push(word);
      if (out.length >= max) return out;
      word = '';
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
  }
  if (inWord) out.push(word);
  return out;
}

interface Redirects {
  /** The files written by `>`, `>>`, `>|`, `&>`, `>&`; null for a target too long to read. */
  readonly targets: Array<string | null>;
  /** The segment before its first redirect. */
  readonly head: string;
  /** The text of a here-string (`<<< 'text'`), or null. */
  readonly hereString: string | null;
  /** A here-document (`<<EOF`). */
  readonly heredoc: boolean;
}

/** The redirects of a segment, read outside quotes, character by character. */
function redirects(segment: string): Redirects {
  const targets: Array<string | null> = [];
  let head: string | null = null;
  let hereString: string | null = null;
  let heredoc = false;
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment.charAt(i);
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '\\') i += 1;
    else if (ch === '<' && segment.startsWith('<<<', i)) {
      hereString = wordsOf(segment.slice(i + 3, i + 3 + MAX_WORD + 8).trimStart(), 1)?.[0] ?? '';
      i += 2;
    } else if (ch === '<' && segment.charAt(i + 1) === '<') {
      heredoc = true;
      i += 1;
    } else if (ch === '>') {
      // The descriptor before it (`2>`, `&>`) belongs to the redirect, not to the words.
      let start = i;
      while (start > 0 && /[0-9&]/.test(segment.charAt(start - 1))) start -= 1;
      head ??= segment.slice(0, start);
      let j = i + 1;
      if (segment.charAt(j) === '>' || segment.charAt(j) === '|') j += 1;
      // `>&2`, `2>&1`, `>&-`: a descriptor copied or closed; `>& file` writes a file.
      if (segment.charAt(j) === '&') {
        if (/[0-9-]/.test(segment.charAt(j + 1))) {
          i = j;
          continue;
        }
        j += 1;
      }
      const words = wordsOf(segment.slice(j, j + MAX_WORD + 8).trimStart(), 1);
      const target = words === null ? null : (words[0] ?? '');
      if (target === null) targets.push(null);
      else if (target !== '' && !DEVICE.test(target)) targets.push(target);
      i = j;
    }
  }
  return { targets, head: head ?? segment, hereString, heredoc };
}

const ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  e: '\x1b',
  E: '\x1b',
  '\\': '\\',
  "'": "'",
  '"': '"',
};

/** The escapes `printf` and `echo -e` read: `\n`, `\x72`, `\155`, `\0155`. */
function unescape(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch !== '\\' || i + 1 >= text.length) {
      out += ch;
      continue;
    }
    const next = text.charAt(i + 1);
    const hex = /^x([0-9a-fA-F]{1,2})/.exec(text.slice(i + 1, i + 4));
    const octal = /^0?([0-7]{1,3})/.exec(text.slice(i + 1, i + 5));
    if (hex !== null) {
      out += String.fromCharCode(Number.parseInt(hex[1] as string, 16));
      i += hex[0].length;
    } else if (octal !== null) {
      out += String.fromCharCode(Number.parseInt(octal[1] as string, 8) & 0xff);
      i += octal[0].length;
    } else if (ESCAPES[next] !== undefined) {
      out += ESCAPES[next];
      i += 1;
    } else out += ch;
  }
  return out;
}

/**
 * `printf` and `echo` of words written out, as the file may hold them. `echo` reads escapes in some
 * shells and not in others, so both readings are kept, one after the other.
 */
function literalText(name: string, args: readonly string[]): string {
  if (name === 'echo') {
    let at = 0;
    while (at < args.length && /^-[neE]+$/.test(args[at] as string)) at += 1;
    const text = args.slice(at).join(' ');
    const read = unescape(text);
    return read === text ? `${text}\n` : `${text}\n${read}\n`;
  }
  // printf [--] FORMAT ARGS…: the format is used again until the arguments run out, as printf does.
  const rest = args[0] === '--' ? args.slice(1) : args;
  const [format, ...values] = rest;
  if (format === undefined) return '';
  const specs = (format.match(/%[^%]/g) ?? []).length;
  const rounds = Math.max(1, Math.ceil(values.length / Math.max(1, specs)));
  let out = '';
  let next = 0;
  for (let round = 0; round < rounds && out.length < 64 * 1024; round += 1)
    out += unescape(format).replace(/%(?:%|[-+ #0-9.]*[sbdiqcuxXoeEfgG])/g, (spec) => {
      if (spec === '%%') return '%';
      const value = values[next++] ?? '';
      return spec.endsWith('b') ? unescape(value) : value;
    });
  return out;
}

/** The files `curl` and `wget` download to: `-o f`, `--output f`, `-sSLo f`, `-O` (the URL's name). */
function downloadTargets(name: string, args: readonly string[]): string[] {
  const fetcher = name.replace(/\.exe$/, '');
  const urls = args.filter(
    (arg) => /^(?:https?|ftp):\/\//i.test(arg) || /^[\w.-]+\.[a-z]{2,}\//i.test(arg),
  );
  const remoteName = (): string[] =>
    urls
      .map((url) => basename(url.split(/[?#]/)[0] ?? ''))
      .filter((file) => file !== '' && !file.includes(':'));
  const targets: string[] = [];
  let remote = false;
  // `curl --output-dir d`, `wget -P d` / `--directory-prefix d`: the folder the file lands in.
  let folder: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    const [flag, glued] = arg.startsWith('--') ? (arg.split(/=(.*)/s) as [string, string?]) : [arg];
    if (flag === '--output' || flag === '--output-document') {
      const value = glued ?? args[++i];
      if (value !== undefined) targets.push(value);
    } else if (flag === '--output-dir' || flag === '--directory-prefix') {
      folder = glued ?? args[++i] ?? null;
    } else if (fetcher === 'wget' && arg === '-P') {
      folder = args[++i] ?? null;
    } else if (fetcher === 'wget' && /^-P./.test(arg)) {
      folder = arg.slice(2);
    } else if (flag === '--remote-name' || flag === '--remote-name-all') remote = true;
    else if (/^-[A-Za-z]/.test(arg) && !arg.startsWith('--')) {
      // A cluster of short flags; the one that takes a value takes the rest of the word or the next one.
      const letters = arg.slice(1);
      const at = letters.indexOf(fetcher === 'wget' ? 'O' : 'o');
      if (at !== -1) {
        const rest = letters.slice(at + 1);
        const value = rest !== '' ? rest : args[++i];
        if (value !== undefined) targets.push(value);
      } else if (fetcher === 'curl' && /^[A-Za-z]+$/.test(letters) && letters.includes('O'))
        remote = true;
    }
  }
  // wget names the file after the URL unless told otherwise; `-O -` writes to the terminal.
  const named =
    fetcher === 'wget' && targets.length === 0
      ? remoteName()
      : [...targets.filter((target) => target !== '-'), ...(remote ? remoteName() : [])];
  const within = (path: string): string =>
    folder === null || folder === '' || path.startsWith('/')
      ? path
      : `${folder.replace(/\/+$/, '')}/${path}`;
  return named.map(within);
}

const isDecoding = (name: string, args: readonly string[]): boolean =>
  DECODERS.has(name) &&
  (name === 'uudecode' ||
    args.some((arg) => /^-(?:-decode|d|D|r)$/.test(arg) || (name === 'openssl' && arg === 'enc')));

/** The command a segment runs, through wrappers and keywords, and its words that are not redirects. */
function commandOf(segment: string): { name: string; args: string[] } | null {
  const found = resolve(segment);
  if (found === null || found.name === '$') return null;
  return {
    name: found.name.toLowerCase(),
    args: withoutRedirects(found.args).map((word) => word.value),
  };
}

/** What a segment writes, and where the text comes from. */
export function segmentWrites(segment: string): SegmentWrites {
  // Too long to read with care: what it makes is not known.
  if (segment.length > MAX_SEGMENT) return { writes: [], makes: true, into: [null] };
  const { targets, head, hereString, heredoc } = redirects(segment);
  // The whole segment, its redirects (and their targets) left out: `curl 2>/dev/null -o x.sh URL`.
  const command = commandOf(segment) ?? commandOf(head);
  const name = command?.name ?? commandWord(segment).toLowerCase();
  const args = command?.args ?? [];
  const writes: Write[] = [];
  const fetches = FETCHERS.has(name);
  const decodes = isDecoding(name, args);
  if (fetches)
    for (const path of downloadTargets(name, args))
      writes.push({ path, source: { kind: 'fetched' } });
  if (COPIERS.has(name)) writes.push(...copyWrites(name, args));
  else if (name === 'rsync' || name === 'scp') {
    const destination = args.filter((arg) => !arg.startsWith('-')).at(-1);
    if (destination !== undefined) writes.push({ path: destination, source: { kind: 'unknown' } });
  }
  if (name === 'dd')
    for (const arg of args)
      if (arg.startsWith('of=')) writes.push({ path: arg.slice(3), source: { kind: 'unknown' } });
  if (name === 'tee')
    for (const arg of args.filter((a) => !a.startsWith('-')))
      writes.push({ path: arg, source: { kind: 'unknown' } });
  const varies = /[$`]/.test(head);
  const texts = name === 'echo' || name === 'printf';
  const source: WrittenSource = fetches
    ? { kind: 'fetched' }
    : decodes
      ? { kind: 'decoded' }
      : hereString !== null && (name === 'cat' || name === 'tee')
        ? /[$`]/.test(hereString)
          ? { kind: 'varies' }
          : { kind: 'text', text: `${hereString}\n` }
        : heredoc && (name === 'cat' || name === 'tee')
          ? { kind: 'heredoc' }
          : texts && varies
            ? { kind: 'varies' }
            : texts
              ? { kind: 'text', text: literalText(name, args) }
              : { kind: 'unknown' };
  let unread = false;
  for (const path of targets) {
    if (path === null) unread = true;
    else writes.push({ path, source });
  }
  // `tar xzf`, `tar -xf`, `tar -C d -xf`, `tar --extract`: a cluster of letters with an `x`.
  const extracts =
    (name === 'tar' || name === 'bsdtar') &&
    (args.some((arg) => arg === '--extract' || arg === '--get') ||
      tarClusters(args).some((cluster) => cluster.includes('x')));
  const clones =
    (name === 'git' && (args.includes('clone') || args.includes('submodule'))) ||
    (name === 'gh' && args.includes('clone')) ||
    name === 'hg' ||
    name === 'svn';
  const inline = INTERPRETERS.has(name) && args.some((arg) => arg === '-c' || arg === '-e');
  // `unzip -l` and its kin only list or test.
  const unpacks =
    UNPACKERS.has(name) && !args.some((arg) => /^-[lvtZ]$/.test(arg) || arg === '--list');
  const into = [
    ...(extracts || unpacks ? unpackFolders(name, args) : []),
    ...(clones ? [cloneTarget(name, args)] : []),
  ];
  return {
    writes,
    makes: fetches || decodes || extracts || clones || unpacks || inline || unread,
    into,
  };
}

/** Options of `cp`, `mv`, `install` and `ln` that take the next word as their value. */
const COPY_VALUES: ReadonlySet<string> = new Set([
  '-S',
  '--suffix',
  '-m',
  '--mode',
  '-o',
  '--owner',
  '-g',
  '--group',
]);

/**
 * What `cp`, `mv`, `install` or `ln` writes: each local file it copies, moves or links, under its own
 * name in the folder named last (`cp a.sh b.sh dir/`, `-t dir`), or as the one file named last. A
 * symbolic link's target is read from the folder the link is in (`ln -s a.sh sub/x.sh` is `sub/a.sh`).
 */
function copyWrites(name: string, args: readonly string[]): Write[] {
  const symbolic =
    name === 'ln' && args.some((arg) => arg === '--symbolic' || /^-[A-Za-z]*s/.test(arg));
  const write = (path: string, from: string): Write => ({
    path,
    source: {
      kind: 'copy',
      from:
        symbolic && !isAbsolute(from) && !from.startsWith('~') ? `${dirname(path)}/${from}` : from,
    },
  });
  const operands: string[] = [];
  let folder: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as string;
    if (word === '-t' || word === '--target-directory') {
      folder = args[i + 1] ?? null;
      i += 1;
    } else if (word.startsWith('--target-directory='))
      folder = word.slice('--target-directory='.length);
    else if (COPY_VALUES.has(word)) i += 1;
    else if (!word.startsWith('-')) operands.push(word);
  }
  const last = operands.at(-1);
  const into =
    folder ?? (last !== undefined && (operands.length > 2 || /[/\\]$/.test(last)) ? last : null);
  if (into !== null) {
    const sources = folder === null ? operands.slice(0, -1) : operands;
    return sources.map((from) => write(`${into.replace(/[/\\]+$/, '')}/${basename(from)}`, from));
  }
  const [from, to] = operands;
  return from !== undefined && to !== undefined ? [write(to, from)] : [];
}

/** The letter clusters of a `tar` line: its options (`-xzf`), and an old-style first word (`xzf`). */
const tarClusters = (args: readonly string[]): string[] =>
  args.filter((arg, at) => /^-[A-Za-z]+$/.test(arg) || (at === 0 && /^[A-Za-z]+$/.test(arg)));

/**
 * Where an archive a segment unpacks lands: the folder it names (see `extractionFolder`), the one it runs
 * in, or beside the file it decompresses. Null where that may be anywhere: `tar -P` keeps the absolute
 * names an archive holds, and `cpio` and `unrar` are not read that closely.
 */
function unpackFolders(name: string, args: readonly string[]): (string | null)[] {
  if (name === 'cpio' || name === 'unrar') return [null];
  const operands = args.filter((arg) => !arg.startsWith('-'));
  if (name === 'tar' || name === 'bsdtar') {
    const absolute =
      args.includes('--absolute-names') ||
      args.includes('--absolute-paths') ||
      tarClusters(args).some((cluster) => cluster.includes('P'));
    if (absolute) return [null];
  }
  if (name === 'ditto') return [operands.at(-1) ?? null];
  if (name === 'gunzip' || name === 'bunzip2' || name === 'unxz') {
    if (args.some((arg) => arg === '-c' || arg === '--stdout' || arg === '--to-stdout')) return [];
    return operands.map((file) => dirname(file));
  }
  return [extractionFolder(name, args) ?? '.'];
}

/** Options of `git clone` (and of git before it) that take the next word as their value. */
const CLONE_VALUES: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--config',
  '--depth',
  '-b',
  '--branch',
  '-o',
  '--origin',
  '--reference',
  '--separate-git-dir',
  '-j',
  '--jobs',
  '--filter',
  '--template',
  '-u',
  '--upload-pack',
  '--shallow-since',
  '--shallow-exclude',
  '--bundle-uri',
  '--git-dir',
  '--work-tree',
]);

/** Where `<verb> <address> [dir]` puts what it fetches: the folder named, or the last part of the address. */
function folderAfter(args: readonly string[], verbs: ReadonlySet<string>): string | null {
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as string;
    if (CLONE_VALUES.has(word)) i += 1;
    else if (!word.startsWith('-')) positional.push(word);
  }
  const at = positional.findIndex((word) => verbs.has(word));
  if (at === -1) return null;
  const [url, folder] = positional.slice(at + 1);
  if (folder !== undefined) return folder;
  if (url === undefined) return null;
  return basename(url.replace(/[/\\]+$/, '')).replace(/\.git$/, '') || null;
}

/** Where `git clone <url> [dir]` puts the clone: the folder named, or the last part of the address. */
export const cloneFolder = (args: readonly string[]): string | null =>
  folderAfter(args, new Set(['clone']));

/** Where a clone, a checkout or an update of a working copy puts what it brings: `.` when it is here. */
function cloneTarget(name: string, args: readonly string[]): string {
  const verbs = name === 'svn' ? new Set(['checkout', 'co', 'export']) : new Set(['clone']);
  return folderAfter(args, verbs) ?? '.';
}

/** Where an extraction puts what it unpacks, when it names it: `tar -C dir`, `unzip -d dir`, `7z x -odir`. */
export function extractionFolder(name: string, args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as string;
    if (name === 'tar' || name === 'bsdtar') {
      if (word === '-C' || word === '--directory') return args[i + 1] ?? null;
      const glued = /^(?:--directory=|-C)(.+)$/.exec(word);
      if (glued !== null) return glued[1] ?? null;
    } else if (name === 'unzip' && word === '-d') return args[i + 1] ?? null;
    else if ((name === '7z' || name === '7za') && /^-o./.test(word)) return word.slice(2);
  }
  return null;
}
