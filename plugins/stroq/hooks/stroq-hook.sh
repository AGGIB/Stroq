#!/usr/bin/env bash
# Claude Code hook entrypoint for the Stroq plugin.
#
# Reads the hook event JSON on stdin and forwards it to `stroq hook claude-code`,
# printing Stroq's decision on stdout. Three ways to start Stroq, in this order:
#
# 1. A globally installed `stroq`: no registry lookup, nothing to download.
# 2. The pinned version, installed once into a copy of its own and run with `node`. The
#    wrapper runs twice for a tool call (before it, and after it or after its failure), and
#    through npx each of them cost about 0.7 s against 0.13 s for node on the same bundle,
#    plus a request to the registry that a slow or absent network turned into a blocked
#    call. The copy is `~/.stroq/plugin-cli/<version>`, put there by `npm install
#    --ignore-scripts` into a staging directory and moved into place in one step, so a
#    hook that starts while another is installing sees a whole copy or none. It lives
#    under Stroq's own home, not in a folder of the plugin or of Claude Code, because
#    Stroq's self-tamper gate watches `~/.stroq`: a write that names that path is refused.
#    The gate checks the path as written, so that raises the bar and is not a guarantee.
# 3. The pinned version through npx, which is what every call did before. It is what runs
#    when the install failed (no network, the pin not on npm yet, a copy that could not be
#    put in place). The first npx run downloads the package (a few seconds); later runs hit
#    the cache.
#
# STROQ_PLUGIN_NO_LOCAL_COPY=1 skips the copy and goes straight to npx (any other value does not).
#
# Failure semantics. Stroq itself fails closed for high-impact PreToolUse calls:
# any internal error is printed as a deny. This wrapper extends that to the
# runtime: if `stroq` cannot be started at all (no Node, no npx, download
# failed, registry not answering), a PreToolUse event exits with code 2, which
# Claude Code treats as "block". PostToolUse events fail open in that case,
# because the tool has already run and there is nothing left to block. A stroq that
# started and failed is not retried through another way: the pin means something.
#
# A stroq that does not answer is ended too. Claude Code lifts a hook that outlives its
# timeout (15 s in hooks.json) and lets the call through, so a stroq that hangs (a FIFO a
# script is named after, in 0.22.0) would turn the firewall off for that call. Whichever way
# it was started, it runs under a deadline (RUN_DEADLINE) after which it and everything it
# started are ended and the exit is non-zero, so a PreToolUse blocks.
#
# Four things about the install and the npx path, all from a registry, or a directory,
# that is not what the pin assumes:
#
# - The pin reaches the default branch before npm has the version (the release is
#   staged and needs approving), and the plugin updates from that branch. Until then
#   npx reports ETARGET for the pin; that one failure, and no other, is retried once
#   with the newest release, so the window costs a version and not every PreToolUse.
#   (The install fails the same way, and npx then goes straight to the newest release.)
# - npx has no deadline of its own, and neither has npm. The whole path to a running
#   stroq, the install and the pinned npx attempt and the fallback together, gets one
#   deadline (NPX_DEADLINE, 11 s), after which what is running and everything it started
#   are ended and the exit is non-zero, so a PreToolUse blocks. Each fetch is also capped
#   and not retried, so most failures come sooner.
# - npm puts the node_modules/.bin of every folder above where it runs on PATH, and the
#   installed stroq starts with `#!/usr/bin/env node`, so the scratch directory is made
#   under Stroq's own home (whose ancestors are the user's), never in a shared temp
#   directory where another user of the machine could plant a `node`.
# - npm reads the `.npmrc` of the project it finds by walking up from where it runs, and a
#   repository can carry one that names the registry the package comes from. npm and npx are
#   run from a fresh directory with a package.json of its own, and with --no-workspaces (a
#   folder above that lists it as a workspace would supply its own node_modules), and the
#   install is given a staging directory with a package.json of its own as its prefix, so
#   neither the project nor anything above the scratch directory chooses the code that
#   acts as its firewall (Stroq takes the project's directory from the hook event, not
#   from where it runs).
set -u
STROQ_PIN="@stroq/cli@0.23.0"

input="$(cat)"

# Seconds the way to a running stroq (the install, or npx, or both) may take: under the 15 s
# hook timeout, with room for Node's own start-up and for stroq's answer. A value that is not
# a plain number is the default. STROQ_PLUGIN_NPX_DEADLINE is for the tests.
case "${STROQ_PLUGIN_NPX_DEADLINE:-}" in
  '' | *[!0-9]* | ?????*) NPX_DEADLINE=11 ;;
  *) NPX_DEADLINE=$((10#$STROQ_PLUGIN_NPX_DEADLINE)) ;;
esac
# Seconds from the start by which stroq must have answered: two more than the way to it may
# take, so that even after an install that used all of its time stroq has MIN_RUN_SECONDS and
# the whole stays inside the hook timeout, with the second the watchdog gives a job to stop.
RUN_DEADLINE=$((NPX_DEADLINE + 2))
MIN_RUN_SECONDS=2
# A fallback attempt needs about this long to download; with less left, do not start one.
MIN_FALLBACK_SECONDS=3
started="$SECONDS"
# Set when npm has said the pinned version is not on the registry (yet).
pin_missing=0

work=""
scratch_failed=0
cleanup() {
  if [ -n "$work" ]; then rm -rf "$work"; fi
}
trap cleanup EXIT

# Seconds of the way-to-stroq deadline that are still there.
budget_left() {
  echo $((NPX_DEADLINE - (SECONDS - started)))
}

# Seconds stroq may take to answer: what is left of RUN_DEADLINE, and not fewer than
# MIN_RUN_SECONDS.
run_left() {
  local left=$((RUN_DEADLINE - (SECONDS - started)))
  if [ "$left" -lt "$MIN_RUN_SECONDS" ]; then left="$MIN_RUN_SECONDS"; fi
  echo "$left"
}

# Stroq's own home: where its state lives, and the directory its self-tamper gate watches.
home_dir() {
  if [ -n "${STROQ_HOME:-}" ]; then
    printf '%s' "$STROQ_HOME"
  elif [ -n "${HOME:-}" ]; then
    printf '%s' "$HOME/.stroq"
  else
    return 1
  fi
}

# The scratch directory npm and npx run from, with the event in it and a package.json of its
# own. Under Stroq's own home, not in a shared temp directory: npm puts the node_modules/.bin
# of every folder above its working directory on PATH, ahead of the user's, and the installed
# stroq starts with `#!/usr/bin/env node`. In /tmp (where mktemp puts it on Linux) any other
# user of the machine can plant a `node` there that then answers as the firewall.
make_scratch() {
  local home base
  if [ -n "$work" ]; then return 0; fi
  # Said once: the install and npx both ask.
  if [ "$scratch_failed" -eq 1 ]; then return 1; fi
  scratch_failed=1
  if ! home="$(home_dir)"; then
    echo "Stroq plugin: neither STROQ_HOME nor HOME is set, so there is nowhere private to run npx from" >&2
    return 1
  fi
  base="$home/plugin-tmp"
  # Made for its owner alone, whatever the umask: the home may not exist yet.
  (umask 077 && mkdir -p "$base") 2>/dev/null && chmod 700 "$base" 2>/dev/null
  # What an earlier hook left when it was killed before it could clean up.
  find "$base" -maxdepth 1 -name 'run.*' -mtime +1 -exec rm -rf {} + 2>/dev/null
  work="$(mktemp -d "$base/run.XXXXXX" 2>/dev/null)" || work=""
  if [ -z "$work" ]; then
    echo "Stroq plugin: could not make a scratch directory to run npx from" >&2
    return 1
  fi
  scratch_failed=0
  printf '%s' "$input" >"$work/in"
  # npm finds the project by walking up to the nearest package.json (or node_modules) and
  # reads that folder's .npmrc: an empty directory inside one that has a hostile .npmrc
  # would inherit it. A package.json of its own makes this directory the project.
  printf '{}' >"$work/package.json"
}

# Starts `"$@"` as a job of its own and ends the whole process tree after $1 seconds. Returns the
# exit status of the job, which is 143 or 137 when the deadline ended it. Job control gives the
# job its own process group, which is what the watchdog signals: npx starts node, and node
# starts stroq. What the job reads and writes is whatever the caller gave this function; its
# stdin is stated (`<&0`), because a job started from a function in a pipeline is otherwise given
# /dev/null.
start_bounded() {
  local secs="$1" pid watchdog status
  shift
  set -m
  "$@" <&0 &
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

# Becomes `"$@"` (from the second argument on), run from the scratch directory with the event on
# stdin and stderr in "$work/err", and stdout in the file $1 (`-`: the hook's own stdout). It runs
# as a job of its own (see `start_bounded`), so the `exec` replaces that job and nothing else.
in_scratch() {
  local out="$1"
  shift
  cd "$work" || exit 126
  export npm_config_fetch_retries=0 npm_config_fetch_timeout=6000
  if [ "$out" = "-" ]; then
    exec "$@" <"$work/in" 2>"$work/err"
  else
    exec "$@" <"$work/in" >"$out" 2>"$work/err"
  fi
}

# Runs `"$@"` (from the third argument on) from the scratch directory, with the event on
# stdin, stdout in the file $2 (`-`: the hook's own stdout) and stderr in "$work/err", and
# ends the whole process tree after $1 seconds.
run_bounded() {
  local secs="$1"
  shift
  start_bounded "$secs" in_scratch "$@"
}

# Runs stroq with the hook's own stdin, stdout and stderr, under the run deadline (see the
# header): a stroq that hangs is ended, and the status says so.
run_stroq_bounded() {
  start_bounded "$(run_left)" "$@"
}

# Where the copy of the pinned version is, and the file that starts it.
copy_dir() {
  local home
  home="$(home_dir)" || return 1
  printf '%s' "$home/plugin-cli/${STROQ_PIN##*@}"
}
copy_entry() {
  printf '%s' "$1/node_modules/@stroq/cli/dist/index.js"
}

# Installs the pinned version into $1, within what is left of the deadline. The package goes
# into a staging directory that has a package.json of its own, as its prefix: npm reads the
# project's `.npmrc` from there and not from a folder above that names another registry;
# --no-workspaces: a folder above that lists the scratch directory as a workspace would
# supply its own node_modules; --ignore-scripts: nothing the package or what it depends on
# says is run. What npm prints on success is not the hook's answer, so it goes nowhere.
# The tree is checked against the pin and then moved into place in one step, so what is at
# $1 is whole or is not there; a hook that got there first wins, and the copy of the one
# that did not is dropped.
install_pinned() {
  local dir="$1" version="${STROQ_PIN##*@}" stage left status got parent
  left="$(budget_left)"
  if [ "$left" -lt 1 ]; then return 1; fi
  make_scratch || return 1
  stage="$work/stage"
  mkdir "$stage" 2>/dev/null && printf '{}' >"$stage/package.json" || return 1
  # No --prefer-offline: npm then answers ETARGET from a packument it cached before the pin was
  # published, without asking the registry, and "the pin is not there" would be said of a pin that is.
  run_bounded "$left" /dev/null npm install --prefix "$stage" --ignore-scripts --no-audit \
    --no-fund --no-workspaces --loglevel=error "$STROQ_PIN"
  status=$?
  if [ "$status" -ne 0 ]; then
    cat "$work/err" >&2
    if [ "$status" -eq 143 ] || [ "$status" -eq 137 ]; then
      echo "Stroq plugin: the install did not finish in $left seconds" >&2
    fi
    # npm has just said the pin is not there: npx would say it again.
    if grep -qE 'ETARGET|No matching version' "$work/err"; then pin_missing=1; fi
    return "$status"
  fi
  got="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version))' "$stage/node_modules/@stroq/cli/package.json" 2>/dev/null)"
  if [ "$got" != "$version" ] || [ ! -f "$(copy_entry "$stage")" ]; then
    # What the package.json says is the registry's to say: a few plain characters of it.
    echo "Stroq plugin: npm installed @stroq/cli $(printf '%s' "${got:-nothing}" | tr -cd 'A-Za-z0-9._+-' | cut -c1-32), not $version; not using it" >&2
    return 1
  fi
  parent="${dir%/*}"
  # Where the copies are kept is a directory of Stroq's own: a link there would take the copy,
  # and the mode set below, wherever it points.
  if [ -L "$parent" ]; then
    echo "Stroq plugin: $parent is a link; not installing into it" >&2
    return 1
  fi
  (umask 077 && mkdir -p "$parent") 2>/dev/null && chmod 700 "$parent" 2>/dev/null
  # A copy arrives by one rename, whole, so what stands at $dir without a way to start it (a
  # link, an empty directory) is not a copy that was cut short but something else; left there
  # it would keep the pinned version from ever being used. It is renamed out of the way, into
  # the scratch directory, and not deleted: a hook that saw the same thing and was quicker may
  # have put a whole copy there since.
  if [ -L "$dir" ] || { [ -e "$dir" ] && [ ! -f "$(copy_entry "$dir")" ]; }; then
    mv "$dir" "$work/husk" 2>/dev/null
  fi
  if [ ! -e "$dir" ] && ! mv "$stage" "$dir" 2>/dev/null; then
    echo "Stroq plugin: could not move the copy into $dir" >&2
    return 1
  fi
  # `mv` onto a directory that appeared since the check puts the tree inside it.
  if [ ! -e "$stage" ] && [ ! -L "$dir" ] && [ -d "$dir/stage" ]; then rm -rf "$dir/stage"; fi
  # The copies of earlier versions, once they are more than a day old: nothing that started
  # before the update can need them by then.
  find "$parent" -mindepth 1 -maxdepth 1 ! -name "$version" -mmin +1440 -exec rm -rf {} + 2>/dev/null
  [ -f "$(copy_entry "$dir")" ]
}

# Runs `npx -y <package> hook claude-code` from the scratch directory and ends it after $2
# seconds (see `run_bounded`).
npx_once() {
  # --no-workspaces: a folder above that lists this one as a workspace makes npm run
  # the package it finds in THAT folder's node_modules, and a `stroq` planted there
  # would answer as the firewall.
  run_bounded "$2" - npx --no-workspaces -y "$1" hook claude-code
}

run_npx() {
  local code left package="$STROQ_PIN"
  left="$(budget_left)"
  if [ "$left" -lt 1 ]; then
    echo "Stroq plugin: no time left to run npx" >&2
    return 1
  fi
  make_scratch || return 1
  if [ "$pin_missing" -eq 1 ]; then package="@stroq/cli@latest"; fi
  npx_once "$package" "$left"
  code=$?
  cat "$work/err" >&2
  # The pinned version is not on npm (yet): only then run the newest release, and only
  # if the first attempt left enough of the deadline for it.
  if [ "$code" -ne 0 ] && [ "$package" = "$STROQ_PIN" ] && grep -qE 'ETARGET|No matching version' "$work/err"; then
    left="$(budget_left)"
    if [ "$left" -ge "$MIN_FALLBACK_SECONDS" ]; then
      npx_once "@stroq/cli@latest" "$left"
      code=$?
      cat "$work/err" >&2
    fi
  fi
  return "$code"
}

run_stroq() {
  local dir entry status
  if command -v stroq >/dev/null 2>&1; then
    printf '%s' "$input" | run_stroq_bounded stroq hook claude-code
    return
  fi
  if [ "${STROQ_PLUGIN_NO_LOCAL_COPY:-}" != "1" ] && command -v node >/dev/null 2>&1 &&
    dir="$(copy_dir)"; then
    entry="$(copy_entry "$dir")"
    if [ ! -f "$entry" ] && command -v npm >/dev/null 2>&1; then
      # A failed install is not the end: npx is next.
      install_pinned "$dir" || true
    fi
    if [ -f "$entry" ]; then
      # From the copy's own directory, not the project's: Stroq takes the project from the event,
      # and a node version manager that picks the node by directory (asdf, nodenv, volta) must
      # not pick it by the project's.
      printf '%s' "$input" | (cd "$dir" && run_stroq_bounded node "$entry" hook claude-code)
      status=$?
      # Killed by the deadline, a copy is slow, not broken: only a failure of its own is advice
      # to start again.
      if [ "$status" -ne 0 ] && [ "$status" -ne 143 ] && [ "$status" -ne 137 ]; then
        echo "Stroq plugin: stroq on the copy at $dir failed; delete it to install again" >&2
      fi
      return "$status"
    fi
  fi
  if command -v npx >/dev/null 2>&1; then
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
