// The order of `stroq prove`, from the command line to the exit code.
//
// Whatever can say no does so first, before a request is spent or a folder is made: an agent there is no
// driver for, a system the check does not run on, a host that is not there, a ledger that cannot be used,
// a policy that cannot be read, a person who has not agreed. Only then is the check run (`prove-run.ts`).
// The first few are outcomes of their own and not errors: the command says so and exits 3, the code of
// everything that is not verified.
import type { Policy } from '@stroq/core';
import { loadPolicy, policySource } from '../engine-factory.js';
import { capabilitiesFor } from '../hosts/capabilities.js';
import { LEDGER_ENV, ledgerFromEnv, openLedger, type Ledger } from '../live/budget.js';
import { DRIVEN_AGENTS, driverFor } from '../live/drivers/index.js';
import type { HostDriver } from '../live/types.js';
import { DEFAULT_DETECT_MS, lookForHost } from '../live/verify-input.js';
import { neutralizeControls } from '../terminal-safe.js';
import { outsideLine } from '../ui/layout.js';
import { stroqVersion } from '../version.js';
import type { ProveOptions } from './prove.js';
import {
  EXIT_NOT_VERIFIED,
  EXIT_USAGE,
  EXIT_VERIFIED,
  declinedReport,
  dryRunReport,
  exitCodeOf,
  hostNotFoundReport,
  notRunReport,
  reportOf,
  unsupportedReport,
  windowsReport,
  type ProveReport,
} from './prove-report.js';
import { defaultHookLine, describeFailure, keep, runCheck } from './prove-run.js';
import { dryRunText, noticeText, renderReport } from './prove-text.js';
import type { Io, ProveDeps } from './prove-types.js';

/** Writers that cannot put a control character on a terminal, whatever is handed to them. */
function ioOf(deps: ProveDeps): Io {
  const out = deps.out ?? ((text: string): void => void process.stdout.write(text));
  const err = deps.err ?? ((text: string): void => void process.stderr.write(text));
  return {
    out: (text) => out(neutralizeControls(text)),
    err: (text) => err(neutralizeControls(text)),
  };
}

type Env = Readonly<Record<string, string | undefined>>;

/** The report of a check that cannot be run for this agent or on this system, or null when it can. */
function gateReport(agent: string, platform: NodeJS.Platform): ProveReport | null {
  if (!DRIVEN_AGENTS.includes(agent))
    return unsupportedReport(agent, capabilitiesFor(agent)?.reason, DRIVEN_AGENTS);
  if (agent === 'codex' && platform !== 'win32')
    return notRunReport(
      agent,
      'unsupported',
      null,
      'Codex live protection is measured on Windows only; this platform is unmeasured',
      ['Use Windows with the measured Codex CLI version. No inference request was made.'],
    );
  return platform === 'win32' && agent !== 'codex' ? windowsReport(agent) : null;
}

/** Prints a report, as a document of JSON or as words, and says what it exits with. */
function conclude(io: Io, options: ProveOptions, report: ProveReport, after = ''): number {
  io.out(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderReport(report)}${after}`);
  return exitCodeOf(report);
}

/** The ledger the requests are counted in: the owner's file when it is named, else this run's own count. */
function ledgerFor(env: Env, maxRequests: number): Ledger {
  const named = env[LEDGER_ENV];
  return named !== undefined && named !== ''
    ? ledgerFromEnv(env)
    : openLedger({ memory: true, limit: maxRequests });
}

/** What can refuse a run and costs nothing to find out: the ledger and the policy, or why not. */
function prepare(
  options: ProveOptions,
  env: Env,
): { readonly ledger: Ledger; readonly policy: Policy } | string {
  try {
    return { ledger: ledgerFor(env, options.maxRequests), policy: loadPolicy() };
  } catch (err) {
    return describeFailure(err);
  }
}

type Consent = 'agreed' | 'declined' | 'not-asked';

/** Whether the person agrees to the cost: said in advance with --yes, or answered on a terminal. */
async function consentOf(options: ProveOptions, deps: ProveDeps): Promise<Consent> {
  if (options.yes) return 'agreed';
  const term = deps.terminal ?? (await import('../ui/terminal.js')).currentTerminal();
  if (!term.interactive) return 'not-asked';
  const [{ confirm }, { styleFor }] = await Promise.all([
    import('../ui/prompt.js'),
    import('../ui/style.js'),
  ]);
  return (await confirm(term, styleFor(term), 'Make the check?', false)) ? 'agreed' : 'declined';
}

/** The plan of a dry run: what would be asked of which host, and nothing done. */
function dryRun(
  io: Io,
  options: ProveOptions,
  hostVersion: string | null,
  hookLine: string,
): number {
  if (options.json) {
    conclude(io, options, dryRunReport(options.agent, hostVersion));
    return EXIT_VERIFIED;
  }
  const plan = dryRunText({
    agent: options.agent,
    hostVersion,
    maxRequests: options.maxRequests,
    policy: policySource(),
    hookLine,
  });
  io.out(`${plan.join('\n')}\n`);
  return EXIT_VERIFIED;
}

interface Hosted {
  readonly driver: HostDriver;
  readonly controller: AbortController;
  readonly hostVersion: string | null;
}

/** Runs the check, keeps what it found, and prints it. */
async function checkAndShow(
  options: ProveOptions,
  deps: ProveDeps,
  io: Io,
  hosted: Hosted,
  ready: { readonly ledger: Ledger; readonly policy: Policy },
): Promise<number> {
  let result;
  try {
    result = await runCheck({
      agent: options.agent,
      driver: hosted.driver,
      policy: ready.policy,
      stroqVersion: stroqVersion(),
      ledger: ready.ledger,
      maxRequests: options.maxRequests,
      env: deps.env ?? process.env,
      controller: hosted.controller,
      signals: deps.signals ?? process,
      reraise: deps.reraise ?? ((signal) => void process.kill(process.pid, signal)),
      say: io.err,
      warn: io.err,
      now: deps.now,
      ids: deps.ids,
    });
  } catch (err) {
    io.err(`stroq prove: the check stopped: ${outsideLine(describeFailure(err))}\n`);
    return EXIT_NOT_VERIFIED;
  }
  const kept = keep(result);
  const code = conclude(
    io,
    options,
    reportOf(result),
    kept.kept ? `Result kept in ${outsideLine(kept.file)}\n` : '',
  );
  if (!kept.kept) io.err(`stroq prove: could not keep the result: ${outsideLine(kept.problem)}\n`);
  return code;
}

/** From the notice of the cost to the end: the part that spends. */
async function spend(
  options: ProveOptions,
  deps: ProveDeps,
  io: Io,
  hosted: Hosted,
): Promise<number> {
  const ready = prepare(options, deps.env ?? process.env);
  if (typeof ready === 'string') {
    io.err(`stroq prove: ${outsideLine(ready)}\n`);
    return EXIT_NOT_VERIFIED;
  }
  const notice = noticeText({
    agent: options.agent,
    hostVersion: hosted.hostVersion,
    maxRequests: options.maxRequests,
  });
  (options.json ? io.err : io.out)(`${notice.join('\n')}\n\n`);
  const consent = await consentOf(options, deps);
  if (consent === 'not-asked') {
    io.err(
      'stroq prove: this is not a terminal, so it will not make requests on your login without --yes.\nRun: stroq prove --yes\n',
    );
    return EXIT_USAGE;
  }
  if (consent === 'declined')
    return conclude(io, options, declinedReport(options.agent, hosted.hostVersion));
  return checkAndShow(options, deps, io, hosted, ready);
}

export async function proveFlow(options: ProveOptions, deps: ProveDeps): Promise<number> {
  const io = ioOf(deps);
  const gate = gateReport(options.agent, deps.platform ?? process.platform);
  if (gate !== null) return conclude(io, options, gate);
  const env = deps.env ?? process.env;
  const controller = new AbortController();
  const hookLine = deps.hookLine ?? defaultHookLine(options.agent);
  const driver = (
    deps.makeDriver ?? ((line, signal) => driverFor(options.agent, { hookLine: line, env, signal }))
  )(hookLine, controller.signal);
  if (driver === null)
    return conclude(io, options, unsupportedReport(options.agent, undefined, DRIVEN_AGENTS));
  const found = await lookForHost(driver, DEFAULT_DETECT_MS);
  if (!found.available) return conclude(io, options, hostNotFoundReport(options.agent, found.note));
  if (options.dryRun) return dryRun(io, options, found.version, hookLine);
  return spend(options, deps, io, { driver, controller, hostVersion: found.version });
}
