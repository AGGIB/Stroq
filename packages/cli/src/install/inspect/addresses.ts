// Addresses that a manifest names for a dependency, said without the parts that must not be kept.
//
// A dependency can come from a place other than a registry: a repository, an archive at an address, a
// folder, a hosted shorthand. The passport says which, and from where, in a form that can be committed:
// the host and the path, and never the user information (`https://user:token@host/...`), the query or
// the fragment, where a credential would be.
import { showable } from './safe-text.js';

export type AddressKind = 'git' | 'url' | 'file' | 'github';

export interface Address {
  readonly kind: AddressKind;
  /** The host, when the address has one that could be read. */
  readonly host: string | null;
  /** What to show of it: the host and path, or the text of a local path or a shorthand. */
  readonly display: string;
}

/** Longest text of a specification that is looked at. */
const SPEC_MAX = 500;
const DISPLAY_MAX = 120;

const GIT_PREFIX = /^(?:git\+|git:\/\/|git@|ssh:\/\/|hg\+|svn\+|bzr\+)/i;
const URL_PREFIX = /^https?:\/\//i;
const FILE_PREFIX = /^(?:file:|link:|portal:|\.{1,2}\/|\/|~\/)/i;
const HOSTED_PREFIX = /^(?:github|gitlab|bitbucket|gist):/i;
/** `owner/repo` and `owner/repo#ref`, the shorthand for a repository on GitHub. */
const SHORTHAND = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#.*)?$/;
/** `user@host:path`, the form git takes for an address on ssh. */
const SCP_LIKE = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/;

function hostAndPath(spec: string): { host: string; path: string } | null {
  const bare = spec.replace(/^(?:git|hg|svn|bzr)\+/i, '');
  try {
    const url = new URL(bare);
    if (url.hostname === '') return null;
    return { host: url.hostname.toLowerCase(), path: url.pathname.replace(/^\//, '') };
  } catch {
    // Not a URL: `git@github.com:owner/repo.git`, or `ssh://git@github.com:owner/repo.git`.
    const scp = SCP_LIKE.exec(bare.replace(/^ssh:\/\//i, ''));
    return scp === null ? null : { host: (scp[1] ?? '').toLowerCase(), path: scp[2] ?? '' };
  }
}

/** The kind of place a specification names, or null if it names a registry (a version, a range, a tag). */
export function addressOf(specification: string): Address | null {
  const spec = specification.trim().slice(0, SPEC_MAX);
  if (spec === '') return null;
  if (GIT_PREFIX.test(spec) || URL_PREFIX.test(spec)) {
    const kind: AddressKind = URL_PREFIX.test(spec) ? 'url' : 'git';
    const found = hostAndPath(spec);
    if (found === null)
      return {
        kind,
        host: null,
        display: showable(spec.replace(/\/\/[^@/]*@/, '//'), DISPLAY_MAX),
      };
    return {
      kind,
      host: found.host,
      display: showable(`${found.host}/${found.path}`, DISPLAY_MAX),
    };
  }
  if (FILE_PREFIX.test(spec))
    return { kind: 'file', host: null, display: showable(spec, DISPLAY_MAX) };
  if (HOSTED_PREFIX.test(spec) || SHORTHAND.test(spec)) {
    return { kind: 'github', host: null, display: showable(spec, DISPLAY_MAX) };
  }
  return null;
}
