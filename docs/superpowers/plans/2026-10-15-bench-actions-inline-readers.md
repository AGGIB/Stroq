# Inline Interpreter Precision Plan (Issue #232)

## Problem Statement
`stroq bench --actions` replays 75 scenarios of ordinary agent work. On 0.25.1, 4 scenarios (5.3%) are asked about under `ask-shell-unparsed`:
- `53-api-json-python-reader-with-os`: Python program reading an API response and an environment variable (`os.environ['USER']`).
- `54-api-json-python-saves-file`: Python program writing fetched JSON to a local file (`open('items.json', 'w').write(...)`).
- `55-api-json-node-reader`: Node program reading stdin via event stream (`process.stdin.on('data', ...).on('end', ...)`).
- `56-api-json-node-print`: Node program reading stdin via `require('fs').readFileSync(0, 'utf8')` and parsing JSON with `node -p`.

## Decisions Per Idiom
1. `53-api-json-python-reader-with-os`:
   - Decision: Allow (judge as `data`).
   - Rationale: `os.environ` and `os.getenv` inspect read-only environment variables. Does not spawn processes or write files.
   - Reader: Add `os` to allowed modules strictly when attributes are limited to `environ` and `getenv`.
2. `54-api-json-python-saves-file`:
   - Decision: Remain an `ask`.
   - Rationale: Inline unconstrained file writes from network payloads mutate the filesystem. Unlike shell redirects (`> items.json`), inline `open(..., 'w')` hides path targets from path rules.
3. `55-api-json-node-reader`:
   - Decision: Remain an `ask`.
   - Rationale: Event-driven streaming with mutable state and callbacks cannot be proven safe without arbitrary AST validation.
4. `56-api-json-node-print`:
   - Decision: Allow (judge as `data`).
   - Rationale: `readFileSync(0, ...)` is Node's idiomatic synchronous stdin read (equivalent to `sys.stdin.read()` in Python).
   - Reader: Add `judgeNodeProgram` in `packages/core/src/actions/inline-node.ts` (or `pipe-consumer.ts`) recognizing synchronous JSON parsing of fd 0 and property access.

## Non-Goals & Safety Boundaries
Must remain denied or asked about:
- `os.system`, `subprocess`, `eval`, `exec`, `compile`, `__import__`, `getattr` on a module, `child_process`, `process.binding`, network calls, file writes outside the project or to protected paths.

## 5-Commit Execution Rhythm
1. `docs(plans): add plan for narrow Python os.environ and Node readFileSync(0) readers`
2. `feat(actions): allow read-only os.environ/getenv in inline Python classifier`
3. `feat(actions): add narrow synchronous stdin reader for inline Node programs`
4. `docs(bench): update GUIDE and BENCH.md for 2 remaining actions-bench asks`
5. `test(actions): verify non-goal denials, ReDoS bounds, and actions-bench reduction`
