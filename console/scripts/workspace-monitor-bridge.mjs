import { lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { runtimeLayout } from './runtime-layout.mjs';
import { jsonAction } from './control-http.mjs';

let loading;
function adapter() {
  loading ??= (async () => {
    const file = runtimeLayout().adapter('workspace-monitor-engine.js');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024 * 1024)
      throw Error('runtime-unavailable');
    const engine = await import(pathToFileURL(file).href);
    if (
      typeof engine.createWorkspaceMonitorControl !== 'function' ||
      typeof engine.routeWorkspaceMonitor !== 'function'
    )
      throw Error('runtime-unavailable');
    return engine;
  })();
  return loading;
}
const unavailable = () => ({ status: 503, body: { error: 'runtime-unavailable' } });

/** A missing fixed adapter cannot fall back to a session writer. */
export async function createSessionTaintControl(configuration = {}) {
  try {
    const engine = await adapter();
    if (typeof engine.createSessionTaintControl !== 'function') throw Error('runtime-unavailable');
    return await engine.createSessionTaintControl(configuration);
  } catch {
    let stopped = false;
    const refused = async () => ({
      status: 503,
      body: { error: stopped ? 'server-stopped' : 'runtime-unavailable' },
    });
    return {
      getState: refused,
      inspect: refused,
      preview: refused,
      clear: refused,
      recheck: refused,
      close: async () => {
        stopped = true;
      },
    };
  }
}

/** Source-bound file changes require the fixed adapter; absence never enables a fallback writer. */
export async function createWorkspaceTaskControl(configuration = {}) {
  try {
    const engine = await adapter();
    if (typeof engine.createWorkspaceTaskControl !== 'function') throw Error('runtime-unavailable');
    return await engine.createWorkspaceTaskControl(configuration);
  } catch {
    let stopped = false;
    const getState = async () => ({
      status: 200,
      body: {
        schema: 'stroq-workspace-task-controls/1',
        workspaceId: configuration.workspaceId,
        generatedAt: new Date().toISOString(),
        available: false,
        history: 'unavailable',
        error: stopped ? 'server-stopped' : 'runtime-unavailable',
        records: [],
      },
    });
    return {
      getState,
      state: getState,
      preview: async () => unavailable(),
      apply: async () => unavailable(),
      recheck: async () => unavailable(),
      close: async () => {
        stopped = true;
      },
    };
  }
}

/** Explicit parent admission only; older adapters retain their existing watch support. */
export async function acquireProtectionCheckLease(configuration) {
  try {
    const engine = await adapter();
    if (typeof engine.acquireWorkspaceMonitorLease !== 'function')
      throw Error('runtime-unavailable');
    return await engine.acquireWorkspaceMonitorLease(configuration);
  } catch {
    throw Error('runtime-unavailable');
  }
}

/** Fixed adapter only. Missing builds provide no source fallback and no scheduling authority. */
export async function createWorkspaceMonitorControl(configuration = {}) {
  try {
    return await (await adapter()).createWorkspaceMonitorControl(configuration);
  } catch {
    let stopped = false;
    const state = () => ({
      status: 200,
      body: {
        schema: 'stroq-workspace-monitor/1',
        workspaceId: configuration.workspaceId,
        status: stopped ? 'stopped' : 'unavailable',
        reason: stopped ? 'server-stopped' : 'runtime-unavailable',
        revision: null,
        configuredAt: null,
        runtimeSha256: null,
        intervalMs: 300000,
        nextCheckAt: null,
        activeRunId: null,
        lastAttempt: null,
      },
    });
    return {
      state: async () => state(),
      preview: async () => unavailable(),
      apply: async () => unavailable(),
      start: async () => state(),
      close: async () => {
        stopped = true;
      },
    };
  }
}

/** The independent catalog watch is optional; older adapters retain workspace-watch support. */
export async function createInventoryMonitorControl(configuration = {}) {
  try {
    const engine = await adapter();
    if (typeof engine.createInventoryMonitorControl !== 'function')
      throw Error('runtime-unavailable');
    return await engine.createInventoryMonitorControl(configuration);
  } catch {
    let stopped = false;
    const state = () => ({
      status: 200,
      body: {
        schema: 'stroq-inventory-monitor/1',
        workspaceId: configuration.workspaceId,
        status: stopped ? 'stopped' : 'unavailable',
        reason: stopped ? 'server-stopped' : 'runtime-unavailable',
        revision: null,
        configuredAt: null,
        runtimeSha256: null,
        intervalMs: 300000,
        nextCheckAt: null,
        lastAttempt: null,
        latestCheckId: null,
        latestCaptureId: null,
        history: { status: 'unavailable', revision: null, records: [], omitted: 0 },
      },
    });
    return {
      state: async () => state(),
      preview: async () => unavailable(),
      apply: async () => unavailable(),
      start: async () => state(),
      close: async () => {
        stopped = true;
      },
    };
  }
}

// The unavailable route accepts no mutation. Still reject the same ambiguous scalar grammar
// before reporting missing runtime, so absence of an adapter does not relax the HTTP boundary.
function parseUnavailable(text) {
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid-request');
  let at = 0;
  const space = () => {
    while (at < text.length && /[ \t\r\n]/.test(text[at])) at++;
  };
  const string = () => {
    if (text[at] !== '"') throw Error('invalid-request');
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') at += 2;
      else if (text[at++] === '"') {
        const decoded = JSON.parse(text.slice(start, at));
        if (!decoded.isWellFormed()) throw Error('invalid-request');
        return decoded;
      }
    }
    throw Error('invalid-request');
  };
  space();
  if (text[at++] !== '{') throw Error('invalid-request');
  space();
  const keys = new Set();
  while (text[at] !== '}') {
    const key = string();
    if (keys.has(key)) throw Error('invalid-request');
    keys.add(key);
    space();
    if (text[at++] !== ':') throw Error('invalid-request');
    space();
    if (text[at] === '"') string();
    else if (text.startsWith('null', at)) at += 4;
    else if (text.startsWith('true', at)) at += 4;
    else if (text.startsWith('false', at)) at += 5;
    else throw Error('invalid-request');
    space();
    if (text[at] !== ',') break;
    at++;
    space();
  }
  if (text[at++] !== '}') throw Error('invalid-request');
  space();
  if (at !== text.length) throw Error('invalid-request');
  return value;
}
export { parseUnavailable as parseFixedControlJson };

export async function routeWorkspaceMonitor(req, path, origin, service) {
  try {
    return await (await adapter()).routeWorkspaceMonitor(req, path, origin, service);
  } catch {
    if (req.url.includes('?') || req.url.includes('#')) {
      req.resume();
      return { status: 400, body: { error: 'invalid-request' } };
    }
    if (path === '/api/workspace-monitor') {
      if (req.method !== 'GET') return { status: 405, body: { error: 'method-not-allowed' } };
      if (
        req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
      ) {
        req.resume();
        return { status: 400, body: { error: 'invalid-request' } };
      }
      return service.state();
    }
    if (['/api/workspace-monitor/preview', '/api/workspace-monitor/apply'].includes(path))
      return jsonAction(req, origin, unavailable, 4096, parseUnavailable);
    return { status: 404, body: { error: 'not-found' } };
  }
}

/** The journal view only reads. A missing adapter answers 503 and never reads the journal itself. */
export async function createJournalViewService(configuration = {}) {
  try {
    const engine = await adapter();
    if (typeof engine.createJournalViewService !== 'function') throw Error('runtime-unavailable');
    return await engine.createJournalViewService(configuration);
  } catch {
    return {
      tail: async () => unavailable(),
      summary: async () => unavailable(),
      since: async () => unavailable(),
      close: async () => {},
    };
  }
}

export async function routeJournalView(req, path, origin, service) {
  try {
    const engine = await adapter();
    if (typeof engine.routeJournalView !== 'function') throw Error('runtime-unavailable');
    return await engine.routeJournalView(req, path, origin, service);
  } catch {
    if (req.url.includes('?') || req.url.includes('#')) {
      req.resume();
      return { status: 400, body: { error: 'invalid-request' } };
    }
    if (
      path === '/api/journal/summary' ||
      path === '/api/journal/tail' ||
      path === '/api/journal/since'
    ) {
      req.resume();
      return unavailable();
    }
    return { status: 404, body: { error: 'not-found' } };
  }
}

/** The settings check only reads. A missing adapter answers 503 and never reads a settings file itself. */
export async function createPostureService(configuration = {}) {
  try {
    const engine = await adapter();
    if (typeof engine.createPostureService !== 'function') throw Error('runtime-unavailable');
    return await engine.createPostureService(configuration);
  } catch {
    return { audit: async () => unavailable(), close: async () => {} };
  }
}

export async function routePosture(req, path, origin, service) {
  try {
    const engine = await adapter();
    if (typeof engine.routePosture !== 'function') throw Error('runtime-unavailable');
    return await engine.routePosture(req, path, origin, service);
  } catch {
    if (req.url.includes('?') || req.url.includes('#')) {
      req.resume();
      return { status: 400, body: { error: 'invalid-request' } };
    }
    if (path === '/api/posture') {
      req.resume();
      return unavailable();
    }
    return { status: 404, body: { error: 'not-found' } };
  }
}

/** The threat feed reads pwn.watch only on request. A missing adapter answers 503 and fetches nothing. */
export async function createThreatFeedService(configuration = {}) {
  try {
    const engine = await adapter();
    if (typeof engine.createThreatFeedService !== 'function') throw Error('runtime-unavailable');
    return await engine.createThreatFeedService(configuration);
  } catch {
    return { read: async () => unavailable(), close: async () => {} };
  }
}

export async function routeThreatFeed(req, path, origin, service) {
  try {
    const engine = await adapter();
    if (typeof engine.routeThreatFeed !== 'function') throw Error('runtime-unavailable');
    return await engine.routeThreatFeed(req, path, origin, service);
  } catch {
    if (req.url.includes('?') || req.url.includes('#')) {
      req.resume();
      return { status: 400, body: { error: 'invalid-request' } };
    }
    if (path === '/api/threats') {
      req.resume();
      return unavailable();
    }
    return { status: 404, body: { error: 'not-found' } };
  }
}

export async function routeInventoryMonitor(req, path, origin, service) {
  try {
    const engine = await adapter();
    if (typeof engine.routeInventoryMonitor !== 'function') throw Error('runtime-unavailable');
    return await engine.routeInventoryMonitor(req, path, origin, service);
  } catch {
    if (req.url.includes('?') || req.url.includes('#')) {
      req.resume();
      return { status: 400, body: { error: 'invalid-request' } };
    }
    if (path === '/api/inventory-monitor') {
      if (req.method !== 'GET') return { status: 405, body: { error: 'method-not-allowed' } };
      if (
        req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
      ) {
        req.resume();
        return { status: 400, body: { error: 'invalid-request' } };
      }
      return service.state();
    }
    if (['/api/inventory-monitor/preview', '/api/inventory-monitor/apply'].includes(path))
      return jsonAction(req, origin, unavailable, 4096, parseUnavailable);
    return { status: 404, body: { error: 'not-found' } };
  }
}

export async function routeWorkspaceTasks(req, path, origin, service) {
  let dispatch;
  try {
    const engine = await adapter();
    if (typeof engine.routeWorkspaceTasks !== 'function') throw Error('runtime-unavailable');
    dispatch = engine.routeWorkspaceTasks;
  } catch {
    if (req.url.includes('?') || req.url.includes('#')) {
      req.resume();
      return { status: 400, body: { error: 'invalid-request' } };
    }
    if (path === '/api/workspace-task-controls') {
      if (req.method !== 'GET') return { status: 405, body: { error: 'method-not-allowed' } };
      if (
        req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
      ) {
        req.resume();
        return { status: 400, body: { error: 'invalid-request' } };
      }
      return service.getState();
    }
    if (
      ['preview', 'apply', 'restore-preview', 'restore', 'recheck'].some(
        (action) => path === `/api/workspace-task-controls/${action}`,
      )
    )
      return jsonAction(req, origin, unavailable, 4096, parseUnavailable);
    return { status: 404, body: { error: 'not-found' } };
  }
  return dispatch(req, path, origin, service);
}

export async function routeSessionTaint(req, path, origin, service) {
  let dispatch;
  try {
    const engine = await adapter();
    if (typeof engine.routeSessionTaint !== 'function') throw Error('runtime-unavailable');
    dispatch = engine.routeSessionTaint;
  } catch {
    if (req.url.includes('?') || req.url.includes('#')) {
      req.resume();
      return { status: 400, body: { error: 'invalid-request' } };
    }
    if (path === '/api/session-taint') {
      if (req.method !== 'GET') return { status: 405, body: { error: 'method-not-allowed' } };
      if (
        req.headers['transfer-encoding'] !== undefined ||
        (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
      ) {
        req.resume();
        return { status: 400, body: { error: 'invalid-request' } };
      }
      return service.getState();
    }
    if (['inspect', 'preview', 'clear', 'recheck'].some((x) => path === `/api/session-taint/${x}`))
      return jsonAction(req, origin, unavailable, 4096, parseUnavailable);
    return { status: 404, body: { error: 'not-found' } };
  }
  return dispatch(req, path, origin, service);
}
