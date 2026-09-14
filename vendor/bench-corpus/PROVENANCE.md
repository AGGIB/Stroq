# Bench corpus — vendored provenance

This directory holds the benign corpus that the false-positive bench (Task 2)
measures the shipped rule set against. Every file under `files/` is
**unmodified** third-party developer documentation, fetched at the exact
commit recorded for it in `sources.json`, the only file a human edits.

## Why this exists

Nobody in this field publishes a false-positive rate on benign developer
traffic. Publishing one is only worth something if a reader can reproduce it:
`sources.json` names each file's repository, ref, resolved commit and
sha256, so anyone can re-fetch the exact bytes the rate was measured on, and
CI (`pnpm check:bench-corpus`) proves the committed copies were not edited
afterwards to flatter the number.

## Why it is disjoint from `rules/fixtures/benign`

`rules/fixtures/benign` (10 files) is not a benchmark — it is a build-time
gate. `scripts/build-rules.ts` runs every ATR rule against those files and
**disables** any rule that fires on one; that mechanism is where the disabled
rules in the shipped bundle come from. Measuring the shipped rule set against
that same corpus would therefore report a false-positive rate of
approximately zero _by construction_, regardless of how the rules actually
behave on real text. `packages/cli/test/bench/corpus.test.ts` enforces the
disjointness by hashing both directories and asserting no overlap, rather
than by trusting that nobody copies a file across by convention.

## Selection

All 25 sources are real README/CONTRIBUTING/SECURITY/configuration
documentation from Apache-2.0 projects, biased toward the content most
likely to trip a content scanner: credentials, tokens, API keys, environment
variables, shell/CLI invocation, CI configuration, and — for the newer
agent-tooling sources — LLM agent instructions. See `sources.json` for the
authoritative per-source table (repo, ref, resolved commit, license,
sha256); the CLI's own report at
`.superpowers/sdd/2026-09-14-bench-and-coverage/task-1-report.md` records the
rationale for each choice and what was rejected.

## License

Every source is licensed Apache-2.0 by its upstream repository (confirmed by
reading each repository's own `LICENSE` file, not a badge). Copyright stays
with the original authors; nothing here modifies the vendored bytes. This
directory is excluded from `pnpm format` / `prettier --check` via
`.prettierignore`, matching `vendor/atlas/ATLAS-2026.08.yaml`'s precedent —
these are third-party bytes whose hashes are committed, and a formatter must
never rewrite them.

## Re-fetching and verifying

```bash
pnpm fetch:bench-corpus   # re-fetches every source, rewrites sources.json with fresh commit/sha256
pnpm check:bench-corpus   # re-hashes the committed files against sources.json; network-free; writes nothing
```

`pnpm check:bench-corpus` is what CI runs (`.github/workflows/ci.yml`, the
"Bench corpus verified" step). It fails if any committed file's hash no
longer matches what `sources.json` records.

To add a new source: confirm the repository's `LICENSE` file is really
Apache-2.0, confirm the raw URL for the file resolves at the ref you intend
to pin, add an entry to `sources.json` with empty `commit`/`sha256`, run
`pnpm fetch:bench-corpus`, and commit the updated manifest together with the
new file under `files/`.
