import { closed, stamp } from './local-guards';

/** Where the time of the last visit to the home screen is kept, in this browser only, per workspace. */
export const LAST_VISIT_KEY = 'stroq.console.lastVisit';
/** The visit before this one, held for the tab, so that reloading the page does not move it. */
export const PREVIOUS_VISIT_KEY = 'stroq.console.previousVisit';
/** How long a tab keeps the visit before it: past this, it reads the newest one again. */
export const PIN_MS = 6 * 60 * 60_000;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export interface VisitStorage {
  readonly local: Store | null;
  readonly session: Store | null;
}

export interface Visit {
  /** The time of the visit before this one, or null for a first visit (or where nothing can be kept). */
  readonly previous: string | null;
  /** Records this visit as the last one. Called once what it came to show has been shown. */
  readonly record: () => void;
}

/** The browser's storages, or none where they cannot be reached (a private window, blocked site data). */
export function browserStorage(): VisitStorage {
  const reach = (name: 'localStorage' | 'sessionStorage'): Store | null => {
    try {
      return window[name];
    } catch {
      return null;
    }
  };
  return { local: reach('localStorage'), session: reach('sessionStorage') };
}

// Each reach into storage on its own: one that fails costs only what it would have kept.
function read(store: Store | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: Store | null, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    /* Not kept: the next visit is a first one. */
  }
}

/** A pin of the tab: the visit before it, and when the tab pinned it. */
function pinOf(text: string | null): { previous: string | null; at: string } | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return closed(value, ['previous', 'at']) &&
      (value.previous === null || stamp(value.previous)) &&
      stamp(value.at)
      ? { previous: value.previous as string | null, at: value.at }
      : null;
  } catch {
    return null;
  }
}

/**
 * This visit to the home screen of one workspace. Its `previous` is the last visit recorded before the
 * tab first opened the page, pinned for the tab (for `PIN_MS`) so that "since your last visit" means the
 * same thing however often the page is opened again. Nothing is recorded until `record` is called, so a
 * visit that showed nothing (a failed read, a tab never looked at) leaves the last visit where it was.
 */
export function openVisit(now: Date, storage: VisitStorage, workspace: string): Visit {
  const lastKey = `${LAST_VISIT_KEY}:${workspace}`;
  const pinKey = `${PREVIOUS_VISIT_KEY}:${workspace}`;
  // A time that is not a time, or one still to come (a clock moved back), is no visit.
  const past = (value: string | null): string | null =>
    value !== null && stamp(value) && Date.parse(value) < now.getTime() ? value : null;
  const pin = pinOf(read(storage.session, pinKey));
  const age = pin === null ? Number.NaN : now.getTime() - Date.parse(pin.at);
  let previous: string | null;
  if (pin !== null && age >= 0 && age < PIN_MS) previous = past(pin.previous);
  else {
    previous = past(read(storage.local, lastKey));
    write(storage.session, pinKey, JSON.stringify({ previous, at: now.toISOString() }));
  }
  return { previous, record: () => write(storage.local, lastKey, now.toISOString()) };
}
