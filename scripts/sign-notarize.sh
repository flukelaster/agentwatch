#!/usr/bin/env bash
# Sign nested binaries, sign the app, notarize, staple. Requires an Apple Developer account.
# Required environment (never commit these):
#   APPLE_SIGNING_IDENTITY   e.g. "Developer ID Application: Your Name (TEAMID)"
#   APPLE_API_KEY_PATH       path to the App Store Connect API key (.p8)
#   APPLE_API_KEY_ID, APPLE_API_ISSUER
# Usage: scripts/sign-notarize.sh path/to/AgentWatch.app path/to/AgentWatch.dmg
set -euo pipefail

app="${1:?path to AgentWatch.app}"
dmg="${2:?path to AgentWatch.dmg}"
: "${APPLE_SIGNING_IDENTITY:?set APPLE_SIGNING_IDENTITY}"
: "${APPLE_API_KEY_PATH:?set APPLE_API_KEY_PATH}"
: "${APPLE_API_KEY_ID:?set APPLE_API_KEY_ID}"
: "${APPLE_API_ISSUER:?set APPLE_API_ISSUER}"

entitlements="$(mktemp)"
trap 'rm -f "$entitlements"' EXIT
# Hardened runtime with the one exception a Node sidecar needs (JIT for V8). No sandbox: see the plan.
cat > "$entitlements" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict></plist>
PLIST

echo "==> signing nested executables and native addons first"
find "$app" -type f \( -name "*.node" -o -name "*.dylib" -o -name "spawn-helper" -o -perm -111 \) ! -path "*/Contents/MacOS/agentwatch-desktop" -print0 |
  while IFS= read -r -d '' f; do
    if file "$f" | grep -q "Mach-O"; then
      codesign --force --options runtime --timestamp --entitlements "$entitlements" --sign "$APPLE_SIGNING_IDENTITY" "$f"
    fi
  done

echo "==> (the bundled Node runtime in Contents/MacOS/node is signed above, with the JIT entitlement V8 needs)"
echo "==> signing the app"
codesign --force --deep --options runtime --timestamp --entitlements "$entitlements" --sign "$APPLE_SIGNING_IDENTITY" "$app"
codesign --verify --deep --strict --verbose=2 "$app"

echo "==> signing the dmg"
codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$dmg"

echo "==> notarizing (this waits for Apple)"
xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait

echo "==> stapling"
xcrun stapler staple "$dmg"
echo "done: $dmg"
