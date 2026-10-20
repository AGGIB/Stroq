import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  FAIL_ON,
  isFailing,
  tagChanges,
  type FailOn,
  type TaggedHit,
} from '../exposure/agent-change.js';
import { GitError, agentChanges, type AgentChanges } from '../exposure/agent-git.js';
import { groupHits, textGroup, textNotices } from '../exposure/agent-report.js';
import type { AgentHit } from '../exposure/agent-surface.js';
import { agentSurface } from '../exposure/agent-tree.js';
import { hardeningExports } from '../exposure/git-hardening.js';
import { annotations, githubSummary, type PreTrustItem } from '../exposure/github-format.js';
import {
  WHY,
  folderSurface,
  repoFindings,
  repoSurface,
  type RepoExecKind,
  type RepoSurface,
} from '../exposure/repo-surface.js';
import { inspectSarif } from '../exposure/sarif.js';
import { neutralizeControls } from '../terminal-safe.js';
import { stroqVersion } from '../version.js';

/**
 * The pre-flight: what a repository will run, read before an agent opens it.
 *
 * `stroq exposure` answers the same question about the directory you are already in,
 * along with everything else about the machine. This one is deliberately narrow and
 * fast, because it is meant to run on a checkout you have not opened yet — which is
 * the only moment that helps against the shape it looks for.
 *
 * Stroq's hooks cannot cover that moment. On Claude Code the startup `git status`
 * runs before the workspace-trust prompt, and a `SessionStart` hook is itself gated
 * on that prompt, so nothing Stroq installs gets in front of it. Running this command
 * first does, which is why it exists as a command rather than as another hook.
 *
 * The same reading also covers what an agent or an editor runs by itself once the folder is
 * trusted: hooks, MCP servers, folder-open tasks. With `--changed-from` it compares those
 * with a base revision, which is the check a pull request needs: what did this change add?
 */

export { GIT_HARDENING, hardeningEnv, hardeningExports } from '../exposure/git-hardening.js';

/** Exit codes: nothing fails, something fails, the arguments were wrong, the check could not run. */
const EXIT = { pass: 0, fail: 1, usage: 2, error: 3 } as const;

/** The kind `repoSurface` and `folderSurface` report the same entry under, for the kinds both read. */
const SAME_ENTRY: Readonly<Partial<Record<AgentHit['kind'], RepoExecKind>>> = {
  'devcontainer-host-command': 'devcontainer-host-command',
  'devcontainer-command': 'devcontainer-command',
  'package-script': 'package-install-script',
};

const entryKey = (kind: string, file: string, what: string): string =>
  `${kind}\0${file.split('\\').join('/')}\0${what}`;

/** The key of the entry of the folder's reading that reports the same as `h`, when there is one. */
const sameEntry = (h: AgentHit): string | undefined => {
  const kind = SAME_ENTRY[h.kind];
  return kind === undefined ? undefined : entryKey(kind, h.file, h.name);
};

/**
 * Each entry once. One the reading of the folder reports as a finding (the same kind, file and
 * key) is left out of the agent entries. One it lists as ordinary is left out of them too, unless
 * it fails there: then it is shown with the findings, and left out of the ordinary list instead.
 */
function once(
  surface: RepoSurface,
  hits: readonly TaggedHit[],
): { surface: RepoSurface; hits: TaggedHit[] } {
  const keys = (list: RepoSurface['onOpen']) =>
    new Set(list.map((h) => entryKey(h.kind, h.file, h.what)));
  const findings = keys(surface.preTrust);
  const ordinary = keys(surface.onOpen);
  const kept = hits.filter((h) => {
    const key = sameEntry(h);
    if (key === undefined) return true;
    return !findings.has(key) && (!ordinary.has(key) || h.severity === 'error');
  });
  const shown = new Set(kept.flatMap((h) => sameEntry(h) ?? []));
  const onOpen = surface.onOpen.filter((h) => !shown.has(entryKey(h.kind, h.file, h.what)));
  return { surface: { ...surface, onOpen }, hits: kept };
}

export function formatInspect(
  dir: string,
  surface: RepoSurface,
  agent: readonly TaggedHit[] = [],
  failOn: FailOn = 'any',
  agentCapped = false,
): string {
  const findings = repoFindings(surface);
  const lines = [`stroq inspect — what ${dir} runs when you open it`, ''];

  if (!surface.isRepo) {
    // Git still reads a bare repository here, and direnv and husky do not need .git to be named.
    const quiet = findings.length === 0 && surface.onOpen.length === 0;
    lines.push(
      quiet
        ? 'This folder is not a git repository, so git runs nothing from it. Its agent and editor files are read below.'
        : 'This folder is not a git repository, but some of what it holds can still run: read the entries below. Its agent and editor files are read after them.',
      '',
    );
  }
  if (findings.length === 0) {
    if (surface.isRepo) lines.push('Nothing here runs before you approve it.', '');
  } else {
    lines.push(`BEFORE YOU APPROVE ANYTHING (${findings.length})`);
    for (const f of findings) {
      lines.push(`  ${f.detail}`);
      if (f.fix) lines.push(`    fix: ${f.fix}`);
    }
    lines.push('');
  }

  const groups = groupHits(agent, failOn);
  lines.push(
    ...textGroup(
      `TAKES EFFECT BY ITSELF ONCE YOU TRUST THE FOLDER (${groups.failing.length})`,
      groups.failing,
    ),
    ...textGroup(
      `ALSO TAKES EFFECT BY ITSELF (${groups.present.length}, not failing)`,
      groups.present,
    ),
  );
  if (surface.onOpen.length > 0) {
    lines.push(
      `When you open or build it (${surface.onOpen.length}, ordinary — not findings)`,
      ...surface.onOpen.map((h) => `  ${h.file} — ${h.what}`),
      '',
    );
  }
  if (surface.capped) {
    lines.push('The walk hit its cap, so the nested-repository count is a lower bound.', '');
  }
  if (agentCapped) {
    lines.push('The walk for agent files hit its cap, so files deeper in were not read.', '');
  }
  const agentErrors = agent.some((h) => h.severity === 'error');
  lines.push(
    findings.length > 0
      ? 'Read the entries above before you point an agent at this directory: they run during an ordinary `git status`, which every agent does at startup, before any prompt you could answer.'
      : agentErrors
        ? 'Read the entries above before you open this folder in an agent or editor. They take effect by themselves once you trust the folder.'
        : 'Open it. Stroq enforces the rest from inside the session.',
  );
  return `${lines.join('\n')}\n`;
}

/** Said when a limit kept the check from reading every agent file or link. */
const CAPPED =
  'Some agent files or links were not read: the check reached a limit. The entries that say "not read" name where.';

/**
 * The result of a change: the failing findings first, then the others, then the verdict. `dir`
 * is the real path of the folder given, to say so when the repository's top is somewhere else.
 */
export function formatChange(
  changedFrom: string,
  changes: AgentChanges,
  failOn: FailOn,
  dir: string,
): string {
  const groups = groupHits(changes.hits, failOn);
  const where =
    dir === changes.root
      ? []
      : [`It checks the whole repository at ${changes.root}, not only ${dir}.`, ''];
  const n = groups.failing.length;
  const verdict =
    n > 0
      ? `${n} ${n === 1 ? 'finding fails' : 'findings fail'} this check (--fail-on ${failOn}).`
      : groups.review.length + groups.present.length > 0
        ? `Nothing fails this check (--fail-on ${failOn}).`
        : 'Nothing in this change runs by itself when an agent or editor opens the repository.';
  return `${[
    `stroq inspect: what changed since ${changedFrom} (${changes.base.slice(0, 12)}) that an agent or editor runs by itself`,
    '',
    ...where,
    ...textGroup(`FAILS (${n})`, groups.failing),
    ...textGroup(`TO REVIEW (${groups.review.length}, not failing)`, groups.review),
    ...textNotices(
      `INSTRUCTION FILES NEW OR CHANGED (${groups.notices.length}, not failing)`,
      groups.notices,
    ),
    ...textGroup(
      `ALREADY THERE BEFORE THIS CHANGE (${groups.present.length}, not failing)`,
      groups.present,
    ),
    ...(changes.capped ? [CAPPED, ''] : []),
    verdict,
  ].join('\n')}\n`;
}

const asJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const tryRealpath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
/** The findings as JSON: `runs`, the text a hook manager's value holds, is never written out. */
const withFailing = (hits: readonly TaggedHit[], failOn: FailOn) =>
  hits.map(({ runs: _runs, ...h }) => ({ ...h, failing: isFailing(h, failOn) }));
const EMPTY_SURFACE: RepoSurface = { isRepo: true, preTrust: [], onOpen: [], capped: false };

interface Output {
  readonly format: InspectFormat;
  readonly failOn: FailOn;
  readonly hits: readonly TaggedHit[];
  readonly text: () => string;
  readonly json: () => object;
  readonly surface: RepoSurface;
  readonly summary: Parameters<typeof githubSummary>[1];
  readonly preTrust: readonly PreTrustItem[];
}

function write(o: Output): void {
  if (o.format === 'text') process.stdout.write(o.text());
  else if (o.format === 'json') process.stdout.write(asJson(o.json()));
  else if (o.format === 'sarif')
    process.stdout.write(asJson(inspectSarif(o.surface, stroqVersion(), o.hits)));
  else {
    // The summary is the Action's to redirect; the runner reads annotations from stderr too.
    process.stdout.write(`${githubSummary(o.hits, o.summary)}\n`);
    const lines = annotations(o.hits, o.failOn, o.preTrust);
    if (lines.length > 0) process.stderr.write(`${lines.join('\n')}\n`);
  }
}

function inspectCheckout(dir: string, format: InspectFormat, failOn: FailOn): number {
  const inRepo = repoSurface(dir);
  // Agent files take effect with or without git: a zip download has them too. Only the reading
  // of `.git` itself, in `repoSurface`, needs a repository.
  const agent = agentSurface(dir);
  // A folder with no .git reads the root dev container and install scripts the same way.
  const { surface, hits } = once(
    inRepo.isRepo ? inRepo : folderSurface(dir),
    tagChanges(agent.hits, null),
  );
  const findings = repoFindings(surface);
  const failing =
    (failOn === 'any' ? findings.length : 0) + hits.filter((h) => isFailing(h, failOn)).length;
  const preTrust = surface.preTrust.map((h) => ({
    kind: h.kind,
    file: h.file,
    what: h.what,
    why: WHY[h.kind] ?? 'repository-supplied execution',
  }));
  write({
    format,
    failOn,
    hits,
    surface,
    preTrust,
    summary: { failOn, preTrust },
    text: () => formatInspect(dir, surface, hits, failOn, agent.capped),
    json: () => ({
      version: 1,
      dir,
      ...surface,
      findings,
      failOn,
      failing,
      agent: withFailing(hits, failOn),
      agentCapped: agent.capped,
    }),
  });
  return failing > 0 ? EXIT.fail : EXIT.pass;
}

function inspectChange(dir: string, format: InspectFormat, failOn: FailOn, rev: string): number {
  let changes: AgentChanges;
  try {
    changes = agentChanges(dir, rev);
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    process.stderr.write(`stroq inspect: ${err.message}\n`);
    return EXIT.error;
  }
  const failing = changes.hits.filter((h) => isFailing(h, failOn)).length;
  const realDir = tryRealpath(dir);
  write({
    format,
    failOn,
    hits: changes.hits,
    surface: EMPTY_SURFACE,
    preTrust: [],
    summary: { failOn, changedFrom: rev, base: changes.base, capped: changes.capped },
    text: () => formatChange(rev, changes, failOn, realDir),
    json: () => ({
      version: 1,
      dir,
      root: changes.root,
      changedFrom: rev,
      base: changes.base,
      failOn,
      failing,
      capped: changes.capped,
      agent: withFailing(changes.hits, failOn),
    }),
  });
  return failing > 0 ? EXIT.fail : EXIT.pass;
}

export type InspectFormat = 'text' | 'json' | 'sarif' | 'github';
const FORMATS: readonly InspectFormat[] = ['text', 'json', 'sarif', 'github'];

export type InspectArgs =
  | { readonly kind: 'usage'; readonly message: string }
  | { readonly kind: 'env' }
  | {
      readonly kind: 'run';
      readonly dir: string;
      readonly format: InspectFormat;
      readonly failOn: FailOn;
      readonly changedFrom?: string;
    };

const usage = (message: string): InspectArgs => ({ kind: 'usage', message });

const isOneOf = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);

/**
 * `--json` and `--sarif` stay as the names they always were for two of the formats. Anything
 * that does not fit is a usage error, exit 2, so a CI job with a typo in it fails loudly
 * instead of checking nothing.
 */
export function parseInspectArgs(argv: readonly string[], cwd = process.cwd()): InspectArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        json: { type: 'boolean' },
        sarif: { type: 'boolean' },
        env: { type: 'boolean' },
        format: { type: 'string' },
        'fail-on': { type: 'string' },
        'changed-from': { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    return usage(err instanceof Error ? err.message : 'bad arguments');
  }
  const { values, positionals } = parsed;
  if (values.env === true) return { kind: 'env' };
  if (values.json === true && values.sarif === true)
    return usage('choose --json or --sarif, not both');
  const alias = values.json === true ? 'json' : values.sarif === true ? 'sarif' : undefined;
  const format = values.format ?? alias ?? 'text';
  if (!isOneOf(FORMATS, format)) return usage(`--format takes ${FORMATS.join(', ')}`);
  if (alias !== undefined && alias !== format) return usage('choose one output format');
  const changedFrom = values['changed-from'];
  if (changedFrom !== undefined && (changedFrom === '' || changedFrom.startsWith('-')))
    return usage('--changed-from takes a revision, such as main or HEAD^1');
  const failOn = values['fail-on'] ?? (changedFrom === undefined ? 'any' : 'new');
  if (!isOneOf(FAIL_ON, failOn)) return usage(`--fail-on takes ${FAIL_ON.join(', ')}`);
  // Without a base every entry was already there, so `new` would never fail anything.
  if (failOn === 'new' && changedFrom === undefined)
    return usage('--fail-on new needs --changed-from');
  if (positionals.length > 1) return usage('takes one directory');
  return {
    kind: 'run',
    dir: resolve(cwd, positionals[0] ?? '.'),
    format,
    failOn,
    ...(changedFrom === undefined ? {} : { changedFrom }),
  };
}

export function runInspect(argv: readonly string[]): number {
  const args = parseInspectArgs(argv);
  if (args.kind === 'usage') {
    process.stderr.write(`stroq inspect: ${args.message}\n`);
    return EXIT.usage;
  }
  if (args.kind === 'env') {
    process.stdout.write(hardeningExports());
    return EXIT.pass;
  }
  if (!existsSync(args.dir)) {
    process.stderr.write(`stroq inspect: no such directory: ${args.dir}\n`);
    return EXIT.usage;
  }
  // Only what runs by itself fails the command, never the on-open list: a check that fails
  // on every repository with a pre-commit hook is one people stop running — which would
  // cost exactly the repositories this exists to catch.
  try {
    return args.changedFrom === undefined
      ? inspectCheckout(args.dir, args.format, args.failOn)
      : inspectChange(args.dir, args.format, args.failOn, args.changedFrom);
  } catch (err) {
    // Exit 1 means a report with findings. A check that stopped wrote none, and a CI step that
    // lets exit 1 through to its upload must not let this through as well.
    const why = neutralizeControls(err instanceof Error ? err.message : String(err)).slice(0, 300);
    process.stderr.write(`stroq inspect: the check stopped before it finished: ${why}\n`);
    return EXIT.error;
  }
}
