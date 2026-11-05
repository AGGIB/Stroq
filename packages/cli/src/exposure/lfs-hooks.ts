// The hooks Git LFS installs, as `git lfs install` writes them. Compared as whole files: a hook that
// is exactly the script git-lfs wrote is Git LFS's, and a hook with anything else in it is not.
//
// The texts are copied from git-lfs, `lfs/hook.go`:
//   https://github.com/git-lfs/git-lfs/blob/v3.8.1/lfs/hook.go
// as of the tag v3.8.1 (2026-10-22). The file was last changed by commit
// c2833cb05a5ff1ecad1eb8ce5e80046ab883ba5e (2024-11-01) and read from there on 2026-11-02, when `main`
// held the same file. `hookBaseContent` is what git-lfs writes today, the next three are older texts
// it still recognises as its own, and `pre-push` has five more. `{{Command}}` stands for the name of
// the hook. Git LFS ends each file with one newline.
//
// Git LFS is MIT-licensed, Copyright (c) 2014- GitHub, Inc. and Git LFS contributors. The licence
// travels with the package, in THIRD_PARTY_NOTICES.md.

const CURRENT =
  "#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { printf >&2 \"\\n%s\\n\\n\" \"This repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting the '{{Command}}' file in the hooks directory (set by 'core.hookspath'; usually '.git/hooks').\"; exit 2; }\ngit lfs {{Command}} \"$@\"";
const OLDER: readonly string[] = [
  "#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo >&2 \"\\nThis repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting the '{{Command}}' file in the hooks directory (set by 'core.hookspath'; usually '.git/hooks').\\n\"; exit 2; }\ngit lfs {{Command}} \"$@\"",
  '#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo >&2 "\\nThis repository is configured for Git LFS but \'git-lfs\' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting \'.git/hooks/{{Command}}\'.\\n"; exit 2; }\ngit lfs {{Command}} "$@"',
  '#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo >&2 "\\nThis repository is configured for Git LFS but \'git-lfs\' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting .git/hooks/{{Command}}.\\n"; exit 2; }\ngit lfs {{Command}} "$@"',
];
const OLDER_PRE_PUSH: readonly string[] = [
  '#!/bin/sh\ngit lfs push --stdin $*',
  '#!/bin/sh\ngit lfs push --stdin "$@"',
  '#!/bin/sh\ngit lfs pre-push "$@"',
  '#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo >&2 "\\nThis repository has been set up with Git LFS but Git LFS is not installed.\\n"; exit 0; }\ngit lfs pre-push "$@"',
  '#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo >&2 "\\nThis repository has been set up with Git LFS but Git LFS is not installed.\\n"; exit 2; }\ngit lfs pre-push "$@"',
];

const NAMES = ['post-checkout', 'post-commit', 'post-merge', 'pre-push'];

/** For each hook Git LFS writes, every text it has written for it. */
const STOCK: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  NAMES.map((name) => [
    name,
    new Set([
      ...[CURRENT, ...OLDER].map((text) => text.replaceAll('{{Command}}', name)),
      ...(name === 'pre-push' ? OLDER_PRE_PUSH : []),
    ]),
  ]),
);

/**
 * Whether `text` is the whole of a hook Git LFS writes under this `name`. Line endings are read as
 * `\n` (a checkout on Windows may turn them into `\r\n`), and the one newline at the end is the
 * file's, but nothing else is let through: not a blank line, a blank at the end of a line, or
 * another line, and not the script of one hook under the name of another.
 */
export function isStockLfsHook(name: string, text: string): boolean {
  const stock = STOCK.get(name);
  if (stock === undefined) return false;
  const lines = text.replace(/\r\n/g, '\n');
  return stock.has(lines.endsWith('\n') ? lines.slice(0, -1) : lines);
}
