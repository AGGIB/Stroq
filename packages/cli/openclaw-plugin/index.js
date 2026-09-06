// Stroq plugin for OpenClaw: turns `before_tool_call` / `after_tool_call` into
// `stroq hook openclaw pre|post` child-process calls. Fail-closed by construction:
// a missing binary, a spawn error, a non-zero exit, a timeout, an aborted run,
// stdout that is not JSON, or a decision this file does not know all block the call.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESCRIPTION =
  'Local action firewall for OpenClaw: scans what the agent reads, taints the session, blocks or asks before dangerous tool calls.';
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_ASK_TIMEOUT_MS = 120000;
const MAX_TITLE = 80;
const MAX_DESCRIPTION = 512;
const load = createRequire(import.meta.url);

/** `definePluginEntry`, from whichever SDK path this Gateway build exposes. */
function resolveDefinePluginEntry() {
  for (const id of ['openclaw/plugin-sdk/plugin-entry', 'openclaw/plugin-sdk/core']) {
    try {
      const mod = load(id);
      const fn = mod?.definePluginEntry ?? mod?.default?.definePluginEntry;
      if (typeof fn === 'function') return fn;
    } catch {
      // not exposed by this build; try the next id, then fall back to bare `register`
    }
  }
  return null;
}

const text = (value) => (typeof value === 'string' && value !== '' ? value : '');
const clip = (value, max) => (value.length <= max ? value : `${value.slice(0, max - 3)}...`);

/** Logging never decides anything: an absent logger is skipped and a throwing one is swallowed. */
function logAt(api, level, message) {
  const fn = api && api.logger && api.logger[level];
  try {
    if (typeof fn === 'function') fn.call(api.logger, message);
  } catch {}
}

/**
 * argv of the Stroq CLI: this plugin's config, then STROQ_BIN, then the `stroq.json`
 * `stroq init --agent openclaw` wrote beside this file, then `stroq` on PATH.
 * `stroqBin`/`STROQ_BIN` are word-split, so either may also name a full command
 * (e.g. "node /opt/stroq/dist/index.js") rather than only a bare path.
 */
function stroqArgv(config) {
  const configured = text(config.stroqBin) || text(process.env.STROQ_BIN);
  if (configured) return configured.split(' ').filter((word) => word !== '');
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
function runStroq(config, phase, payload, abortSignal) {
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
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.stdin.on('error', () => {});
    child.on('error', (err) => finish({ error: `cannot run ${bin}: ${err.message}` }));
    child.on('close', (code) => finish(replyOf(code, stdout, stderr)));
    child.stdin.end(stdin);
  });
}

/** Both phases' payload; only `exec` declares its own directory, so the rest fall back. */
function payloadFor(phase, event, ctx, config) {
  const params = event.params && typeof event.params === 'object' ? event.params : {};
  const c = ctx || {};
  const base = {
    sessionId: text(c.sessionKey) || text(c.sessionId) || 'openclaw',
    agentId: c.agentId,
    runId: c.runId ?? event.runId,
    toolCallId: c.toolCallId ?? event.toolCallId,
    toolKind: event.toolKind ?? c.toolKind,
    requester: c.requester,
    toolName: text(event.toolName),
    params,
    cwd: text(params.cwd) || text(config.workspace) || process.cwd(),
  };
  if (phase === 'pre') return base;
  return { ...base, result: event.result, error: event.error, durationMs: event.durationMs };
}

/** `ask` as OpenClaw's approval request, inside its documented 80/512 caps. */
function approval(api, event, reply, config) {
  const ms = Number(config.askTimeoutMs) > 0 ? Number(config.askTimeoutMs) : DEFAULT_ASK_TIMEOUT_MS;
  return {
    title: clip(`Stroq: ${text(reply.ruleId) || 'policy'}`, MAX_TITLE),
    description: clip(text(reply.reason) || 'Stroq asks before this action.', MAX_DESCRIPTION),
    severity: 'warning',
    // `allow-always` is deliberately not offered: Stroq audits every ask, and a
    // remembered allow is one it would never be asked about again.
    allowedDecisions: ['allow-once', 'deny'],
    timeoutMs: ms,
    onResolution: (decision) =>
      logAt(api, 'info', `stroq: approval ${decision} for ${text(event.toolName)}`),
  };
}

export function register(api) {
  const config = (api && api.pluginConfig) || {};
  const block = (event, detail) => {
    logAt(api, 'warn', `stroq: ${text(event && event.toolName) || 'tool'}: ${detail}`);
    return { block: true, blockReason: `Stroq internal error (fail-closed): ${detail}` };
  };
  // Priority 100 so Stroq answers before ordinary hooks, and no matcher: every tool
  // goes through Stroq, and one it does not care about answers allow in ~100 ms.
  api.on(
    'before_tool_call',
    async (event, ctx) => {
      let outcome;
      try {
        const payload = payloadFor('pre', event, ctx, config);
        outcome = await runStroq(config, 'pre', payload, ctx?.abortSignal);
      } catch (err) {
        return block(event, `cannot read the tool call: ${String(err)}`);
      }
      if (outcome.error) return block(event, outcome.error);
      const reply = outcome.reply;
      if (reply.decision === 'allow') return undefined;
      if (reply.decision === 'ask') return { requireApproval: approval(api, event, reply, config) };
      if (reply.decision === 'deny')
        return {
          block: true,
          blockReason: `Stroq blocked this action (${text(reply.ruleId) || 'policy'}): ${text(reply.reason) || 'no reason given'}`,
        };
      return block(event, `unknown decision ${JSON.stringify(reply.decision)}`);
    },
    { priority: 100 },
  );
  // Observe-only, and it must never throw: the tool has already run, the return value
  // is ignored, and the taint the scan sets is enforced on the NEXT call.
  api.on('after_tool_call', async (event, ctx) => {
    try {
      const payload = payloadFor('post', event, ctx, config);
      const outcome = await runStroq(config, 'post', payload, ctx?.abortSignal);
      if (outcome.error) logAt(api, 'debug', `stroq: post scan failed: ${outcome.error}`);
      else if (text(outcome.reply.warning)) logAt(api, 'warn', `stroq: ${outcome.reply.warning}`);
    } catch (err) {
      logAt(api, 'debug', `stroq: post scan failed: ${String(err)}`);
    }
  });
}

const definePluginEntry = resolveDefinePluginEntry();
export default definePluginEntry
  ? definePluginEntry({ id: 'stroq', name: 'Stroq', description: DESCRIPTION, register })
  : register;
