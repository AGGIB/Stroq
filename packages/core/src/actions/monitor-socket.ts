/**
 * Monitor's second mode. Claude Code 2.1.271 takes `command` (a script whose stdout lines
 * are events) or, instead of it, `ws: { url, protocols }` (a WebSocket to open, each text
 * frame an event): "exactly one of command or ws". A socket carries no command, so the
 * readers of `command` saw nothing in it, although it is the more direct way out: the
 * url is an address the model chose, and the protocols are values it sends in the
 * handshake.
 *
 * Read by the classifier (it is an outbound connection) and by the secret guard (it is
 * text a known value can be in). Both take what is there and nothing more: a field of
 * the wrong type is not text, and a host that sends one will have Claude Code reject it.
 */

/** What a Monitor call's `ws` field holds, or `null` when it has none. */
export interface MonitorSocket {
  readonly url: string;
  readonly protocols: readonly string[];
}

export function monitorSocket(toolInput: Readonly<Record<string, unknown>>): MonitorSocket | null {
  const ws = toolInput['ws'];
  if (typeof ws !== 'object' || ws === null || Array.isArray(ws)) return null;
  const fields = ws as Readonly<Record<string, unknown>>;
  const url = fields['url'];
  const protocols = fields['protocols'];
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
 * The text of the socket the guard looks for a known value in: the url, then the protocols,
 * a space between each (run together they would make a word that no value matches). Empty
 * for a call with no socket.
 */
export function monitorSocketText(toolInput: Readonly<Record<string, unknown>>): string {
  const socket = monitorSocket(toolInput);
  return socket === null ? '' : [socket.url, ...socket.protocols].filter((p) => p !== '').join(' ');
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
