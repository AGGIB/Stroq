import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { isFailing, type TaggedHit } from '../../src/exposure/agent-change.js';
import { agentChanges } from '../../src/exposure/agent-git.js';
import { describe as sentenceOf, plainQuote } from '../../src/exposure/agent-report.js';
import { githubSummary } from '../../src/exposure/github-format.js';
import { commitFiles, hookSettings, scratchRepo } from '../helpers/scratch-repo.js';

/**
 * What an entry already there runs, as a change touches it. A file it names, and any file of any
 * kind under the folder of one, fails: `tools/conf/x.yaml` under a hook that runs `node
 * tools/run.js`. So does other code of the repository, which the code it runs may load from
 * anywhere: what a file loads is not read, so it is not left as a warning. The job summary says
 * so in one line.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function changed(edits: Record<string, string>): readonly TaggedHit[] {
  const dir = scratchRepo(dirs);
  const base = commitFiles(dir, {
    '.claude/settings.json': hookSettings({ PostToolUse: 'node tools/run.js' }),
    'tools/run.js': '1\n',
    'tools/conf/x.yaml': 'a: 1\n',
    'src/other.ts': '1\n',
  });
  commitFiles(dir, edits);
  return agentChanges(dir, base).hits.filter((h) => h.kind === 'agent-run-file-changed');
}

describe('what an entry already there may run or load', () => {
  it('fails any file under the folder of the file it runs, data included', () => {
    const hits = changed({ 'tools/conf/x.yaml': 'a: 2\n', 'tools/run.js': '2\n' });
    expect(hits.map((h) => `${h.file} ${h.severity} ${isFailing(h, 'new')}`)).toEqual([
      'tools/conf/x.yaml error true',
      'tools/run.js error true',
    ]);
  });

  it('fails other code of the repository, which the code it runs may load', () => {
    const hits = changed({ 'src/other.ts': '2\n' });
    expect(hits.map((h) => `${h.file} ${h.severity} ${isFailing(h, 'new')}`)).toEqual([
      'src/other.ts error true',
    ]);
    expect(sentenceOf(hits[0] as TaggedHit, plainQuote)).toContain(
      'runs code of this repository that may load it',
    );
    const summary = githubSummary(hits, { failOn: 'new', changedFrom: 'main', base: 'abc' });
    expect(summary).toContain(
      'Other code of the repository that an entry already there may load fails too: what a file loads is not read, so it is not left for review.',
    );
  });
});
