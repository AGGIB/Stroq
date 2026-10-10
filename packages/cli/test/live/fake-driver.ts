// A stand-in for a host, in process, with the faults a real one could have.
//
// WHAT THIS PROVES. The orchestration of `verifyHost` (what it asks of a driver, in what order, how it
// stops, what it spends from the ledger), the evidence rules (what a run, an audit log and a file on the
// disk are taken to show), and the persistence of the result. In `honest` mode the hook's side is not
// imitated: the real engine runs in process on the real probe command, with the policy that is in the
// throwaway home, and writes its audit entries to the throwaway home exactly as `stroq hook` would,
// through the real Claude Code adapter. The file effects of the three probe commands are done natively
// with `node:fs` inside the project. Nothing is shelled out, so nothing the model-less double does can
// reach anything but the temporary directories it is given.
//
// THE CONTRACT OF A CONTROL. A control run is the real run with the hook taken out and nothing else changed
// (`types.ts`, on `HostDriver`). The double records, for every request, what a real driver would have
// started its host with (`invocationFor`), so that `driver-contract.test.ts` can hold the real run and the
// control to it; `noop-explicit-allow` is the driver that breaks it, and `verifyHost` has to see through it.
//
// WHAT THIS DOES NOT PROVE. Anything about a real host. Whether Claude Code stops a command when a
// hook says deny, what its stream looks like, how it words a limit, whether its exit code or its
// permission layer behave as the faults below assume: all of that is what the double is told, and what
// it is told is the author's reading of those hosts. A result produced with this double is labelled
// `stand-in`, and the state rule does not count it for the host (`states.ts`).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_POLICY, loadPolicyFile, type Policy } from '@stroq/core';
import { handleClaudeHook } from '../../src/adapters/claude-code.js';
import { createEngineAt } from '../../src/engine-factory.js';
import { ALLOW_FILE, DENY_FILE, EGRESS_FILE, promptFor } from '../../src/live/probes.js';
import type {
  HostDriver,
  HostRun,
  Probe,
  ProbeContext,
  StreamEvent,
} from '../../src/live/types.js';
import type { Invocation } from './driver-contract.js';

/**
 * How the double misbehaves.
 *
 * - `honest`            the hook is called, and the host obeys it.
 * - `ignore-deny`       the hook is called and says deny; the host runs the command anyway.
 * - `never-call-hook`   the host never calls the hook; the command runs; no audit entry exists.
 * - `crash-fail-open`   the hook crashes, which the host treats as an allow; no audit entry exists.
 * - `noop-hook`         the hook is a no-op that always allows (what the control run installs).
 * - `host-blocks-all`   the hook is called, but the host's own permissions block every command.
 * - `refusal`           the model declines to issue the command.
 * - `limit`             the host stops on a usage limit, in words only.
 * - `limit-flagged`     the same, with the driver reporting it as `limitHit`.
 * - `extra-command`     the hook is called and the host obeys it, and the model runs a second command too.
 * - `altered-command`   the model runs the command with more after it, which the hook (if it is
 *                       there) judges as it is. The model's doing, so it holds in a control run too.
 * - `garbage`           the stream cannot be read at all.
 * - `timeout`           the host does not answer in time.
 * - `host-error`        the host exits with an error and no explanation.
 * - `api-billing`       the host says it is billed to an API key.
 * - `wrong-cwd`         the host runs as an honest one would, in a directory that is not the project.
 * - `host-ignores-hook-but-blocks`
 *                       the allow runs; the deny and egress probes are stopped by the host's own permission
 *                       rules, in the host's own words, whatever the hook says: a host that does not honour a
 *                       hook's deny, which only looks like one that does.
 * - `noop-explicit-allow`
 *                       a driver that breaks the contract of a control: its no-op hook says "allow", which
 *                       skips the host's own permission step. The real run of a deny probe is stopped by the
 *                       host's own rules, and the control, with that step skipped, runs the command.
 */
export type Fault =
  | 'honest'
  | 'ignore-deny'
  | 'never-call-hook'
  | 'crash-fail-open'
  | 'noop-hook'
  | 'host-blocks-all'
  | 'refusal'
  | 'limit'
  | 'limit-flagged'
  | 'extra-command'
  | 'altered-command'
  | 'garbage'
  | 'timeout'
  | 'host-error'
  | 'api-billing'
  | 'wrong-cwd'
  | 'host-ignores-hook-but-blocks'
  | 'noop-explicit-allow';

export interface FakeCall {
  readonly probeId: string;
  readonly hookMode: 'real' | 'noop';
  readonly sessionId: string;
  readonly nonce: string;
  readonly fault: Fault;
  /** What a real driver would have started its host with for this request. */
  readonly invocation: Invocation;
}

export interface FakeOptions {
  /** One fault for every request, or a choice per request. */
  readonly fault: Fault | ((probe: Probe, ctx: ProbeContext) => Fault);
  /** The policy the double's hook judges under. By default the `policy.yaml` of the throwaway home. */
  readonly hookPolicy?: Policy;
  readonly available?: boolean;
  readonly version?: string | null;
  readonly note?: string;
  /** The hook is given a session of the host's own making and not the one the check asked for. */
  readonly hostSession?: boolean;
}

/** What a fault does when the hook is a no-op (the control run): the hook-side faults all become that. */
const HOOK_SIDE: ReadonlySet<Fault> = new Set<Fault>([
  'honest',
  'extra-command',
  'ignore-deny',
  'never-call-hook',
  'crash-fail-open',
  'noop-hook',
]);

const INIT: StreamEvent = { type: 'init', text: 'fake host' };

/** What the model runs in `extra-command`, besides the probe. */
const EXTRA_COMMAND = 'ls -la';
/** What the model adds after the probe in `altered-command`. */
const ALTERATION = '; echo more';

/** A run that ended as a run ends, in the directory the host was started in (as its init message says). */
function ended(
  ctx: ProbeContext,
  events: readonly StreamEvent[],
  over: Partial<HostRun> = {},
): HostRun {
  return {
    stream: [INIT, ...events, { type: 'result', isError: false, text: 'DONE' }],
    exitCode: 0,
    timedOut: false,
    stderrTail: '',
    apiProvider: 'firstParty',
    apiKeySource: 'none',
    cwd: ctx.project,
    ...over,
  };
}

/** The effect of a probe's command, done with `node:fs` in the project: no shell, no network. */
function perform(probe: Probe, ctx: ProbeContext): void {
  switch (probe.id) {
    case 'allow':
      writeFileSync(join(ctx.project, ALLOW_FILE), `${ctx.nonce}\n`);
      return;
    case 'deny':
      mkdirSync(join(ctx.project, '.git', 'hooks'), { recursive: true });
      // Not executable, as the real command leaves it.
      writeFileSync(join(ctx.project, DENY_FILE), `${ctx.nonce}\n`, { mode: 0o644 });
      return;
    case 'secret-egress':
      writeFileSync(join(ctx.project, EGRESS_FILE), `${ctx.nonce}\n`);
      return;
    default:
      throw new Error(`the double does not know the probe ${probe.id}`);
  }
}

/** The hook of a control run: it exits 0 and says nothing, so the host goes on as if no hook were there. */
const NOOP_HOOK = 'true';

/**
 * What a real driver would start its host with for this request (the argv and settings the plan gives for
 * Claude Code, in the parts `driver-contract.ts` holds a control to). The real run and the control are
 * started alike but for the hook, which is the one thing that is not alike; `noop-explicit-allow` is the
 * driver that lets the hook of its control say "allow", and so breaks the contract.
 */
export function invocationFor(
  probe: Probe,
  ctx: ProbeContext,
  decides: 'nothing' | 'allow' = 'nothing',
): Invocation {
  return {
    nonce: ctx.nonce,
    prompt: promptFor(probe),
    model: 'haiku',
    sessionId: ctx.sessionId,
    flags: [
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--setting-sources',
      'project',
      '--strict-mcp-config',
      '--tools',
      'Bash',
    ],
    settings: {},
    permissions: { mode: 'dontAsk', allow: ['Bash(echo:*)', 'Bash(mkdir:*)', 'Bash(curl:*)'] },
    hook:
      ctx.hookMode === 'real'
        ? {
            command: `env HOME=${ctx.home} STROQ_HOME=${ctx.stroqHome} stroq hook claude-code`,
            decides: 'nothing',
          }
        : { command: NOOP_HOOK, decides },
    cwd: ctx.project,
    env: ctx.env,
  };
}

/** The faults that are a way of behaving per kind of probe and hook, and not a way of behaving of their own. */
type Composite = 'host-ignores-hook-but-blocks' | 'noop-explicit-allow';
type BaseFault = Exclude<Fault, Composite>;

/** What a fault comes to for a probe of this kind, run with the hook the context says. */
function effectiveFault(chosen: Fault, kind: Probe['kind'], mode: 'real' | 'noop'): BaseFault {
  if (chosen === 'host-ignores-hook-but-blocks')
    return kind === 'allow' ? 'honest' : 'host-blocks-all';
  if (chosen === 'noop-explicit-allow') {
    if (kind === 'allow') return 'honest';
    return mode === 'noop' ? 'noop-hook' : 'host-blocks-all';
  }
  return mode === 'noop' && HOOK_SIDE.has(chosen) ? 'noop-hook' : chosen;
}

export class FakeHostDriver implements HostDriver {
  readonly mode = 'stand-in' as const;
  /** Every request made of the double, in order. */
  readonly calls: FakeCall[] = [];
  detections = 0;

  constructor(private readonly options: FakeOptions) {}

  detect(): Promise<{ available: boolean; version: string | null; note?: string }> {
    this.detections += 1;
    return Promise.resolve({
      available: this.options.available ?? true,
      version: this.options.version === undefined ? '9.9.9-fake' : this.options.version,
      ...(this.options.note === undefined ? {} : { note: this.options.note }),
    });
  }

  private chosenFault(probe: Probe, ctx: ProbeContext): Fault {
    return typeof this.options.fault === 'function'
      ? this.options.fault(probe, ctx)
      : this.options.fault;
  }

  /** What the hook says, by the real engine and the real adapter. Writes the audit entry as the hook does. */
  private async consultHook(
    probe: Probe,
    ctx: ProbeContext,
    command: string = probe.command,
  ): Promise<{ stopped: boolean; reason: string }> {
    const file = join(ctx.stroqHome, 'policy.yaml');
    const policy =
      this.options.hookPolicy ?? (existsSync(file) ? loadPolicyFile(file) : DEFAULT_POLICY);
    const engine = createEngineAt({ home: ctx.stroqHome, userHome: ctx.home, policy, env: {} });
    const out = await handleClaudeHook(engine, {
      session_id: this.options.hostSession === true ? `host-chose-${probe.id}` : ctx.sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
      cwd: ctx.project,
    });
    if (out.stdout === '') return { stopped: false, reason: '' };
    const said = (
      JSON.parse(out.stdout) as {
        hookSpecificOutput: { permissionDecisionReason: string };
      }
    ).hookSpecificOutput;
    // A host that cannot ask a person treats an ask as a refusal, as `claude -p` does.
    return { stopped: true, reason: said.permissionDecisionReason };
  }

  async run(probe: Probe, ctx: ProbeContext): Promise<HostRun> {
    const chosen = this.chosenFault(probe, ctx);
    const fault = effectiveFault(chosen, probe.kind, ctx.hookMode);
    this.calls.push({
      probeId: probe.id,
      hookMode: ctx.hookMode,
      sessionId: ctx.sessionId,
      nonce: ctx.nonce,
      fault,
      invocation: invocationFor(
        probe,
        ctx,
        chosen === 'noop-explicit-allow' && ctx.hookMode === 'noop' ? 'allow' : 'nothing',
      ),
    });
    const call: StreamEvent = { type: 'tool_use', name: 'Bash', input: { command: probe.command } };
    const ran: StreamEvent = { type: 'tool_result', isError: false, text: '' };

    switch (fault) {
      case 'refusal':
        return ended(ctx, [{ type: 'text', text: 'I will not run that command.' }]);
      case 'limit':
        return {
          stream: [
            INIT,
            { type: 'result', isError: true, text: 'Claude AI usage limit reached|1760000000' },
          ],
          exitCode: 1,
          timedOut: false,
          stderrTail: '',
        };
      case 'limit-flagged':
        return { ...ended(ctx, []), limitHit: 'usage limit reached' };
      case 'garbage':
        return { stream: [], exitCode: 0, timedOut: false, stderrTail: '', unparsedLines: 9 };
      case 'timeout':
        return { stream: [INIT], exitCode: null, timedOut: true, stderrTail: '' };
      case 'host-error':
        return { stream: [INIT], exitCode: 1, timedOut: false, stderrTail: 'boom' };
      case 'noop-hook':
      case 'never-call-hook':
        perform(probe, ctx);
        return ended(ctx, [call, ran, { type: 'text', text: 'DONE' }]);
      case 'crash-fail-open':
        perform(probe, ctx);
        return ended(ctx, [call, ran, { type: 'text', text: 'DONE' }], {
          stderrTail: 'hook exited with an error (non-blocking)',
        });
      case 'host-blocks-all': {
        // The hook is consulted when it is a real one; the host's own rules stop the command all the same.
        if (ctx.hookMode === 'real') await this.consultHook(probe, ctx);
        const refusal: StreamEvent = {
          type: 'tool_result',
          isError: true,
          text: 'Permission to use Bash has been denied.',
        };
        return ended(ctx, [call, refusal, { type: 'text', text: 'BLOCKED' }]);
      }
      case 'ignore-deny': {
        await this.consultHook(probe, ctx);
        perform(probe, ctx);
        return ended(ctx, [call, ran, { type: 'text', text: 'DONE' }]);
      }
      case 'extra-command': {
        const verdict = await this.consultHook(probe, ctx);
        const extra = await this.consultHook(probe, ctx, EXTRA_COMMAND);
        if (!verdict.stopped) perform(probe, ctx);
        const results: StreamEvent[] = [verdict, extra].map((v) => ({
          type: 'tool_result',
          isError: v.stopped,
          text: v.stopped ? v.reason : '',
        }));
        return ended(ctx, [
          call,
          { type: 'tool_use', name: 'Bash', input: { command: EXTRA_COMMAND } },
          ...results,
          { type: 'text', text: 'DONE' },
        ]);
      }
      case 'altered-command': {
        const altered = `${probe.command}${ALTERATION}`;
        const verdict =
          ctx.hookMode === 'noop'
            ? { stopped: false, reason: '' }
            : await this.consultHook(probe, ctx, altered);
        if (!verdict.stopped) perform(probe, ctx);
        return ended(ctx, [
          { type: 'tool_use', name: 'Bash', input: { command: altered } },
          {
            type: 'tool_result',
            isError: verdict.stopped,
            text: verdict.stopped ? verdict.reason : '',
          },
          { type: 'text', text: 'DONE' },
        ]);
      }
      case 'api-billing':
      case 'wrong-cwd':
      case 'honest': {
        const verdict = await this.consultHook(probe, ctx);
        // What the host says of itself besides what it did.
        const says: Partial<HostRun> =
          fault === 'api-billing'
            ? { apiKeySource: 'ANTHROPIC_API_KEY' }
            : fault === 'wrong-cwd'
              ? { cwd: ctx.home }
              : {};
        if (verdict.stopped) {
          const blocked: StreamEvent = { type: 'tool_result', isError: true, text: verdict.reason };
          return ended(ctx, [call, blocked, { type: 'text', text: 'BLOCKED' }], says);
        }
        perform(probe, ctx);
        return ended(ctx, [call, ran, { type: 'text', text: 'DONE' }], says);
      }
    }
  }
}
