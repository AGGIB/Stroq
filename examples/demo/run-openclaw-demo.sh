#!/usr/bin/env bash
# Replays six recorded OpenClaw tool calls through the real CLI and asserts the
# decision each one must produce, then checks that the plugin the Gateway loads
# actually ships inside @stroq/cli. A demo that prints a convincing story while the
# decision underneath it has changed is worse than no demo, so every event is checked
# with grep over the captured streams and any mismatch exits 1.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cli="$root/packages/cli/dist/index.js"
[ -f "$cli" ] || { echo "build first: pnpm build" >&2; exit 1; }
export STROQ_HOME="$(mktemp -d)"
export HOME="$(mktemp -d)"
demo_cwd="$(mktemp -d)"
work="$(mktemp -d)"
trap 'rm -rf "$STROQ_HOME" "$HOME" "$demo_cwd" "$work"' EXIT
secret='demo_secret_value_1234567890abcdef'
printf 'DEMO_API_KEY=%s\n' "$secret" > "$demo_cwd/.env"
echo "STROQ_HOME=$STROQ_HOME"
echo "demo project with a .env: $demo_cwd"

last_code=0

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# expect <event> <file> <literal text>
expect() {
  grep -qF -- "$3" "$2" || fail "$1 (expected: $3)"
}

# absent <event> <file> <literal text>
absent() {
  if [ -f "$2" ] && grep -qF -- "$3" "$2"; then fail "$1 (must not contain that text: $2)"; fi
}

# The phase is not in the payload: the plugin puts it on the command line. Each
# fixture's file name says which one it is.
run_event() {
  local event="$1" phase
  phase="${event#*-}"
  phase="${phase%%-*}"
  echo
  echo "== $event ($phase)"
  # `set -e` must not abort the demo when Stroq blocks with a non-zero exit.
  set +e
  sed "s#__CWD__#$demo_cwd#g" "$root/examples/demo/openclaw-events/$event.json" \
    | node "$cli" hook openclaw "$phase" > "$work/out" 2> "$work/err"
  last_code=$?
  set -e
  # Exit 2 is Stroq's own failure, which the plugin turns into a block. Any OTHER
  # non-zero exit is Stroq crashing, and the demo treats it as a failure because it
  # is not a decision Stroq made.
  if [ "$last_code" -eq 2 ]; then
    echo "(exit 2 -> the plugin blocks, reason on stderr)"
  elif [ "$last_code" -ne 0 ]; then
    cat "$work/err" >&2
    fail "$event (unexpected exit $last_code)"
  fi
  if [ -s "$work/err" ]; then cat "$work/err" >&2; fi
  cat "$work/out"
  echo
}

event=1-post-exec-npm-install
run_event "$event"
expect "$event" "$work/out" '"verdict":"suspect"'
expect "$event" "$work/out" '"warning"'

event=2-pre-exec-curl
run_event "$event"
expect "$event" "$work/out" '"decision":"deny"'
expect "$event" "$work/out" 'deny-encoded-exec'

event=3-pre-exec-ls
run_event "$event"
[ "$last_code" -eq 0 ] || fail "$event (expected exit 0)"
expect "$event" "$work/out" '{"decision":"allow"}'

event=4-pre-write-openclaw-json
run_event "$event"
expect "$event" "$work/out" '"decision":"deny"'
expect "$event" "$work/out" 'deny-self-tamper'

event=5-pre-message-secret
run_event "$event"
expect "$event" "$work/out" '"decision":"deny"'
expect "$event" "$work/out" 'deny-secret-egress'
expect "$event" "$work/out" 'DEMO_API_KEY'
# The reason names the secret and its source; the value itself leaves no trace on
# any channel Stroq writes to.
absent "$event" "$work/out" "$secret"
absent "$event" "$work/err" "$secret"
absent "$event" "$STROQ_HOME/audit.jsonl" "$secret"
absent "$event" "$STROQ_HOME/stroq.log" "$secret"

# The decision Codex has no way to render: on OpenClaw an ask is a real /approve prompt.
event=6-pre-exec-git-reset
run_event "$event"
[ "$last_code" -eq 0 ] || fail "$event (an ask is exit 0 with JSON, not a block)"
expect "$event" "$work/out" '"decision":"ask"'
expect "$event" "$work/out" 'ask-destructive'

echo
echo "== the plugin ships inside @stroq/cli"
# A plugin that is not in the packed tarball is an adapter that cannot be installed,
# and `files` is the only thing that decides.
( cd "$root/packages/cli" && npm pack --dry-run --json ) > "$work/pack" 2>/dev/null \
  || fail "npm pack --dry-run failed"
for f in openclaw-plugin/openclaw.plugin.json openclaw-plugin/package.json \
         openclaw-plugin/index.js openclaw-plugin/run-stroq.js openclaw-plugin/README.md; do
  grep -qF "\"$f\"" "$work/pack" \
    || fail "npm pack does not ship $f (add openclaw-plugin to packages/cli/package.json files)"
  echo "  $f"
done

echo
echo "== stroq why"
node "$cli" why
echo
echo "== audit log"
node "$cli" log
node "$cli" verify
echo
echo "OK: every event produced the decision it was supposed to"
