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
 * The text a strict scan reads: the same 200,000 characters the default scan clips to.
 * Text beyond it is not read, so in strict mode a result that long is withheld rather
 * than delivered with its tail unread.
 */
export const STRICT_MAX_TEXT_CHARS = MCP_MAX_RESULT_CHARS;

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
