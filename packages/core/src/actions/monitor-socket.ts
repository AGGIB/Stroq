/**
 * Monitor's second mode. Claude Code 2.1.271 takes `command` (a script whose stdout lines
 * are events) or, instead of it, `ws: { url, protocols }` (a WebSocket to open, each text
 * frame an event): "exactly one of command or ws". A socket carries no command, so the
 * readers of `command` saw nothing in it, although it is the more direct way out: the
 * url is an address the model chose, and the protocols are values it sends in the
 * handshake.
 *
 * Read by the classifier (it is an outbound connection, whether or not a command comes with
 * it) and by the secret guard (it is text a known value can be in, all of it). `ws` is a
 * socket when it is an object; a string, a list or `null` there is no socket, and a host that
 * sends one will have Claude Code reject it.
 */

/** A socket is an object: a string, a list, `null` and a number are not one. */
const isSocketObject = (ws: unknown): ws is Readonly<Record<string, unknown>> =>
  typeof ws === 'object' && ws !== null && !Array.isArray(ws);

/** What a Monitor call's `ws` field holds, or `null` when it has none. */
export interface MonitorSocket {
  readonly url: string;
  readonly protocols: readonly string[];
}

export function monitorSocket(toolInput: Readonly<Record<string, unknown>>): MonitorSocket | null {
  const ws = toolInput['ws'];
  if (!isSocketObject(ws)) return null;
  const url = ws['url'];
  const protocols = ws['protocols'];
  return {
    url: typeof url === 'string' ? url : '',
    // One protocol sent as a string is not what the schema says, and is as harmless to read as to skip.
    protocols: Array.isArray(protocols)
      ? protocols.filter((p): p is string => typeof p === 'string')
      : typeof protocols === 'string'
        ? [protocols]
        : [],
  };
}

/**
 * The text of the socket the guard looks for a known value in: all of it, as the MCP path reads its
 * input, as JSON. The url and the protocols are the fields of the schema, and a host that sends more
 * (headers, an auth field of its own) sends it to the same address: every string at any depth is text a
 * known value can be in, and so is a key or a number. Empty for a call with no socket.
 */
export function monitorSocketText(toolInput: Readonly<Record<string, unknown>>): string {
  const ws = toolInput['ws'];
  return isSocketObject(ws) ? JSON.stringify(ws) : '';
}

/** A url longer than this names a host that Stroq does not go looking for: it is not an address anyone types. */
const MAX_HOST_URL_CHARS = 4096;

/** The host of a socket's url, lower case and without its port, or `null` when the url names none. */
export function monitorSocketHost(url: string): string | null {
  if (url.length > MAX_HOST_URL_CHARS) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
