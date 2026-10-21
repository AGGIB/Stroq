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
