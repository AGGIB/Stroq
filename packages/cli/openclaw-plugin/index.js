// Stroq plugin for OpenClaw: turns `before_tool_call` / `after_tool_call` into
// `stroq hook openclaw pre|post` child-process calls (spawning is in run-stroq.js).
// Fail-closed by construction — every one of these blocks the call: a missing binary,
// a spawn error, a non-zero exit, a timeout, an aborted run, a reply larger than
// 1 MiB, params that cannot be serialised, stdout that is not JSON or is JSON but not
// an object, and a decision this file does not know.
import { createRequire } from 'node:module';
import { clip, runStroq, text } from './run-stroq.js';

const DESCRIPTION =
  'Local action firewall for OpenClaw: scans what the agent reads, taints the session, blocks or asks before dangerous tool calls.';
const DEFAULT_ASK_TIMEOUT_MS = 120000;
// OpenClaw's own documented bounds for an approval prompt. A `timeoutMs` past the
// maximum is not a longer prompt, it is a `requireApproval` the Gateway may reject
// outright — and a rejected approval is a call nobody was ever asked about.
const MIN_ASK_TIMEOUT_MS = 1000;
const MAX_ASK_TIMEOUT_MS = 600000;
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

/** Logging never decides anything: an absent logger is skipped and a throwing one is swallowed. */
function logAt(api, level, message) {
  const fn = api && api.logger && api.logger[level];
  try {
    if (typeof fn === 'function') fn.call(api.logger, message);
  } catch {}
}

/**
 * Both phases' payload. `cwd` is always the plugin's OWN directory — `config.workspace`,
 * else `process.cwd()` — and never a tool call's `params.cwd`: honouring a
 * model-supplied `cwd` here would let any tool point the project directory (and so
 * the secret index) at an empty one and walk straight past a secret-egress guard.
 * `exec` is no exception: the CLI adapter also never reads `params.cwd` for this
 * (Task 4.5 review, Critical — it used to, and that was the actual bypass). `params`
 * is still forwarded whole regardless, `cwd` included, purely for the audit trail.
 */
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
    cwd: text(config.workspace) || process.cwd(),
  };
  if (phase === 'pre') return base;
  return { ...base, result: event.result, error: event.error, durationMs: event.durationMs };
}

/** How long the prompt stays open, clamped to the range OpenClaw documents. */
function askTimeout(config) {
  const configured = Number(config.askTimeoutMs);
  if (!(configured > 0)) return DEFAULT_ASK_TIMEOUT_MS;
  return Math.min(Math.max(configured, MIN_ASK_TIMEOUT_MS), MAX_ASK_TIMEOUT_MS);
}

/** `ask` as OpenClaw's approval request, inside its documented 80/512/600 000 caps. */
function approval(api, event, reply, config) {
  const ms = askTimeout(config);
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
  // `detail` is clipped like a child's stderr: it is a block reason shown to a user.
  const block = (event, detail) => {
    const clipped = clip(String(detail), 300);
    logAt(api, 'warn', `stroq: ${text(event && event.toolName) || 'tool'}: ${clipped}`);
    return { block: true, blockReason: `Stroq internal error (fail-closed): ${clipped}` };
  };
  // A stale `stroq.json` entry is reported at `warn`: the operator should repair it.
  const warn = (message) => logAt(api, 'warn', `stroq: ${message}`);
  // Priority 100 so Stroq answers before ordinary hooks; no matcher, every tool goes through.
  api.on(
    'before_tool_call',
    async (event, ctx) => {
      let outcome;
      try {
        const payload = payloadFor('pre', event, ctx, config);
        outcome = await runStroq(config, 'pre', payload, ctx?.abortSignal, warn);
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
  // Observe-only and never throws; the taint it sets is enforced on the NEXT call. The
  // abort signal is not forwarded: a cancelled run's result must still be scanned.
  api.on('after_tool_call', async (event, ctx) => {
    try {
      const payload = payloadFor('post', event, ctx, config);
      const outcome = await runStroq(config, 'post', payload, undefined, warn);
      // `warn`: a scan nobody looked at leaves the session untainted; operators must see it.
      if (outcome.error) logAt(api, 'warn', `stroq: post scan failed: ${outcome.error}`);
      else if (text(outcome.reply.warning)) logAt(api, 'warn', `stroq: ${outcome.reply.warning}`);
    } catch (err) {
      logAt(api, 'warn', `stroq: post scan failed: ${String(err)}`);
    }
  });
}

const definePluginEntry = resolveDefinePluginEntry();
export default definePluginEntry
  ? definePluginEntry({ id: 'stroq', name: 'Stroq', description: DESCRIPTION, register })
  : register;
