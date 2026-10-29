# Live

**Live** (`/live/`) shows what your agents are doing as it happens: a status line, four counts and a
feed that grows from the top. It is the screen to leave open next to an agent, and the one that
shows Stroq working: a denied action appears within about two seconds of the hook recording it.

Everything on it comes from the audit journal, `<Stroq home>/audit.jsonl`. It reads; it never starts,
changes or stops anything.

## What you see

- **Status line.** `Watching your journal`, when the last action was recorded and when the page last
  checked. A dot pulses while it is following (not under reduced motion). **Pause** stops the feed
  and the counts together; **Resume** continues from the same place. If the journal moved on past what
  could be read in one go, the page says there is a gap and invents no count.
- **Counts.** Allowed, Asked you, Denied and Flagged for the newest part of the journal, with the time
  they start from. They refresh every 15 seconds and about half a second after new rows arrive.
- **Feed.** One row per recorded action: time, the decision (`Allowed`, `Asked you`, `Denied`, or
  `Flagged` for a result that looked like an instruction to the agent), a plain title such as
  _Run a command_ or _Write a file_, and what Stroq noticed (for example _Outbound shell command,
  Credential in outbound input. Rule deny-secret-egress._). **Needs a look** filters to denied, asked
  and flagged rows.
- **Notify me.** An opt-in button in the status line. When on, a desktop notification appears while
  the page is open in a background tab and an action is denied or a result is flagged (not for an
  allowed or asked action; whether a host also asked you is not something the journal records). The text is built from
  the same fixed wording as the feed: a coarse tool kind, an action label and a bundled rule id, never a
  command, path or URL (`console/lib/live-notify.ts`). Your browser asks for permission when you turn it
  on, and the choice is kept in this browser only. It works only while the tab is open: closing it
  stops the notifications, and browsers slow background tabs, so a notification can arrive up to about
  a minute late. A browser that does not support notifications does not show the button.
- **Receipt.** Below the feed, the text of a short receipt: the number of recorded actions and the
  window they cover (in UTC), the four counts, the five most common kinds of action and, when a
  settings file was read, the settings check counts. **Copy** and **Download** (a `.md` file) hand over
  exactly that text, so you can see what you share before you share it. It holds numbers and fixed
  wording only; the notable rows, rule ids, sessions, commands, paths and secrets are not inputs to it.
  It says the counts are recorded policy decisions, not proof that a host stopped anything. It is
  absent when there is no journal to report. Built in `console/lib/receipt.ts`.
- When the journal does not exist yet, cannot be read safely, or has a gap, the page says exactly that
  and points to **Try an action** and Protection. An unreadable journal is never shown as "nothing
  happened".

## What a row holds, and what it does not

A row keeps: when, whether it is before or after the tool ran, the recorded decision, a coarse tool
kind (command, file read, file write, search, web, MCP, sub-agent, other), the action classes, the
id of a **bundled** rule, a pseudonymous session (`session-` plus a hash) and the digest of the raw line.

It never holds the command, path, URL, tool name, summary, reason, secret names or a raw session id.
A rule from your own policy shows as "a rule in your own policy" because its id is your text. The
journal records no agent or project, so the page does not say which agent acted.

## How it works

- `POST /api/journal/tail` with `{ "after": null | "<seq>.<sha256 of that line>" }`. The cursor is one
  opaque string because the strict request parser reads flat objects. The reply holds at most 100
  rows, oldest first, and a `head` to continue from.
  - `start`: no cursor; the newest 25 rows.
  - `ok`: rows newer than the cursor. A backlog is returned 100 at a time and the page asks again at
    once.
  - `reset`: the line at that sequence number is a different line, or the cursor is ahead of the
    journal, so it is not the journal the cursor came from. The page starts over.
  - `gap`: the cursor is older than the window that was read. Some rows may be missing and no count
    is invented.
- `GET /api/journal/summary`: counts, the top action classes, tool kinds and the newest eight denied,
  asked or flagged rows over the same window, and the home screen's week: today and the six local days
  before it, each counted the same way and marked `all`, `part` or `none` for how much of the day the
  window reaches. A row stamped after today counts today. `daysComplete` is true only where every day
  was read whole and no line of the window was unreadable, since such a line may hold any decision.
- `POST /api/journal/since` with `{ "since": "<ISO time>" }`: what was recorded after a moment (the
  home screen's last visit, kept in that browser per workspace), counted from the same window, with
  `complete` and the number of unreadable lines. A moment more than five minutes ahead of this
  machine's clock is refused. The home screen records a visit only after it has shown its result with
  the tab in view, so a visit whose read failed does not move it.
- The reader takes the newest 1 MiB of the file. It refuses a journal that is a link, has more than
  one name, is owned by someone else or is group- or world-writable, and so does a Stroq folder that
  is. Only those two are checked: a link higher up the path, such as a home folder that is a link, is
  followed. A line longer than 256 KiB is not read and is counted. A line with a suspect result is kept
  even when the tool call failed, because the text it returned can still look like an instruction;
  other failed calls are not shown. It tolerates a hook appending during the read and refuses a file that got shorter. An
  unfinished last line is left for the next read. Lines out of order or not a record are counted, and the page says how many lines could not
  be read, because a damaged or out-of-order line can hide the rows after it.
- All three operations are closed schemas on the server and again in the browser. They write nothing under
  the Stroq home and return `busy` never: concurrent reads are independent.
- The page polls every 2 seconds, pauses while the tab is hidden, backs off on errors and stops after
  five failures with a button to try again.

## Limits

- These are recorded policy decisions and scan observations, not proof that a host stopped anything.
- Reading does not verify the hash chain. Investigations does that on request, and says what it
  cannot show (a cut-off tail, a rewritten chain).
- Only the newest megabyte is read, so counts describe that window, not all time.
- It shows what Stroq recorded. An agent that does not call Stroq's hooks leaves no rows here; check
  that on **Agents & coverage**.

## Where it lives

- Page: `console/components/platform/live-view.tsx`, hook `use-journal-live.ts`; wording, schemas
  and the row merge in `console/lib/journal-view.ts`.
- Server: `console/scripts/journal-view-reader.ts` (safe bounded read and projection),
  `journal-view-service.ts`, `journal-view-http.ts`, loaded through `workspace-monitor-bridge.mjs`
  with a fail-closed fallback.
- Tests: `lib/journal-view.test.ts` (schemas, wording, row merge), `scripts/journal-view-service.test.mjs`
  (cursor, privacy, bounds, refusals) and `scripts/journal-view-http.test.mjs` (gates, writes nothing).
