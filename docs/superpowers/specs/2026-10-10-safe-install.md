# Safe Install — design spec (2026-10-10)

**Goal.** `stroq vet <source>` says what a skill or an MCP server would be able to do, before any of it is on the machine. `stroq add <source>` puts it in a private store only after a person has confirmed the digest of exactly the bytes that were inspected, and `stroq remove` takes it out again. The verb is `add`, not `install`: `stroq install` prints a hint ("stroq has no install: `stroq init` guards an agent, `stroq add` adds a skill or MCP server after a check") so that nobody takes it for the command that guards an agent.

**This spec and the code.** Sections 3 and 4 are a contract: authors will quote a digest in a README and a lock file will pin it, so the format is written here in full and pinned by golden vectors that the CI of Linux, macOS and Windows is meant to reproduce. No CI has run on this code yet: the vectors and every other test have so far been run on macOS only, so "the same on every OS" is a design goal that the first CI run will confirm or refute. It is built first, as library code with no I/O, in `packages/cli/src/install/{types,tree,safe-path,path-collision}.ts` with tests in `packages/cli/test/install/`. The rest is the design of record for the later tasks (section 15).

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

Whatever the source, the result is a `Tree` held in memory: the files with their bytes, under the limits of section 3. The digest, every inspector and, later, the write to the store all use those same bytes. There is no second read of the source, and nothing hostile is on the disk before a person has confirmed. The tree copies the bytes in once and freezes its entries, but a byte array cannot be frozen, so what keeps the bytes that are written equal to the bytes that were confirmed is a check and not a lock: **the writer calls `treeDigest(tree)` after the last inspector has run, and writes only if the result is the digest the person confirmed, from the same buffers that it then writes.** Without that re-hash there is a gap, since an inspector that changed `entry.bytes` in place would go unseen (each entry still records the old hash). The only writer is `add`, into a content-addressed store (section 8). `vet` writes nothing except what `--out` names.

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
2. **A path is hashed exactly as it is spelled.** There is no Unicode normalisation of any kind: a composed `é` (U+00E9, UTF-8 `c3 a9`) and a decomposed one (`e` then U+0301, UTF-8 `65 cc 81`) are two names and give two digests. The only text of a path that the digest sees is its UTF-8 bytes, and the order of rule 1 is of the same bytes as spelled: a reader may not sort by a normalised form of the path and then hash the path as spelled (the last two vectors below are built to catch that).

- The executable bit is in the digest because it is what turns a file into a program. It is a fact about files only: a symlink or gitlink entry with the flag set is refused, so that two readers cannot disagree about it.
- A path appears once, and is not both a file and the folder of another entry. **A tree can be written to every kind of disk whose folding rules this module knows, and read back as the list of paths that was inspected.** The rules it knows are simple and full case folding and NFC for ordinary names, and NFKC for the special names of section 4; the rules it does not model are listed as hazards below. A Linux tree can hold three things that no disk which ignores letter case or Unicode form (NTFS, the default APFS, HFS+) can, so a tree that has one of them is refused: two paths that are one name there (`README` and `readme`, a composed and a decomposed letter, `ß`, `ẞ` and `ss`), where one file would overwrite the other; a file and the folder of another entry that are one name there (`Docs` and `docs/x`); and two entries in folders that are one folder there but are spelled two ways (`Docs/a.md` and `docs/b.md`, or a composed and a decomposed folder name), where the disk merges the folders under the spelling of whichever path is written first, so that a read of the disk lists `Docs/b.md`, a path that was never inspected, and the digest of what is on the disk is not the one that was confirmed. In short, a folder has one spelling in a tree. The refusal belongs to the tree contract and not to a reader: `buildTree`, `treeDigest` and `treeManifest` all raise `TreeError('path-collision')`, whose message is one of three fixed phrases that name no path. The paths are in the error, as text from outside for whoever shows them with care: `path` is the later of the two in the order of the digest and `other` the earlier, except for a file and a folder, where `path` is the entry below the file and `other` is the file, whichever sorts first. So every reader inherits it, and a Linux tarball that holds `README` and `readme` is refused when it is vetted and not when it is installed. A path given twice is `duplicate-path`, and a file that is also the folder of another entry in exactly the same spelling is `path-conflict`; they are found first, and then the three above in the order given. The folding is in section 4.
- An LFS pointer is an ordinary file to the digest (an `f` line) and an `unknown` line in the passport. A gitlink is a `g` line (size 0, 64 zeros), recorded and never opened, and an `unknown` line in the passport too. A file over 8 MiB is refused. A symlink is recorded and never followed or written.
- A tree is checked every time it is hashed, not once when it is made: the path rules, the shape of each entry, the limits, that the tree can be written to a disk that ignores letter case and Unicode form and read back as the same paths (the three refusals above), and that each recorded size and hash is that of the bytes (or target text) the entry carries. A tree whose bytes changed after it was built fails with a typed `TreeError`, not with a digest that is no longer true. `buildTree` takes its own copy of the bytes (before it hashes them, so that what was hashed is what is kept), sorts, and freezes.
- Each entry is read once. Its properties are copied into a new frozen object while it is checked, and only the copy is used from then on, so an entry that answers differently the second time it is asked (a getter, a proxy, a reader that reuses its objects) cannot make what is hashed, sorted or kept differ from what was checked. The list of entries is read the same way: its length once, and each place in it once.
- The digest depends only on what the entries record: not on their order, not on whether their bytes are present (a tree read back from a manifest hashes the same), not on time, and not on where on a disk it was read.

Published vectors, all pinned in `packages/cli/test/install/tree-digest.test.ts`, which does no I/O and is meant to run on Linux, macOS and Windows CI. Every digest below was reproduced by the Python program further down, which shares no code with the module and asserts all of them; the first two were also checked with `shasum -a 256`. The text that the twelve-entry vector hashes is printed in full, so that a reader who has not got the module can hash it too. No CI has run yet: the vectors have so far been checked on macOS only.

| Tree | Digest |
| --- | --- |
| empty (the hash of `stroq-tree/1\n`) | `a55df2b9db34f2f996df306efa9d7e40fe435756d35c259054f02079a2db5af9` |
| one file, `SKILL.md` containing `# demo\n` | `46dbb1de69c273f8996ac30dfa1d2fc6ab83ea080e40a4e15d4be87e55ab5223` |
| twelve entries: an executable, a symlink, a gitlink, an empty file, upper- and lower-case names, a space, `é`, a BMP and an astral character | `40d01f91f80f781704e8e0b4945c1ee67cce432b5356ab57d8c7819febf50b7a` |
| rule 1, the whole path: `lib-x` containing `x\n`, `lib.js` containing `js\n`, `lib/a.js` containing `a\n` | `314b81cc68ba1e227418ed0c76e401aa609bd9a18e499585b3ebfbad369404c3` |
| rule 2, composed: one file `café.txt` (the `é` as U+00E9) containing `x\n` | `b30ff40ed2b391f580ed00d7c320ef2bdc037dec5738387202c9b6cb7f50ac59` |
| rule 2, decomposed: the same file with the `é` as `e` and U+0301 | `ed486ccbd1dcc27357665f5ac31cdeb80239c5275170dc6c83cc9d697b9387f4` |
| rule 2, order, a decomposed name that starts like a composed one: `e` U+0301 `a`, and `é` (U+00E9), each containing `x\n` | `226a608853e0118bb823e1f45d505b3d3c452a0ccc0db40d9724df5c475b5e61` |
| rule 2, order, a decomposed accent before `b`: `a` U+0301 `.txt`, and `b.txt`, each containing `x\n` | `9a027587f0ff3dc6289a20b8b71534399367ac27854accc23caaaadcabc87ec4` |

The twelve-entry vector hashes this text, one line per entry in the order of the bytes of the path (`é` is U+00E9, `ｚ` is U+FF5A, and the last name starts with U+1F600). The program at the end of this section lists the twelve entries with their contents.

```text
stroq-tree/1
f 0 1 df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c B.txt
f 0 2 ec39b67830c0c34d71b0b6bf1d1c424eb7caab9222eb401fdaef044cf2145e9b Z.txt
f 0 0 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 _private.txt
f 0 5 3f49dbbfe051cb20cc038923424fedf8d18307cc805e1520e4168e9360e2eb38 a b.txt
f 0 1 ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb a.txt
f 1 18 299001868fb8c02fd431c336c6d058f5558c5dff5b5af5e6fe04b870a6a9cbba bin/run
f 0 1 594e519ae499312b29433b7dd8a97ff068defcba9755b6d5d00e84c524d67b06 docs/z.md
f 0 5 850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e docs/é.md
l 0 10 c13070e42c92f74c8791d1431dd7bc370763659708e5269e492305297a7d1f40 lnk
g 0 0 0000000000000000000000000000000000000000000000000000000000000000 vendor/sub
f 0 2 07f7ab476bc3a83fad639d34a012cb4a5f859441f0d24c11627ca96696839012 ｚ.txt
f 0 5 fa1eadc4c6995667412681c69ce33adfc9302a2965f521c40908549e670e2e4e 😀.txt
```

The test also pins one change of each kind to the twelve-entry tree, and every one gives a different digest:

| The twelve-entry tree with | Digest |
| --- | --- |
| `a.txt` containing `b` instead of `a` | `7d042819a1f11e26d92db75b134f39f226a4835e65119c2ab6741c48bdf12744` |
| `a.txt` executable | `17e02ce0229b30238cf1a92195f398f8be0dc90db13d58bb9b9acecde744216f` |
| `a.txt` renamed `a1.txt` | `3b6500146585ded6e8a23b06a040fbbf512a4ed987ed265b7b014146e4733335` |
| `extra.txt` containing `x` added | `258cba9d4db62ab66ae0142051391bc5f05fb48d2f612ef91af406579208a0fd` |
| `B.txt` removed | `2eaea6e88545eb6525c50cf71969ece606c2e6895968ab40ea343a1964cba4fc` |
| `lnk` pointing at `docs/z.md` | `fcee979ed03f016ca2d62fcd82d1743f7ccb008a40aa4db61e6cdcb52d9bae8e` |
| `lnk` a file that contains the text `docs/é.md` | `a27f3158b3210305a7a265f99d952e6d1d9bb9b4cc3dbfca952b45acb6472d91` |

The same three lines of the rule 1 vector in the order of a folder-by-folder sort hash to `43b1c9e7d2cec50e79ae9fe3d5fe46b87a1c7f3685e5a8281b9edeb68bd8ef52`, and the two lines of each order vector the other way round (the order of a sort by the NFC form of the path) hash to `6ab5845d9d08fcf917c588bd3e76a75fab0274fbe886b23e13f997454bbd67d4` and `2bec8af129a378613e258df664ab7a0697affa1575b03a86afcda633c37910db`; the tests show that none of them is the digest of its tree. The last five vectors exist because the first ten pass under a sort that goes folder by folder and under one that sorts by the NFC form of the path and hashes the path as spelled; a mutation of the code in either way fails its own vectors.

The program below is a reference for the format. It prints nothing, and fails an `assert` when a digest of this section is not reproduced.

```python
import hashlib


def sha(data):
    return hashlib.sha256(data).hexdigest()


def tree_digest(entries):
    """entries: (path, kind, executable, data) with kind f, l or g. data is the bytes of a file,
    the bytes of the target text of a link, or None for a gitlink."""
    lines = []
    for path, kind, executable, data in entries:
        size, hash_hex = (0, '0' * 64) if kind == 'g' else (len(data), sha(data))
        lines.append((path.encode('utf-8'), f'{kind} {int(executable)} {size} {hash_hex} {path}\n'))
    lines.sort(key=lambda line: line[0])  # the bytes of the whole path string, as spelled
    return sha(('stroq-tree/1\n' + ''.join(text for _, text in lines)).encode('utf-8'))


def file(path, text, executable=False):
    return (path, 'f', executable, text.encode('utf-8'))


def without(entries, path):
    return [entry for entry in entries if entry[0] != path]


twelve = [
    file('\U0001f600.txt', 'smile'), ('lnk', 'l', False, 'docs/\u00e9.md'.encode('utf-8')),
    file('docs/\u00e9.md', 'caf\u00e9'), file('a.txt', 'a'), ('vendor/sub', 'g', False, None),
    file('B.txt', 'B'), file('\uff5a.txt', 'fw'), file('bin/run', '#!/bin/sh\necho hi\n', True),
    file('_private.txt', ''), file('Z.txt', 'Z\n'), file('docs/z.md', 'z'), file('a b.txt', 'space'),
]
x = 'x\n'

assert tree_digest([]) == 'a55df2b9db34f2f996df306efa9d7e40fe435756d35c259054f02079a2db5af9'
assert tree_digest([file('SKILL.md', '# demo\n')]) == '46dbb1de69c273f8996ac30dfa1d2fc6ab83ea080e40a4e15d4be87e55ab5223'
assert tree_digest(twelve) == '40d01f91f80f781704e8e0b4945c1ee67cce432b5356ab57d8c7819febf50b7a'
assert tree_digest(without(twelve, 'a.txt') + [file('a.txt', 'b')]) == '7d042819a1f11e26d92db75b134f39f226a4835e65119c2ab6741c48bdf12744'
assert tree_digest(without(twelve, 'a.txt') + [file('a.txt', 'a', True)]) == '17e02ce0229b30238cf1a92195f398f8be0dc90db13d58bb9b9acecde744216f'
assert tree_digest(without(twelve, 'a.txt') + [file('a1.txt', 'a')]) == '3b6500146585ded6e8a23b06a040fbbf512a4ed987ed265b7b014146e4733335'
assert tree_digest(twelve + [file('extra.txt', 'x')]) == '258cba9d4db62ab66ae0142051391bc5f05fb48d2f612ef91af406579208a0fd'
assert tree_digest(without(twelve, 'B.txt')) == '2eaea6e88545eb6525c50cf71969ece606c2e6895968ab40ea343a1964cba4fc'
assert tree_digest(without(twelve, 'lnk') + [('lnk', 'l', False, b'docs/z.md')]) == 'fcee979ed03f016ca2d62fcd82d1743f7ccb008a40aa4db61e6cdcb52d9bae8e'
assert tree_digest(without(twelve, 'lnk') + [file('lnk', 'docs/\u00e9.md')]) == 'a27f3158b3210305a7a265f99d952e6d1d9bb9b4cc3dbfca952b45acb6472d91'
assert tree_digest([file('lib/a.js', 'a\n'), file('lib.js', 'js\n'), file('lib-x', x)]) == '314b81cc68ba1e227418ed0c76e401aa609bd9a18e499585b3ebfbad369404c3'
assert tree_digest([file('caf\u00e9.txt', x)]) == 'b30ff40ed2b391f580ed00d7c320ef2bdc037dec5738387202c9b6cb7f50ac59'
assert tree_digest([file('cafe\u0301.txt', x)]) == 'ed486ccbd1dcc27357665f5ac31cdeb80239c5275170dc6c83cc9d697b9387f4'
assert tree_digest([file('\u00e9', x), file('e\u0301a', x)]) == '226a608853e0118bb823e1f45d505b3d3c452a0ccc0db40d9724df5c475b5e61'
assert tree_digest([file('a\u0301.txt', x), file('b.txt', x)]) == '9a027587f0ff3dc6289a20b8b71534399367ac27854accc23caaaadcabc87ec4'
```

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

**Hazards for the readers** (found while building the tree, and binding on S1 and S2). The promise of this section is made for what the module checks, and these are the places where a platform does something that it does not:

- **The executable bit cannot be known when a directory is read on Windows.** The platform has no owner-execute bit, so a directory read gives `exec` 0 for every file. The digest of a tree read from a directory on Windows therefore differs from the digest of the same files in a tarball, or read on a POSIX disk, whenever one of them is executable. It is recorded in the passport as a blind spot (a fixed string in `blindSpots`; the strict `PassportSchema` gets no new key, so there is no format bump later) and is labelled `platform-dependent` wherever it is shown. Two rules can be enforced, and S5 and S6 hold to them: `vet --from <dir> --expect <digest>` is refused on Windows (`--expect` takes a bare 64-hex string that carries no provenance, so it cannot tell where the digest came from), and the lock refuses to compare a platform-dependent digest with one whose source is an archive kind (`tarball`, `npm`, `github`, `url`).
- **The bytes of a working tree are not the bytes of the published archive.** A checkout rewrites files: line endings (`core.autocrlf`), `.gitattributes` filters and keyword expansion, and an editor or a build may do more. The digest is of the bytes that were read, wherever they were read from, so the digest of a directory is not expected to equal the digest an author published for the archive. To check a published artifact, read the published archive. A volume that stores names decomposed (HFS+) lists an accented name as a letter and a combining mark, which is another path to the digest (rule 2), so a directory read from one differs from the archive for the same reason.
- **A directory that is a git clone holds `.git`, which the path rules refuse.** Its first entry would make `buildTree` raise `bad-path` and the whole read fail. The directory reader (S1) leaves a `.git` entry out, wherever it is (a directory, or the file that a submodule has), and says so with a blind spot, as it does for `node_modules`. It does not pass the entry on to the tree.
- **What the tree contract does not model.** Everything it promises it promises for the folding rules it knows (simple and full case folding, NFC, and NFKC for the special names). It does not model: the 8.3 short names that NTFS makes for long names, other than `git~N` (`a-long-script.sh` and `a-long~1.sh` are two ordinary names to the module, and on a volume that makes short names the second can be taken for the alias of the first and replace it); HFS+ decomposing names, which makes a composed name read back as another path; and a disk whose case table is older or newer than the Unicode tables of the Node that runs the check. A tree that passes can still lose a file or read back differently on such a disk.

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
| invisible, direction | decided by Unicode property, not by a list: any character in `Cf` (format characters, the direction marks and isolates among them), `Cs`, `Zl`, `Zp` or `Default_Ignorable_Code_Point` (the soft hyphen, the Hangul fillers, the Arabic letter mark, the combining grapheme joiner, the Khmer inherent vowels, every variation selector including the Mongolian ones, the tag block, and code points reserved for characters of this kind). Explicit ranges (the union of what `neutralizeControls` and the replay page's `showInvisible` write out) stay beside the classes as a floor. A sweep asks the engine about every code point and checks that the refused set is exactly the classes; a parity test asks both display helpers about every code point |
| Windows-forbidden | `<` `>` `"` `\|` `?` `*` in any component. A path is promised to be a name on any filesystem. The full-width forms (`？`, `：`) that CJK names use in their place are other characters and are accepted |
| not valid text | a lone surrogate, or U+FFFD (a decoder's mark for bytes that were not UTF-8: two different names would become one) |
| `.git` | a component equal to `.git`, or its NTFS short name `git~N`, after the folding below: any case, and any compatibility spelling (full-width, the dotless `ı`). Only that: `.gitignore`, `.github/workflows/x.yml` are fine. **Of the 8.3 aliases only `git~N` is covered**: the short names of `.gitmodules` or `.gitattributes` (`GITMOD~1`, `GITATT~1`) are not looked for, since those are ordinary files in a tree |
| trailing dot or space | Windows drops them, so `a.` and `a` would be one file. It is judged on the narrowed name (below), so a name that only ends in a dot or a space once it is made plain is refused too: a full-width full stop, a one dot leader, an ellipsis, a no-break or an ideographic space (a few dozen code points). `.git` followed by U+FF0E is `.git.` to a program that narrows names, and Windows drops the dot and opens `.git`. A name of two full-width full stops narrows to `..` and is refused here |
| device names | CON PRN AUX NUL COM0-9 LPT0-9 CONIN$ CONOUT$, after the folding below, with or without an extension (`NUL.txt`; the extension starts at the first dot of the folded name, so a full-width dot is one). `COM10` and `console.txt` are fine |
| size | more than 240 UTF-8 bytes, or more than 20 components. The length is judged first, so a hostile path is never read beyond its first 240 characters |

**Folding.** There are two questions that a disk answers by folding a name: is it a name that opens something dangerous (`.git`, its short name, a device, or a name that ends in a dot or a space), and is it the same name as another one in the tree. If the two were answered with different foldings, a spelling would slip past one rule and be taken for the same name by the other (the dotless `ı` is `i` to a filesystem that folds case through upper case and back, and a full-width dot ends the name of a device once it is made plain). So they fold alike. The collision rule folds one name at a time: NFC, then upper case, then lower case, then NFC, **repeated until a round changes nothing** (three rounds at most; no code point needs more than two). One round is not a key for the capital sharp s (U+1E9E gives `ß` in the first round and `ss` only in the second), so with one round it was kept apart from both `ß` and `ss`, which a disk that folds case joins it with; a sweep asks the engine about every code point and checks that folding a key again changes nothing, and that the key of a letter is the key of its lower and of its upper case. Composed and decomposed letters are one; `ß` and `ẞ` join `ss`, the two sigmas join, `ı` joins `i`. The rules for the special names fold the same way after one more step in front, NFKC, which makes full-width and superscript forms plain, as a program that narrows a name to a smaller character set does. The collision rule itself stops at NFC: no filesystem treats a full-width `z` and `z` as one name, and CJK names use the full-width forms on purpose. For the same reason the separators and the characters that make a path absolute or name a stream (`/`, `\`, `:`) are judged as they are spelled, and a full-width solidus or colon is a name on every disk. Dots are different: Windows drops a trailing dot, and a program that narrows a name makes the full-width one a dot, so the end of a name is judged on the narrowed name. A name longer than a path may be is not folded at all, because normalisation is quadratic on a long run of combining marks of mixed classes (65,536 of them take three seconds); such a name is refused by `checkEntryPath` before it could be an entry.

`findCollisions(paths)` returns the pairs that cannot both be written to such a filesystem (NTFS, the default APFS, HFS+): equal after that folding (`a/README` and `a/readme`; a composed and a decomposed `é`). Each later path is paired with the first of its group, so the answer is never longer than the input. It compares whole paths. `findFolderConflicts(paths)` returns the pairs `[file, below]` where a folder of `below` is one name with `file` (`Docs` and `docs/x`; the same spelling included), in time linear in the length of the paths. `findFolderSpellings(paths)` returns the pairs `[first, later]` of paths that go through one folder and spell its name differently (`Docs/a.md` and `docs/b.md`; a composed and a decomposed folder name), at most one pair for a path, in the same time. `buildTree` and `treeDigest` use all three (section 3). `stripTopComponent(paths)` removes exactly one leading component when every path shares it (tarballs have a top folder), and leaves the paths alone otherwise, or when the shared part is empty or a dot.

**Decisions beyond the obvious rules.** The obvious rules are traversal, absolute paths, backslash, drive letter, NUL and other controls, `.git`, the alternate data stream colon, trailing dot or space, and the reserved Windows names. The code also decides, and this spec records, that: the C1 block is a control (0x9b is a terminal's CSI); a lone surrogate is refused (it has no UTF-8, so two names would hash alike); U+FFFD is refused; `COM0` and `LPT0` are devices, and so are `CONIN$` and `CONOUT$`, because refusing a file of that name costs nothing; `.git`, its short name, the device names and the end of a name are judged after NFKC and case folding; the invisible characters are a Unicode property and not a list, and follow the Unicode tables of the Node that runs the check (Node 22 and 24 agree on all of them today; a newer Node may refuse more); the six Windows-forbidden characters are refused; collisions are refused at the tree, and so are two folders that are one folder but spelled two ways. A path is never rewritten: it passes as it was spelled or it is refused.

## 5. The passport

A passport is a record of what was found, never a promise of what is not there. Each line is `{kind, subject, basis, sensitive, where[], detector}`:

- `kind`: `fs.read`, `fs.write`, `net`, `cred.env`, `cred.file`, `exec`, `hook`, `install-script`, `tool`, `allowed-tools` or `signal`.
- `basis`: `declared` (the artifact says so), `observed` (a reading of its files found it), `limited` (Stroq itself holds it to that when it runs it) or `unknown` (something here could not be understood).
- Around the lines: `blindSpots` (what was not looked at), `signals` (`{ruleId, file}`), `imported` (findings of other tools) and `analysis {stroq, rules}`. `PassportSchema` is strict: an unknown key or basis is an error, so a lock file can be validated with it. It holds no time and no path of this machine; its canonical form is `stableStringify`. **The same artifact, read by the same version of Stroq with the same rules, gives the same passport on any machine** (a directory read on Windows excepted, whose digest has no executable bit: section 3): `analysis.stroq` and `analysis.rules` are part of the passport, because another version may read the same files differently, and then the passport differs. So `stroq vet --json` is deterministic for a given Stroq, and an author who commits one to a README commits it with the version that made it; a passport from another version is not a mismatch of the artifact.
- `artifact.source` is a `SourceRef`. It tells one source from another and shows a person where an artifact came from, and **it is never used to fetch**: a passport can come from outside (a README, a lock file that somebody else wrote), so what it names must not pick what is downloaded, and the only input to a fetch is the full source spec that the lock keeps (section 8). The kinds say different amounts. A `url` keeps only its host (a lower-case ASCII host name: no scheme, user information, port, path, query or fragment, and never an IPv4 address in a form that a URL parser reads, decimal or `0x` hexadecimal); a `dir` or `tarball` keeps a label (at most 80 characters, relative, with no `..` component, and not `/`, `\`, `~` or a drive letter at the start, so that a passport reads the same on every machine). These three cannot be turned back into an address. An `npm` or `github` reference is exact: `npm` keeps name, version and, when there is one, a sha-512 integrity; `github` keeps owner, repo, ref, and the commit (40 lower-case hexadecimal digits) and the subdirectory (a relative name) when there are some. That would be enough to fetch again, which is why the rule is that nothing fetches from a passport. No text in any of them holds a control or an invisible character (the same Unicode properties as in section 4), so that a passport can be printed and committed as it is.

**Honesty rules.** The absence of a line means nothing, and `blindSpots` are always printed. A negative claim ("no credentials granted") may only rest on basis `limited` (for example `--pass-env`, which the wrapper enforces); otherwise the words are "none seen (static)". A skill gets no promise about run time, because hooks do not know which skill is active. Rule hits are `signals`, not gates: about 15% of harmless documents are flagged.

**What reads what.** Front matter (the `yaml` package, the first block of at most 16 KiB): `allowed-tools`, `hooks`. Fenced shell blocks, inline `` !`cmd` `` and `scripts/*.sh|ps1|bat`, through `classifyCommand`: `shell.network` hosts become `net`, `fs.secrets` becomes `cred.file`, `shell.exec_encoded` is a signal, `shell.unparsed` is `unknown`. `package.json`: `bin` and `main`; the lifecycle scripts `preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`, `postprepare`; `binding.gyp`; a dependency that is not from a registry is sensitive. Heuristics for JS and Python: `process.env.X` and `os.environ` give `cred.env`, a URL literal gives `net`, a URL built at run time gives `unknown`, subprocess and `eval` give `exec` and a signal, native and minified files give a signal and a blind spot. Checks on the in-memory tree: devcontainer, husky, `.envrc`, `.gitmodules`, `.gitattributes`, and `.vscode` autorun through `editorAutorunText` (not `repoSurface`, which leaves out `.git`). `tool` lines exist only after a probe (section 13).

**Other tools' findings.** `--import <file>` takes `stroq-findings/1` or SARIF 2.1.0 and shows each as "reported by X, not verified": at most 200 findings of 300 characters, and they never change the digest. The real Cisco and Snyk formats have not been checked offline; samples are needed.

## 6. Fetch

The only network code is `install/fetch.ts`; a guard test forbids `fetch(`, `http.request` and `https.` in the rest of `cli/src`. https only, through an injectable `Transport`. `--online` is required (or a y/N on a TTY for `add`), and the hosts are printed first (`registry.npmjs.org`, `codeload.github.com`, the host of a URL). At most 3 redirects, only to https hosts on the source's allowlist; IP literals and `localhost` are refused; `Accept-Encoding: identity`; no tokens and no `.npmrc`. The limits of section 3 apply, and a byte counter cuts the stream. **npm:** the registry JSON gives `dist.tarball` (same origin), and the sha-512 of `dist.integrity` is checked before the tarball is parsed; a package without a sha-512 is refused. **GitHub:** codeload; the commit id in the pax header is the server's claim (to be checked against a fixture), so otherwise a 40-hex ref is needed.

## 7. The tar reader

Our own, about 200 lines, with no dependency. It accepts files, directories, pax `x` and `g` and GNU `L`. It refuses links, devices, FIFOs, sparse entries, duplicates, a bad checksum, a tail with data in it and invalid UTF-8. Collisions of case or Unicode form need no rule of its own: the tree it builds refuses them (section 3), so a tarball that holds `README` and `readme` fails when it is vetted. It strips exactly one shared top component, applies `checkEntryPath` to every entry, and unzips with `gunzipSync` and `maxOutputLength`. It is fuzzed with `fast-check`.

## 8. Store and lock

`~/.stroq/store/sha256-<first 32 hex>/{manifest.json,tree/…}`: written by temp file and rename, modes 0600 and 0700, no executable bits (the flag is kept in the manifest). It lives inside `~/.stroq`, which `SELF_CONFIG_FILE` already covers, and is denied to writes in the sandbox. The lock is `~/.stroq/passports.json` (zod, `withLock`, temp and rename, 0600). Per name: kind; status (`confirmed`, `drifted` or `revoked`); the full source spec (the whole URL, the resolved commit, the integrity of the tarball: the only input to a fetch, which is never taken from a passport) and the resolved id; digest; the confirmed passport; the grant (`passEnv`, pin); `installedTo`; the previous config entry, for undo; and `history[]` receipts `{v, at, action, name, from, to, material, confirmed, stroq}` with a line in the audit log. There is no project-level lock yet: an agent writes project files, so it would only advise. An author uses `vet --json`; a consumer uses `vet --expect <digest>`.

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
- A digest of a directory is not the digest of the archive an author published (line endings, filters and keyword expansion change bytes), and on Windows it is platform-dependent (no executable bit), as it is for a directory read from a volume that stores names decomposed (HFS+): see the hazards in section 3.
- The promise that a tree can be written to a disk and read back as the same paths covers the folding rules the module knows. The 8.3 short names of NTFS other than `git~N`, and a disk with another case table than the Node that runs the check, are not modelled (section 3).
- A passport is the same for the same artifact only when it is read by the same Stroq with the same rules; another version may read the same files differently (section 5).
- The commit id GitHub sends is a claim of the server. The Cisco and Snyk report formats are unchecked until there are samples. Real registry and GitHub answers are covered by fixtures until the first `--online` run on public repositories.

## 15. Who builds what

| Task | Part | Files |
| --- | --- | --- |
| S0 | this contract: types, tree, safe path, digest, spec | `install/{types,tree,safe-path,path-collision}.ts` |
| S1 | directory reader, store | `install/{read-dir,store}.ts` |
| S2 | fetch, npm, GitHub, tar reader | `install/{fetch,source,fetch-npm,fetch-github,archive-tar}.ts` |
| S3 | inspectors, passport, imports | `install/{inspect-*,passport,import-findings}.ts` |
| S4 | rendering and typed confirmation | `install/render*`, `ui/prompt.ts` |
| S5, S6, S8 | `vet`; `add` and `remove` for skills; for MCP | `commands/vet.ts`, `install/{lock,skill-install,receipt,mcp-install}.ts` |
| S7 | runtime pin | `mcp/{proxy,pin}.ts`, `commands/mcp.ts`, `mcp-config.ts` |
| S11 | sandboxed probe and first run | `exposure/probe.ts`, `run/sandbox.ts` |
