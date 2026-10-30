import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { serialize } from 'node:v8';

const TTL = 300_000,
  MAX_CURSORS = 256,
  MAX_MEMORY = 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const closed = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

/** This fixed read protocol has only string/null scalars; reject duplicate decoded keys. */
export function parseTaskLockPageJson(text) {
  const value = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid-request');
  let at = 0;
  const space = () => {
    while (at < text.length && /[ \t\r\n]/.test(text[at])) at++;
  };
  const string = () => {
    if (text[at] !== '"') throw Error('invalid-request');
    const start = at++;
    while (at < text.length) {
      if (text[at] === '\\') at += 2;
      else if (text[at++] === '"') return JSON.parse(text.slice(start, at));
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

/** Server-held page continuations contain only private bindings, never browser offsets or paths. */
export function createTaskLockPages({
  workspaceId,
  schema,
  now,
  context,
  worker,
  assertBound,
  unavailable,
}) {
  const cursors = new Map(),
    expired = new Set();
  let memory = 0,
    stopped = false;
  function remove(id, timedOut = false) {
    const entry = cursors.get(id);
    if (!entry) return;
    cursors.delete(id);
    clearTimeout(entry.timer);
    memory -= entry.bytes;
    if (timedOut) {
      expired.add(id);
      while (expired.size > MAX_CURSORS) expired.delete(expired.values().next().value);
    }
  }
  function issue(value) {
    const bytes = serialize(value).byteLength;
    if (bytes > MAX_MEMORY) throw Error('invalid-report');
    for (const [id, entry] of cursors) if (entry.expires <= now()) remove(id, true);
    while (cursors.size >= MAX_CURSORS || memory + bytes > MAX_MEMORY)
      remove(cursors.keys().next().value);
    const id = randomUUID(),
      expiresAt = now() + TTL;
    const timer = setTimeout(() => remove(id, true), TTL);
    timer.unref();
    cursors.set(id, { value: structuredClone(value), bytes, expires: expiresAt, timer });
    memory += bytes;
    return id;
  }
  function cursor(id) {
    const entry = cursors.get(id);
    if (entry && entry.expires <= now()) remove(id, true);
    if (!cursors.has(id)) throw Error(expired.has(id) ? 'task-page-expired' : 'task-page-stale');
    return structuredClone(entry.value);
  }
  function body(state, index = 1, nextCursor = null, catalogLimited = false) {
    const value = {
      schema: 'stroq-task-lock-page/1',
      state,
      page: { index, nextCursor, catalogLimited },
    };
    if (!schema.validateTaskLockPage(value) || state.workspaceId !== workspaceId)
      throw Error('invalid-report');
    return structuredClone(value);
  }
  async function read(input) {
    if (stopped) throw Error('server-stopped');
    if (
      typeof schema?.validateTaskLockPage !== 'function' ||
      typeof schema?.validateTaskLockPageRequest !== 'function'
    )
      throw Error('runtime-unavailable');
    if (input !== null && !schema.validateTaskLockPageRequest(input))
      throw Error('invalid-request');
    const prior = input && Object.hasOwn(input, 'cursor') ? cursor(input.cursor) : null;
    let bound;
    try {
      bound = await context();
    } catch (error) {
      if (prior && error?.message !== 'server-stopped') throw Error('task-page-stale');
      if (
        input === null &&
        ['context-unavailable', 'runtime-unavailable', 'platform-unsupported'].includes(
          error?.message,
        )
      )
        return body(unavailable(error.message));
      throw error;
    }
    if (prior && !isDeepStrictEqual(prior.bound, bound)) throw Error('task-page-stale');
    const selected = prior
      ? { offset: prior.offset, expectedListingSha256: prior.listingSha256 }
      : (input ?? { offset: 0, expectedListingSha256: null });
    const made = await worker('page', selected, bound);
    if (stopped) throw Error('server-stopped');
    try {
      await assertBound(bound);
    } catch {
      throw Error('task-page-stale');
    }
    if (stopped) throw Error('server-stopped');
    if (
      !closed(made, ['state', 'listing']) ||
      !closed(made.listing, ['sha256', 'offset', 'total', 'limited'])
    )
      throw Error('invalid-report');
    const listing = made.listing;
    if (
      typeof listing.sha256 !== 'string' ||
      !SHA.test(listing.sha256) ||
      !Number.isSafeInteger(listing.offset) ||
      listing.offset < 0 ||
      listing.offset > 8128 ||
      listing.offset % 64 !== 0 ||
      !Number.isSafeInteger(listing.total) ||
      listing.total < 0 ||
      listing.total > 8192 ||
      (listing.total === 0 ? listing.offset !== 0 : listing.offset >= listing.total) ||
      typeof listing.limited !== 'boolean' ||
      (Object.hasOwn(selected, 'offset') && listing.offset !== selected.offset)
    )
      throw Error('invalid-report');
    if (prior && listing.sha256 !== prior.listingSha256) throw Error('task-page-stale');
    if (input && Object.hasOwn(input, 'id')) {
      const row = made.state?.tasks?.find((item) => item.id === input.id);
      if (
        !row ||
        (input.expectedPermitSha256 !== null && row.permitSha256 !== input.expectedPermitSha256)
      )
        throw Error('invalid-report');
    }
    // Validate before retaining a continuation or publishing any worker output.
    const hasNext = made.state?.available && listing.offset + 64 < listing.total;
    body(
      made.state,
      listing.offset / 64 + 1,
      hasNext ? '00000000-0000-0000-0000-000000000000' : null,
      listing.limited,
    );
    const nextCursor = hasNext
      ? issue({ bound, listingSha256: listing.sha256, offset: listing.offset + 64 })
      : null;
    return body(made.state, listing.offset / 64 + 1, nextCursor, listing.limited);
  }
  return {
    first: () => read(null),
    select: (input) => read(input),
    close() {
      stopped = true;
      for (const id of cursors.keys()) remove(id);
      expired.clear();
    },
  };
}
