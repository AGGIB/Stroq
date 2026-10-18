# GitHub-hosted repository maintenance

Repository maintenance runs on GitHub-hosted Ubuntu runners, independently of a
developer's Mac. It uses short-lived GitHub tokens and the existing native Codex
subscription for code review; it needs no separate OpenAI API key.

## What the workflow does

`Repository maintainer` runs every 15 minutes, after CI or CodeQL completes, and
on issue activity. Both jobs check out trusted `main`, never a PR branch.

- The scan job restores missing category labels only when an issue matches an
  existing issue form and label. It maintains one deduplicated readiness comment
  per PR. It does not guess diagnoses, promise fixes, close old issues or publish
  exploit details.
- The merge job independently fetches current state and squash-merges at most one
  ready PR per run. It does not rely on the scan's comment as authorization.
- Native Codex reviews inform the human reviewer. A missing comment, an emoji or
  a bot's COMMENT review never substitutes for a human approval.

Normal GitHub `Closes #n` links continue closing issues on merge. Merging does
not publish a release, create a tag, or approve npm publication.

## Requirements for automatic merge

The current PR commit must have an explicit APPROVED review from a different
human collaborator with write, maintain or admin permission. Drafts, hold/WIP
labels, effective change requests and unresolved review threads block merging.

CI and CodeQL must finish successfully for the current head and current base.
The controller verifies the GitHub Actions app, workflow path, run, matrix and
test-merge parents; a matching check name alone is insufficient. It rereads every
gate immediately before a merge and sends the expected head SHA to GitHub.

The active server-side rules for `main` must require:

- Up-to-date required GitHub Actions checks.
- At least one independent approval, with stale approvals dismissed on push.
- Resolved review conversations.

The versioned policy is `.github/maintainer-ruleset.json`. It has no bypass actors.
The controller reads effective active branch rules using metadata access, so it
does not require the Administration permission unavailable to `GITHUB_TOKEN`.
Classic protection may impose additional requirements; GitHub still enforces
them. Missing permissions, unsupported rules or uncertain results stop merging.

Changes to workflows, agent policy and release versions stay on a manual merge
path even after approval. The controller never changes repository protection,
force-pushes, deletes branches or modifies its own policy.

## Permissions and checks after merge

The scan job has issue/PR write permission and read access to contents, Actions,
checks and commit statuses. The merge job additionally needs contents and Actions
write permission. Neither job has model credentials or a persistent token.

A merge made with `GITHUB_TOKEN` suppresses the usual subsequent push workflows.
The writer verifies dispatch support before merging, then explicitly dispatches
CI, CodeQL and Scorecard on `main`. A dispatch failure fails the maintenance run
and needs maintainer attention; it is never reported as a fully checked merge.

## Native cloud Codex review

In <https://chatgpt.com/settings/code-review>, select `AGGIB/Stroq` and enable
automatic review for all PRs. The configured review trigger determines re-review
on subsequent pushes. Reviews use the connected subscription and its applicable
limits, separately from the workflow's human approval condition.

See the [official Codex GitHub integration documentation](https://learn.chatgpt.com/docs/third-party/github).

## Manual verification

In Actions → Repository maintainer → Run workflow, set `dry_run` to true for a
read-only reconciliation. This forces the API client to reject mutations and
skips the merge job. Normal runs use `dry_run: false`.

Offline policy and API-client tests need no credentials:

```sh
node --test .github/scripts/maintainer.test.mjs
```

Keep any previous local maintainer paused to avoid duplicate writers. Enable the
GitHub workflow only with the approved permissions and active protection policy.
