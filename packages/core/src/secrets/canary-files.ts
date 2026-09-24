import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * Decoy files: a credentials-shaped file that no task the user asked for needs, planted
 * with `stroq canary --file`. An agent that opens one was steered there by something it
 * read that the rules did not catch, so touching it is treated as the session being
 * compromised: the call is denied and the session tainted. The value inside is also a
 * canary in the secret index, so it cannot leave the machine either.
 *
 * Only the paths are recorded here, never the value.
 */
export interface CanaryFiles {
  /** The user's home, for `~` and `$HOME` in the paths a call names. */
  readonly home: string;
  /** Registered decoys as `canaryKey`s. */
  paths(): ReadonlySet<string>;
}

/**
 * A path as a comparison key: `~` and `$HOME` expanded, made absolute against `cwd`,
 * `.` and `..` resolved, separators and case folded — so every spelling of the decoy
 * an agent can use is the same key, and folding case can only over-match.
 */
export function canaryKey(path: string, cwd: string, home: string): string {
  const expanded = path.replace(/^(?:~|\$\{?HOME\}?)(?=$|[/\\])/, home);
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  return absolute.replace(/\\/g, '/').toLowerCase();
}

const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'file_paths', 'paths'];
/** Where a shell word ends: whitespace, the operators around it, and a redirect. */
const SHELL_WORD_BREAK = /[\s;|&<>()`]+/;

function namedPaths(toolName: string, toolInput: Readonly<Record<string, unknown>>): string[] {
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return [];
  if (toolName === 'Bash') {
    const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
    return command
      .split(SHELL_WORD_BREAK)
      .map((word) => word.replace(/["']/g, ''))
      .filter((word) => word !== '' && !word.startsWith('-'));
  }
  return PATH_KEYS.flatMap((key) => {
    const value = toolInput[key];
    if (typeof value === 'string') return [value];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  });
}

/**
 * The decoy this call names, resolved, or null. A tool's path arguments are read by key;
 * a shell command is read word by word, so `cat ~/.aws/credentials.bak`, the quoted
 * `"$HOME/…"` form and a relative path from inside the directory all count.
 */
export function canaryFileTouched(
  paths: ReadonlySet<string>,
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
  cwd: string,
  home: string,
): string | null {
  if (paths.size === 0) return null;
  for (const named of namedPaths(toolName, toolInput)) {
    const key = canaryKey(named, cwd, home);
    if (paths.has(key)) {
      const expanded = named.replace(/^(?:~|\$\{?HOME\}?)(?=$|[/\\])/, home);
      return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
    }
  }
  return null;
}

function readRegistry(file: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { files?: unknown };
    return Array.isArray(parsed.files)
      ? parsed.files.filter((f): f is string => typeof f === 'string')
      : [];
  } catch {
    return [];
  }
}

/** The registry `stroq canary --file` writes, read once per engine. */
export class FileCanaryFiles implements CanaryFiles {
  private cached: ReadonlySet<string> | null = null;

  constructor(
    private readonly file: string,
    readonly home: string,
  ) {}

  paths(): ReadonlySet<string> {
    this.cached ??= new Set(readRegistry(this.file).map((f) => canaryKey(f, '/', this.home)));
    return this.cached;
  }
}

/** Adds an absolute path to the registry once; temp file and rename, readable only by the user. */
export function addCanaryFile(file: string, absolutePath: string): void {
  const files = readRegistry(file);
  if (files.includes(absolutePath)) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    `${JSON.stringify({ version: 1, files: [...files, absolutePath] }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
  chmodSync(temp, 0o600);
  renameSync(temp, file);
}
