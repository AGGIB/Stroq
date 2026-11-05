// Where each URL of the older console now lives. The console has five screens (Check, Live, Agents,
// Rules, Skills & MCP); a bookmark, a link in a document or a page of the older console that still
// names one of the other addresses is sent to the screen that took its place, and the part of the
// address that still means something (a session, an event, a filter) goes with it.
//
// Plain data and one function, with no imports: the server uses it before it looks for a file, and a
// test reads it to check that every address leads to a screen that exists.

const DENIED = 'denied';
const ASKED = 'asked';
const FLAGGED = 'flagged';
const DECISION_TO_SHOW = new Map([
  ['block', DENIED],
  ['ask', ASKED],
  ['flag', FLAGGED],
]);
const SESSION = /^session-[a-f0-9]{16}$/;
const SHA = /^[a-f0-9]{64}$/;

/** The screens, as the menu lists them. */
export const SCREENS = Object.freeze(['/', '/live/', '/agents/', '/policies/', '/skills/']);

/** Old address to new address, for the addresses that move whole and take nothing with them. */
const MOVED = new Map([
  ['/protection/', '/'],
  ['/protection/workspace/', '/#autorun'],
  ['/keys/', '/#keys'],
  ['/settings/', '/'],
  ['/overview/', '/live/'],
  ['/posture/', '/agents/#settings'],
  ['/agents/hooks/', '/agents/'],
  ['/try/', '/policies/#try'],
  ['/policies/reference/', '/policies/#reference'],
  ['/skills/scan/', '/skills/?part=check#check'],
]);

/** Every old address, so that a test can check each one has a place to go. */
export const MOVED_ADDRESSES = Object.freeze([
  ...MOVED.keys(),
  '/skills/quarantine/',
  '/skills/mcp/',
  '/skills/mcp/contracts/',
  '/policies/history/',
  '/activity/',
  '/activity/event/',
  '/sessions/',
  '/incidents/',
]);

const withSlash = (path) => (path.endsWith('/') ? path : `${path}/`);

/** The query of `/live/` made from what an old Activity or Sessions address carried. */
function liveQuery(params) {
  const next = new URLSearchParams();
  const show = DECISION_TO_SHOW.get(params.get('decision') ?? '');
  if (show !== undefined) next.set('show', show);
  const session = params.get('session');
  if (session !== null && SESSION.test(session)) next.set('session', session);
  const text = params.get('q');
  if (text !== null && text.length > 0 && text.length <= 200) next.set('q', text);
  return next;
}

/** The query of `/live/` made from the event an old event or investigation address named. */
function eventQuery(params) {
  const next = new URLSearchParams();
  const id = params.get('id') ?? '';
  const evidence = params.get('evidence') ?? /^incident-([a-f0-9]{64})$/.exec(id)?.[1] ?? null;
  const seq = /^audit-([1-9]\d{0,15})$/.exec(id)?.[1];
  if (evidence !== null && SHA.test(evidence)) next.set('event', evidence);
  else if (seq !== undefined) next.set('event', seq);
  return next;
}

const WORKSPACE = /^workspace-[a-f0-9]{24}$/;
const IDS = {
  // A recorded change: its number, the workspace it belongs to and the filter of the list.
  record: /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
  workspace: WORKSPACE,
  view: /^(?:quarantined|attention|removed|configured)$/,
  // One tool version of one registration.
  registration: /^item-[a-f0-9]{24}$/,
  binding: /^binding-[a-f0-9]{64}$/,
  tool: /^tool-[a-f0-9]{64}$/,
  version: /^[a-f0-9]{64}$/,
};

/** The part of Skills & MCP an old address was about, with the values of it that still read. */
function skillsPartAddress(part, keys, params) {
  const next = new URLSearchParams({ part });
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null && params.getAll(key).length === 1 && IDS[key].test(value))
      next.set(key, value);
  }
  return `/skills/?${next}#${part}`;
}

const suffix = (params) => (params.size > 0 ? `?${params}` : '');

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

/** `/policies/` with the recorded change an old history address named, opened on the History section. */
function historyAddress(params) {
  const entry = params.get('entry');
  return entry !== null && UUID.test(entry)
    ? `/policies/?entry=${entry}#history`
    : '/policies/#history';
}

/**
 * Where an old address now lives, or null for an address that has not moved. `pathname` is the path
 * of the request and `search` its query string with or without the leading `?`.
 */
export function redirectFor(pathname, search = '') {
  if (typeof pathname !== 'string') return null;
  const path = withSlash(pathname);
  const params = new URLSearchParams(search);
  if (path === '/activity/') return `/live/${suffix(liveQuery(params))}`;
  if (path === '/activity/event/' || path === '/incidents/')
    return `/live/${suffix(eventQuery(params))}`;
  if (path === '/policies/history/') return historyAddress(params);
  if (path === '/skills/quarantine/')
    return skillsPartAddress('quarantine', ['workspace', 'record', 'view'], params);
  if (path === '/skills/mcp/')
    return skillsPartAddress('registrations', ['workspace', 'record', 'view'], params);
  if (path === '/skills/mcp/contracts/')
    return skillsPartAddress(
      'tools',
      ['workspace', 'registration', 'binding', 'tool', 'version'],
      params,
    );
  if (path === '/sessions/') return `/live/${suffix(liveQuery(params))}`;
  return MOVED.get(path) ?? null;
}
