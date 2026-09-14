<!--
  GENERATED FILE. Do not hand-edit.
  Produced by `pnpm generate:reports` from `stroq bench --corpus vendor/bench-corpus/files`'s own output.
  Refresh it with `pnpm generate:reports`; `pnpm check:reports` fails CI if
  this file and the command's live output disagree.
-->

# Stroq bench

Stroq's false-positive rate against real, benign developer documentation. This number is ours — measured by a method we publish, on a corpus we vendor. It is not a third-party audit.

```text
stroq bench: 25 files, 655 KB, 599 rules
flagged:   10 / 25   (40.0%)

  STROQ-2026-00005   Remote script piped into a shell                 3 files
  ATR-2026-00142     Data Piggybacking via Casual Transition Words    3 files
  ATR-2026-00113     Credential File Theft from Agent Environment     2 files
  STROQ-2026-00002   Hidden directive addressed to the AI assistant   1 file
  ATR-2026-00117     Agent Identity Spoofing and Authority Impersonat 1 file
  ATR-2026-00030     Cross-Agent Attack Detection                     1 file
  STROQ-2026-00004   Instruction to read and send credentials         1 file
  ATR-2026-00150     Credential Data Leaked in Tool Response          1 file

Flagged files:
  vendor/bench-corpus/files/apache-airflow/README.md
  vendor/bench-corpus/files/apache-apisix/README.md
  vendor/bench-corpus/files/apache-apisix/admin-api.md
  vendor/bench-corpus/files/apache-nifi/README.md
  vendor/bench-corpus/files/apache-superset/SECURITY.md
  vendor/bench-corpus/files/google-github-actions-auth/README.md
  vendor/bench-corpus/files/huggingface-huggingface_hub/README.md
  vendor/bench-corpus/files/prometheus-prometheus/configuration.md
  vendor/bench-corpus/files/pulumi-pulumi/README.md
  vendor/bench-corpus/files/ray-project-ray/configure.rst

corpus: vendor/bench-corpus/files
```

Every file the list above names is unmodified, ordinary documentation belonging to its own project. Appearing in it means a Stroq rule fired in error on that file — it is not a statement that the file, or the project it comes from, did anything wrong.

## Method

The corpus is vendored, unmodified, third-party developer documentation — README, CONTRIBUTING, SECURITY and configuration files pulled from real Apache-2.0-licensed projects — fetched at an exact resolved commit and pinned by sha256 for every file in [`vendor/bench-corpus/sources.json`](../vendor/bench-corpus/sources.json); `pnpm check:bench-corpus` fails CI if a committed file no longer matches the hash the manifest recorded for it. See [`vendor/bench-corpus/PROVENANCE.md`](../vendor/bench-corpus/PROVENANCE.md) for why each source was chosen.

This corpus is deliberately disjoint from `rules/fixtures/benign`, a separate, much smaller corpus that `stroq bench` never reads: `scripts/build-rules.ts` runs every ATR rule against those fixtures at build time and disables any rule that fires on one, which is where the disabled rules in the shipped bundle come from. Measuring the false-positive rate against that same corpus would report a number close to zero by construction — the rules were tuned on it — regardless of how they behave on text they were never checked against, so the number above would be measuring the build gate rather than the rules. `packages/cli/test/bench/corpus.test.ts` enforces the two corpora share no file by hashing both directories, rather than relying on nobody copying a file across.

`stroq bench --corpus <dir>` reproduces this measurement on your own files. The vendored corpus this document measures ships with the repository, not with the published npm package — `stroq bench` with no `--corpus` looks for it next to the installed CLI and, not finding it there, tells you to pass `--corpus` yourself, which is always the case for an installed CLI.
