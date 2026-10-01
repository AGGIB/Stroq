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
# failed, registry not answering), a PreToolUse event exits with code 2, which
# Claude Code treats as "block". PostToolUse events fail open in that case,
# because the tool has already run and there is nothing left to block.
#
# Three things about the npx path, all from a registry, or a directory, that is not
# what the pin assumes:
#
# - The pin reaches the default branch before npm has the version (the release is
#   staged and needs approving), and the plugin updates from that branch. Until then
#   npx reports ETARGET for the pin; that one failure, and no other, is retried once
#   with the newest release, so the window costs a version and not every PreToolUse.
#   A failure of stroq itself is never retried: the pin means something.
# - npx has no deadline of its own, and Claude Code lifts a hook that outlives its
#   timeout (15 s in hooks.json) and lets the call through, which would turn a
#   registry that hangs into a firewall that is off. The whole npx path, the pinned
#   attempt and the fallback together, gets one deadline (11 s), after which npx and
#   everything it started are ended and the exit is non-zero, so a PreToolUse blocks.
#   Each fetch is also capped and not retried, so most failures come sooner.
# - npm puts the node_modules/.bin of every folder above where it runs on PATH, and the
#   installed stroq starts with `#!/usr/bin/env node`, so the scratch directory is made
#   under Stroq's own home (whose ancestors are the user's), never in a shared temp
#   directory where another user of the machine could plant a `node`.
# - npm reads the `.npmrc` of the project it finds by walking up from where it runs, and a
#   repository can carry one that names the registry the package comes from. npx is run
#   from a fresh directory with a package.json of its own, and with --no-workspaces (a
#   folder above that lists it as a workspace would supply its own node_modules), so
#   neither the project nor anything above the scratch directory chooses the code that
#   acts as its firewall (Stroq takes the project's directory from the hook event, not
#   from where it runs).
set -u
STROQ_PIN="@stroq/cli@0.22.0"

input="$(cat)"

# Seconds the whole npx path may take: under the 15 s hook timeout, with room for Node's
# own start-up. STROQ_PLUGIN_NPX_DEADLINE is for the tests.
NPX_DEADLINE="${STROQ_PLUGIN_NPX_DEADLINE:-11}"
# A fallback attempt needs about this long to download; with less left, do not start one.
MIN_FALLBACK_SECONDS=3

work=""
cleanup() {
  if [ -n "$work" ]; then rm -rf "$work"; fi
}
trap cleanup EXIT

# Runs `npx -y <package> hook claude-code` from the scratch directory, with the event on
# stdin and stderr in "$work/err", and ends the whole process tree after $1 seconds.
# Returns npx's exit status, which is 143 or 137 when the deadline ended it.
# Job control gives the background job its own process group, which is what the
# watchdog signals: npx starts node, and node starts stroq.
run_bounded() {
  local secs="$1" package="$2" pid watchdog status
  set -m
  (
    cd "$work" || exit 126
    export npm_config_fetch_retries=0 npm_config_fetch_timeout=6000
    # --no-workspaces: a folder above that lists this one as a workspace makes npm run
    # the package it finds in THAT folder's node_modules, and a `stroq` planted there
    # would answer as the firewall.
    exec npx --no-workspaces -y "$package" hook claude-code <"$work/in" 2>"$work/err"
  ) &
  pid=$!
  (
    sleep "$secs"
    kill -s TERM -- "-$pid" 2>/dev/null
    sleep 1
    kill -s KILL -- "-$pid" 2>/dev/null
  ) >/dev/null 2>&1 &
  watchdog=$!
  disown "$watchdog" 2>/dev/null
  wait "$pid" 2>/dev/null
  status=$?
  kill -s TERM -- "-$watchdog" 2>/dev/null
  set +m
  return "$status"
}

run_npx() {
  local start="$SECONDS" code left
  # Under Stroq's own home, not in a shared temp directory: npm puts the node_modules/.bin of
  # every folder above its working directory on PATH, ahead of the user's, and the installed
  # stroq starts with `#!/usr/bin/env node`. In /tmp (where mktemp puts it on Linux) any other
  # user of the machine can plant a `node` there that then answers as the firewall.
  base="${STROQ_HOME:-${HOME:-}/.stroq}/plugin-tmp"
  if [ -z "${STROQ_HOME:-}" ] && [ -z "${HOME:-}" ]; then
    echo "Stroq plugin: neither STROQ_HOME nor HOME is set, so there is nowhere private to run npx from" >&2
    return 1
  fi
  mkdir -p "$base" 2>/dev/null && chmod 700 "$base" 2>/dev/null
  # What an earlier hook left when it was killed before it could clean up.
  find "$base" -maxdepth 1 -name 'run.*' -mtime +1 -exec rm -rf {} + 2>/dev/null
  work="$(mktemp -d "$base/run.XXXXXX" 2>/dev/null)" || work=""
  if [ -z "$work" ]; then
    echo "Stroq plugin: could not make a scratch directory to run npx from" >&2
    return 1
  fi
  printf '%s' "$input" >"$work/in"
  # npm finds the project by walking up to the nearest package.json (or node_modules) and
  # reads that folder's .npmrc: an empty directory inside one that has a hostile .npmrc
  # would inherit it. A package.json of its own makes this directory the project.
  printf '{}' >"$work/package.json"
  run_bounded "$NPX_DEADLINE" "$STROQ_PIN"
  code=$?
  cat "$work/err" >&2
  # The pinned version is not on npm (yet): only then run the newest release, and only
  # if the first attempt left enough of the deadline for it.
  if [ "$code" -ne 0 ] && grep -qE 'ETARGET|No matching version' "$work/err"; then
    left=$((NPX_DEADLINE - (SECONDS - start)))
    if [ "$left" -ge "$MIN_FALLBACK_SECONDS" ]; then
      run_bounded "$left" "@stroq/cli@latest"
      code=$?
      cat "$work/err" >&2
    fi
  fi
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
