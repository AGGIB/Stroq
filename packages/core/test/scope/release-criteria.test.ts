import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprintOf, shellTarget } from '../../src/scope/fingerprint.js';
import { createScopeGate } from '../../src/scope/gate.js';
import { HARD_CLASSES } from '../../src/scope/hard-set.js';
import {
  ALLOW,
  ASK,
  DENY,
  POSIX_PATHS,
  callOf,
  gateFixture,
  resourcesOf,
  verdictOf,
} from './gate-fixture.js';
import { NONCE, SESSION } from './helpers.js';

/**
 * The two statements the task lock is released on. They are named exactly so that a failing
 * release check points at the sentence it protects.
 */
describe('release criteria', () => {
  it('a permit is not reusable by another task or session', async () => {
    const read = callOf(
      'Read',
      { file_path: '/work/project/src/a.ts' },
      {
        resources: resourcesOf([['read', '/work/project/src/a.ts']]),
      },
    );
    const a = gateFixture({ body: { taskId: 'task-a' } });
    expect((await verdictOf(a, read)).decision.effect).toBe('allow');

    // Another task, with its own launch (its own nonce), handed the first task's permit file.
    mkdirSync(join(a.home, 'tasks', 'task-b'), { recursive: true });
    copyFileSync(
      join(a.home, 'tasks', 'task-a', 'permit.json'),
      join(a.home, 'tasks', 'task-b', 'permit.json'),
    );
    const asB = (nonce: string) =>
      createScopeGate({
        taskId: 'task-b',
        store: a.store,
        keys: a.keyStore,
        context: () => ({ ...a.run, nonce }),
        now: () => a.clock.now,
        paths: POSIX_PATHS,
      });
    const otherLaunch = await asB(`${NONCE}-b`).evaluate(read);
    expect(otherLaunch?.decision).toMatchObject({ effect: 'deny', ruleId: 'task-void:nonce' });
    // Even a task that somehow shares the launch secret cannot wear another task's permit.
    const sameLaunch = await asB(NONCE).evaluate(read);
    expect(sameLaunch?.decision).toMatchObject({ effect: 'deny', ruleId: 'task-void:task-id' });

    // The same task, called from another session.
    const otherSession = await verdictOf(a, {
      ...read,
      event: { ...read.event, sessionId: `${SESSION}-2` },
    });
    expect(otherSession.decision).toMatchObject({ effect: 'deny', ruleId: 'task-void:session' });

    // The same task and session, relaunched: the new launch has a new nonce.
    const relaunched = createScopeGate({
      taskId: 'task-a',
      store: a.store,
      keys: a.keyStore,
      context: () => ({ ...a.run, nonce: `${NONCE}-2` }),
      now: () => a.clock.now,
      paths: POSIX_PATHS,
    });
    expect((await relaunched.evaluate(read))?.decision.ruleId).toBe('task-void:nonce');

    // The same task, after it ended or was revoked.
    a.store.end('task-a');
    expect((await verdictOf(a, read)).decision.ruleId).toBe('task-void:ended');
  });

  it('hard denies are not bypassed by scopes', async () => {
    const widest = gateFixture({
      scope: {
        tools: ['Read', 'Write', 'Edit', 'Bash', 'WebFetch', 'mcp__docs__search'],
        read: { allow: ['/**'], deny: [] },
        write: { allow: ['/**'], deny: [] },
        net: { mode: 'hosts', hosts: ['api.example.com'] },
        mcp: [{ server: 'docs', tools: '*' }],
        shell: 'allowed',
      },
    });
    for (const hard of HARD_CLASSES) {
      for (const decision of [ALLOW, ASK, DENY]) {
        const call = callOf('Bash', { command: 'echo hi' }, { classes: [hard], decision });
        // An escalation signed for this exact operation is on offer too.
        widest.escalate(fingerprintOf('Bash', 'shell', shellTarget('echo hi')));
        const again = await verdictOf(widest, call);
        expect(again.decision.effect, `${hard} / ${decision.effect}`).toBe('deny');
        expect(again.decision.ruleId).toBe(`task-hard:${hard}`);
      }
    }
  });
});
