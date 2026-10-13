# Codex CLI fixtures

Captured on Windows on 2026-10-13 with the real Codex CLI **0.162.1**, model
`gpt-5.6-luna`, and the account's existing ChatGPT login. The model was available on this
account at capture time; availability on another account is not implied. An unsupported
model ends the check as inconclusive and is not retried with another model.

The committed files come from `scripts/capture-codex-fixture.ts`, which calls the production
`createCodexDriver` and `verifyHost` with a persistent three-request ledger. This was a real
run, not a replay host: the result was `live` / `verified`, using exactly three inference
requests. Login/version preflights make no inference requests. The final run reported
61,640 input tokens (including cached tokens) and 390 output tokens. Codex did not report
a monetary amount; these counts describe usage, not a price.

| Capture        | Independent evidence                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `allow.real`   | One allow audit entry; the file exists with the nonce.                                                                            |
| `deny.real`    | One `deny-git-exec` audit entry; the file does not exist; the host's own router reports Stroq's deny words and the exact command. |
| `deny.control` | No new audit entry; the same command creates the git-config file with the nonce.                                                  |

Each capture includes stdout JSONL, the matching per-request audit entries, the actual
exit code and sentinel read in `*.evidence.json`, and the invocation. `*.stderr.jsonl`
is a lossless JSON container for the retained host diagnostic text, not Codex stdout.
The optional secret-egress probe was not attempted because the three-request cap had
been reached. This run establishes the allow/deny/control behavior of this version;
it does not establish secret-egress protection, other host versions, or POSIX behavior.

## What Codex actually reports

`command_execution` items contain a rendered shell argv. The parser unwraps a recognized
shell's single quoted command argument; unfamiliar wrappers remain unchanged and cannot
silently become an exact probe match. Started/completed updates of the same item are one
tool call.

A hook-denied command is **absent from `codex exec --json`** in this version. Its only host
record is stderr's `ERROR codex_core::tools::router: error=Command blocked by PreToolUse hook:`
diagnostic, ending in `Command: <exact command>`. The driver reads that diagnostic while the
process runs. A completed command's output also contributes tool-result text, so a similar
phrase there can supply E4 wording. A pass still requires the exact command, matching
independent audit entry, absent sentinel and successful control; wording alone never
verifies a deny. Both streams are bounded by the same total and line limits.

JSONL does not state the authentication method or provider. Before **each** inference
process, the driver requires the host's exact successful `codex login status` answer
`Logged in using ChatGPT`. It strips API/provider environment overrides, forces
`forced_login_method="chatgpt"` and `model_provider="openai"`, ignores user config/rules,
and never reads, copies or relocates authentication files. A host billing signal in its
error stream stops the process immediately; a model/tool mention of API billing does not.
Billing claims in `HostRun` come from this host preflight and forced configuration, not
from `thread.started` or from an inference made by the model. The cwd claim comes from
the spawn options, not from the host stream. Plan pay-as-you-go credits are not detected.

The check runs fixed inert probes with `approval_policy="never"` and
`sandbox="danger-full-access"` in both real and control runs. Windows' workspace-write
sandbox rejected even the allow probe before the hook during development, so it could not
arm a control. This check therefore does not establish sandbox protection. Hook trust is
bypassed for this invocation; results retain `hook-trust-bypassed` and `sandbox-disabled`.
The CLI refuses other platforms and versions until they have their own measured capture.

Only the inline Stroq pre-tool hook is supplied. The control changes its command to
`node -e 0`, which prints nothing and makes no explicit allow decision. The host keeps
its authentication home; a generated wrapper gives only Stroq the throwaway home and
policy/audit directory. On Windows it uses Stroq's existing quote-free short-path helper:
a quoted wrapper failed to start in the real host, which then continued without the hook.
Codex probes use native forward-slash paths, rather than Claude Code's Git Bash drive form.

`--ignore-user-config` does not remove the user layer's adjacent `hooks.json`. The driver
refuses existing or uninspectable user hooks, project/ancestor hook configurations, and
known local system/managed configuration sources before inference; it never rewrites or
temporarily disables them. Enterprise cloud-managed configuration was not exercised.
The check proves this isolated hook line, not that a user's installed hooks or project
trust settings are loaded in an ordinary session.

## Reproduce and clean

Build first, sign in to Codex using ChatGPT, then run manually (this spends subscription
requests; automated tests never call the real model):

```sh
pnpm build
pnpm exec tsx scripts/capture-codex-fixture.ts /absolute/private/raw-output
pnpm exec tsx scripts/clean-codex-fixture.ts /absolute/private/raw-output packages/cli/test/fixtures/hosts/codex/0.162.1
```

`STROQ_CODEX_BIN` can name an absolute native Codex executable. The capture keeps its
throwaway directory for disk/audit inspection and records its location privately. Remove
that marked temporary directory after inspection; it is not part of the committed fixtures.

Cleaning replaces the temporary root with `/tmp/stroq-live-fixture`, user names with
`fixture-user`, UUIDs with numbered fixture IDs, and random test
nonces/credentials with the shared fixture values. It retains only the hook-denial router
line from stderr; unrelated shell-snapshot and plugin-cache diagnostics are omitted.
Audit captures are cumulative, so cleaning selects entries carrying that request's nonce.
Audit hashes were computed over the original text and are not recomputed or verified after
cleaning. Paths in the fixture are replacements; they do not claim the run was on Linux.
The historical 0.162.1 shell path was normalized to `/usr/bin/pwsh`; new captures retain
the host's quoting and executable spelling. The cleaner refuses remaining Windows or
POSIX home paths and AppData references. Tests scan every committed JSON/JSONL file and
reproduce each recorded argv plus the version/login preflights.

Development made 24 inference attempts through `codex exec`: one unsupported-model failure without
reported usage and 23 completed turns, including unarmed/no-hook experiments. Those turns
reported 460,064 input and 3,167 output tokens in total. They are not extra successful
verification runs: only the final production-driver three-probe run is recorded here.
Local help, version, login and rejected argument-validation commands are not inference attempts.
