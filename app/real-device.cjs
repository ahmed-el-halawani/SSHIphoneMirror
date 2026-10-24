const { quote, resultJSON } = require('./core.cjs');
const fs=require('node:fs'),path=require('node:path');
const embedded=name=>fs.readFileSync(path.join(__dirname,name)).toString('base64');

function validateRealUdid(value) {
  if (!/^(?:[0-9A-F]{8}-[0-9A-F]{16}|[0-9a-f]{40})$/i.test(value || '')) throw Error('Choose a valid connected iPhone.');
  return value;
}

const install = `set -e
export PATH="$HOME/Documents/Codex/developer-tools/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v node >/dev/null || { echo 'Install Node.js 24 or newer on the Mac before real-device setup.' >&2; exit 1; }
TOOLS="$HOME/.local/share/iphone-mirror-tools"
export APPIUM_HOME="$TOOLS/extensions"
if ! node -e 'process.exit(require(process.env.HOME+"/.local/share/iphone-mirror-tools/node_modules/appium/package.json").version==="3.8.0"?0:1)' 2>/dev/null; then
  npm install --prefix "$TOOLS" --no-audit --no-fund appium@3.8.0
fi
if ! node -e 'process.exit(require(process.env.APPIUM_HOME+"/node_modules/appium-xcuitest-driver/package.json").version==="12.20.0"?0:1)' 2>/dev/null; then
  "$TOOLS/node_modules/.bin/appium" driver install xcuitest@12.20.0
fi
if ! (cd "$APPIUM_HOME" && node --input-type=module -e 'await import("appium-ios-remotexpc")') >/dev/null 2>&1; then
  npm install --prefix "$APPIUM_HOME" --no-audit --no-fund appium-ios-remotexpc@5.26.3
fi
printf %s '${embedded('patch-wda-ipv6.cjs')}' | base64 -D > "$TOOLS/patch-wda-ipv6.cjs"
node "$TOOLS/patch-wda-ipv6.cjs"`;

const cancel = `/usr/bin/python3 - <<'PY'
import pathlib,os,signal,subprocess
tools=pathlib.Path.home()/'.local/share/iphone-mirror-tools'
for name,expected in [('appium.pid','17425'),('wifi-proxy.pid','mac-wifi-proxy.cjs')]:
 try:
  pid=int((tools/name).read_text())
  cmd=subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True)
  if str(tools) in cmd and expected in cmd: os.kill(pid,signal.SIGTERM)
 except (OSError,ValueError,subprocess.CalledProcessError): pass
PY`;

function startScript(udid) {
  validateRealUdid(udid);
  return `set -e
export PATH="$HOME/Documents/Codex/developer-tools/node/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
TOOLS="$HOME/.local/share/iphone-mirror-tools"
export APPIUM_HOME="$TOOLS/extensions"
export MIRROR_DEVICE_UDID=${quote(udid)}
/usr/bin/python3 - <<'PY'
import json,os,pathlib,re,signal,subprocess,time,urllib.request,urllib.error,tempfile,ipaddress,base64
tools=pathlib.Path.home()/'.local/share/iphone-mirror-tools'
base='http://127.0.0.1:17425'
with tempfile.TemporaryDirectory() as folder:
 file=folder+'/device.json'
 subprocess.run(['xcrun','devicectl','device','info','details','--device',os.environ['MIRROR_DEVICE_UDID'],'--json-output',file,'--timeout','30'],check=True,stdout=subprocess.DEVNULL)
 device=json.load(open(file))['result']
connection=device.get('connectionProperties',{})
wifi=connection.get('transportType')=='localNetwork'
binding=connection.get('tunnelIPAddress') if wifi else '127.0.0.1'
if wifi and (not binding or not binding.lower().startswith('fd') or ipaddress.ip_address(binding).version!=6): raise SystemExit('No encrypted Wi-Fi tunnel is available. Unlock the phone and verify Xcode can connect to it over the network.')
identities=subprocess.check_output(['security','find-identity','-v','-p','codesigning'],text=True)
names=re.findall(r'[0-9A-F]{40} "(Apple Development:[^"]+)"',identities)
if not names: raise SystemExit('No valid Apple Development signing identity. Add your development account in Xcode on the Mac.')
teams=set()
for name in names:
  pem=subprocess.check_output(['security','find-certificate','-c',name,'-p'])
  subject=subprocess.check_output(['openssl','x509','-noout','-subject','-nameopt','RFC2253'],input=pem).decode()
  match=re.search(r'(?:^|,)OU=([A-Z0-9]{10})(?:,|$)',subject)
  if match: teams.add(match.group(1))
if len(teams)!=1: raise SystemExit('Cannot choose a unique development team. Configure a single valid team for automatic WDA signing on this Mac.')
team=next(iter(teams))
previous={}
try: previous=json.loads((tools/'current-session.json').read_text())
except (OSError,ValueError): pass
pidfile=tools/'appium.pid'
if pidfile.exists():
  try:
    pid=int(pidfile.read_text())
    cmd=subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True)
    if str(tools) in cmd and '17425' in cmd:
      os.kill(pid,signal.SIGTERM)
      time.sleep(1)
  except (ValueError,ProcessLookupError,subprocess.CalledProcessError): pass
log=open(tools/'appium.log','ab')
os.chmod(tools/'appium.log',0o600)
proxy_pid=tools/'wifi-proxy.pid'
if proxy_pid.exists():
 try:
  old=int(proxy_pid.read_text());cmd=subprocess.check_output(['ps','-p',str(old),'-o','command='],text=True)
  if str(tools) in cmd and 'mac-wifi-proxy.cjs' in cmd: os.kill(old,signal.SIGTERM);time.sleep(1)
 except (OSError,ValueError,subprocess.CalledProcessError): pass
if wifi:
 proxy_file=tools/'mac-wifi-proxy.cjs'
 proxy_file.write_bytes(base64.b64decode('${embedded('mac-wifi-proxy.cjs')}'))
 route=tools/'wifi-route.json';route.write_text(json.dumps({'address':binding}));os.chmod(route,0o600)
 proxy=subprocess.Popen(['node',str(proxy_file),os.environ['MIRROR_DEVICE_UDID'],str(route)],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
 proxy_pid.write_text(str(proxy.pid));os.chmod(proxy_pid,0o600)
proc=subprocess.Popen([str(tools/'node_modules/.bin/appium'),'--address','127.0.0.1','--port','17425','--log-no-colors','--log-level','info'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
pidfile.write_text(str(proc.pid))
os.chmod(pidfile,0o600)
def request(method,path,data=None,timeout=30):
  body=None if data is None else json.dumps(data).encode()
  req=urllib.request.Request(base+path,data=body,method=method,headers={'Content-Type':'application/json'})
  try:
    with urllib.request.urlopen(req,timeout=timeout) as r: result=json.load(r)
  except urllib.error.HTTPError as e:
    try: message=json.load(e).get('value',{}).get('message',str(e))
    except ValueError: message=str(e)
    raise RuntimeError(message[-6000:])
  value=result.get('value',{})
  if isinstance(value,dict) and value.get('error'): raise RuntimeError(value.get('message',value['error']))
  return value
for attempt in range(60):
  if proc.poll() is not None: raise SystemExit('Appium could not start. Check ~/.local/share/iphone-mirror-tools/appium.log on the Mac; port 17425 may be occupied.')
  try:
    request('GET','/status',timeout=2)
    break
  except (OSError,RuntimeError): time.sleep(0.5)
else: raise SystemExit('Appium did not become ready in time.')
caps={'platformName':'iOS','appium:automationName':'XCUITest','appium:udid':os.environ['MIRROR_DEVICE_UDID'],'appium:noReset':True,'appium:useNewWDA':previous.get('bindingIP')!=binding or previous.get('udid')!=os.environ['MIRROR_DEVICE_UDID'],'appium:newCommandTimeout':0,'appium:xcodeOrgId':team,'appium:xcodeSigningId':'Apple Development','appium:updatedWDABundleId':'dev.iphonemirror.wda.'+team.lower(),'appium:allowProvisioningUpdates':True,'appium:allowProvisioningDeviceRegistration':True,'appium:wdaBindingIP':binding,'appium:wdaLocalPort':18100,'appium:mjpegServerPort':19102 if wifi else 19100,'appium:wdaLaunchTimeout':180000,'appium:wdaStartupRetries':1,'appium:waitForIdleTimeout':1,'appium:showXcodeLog':True,'appium:settings[mjpegServerFramerate]':12,'appium:settings[mjpegServerScreenshotQuality]':50}
try:
  session=request('POST','/session',{'capabilities':{'alwaysMatch':caps,'firstMatch':[{}]}},timeout=600)
  sid=session['sessionId']
  rect=request('GET','/session/'+sid+'/window/rect')
  result={'sessionId':sid,'width':rect['width'],'height':rect['height'],'team':team,'udid':os.environ['MIRROR_DEVICE_UDID'],'bindingIP':binding,'transport':'Wi-Fi' if wifi else 'USB'}
  (tools/'current-session.json').write_text(json.dumps(result))
  os.chmod(tools/'current-session.json',0o600)
  print('MIRROR_JSON='+json.dumps(result))
except Exception as e: raise SystemExit(str(e))
PY`;
}

async function request(base, session, suffix, method='GET', body) {
  if(!/^[a-f0-9-]{36}$/i.test(session)) throw Error('Invalid device session.');
  const response=await fetch(`${base}/session/${session}${suffix}`,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
  const data=await response.json();
  if(!response.ok || data.value?.error)throw Error(data.value?.message || 'The iPhone command failed.');
  return data.value;
}

function validateInput(input) {
  if(!input || !['home','tap','swipe','key'].includes(input.type)) throw Error('Unsupported iPhone input.');
  const fields=input.type==='tap'?['x','y']:input.type==='swipe'?['x1','y1','x2','y2']:[];
  for(const field of fields)if(!Number.isFinite(input[field]) || input[field]<0 || input[field]>1)throw Error('Invalid touch coordinates.');
  if(input.type==='key' && (typeof input.key!=='string' || !input.key.length || input.key.length>32))throw Error('Invalid key.');
  return input;
}

async function input(base,session,command) {
  validateInput(command);
  if(command.type==='home') return request(base,session,'/execute/sync','POST',{script:'mobile: pressButton',args:[{name:'home'}]});
  if(command.type==='key') {
    const special={Backspace:'\uE003',Enter:'\uE007',Tab:'\uE004',Escape:'\uE00C',ArrowLeft:'\uE012',ArrowRight:'\uE014',ArrowUp:'\uE013',ArrowDown:'\uE015'};
    const key=special[command.key] || command.key;
    return request(base,session,'/actions','POST',{actions:[{type:'key',id:'keyboard',actions:[{type:'keyDown',value:key},{type:'keyUp',value:key}]}]});
  }
  const rect=await request(base,session,'/window/rect');
  const x=v=>Math.round(rect.x+v*(rect.width-1)), y=v=>Math.round(rect.y+v*(rect.height-1));
  const script=command.type==='tap'?'mobile: tap':'mobile: dragFromToForDuration';
  const args=command.type==='tap'?{x:x(command.x),y:y(command.y)}:{fromX:x(command.x1),fromY:y(command.y1),toX:x(command.x2),toY:y(command.y2),duration:Math.max(0.1,Math.min(2,Number(command.duration)||0.3))};
  return request(base,session,'/execute/sync','POST',{script,args:[args]});
}

module.exports={validateRealUdid,validateInput,install,startScript,request,input,cancel};
