'use client';
import { useEffect } from 'react';

/** What an address may name after `#`: the id of a section, never anything else. */
const SECTION = /^[A-Za-z][\w-]{0,63}$/;

/**
 * Scrolls to the section the address names once the page has drawn it. The sections of the screens
 * are drawn after their data arrives, so the browser's own jump to `#history` or `#settings` has
 * nothing to land on; this does it when `ready` turns true, once.
 */
export function useScrollToHash(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    const id = window.location.hash.slice(1);
    if (!SECTION.test(id)) return;
    const frame = requestAnimationFrame(() =>
      document.getElementById(id)?.scrollIntoView({ block: 'start' }),
    );
    return () => cancelAnimationFrame(frame);
  }, [ready]);
}
