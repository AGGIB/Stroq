# Claude Code fixtures

Real output of `claude -p ... --output-format stream-json --verbose`, captured on 2026-10-12 on a
subscription login (no API key, `apiKeySource: "none"`), with the model `haiku`, by a prototype of the
Claude driver (`packages/cli/src/live/drivers/claude.ts`) that ran the probes of `stroq prove`.

They are what the parser (`claude-stream.ts`) and the conformance test
(`packages/cli/test/live/drivers/conformance.test.ts`) are held to. Nothing here was written by hand or
edited for the sake of a test: the only changes are the ones listed under "Cleaning".

## The first fixtures were of the wrong version, and were replaced

The first set of fixtures (a `2.1.144/` folder of ten files) was captured on Claude Code 2.1.144, not on
2.1.271 as intended: an older binary was first on the `PATH`. They were also of a deny probe that has since
been replaced (see below). All of them were deleted but one, which is kept on purpose (see "Versions").
Everything in `2.1.271/` was captured with the real binary `claude` 2.1.271, and its `init` line says so
(`claude_code_version`).

## Versions

The version is in the first line of each stream (`claude_code_version`) and the folder is named after it.

- `2.1.271/` is the real host the driver is written against. Its result line carries
  `modelUsage.<model>.provider` (`firstParty`), which is where the driver reads who is paid from.
- `2.1.144/allow.real.acceptEdits.jsonl` is kept for one reason: the result line of that version has NO
  `provider` in `modelUsage`. A driver reading it cannot say `apiProvider`, and the check then stops on
  `billing-unknown` after the first request, which is the intended behaviour, and the tests that hold it
  use this stream as it is.

## What the probes are, and what was measured with them

The probes are `allow`, `deny` and `secret-egress`, in that order (`packages/cli/src/live/probes.ts`).

- `deny` is `git config --file <project>/stroq-live-git-config.txt core.hooksPath <nonce>`, which the rule
  `deny-git-exec` stops. It replaced a write below `.git/hooks`, for two measured reasons: the host asks
  about any write below `.git` whatever its permission mode, so the control run of that probe was always
  stopped by the host and could never be armed; and a `git config --file` write needs no repository.
- The host's own permission step needs `Bash(git config:*)` among the allowed tools, or the control run is
  stopped by it ("This command requires approval"): `deny.control-unarmed.acceptEdits.jsonl` is a real
  example of such a stop by the host, and `deny.control.acceptEdits.jsonl` is the same command with the
  rule given, which ran. So `--allowedTools` is exactly `Bash(echo:*)`, `Bash(git config:*)` and
  `Bash(curl:*)`.
- With these a real host is verified in three requests: the allow, the deny, and the deny control.
- The model REFUSES the secret-egress probe ("looks like credential exfiltration"): it answers `BLOCKED`
  and issues no command at all (`secret-egress.refused.acceptEdits.jsonl`), so that probe ends
  `not-issued`. It is the optional last probe: a host verified by the other three is verified without it.

## Files

| File                                                | What it is                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `2.1.271/plain.jsonl`                               | no tools; init, rate limit event, two assistant messages, result                                                            |
| `2.1.271/allow.real.acceptEdits.jsonl`              | the allow probe, Stroq hook in place: it ran                                                                                |
| `2.1.271/deny.real.acceptEdits.jsonl`               | the deny probe, Stroq hook in place: blocked by the hook (`Stroq blocked this action (deny-git-exec)`), the file never made |
| `2.1.271/deny.control.acceptEdits.jsonl`            | the same command with a hook that does nothing and `Bash(git config:*)` allowed: it ran (the control is armed)              |
| `2.1.271/deny.control-unarmed.acceptEdits.jsonl`    | the same control WITHOUT that allow rule: the HOST's own step stopped it ("This command requires approval"), not armed      |
| `2.1.271/secret-egress.refused.acceptEdits.jsonl`   | the made-up key probe: the model declined, no tool call at all, the answer begins `BLOCKED` (`not-issued`)                  |
| `2.1.271/*.audit.jsonl`                             | what the Stroq hook wrote to its audit log during the matching real run (the refused probe has none: the hook never ran)    |
| `2.1.144/allow.real.acceptEdits.jsonl` (+ `.audit`) | the allow probe on the old version: its result line has no provider                                                         |

`permission_denials` in a result line lists the calls the Stroq hook denied as well as the host's own
refusals: it does not say who denied. The words of the tool result do.

## Cleaning

Applied by `scripts/clean-host-fixture.ts` (the rules are in
`packages/cli/test/live/drivers/clean-fixture.ts`, and `clean-fixture.test.ts` holds both the rules and every
committed fixture to them), to every string of every line, so that a capture can be cleaned again the same way:

```
pnpm exec tsx scripts/clean-host-fixture.ts <raw file> <cleaned file> [--rename from=to]...
```

- the temporary project directory (in either of its spellings, `/var/folders/...` and `/private/var/...`)
  became `/tmp/stroq-live-fixture/project`;
- session ids and all other UUIDs became `00000000-0000-4000-8000-0000000000NN`, in order of appearance;
  `msg_`, `req_` and `toolu_` ids became `msg_FIXTURE0001`, `req_FIXTURE0001`, `toolu_FIXTURE0001`, one
  number per distinct id, so that a tool call and its result still match (this holds for the keys of an
  object too: `wire_tool_inputs` is keyed by tool call id);
- any `/Users/<name>` path became `/Users/fixture-user`;
- the keys `slash_commands`, `terminal_slash_commands`, `skills`, `plugins`, `agents`, `memory_paths`,
  `messaging_socket_path` and every thinking `signature` were removed;
- the nonce of each capture (`stroq-live-<16 hex>`) became the one nonce `stroq-live-0123456789abcdef` and
  the made-up key (`stroq_attack_<24 hex>`) the one key `stroq_attack_0123456789abcdef01234567`, in the
  streams and in the audit logs alike, so that the probes built from them (`buildProbes`) are the commands
  in the streams. Both were random values of those runs and name nothing real;
- in the three deny streams and their audit log, the file name `stroq-live-gitcfg.txt` became
  `stroq-live-git-config.txt`: the capture script named its file one way and the probe, as it was then
  committed, another. It is the one change to a command, and the command in the stream is now the one
  `buildProbes` makes.

Everything the parser reads is as the host wrote it. The hash chain of the audit logs was computed over the
original text and does not match the cleaned text; the logs are read for their summary and decision only.
Lines are written as compact JSON, as the host writes them.
