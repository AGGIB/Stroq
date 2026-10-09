import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { liveDir, liveDirIn, liveResultFile, liveResultFileIn } from '../../src/paths.js';

/**
 * Where `stroq prove` keeps what it last found out about each host: one file per agent, under a
 * directory of its own so that "forget every live result" is one `rm -rf ~/.stroq/live`.
 */
describe('the live-check paths', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['STROQ_HOME'];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['STROQ_HOME'];
    else process.env['STROQ_HOME'] = saved;
  });

  it('keeps one result file per agent under <home>/live', () => {
    expect(liveDirIn('/some/home')).toBe(join('/some/home', 'live'));
    expect(liveResultFileIn('/some/home', 'claude-code')).toBe(
      join('/some/home', 'live', 'claude-code.json'),
    );
    expect(liveResultFileIn('/some/home', 'codex')).not.toBe(
      liveResultFileIn('/some/home', 'claude-code'),
    );
  });

  it('follows STROQ_HOME for the helpers that are bound to the real home', () => {
    process.env['STROQ_HOME'] = join('/a', 'throwaway');
    expect(liveDir()).toBe(join('/a', 'throwaway', 'live'));
    expect(liveResultFile('cursor')).toBe(join('/a', 'throwaway', 'live', 'cursor.json'));
  });
});
