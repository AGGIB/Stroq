#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cli="$root/packages/cli/dist/index.js"
[ -f "$cli" ] || { echo "build first: pnpm build" >&2; exit 1; }
export STROQ_HOME="$(mktemp -d)"
demo_cwd="$(mktemp -d)"
printf 'DEMO_API_KEY=demo_secret_value_1234567890abcdef\n' > "$demo_cwd/.env"
echo "STROQ_HOME=$STROQ_HOME"
echo "demo project with a .env: $demo_cwd"
run_event() {
  local event="$1" out
  echo
  echo "== $event"
  out="$(sed "s#__CWD__#$demo_cwd#g" "$root/examples/demo/events/$event.json" | node "$cli" hook claude-code)"
  if [ -n "$out" ]; then echo "$out"; else echo "(no output → action allowed / content clean)"; fi
}
for event in 1-post-read 2-pre-bash-curl 3-pre-bash-ls 4-post-mcp-sentry 5-pre-bash-npx 6-pre-bash-curl-secret; do
  run_event "$event"
done
echo
echo "== stroq why"
node "$cli" why
echo
echo "== audit log"
node "$cli" log
node "$cli" verify
