#!/bin/sh
# Build ah's window app into webview/build/ah.app, ad-hoc signed: a local build
# isn't quarantined, so Gatekeeper never checks it, and arm64 only needs some
# signature to run.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
app="$here/build/ah.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$here/Info.plist" "$app/Contents/Info.plist"
swiftc -O -module-cache-path "${TMPDIR:-/tmp}/ah-swift-cache" -swift-version 6 -o "$app/Contents/MacOS/ah-webview" "$here/main.swift"
codesign --force --sign - "$app"
echo "$app"
