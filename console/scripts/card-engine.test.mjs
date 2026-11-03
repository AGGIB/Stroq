import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCardService } from './card-service.mjs';

// The whole way from the built CLI to the card the Check screen shows, on a machine made up for the
// test: its own home, its own Stroq folder, a session it wrote itself, and an environment of its own.
async function machine(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'stroq-card-engine-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const work = join(root, 'work');
  await mkdir(home);
  await mkdir(work);
  return { root, home, work, stroq: join(home, '.stroq') };
}

async function claudeSession(m, commands) {
  const dir = join(m.home, '.claude', 'projects', m.work.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(dir, { recursive: true });
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const lines = commands.flatMap((command, i) => [
    JSON.stringify({
      type: 'assistant',
      sessionId: 'made-up-session',
      cwd: m.work,
      timestamp: at,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command } }],
      },
    }),
    JSON.stringify({
      type: 'user',
      sessionId: 'made-up-session',
      cwd: m.work,
      timestamp: at,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }],
      },
    }),
  ]);
  await writeFile(join(dir, 'made-up-session.jsonl'), `${lines.join('\n')}\n`);
}

async function run(m) {
  const card = await createCardService({
    home: m.stroq,
    userHome: m.home,
    project: m.work,
    environment: { PATH: process.env.PATH },
  });
  try {
    await card.start();
    for (let i = 0; i < 400; i++) {
      const state = await card.getState();
      if (state.status !== 'running') return state;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('the card did not finish');
  } finally {
    await card.close();
  }
}

test('a machine with a session gets the terminal’s card, its numbers and its owl', async (t) => {
  const m = await machine(t);
  await claudeSession(m, ['echo hello', 'ls']);
  const state = await run(m);
  assert.equal(state.engine.available, true);
  assert.equal(state.status, 'done', state.error);
  const { result } = state;
  assert.equal(result.schema, 'stroq-card-view/1');
  assert.equal(result.owl, 'happy');
  assert.equal(result.view.kind, 'card');
  assert.match(result.view.title, /^Hoo checked 30 days of your agent sessions$/);
  assert.match(result.view.subtitle, /^1 session · Claude Code · this machine$/);
  assert.deepEqual(
    result.view.rows.map((row) => [row.id, row.count]),
    [
      ['commands', 2],
      ['told', 0],
      ['keys', 0],
      ['autorun', 0],
    ],
  );
  assert.equal(result.view.nothing, 'Nothing worth a look in these sessions.');
  assert.deepEqual(result.moments, []);
  // The command leaves what `stroq show` reads, as it does in a terminal.
  const last = JSON.parse(await readFile(join(m.stroq, 'card', 'last.json'), 'utf8'));
  assert.equal(last.schema, 'stroq-card-last/1');
});

test('a machine with no sessions gets the idle owl and says where it looked', async (t) => {
  const m = await machine(t);
  const state = await run(m);
  assert.equal(state.status, 'done', state.error);
  assert.equal(state.result.owl, 'idle');
  assert.equal(state.result.view.kind, 'nothing-to-read');
  assert.match(state.result.view.looked, /Looked for Claude Code in ~\/\.claude\/projects/);
});
