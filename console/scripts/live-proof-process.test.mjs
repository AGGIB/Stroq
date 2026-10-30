import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeLiveEngine, liveEnvironment } from './live-proof-process.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('only auth profile locations and operational variables survive; billing and loader env do not', () => {
  const env = liveEnvironment({
    home: '/safe/stroq',
    userHome: '/safe/user',
    environment: {
      PATH: '/bin',
      CLAUDE_CONFIG_DIR: '/safe/claude',
      CODEX_HOME: '/safe/codex',
      ANTHROPIC_API_KEY: 'secret',
      OPENAI_API_KEY: 'secret',
      NODE_OPTIONS: '--import evil',
      STROQ_CLAUDE_BIN: 'evil',
      STROQ_LIVE_LEDGER: '/private/budget',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret',
    },
  });
  assert.equal(env.HOME, '/safe/user');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/safe/claude');
  assert.equal(env.CODEX_HOME, '/safe/codex');
  assert.equal(env.NODE_DISABLE_COMPILE_CACHE, '1');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.STROQ_CLAUDE_BIN, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test(
  'external abort kills a detached fixture host and its descendants, without an agent CLI',
  { skip: process.platform === 'win32', timeout: 10000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stroq-proof-supervisor-'));
    const adapter = join(directory, 'adapter.mjs');
    const marker = join(directory, 'pids.json');
    await writeFile(
      adapter,
      `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
 process.on('SIGTERM',()=>{});
 process.on('message',({input})=>{
  const nested = "const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync("+JSON.stringify(input.marker)+",JSON.stringify(["+process.pid+",process.pid,descendant.pid]));setInterval(()=>{},1000);";
  const grand=spawn(process.execPath,['-e',nested],{detached:true,stdio:'ignore'});
  process.send({type:'child',pid:grand.pid});
 });`,
    );
    const aborter = new AbortController();
    const result = executeLiveEngine(
      'run',
      { maxRequests: 3, marker },
      {
        adapter,
        project: directory,
        userHome: directory,
        home: join(directory, '.stroq'),
        signal: aborter.signal,
        timeoutMs: 8000,
      },
    );
    let pids = [];
    try {
      for (let i = 0; i < 100; i++) {
        try {
          pids = JSON.parse(await readFile(marker, 'utf8'));
          break;
        } catch {
          await delay(10);
        }
      }
      assert.equal(pids.length, 3);
      assert.equal(alive(pids[1]), true);
      aborter.abort();
      await assert.rejects(result, /cancelled/);
      for (let i = 0; i < 100 && pids.some(alive); i++) await delay(10);
      assert.equal(pids.some(alive), false);
    } finally {
      aborter.abort();
      await result.catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'deadline bounds a silent fixture worker and discards all error output',
  { timeout: 7000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stroq-proof-deadline-'));
    const adapter = join(directory, 'adapter.mjs');
    await writeFile(
      adapter,
      `process.on('message',()=>{process.stderr.write('secret-fixture-value');setInterval(()=>{},1000);});`,
    );
    try {
      await assert.rejects(
        executeLiveEngine(
          'inspect',
          {},
          {
            adapter,
            project: directory,
            userHome: directory,
            home: join(directory, '.stroq'),
            timeoutMs: 100,
          },
        ),
        { message: 'deadline-exceeded' },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
