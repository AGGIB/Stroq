/**
 * What `stroq harden` asks a host to keep an agent away from: the secret files of a project and the
 * credential stores of a home directory.
 *
 * This is not a new opinion about what is secret. Stroq already holds two: the classifier that gives a
 * path the class `fs.secrets` (`classify-tool.ts` in core: `.env` and its variants, `.ssh`, `.aws`,
 * `.kube`, `.config/gcloud`, `.npmrc`, `.netrc`, `.pgpass`, `.git-credentials`) and the secret index that
 * reads values out of a few files of the home (`HOME_SECRET_SOURCES` in core). The tests in
 * `credential-paths.test.ts` hold this list to both, so that it cannot fall behind them. Two entries are
 * the design's own and are not known to the classifier yet (`.docker/config.json` is read into the
 * index but not classified, `.gnupg` is in neither): the test names them, so that adding another is a
 * decision and not an accident.
 */

/**
 * Secret files that live in a project, by name, relative to the folder an agent is started in. `.env.*`
 * also covers `.env.example`, which the classifier does not call secret: Claude Code's rule cannot say
 * "all but", and a rule that is too wide only costs the agent a file, where one too narrow costs a key.
 */
export const PROJECT_SECRET_FILES: readonly string[] = ['.env', '.env.*'];

/**
 * Credential stores in a home directory, relative to it. A trailing `/**` is the whole folder; the others
 * are one file each.
 */
export const HOME_CREDENTIAL_PATHS: readonly string[] = [
  '.ssh/**',
  '.aws/**',
  '.config/gcloud/**',
  '.kube/**',
  '.docker/config.json',
  '.npmrc',
  '.netrc',
  '.pgpass',
  '.git-credentials',
  '.gnupg/**',
];

const WHOLE_FOLDER = '/**';

/** A Claude Code read rule for a file of the project the agent is started in. */
export const projectReadRule = (name: string): string => `Read(./${name})`;

/** A Claude Code read rule for a path under the user's home directory. */
export const homeReadRule = (path: string): string => `Read(~/${path})`;

/** The rules `claude-read-deny` adds, in the order they are shown: the project's files, then the home's. */
export const CLAUDE_READ_DENY_RULES: readonly string[] = [
  ...PROJECT_SECRET_FILES.map(projectReadRule),
  ...HOME_CREDENTIAL_PATHS.map(homeReadRule),
];

/**
 * Whether the home path `rule` (an entry of `HOME_CREDENTIAL_PATHS`) names `file` (a path relative to the
 * home): the file itself, or any file inside the folder a `/**` names. Whole path segments only, so
 * `.aws/**` does not name `.awsome/credentials`.
 */
export function ruleCovers(rule: string, file: string): boolean {
  if (!rule.endsWith(WHOLE_FOLDER)) return rule === file;
  const folder = rule.slice(0, -WHOLE_FOLDER.length);
  return file === folder || file.startsWith(`${folder}/`);
}
