#!/usr/bin/env bash
set -euo pipefail
version="${1:-4.0.0}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dest="$root/rules/atr"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && npm pack "agent-threat-rules@$version" --silent >/dev/null && tar xzf "agent-threat-rules-$version.tgz")
rm -rf "$dest"
mkdir -p "$dest"
for category in prompt-injection context-exfiltration tool-poisoning agent-manipulation skill-compromise; do
  if [ -d "$tmp/package/rules/$category" ]; then
    cp -R "$tmp/package/rules/$category" "$dest/$category"
  fi
done
cp "$tmp/package/LICENSE" "$dest/LICENSE"
printf 'Imported from agent-threat-rules@%s (MIT). Do not edit by hand; rerun scripts/import-atr-rules.sh.\n' "$version" > "$dest/README.md"
echo "imported $(find "$dest" -name '*.yaml' -o -name '*.yml' | wc -l | tr -d ' ') rule files into $dest"
