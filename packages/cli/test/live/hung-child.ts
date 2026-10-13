import { openLedger } from '../../src/live/budget.js';
import { buildProbes, prepareProject } from '../../src/live/probes.js';
import { makeRequest } from '../../src/live/request.js';
import { createThrowawayRoot, removeThrowawayRoot } from '../../src/live/throwaway.js';
import type { HostDriver, HostRun } from '../../src/live/types.js';
import { lookForHost } from '../../src/live/verify-input.js';

/**
 * Run by `request-hung.test.ts`, never by the test runner: a process of its own with a driver whose promises
 * never settle and that holds no handle of any kind (no child process, no socket, no timer). In such a
 * process nothing keeps Node alive but the timers the check sets to give up on the driver, so it is the
 * place to see whether those timers do. It prints one line of JSON: what the check made of the silence.
 */
const silent: HostDriver = {
  detect: () => new Promise(() => undefined),
  run: () => new Promise<HostRun>(() => undefined),
};

const found = await lookForHost(silent, 200);

const made = createThrowawayRoot('stroq-live-hung-');
try {
  const fake = 'stroq_attack_0123456789abcdef01234567';
  prepareProject(made.project, fake);
  const [allow] = buildProbes('stroq-live-0123456789abcdef', fake, made.project);
  if (allow === undefined) throw new Error('no allow probe');
  const requested = await makeRequest({
    driver: silent,
    ledger: openLedger({ memory: true, limit: 5 }),
    label: 'hung',
    probe: allow,
    ctx: {
      project: made.project,
      stroqHome: made.stroqHome,
      home: made.home,
      sessionId: '11111111-2222-4333-8444-555555555555',
      nonce: 'stroq-live-0123456789abcdef',
      hookMode: 'real',
      deadlineMs: 200,
      env: {},
    },
    graceMs: 50,
  });
  process.stdout.write(
    JSON.stringify({
      found,
      timedOut: requested.sent ? requested.observation.run.timedOut : null,
    }),
  );
} finally {
  removeThrowawayRoot(made.root);
}
