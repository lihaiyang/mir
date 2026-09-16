#!/usr/bin/env bash
#
# Verify a packaged macOS artifact before it is uploaded to a release.
#
# Guards failures that are invisible until runtime, and that have each shipped
# at least once:
#
#   1. Channel mix-up — package.json's `build` config carries three
#      channel-specific fields (appId / productName / artifactName). Merging
#      between the dev and stable branches without switching them produces a
#      dev build packed as `MIR.app` + `com.mir.ide`, which on update replaces
#      the user's *stable* install. Both directions are checked.
#   2. Missing exec bit — node-pty's `spawn-helper` is published on npm as 0644.
#      Without +x every `pty:create` fails with "posix_spawnp failed", i.e. no
#      terminal at all.
#
# Usage: bash scripts/verify-package.sh [releaseDir]
#
# NOTE: zip listings are written to temp files and grepped from there, never
# piped into `grep -q`. Under `set -o pipefail`, `grep -q` exits on its first
# match, the still-writing `unzip` dies of SIGPIPE, and the pipeline reports
# failure even though the pattern matched — a false negative whose occurrence
# depends on where in the listing the match happens to fall.

set -euo pipefail

REL_DIR="${1:-release}"
VERSION=$(node -p "require('./package.json').version")

case "$VERSION" in
  *-dev.*)
    CHANNEL=dev
    APP_NAME='MIR Dev.app'
    BUNDLE_ID='com.mir.ide.dev'
    ;;
  *)
    CHANNEL=stable
    APP_NAME='MIR.app'
    BUNDLE_ID='com.mir.ide'
    ;;
esac

echo "version : $VERSION"
echo "channel : $CHANNEL"
echo "expect  : ${APP_NAME} (${BUNDLE_ID})"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# --- exactly one mac zip -----------------------------------------------------
shopt -s nullglob
zips=("$REL_DIR"/*-mac.zip)
shopt -u nullglob
if [ "${#zips[@]}" -ne 1 ]; then
  echo "::error::expected exactly one *-mac.zip in $REL_DIR, found ${#zips[@]}: ${zips[*]:-none}"
  exit 1
fi
ZIP="${zips[0]}"
BASE=$(basename "$ZIP")
echo "artifact: $ZIP"

# --- artifact name matches the channel --------------------------------------
if [ "$CHANNEL" = dev ]; then
  case "$BASE" in
    MIR-Dev-*) ;;
    *) echo "::error::dev version $VERSION must produce a MIR-Dev-* artifact, got $BASE"; exit 1 ;;
  esac
else
  case "$BASE" in
    MIR-Dev-*)
      echo "::error::stable version $VERSION produced a dev-named artifact ($BASE) — build config was not switched from the dev branch"
      exit 1
      ;;
    MIR-*) ;;
    *) echo "::error::unexpected artifact name $BASE"; exit 1 ;;
  esac
fi

# --- the .app bundle inside decides which install gets replaced --------------
unzip -l "$ZIP" > "$WORK/list.txt"
if ! grep -qF " ${APP_NAME}/Contents/Info.plist" "$WORK/list.txt"; then
  echo "::error::$BASE does not contain ${APP_NAME} at its root — applying this update would replace the wrong app"
  exit 1
fi

if command -v plutil >/dev/null 2>&1; then
  unzip -p "$ZIP" "${APP_NAME}/Contents/Info.plist" > "$WORK/Info.plist"
  actual_id=$(plutil -extract CFBundleIdentifier raw -o - "$WORK/Info.plist" 2>/dev/null || echo '?')
  if [ "$actual_id" != "$BUNDLE_ID" ]; then
    echo "::error::${APP_NAME} has CFBundleIdentifier '$actual_id', expected '$BUNDLE_ID'"
    exit 1
  fi
  echo "bundle  : $APP_NAME ($actual_id)"
fi

# --- node-pty spawn-helper keeps its exec bit --------------------------------
unzip -Z "$ZIP" > "$WORK/zipinfo.txt"
grep 'node-pty.*spawn-helper' "$WORK/zipinfo.txt" > "$WORK/helpers.txt" || true
if [ ! -s "$WORK/helpers.txt" ]; then
  echo "::error::no node-pty spawn-helper found in $BASE"
  exit 1
fi
cat "$WORK/helpers.txt"
if grep -qv '^-rwx' "$WORK/helpers.txt"; then
  echo "::error::spawn-helper is not executable inside the zip — every pty:create would fail with 'posix_spawnp failed'"
  exit 1
fi

echo "✓ package verified"
