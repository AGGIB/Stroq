# GitHub-hosted repository maintenance

The proposed maintenance setup runs on GitHub-hosted Ubuntu runners. It does not
use a developer's Mac, a self-hosted runner, or an OpenAI API key. Codex reviews
use the connected account's existing subscription and its applicable limits;
GitHub Actions usage remains subject to GitHub's runner limits and billing.

## What is included

- Root `AGENTS.md` gives cloud Codex repository-specific review rules.
- `Repository maintainer preview` reads current PRs, checks, reviews and issue
  metadata, and reports proposed decisions in the Actions log. Its token has only
  read permissions and its API client rejects mutation requests.
- The controller source and its tests make the proposed future writer behavior
  reviewable. **This PR does not enable issue changes or automatic merging.**

## Enable native cloud Codex review

1. Open <https://chatgpt.com/settings/code-review> and sign in to the existing
   Codex account.
2. Connect `AGGIB/Stroq` if it is not already connected. Check the requested
   repository access before approving the connection.
3. Select the repository, enable automatic code review for its PRs, and select
   the available trigger for new pushes. This is a cloud setting, independent of
   the desktop app.
4. Open a representative PR and confirm that Codex actually completes a review.

See the [official Codex GitHub integration documentation](https://learn.chatgpt.com/docs/third-party/github).
The native integration does not document a stable machine-readable successful
review API. A live review in this repository emitted a versioned
`codex-review-state:v1` summary containing the reviewed commit SHA, but its completed
state and provenance must be verified before it can authorize autonomous merges.
A missing comment, an emoji reaction, or a successful CI job is not a Codex
approval. This proposal therefore requires an explicit approval from a trusted
human reviewer on the current PR commit. Fully autonomous semantic issue triage
and an AI merge verdict are not enabled by this preview.

## Review the preview

After this PR is merged, open Actions → Repository maintainer preview → Run
workflow, or wait for a scheduled run. It also runs after CI or CodeQL finishes.
The preview reports readiness and missing requirements without posting comments,
changing labels, closing issues, dispatching other workflows, or merging.

For local policy tests, no credentials are needed:

```sh
node --test .github/scripts/maintainer.test.mjs
```

## Proposed activation, requiring separate approval

Activation is a separate change to the workflow, not a secret or an API payment.
It would add a scan job with issue/PR write permission and a separate merge job
with repository-content and Actions write permission. Both use short-lived
`GITHUB_TOKEN` credentials, trusted `main` code, and GitHub-hosted runners.

The writer would restore missing labels matching the existing issue forms,
publish deduplicated PR readiness information, and squash-merge at most one ready
PR per run. It would not independently diagnose bugs, close old issues, publish
releases, create tags, or change repository protection. Normal GitHub `Closes #n`
links would keep closing issues when their PR is merged.

Merge readiness includes a current-commit approval from a trusted human, no open
blocking review threads or change requests, successful trusted CI and CodeQL,
fresh head/base commits, a protected `main`, and GitHub's normal merge-rule
enforcement. Unknown or unreadable requirements block merging. Changes to the
controller or its policy require human review.

Before writer activation, server-side branch protection must also require
up-to-date CI, at least one independent approval, dismissal of stale approvals,
and resolved review conversations. Those protections close races between the
controller's last read and its merge request. Current protection does not require
these review and freshness guarantees; the preview does not change it.

Merging with `GITHUB_TOKEN` does not trigger the usual subsequent push workflows.
Before enabling a writer, add explicit manual-dispatch support to CI, CodeQL and
Scorecard and verify the post-merge dispatches. The preview does not make those
changes or dispatch those workflows.

Neither this preview nor a draft PR enables native cloud Codex settings or a
writer. Verify those settings separately before relying on them, and avoid running
a second maintainer with mutation rights during migration.
