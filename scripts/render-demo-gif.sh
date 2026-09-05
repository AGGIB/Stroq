#!/usr/bin/env bash
# Assembles docs/assets/demo.gif from pre-rendered PNG frames of
# docs/assets/demo-terminal.html.
#
# This script does NOT take any screenshots itself — it only runs the ffmpeg
# palette + encode pipeline over frames that already exist on disk. Frames are
# produced by driving docs/assets/demo-terminal.html's ?step=N query parameter
# with a Playwright browser (an MCP `browser_*` tool set, or the `playwright`
# package directly), one screenshot per storyboard scene:
#
#   1. browser_resize to 960x600.
#   2. Serve docs/assets/ over local HTTP (a sandboxed Playwright browser may
#      block file:// URLs — e.g. `node -e` with node:http, or
#      `python3 -m http.server`, run from docs/assets/) and, for each step
#      N = 1..6, browser_navigate to
#      http://127.0.0.1:<port>/demo-terminal.html?step=N.
#   3. browser_take_screenshot (type png, scale "css" — NOT "device", or
#      frames come out at 2x device-pixel size and bloat the GIF) to
#      <frames-dir>/frame-0N.png (two-digit, sequential, 960x600 exactly).
#   4. browser_close once all steps are captured.
#
# Usage:
#   scripts/render-demo-gif.sh [frames-dir]
#
# <frames-dir> (default: "${TMPDIR:-/tmp}/stroq-demo-frames") must contain
# frame-01.png .. frame-NN.png. It may also contain a durations.txt ffconcat
# list controlling how long each frame holds on screen. The concat demuxer's
# per-entry "duration" directive is unreliable across ffmpeg/filter versions
# for the *last* entry in the list (it can silently double or drop that
# entry's hold time once resampled by a "fps=" filter), so durations.txt uses
# the robust alternative instead: each source frame is listed N times in a
# row, once per output tick, each tagged with the *same* fixed 1/fps duration
# — there is no "special last entry" to get wrong. For a frame held 2.5s at
# 12fps that looks like:
#
#   file 'frame-01.png'
#   duration 0.083333
#   file 'frame-01.png'
#   duration 0.083333
#   ... (30 repeats total = 2.5s * 12fps)
#
# followed by a final bare repeat of the very last file (no duration line),
# which is the standard ffmpeg concat-demuxer convention for closing out the
# list; at a uniform 1/fps duration it adds at most one negligible ~83ms tail
# frame regardless of whether that closing directive is honored.
#
# If durations.txt is missing, this script generates one from the Stroq
# demo's own storyboard timings (1.5-3s per scene, 4s on the final scene) for
# exactly 7 frames (the 0.3.0 storyboard) or exactly 6 (the 0.2.0 one), or a
# flat 2s hold per frame for any other frame count.
#
# Requires only ffmpeg (already installed) — no new packages, no network
# access, no browser automation of its own.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
frames_dir="${1:-${TMPDIR:-/tmp}/stroq-demo-frames}"
out="$root/docs/assets/demo.gif"
fps=12
tick="$(awk -v fps="$fps" 'BEGIN { printf "%.6f", 1 / fps }')"

shopt -s nullglob
frames=("$frames_dir"/frame-*.png)
shopt -u nullglob
if [ "${#frames[@]}" -eq 0 ]; then
  echo "error: no frame-*.png files found in $frames_dir" >&2
  echo "see this script's header comment for how frames are produced." >&2
  exit 1
fi

durations_file="$frames_dir/durations.txt"
if [ ! -f "$durations_file" ]; then
  echo "no durations.txt in $frames_dir - generating a default" >&2
  frame_count="${#frames[@]}"
  default_durations=()
  if [ "$frame_count" -eq 7 ]; then
    # 0.3.0 storyboard: README, warning, curl|sh denied, MCP result, npx asked,
    # secret egress denied, stroq attack summary.
    default_durations=(1.8 2.5 2.8 1.8 2.8 3 4)
  elif [ "$frame_count" -eq 6 ]; then
    default_durations=(2.5 2.5 3 2.5 1.5 4)
  else
    for ((i = 0; i < frame_count; i++)); do
      default_durations+=(2)
    done
  fi
  {
    last_name=""
    for i in "${!frames[@]}"; do
      frame_name="$(basename "${frames[$i]}")"
      last_name="$frame_name"
      repeats="$(awk -v d="${default_durations[$i]}" -v fps="$fps" 'BEGIN { printf "%d", (d * fps) + 0.5 }')"
      for ((k = 0; k < repeats; k++)); do
        printf "file '%s'\nduration %s\n" "$frame_name" "$tick"
      done
    done
    printf "file '%s'\n" "$last_name"
  } >"$durations_file"
fi

mkdir -p "$(dirname "$out")"

(
  cd "$frames_dir"
  ffmpeg -y -f concat -safe 0 -i durations.txt \
    -vf "fps=$fps,palettegen=stats_mode=diff" \
    palette.png

  ffmpeg -y -f concat -safe 0 -i durations.txt -i palette.png \
    -lavfi "fps=$fps[x];[x][1:v]paletteuse=dither=sierra2_4a" \
    -loop 0 \
    "$out"
)

echo "wrote $out"
ls -la "$out"
