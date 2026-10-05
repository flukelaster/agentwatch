#!/usr/bin/env bash
# Optional managed-install artifact: wraps the signed app in a Developer ID Installer package.
# Requires: APPLE_INSTALLER_IDENTITY="Developer ID Installer: Your Name (TEAMID)"
# Usage: scripts/build-pkg.sh path/to/AgentWatch.app aarch64|x64
set -euo pipefail
app="${1:?path to signed AgentWatch.app}"
label="${2:?aarch64 or x64}"
: "${APPLE_INSTALLER_IDENTITY:?set APPLE_INSTALLER_IDENTITY}"
mkdir -p dist
version="$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")"
productbuild --component "$app" /Applications --sign "$APPLE_INSTALLER_IDENTITY" "dist/AgentWatch_${version}_${label}.pkg"
echo "wrote dist/AgentWatch_${version}_${label}.pkg (notarize it with: xcrun notarytool submit ... --wait; xcrun stapler staple ...)"
