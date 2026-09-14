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
documentation from Apache-2.0 projects, deliberately weighted toward the
text that actually causes false positives rather than away from it:
credentials, tokens, API keys, environment variables, shell/CLI invocation,
CI configuration, and — for the newer agent-tooling sources — LLM agent
instructions. The two largest files in the corpus,
`apache-apisix/admin-api.md` (107 KB, an admin-API reference full of `curl`
examples with `X-API-KEY` headers) and `prometheus-prometheus/configuration.md`
(206 KB, a scrape-config reference saturated with `basic_auth`,
`bearer_token`, `authorization` and TLS credential fields), are together
about 48% of the corpus by bytes. They were chosen _because_ they are the
documents most likely to trip a rule that matches on credential- or
token-shaped text, not because they were expected to pass cleanly — a
corpus picked to flatter the false-positive number would have excluded
them, not led with them. See `sources.json` for the authoritative
per-source table (repo, ref, resolved commit, license, sha256); the
rationale for each of the 25 entries is in the table below.

| Repo                                   | Path                                | Why chosen                                                                                                                                                                     |
| -------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| apache/airflow                         | README.md                           | General orchestration-platform dev doc — plugins, connections, env-var-driven config.                                                                                          |
| apache/superset                        | CONTRIBUTING.md                     | Dev setup instructions — shell commands, CI, local secrets for dev.                                                                                                            |
| apache/spark                           | README.md                           | Build/run instructions, shell invocation.                                                                                                                                      |
| kubernetes/kubectl                     | README.md                           | Thin CLI wrapper repo, low keyword density but a real, widely-used dev artifact — kept for source diversity.                                                                   |
| grpc/grpc                              | SECURITY.md                         | Vulnerability-reporting doc, short but a genuine security-process document.                                                                                                    |
| apache/superset                        | SECURITY.md                         | Discusses `SECRET_KEY`, CSRF tokens, session cookies, credential rotation.                                                                                                     |
| apache/nifi                            | README.md                           | Discusses NiFi Registry, sensitive property encryption, and flow credentials.                                                                                                  |
| apache/rocketmq                        | README.md                           | Message-broker README covering ACL access-key/secret-key pairs.                                                                                                                |
| apache/apisix                          | README.md                           | API gateway README; discusses admin API keys and auth plugins.                                                                                                                 |
| apache/apisix                          | docs/en/latest/admin-api.md         | Full admin-API reference: `curl` examples with `X-API-KEY` headers throughout — the highest credential/token density found, and one of the two largest files (see above).      |
| apache/kafka                           | README.md                           | Build/test shell commands, CI notes.                                                                                                                                           |
| grpc/grpc                              | CONTRIBUTING.md                     | Second file from the same repo: dev workflow, shell commands, CI checks.                                                                                                       |
| prometheus/prometheus                  | docs/configuration/configuration.md | Full scrape-config reference: `basic_auth`, `bearer_token`, `authorization`, `tls_config`, environment-variable substitution — the other of the two largest files (see above). |
| huggingface/huggingface_hub            | README.md                           | Login/token workflow overview.                                                                                                                                                 |
| huggingface/huggingface_hub            | docs/source/en/quick-start.md       | `HF_TOKEN` environment variable, `huggingface-cli login`, access-token instructions.                                                                                           |
| huggingface/transformers               | README.md                           | Major ML library README — install/shell instructions; kept for project-scale diversity.                                                                                        |
| google/adk-python                      | README.md                           | Google's Agent Development Kit: agent definitions, tool wiring, model/API-key configuration — direct match for the agent-instructions bias.                                    |
| google-gemini/gemini-cli               | README.md                           | An LLM agent CLI: `GEMINI_API_KEY` env var, shell/tool execution, agent behavior docs.                                                                                         |
| google-github-actions/auth             | README.md                           | GCP-auth GitHub Action: Workload Identity Federation, service-account keys, `GITHUB_TOKEN`, CI secrets.                                                                        |
| pulumi/pulumi                          | README.md                           | IaC tool; `pulumi config set --secret`, provider credentials.                                                                                                                  |
| open-telemetry/opentelemetry-collector | CONTRIBUTING.md                     | Dev workflow with shell commands and CI steps.                                                                                                                                 |
| argoproj/argo-cd                       | docs/operator-manual/security.md    | GitOps CD tool's security manual: repo credentials, SSO tokens, webhook secrets.                                                                                               |
| ray-project/ray                        | doc/source/ray-core/configure.rst   | Runtime configuration reference: environment variables throughout.                                                                                                             |
| envoyproxy/envoy                       | SECURITY.md                         | Proxy's vulnerability-disclosure process; credential/cert handling in reported issues — kept for infra-project diversity.                                                      |
| apache/druid                           | README.md                           | Big-data engine README; build/config instructions — kept for project diversity.                                                                                                |

### What was rejected, and why

- **aws-actions/configure-aws-credentials** — rejected on license, not
  content. Its `LICENSE` file was read directly rather than assumed from the
  usual AWS-repo convention of Apache-2.0: it is a permissive MIT-style
  license ("Permission is hereby granted, free of charge…"), not
  Apache-2.0. Dropped even though its content (OIDC tokens, AWS credentials
  in CI) would otherwise have fit the corpus well.
- **helm/helm** — its `SECURITY.md` is a 171-byte stub that just points
  elsewhere, and the alternate path tried
  (`docs/charts_tips_and_tricks.md`) 404'd. Dropped the whole repo rather
  than vendor a near-empty file.
- **fluxcd/flux2** — every candidate doc path tried (`SECURITY.md`,
  `docs/security/index.md`, `.github/SECURITY.md`) 404'd at `main`. Dropped;
  did not guess further at a moved path.
- **open-policy-agent/opa** — `SECURITY.md` exists but is a 227-byte stub;
  `docs/content/configuration.md` and `docs/content/security.md`, which
  would have covered its JWT/token handling, both 404'd. Dropped.
- **moby/moby** — `CONTRIBUTING.md` was low-signal; the promising
  `docs/reference/commandline/login.md` (Docker credential stores) 404'd at
  `master`. Dropped.
- **trinodb/trino** — `README.md` was low-signal;
  `docs/src/main/sphinx/security/overview.rst` 404'd. Dropped.
- **apache/dolphinscheduler** — `README.md` had no relevant content;
  `docs/docs/en/guide/security.md` and `.../open-api.md` (which would have
  covered its admin API tokens) both 404'd, likely reorganized. Dropped.
- **etcd-io/etcd** — `README.md` and `security/README.md` cover the same
  territory (auth, TLS, bearer tokens) that
  `prometheus/prometheus/docs/configuration/configuration.md` covers far
  more densely. Left out rather than pad the manifest with a weaker
  duplicate of ground already covered.
- **argoproj/argo-cd**'s `SECURITY.md` and **ray-project/ray**'s
  `README.rst` — both near-empty of relevant content; the repos are still
  represented in the corpus, but by their more relevant documents
  (`docs/operator-manual/security.md` and
  `doc/source/ray-core/configure.rst` respectively).
- **pulumi/pulumi**'s `CONTRIBUTING.md` and **apache/nifi**'s `SECURITY.md`
  — both considered as a second file from an already-included repo, both
  dropped to avoid overweighting one repo relative to the 21 distinct
  repositories already represented; each repo's more relevant file was kept
  instead.

### Selection method, stated exactly

No candidate was ever run through Stroq's own scanner (`scanContent`) or any
ATR rule before being included or excluded. Every candidate was filtered
only by two mechanical checks that do not depend on Stroq's rule set at
all — the repository's actual `LICENSE` file names Apache-2.0, and the raw
file URL returns HTTP 200 at the named ref — plus, for close calls between
several documents in the same repository, a plain case-insensitive keyword
count (`token|secret|credential|password|api[_ -]?key|env(?:ironment)?
?var|shell|curl |bash |ci\/cd|github actions|prompt|agent|instruction|\.env`)
used only to prefer the more topically relevant document, never to predict
or check how Stroq's rules would score it. The false-positive rate this
corpus produces was not known, checked, or influenced at selection time.

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
