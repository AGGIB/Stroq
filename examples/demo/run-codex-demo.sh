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
  local event="$1" out code
  echo
  echo "== $event"
  # Codex blocks on exit 2 with the reason on stderr, so the exit code is part of
  # the output here; `set -e` must not abort the demo when Stroq uses it.
  set +e
  out="$(sed "s#__CWD__#$demo_cwd#g" "$root/examples/demo/codex-events/$event.json" | node "$cli" hook codex)"
  code=$?
  set -e
  [ "$code" -eq 0 ] || echo "(exit $code → Codex blocks, reason on stderr above)"
  if [ -n "$out" ]; then echo "$out"; else echo "(no output → action allowed / content clean)"; fi
}
for event in 1-post-bash-npm-install 2-pre-bash-curl 3-pre-bash-ls 4-pre-apply-patch-hooks 5-pre-mcp-secret; do
  run_event "$event"
done
echo
echo "== stroq why"
node "$cli" why
echo
echo "== audit log"
node "$cli" log
node "$cli" verify
