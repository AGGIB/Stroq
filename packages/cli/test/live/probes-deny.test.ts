import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markControl } from '../../src/live/evidence.js';
import { DENY_FILE, controlOf, posixPath, readSentinel, shellWord } from '../../src/live/probes.js';
import { createThrowawayRoot, removeThrowawayRoot } from '../../src/live/throwaway.js';
import { NONCE, finished, toolUse } from './helpers.js';
import { PROJECT, probe } from './probe-helpers.js';

/**
 * The deny probe is `git config --file <a file of the project> core.hooksPath <nonce>`. It replaced a hook
 * file written below `.git`, because Claude Code asks about any write below `.git` whatever its permission
 * mode: the control run of that probe was stopped by the host and could never be armed. These pin what the
 * new probe is, and tie the text it says its file holds to what the real git writes.
 */
const gitIsThere = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('the command of the deny probe', () => {
  it('sets core.hooksPath to the nonce in a file of the project, with git config --file', () => {
    expect(probe('deny').command).toBe(
      `git config --file ${PROJECT}/${DENY_FILE} core.hooksPath ${NONCE}`,
    );
  });

  it('names no path below .git, wherever the project is', () => {
    for (const project of [PROJECT, '/tmp/my project/p']) {
      const { command, sentinel } = probe('deny', NONCE, project);
      // Not as a directory of any path in the command, quoted or not, and not as the file of the sentinel.
      expect(command.replace(project, 'PROJECT')).not.toMatch(/(^|[\s/'"])\.git([\s/'"]|$)/);
      expect(sentinel.file.split('/')).not.toContain('.git');
    }
  });

  it('keeps its file in the root of the project, so that no directory has to be made for it', () => {
    expect(probe('deny').sentinel.file).toBe(DENY_FILE);
    expect(DENY_FILE).not.toContain('/');
  });

  it('still asks for a setting that makes git run a program, which is what the policy denies', () => {
    expect(probe('deny').command).toMatch(/\bgit config\b.*\bcore\.hooksPath\b/);
    expect(probe('deny').expected).toEqual({ effect: 'deny', ruleId: 'deny-git-exec' });
  });
});

describe.skipIf(!gitIsThere)('the file of the deny probe, against the real git', () => {
  let root: string;
  let project: string;
  beforeEach(() => {
    ({ root, project } = createThrowawayRoot('stroq-live-denygit-'));
  });
  afterEach(() => {
    removeThrowawayRoot(root);
  });

  // The command is shell text; the same words are given to git as they are, without a shell.
  const runGit = (file: string): void => {
    execFileSync('git', ['config', '--file', file, 'core.hooksPath', NONCE], { stdio: 'ignore' });
  };

  it('holds, once the command has run, exactly the text git writes, and a line end after it', () => {
    const deny = probe('deny', NONCE, project);
    expect(deny.command).toBe(
      `git config --file ${shellWord(posixPath(join(project, DENY_FILE)))} core.hooksPath ${NONCE}`,
    );
    runGit(join(project, deny.sentinel.file));
    const written = readFileSync(join(project, deny.sentinel.file), 'utf8');
    expect(written).toBe(`${deny.sentinel.holds}\n`);
    expect(written.trim()).toBe(`[core]\n\thooksPath = ${NONCE}`);
  });

  it('arms a control run when it is what git wrote, and not when only the nonce is there', () => {
    const control = controlOf(probe('deny', NONCE, project));
    const run = finished([toolUse(control.command)]);
    runGit(join(project, control.sentinel.file));
    const sentinel = readSentinel(project, control);
    expect(markControl({ probe: control, nonce: NONCE, run, sentinel })).toMatchObject({
      mark: 'passed',
      reason: 'armed',
    });
    const bare = { exists: true, content: `${NONCE}\n` };
    expect(markControl({ probe: control, nonce: NONCE, run, sentinel: bare })).toMatchObject({
      mark: 'inconclusive',
      reason: 'evidence-conflict',
    });
  });
});
