# Contributing to Stroq

Thanks for considering a contribution. Stroq is a security tool: a missed detection or a bypass is a bug, and a false positive on legitimate content or commands is also a bug. Both are treated with the same seriousness as a crash.

## Development Setup

```bash
git clone https://github.com/AGGIB/stroq.git
cd stroq
pnpm install
pnpm test
pnpm build
```

Requires Node >= 22 and pnpm (the pinned version is in the root `package.json`'s `packageManager` field; run `corepack enable` to pick it up automatically).

Useful scripts:

```bash
pnpm test:coverage   # vitest with the 80% coverage gate
pnpm typecheck
pnpm format:check    # prettier --check
pnpm build:rules     # rebuild packages/core/src/rules.bundle.json from rules/ (run this locally)
pnpm check:rules     # verify the committed bundle deterministically, the same way CI does
./examples/demo/run-demo.sh
```

## Test-Driven Development

Write the failing test first, then the minimal implementation that makes it pass, then refactor. Every new behavior needs a test; every bug fix needs a regression test that fails before the fix and passes after. We aim for 80%+ coverage (enforced by `pnpm test:coverage`); a pull request that drops coverage below the threshold will fail CI.

## Coding Conventions

- Files stay focused: roughly 400 lines is the point to consider splitting a module.
- Functions stay small: roughly 50 lines is the point to extract a helper.
- No mutation: return new objects/arrays instead of mutating arguments or shared state.
- Regexes that need a specific code point use `\u` (or `\u{...}` with the `u`/`v` flag) escapes, not a literal invisible, zero-width, or non-Latin character pasted into source — this keeps diffs reviewable and prevents an accidental copy-paste of the very payloads we're trying to detect.
- Prefer early returns over deep nesting; validate inputs at the boundary (hook stdin, CLI args, policy/rule files) with explicit error handling rather than letting bad input propagate.

## Adding a Stroq Rule

Rules live in `rules/stroq/` in [ATR](https://github.com/Agent-Threat-Rule/agent-threat-rules) format. A new rule must:

1. Have a unique `id` following the existing `STROQ-<year>-<sequence>-<slug>` pattern.
2. Include `test_cases` with at least one true positive and, where the pattern could plausibly match legitimate text, at least one true negative.
3. Pass the benign-corpus gate: run `pnpm build:rules` and confirm your rule does not fire on anything in `rules/fixtures/benign/`. Unlike vendored ATR rules (which are auto-disabled on a benign-corpus hit), a Stroq-authored rule that fires on the benign corpus **fails the build** — fix the pattern instead of disabling it.
4. Pass the regex performance gate: `pnpm build:rules` also times every rule against adversarial blobs (repeated base64 alphabet, repeated characters, repeated URLs) at increasing sizes and disables anything over 25 ms. A Stroq rule that fails this gate fails the build the same way.

Run `pnpm build:rules` after any change under `rules/` and commit the regenerated `packages/core/src/rules.bundle.json` and `rules/atr-disabled.json` alongside your rule change. The committed `rules/atr-disabled.json` is the authoritative record of which vendored rules are disabled and why; `pnpm build:rules` (run on a maintainer's machine) is what regenerates it, including the performance gate's timing measurements. CI does not re-run those measurements — machine speed shouldn't decide which rules ship — instead it runs `pnpm build:rules --check` (the same thing `pnpm check:rules` runs locally), which deterministically re-verifies rule compilation and the benign-corpus scan against the committed disabled list and byte-compares the assembled bundle, and `--advisory-perf` on top of that, which times every rule and warns about anything over threshold that isn't already disabled without failing the build. Run `pnpm check:rules` before opening a pull request to confirm your commit would pass CI.

## Adding a Benign Fixture

If Stroq flags something it shouldn't, that is a false positive and a bug. To fix it:

1. Add a realistic fixture reproducing the benign content to `rules/fixtures/benign/` (a real-looking README, CI log, runbook, chat transcript, etc. — not a synthetic one-liner).
2. Run `pnpm build:rules`. Any rule that now fires on your fixture will either be disabled automatically (vendored ATR rules) or fail the build (Stroq rules, which must be tightened instead).
3. If a Stroq rule needs tightening, add a regression test alongside the existing ones in `packages/core/test/rules/` or `packages/core/test/scan/corpus.test.ts` so the fixture stays covered going forward.

## Adding a Bypass Regression Test

If you find a way past the action classifier or the policy engine (a command that should be classified into `shell.network`, `shell.destructive`, `config.self`, etc. but isn't, or the reverse), add a regression test under `packages/core/test/actions/` (see `classify-bash.test.ts`, `classify-bash-network.test.ts`, `classify-bash-self-tamper.test.ts`, and `self-config.test.ts` for the existing structure and naming) before fixing the classifier. For anything you believe is an active, exploitable security bypass rather than a coverage gap, please report it privately first — see [SECURITY.md](SECURITY.md) — and open the pull request with the regression test once a fix is ready.

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/): `type: short description`, for example `fix: classify sudo -u as a wrapped command` or `feat: add ask-network-fetch policy rule`. Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

## Pull Requests

Before opening a pull request:

- [ ] Tests added or updated for the change (including a regression test for any bug fix)
- [ ] `pnpm build:rules` run and its output committed, if anything under `rules/` changed (`pnpm check:rules` confirms it matches what CI expects)
- [ ] `pnpm test:coverage`, `pnpm typecheck`, and `pnpm format:check` all pass locally
- [ ] Docs updated (README, `packages/cli/README.md`, or this file) if behavior, commands, or policy defaults changed

See `.github/PULL_REQUEST_TEMPLATE.md` for the checklist used on the pull request itself.

## Release Process

Releases are cut from `main` once CI is green:

1. Update `CHANGELOG.md` with the new version's changes (Keep a Changelog format).
2. Bump `version` in `packages/cli/package.json` (and `packages/core/package.json`, which stays private).
3. Commit, then tag and push the tag:

   ```bash
   git tag v0.1.0
   git push --tags
   ```

4. Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds and runs `npm publish --provenance --access public` for the `packages/cli` package.
5. This requires an `NPM_TOKEN` repository secret with publish rights for the `stroq` package (or npm trusted publishing configured for this repository as an alternative to a long-lived token).
