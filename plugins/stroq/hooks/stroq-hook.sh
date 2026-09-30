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
#
# Two things about the npx path, both from a registry that is not answering the way
# the pin assumes:
#
# - The pin reaches the default branch before npm has the version (the release is
#   staged and needs approving), and the plugin updates from that branch. Until then
#   npx reports ETARGET for the pin; that one failure, and no other, is retried once
#   with the newest release, so the window costs a version and not every PreToolUse.
#   A failure of stroq itself is never retried: the pin means something.
# - npx has no deadline of its own, and Claude Code lifts a hook that outlives its
#   timeout (15 s in hooks.json) and lets the call through, which would turn a
#   registry that hangs into a firewall that is off. Each fetch is capped at 6 s with
#   no retries, so the pinned attempt and the fallback both fit, and a registry that
#   does not answer ends as a non-zero exit, which blocks a PreToolUse.
set -u
STROQ_PIN="@stroq/cli@0.21.1"

input="$(cat)"

# Each npm fetch is capped, twice over the 15 s hook timeout; see the header.
npx_stroq() {
  printf '%s' "$input" | npm_config_fetch_retries=0 npm_config_fetch_timeout=6000 npx -y "$1" hook claude-code
}

run_npx() {
  errfile="$(mktemp 2>/dev/null)" || errfile=""
  if [ -z "$errfile" ]; then
    npx_stroq "$STROQ_PIN"
    return $?
  fi
  npx_stroq "$STROQ_PIN" 2>"$errfile"
  code=$?
  cat "$errfile" >&2
  # The pinned version is not on npm (yet): only then run the newest release.
  if [ "$code" -ne 0 ] && grep -qE 'ETARGET|No matching version' "$errfile"; then
    rm -f "$errfile"
    npx_stroq "@stroq/cli@latest"
    return $?
  fi
  rm -f "$errfile"
  return "$code"
}

run_stroq() {
  if command -v stroq >/dev/null 2>&1; then
    printf '%s' "$input" | stroq hook claude-code
  elif command -v npx >/dev/null 2>&1; then
    run_npx
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
