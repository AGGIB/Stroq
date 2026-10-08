import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stroqHome } from '../src/paths.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('stroqHome', () => {
  it('is the directory STROQ_HOME names', () => {
    vi.stubEnv('STROQ_HOME', '/srv/stroq-home');

    expect(stroqHome()).toBe('/srv/stroq-home');
  });

  it('is ~/.stroq where STROQ_HOME is not set', () => {
    vi.stubEnv('STROQ_HOME', undefined as unknown as string);
    delete process.env['STROQ_HOME'];

    expect(stroqHome()).toBe(join(homedir(), '.stroq'));
  });

  // A fifth review: an empty variable was a directory named "", and what Stroq keeps (the install record,
  // the audit log) was written in the folder it was run in.
  it('is ~/.stroq where STROQ_HOME is empty: an empty variable is not a directory', () => {
    vi.stubEnv('STROQ_HOME', '');

    expect(stroqHome()).toBe(join(homedir(), '.stroq'));
  });
});
