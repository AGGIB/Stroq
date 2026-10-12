# Claude Code fixtures

Real output of `claude -p ... --output-format stream-json --verbose`, captured on 2026-10-12 on a
subscription login (no API key, `apiKeySource: "none"`), with the model `haiku`, by a prototype of the
Claude driver (`packages/cli/src/live/drivers/claude.ts`) that ran the three probes of `stroq prove` once
each, and each deny probe a second time with a hook that does nothing (the control).

They are what the parser (`claude-stream.ts`) and the conformance test
(`packages/cli/test/live/drivers/conformance.test.ts`) are held to. Nothing here was written by hand or
edited for the sake of a test: the only changes are the ones listed under "Cleaning".

## Versions

The version is in the first line of each stream (`claude_code_version`) and the folder is named after it.

- `2.1.271/plain.jsonl` is a request with no tools at all. Its last line is the only one that carries
  `modelUsage.<model>.provider` (`firstParty`), which is where the driver reads the provider from.
- `2.1.144/` holds the ten files of the probe runs. The Claude Code that answered those requests was
  2.1.144 (the driver was written against 2.1.271, whose output differs in the one place below), and the
  result line of that version has NO `provider` in `modelUsage`. A driver reading it cannot say
  `apiProvider`, and the check then stops on `billing-unknown` after the first request, which is the
  intended behaviour; the tests that need the provider add it to the result line in code and say so.

## Files

| File                                              | What it is                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2.1.271/plain.jsonl`                             | no tools; init, rate limit event, two assistant messages, result                                                                                  |
| `2.1.144/allow.real.acceptEdits.jsonl`            | the allow probe, Stroq hook in place: it ran                                                                                                      |
| `2.1.144/allow.real.dontAsk.jsonl`                | the allow probe under `--permission-mode dontAsk`: the HOST's own rules blocked it (the reason `acceptEdits` is used)                             |
| `2.1.144/secret-egress.real.acceptEdits.jsonl`    | the made-up key probe, Stroq hook in place: blocked by the hook (`Stroq blocked this action (deny-secret-egress)`)                                |
| `2.1.144/secret-egress.control.acceptEdits.jsonl` | the same command with a hook that does nothing: it ran (the control is armed)                                                                     |
| `2.1.144/deny.real.acceptEdits.jsonl`             | the git-hook probe, Stroq hook in place: blocked by the hook (`deny-git-exec`)                                                                    |
| `2.1.144/deny.control.acceptEdits.jsonl`          | the same command with a hook that does nothing: the HOST's own permission step blocked it (the host protects `.git`), so the control is not armed |
| `2.1.144/*.audit.jsonl`                           | what the Stroq hook wrote to its audit log during the matching real run                                                                           |

`permission_denials` in a result line lists the calls the Stroq hook denied as well as the host's own
refusals: it does not say who denied. The words of the tool result do.

## Cleaning

Applied once, by a script, to every string of every line:

- the temporary project directory (in either of its spellings, `/var/folders/...` and `/private/var/...`)
  became `/tmp/stroq-live-fixture/project`;
- session ids and all other UUIDs became `00000000-0000-4000-8000-0000000000NN`, in order of appearance;
  `msg_`, `req_` and `toolu_` ids became `msg_FIXTURE0001`, `req_FIXTURE0001`, `toolu_FIXTURE0001`, one
  number per distinct id, so that a tool call and its result still match;
- any `/Users/<name>` path became `/Users/fixture-user`;
- the keys `slash_commands`, `terminal_slash_commands`, `skills`, `plugins`, `agents`, `memory_paths`,
  `messaging_socket_path` and every thinking `signature` were removed.

Everything the parser reads is as the host wrote it. The nonces (`stroq-live-<16 hex>`) and the made-up key
(`stroq_attack_<24 hex>`) are the random values of those runs and name nothing real. The hash chain of the
audit logs was computed over the original paths and does not match the cleaned text; the logs are read for
their summary and decision only.
