#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
out="$PWD/.research/CompactFixture.app"
mkdir -p "$out"
sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
arch="$(uname -m)"
xcrun swiftc -parse-as-library -O -sdk "$sdk" -target "$arch-apple-ios17.0-simulator" \
  idb-evaluation/test-fixture/Sources/TestFixtureApp.swift -o "$out/CompactFixture"
cp idb-evaluation/test-fixture/Sources/Info.plist "$out/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleIdentifier com.evaluation.CompactFixture' "$out/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleExecutable CompactFixture' "$out/Info.plist"
/usr/libexec/PlistBuddy -c 'Set :CFBundleName CompactFixture' "$out/Info.plist"
test -x "$out/CompactFixture"
plutil -lint "$out/Info.plist"
printf '%s\n' "$out"
