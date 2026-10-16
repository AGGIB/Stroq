import { DEFAULT_BUDGET_MS } from '@stroq/core';
import { MAX_PENDING } from './framing.js';
import { MCP_MAX_RESULT_CHARS } from './mcp-result-text.js';

/**
 * The named bounds of `stroq mcp --strict`. Strict mode exists so that nothing a server
 * says reaches the client unless Stroq read and scanned all of it, which only holds if
 * reading and scanning cannot be made unbounded by the server. Each constant is one of
 * those bounds; where an existing constant already says it, it is reused, not copied.
 */

/**
 * How many messages a server may have withheld in one run before strict mode ends it.
 * Small on purpose: a server that is merely chatty can be told apart from a hostile one
 * by how soon it crosses a bound, and every withheld message is an audit line, so the
 * count is also what bounds the audit a hostile server can cause. `--strict-max-withheld`
 * changes it for one wrapper.
 */
export const DEFAULT_STRICT_MAX_WITHHELD = 20;

/**
 * The cap for the withheld messages that a benign server also produces: log lines, a
 * progress notification with a message, a scan that ran out of time, a text past the scan
 * window. They are counted and audited like the rest, but they do not count toward
 * `--strict-max-withheld`, since a chatty server is not an attacker; a server that sends
 * this many is flooding, and is ended all the same. Every one of them is an audit line,
 * so this is also the bound on the audit a flood of them can write.
 */
export const STRICT_MAX_BENIGN_WITHHELD = 1000;

/**
 * The longest string Stroq treats as an id or a progress token: one a client could have
 * chosen, short and plain. A longer one is a field a server is using for something else.
 * It is also the longest id echoed back to a server in a refusal.
 */
export const STRICT_ID_CHARS = 64;

/** The most digits of an integer id read from the head of an unparsable line: 2^53 has sixteen. */
export const STRICT_ID_DIGITS = 15;

/** The largest `--strict-max-withheld` accepted: a wrapper that sets 0 or a million has not asked for a bound. */
export const MAX_STRICT_MAX_WITHHELD = 1000;

/**
 * The wall-clock ceiling, in milliseconds, for scanning one server message in strict
 * mode. It is the engine's own scan budget (4,000 ms), but HARD: the engine checks its
 * budget only between rules, so one slow rule on a 100 KB result was measured holding
 * the proxy for 12 to 18 seconds. Strict mode runs the scan under a timer the runtime
 * enforces (see `strict-scan.ts`) and treats an overrun as a message it could not read.
 * Deliberately NOT read from `STROQ_SCAN_BUDGET_MS`, which only ever loosens the soft
 * budget and would loosen this bound with it.
 */
export const STRICT_SCAN_DEADLINE_MS = DEFAULT_BUDGET_MS;

/**
 * The most server lines strict mode lets wait in the proxy's queue before it stops
 * reading the server's stdout. The default pump relies on write backpressure alone,
 * which never engages for lines that are withheld rather than written, so a server
 * flooding tiny notifications could otherwise queue them without bound.
 */
export const STRICT_MAX_QUEUED_LINES = 256;

/**
 * The same bound in text rather than in lines: about 32 MiB of queued server output. A
 * line count is no bound on memory when a line can be 8 MiB (256 of them is 2 GiB, and a
 * stalled scan measured 591 MiB held with 2 MiB lines), so the gate pauses at whichever
 * of the two is reached first.
 */
export const STRICT_MAX_QUEUED_CHARS = 32 * 1024 * 1024;

/**
 * The text a strict scan reads: the same 200,000 characters the default scan clips to.
 * Text beyond it is not read, so in strict mode a result that long is withheld rather
 * than delivered with its tail unread.
 */
export const STRICT_MAX_TEXT_CHARS = MCP_MAX_RESULT_CHARS;

/**
 * How deeply a message may nest and still be read. Real results nest a dozen levels;
 * this is the point past which Stroq stops reading and withholds, rather than following
 * a structure that exists to be followed. It is far inside what the serialiser handles,
 * so a message that passes can always be written again.
 */
export const STRICT_MAX_DEPTH = 256;

/**
 * The JSON view of a result (see `strict-views.ts`): the structure as JSON, each string cut
 * to `STRICT_COPY_STRING_CHARS` characters and the whole cut to `STRICT_COPY_MAX_CHARS`.
 * It is there so a rule whose pattern is JSON syntax (a key and its value side by side,
 * about forty bundled rules) has the text it was written for. Both cuts are far below what
 * the default proxy reads of the same JSON, which `strict-views.ts` scans as its own view.
 */
export const STRICT_COPY_STRING_CHARS = 2000;
export const STRICT_COPY_MAX_CHARS = 32 * 1024;

/** Requests the client has cancelled whose late answers are still expected and are dropped without counting. */
export const STRICT_CANCELLED_MEMORY = 256;

/** In-flight requests strict mode tracks: the same bound the default proxy keeps for the results it scans. */
export const STRICT_MAX_TRACKED = MAX_PENDING;

/**
 * How much of the head of a message that could not be parsed strict mode searches for
 * the request id it answers, so the client's request can still be answered. The id of
 * a well-formed response sits within the first few dozen characters.
 */
export const STRICT_ID_SNIFF_CHARS = 512;

/** The JSON-RPC error code strict mode answers withheld requests with: the implementation-defined server error range. */
export const STRICT_ERROR_CODE = -32000;
