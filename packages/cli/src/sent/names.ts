// The name of a key, as a report prints it and as `--json` holds it.
//
// A name is read from a file or the environment: a `.env` line, a `.netrc` host (`password
// (<host>)`), a Docker registry (`docker auth (<registry>)`), an environment variable, a decoy
// line, the name given to `stroq canary --name`, or Stroq's own log of them. Any of those can
// hold a terminal escape, a line break or a right-to-left mark, which would reach the terminal
// or a script that reads the JSON. So a name is kept only when it has the shape of one: letters,
// digits and `_ . / : @ + -`, or one of the core's labels around a host. Any other is replaced
// with a fixed label. Both patterns are one class with a bound, read once: nothing backtracks.

/** What is printed in place of a key name that does not have the shape of one. */
export const NAME_NOT_SHOWN = '[a name that cannot be printed]';

const PLAIN = /^[A-Za-z0-9_./:@+-]{1,128}$/;
/** `password (api.example.test)`, `docker auth (https://index.docker.io/v1/)`, `([::1]:5000)`. */
const LABELLED = /^(?:password|docker auth|docker password) \([A-Za-z0-9_./:@+[\]-]{1,253}\)$/;

/** The name as it may be printed: as it is when it has the shape of a name, else a fixed label. */
export const keyName = (name: string): string =>
  PLAIN.test(name) || LABELLED.test(name) ? name : NAME_NOT_SHOWN;

/** A program or a server name as a phrase prints it: no path, no quote, no bracket of code. */
const PROGRAM = /^[\w.+[\]-]{1,64}$/;

/** Whether a program or server name has the shape of one, and may be printed. */
export const isProgramName = (word: string): boolean => PROGRAM.test(word);

/** One label of a host name; `_` too, which a URL parser lets through. */
const HOST_LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/i;
/** An IPv6 address, in brackets or not. */
const IPV6 = /^\[?[0-9a-f:.]{2,45}\]?$/i;

/**
 * Whether a host has the shape of one and may be printed: labels of letters, digits, `-` and
 * `_` between dots (one label for an ssh alias or `localhost`), or an IPv6 address. Read one
 * label at a time: nothing backtracks.
 */
export function isHostShape(host: string): boolean {
  if (host.length === 0 || host.length > 254) return false;
  if (host.includes(':')) return IPV6.test(host);
  const labels = (host.endsWith('.') ? host.slice(0, -1) : host).split('.');
  return labels.every((label) => HOST_LABEL.test(label));
}
