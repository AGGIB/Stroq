import { describe, expect, it } from 'vitest';
import { internalErrorReason, isClosedHome } from '../../src/adapters/internal-error.js';

const HOME = '/Users/dev/.stroq';
const fsError = (code: string, path?: string, message = `${code}: x`): Error =>
  Object.assign(new Error(message), { code, ...(path === undefined ? {} : { path }) });

describe('a Stroq home closed to the hook', () => {
  it('is a refusal (EPERM, EACCES) of the home or a path in it', () => {
    expect(isClosedHome(fsError('EPERM', `${HOME}/sessions/s1.json`), HOME)).toBe(true);
    expect(isClosedHome(fsError('EACCES', HOME), HOME)).toBe(true);
    expect(isClosedHome(fsError('EPERM', undefined, `EPERM: mkdir '${HOME}/sessions'`), HOME)).toBe(
      true,
    );
  });

  it('is not another error, nor a refusal of another folder', () => {
    expect(isClosedHome(fsError('ENOENT', `${HOME}/policy.yaml`), HOME)).toBe(false);
    expect(isClosedHome(fsError('EPERM', '/Users/dev/.stroq-other/x'), HOME)).toBe(false);
    expect(isClosedHome(fsError('EPERM', '/Users/dev/project/x'), HOME)).toBe(false);
    expect(isClosedHome(new Error('boom'), HOME)).toBe(false);
    expect(isClosedHome('EPERM', HOME)).toBe(false);
    expect(isClosedHome(null, HOME)).toBe(false);
  });
});

describe('the reason of a call refused because Stroq failed', () => {
  it('names the folder to grant when the home is closed', () => {
    expect(internalErrorReason(fsError('EPERM', `${HOME}/sessions`), HOME)).toBe(
      'Stroq internal error (fail-closed): EPERM: x. Stroq cannot use its own folder, /Users/dev/.stroq. If the agent runs in a sandbox, give that folder read and write access in it.',
    );
  });

  it('is the error alone otherwise, as it always was', () => {
    expect(internalErrorReason(new Error('boom'), HOME)).toBe(
      'Stroq internal error (fail-closed): boom',
    );
    expect(internalErrorReason('not an error', HOME)).toBe(
      'Stroq internal error (fail-closed): not an error',
    );
  });
});
