# Safe Install — design spec (2026-10-10)

**Goal.** `stroq vet <source>` says what a skill or an MCP server would be able to do, before any of it is on the machine. `stroq add <source>` puts it in a private store only after a person has confirmed the digest of exactly the bytes that were inspected, and `stroq remove` takes it out again. The verb is `add`, not `install`: `stroq install` prints a hint ("stroq has no install: `stroq init` guards an agent, `stroq add` adds a skill or MCP server after a check") so that nobody takes it for the command that guards an agent.

**This spec and the code.** Sections 3 and 4 are a contract: authors will quote a digest in a README and a lock file will pin it, so the format is written here in full and pinned by golden vectors that the CI of Linux, macOS and Windows is meant to reproduce. No CI has run on this code yet: the vectors and every other test have so far been run on macOS only, so "the same on every OS" is a design goal that the first CI run will confirm or refute. It is built first, as library code with no I/O, in `packages/cli/src/install/{types,tree,safe-path}.ts` with tests in `packages/cli/test/install/`. The rest is the design of record for the later tasks (section 15).

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

`k` is the letter above, `x` is `1` for an executable file and `0` for anything else, `size` is decimal, and the path comes last so that a space in it needs no escaping. Two rules decide the digest, and a reader written in another language must keep both:

1. **The lines are sorted by the UTF-8 bytes of the whole path string, compared byte by byte.** The whole string, not folder by folder. `lib-x` and `lib.js` sort before `lib/a.js`, because `-` (0x2d) and `.` (0x2e) are below `/` (0x2f); a sort that compared the folder `lib` with `lib-x` first, found it shorter, and put everything inside `lib/` ahead of them would give another digest. Not `localeCompare` (it depends on the machine's locale), and not the default sort of JavaScript, which compares UTF-16 units and puts a character outside the BMP before U+FF5A where the bytes put it after.
2. **A path is hashed exactly as it is spelled.** There is no Unicode normalisation of any kind: a composed `é` (U+00E9, UTF-8 `c3 a9`) and a decomposed one (`e` then U+0301, UTF-8 `65 cc 81`) are two names and give two digests. The only text of a path that the digest sees is its UTF-8 bytes.

- The executable bit is in the digest because it is what turns a file into a program. It is a fact about files only: a symlink or gitlink entry with the flag set is refused, so that two readers cannot disagree about it.
- A path appears once, and is not both a file and the folder of another entry. **A tree can be written to every kind of disk.** Two paths that are one name on a filesystem that ignores letter case or Unicode form (NTFS, the default APFS, HFS+) are refused: `README` and `readme`, a composed and a decomposed letter, `ß` and `ss`; so is a file and the folder of another entry that are one name there (`Docs` and `docs/x`). A Linux tree can hold both, no other disk can, and one of the two would overwrite the other. The refusal belongs to the tree contract and not to a reader: `buildTree`, `treeDigest` and `treeManifest` all raise `TreeError('path-collision')`, whose message is a fixed phrase that names no path (the paths are in the error's `path`, for whoever shows them with care). So every reader inherits it, and a Linux tarball that holds `README` and `readme` is refused when it is vetted and not when it is installed. A path given twice is `duplicate-path`, and a file that is also the folder of another entry in exactly the same spelling is `path-conflict`; they are found first. Two folders that differ only in case are not refused by themselves: the files in them collide only when their whole paths do. The folding is in section 4.
- An LFS pointer is an ordinary file to the digest and an `unknown` line in the passport; so is a gitlink. A file over 8 MiB is refused. A symlink is recorded and never followed or written.
- A tree is checked every time it is hashed, not once when it is made: the path rules, the shape of each entry, the limits, that the tree can be written to every disk, and that each recorded size and hash is that of the bytes (or target text) the entry carries. A tree whose bytes changed after it was built fails with a typed `TreeError`, not with a digest that is no longer true. `buildTree` takes its own copy of the bytes (before it hashes them, so that what was hashed is what is kept), sorts, and freezes.
- Each entry is read once. Its properties are copied into a new frozen object while it is checked, and only the copy is used from then on, so an entry that answers differently the second time it is asked (a getter, a proxy, a reader that reuses its objects) cannot make what is hashed, sorted or kept differ from what was checked. The list of entries is read the same way: its length once, and each place in it once.
- The digest depends only on what the entries record: not on their order, not on whether their bytes are present (a tree read back from a manifest hashes the same), not on time, and not on where on a disk it was read.

Published vectors, all pinned in `packages/cli/test/install/tree-digest.test.ts`, which does no I/O and is meant to run on Linux, macOS and Windows CI. The first ten were worked out by two programs that share no code with the module and none with each other (a node script that was given the entries already in byte order, and a Python one that sorts them itself); the first two of those were also checked with `shasum`. All thirteen were then derived again by a third program, written in Ruby from this section alone, which reproduced the first ten exactly and gave the last three. No CI has run yet: the vectors have so far been checked on macOS only.

| Tree | Digest |
| --- | --- |
| empty (the hash of `stroq-tree/1\n`) | `a55df2b9db34f2f996df306efa9d7e40fe435756d35c259054f02079a2db5af9` |
| one file, `SKILL.md` containing `# demo\n` | `46dbb1de69c273f8996ac30dfa1d2fc6ab83ea080e40a4e15d4be87e55ab5223` |
| twelve entries: an executable, a symlink, a gitlink, an empty file, upper- and lower-case names, a space, `é`, a BMP and an astral character | `40d01f91f80f781704e8e0b4945c1ee67cce432b5356ab57d8c7819febf50b7a` |
| rule 1, the whole path: `lib-x` containing `x\n`, `lib.js` containing `js\n`, `lib/a.js` containing `a\n` | `314b81cc68ba1e227418ed0c76e401aa609bd9a18e499585b3ebfbad369404c3` |
| rule 2, composed: one file `café.txt` (the `é` as U+00E9) containing `x\n` | `b30ff40ed2b391f580ed00d7c320ef2bdc037dec5738387202c9b6cb7f50ac59` |
| rule 2, decomposed: the same file with the `é` as `e` and U+0301 | `ed486ccbd1dcc27357665f5ac31cdeb80239c5275170dc6c83cc9d697b9387f4` |

The same three lines of the rule 1 vector in the order of a folder-by-folder sort hash to `43b1c9e7d2cec50e79ae9fe3d5fe46b87a1c7f3685e5a8281b9edeb68bd8ef52`; the test shows that this is not the digest of the tree. The test also pins one change of each kind to the twelve-entry tree (a byte, the executable bit, a path, an added and a removed entry, a symlink target, a symlink turned into a file); every one gives a different digest. The last three vectors exist because the first ten pass under a sort that goes folder by folder and under one that normalises paths to NFC; a mutation of the code in either way now fails exactly its own vector.

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

The limits are judged **one entry at a time, in the order the entries are given**. An entry is hashed only after its size has been held against the limit for a file and against what the entries before it add up to, so the work done before a refusal is bounded by the limits (never more than 32 MiB is hashed), but it is not none: an entry that comes before the one that is over a limit has been hashed already, and the fault reported is the first one in the order given. (The digest of a tree that is accepted does not depend on that order, and a tree that is refused is refused whatever the order; only which fault is named can differ.)

**Hazards for the readers** (found while building the tree, and binding on S1 and S2):

- **The executable bit cannot be known when a directory is read on Windows.** The platform has no owner-execute bit, so a directory read gives `exec` 0 for every file. The digest of a tree read from a directory on Windows therefore differs from the digest of the same files in a tarball, or read on a POSIX disk, whenever one of them is executable. It is labelled `platform-dependent` wherever it is shown, and must never be compared with a tarball digest: `vet --expect` and the lock do not accept it against a digest taken from an archive (a tarball, `npm:`, `github:`, `https:`).
- **The bytes of a working tree are not the bytes of the published archive.** A checkout rewrites files: line endings (`core.autocrlf`), `.gitattributes` filters and keyword expansion, and an editor or a build may do more. The digest is of the bytes that were read, wherever they were read from, so the digest of a directory is not expected to equal the digest an author published for the archive. To check a published artifact, read the published archive.

## 4. Entry paths

The path of an entry decides where a byte of somebody else's archive lands, and its author chooses it. `checkEntryPath` judges a path as text, before any filesystem is asked, so that the answer does not depend on the disk of the machine (it follows the Unicode tables of the Node that runs it, below). It returns `{ok: true, path}` with the path unchanged, or `{ok: false, reason}` with a fixed phrase that never repeats the path. Refused:

| Class | Detail |
| --- | --- |
| empty | an empty path, or an empty component (`a//b`, `a/`) |
| dots | a `.` or `..` component |
| absolute | a leading `/` or `\` |
| backslash | any, in any position |
| drive, stream | a drive letter (`C:x`); any `:` (an NTFS alternate data stream) |
| controls | the `Cc` class: U+0000 to U+001F, U+007F and the C1 block (U+0080 to U+009F, which holds the 8-bit CSI) |
| invisible, direction | decided by Unicode property, not by a list: any character in `Cf` (format characters, the direction marks and isolates among them), `Cs`, `Zl`, `Zp` or `Default_Ignorable_Code_Point` (the soft hyphen, the Hangul fillers, the Arabic letter mark, the combining grapheme joiner, the Khmer inherent vowels, every variation selector including the Mongolian ones, the tag block, and code points reserved for characters of this kind). The ranges of the first version (the union of what `neutralizeControls` and the replay page's `showInvisible` write out) stay as a floor. A sweep asks the engine about every code point and checks that the refused set is exactly the classes; a parity test asks both display helpers about every code point |
| Windows-forbidden | `<` `>` `"` `\|` `?` `*` in any component. A path is promised to be a name on any filesystem. The full-width forms (`？`, `：`) that CJK names use in their place are other characters and are accepted |
| not valid text | a lone surrogate, or U+FFFD (a decoder's mark for bytes that were not UTF-8: two different names would become one) |
| `.git` | a component equal to `.git`, or its NTFS short name `git~N`, after the folding below: any case, and any compatibility spelling (full-width, the dotless `ı`). Only that: `.gitignore`, `.github/workflows/x.yml` are fine. **Of the 8.3 aliases only `git~N` is covered**: the short names of `.gitmodules` or `.gitattributes` (`GITMOD~1`, `GITATT~1`) are not looked for, since those are ordinary files in a tree |
| trailing dot or space | Windows drops them, so `a.` and `a` would be one file |
| device names | CON PRN AUX NUL COM0-9 LPT0-9 CONIN$ CONOUT$, after the folding below, with or without an extension (`NUL.txt`; the extension starts at the first dot of the folded name, so a full-width dot is one). `COM10` and `console.txt` are fine |
| size | more than 240 UTF-8 bytes, or more than 20 components. The length is judged first, so a hostile path is never read beyond its first 240 characters |

**Folding.** There are two questions that a disk answers by folding a name: is it a name that opens something dangerous (`.git`, its short name, a device), and is it the same name as another one in the tree. If the two were answered with different foldings, a spelling would slip past one rule and be taken for the same name by the other (the dotless `ı` is `i` to a filesystem that folds case through upper case and back, and a full-width dot ends the name of a device once it is made plain). So they fold alike. The collision rule folds one name at a time: NFC, then upper case, then lower case, then NFC (composed and decomposed letters are one; `ß` joins `ss`, the two sigmas join, `ı` joins `i`). The rules for fixed names fold the same way after one more step in front, NFKC, which makes full-width and superscript forms plain, as a program that narrows a name to a smaller character set does. The collision rule itself stops at NFC: no filesystem treats a full-width `z` and `z` as one name, and CJK names use the full-width forms on purpose. The structural characters (`/`, `\`, `:`, `.`) are judged as they are spelled, not after folding, for the same reason. A name longer than a path may be is not folded at all, because normalisation is quadratic on a long run of combining marks of mixed classes (65,536 of them take three seconds); such a name is refused by `checkEntryPath` before it could be an entry.

`findCollisions(paths)` returns the pairs that cannot both be written to such a filesystem (NTFS, the default APFS, HFS+): equal after that folding (`a/README` and `a/readme`; a composed and a decomposed `é`). Each later path is paired with the first of its group, so the answer is never longer than the input. It compares whole paths. `findFolderConflicts(paths)` returns the pairs `[file, below]` where a folder of `below` is one name with `file` (`Docs` and `docs/x`; the same spelling included), in time linear in the length of the paths. `buildTree` and `treeDigest` use both (section 3). `stripTopComponent(paths)` removes exactly one leading component when every path shares it (tarballs have a top folder), and leaves the paths alone otherwise, or when the shared part is empty or a dot.

**Decisions beyond the brief.** The brief for the path rules listed traversal, absolute paths, backslash, drive letter, NUL and other controls, `.git`, the alternate data stream colon, trailing dot or space, and the reserved Windows names. The code also decides, and this spec records, that: the C1 block is a control (0x9b is a terminal's CSI); a lone surrogate is refused (it has no UTF-8, so two names would hash alike); U+FFFD is refused; `COM0` and `LPT0` are devices, and so are `CONIN$` and `CONOUT$`, because refusing a file of that name costs nothing; `.git`, its short name and the device names are matched after NFKC and case folding; the invisible characters are a Unicode property and not a list, and follow the Unicode tables of the Node that runs the check (Node 22 and 24 agree on all of them today; a newer Node may refuse more); the six Windows-forbidden characters are refused; collisions are refused at the tree. A path is never rewritten: it passes as it was spelled or it is refused.

## 5. The passport

A passport is a record of what was found, never a promise of what is not there. Each line is `{kind, subject, basis, sensitive, where[], detector}`:

- `kind`: `fs.read`, `fs.write`, `net`, `cred.env`, `cred.file`, `exec`, `hook`, `install-script`, `tool`, `allowed-tools` or `signal`.
- `basis`: `declared` (the artifact says so), `observed` (a reading of its files found it), `limited` (Stroq itself holds it to that when it runs it) or `unknown` (something here could not be understood).
- Around the lines: `blindSpots` (what was not looked at), `signals` (`{ruleId, file}`), `imported` (findings of other tools) and `analysis {stroq, rules}`. `PassportSchema` is strict: an unknown key or basis is an error, so a lock file can be validated with it. It holds no time and no path of this machine; its canonical form is `stableStringify`. **The same artifact, read by the same version of Stroq with the same rules, gives the same passport on any machine**: `analysis.stroq` and `analysis.rules` are part of the passport, because another version may read the same files differently, and then the passport differs. So `stroq vet --json` is deterministic for a given Stroq, and an author who commits one to a README commits it with the version that made it; a passport from another version is not a mismatch of the artifact.
- `artifact.source` is a `SourceRef`, and it is a label, not an address. It tells one source from another and shows a person where an artifact came from; it **cannot be used to fetch the artifact again**. A `url` keeps only its host (a lower-case ASCII host name: no scheme, user information, port, path, query or fragment, and never an IPv4 address); a `dir` or `tarball` keeps a label (at most 80 characters, relative, with no `..` component, and not `/`, `\`, `~` or a drive letter at the start, so that a passport reads the same on every machine); `npm` keeps name, version and integrity; `github` keeps owner, repo, ref, and the commit and subdirectory when there are some. What it takes to fetch again (the whole URL, the resolved commit, the integrity of the tarball) is kept in the lock as a separate, full source spec (section 8).

**Honesty rules.** The absence of a line means nothing, and `blindSpots` are always printed. A negative claim ("no credentials granted") may only rest on basis `limited` (for example `--pass-env`, which the wrapper enforces); otherwise the words are "none seen (static)". A skill gets no promise about run time, because hooks do not know which skill is active. Rule hits are `signals`, not gates: about 15% of harmless documents are flagged.

**What reads what.** Front matter (the `yaml` package, the first block of at most 16 KiB): `allowed-tools`, `hooks`. Fenced shell blocks, inline `` !`cmd` `` and `scripts/*.sh|ps1|bat`, through `classifyCommand`: `shell.network` hosts become `net`, `fs.secrets` becomes `cred.file`, `shell.exec_encoded` is a signal, `shell.unparsed` is `unknown`. `package.json`: `bin` and `main`; the lifecycle scripts `preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`, `postprepare`; `binding.gyp`; a dependency that is not from a registry is sensitive. Heuristics for JS and Python: `process.env.X` and `os.environ` give `cred.env`, a URL literal gives `net`, a URL built at run time gives `unknown`, subprocess and `eval` give `exec` and a signal, native and minified files give a signal and a blind spot. Checks on the in-memory tree: devcontainer, husky, `.envrc`, `.gitmodules`, `.gitattributes`, and `.vscode` autorun through `editorAutorunText` (not `repoSurface`, which leaves out `.git`). `tool` lines exist only after a probe (section 13).

**Other tools' findings.** `--import <file>` takes `stroq-findings/1` or SARIF 2.1.0 and shows each as "reported by X, not verified": at most 200 findings of 300 characters, and they never change the digest. The real Cisco and Snyk formats have not been checked offline; samples are needed.

## 6. Fetch

The only network code is `install/fetch.ts`; a guard test forbids `fetch(`, `http.request` and `https.` in the rest of `cli/src`. https only, through an injectable `Transport`. `--online` is required (or a y/N on a TTY for `add`), and the hosts are printed first (`registry.npmjs.org`, `codeload.github.com`, the host of a URL). At most 3 redirects, only to https hosts on the source's allowlist; IP literals and `localhost` are refused; `Accept-Encoding: identity`; no tokens and no `.npmrc`. The limits of section 3 apply, and a byte counter cuts the stream. **npm:** the registry JSON gives `dist.tarball` (same origin), and the sha-512 of `dist.integrity` is checked before the tarball is parsed; a package without a sha-512 is refused. **GitHub:** codeload; the commit id in the pax header is the server's claim (to be checked against a fixture), so otherwise a 40-hex ref is needed.

## 7. The tar reader

Our own, about 200 lines, with no dependency. It accepts files, directories, pax `x` and `g` and GNU `L`. It refuses links, devices, FIFOs, sparse entries, duplicates, a bad checksum, a tail with data in it and invalid UTF-8. Collisions of case or Unicode form need no rule of its own: the tree it builds refuses them (section 3), so a tarball that holds `README` and `readme` fails when it is vetted. It strips exactly one shared top component, applies `checkEntryPath` to every entry, and unzips with `gunzipSync` and `maxOutputLength`. It is fuzzed with `fast-check`.

## 8. Store and lock

`~/.stroq/store/sha256-<first 32 hex>/{manifest.json,tree/…}`: written by temp file and rename, modes 0600 and 0700, no executable bits (the flag is kept in the manifest). It lives inside `~/.stroq`, which `SELF_CONFIG_FILE` already covers, and is denied to writes in the sandbox. The lock is `~/.stroq/passports.json` (zod, `withLock`, temp and rename, 0600). Per name: kind; status (`confirmed`, `drifted` or `revoked`); the full source spec (the whole URL, the resolved commit, the integrity: what it takes to fetch again, which the passport's `SourceRef` does not hold) and the resolved id; digest; the confirmed passport; the grant (`passEnv`, pin); `installedTo`; the previous config entry, for undo; and `history[]` receipts `{v, at, action, name, from, to, material, confirmed, stroq}` with a line in the audit log. There is no project-level lock yet: an agent writes project files, so it would only advise. An author uses `vet --json`; a consumer uses `vet --expect <digest>`.

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
- A digest of a directory is not the digest of the archive an author published (line endings, filters and keyword expansion change bytes), and on Windows it is platform-dependent (no executable bit): see the hazards in section 3.
- A passport is the same for the same artifact only when it is read by the same Stroq with the same rules; another version may read the same files differently (section 5).
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
