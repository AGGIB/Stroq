import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ENGINE_PATHS, REPOSITORY, engineAvailability } from './control-engine.mjs';
import { executeCard } from './card-process.mjs';
import { runtimeLayout } from './runtime-layout.mjs';

const fail = (status, error) => ({ status, body: { error } });
const ERRORS = [
  'engine-unavailable',
  'deadline-exceeded',
  'output-limit',
  'cancelled',
  'invalid-report',
  'card-failed',
  'server-stopped',
];
const safeError = (error) => (ERRORS.includes(error?.message) ? error.message : 'card-failed');

/**
 * The card for the Check screen. One run at a time; a run is the CLI's own `stroq card --json`, and
 * what the screen shows is made from its answer by the CLI's own wording (`card-view.js`). The last
 * answer is kept in memory so that the screen can be opened again without a new run, and a run that
 * is asked for while one is going is the one that is going.
 */
export async function createCardService(options = {}) {
  const userHome = options.userHome ?? homedir();
  const resolved = {
    paths: ENGINE_PATHS,
    project: REPOSITORY,
    userHome,
    home: options.home ?? process.env.STROQ_HOME ?? join(userHome, '.stroq'),
    environment: process.env,
    view: runtimeLayout().adapter('card-view.js'),
    ...options,
  };
  const now = options.now ?? Date.now;
  const available =
    options.available ??
    (async () => {
      try {
        const s = await lstat(resolved.view);
        if (!s.isFile() || s.isSymbolicLink()) throw new Error();
      } catch {
        return { available: false, version: null };
      }
      return engineAvailability(resolved.paths);
    });
  const present =
    options.present ??
    (async (raw) => {
      const { presentCard } = await import(pathToFileURL(resolved.view).href);
      return presentCard(raw, resolved.userHome);
    });
  const run =
    options.run ??
    ((extra) =>
      executeCard({
        paths: resolved.paths,
        project: resolved.project,
        userHome: resolved.userHome,
        home: resolved.home,
        environment: resolved.environment,
        ...extra,
      }));
  let state = { status: 'idle', startedAt: null, finishedAt: null, error: null, result: null };
  let active = null;
  let stopped = false;
  const clone = (value) => structuredClone(value);

  async function getState() {
    return {
      schema: 'stroq-card-state/1',
      engine: await available(),
      ...clone(state),
    };
  }

  async function start() {
    if (stopped) return fail(503, 'server-stopped');
    if (active) return { status: 202, body: await getState() };
    const engine = await available();
    if (!engine.available) {
      state = {
        ...state,
        status: 'failed',
        error: 'engine-unavailable',
        finishedAt: new Date(now()).toISOString(),
      };
      return { status: 200, body: await getState() };
    }
    const controller = new AbortController();
    state = {
      status: 'running',
      startedAt: new Date(now()).toISOString(),
      finishedAt: null,
      error: null,
      // The last card stays on the screen while the next one is made.
      result: state.result,
    };
    const task = Promise.resolve()
      .then(() => run({ signal: controller.signal }))
      .then(async (raw) => {
        if (controller.signal.aborted) throw new Error('cancelled');
        const result = await present(raw);
        if (result === null || result === undefined) throw new Error('invalid-report');
        state = {
          status: 'done',
          startedAt: state.startedAt,
          finishedAt: new Date(now()).toISOString(),
          error: null,
          result,
        };
      })
      .catch((error) => {
        state = {
          status: 'failed',
          startedAt: state.startedAt,
          finishedAt: new Date(now()).toISOString(),
          error: controller.signal.aborted ? 'cancelled' : safeError(error),
          result: state.result,
        };
      })
      .finally(() => {
        if (active?.task === task) active = null;
      });
    active = { controller, task };
    return { status: 202, body: await getState() };
  }

  return {
    getState,
    start,
    async close() {
      stopped = true;
      const current = active;
      current?.controller.abort();
      await current?.task;
    },
  };
}
