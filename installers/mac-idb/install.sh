#!/bin/bash
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# Explicit invocation only. Never overwrite an existing build or upgrade a host silently.
test "${1:-}" = build || { echo 'Usage: bash install.sh build (creates a versioned build; does not activate it)' >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
(cd "$HERE" && shasum -a 256 -c SHA256SUMS)
PIN=1387b360a9dcad34573cb1d9f277e5a0eacfd804
ARCH="$(uname -m)"
test "$ARCH" = x86_64 || { echo 'This compatibility patch is qualified for Intel only. Qualify an ARM build separately.' >&2; exit 1; }
for tool in git xcodegen protoc python3 xcodebuild; do command -v "$tool" >/dev/null || { echo "Missing build prerequisite: $tool" >&2; exit 1; }; done
python3 -c 'import sys; assert sys.version_info >= (3, 10), "IDB build requires Python 3.10+"'
DEST="$HOME/.local/share/iphone-mirror/idb/$PIN"
test ! -e "$DEST" || { echo "Build directory already exists: $DEST; it has not been modified." >&2; exit 1; }
mkdir -p "$(dirname "$DEST")"
git clone https://github.com/facebook/idb.git "$DEST/source"
git -C "$DEST/source" checkout --detach "$PIN"
test "$(git -C "$DEST/source" rev-parse HEAD)" = "$PIN"
git -C "$DEST/source" apply --check "$HERE/patches/intel-xcode26.patch"
git -C "$DEST/source" apply "$HERE/patches/intel-xcode26.patch"
python3 -m venv "$DEST/venv"
"$DEST/venv/bin/python" -m pip install -r "$HERE/python-requirements.lock"
FB_IDB_VERSION=1.1.8 "$DEST/venv/bin/python" -m pip install --no-deps "$DEST/source"
(cd "$DEST/source" && ./build.sh build idb_companion)
mkdir -p "$DEST/bin"
ln -s ../source/Build/Products/Release/idb_companion "$DEST/bin/idb_companion"
shasum -a 256 "$DEST/source/Build/Products/Release/idb_companion" > "$DEST/SHA256SUMS"
"$DEST/venv/bin/python" - "$DEST" <<'PY'
import json,pathlib,platform,subprocess,sys
dest=pathlib.Path(sys.argv[1])
data={'commit':'1387b360a9dcad34573cb1d9f277e5a0eacfd804','architecture':platform.machine(),'macOS':platform.mac_ver()[0],'xcode':subprocess.check_output(['xcodebuild','-version'],text=True).strip()}
(dest/'compatibility.json').write_text(json.dumps(data,indent=2))
PY
echo "Built $DEST. Run verify.sh against this directory and a booted test Simulator."
echo 'After qualification, select this directory using the current symlink. Keep the prior target for rollback.'
