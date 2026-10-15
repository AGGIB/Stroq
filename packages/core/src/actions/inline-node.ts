/**
 * What a program given to `node -e` or `node -p` does when piped data from a command: only handles
 * data, runs code, or cannot be told.
 *
 * Safe synchronous readers read stdin via `fs.readFileSync(0, ...)` and parse or access data
 * without side-effects (e.g. `JSON.parse(require('fs').readFileSync(0, 'utf8')).name`).
 * Anything running arbitrary code, mutating files, touching the network, or using asynchronous
 * event streaming is denied (`exec`) or asked about (`unknown`).
 */

export type NodeProgramVerdict = 'data' | 'exec' | 'unknown';

const MAX_PROGRAM_CHARS = 16_000;
const CONTROL = /[\0-\x08\x0b\x0c\x0e-\x1f]/;

/** What `node` is given that is run: blatant, and so a program that is denied and not asked about. */
export const NODE_EXEC =
  /\b(?:child_process|execSync|execFileSync|spawnSync|spawn|fork|eval|Function|WebAssembly)\b|\brequire\s*\(\s*['"`](?:vm|child_process|worker_threads|cluster)|\bimport\s*\(|process\s*\.\s*(?:binding|mainModule|dlopen)/;

/** Prototype pollution, constructor escaping, and global recovery primitives. */
const PROTOTYPE_ESCAPE = /\b(?:constructor|__proto__|prototype|globalThis|global)\b/;

/** Asynchronous event streaming, promises, and timers. */
const ASYNC_STREAM =
  /\b(?:then|catch|finally|Promise|async|await|setTimeout|setInterval|setImmediate)\b|\.(?:on|once|pipe)\s*\(/;

/** File system writes and mutation operations. */
const FS_MUTATION =
  /\b(?:write|writeFileSync|appendFile|appendFileSync|truncate|truncateSync|open|openSync|unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync|mkdir|mkdirSync|copyFile|copyFileSync|rename|renameSync|chmod|chmodSync|chown|chownSync|createWriteStream|createReadStream|watch|watchFile|cp|cpSync)\b/;

/** Network and external socket operations. */
const NETWORK_OPS = /\b(?:fetch|http|https|net|tls|dgram|WebSocket|axios|undici|request)\b/;

/** Matches require calls to inspect module names. */
const REQUIRE_CALL = /\brequire\s*\(\s*([^)]*)\)/g;

/** Matches readFileSync calls to verify standard input descriptor (fd 0). */
const READ_FILE_SYNC = /\breadFileSync\s*\(\s*([^,)]*)/g;

/** Allowed arguments for fd 0 in readFileSync. */
const VALID_STDIN_FDS = new Set(['0', "'0'", '"0"', 'process.stdin.fd']);

/** Allowed modules in require calls. */
const ALLOWED_MODULES = new Set(["'fs'", '"fs"', "'node:fs'", '"node:fs"']);

/**
 * Validates calls to require(...) ensuring only allowed modules ('fs', 'node:fs') are loaded.
 */
function hasOnlyAllowedRequires(program: string): boolean {
  REQUIRE_CALL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REQUIRE_CALL.exec(program)) !== null) {
    const rawArg = (match[1] ?? '').trim();
    if (!ALLOWED_MODULES.has(rawArg)) {
      return false;
    }
  }
  return true;
}

/**
 * Validates that every call to readFileSync reads from standard input (fd 0).
 */
function hasValidStdinReads(program: string): boolean {
  READ_FILE_SYNC.lastIndex = 0;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = READ_FILE_SYNC.exec(program)) !== null) {
    const rawFd = (match[1] ?? '').trim();
    if (!VALID_STDIN_FDS.has(rawFd)) {
      return false;
    }
    count += 1;
  }
  return count > 0;
}

/**
 * Inspects process attribute accesses to forbid dangerous process methods.
 */
function hasUnsafeProcessAccess(program: string): boolean {
  const matches = program.matchAll(/process\s*\.\s*([a-zA-Z0-9_$]+)/g);
  for (const m of matches) {
    const attr = m[1];
    if (
      attr !== 'stdin' &&
      attr !== 'stdout' &&
      attr !== 'stderr' &&
      attr !== 'exit' &&
      attr !== 'argv' &&
      attr !== 'env'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Judge an inline Node program passed to node -e or node -p.
 */
export function judgeNodeProgram(program: string): NodeProgramVerdict {
  if (program.length > MAX_PROGRAM_CHARS || CONTROL.test(program)) return 'unknown';
  if (NODE_EXEC.test(program)) return 'exec';

  if (PROTOTYPE_ESCAPE.test(program)) return 'unknown';
  if (ASYNC_STREAM.test(program)) return 'unknown';
  if (FS_MUTATION.test(program)) return 'unknown';
  if (NETWORK_OPS.test(program)) return 'unknown';
  if (hasUnsafeProcessAccess(program)) return 'unknown';
  if (!hasOnlyAllowedRequires(program)) return 'unknown';
  if (!hasValidStdinReads(program)) return 'unknown';

  return 'data';
}
