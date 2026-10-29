# Threat feed

**Settings → Threat feed** is off until you turn it on. When it is on, the Protection page lists
incidents from [pwn.watch](https://pwn.watch/), a public list of breaches, attacks on packages and
urgent patches kept by a third party, that match this project. Stroq does not check what pwn.watch
says; each match links to the incident's page there.

## What is downloaded, and what is sent

- One fixed address, `https://pwn.watch/incidents.json`, by the console's own server on this machine,
  never by the page. The page's content security policy is unchanged (`connect-src 'self'`).
- Only when the Protection page asks, which it does only in a browser where the feed is on. With the
  feed off, nothing is downloaded. The switch is kept in that browser.
- At most once every 15 minutes; a list that has not changed is answered by its ETag without the body.
  After a failed download the next try waits a minute, then two, four and eight, up to fifteen. The
  waits are measured on a clock that only goes forward. Pages that ask at the same moment share one
  download.
- No redirects, HTTPS only, at most 4 MiB, at most 20 seconds. A list that is not pwn.watch's, an empty
  one, one most of whose incidents do not fit the expected fields, or one less than half the size of
  the list it would replace is refused, and the copy before it is kept; an incident that does not fit
  is left out and counted on the page.
- A list more than a day old, because every download since failed, is not shown.
- The request carries `accept` and `user-agent: stroq-console` and nothing about the machine or the
  project. pwn.watch sees a download from your address, and, when you open an incident's page from the
  list, which incident you opened.

## What it is compared with

All on this machine, from a fixed list of files; nothing the browser sends picks a path:

- the packages this project lists in `package.json`, `pyproject.toml`, `requirements.txt` and
  `Pipfile` (direct dependencies only; lockfiles are not read), each file read under the settings
  check's rules: bounded, never through a link the repository ships, and never a file with a second
  name (a hard link);
- the ecosystems its files show: npm, PyPI, GitHub Actions (`.github/workflows`), Docker, Go, Rust,
  Ruby, PHP, WordPress, Java and .NET;
- the coding agents set up in your home folder: Claude Code (`~/.claude`), Cursor (`~/.cursor`) and
  Codex CLI (`~/.codex` or `CODEX_HOME`).

An incident matches in three ways, most pressing first:

1. it names, as a package (with a version, marked `(npm)` or `(PyPI)`, scoped, or in the list after
   "npm" or "PyPI"), a package this project lists, within the last half year;
2. its product names a coding agent set up here;
3. it is a supply-chain attack pwn.watch still follows (or updated in the last two weeks), filed first
   under an ecosystem this project uses.

A tag counts as a package name only for a patch, where pwn.watch tags the product by its own name;
elsewhere tags name the companies hit and the kinds of attack, and pwn.watch tags some browser and
kernel bugs `anthropic` because Anthropic found them.

## Limits

- A match means pwn.watch names something you use, not that you are affected: the versions it gives
  are prose, so the page asks you to check yours.
- Only direct dependencies are compared. A worm in a dependency of a dependency is shown only as an
  attack in the ecosystem.
- No match is not a clean bill: pwn.watch lists what it lists, and the matching above is narrow on
  purpose.
- The page shows three matches and counts the rest; the answer holds at most five. Each shows what
  pwn.watch says about a fix (a fixed version out, partly fixed, no fix yet, no fix needed).
- Titles are cleaned of control, format and invisible characters, and one with nothing visible left is
  dropped.
