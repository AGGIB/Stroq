// Spawns the Stroq CLI for one hook phase and resolves to `{ reply }` or `{ error }`,
// never rejecting: every failure this plugin can see — a missing binary, a spawn
// error, a non-zero exit, a timeout, an aborted run, an oversized reply, or stdout
// that is not JSON — becomes an `{ error }` for index.js to turn into a block.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 10000;
// A reply this large is not a decision Stroq ever sends; it is a hung or misbehaving
// CLI, and buffering it further would only delay the same block.
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** The launch command `stroq init --agent openclaw` records beside this file. */
const COMMAND_FILE = 'stroq.json';
/** The last resort: a bare name `spawn` resolves through PATH. */
const PATH_FALLBACK = 'stroq';

export const text = (value) => (typeof value === 'string' && value !== '' ? value : '');
export const clip = (value, max) => (value.length <= max ? value : `${value.slice(0, max - 3)}...`);

/** A launch command is a non-empty array of strings; anything else is not one. */
const isArgv = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((a) => typeof a === 'string');

/**
 * The file a recorded command would actually run: the LAST absolute path in the argv,
 * which is the entry rather than the interpreter — `['<node>', '--import', 'tsx',
 * '/opt/stroq/src/index.ts']` names three paths and only the last one goes stale. A
 * relative element is never treated as the entry: it resolves against a working
 * directory this module does not know, so its absence would prove nothing.
 */
export const recordedEntry = (argv) => {
  for (let i = argv.length - 1; i >= 0; i -= 1) if (isAbsolute(argv[i])) return argv[i];
  return null;
};

/**
 * argv of the Stroq CLI, and the recorded entry (if any) that turned out to be gone:
 * this plugin's config, then `STROQ_BIN`, then the `stroq.json` `stroq init --agent
 * openclaw` wrote beside this file, then `stroq` on PATH.
 *
 * The recorded command is SKIPPED when its entry file no longer exists. `npx
 * @stroq/cli init --agent openclaw` records a path inside the npx cache, and pruning
 * that cache used to leave every single tool call blocked on an ENOENT nobody could
 * read — a firewall bricking the agent because its own installer's temp directory was
 * cleaned up. Falling back to PATH turns that into one warning plus a working Stroq
 * wherever one is installed; when there is none, the call still fails closed.
 *
 * `stroqBin`/`STROQ_BIN` is always ONE path, never split on whitespace (a real install
 * path can legitimately contain a space, and a launch command needing extra arguments
 * belongs in `stroq.json`'s array-shaped `command` instead) and never existence-
 * checked: an operator who named a binary must see it fail rather than be silently
 * redirected to some other Stroq that happens to be on PATH.
 *
 * Pure — the config, the environment, the recorded command and the existence check
 * are all parameters — so the whole order is testable without a filesystem.
 */
export function resolveStroqArgv({ config = {}, env = {}, recorded = null, exists }) {
  const configured = text(config.stroqBin) || text(env.STROQ_BIN);
  if (configured) return { argv: [configured], staleEntry: null };
  if (!isArgv(recorded)) return { argv: [PATH_FALLBACK], staleEntry: null };
  const entry = recordedEntry(recorded);
  if (entry !== null && !exists(entry)) return { argv: [PATH_FALLBACK], staleEntry: entry };
  return { argv: [...recorded], staleEntry: null };
}

/** The `command` array `init` recorded, or `null` when there is none to read. */
function readRecordedCommand(file) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).command : null;
  } catch {
    // unreadable or not JSON: fall through to PATH
    return null;
  }
}

/** A stale entry is one fact about this install, not one per tool call. */
let warnedStale = false;

function stroqArgv(config, warn) {
  const { argv, staleEntry } = resolveStroqArgv({
    config,
    env: process.env,
    recorded: readRecordedCommand(join(HERE, COMMAND_FILE)),
    exists: existsSync,
  });
  if (staleEntry !== null && !warnedStale) {
    warnedStale = true;
    warn(
      `${COMMAND_FILE} records ${staleEntry}, which no longer exists; falling back to ` +
        `"${PATH_FALLBACK}" on PATH. Install @stroq/cli globally and re-run ` +
        '"stroq init --agent openclaw".',
    );
  }
  return argv;
}

/** The child's answer: a reply object, or the reason it is not one. */
function replyOf(code, stdout, stderr) {
  if (code !== 0)
    return { error: `exit ${code}: ${clip(stderr.trim() || 'no reason given', 300)}` };
  try {
    const reply = JSON.parse(stdout);
    if (reply && typeof reply === 'object') return { reply };
  } catch {
    // not an answer at all
  }
  return { error: `unreadable answer: ${clip(stdout.trim(), 200)}` };
}

/**
 * Runs one phase and resolves to `{ reply }` or `{ error }`. Never rejects. `warn`
 * carries the one message this module can produce that is not a decision — a
 * `stroq.json` whose entry is gone — out to the Gateway's own logger.
 */
export function runStroq(config, phase, payload, abortSignal, warn = () => {}) {
  return new Promise((resolve) => {
    let argv;
    let stdin;
    try {
      argv = stroqArgv(config, warn);
      stdin = JSON.stringify(payload);
    } catch (err) {
      resolve({ error: `cannot build the hook call: ${String(err)}` });
      return;
    }
    const [bin, ...rest] = argv;
    const child = spawn(bin, [...rest, 'hook', 'openclaw', phase], { signal: abortSignal });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const ms = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ error: `no answer in ${ms} ms` });
    }, ms);
    // Bytes, not UTF-16 code units: a cap called BYTES that counted `String.length`
    // would let a reply of multi-byte characters buffer several times its own limit.
    const checkSize = () => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= MAX_OUTPUT_BYTES) return;
      child.kill('SIGKILL');
      finish({ error: `the reply exceeded ${MAX_OUTPUT_BYTES} bytes and was cut off` });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      checkSize();
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      checkSize();
    });
    child.stdin.on('error', () => {});
    child.on('error', (err) => finish({ error: `cannot run ${bin}: ${err.message}` }));
    child.on('close', (code) => finish(replyOf(code, stdout, stderr)));
    child.stdin.end(stdin);
  });
}
