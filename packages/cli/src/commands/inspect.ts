import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { repoFindings, repoSurface, type RepoSurface } from '../exposure/repo-surface.js';

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
    options: { json: { type: 'boolean' }, env: { type: 'boolean' } },
    allowPositionals: true,
  });
  if (values.env === true) {
    process.stdout.write(hardeningExports());
    return 0;
  }
  const dir = resolve(positionals[0] ?? process.cwd());
  if (!existsSync(dir)) {
    process.stderr.write(`stroq inspect: no such directory: ${dir}\n`);
    return 1;
  }
  const surface = repoSurface(dir);
  const findings = repoFindings(surface);
  process.stdout.write(
    values.json === true
      ? `${JSON.stringify({ version: 1, dir, ...surface, findings }, null, 2)}\n`
      : formatInspect(dir, surface),
  );
  // Only pre-trust execution fails the command. The on-open list is ordinary, and a
  // check that fails on every repository with a pre-commit hook is one people stop
  // running — which would cost exactly the repositories this exists to catch.
  return findings.length > 0 ? 1 : 0;
}
