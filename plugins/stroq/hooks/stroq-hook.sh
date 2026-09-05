#!/usr/bin/env bash
# Claude Code hook entrypoint for the Stroq plugin.
#
# Reads the hook event JSON on stdin and forwards it to `stroq hook claude-code`,
# printing Stroq's decision on stdout. A globally installed `stroq` is preferred
# (no registry lookup); otherwise the pinned npm version runs through npx. The
# first npx run downloads the package (a few seconds); later runs hit the cache.
#
# Failure semantics. Stroq itself fails closed for high-impact PreToolUse calls:
# any internal error is printed as a deny. This wrapper extends that to the
# runtime: if `stroq` cannot be started at all (no Node, no npx, download
# failed), a PreToolUse event exits with code 2, which Claude Code treats as
# "block". PostToolUse events fail open in that case, because the tool has
# already run and there is nothing left to block.
set -u
STROQ_PIN="@stroq/cli@0.3.0"

input="$(cat)"

run_stroq() {
  if command -v stroq >/dev/null 2>&1; then
    printf '%s' "$input" | stroq hook claude-code
  elif command -v npx >/dev/null 2>&1; then
    printf '%s' "$input" | npx -y "$STROQ_PIN" hook claude-code
  else
    echo "Stroq plugin: neither 'stroq' nor 'npx' is on PATH. Install Node >= 22, or run: npm install -g @stroq/cli" >&2
    return 127
  fi
}

run_stroq
status=$?
if [ "$status" -ne 0 ]; then
  echo "Stroq plugin: could not run stroq (exit $status)" >&2
  case "$input" in
    *'"hook_event_name"'*'"PreToolUse"'*) exit 2 ;;
    *) exit 0 ;;
  esac
fi
exit 0
