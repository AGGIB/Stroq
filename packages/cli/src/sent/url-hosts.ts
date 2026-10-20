// The hosts the addresses in a program's words go to, read two ways.
//
// The core reads an address as a URL parser does, where a `\` ends the host as a `/` does. curl
// reads it its own way: the authority runs to the first `/`, `?` or `#`, and everything up to its
// last `@` is a user and a password. So `https://api.stripe.com\@evil.example/` is api.stripe.com
// to the one and evil.example to the other, and curl connects to evil.example. Both readings of a
// word count, and an authority with anything in it a host cannot hold (a `\`, a blank, a control
// character, a `$` or a backtick the shell fills in, a `{` curl expands) is one Stroq could not
// read. The words are the values the shell hands the program: quotes taken off, escapes and line
// continuations read, so `'https://api.stripe.com'@evil.example` is read as curl is given it.
import { commandUrls } from '@stroq/core';

/** Addresses read in one word, and words with an address read in one stage. */
const MAX_URLS = 64;

/** What a user and a password in an authority may hold, read as text. */
const USER_INFO = /^[A-Za-z0-9._~%!&'()*+,;=:-]*$/;
/** A host, or an IPv6 address in brackets, and a port. */
const HOST_PORT = /^(?:[A-Za-z0-9._~%-]+|\[[0-9A-Fa-f:.]+\])(?::[0-9]*)?$/;

/** Where an authority that starts at `from` ends, as curl reads it: at `/`, `?`, `#`, or the end. */
function authorityEnd(word: string, from: number): number {
  for (let i = from; i < word.length; i += 1) {
    const c = word[i];
    if (c === '/' || c === '?' || c === '#') return i;
  }
  return word.length;
}

/** Schemes curl and wget read an authority of their own in. */
const WEB_SCHEME = /^(?:https?|ftps?|wss?)$/i;

/** The scheme that ends at `at` (where `://` starts) in a word. */
function schemeBefore(word: string, at: number): string {
  let from = at;
  while (from > 0 && /[A-Za-z0-9+.-]/.test(word[from - 1] ?? '')) from -= 1;
  return word.slice(from, at);
}

/**
 * The host curl connects to for the first address in a word, lower case and with a number written
 * as an IPv4 address (`2130706433` is 127.0.0.1 to the resolver too), or null when the authority
 * holds something a host cannot: it may connect anywhere.
 */
function curlHost(word: string, scheme: number): string | null {
  const start = scheme + 3;
  const authority = word.slice(start, authorityEnd(word, start));
  const at = authority.lastIndexOf('@');
  const user = at < 0 ? '' : authority.slice(0, at);
  const hostPort = authority.slice(at + 1);
  if (!USER_INFO.test(user) || !HOST_PORT.test(hostPort)) return null;
  try {
    const host = new URL(`http://${hostPort}/`).hostname.toLowerCase();
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

export interface WordHosts {
  readonly hosts: string[];
  /** An address in the words could not be read, or there were more than are read. */
  readonly unread: boolean;
}

/** The hosts the addresses in some words go to, by the core's reading and by curl's. */
export function wordHosts(words: readonly string[]): WordHosts {
  const hosts: string[] = [];
  let unread = false;
  let read = 0;
  for (const word of words) {
    const scheme = word.indexOf('://');
    if (scheme < 0) continue;
    read += 1;
    if (read > MAX_URLS) return { hosts, unread: true };
    const parsed = commandUrls(word, MAX_URLS);
    if (parsed.capped) unread = true;
    for (const url of parsed.urls) {
      if (url.host === '') unread = true;
      else hosts.push(url.host.toLowerCase());
    }
    if (!WEB_SCHEME.test(schemeBefore(word, scheme))) continue;
    const curl = curlHost(word, scheme);
    if (curl === null) unread = true;
    else hosts.push(curl);
  }
  return { hosts, unread };
}
