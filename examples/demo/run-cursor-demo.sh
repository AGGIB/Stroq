#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cli="$root/packages/cli/dist/index.js"
[ -f "$cli" ] || { echo "build first: pnpm build" >&2; exit 1; }
export STROQ_HOME="$(mktemp -d)"
export HOME="$(mktemp -d)"
demo_cwd="$(mktemp -d)"
trap 'rm -rf "$STROQ_HOME" "$HOME" "$demo_cwd"' EXIT
printf 'DEMO_API_KEY=demo_secret_value_1234567890abcdef\n' > "$demo_cwd/.env"
echo "STROQ_HOME=$STROQ_HOME"
echo "demo project with a .env: $demo_cwd"
run_event() {
  local event="$1" out
  echo
  echo "== $event"
  out="$(sed "s#__CWD__#$demo_cwd#g" "$root/examples/demo/cursor-events/$event.json" | node "$cli" hook cursor)"
  if [ -n "$out" ]; then echo "$out"; else echo "(no output → action allowed / content clean)"; fi
}
for event in 1-before-read-file 2-before-shell-curl 3-before-shell-ls 4-after-mcp-sentry 5-before-mcp-secret; do
  run_event "$event"
done
echo
echo "== stroq why"
node "$cli" why
echo
echo "== audit log"
node "$cli" log
node "$cli" verify
