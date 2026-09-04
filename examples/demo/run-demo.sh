#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cli="$root/packages/cli/dist/index.js"
[ -f "$cli" ] || { echo "build first: pnpm build" >&2; exit 1; }
export STROQ_HOME="$(mktemp -d)"
echo "STROQ_HOME=$STROQ_HOME"
for event in 1-post-read 2-pre-bash-curl 3-pre-bash-ls 4-post-mcp-sentry 5-pre-bash-npx; do
  echo
  echo "== $event"
  out="$(node "$cli" hook claude-code < "$root/examples/demo/events/$event.json")"
  if [ -n "$out" ]; then echo "$out"; else echo "(no output → action allowed / content clean)"; fi
done
echo
echo "== stroq why"
node "$cli" why
echo
echo "== audit log"
node "$cli" log
node "$cli" verify
