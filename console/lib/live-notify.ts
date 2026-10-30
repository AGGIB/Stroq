import { describeRow, type JournalRow } from './journal-view';

/**
 * What a desktop notification says when the Live page is in the background and new rows arrive.
 * Only denied actions and flagged results notify: an `ask` already stopped at the agent's own
 * prompt, and an allowed action is not news. The text is built from the same fixed wording as the
 * feed, so it holds a coarse tool kind, an action label and a bundled rule id, never a command,
 * path or URL.
 */
export interface LiveNotification {
  readonly title: string;
  readonly body: string;
}

const needsLook = (row: JournalRow): boolean => row.phase === 'post' || row.decision === 'deny';

export function notificationFor(rows: readonly JournalRow[]): LiveNotification | null {
  const notable = rows.filter(needsLook);
  const first = notable[0];
  if (first === undefined) return null;
  if (notable.length === 1) {
    const words = describeRow(first);
    return {
      title: first.phase === 'post' ? 'Stroq flagged a result' : 'Stroq recorded a denied action',
      body: `${words.title}. ${words.detail}`,
    };
  }
  const flagged = notable.filter((row) => row.phase === 'post').length;
  const denied = notable.length - flagged;
  const parts = [
    denied > 0 ? `${denied} denied` : null,
    flagged > 0 ? `${flagged} flagged` : null,
  ].filter((part): part is string => part !== null);
  return {
    title: `Stroq: ${notable.length} actions need a look`,
    body: `${parts.join(', ')}. Open Live to see them.`,
  };
}
