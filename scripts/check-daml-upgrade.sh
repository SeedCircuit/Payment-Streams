#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE_REF="${CANTON_STREAMS_UPGRADE_BASELINE_REF:-ede975bf5f9114d7bb3d79e0ebb421a9c6f021de}"
BASELINE_ROOT="$(mktemp -d)"
trap 'rm -rf "$BASELINE_ROOT"' EXIT

if command -v dpm >/dev/null 2>&1; then
  DAML=(dpm)
elif command -v daml >/dev/null 2>&1; then
  DAML=(daml)
else
  echo "DPM or the Daml SDK is required" >&2
  exit 127
fi

(cd "$ROOT/packages/daml/main" && "${DAML[@]}" build)
mkdir -p "$BASELINE_ROOT/packages/daml"
git -C "$ROOT" archive "$BASELINE_REF" packages/daml/main | tar -x -C "$BASELINE_ROOT"
cp -R "$ROOT/packages/daml/interfaces" "$BASELINE_ROOT/packages/daml/interfaces"
cp -R "$ROOT/packages/daml/main/.lib" "$BASELINE_ROOT/packages/daml/main/.lib"
(cd "$BASELINE_ROOT/packages/daml/main" && "${DAML[@]}" build)
"${DAML[@]}" upgrade-check --both \
  "$BASELINE_ROOT/packages/daml/main/.daml/dist/canton-streams-1.3.0.dar" \
  "$ROOT/packages/daml/main/.daml/dist/canton-streams-1.4.0.dar"
