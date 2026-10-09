# Safe Install — design spec (2026-10-10)

**Goal.** `stroq vet <source>` says what a skill or an MCP server would be able to do, before any of it is on the machine. `stroq add <source>` puts it in a private store only after a person has confirmed the digest of exactly the bytes that were inspected, and `stroq remove` takes it out again. The verb is `add`, not `install`: `stroq install` prints a hint ("stroq has no install: `stroq init` guards an agent, `stroq add` adds a skill or MCP server after a check") so that nobody takes it for the command that guards an agent.

**This spec and the code.** Sections 3 and 4 are a contract: authors will quote a digest in a README and a lock file will pin it, so the format is written here in full and pinned by golden vectors that every OS's CI reproduces. It is built first, as library code with no I/O, in `packages/cli/src/install/{types,tree,safe-path}.ts` with tests in `packages/cli/test/install/`. The rest is the design of record for the later tasks (section 15).

## 1. Sources and kinds

| Source | Form | Notes |
| --- | --- | --- |
| `--from <dir or .tgz>` | a local directory or tarball | offline. A `node_modules` inside a directory is skipped, with a blind spot |
| `npm:<pkg>[@version or tag]` | the registry tarball | its sha-512 is checked before the tarball is read |
| `github:<owner>/<repo>[#ref][:subdir]` | the codeload tarball of a ref | |
| `https://….tgz` | a tarball at a URL | |

Not in the first version: zip, git hosts other than GitHub, vendoring of dependencies (backlog), private repositories.

| Kind | What is supported |
| --- | --- |
| `skill` | everything: `vet`, `add`, `remove` |
| `mcp` | stdio servers run by node. `add` needs self-contained code so that the runtime pin can hold (section 10); if the code is not, `add` refuses and explains. Python and `uvx` servers: `vet` only |
| `plugin` | `vet` only. Claude Code installs plugins itself, under `~/.claude/plugins/{cache,marketplaces}`, and `/plugin install` cannot be intercepted |

## 2. Quarantine in memory

Whatever the source, the result is a `Tree` held in memory: the files with their bytes, under the limits of section 3. The digest, every inspector and, later, the write to the store all use those same bytes. There is no second read, so there is no gap between what was checked and what is used (no TOCTOU), and nothing hostile is on the disk before a person has confirmed. The only writer is `add`, into a content-addressed store (section 8). `vet` writes nothing except what `--out` names.

## 3. The tree and its digest, `stroq-tree/1`

A tree is a list of entries. Empty directories are not entries. An entry is one of three kinds:

| Kind | Letter | Size and hash |
| --- | --- | --- |
| file | `f` | the byte size and the SHA-256 of its raw bytes; `exec` is the owner-execute bit |
| symlink | `l` | recorded, never made on a disk. The size is the byte length of its target text, the hash is of that text's UTF-8 bytes |
| gitlink (a nested repository) | `g` | recorded, never opened. Size 0 and a hash of 64 zeros |

The digest is the SHA-256, in lower-case hex, of this UTF-8 text:

```text
stroq-tree/1\n
<k> <x> <size> <sha256> <path>\n        one line per entry
```

`k` is the letter above, `x` is `1` for an executable file and `0` for anything else, `size` is decimal, and the path comes last so that a space in it needs no escaping. **The lines are sorted by the UTF-8 bytes of the path, compared byte by byte.** Not `localeCompare` (it depends on the machine's locale), and not the default sort of JavaScript, which compares UTF-16 units and puts a character outside the BMP before U+FF5A where the bytes put it after.

- The executable bit is in the digest because it is what turns a file into a program. It is a fact about files only: a symlink or gitlink entry with the flag set is refused, so that two readers cannot disagree about it.
- A path appears once, and is not both a file and the folder of another entry. Two paths that differ only in case or in Unicode composition are legal in a tree (a Linux tree can have both), but they cannot both be written to a case-insensitive filesystem: `findCollisions` (section 4) finds them, and the tar reader refuses them (section 7).
- An LFS pointer is an ordinary file to the digest and an `unknown` line in the passport; so is a gitlink. A file over 8 MiB is refused. A symlink is recorded and never followed or written.
- A tree is checked every time it is hashed, not once when it is made: the path rules, the shape of each entry, the limits, and that each recorded size and hash is that of the bytes (or target text) the entry carries. A tree whose bytes changed after it was built fails with a typed `TreeError`, not with a digest that is no longer true. `buildTree` takes its own copy of the bytes, sorts, and freezes.
- The digest depends only on what the entries record: not on their order, not on whether their bytes are present (a tree read back from a manifest hashes the same), not on time, and not on where on a disk it was read.

Published vectors (all pinned in `packages/cli/test/install/tree-digest.test.ts`, which does no I/O and runs on Linux, macOS and Windows CI; they were worked out by two programs that share no code with the module, and checked with `shasum`):

| Tree | Digest |
| --- | --- |
| empty (the hash of `stroq-tree/1\n`) | `a55df2b9db34f2f996df306efa9d7e40fe435756d35c259054f02079a2db5af9` |
| one file, `SKILL.md` containing `# demo\n` | `46dbb1de69c273f8996ac30dfa1d2fc6ab83ea080e40a4e15d4be87e55ab5223` |
| twelve entries: an executable, a symlink, a gitlink, an empty file, upper- and lower-case names, a space, `é`, a BMP and an astral character | `40d01f91f80f781704e8e0b4945c1ee67cce432b5356ab57d8c7819febf50b7a` |

The test also pins one change of each kind (a byte, the executable bit, a path, an added and a removed entry, a symlink target, a symlink turned into a file); every one gives a different digest.

**Limits** (`LIMITS` in `types.ts`):

| Limit | Value | What it bounds |
| --- | --- | --- |
| `maxCompressed` | 20 MiB | a download, as sent |
| `maxExpanded` | 32 MiB | all the files together, unpacked |
| `maxEntries` | 5000 | entries in a tree |
| `maxPathBytes` | 240 | one path, in UTF-8 bytes |
| `maxDepth` | 20 | components in a path |
| `maxFileBytes` | 8 MiB | one file |
| `perRequestMs`, `totalMs` | 20 s, 60 s | one request, and all of a fetch |

The size limits are judged before anything is hashed, so a tree that is too big is refused for being too big.

## 4. Entry paths

The path of an entry decides where a byte of somebody else's archive lands, and its author chooses it. `checkEntryPath` judges a path as text, before any filesystem is asked, so that the answer is the same on every machine. It returns `{ok: true, path}` with the path unchanged, or `{ok: false, reason}` with a fixed phrase that never repeats the path. Refused:

| Class | Detail |
| --- | --- |
| empty | an empty path, or an empty component (`a//b`, `a/`) |
| dots | a `.` or `..` component |
| absolute | a leading `/` or `\` |
| backslash | any, in any position |
| drive, stream | a drive letter (`C:x`); any `:` (an NTFS alternate data stream) |
| controls | U+0000 to U+001F, U+007F and the C1 block |
| invisible, direction | the bidi overrides and isolates, zero-width and formatting characters, line and paragraph separators, variation selectors, tag characters: the union of what `neutralizeControls` and the replay page's `showInvisible` write out. A parity test asks both helpers about every code point |
| not valid text | a lone surrogate, or U+FFFD (a decoder's mark for bytes that were not UTF-8: two different names would become one) |
| `.git` | a component equal to `.git` in any case, or its NTFS short name (`GIT~1`). Only that: `.gitignore`, `.github/workflows/x.yml` are fine |
| trailing dot or space | Windows drops them, so `a.` and `a` would be one file |
| device names | CON PRN AUX NUL COM0-9 LPT0-9 CONIN$ CONOUT$, any case, with or without an extension (`NUL.txt`). `COM10` and `console.txt` are fine |
| size | more than 240 UTF-8 bytes, or more than 20 components. The length is judged first, so a hostile path is never read beyond its first 240 characters |

`findCollisions(paths)` returns the pairs that cannot both be written to a case-insensitive or normalisation-insensitive filesystem (NTFS, the default APFS, HFS+): equal after Unicode NFC and case folding (`a/README` and `a/readme`; a composed and a decomposed `é`). Case is folded through upper case and back, so that `ß` joins `ss`: a tree that would lose a file on a filesystem that folds that far is refused on all of them. Each later path is paired with the first of its group, so the answer is never longer than the input. `stripTopComponent(paths)` removes exactly one leading component when every path shares it (tarballs have a top folder), and leaves the paths alone otherwise, or when the shared part is empty or a dot.

## 5. The passport

A passport is a record of what was found, never a promise of what is not there. Each line is `{kind, subject, basis, sensitive, where[], detector}`:

- `kind`: `fs.read`, `fs.write`, `net`, `cred.env`, `cred.file`, `exec`, `hook`, `install-script`, `tool`, `allowed-tools` or `signal`.
- `basis`: `declared` (the artifact says so), `observed` (a reading of its files found it), `limited` (Stroq itself holds it to that when it runs it) or `unknown` (something here could not be understood).
- Around the lines: `blindSpots` (what was not looked at), `signals` (`{ruleId, file}`), `imported` (findings of other tools) and `analysis {stroq, rules}`. `PassportSchema` is strict: an unknown key or basis is an error, so a lock file can be validated with it. It holds no time and no path of this machine; its canonical form is `stableStringify`, so `stroq vet --json` is deterministic and an author may commit it to a README.

**Honesty rules.** The absence of a line means nothing, and `blindSpots` are always printed. A negative claim ("no credentials granted") may only rest on basis `limited` (for example `--pass-env`, which the wrapper enforces); otherwise the words are "none seen (static)". A skill gets no promise about run time, because hooks do not know which skill is active. Rule hits are `signals`, not gates: about 15% of harmless documents are flagged.

**What reads what.** Front matter (the `yaml` package, the first block of at most 16 KiB): `allowed-tools`, `hooks`. Fenced shell blocks, inline `` !`cmd` `` and `scripts/*.sh|ps1|bat`, through `classifyCommand`: `shell.network` hosts become `net`, `fs.secrets` becomes `cred.file`, `shell.exec_encoded` is a signal, `shell.unparsed` is `unknown`. `package.json`: `bin` and `main`; the lifecycle scripts `preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`, `postprepare`; `binding.gyp`; a dependency that is not from a registry is sensitive. Heuristics for JS and Python: `process.env.X` and `os.environ` give `cred.env`, a URL literal gives `net`, a URL built at run time gives `unknown`, subprocess and `eval` give `exec` and a signal, native and minified files give a signal and a blind spot. Checks on the in-memory tree: devcontainer, husky, `.envrc`, `.gitmodules`, `.gitattributes`, and `.vscode` autorun through `editorAutorunText` (not `repoSurface`, which leaves out `.git`). `tool` lines exist only after a probe (section 13).

**Other tools' findings.** `--import <file>` takes `stroq-findings/1` or SARIF 2.1.0 and shows each as "reported by X, not verified": at most 200 findings of 300 characters, and they never change the digest. The real Cisco and Snyk formats have not been checked offline; samples are needed.

## 6. Fetch

The only network code is `install/fetch.ts`; a guard test forbids `fetch(`, `http.request` and `https.` in the rest of `cli/src`. https only, through an injectable `Transport`. `--online` is required (or a y/N on a TTY for `add`), and the hosts are printed first (`registry.npmjs.org`, `codeload.github.com`, the host of a URL). At most 3 redirects, only to https hosts on the source's allowlist; IP literals and `localhost` are refused; `Accept-Encoding: identity`; no tokens and no `.npmrc`. The limits of section 3 apply, and a byte counter cuts the stream. **npm:** the registry JSON gives `dist.tarball` (same origin), and the sha-512 of `dist.integrity` is checked before the tarball is parsed; a package without a sha-512 is refused. **GitHub:** codeload; the commit id in the pax header is the server's claim (to be checked against a fixture), so otherwise a 40-hex ref is needed.

## 7. The tar reader

Our own, about 200 lines, with no dependency. It accepts files, directories, pax `x` and `g` and GNU `L`. It refuses links, devices, FIFOs, sparse entries, duplicates, a bad checksum, a tail with data in it, invalid UTF-8 and collisions of case or NFC. It strips exactly one shared top component, applies `checkEntryPath` to every entry, and unzips with `gunzipSync` and `maxOutputLength`. It is fuzzed with `fast-check`.

## 8. Store and lock

`~/.stroq/store/sha256-<first 32 hex>/{manifest.json,tree/…}`: written by temp file and rename, modes 0600 and 0700, no executable bits (the flag is kept in the manifest). It lives inside `~/.stroq`, which `SELF_CONFIG_FILE` already covers, and is denied to writes in the sandbox. The lock is `~/.stroq/passports.json` (zod, `withLock`, temp and rename, 0600). Per name: kind; status (`confirmed`, `drifted` or `revoked`); source and resolved id; digest; the confirmed passport; the grant (`passEnv`, pin); `installedTo`; the previous config entry, for undo; and `history[]` receipts `{v, at, action, name, from, to, material, confirmed, stroq}` with a line in the audit log. There is no project-level lock yet: an agent writes project files, so it would only advise. An author uses `vet --json`; a consumer uses `vet --expect <digest>`.

## 9. Material change, update, remove

A change is **material** when it brings (a) a new sensitive line (a new `net` host, `cred.*`, `exec`, `hook`, `install-script`, wider `allowed-tools`, a new or riskier tool), (b) a weaker basis, (c) a new blind spot (a native or obfuscated file, a non-registry dependency, a new symlink or gitlink), or (d) a changed source, set of maintainers or launch command. A new version or new docs alone is not.

`add <name>` on a name that is installed is an **update**: it re-resolves the source and diffs the capabilities. A material change needs a new typed digest, any other a y/N, and the old install keeps running until it is confirmed. A change outside Stroq marks the name `drifted`, and `add <name> --restore` writes it again from the store. **Remove** deletes a skill's directory only if its digest still matches the lock (otherwise `--force`), restores the earlier entry of an MCP config from its snapshot, cleans the store and writes a receipt.

## 10. Runtime pin for MCP

`stroq mcp --pin sha256:<d>` (after `--client` in the wrapper); `add` writes absolute store paths. `proxy.ts`, the one seam before the server is spawned, refuses to start unless the tree in the store hashes to `<d>` and the lock holds `<d>` as confirmed on this machine. It hashes and copies in a single pass into a private 0700 directory and runs the server from the copy. The honest word is **tamper-evident, not tamper-proof**: it is the same user, and macOS and Windows have no immutability. A wrapper without `--pin` works as before; an older Stroq fails with "unknown option --pin", which is failing closed.

## 11. Confirmation is for a person

`confirmTyped` shows the full digest and asks for its first 12 hex characters: 3 attempts, and end of input is a no. It needs a TTY (stdin and stdout; not CI, not a dumb terminal). **There is no `--yes` and no `--confirm-digest`**, because an agent would read the digest from `vet --json`; without a TTY `add` refuses and points to `vet`. `add`, `remove` and `vet --online` are state-changing commands for the hook gate (`stroq-state.ts`). An agent that has been allowed to drive a pty (python `pty`, `expect`) can still get through, so the docs say it "stops scripts, CI and the agent's direct calls; not an agent you have allowed to drive the terminal".

## 12. Rendering

The terminal view is about 25 lines: the digest at the top, the lines by sensitivity with the tags `[declared]`, `[observed]`, `[limited]`, `[unknown]`, the blind spots, and the number of signals. Every string from outside goes through `outsideLine`, `showInvisible` and a cut. `--out` goes through `neutralizeControls` and is opened with `wx`. The HTML card follows the sent-card: no script, no link, no resource, and the CSP of the replay page. `--card` writes markdown for a README, with the command that reproduces it and the words "not a security certificate".

## 13. The sandboxed first run (last)

Needs `srt` and refuses without it (unlike `run --sandbox`, which only warns). The profile: the tree in a scratch directory outside `$HOME`; `denyRead` on every child of `realpath($HOME)` except the chain to the node prefix; `allowWrite` on the scratch only; `allowedDomains` empty; synthetic HOME, XDG and TMPDIR; the environment is `childEnv([])` without HOME and without `NODE_OPTIONS`. The handshake is `server/discover` (3 s), falling back to `initialize`, then `notifications/initialized` and `tools/list` by `nextCursor` (at most 20 pages and 500 tools); name, title, description, annotations and inputSchema are scanned as the proxy scans them. The handshake moves out of `exposure/probe.ts` into a shared module. Without `srt` it is tested by configuration tests and injections only.

## 14. What is deliberately not promised

- A passport is not a security certificate, and no line absent from it is a promise.
- No run-time limit on a skill; for an MCP server, only the limits Stroq itself enforces (basis `limited`).
- The pin is tamper-evident, not tamper-proof; the confirmation does not stop an agent allowed to drive the terminal.
- Plugins, zip archives, other git hosts, private repositories and dependency vendoring are not handled; a Python server is only looked at.
- The commit id GitHub sends is a claim of the server. The Cisco and Snyk report formats are unchecked until there are samples. Real registry and GitHub answers are covered by fixtures until the first `--online` run on public repositories.

## 15. Who builds what

| Task | Part | Files |
| --- | --- | --- |
| S0 | this contract: types, tree, safe path, digest, spec | `install/{types,tree,safe-path}.ts` |
| S1 | directory reader, store | `install/{read-dir,store}.ts` |
| S2 | fetch, npm, GitHub, tar reader | `install/{fetch,source,fetch-npm,fetch-github,archive-tar}.ts` |
| S3 | inspectors, passport, imports | `install/{inspect-*,passport,import-findings}.ts` |
| S4 | rendering and typed confirmation | `install/render*`, `ui/prompt.ts` |
| S5, S6, S8 | `vet`; `add` and `remove` for skills; for MCP | `commands/vet.ts`, `install/{lock,skill-install,receipt,mcp-install}.ts` |
| S7 | runtime pin | `mcp/{proxy,pin}.ts`, `commands/mcp.ts`, `mcp-config.ts` |
| S11 | sandboxed probe and first run | `exposure/probe.ts`, `run/sandbox.ts` |
