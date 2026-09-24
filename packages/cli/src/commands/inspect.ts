import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { repoFindings, repoSurface, type RepoSurface } from '../exposure/repo-surface.js';
import { inspectSarif } from '../exposure/sarif.js';
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
 */

/**
 * Configuration that neutralises the two shapes a repository can use to run a command
 * during an ordinary read, printed for the user to export.
 *
 * Verified against git 2.53.0: with `core.fsmonitor` pointing at a script, a plain
 * `git status` runs it twice and the same command under these variables runs it not
 * at all; a nested bare repository that `git rev-parse` happily treats as a
 * repository is refused outright under `safe.bareRepository=explicit`.
 *
 * Deliberately just these two. `core.hooksPath` is how husky installs itself and
 * `core.pager`, `core.editor` and `diff.external` are ordinary preferences, so
 * overriding them would break real workflows to close a narrower hole than the one
 * `stroq inspect` already reports.
 */
export const GIT_HARDENING: readonly { readonly key: string; readonly value: string }[] = [
  { key: 'core.fsmonitor', value: 'false' },
  { key: 'safe.bareRepository', value: 'explicit' },
];

export function hardeningExports(): string {
  const lines = [`export GIT_CONFIG_COUNT=${GIT_HARDENING.length}`];
  GIT_HARDENING.forEach(({ key, value }, i) => {
    lines.push(`export GIT_CONFIG_KEY_${i}=${key}`, `export GIT_CONFIG_VALUE_${i}=${value}`);
  });
  return `${lines.join('\n')}\n`;
}

/**
 * The same two settings as variables to overlay on a child's environment, which is
 * how `stroq run` applies what `--env` asks the user to apply themselves.
 *
 * Returns only the variables to ADD, so a caller can merge them without having to
 * know which ones they are. The indices continue an existing `GIT_CONFIG_*` block
 * rather than starting at zero: `eval "$(stroq inspect --env)"` is the documented
 * way to do this by hand, so the user who read the README already has a block, and
 * anyone with a `GIT_CONFIG_*` pair of their own would otherwise lose it silently. A
 * pair already present with the same value is left alone — nesting one launch inside
 * another must not grow the block without bound.
 *
 * A `GIT_CONFIG_COUNT` that is not a count starts the block over from zero. Git
 * itself refuses such a value, so nothing usable is being discarded, and the
 * alternative — refusing to harden because the environment is already broken — would
 * turn a broken shell into an unprotected launch.
 */
export function hardeningEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const declared = Number(env['GIT_CONFIG_COUNT']);
  const start = Number.isInteger(declared) && declared >= 0 ? declared : 0;
  const present = new Set(
    Array.from(
      { length: start },
      (_, i) => `${env[`GIT_CONFIG_KEY_${i}`]}=${env[`GIT_CONFIG_VALUE_${i}`]}`,
    ),
  );
  const missing = GIT_HARDENING.filter(({ key, value }) => !present.has(`${key}=${value}`));
  if (missing.length === 0) return {};
  const overlay: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(start + missing.length) };
  missing.forEach(({ key, value }, i) => {
    overlay[`GIT_CONFIG_KEY_${start + i}`] = key;
    overlay[`GIT_CONFIG_VALUE_${start + i}`] = value;
  });
  return overlay;
}

export function formatInspect(dir: string, surface: RepoSurface): string {
  if (!surface.isRepo)
    return `${dir} is not a git repository — nothing for stroq inspect to read\n`;
  const findings = repoFindings(surface);
  const lines = [`stroq inspect — what ${dir} runs when you open it`, ''];

  if (findings.length === 0) {
    lines.push('Nothing here runs before you approve it.', '');
  } else {
    lines.push(`BEFORE YOU APPROVE ANYTHING (${findings.length})`);
    for (const f of findings) {
      lines.push(`  ${f.detail}`);
      if (f.fix) lines.push(`    fix: ${f.fix}`);
    }
    lines.push('');
  }

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
  lines.push(
    findings.length === 0
      ? 'Open it. Stroq enforces the rest from inside the session.'
      : 'Read the entries above before you point an agent at this directory: they run during an ordinary `git status`, which every agent does at startup, before any prompt you could answer.',
  );
  return `${lines.join('\n')}\n`;
}

export function runInspect(argv: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { json: { type: 'boolean' }, sarif: { type: 'boolean' }, env: { type: 'boolean' } },
    allowPositionals: true,
  });
  if (values.env === true) {
    process.stdout.write(hardeningExports());
    return 0;
  }
  if (values.json === true && values.sarif === true) {
    process.stderr.write('stroq inspect: choose --json or --sarif, not both\n');
    return 2;
  }
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    process.stderr.write(`stroq inspect: no such directory: ${dir}\n`);
    return 1;
  }
  const surface = repoSurface(dir);
  const findings = repoFindings(surface);
  process.stdout.write(
    values.sarif === true
      ? `${JSON.stringify(inspectSarif(surface, stroqVersion()), null, 2)}\n`
      : values.json === true
        ? `${JSON.stringify({ version: 1, dir, ...surface, findings }, null, 2)}\n`
        : formatInspect(dir, surface),
  );
  // Only pre-trust execution fails the command. The on-open list is ordinary, and a
  // check that fails on every repository with a pre-commit hook is one people stop
  // running — which would cost exactly the repositories this exists to catch.
  return findings.length > 0 ? 1 : 0;
}
