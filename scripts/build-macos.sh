#!/usr/bin/env bash
# Builds the daemon + CLI bundles and the Tauri app for one macOS architecture.
# Usage: scripts/build-macos.sh [aarch64|x86_64]    (default: this machine's architecture)
# Separate arm64 and x86_64 builds are the MVP strategy; a Universal 2 build is a later investigation.
set -euo pipefail
cd "$(dirname "$0")/.."

arch="${1:-$(uname -m)}"
case "$arch" in
  arm64|aarch64) triple="aarch64-apple-darwin"; label="aarch64"; prep="aarch64" ;;
  x86_64)        triple="x86_64-apple-darwin";  label="x64"; prep="x86_64" ;;
  *) echo "unknown architecture: $arch" >&2; exit 2 ;;
esac

echo "==> preparing the runtime the app carries (official Node 24 + daemon + CLI + node-pty)"
node scripts/prepare-runtime.mjs "$prep"

# Tauri signs the bundle (nested binaries first, then the app, before the DMG is made) with this identity.
# "-" is an ad-hoc signature: it seals the bundle's resources and binds Info.plist, so the app verifies and
# launches on this Mac, but Gatekeeper still rejects it on any other Mac. A real Developer ID identity in
# APPLE_SIGNING_IDENTITY is used as is (then run scripts/sign-notarize.sh for the hardened runtime + notarization).
export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:--}"
if [ "$APPLE_SIGNING_IDENTITY" = "-" ]; then echo "==> signing: ad-hoc (set APPLE_SIGNING_IDENTITY for a real identity)"; fi

# a DMG build that died leaves a mounted "dmg.*" volume and an rw.*.dmg behind, and the next build fails on them
for v in /Volumes/dmg.*; do [ -d "$v" ] && hdiutil detach "$v" -force >/dev/null 2>&1 || true; done
rm -f apps/desktop/src-tauri/target/"$triple"/release/bundle/macos/rw.*.dmg

echo "==> building the app for $triple"
rustup target add "$triple" >/dev/null 2>&1 || true
# Tauri's DMG step normally asks Finder (AppleScript) to lay out the window: it mounts a disk and pops an install-like
# window on every build, and it is the step that sometimes fails. CI=true skips it (same DMG, default icon layout).
# PRETTY_DMG=1 brings the styled window back for a release build.
[ "${PRETTY_DMG:-}" = "1" ] || export CI=true
build() { (cd apps/desktop && pnpm tauri build --target "$triple" --bundles dmg,app); }
build || { echo "==> bundling failed once; cleaning up and retrying"
  for v in /Volumes/dmg.*; do [ -d "$v" ] && hdiutil detach "$v" -force >/dev/null 2>&1 || true; done
  rm -f apps/desktop/src-tauri/target/"$triple"/release/bundle/macos/rw.*.dmg
  build; }

app="apps/desktop/src-tauri/target/$triple/release/bundle/macos/AgentWatch.app"
echo "==> verifying the signature of $app"
codesign --verify --deep --strict "$app"
codesign -dv "$app" 2>&1 | grep -E "Signature|Sealed Resources|Info.plist"

out="dist"
mkdir -p "$out"
dmg="$(ls apps/desktop/src-tauri/target/"$triple"/release/bundle/dmg/*.dmg | head -n1)"
cp "$dmg" "$out/AgentWatch_0.1.0_${label}.dmg"
echo "wrote $out/AgentWatch_0.1.0_${label}.dmg"
