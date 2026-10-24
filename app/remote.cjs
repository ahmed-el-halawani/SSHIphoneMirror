const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { quote, validateUdid } = require('./core.cjs');

const probe = `set -e
test "$(uname -s)" = Darwin || { echo 'This host is not a Mac.' >&2; exit 1; }
xcode-select -p | grep -q '\\.app' || { echo 'Install full Xcode on this Mac, open it once, and accept its license. Command Line Tools alone cannot run iOS Simulator.' >&2; exit 1; }
xcrun simctl list runtimes -j >/dev/null
/usr/bin/python3 - <<'PY'
import json, subprocess, platform, tempfile, pathlib
def run(*args): return subprocess.check_output(args,text=True).strip()
runtimes=json.loads(run('xcrun','simctl','list','runtimes','-j'))['runtimes']
runtimes=[r for r in runtimes if r.get('isAvailable') and r.get('identifier','').startswith('com.apple.CoreSimulator.SimRuntime.iOS')]
devices=json.loads(run('xcrun','simctl','list','devices','available','-j'))['devices']
phones=[dict(udid=d['udid'],name=d['name'],state=d['state'],runtime=runtime,kind='simulator') for runtime,ds in devices.items() for d in ds if d.get('isAvailable') and d['name'].startswith('iPhone')]
try:
  with tempfile.TemporaryDirectory(prefix='iphone-mirror-') as folder:
    file=str(pathlib.Path(folder)/'devices.json')
    subprocess.run(['xcrun','devicectl','list','devices','--json-output',file],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=30)
    physical=json.load(open(file)).get('result',{}).get('devices',[])
  for d in physical:
    h=d.get('hardwareProperties',{});p=d.get('deviceProperties',{});c=d.get('connectionProperties',{})
    if h.get('deviceType')=='iPhone' and c.get('pairingState')=='paired':
      phones.append(dict(udid=h['udid'],name=p.get('name','iPhone'),state='Connected' if c.get('tunnelState')=='connected' else 'Paired',runtime=p.get('osVersionNumber',''),kind='real',transport='USB' if c.get('transportType')=='wired' else 'Wi-Fi'))
except (OSError,ValueError,subprocess.SubprocessError): pass
print('MIRROR_JSON='+json.dumps(dict(os=run('sw_vers','-productVersion'),arch=platform.machine(),xcode=run('xcodebuild','-version').splitlines()[0],runtimes=len(runtimes),devices=phones)))
PY`;

function installScript() {
  // shortcut: installs upstream's latest helpers; pin releases before supporting multiple Xcode generations.
  return `set -e
if ! test -x "$HOME/.local/bin/simbeamd" || ! test -x "$HOME/.local/bin/simbeam-control"; then
  echo 'Installing SimBeam helpers from verified GitHub releases...'
  SIMBEAM_NO_SERVICE=1
  SIMBEAM_NO_PAIR=1
  export SIMBEAM_NO_SERVICE SIMBEAM_NO_PAIR
  (
${readFileSync(join(__dirname, '..', 'vendor', 'simbeam', 'install.sh'), 'utf8')}
  )
fi
"$HOME/.local/bin/simbeamd" version
"$HOME/.local/bin/simbeam-control" --protocol
`;
}

const prepareRuntime = `set -e
if ! xcrun simctl list runtimes -j | /usr/bin/python3 -c 'import json,sys; rs=json.load(sys.stdin)["runtimes"]; sys.exit(0 if any(r.get("isAvailable") and r.get("identifier","").startswith("com.apple.CoreSimulator.SimRuntime.iOS") for r in rs) else 1)'; then
  echo 'Downloading the iOS Simulator runtime using Xcode. This can be several GB.'
  xcodebuild -downloadPlatform iOS
fi
/usr/bin/python3 - <<'PY'
import json,subprocess
def run(*args): return subprocess.check_output(args,text=True)
rs=json.loads(run('xcrun','simctl','list','runtimes','-j'))['runtimes']
rs=[r for r in rs if r.get('isAvailable') and r.get('identifier','').startswith('com.apple.CoreSimulator.SimRuntime.iOS')]
if not rs: raise SystemExit('Xcode did not install an available iOS runtime. Open Xcode > Settings > Components on the Mac.')
r=rs[-1]
types=r.get('supportedDeviceTypes',[])
phone=next((t for t in types if t.get('productFamily')=='iPhone'),None)
if not phone: raise SystemExit('No compatible iPhone device type. Create an iPhone in Xcode > Window > Devices and Simulators.')
run('xcrun','simctl','create','iPhone Mirror',phone['identifier'],r['identifier'])
PY`;

function startScript(udid) {
  validateUdid(udid);
  return `set -e
export PATH="$HOME/.local/bin:$PATH"
UDID=${quote(udid)}
/usr/bin/python3 - "$UDID" <<'PY'
import json,subprocess,sys
ds=json.loads(subprocess.check_output(['xcrun','simctl','list','devices','available','-j'],text=True))['devices']
d=next((d for a in ds.values() for d in a if d['udid']==sys.argv[1]),None)
if not d: raise SystemExit('The selected simulator is no longer available. Check the Mac again.')
if d['state']!='Booted': subprocess.run(['xcrun','simctl','boot',sys.argv[1]],check=True)
PY
open -a Simulator
xcrun simctl bootstatus "$UDID" -b
pattern="^$HOME/.local/bin/simbeamd serve -addr 127.0.0.1:18080 -no-update-check$"
if ! pgrep -f "$pattern" >/dev/null; then
  nohup "$HOME/.local/bin/simbeamd" serve -addr 127.0.0.1:18080 -no-update-check >/tmp/iphonemirror-simbeam.log 2>&1 </dev/null &
fi
/usr/bin/python3 - <<'PY'
import json,pathlib,time,urllib.request
for attempt in range(20):
  try:
    c=json.loads((pathlib.Path.home()/'.simbeam/control.json').read_text())
    req=urllib.request.Request('http://'+c['addr']+'/pair',method='POST',headers={'Authorization':'Bearer '+c['token']})
    with urllib.request.urlopen(req,timeout=5) as response: result=json.load(response)
    print('MIRROR_JSON='+json.dumps(result))
    break
  except (OSError,ValueError):
    if attempt==19: raise SystemExit('SimBeam did not start. Check /tmp/iphonemirror-simbeam.log on the Mac.')
    time.sleep(0.5)
PY`;
}

const stop = `set -e
pattern="^$HOME/.local/bin/simbeamd serve -addr 127.0.0.1:18080 -no-update-check$"
if pgrep -f "$pattern" >/dev/null; then pkill -TERM -f "$pattern"; fi
echo 'Mirror service stopped. Simulator kept open.'`;

function shutdownScript(udid) {
  validateUdid(udid);
  return `set -e
/usr/bin/python3 - ${quote(udid)} <<'PY'
import json,subprocess,sys
devices=json.loads(subprocess.check_output(['xcrun','simctl','list','devices','available','-j'],text=True))['devices']
device=next((d for group in devices.values() for d in group if d['udid']==sys.argv[1]),None)
if not device: raise SystemExit('This simulator is no longer available. Refresh the device list.')
if device['state']!='Shutdown': subprocess.run(['xcrun','simctl','shutdown',sys.argv[1]],check=True)
print('Selected simulator shut down. Its data is preserved.')
PY`;
}

module.exports = { probe, installScript, prepareRuntime, startScript, stop, shutdownScript };
