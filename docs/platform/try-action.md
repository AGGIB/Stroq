# Try an action

**Try an action** (`/try/`) answers one question without touching anything: _what would my policy do
with this?_ Type a command, a file to read or write, or a page to fetch, and the real Stroq engine
judges it twice: in a clean session, and in the same session after the agent has read a file that
hides an instruction. The two answers side by side show what no list of rules can: the same action
is treated differently once the session has read something it cannot trust.

It is also the fastest way to see Stroq work on a fresh install, before any agent is connected.
The page offers eight examples; one click runs one.

## What the answer means

Each row is a **recorded policy decision**: `Allowed`, `Asks you` or `Denied`, with the rule that
decided it, that rule's own reason and the finite classification signals behind it (for example
`remote-pipe-shell`). A summary sentence says whether the answer depends on what the agent read.

It is not a test of any agent and not a claim that anything was blocked. See the limits below.

## How it runs

- `POST /api/policy/try` with `{ "kind": "command" | "read" | "write" | "fetch", "subject": "<one
action, at most 1000 characters>" }`. No other field is accepted, so a path, working directory,
  environment value or URL cannot be supplied.
- The policy service reads the current policy (your `policy.yaml`, or the built-in default) and sends
  the request to the policy engine in a worker thread with a 4 s deadline and a 256 MiB heap cap. The worker's temporary folder is a
  private scratch folder that the service removes once the worker has stopped, so a run that is cut off
  cannot leave its throwaway folders behind.
- The worker runs the same step runner as `stroq attack` and `stroq bench --actions`
  (`runActionScenario`) twice, each in a throwaway project and home that the runner removes
  afterwards. The tainted run first replays one fixed made-up README with a hidden instruction, and
  the row says so if the engine did not actually reach the suspect state.
- The response is validated against a closed schema (`stroq-try-action/1`) on the server's side in
  tests and again in the browser before anything is shown.

## What it never does

- It runs, writes and sends nothing. The engine judges the event; it does not execute it. It does read:
  to judge a command that runs a script or names a config file (`bash file`, `source file`,
  `ssh host`), the engine opens that file on your real disk, as the real hook does. Nothing from it is
  returned, but the verdict can depend on what it holds, so a typed command can tell you something
  about a file.
- It stores nothing: no history, no home directory, no backup. A test asserts the Stroq home stays
  empty. The text you typed is held only in the page's memory and is never returned by the server.
- Reasons come from the rule in your policy. The engine's extra context for a tainted session (the
  throwaway file path and the commands that clear a taint) is dropped, because it names a folder that
  no longer exists and commands that mean nothing here.
- It cannot be used while a policy preview or apply is running: the check is refused as `busy`
  instead of reading a policy that is changing.

## Limits

- It judges a made-up event in a throwaway folder. A real host may send a different event, or run the
  action without asking Stroq.
- The untrusted-text row uses one fixed file. Real sessions can reach that state in other ways.
- Your own secret values, session history and MCP servers are not part of the check. A real run
  also knows them, so an action that the secret guard would deny on your machine can be `Allowed`
  here.
- MCP tool calls are not offered yet.

## Where it lives

- Page: `console/components/platform/try-action.tsx`, hook `use-try-action.ts`, wording and schema
  in `console/lib/try-action.ts`.
- Engine: `console/scripts/try-action.ts`, dispatched as the `try-action` operation of
  `policy-engine-entry.ts`; service method `tryAction` in `policy-service.mjs`.
- Tests: `lib/try-action.test.ts` (schema and wording), `scripts/try-action-engine.test.mjs`
  (decisions, no echo, no leftovers), `scripts/try-action-http.test.mjs` (route gates, own policy,
  invalid policy, nothing written).
