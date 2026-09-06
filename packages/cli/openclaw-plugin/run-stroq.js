// Spawns the Stroq CLI for one hook phase and resolves to `{ reply }` or `{ error }`,
// never rejecting: every failure this plugin can see — a missing binary, a spawn
// error, a non-zero exit, a timeout, an aborted run, an oversized reply, or stdout
// that is not JSON — becomes an `{ error }` for index.js to turn into a block.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 10000;
// A reply this large is not a decision Stroq ever sends; it is a hung or misbehaving
// CLI, and buffering it further would only delay the same block.
const MAX_OUTPUT_BYTES = 1024 * 1024;

export const text = (value) => (typeof value === 'string' && value !== '' ? value : '');
export const clip = (value, max) => (value.length <= max ? value : `${value.slice(0, max - 3)}...`);

/**
 * argv of the Stroq CLI: this plugin's config, then STROQ_BIN, then the `stroq.json`
 * `stroq init --agent openclaw` wrote beside this file, then `stroq` on PATH.
 * `stroqBin`/`STROQ_BIN` is always ONE path and is never split on whitespace: a real
 * install path can legitimately contain a space, and a launch command needing extra
 * arguments belongs in `stroq.json`'s `command` array instead (already written by
 * `stroq init --agent openclaw`), which is array-shaped for exactly this reason.
 */
function stroqArgv(config) {
  const configured = text(config.stroqBin) || text(process.env.STROQ_BIN);
  if (configured) return [configured];
  const file = join(HERE, 'stroq.json');
  try {
    const argv = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).command : null;
    if (Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === 'string'))
      return argv;
  } catch {
    // unreadable or not JSON: fall through to PATH
  }
  return ['stroq'];
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

/** Runs one phase and resolves to `{ reply }` or `{ error }`. Never rejects. */
export function runStroq(config, phase, payload, abortSignal) {
  return new Promise((resolve) => {
    let argv;
    let stdin;
    try {
      argv = stroqArgv(config);
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
    const checkSize = () => {
      if (stdout.length + stderr.length <= MAX_OUTPUT_BYTES) return;
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
