#!/bin/bash
set -euo pipefail
test "$#" = 2 || { echo 'Usage: bash verify.sh BUILD_DIRECTORY BOOTED_SIMULATOR_UDID' >&2; exit 2; }
ROOT="$1"
DEVICE="$2"
python3 - "$ROOT" "$DEVICE" <<'PY'
import hashlib,json,pathlib,platform,re,subprocess,sys,tempfile
root=pathlib.Path(sys.argv[1]).resolve();device=sys.argv[2]
assert re.fullmatch(r'[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}',device),'Invalid Simulator UDID'
manifest=json.loads((root/'compatibility.json').read_text())
assert manifest['commit']=='1387b360a9dcad34573cb1d9f277e5a0eacfd804'
assert manifest['architecture']==platform.machine(),'Architecture changed; requalify'
assert manifest['macOS']==platform.mac_ver()[0],'macOS changed; requalify'
assert manifest['xcode']==subprocess.check_output(['xcodebuild','-version'],text=True).strip(),'Xcode changed; requalify'
binary=root/'source/Build/Products/Release/idb_companion'
assert hashlib.sha256(binary.read_bytes()).hexdigest()==(root/'SHA256SUMS').read_text().split()[0],'Binary checksum mismatch'
cli=[str(root/'venv/bin/idb'),'--companion-path',str(binary)]
tree=json.loads(subprocess.check_output(cli+['ui','describe-all','--api','ax','--client-type','xctest','--format','complete','--udid',device],timeout=30))
assert tree.get('elements') and tree.get('screen') and not tree.get('truncated'),'Incomplete accessibility'
with tempfile.TemporaryDirectory() as folder:
 file=pathlib.Path(folder)/'screen.png'
 subprocess.run(cli+['screenshot',str(file),'--udid',device],check=True,timeout=30)
 assert file.read_bytes().startswith(b'\x89PNG\r\n\x1a\n')
print(json.dumps({'ok':True,'manifest':manifest,'backend':tree['backend']}))
PY
