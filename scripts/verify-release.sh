#!/usr/bin/env bash
# Verifies a release artifact the way Gatekeeper will. Run on a clean machine or user account.
# Usage: scripts/verify-release.sh dist/AgentWatch_0.1.0_aarch64.dmg
set -euo pipefail
dmg="${1:?path to dmg}"
fail=0
check() { if "$@"; then echo "ok:   $*"; else echo "FAIL: $*" >&2; fail=1; fi; }

check codesign --verify --strict --verbose=2 "$dmg"
check xcrun stapler validate "$dmg"
check spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"

mnt="$(mktemp -d)"
hdiutil attach "$dmg" -mountpoint "$mnt" -nobrowse -quiet
trap 'hdiutil detach "$mnt" -quiet || true' EXIT
app="$(ls -d "$mnt"/*.app | head -n1)"
check codesign --verify --deep --strict --verbose=2 "$app"
check spctl --assess --type execute --verbose=2 "$app"
# nothing may be left unsigned inside the bundle
unsigned="$(find "$app" -type f -perm -111 -print0 | xargs -0 file | grep Mach-O | cut -d: -f1 | while read -r f; do codesign --verify "$f" >/dev/null 2>&1 || echo "$f"; done)"
if [ -n "$unsigned" ]; then echo "FAIL: unsigned Mach-O files:" >&2; echo "$unsigned" >&2; fail=1; else echo "ok:   every Mach-O file is signed"; fi
exit "$fail"
