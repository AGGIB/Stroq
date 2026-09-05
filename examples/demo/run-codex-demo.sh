#!/usr/bin/env bash
# Replays five recorded Codex hook events through the real CLI and asserts the
# decision each one must produce. A demo that prints a convincing story while the
# decision underneath it has changed is worse than no demo, so every event is
# checked with grep over the captured streams and any mismatch exits 1.
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

run_event() {
  local event="$1"
  echo
  echo "== $event"
  # `set -e` must not abort the demo when Stroq blocks with a non-zero exit.
  set +e
  sed "s#__CWD__#$demo_cwd#g" "$root/examples/demo/codex-events/$event.json" \
    | node "$cli" hook codex > "$work/out" 2> "$work/err"
  last_code=$?
  set -e
  # Exit 2 is the one block Codex honours without parsing stdout. Any OTHER
  # non-zero exit is Stroq failing, and Codex reads that as a hook failure and
  # runs the action anyway — so it is a demo failure, not a decision.
  if [ "$last_code" -eq 2 ]; then
    echo "(exit 2 -> Codex blocks, reason on stderr)"
  elif [ "$last_code" -ne 0 ]; then
    cat "$work/err" >&2
    fail "$event (unexpected exit $last_code)"
  fi
  if [ -s "$work/err" ]; then cat "$work/err" >&2; fi
  if [ -s "$work/out" ]; then
    cat "$work/out"
    echo
  else
    echo "(no output -> action allowed / content clean)"
  fi
}

event=1-post-bash-npm-install
run_event "$event"
expect "$event" "$work/out" 'additionalContext'

event=2-pre-bash-curl
run_event "$event"
expect "$event" "$work/out" '"permissionDecision":"deny"'
expect "$event" "$work/out" 'deny-encoded-exec'

event=3-pre-bash-ls
run_event "$event"
[ "$last_code" -eq 0 ] || fail "$event (expected exit 0)"
if [ -s "$work/out" ]; then fail "$event (expected no output)"; fi

event=4-pre-apply-patch-hooks
run_event "$event"
expect "$event" "$work/out" '"permissionDecision":"deny"'
expect "$event" "$work/out" 'deny-self-tamper'

event=5-pre-mcp-secret
run_event "$event"
expect "$event" "$work/out" '"permissionDecision":"deny"'
expect "$event" "$work/out" 'deny-secret-egress'
expect "$event" "$work/out" 'DEMO_API_KEY'
# The reason names the secret and its source; the value itself leaves no trace on
# any channel Stroq writes to.
absent "$event" "$work/out" "$secret"
absent "$event" "$work/err" "$secret"
absent "$event" "$STROQ_HOME/audit.jsonl" "$secret"
absent "$event" "$STROQ_HOME/stroq.log" "$secret"

echo
echo "== stroq why"
node "$cli" why
echo
echo "== audit log"
node "$cli" log
node "$cli" verify
echo
echo "OK: every event produced the decision it was supposed to"
