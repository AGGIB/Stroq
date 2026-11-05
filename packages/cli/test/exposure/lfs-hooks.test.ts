import { describe, expect, it } from 'vitest';
import { isStockLfsHook } from '../../src/exposure/lfs-hooks.js';

/**
 * The hooks `git lfs install` writes are the text in git-lfs's `lfs/hook.go`: the current template,
 * three older ones it still recognises as its own, and for `pre-push` five more. Each hook is a
 * hook of its own name only. This is written out again here, by hand, so a slip in the table is not
 * a slip in the test.
 */
const MESSAGE = (hook: string) =>
  `This repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting the '${hook}' file in the hooks directory (set by 'core.hookspath'; usually '.git/hooks').`;
const CALL = (hook: string) => `git lfs ${hook} "$@"`;

const VARIANTS: readonly ((hook: string) => string)[] = [
  (h) =>
    `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { printf >&2 "\\n%s\\n\\n" "${MESSAGE(h)}"; exit 2; }\n${CALL(h)}`,
  (h) =>
    `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo >&2 "\\n${MESSAGE(h)}\\n"; exit 2; }\n${CALL(h)}`,
  (h) =>
    `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo >&2 "\\nThis repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting '.git/hooks/${h}'.\\n"; exit 2; }\n${CALL(h)}`,
  (h) =>
    `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo >&2 "\\nThis repository is configured for Git LFS but 'git-lfs' was not found on your path. If you no longer wish to use Git LFS, remove this hook by deleting .git/hooks/${h}.\\n"; exit 2; }\n${CALL(h)}`,
];
const OLD_PRE_PUSH: readonly string[] = [
  '#!/bin/sh\ngit lfs push --stdin $*',
  '#!/bin/sh\ngit lfs push --stdin "$@"',
  '#!/bin/sh\ngit lfs pre-push "$@"',
  `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo >&2 "\\nThis repository has been set up with Git LFS but Git LFS is not installed.\\n"; exit 0; }\n${CALL('pre-push')}`,
  `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { echo >&2 "\\nThis repository has been set up with Git LFS but Git LFS is not installed.\\n"; exit 2; }\n${CALL('pre-push')}`,
];
const HOOKS = ['post-checkout', 'post-commit', 'post-merge', 'pre-push'];

describe('isStockLfsHook', () => {
  it.each(HOOKS.flatMap((hook) => VARIANTS.map((v, i) => [hook, i, v(hook)] as const)))(
    'takes the script git lfs writes for %s, variant %i',
    (hook, _i, text) => {
      expect(isStockLfsHook(hook, text)).toBe(true);
      expect(isStockLfsHook(hook, `${text}\n`)).toBe(true);
      expect(isStockLfsHook(hook, `${text}\n`.replace(/\n/g, '\r\n'))).toBe(true);
    },
  );

  it.each(OLD_PRE_PUSH)('takes an older pre-push of git lfs: %j', (text) => {
    expect(isStockLfsHook('pre-push', `${text}\n`)).toBe(true);
    for (const other of ['post-checkout', 'post-commit', 'post-merge', 'pre-commit'])
      expect(isStockLfsHook(other, `${text}\n`), other).toBe(false);
  });

  it('is exact: one character more or less, or another name, is not the script', () => {
    const text = `${VARIANTS[0]?.('pre-push')}\n`;
    const firstLineEnd = text.indexOf('\n');
    const blankAfterFirstLine = `${text.slice(0, firstLineEnd)}\n${text.slice(firstLineEnd)}`;
    expect(isStockLfsHook('pre-push', text)).toBe(true);
    for (const bad of [
      `${text}\n`,
      ` ${text}`,
      text.replace('exit 2', 'exit 3'),
      text.replace('#!/bin/sh', '#!/bin/bash'),
      text.replace('"$@"', '"$*"'),
      text.slice(0, -2),
      `${text}true\n`,
      blankAfterFirstLine,
      text.replace(/\n/g, '\r\r\n'),
      '',
    ])
      expect(isStockLfsHook('pre-push', bad), JSON.stringify(bad.slice(0, 40))).toBe(false);
    expect(isStockLfsHook('post-commit', text)).toBe(false);
    expect(isStockLfsHook('pre-commit', text)).toBe(false);
    expect(isStockLfsHook('PRE-PUSH', text)).toBe(false);
  });
});
