import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cardEnvironment, executeCard } from './card-process.mjs';

/** A stand-in for the CLI: the script it is given runs instead, so that what the console does with
 * the answer, the exit code, the time and the environment can be tested without a machine's sessions. */
async function fixture(t, source) {
  const dir = await mkdtemp(join(tmpdir(), 'stroq-card-process-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = join(dir, 'cli.mjs');
  await writeFile(cli, source);
  return { cli, dir };
}
const options = (extra) => ({
  paths: { cli: extra.cli },
  project: extra.dir,
  userHome: extra.dir,
  home: join(extra.dir, '.stroq'),
  environment: { PATH: process.env.PATH, KEEP_ME: 'yes', NODE_OPTIONS: '--require ./evil.js' },
  ...extra,
});

test('it runs `card --json` and returns what the command printed, parsed', async (t) => {
  const f = await fixture(
    t,
    `console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME, stroq: process.env.STROQ_HOME, keep: process.env.KEEP_ME, node: process.env.NODE_OPTIONS ?? null, color: process.env.NO_COLOR }))`,
  );
  const answer = await executeCard(options(f));
  assert.deepEqual(answer.args, ['card', '--json']);
  assert.equal(answer.home, f.dir);
  assert.equal(answer.stroq, join(f.dir, '.stroq'));
  assert.equal(
    answer.keep,
    'yes',
    'the environment of the console is the card’s, as in a terminal',
  );
  assert.equal(answer.node, null, 'a loader variable is not passed on');
  assert.equal(answer.color, '1');
});

test('the loader names are the only ones left out of the environment', () => {
  const env = cardEnvironment({
    home: '/h/.stroq',
    userHome: '/h',
    environment: {
      PATH: '/bin',
      ANTHROPIC_API_KEY: 'sk-made-up',
      NODE_OPTIONS: 'x',
      NODE_PATH: 'x',
      LD_PRELOAD: 'x',
      DYLD_INSERT_LIBRARIES: 'x',
      ELECTRON_RUN_AS_NODE: '1',
      CLAUDE_CONFIG_DIR: '/c',
    },
  });
  assert.deepEqual(Object.keys(env).sort(), [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CONFIG_DIR',
    'HOME',
    'NO_COLOR',
    'PATH',
    'STROQ_HOME',
    'USERPROFILE',
  ]);
});

test('a command that fails, prints something else, or prints too much is refused', async (t) => {
  const failing = await fixture(t, 'process.exit(1)');
  await assert.rejects(executeCard(options(failing)), { message: 'card-failed' });
  const words = await fixture(t, 'console.log("not json")');
  await assert.rejects(executeCard(options(words)), { message: 'invalid-report' });
  const loud = await fixture(t, 'process.stdout.write("x".repeat(5 * 1024 * 1024))');
  await assert.rejects(executeCard(options(loud)), { message: 'output-limit' });
});

test('a command that does not finish in time is stopped', async (t) => {
  const f = await fixture(t, 'setInterval(() => {}, 1000)');
  await assert.rejects(executeCard({ ...options(f), timeoutMs: 300 }), {
    message: 'deadline-exceeded',
  });
});

test('a run can be cancelled', async (t) => {
  const f = await fixture(t, 'setInterval(() => {}, 1000)');
  const controller = new AbortController();
  const run = executeCard({ ...options(f), signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(run, { message: 'cancelled' });
  await assert.rejects(executeCard({ ...options(f), signal: controller.signal }), {
    message: 'cancelled',
  });
});

test('a CLI that cannot start is reported as unavailable', async (t) => {
  const f = await fixture(t, '');
  await assert.rejects(executeCard({ ...options(f), project: join(f.dir, 'missing') }), {
    message: 'engine-unavailable',
  });
});
