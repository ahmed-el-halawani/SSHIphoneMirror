const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateRealUdid,validateInput,startScript,input}=require('../app/real-device.cjs');
const session='12345678-1234-1234-1234-123456789abc';

test('CoreDevice fallback launches signed WDA only after a definite Appium discovery failure',()=>{
  const source=startScript('00008140-0000000000000001');
  const fallback=source.slice(source.indexOf('def start_session():'),source.indexOf('try:\n  session=start_session()'));
  const code=`import json,os,pathlib,tempfile,subprocess,time,urllib.request,io,copy
from unittest.mock import patch,Mock
os.environ['MIRROR_DEVICE_UDID']='00008140-0000000000000001'
with tempfile.TemporaryDirectory() as folder:
 tools=bundle=pathlib.Path(folder);native_pid=tools/'wda-native.pid';binding='fd00::1';platform_version='27.0'
 exec(${JSON.stringify(fallback)})
 for wifi,error,expected in [(True,None,1),(True,'Unknown device or simulator UDID',2),(False,'Unknown device or simulator UDID',1),(True,'connection outcome unknown',1)]:
  calls=[];caps={'appium:mjpegServerPort':19102}
  def request(*args,**kwargs):
   calls.append(copy.deepcopy(caps))
   if len(calls)==1 and error: raise RuntimeError(error)
   return {'sessionId':'ready'}
  child=Mock(pid=12345);child.poll.return_value=None
  with patch.object(subprocess,'Popen',return_value=child) as launch,patch.object(urllib.request,'urlopen',return_value=io.StringIO('{}')):
   try:
    assert start_session()=={'sessionId':'ready'}
    assert error is None or expected==2
   except RuntimeError as failure:
    assert error is not None and expected==1 and str(failure)==error
   assert len(calls)==expected
   assert launch.call_count==(1 if expected==2 else 0)
   if expected==2:
    assert launch.call_args.args[0][:2]==['xcodebuild','test-without-building']
    assert 'appium:mjpegServerPort' in calls[0] and 'appium:mjpegServerPort' not in calls[1]
    assert calls[1]['appium:webDriverAgentUrl']=='http://[fd00::1]:18100'
    assert native_pid.read_text()=='12345'
`;
  const result=require('node:child_process').spawnSync(process.platform==='win32'?'python':'python3',['-c',code],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('real setup reports a locked phone before starting Appium or installing WDA',()=>{
  const source=startScript('00008140-0000000000000001');
  const preflight=source.slice(source.indexOf('with tempfile.TemporaryDirectory()'),source.indexOf('connection=device.get'));
  const code=`import json,tempfile,subprocess,os,pathlib
from unittest.mock import patch
os.environ['MIRROR_DEVICE_UDID']='phone'
for locked in [False,True]:
 def run(argv,**kwargs):
  file=argv[argv.index('--json-output')+1]
  pathlib.Path(file).write_text(json.dumps({'result':{'passcodeRequired':locked}}))
 with patch.object(subprocess,'run',side_effect=run) as calls:
  try:
   exec(${JSON.stringify(preflight)})
   assert not locked
  except SystemExit as error:
   assert locked and 'Unlock the iPhone' in str(error)
  assert calls.call_count==(1 if locked else 2)
`;
  const result=require('node:child_process').spawnSync(process.platform==='win32'?'python':'python3',['-c',code],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('real setup retries transient read failures before preparing WDA',()=>{
  const source=startScript('00008140-0000000000000001');
  const preflight=source.slice(source.indexOf('with tempfile.TemporaryDirectory()'),source.indexOf('connection=device.get'));
  const code=`import json,tempfile,subprocess,os,pathlib,time
from unittest.mock import patch
os.environ['MIRROR_DEVICE_UDID']='phone'
attempts=[]
def run(argv,**kwargs):
 attempts.append(argv)
 if len(attempts)<=2: raise subprocess.CalledProcessError(1,argv)
 result={'passcodeRequired':False} if 'lockState' in argv else {'connectionProperties':{'transportType':'localNetwork','tunnelIPAddress':'fd00::1'}}
 pathlib.Path(argv[argv.index('--json-output')+1]).write_text(json.dumps({'result':result}))
with patch.object(subprocess,'run',side_effect=run),patch.object(time,'sleep'):
 exec(${JSON.stringify(preflight)})
assert len(attempts)==4
assert 'lockState' in attempts[2] and 'details' in attempts[3]
assert device['connectionProperties']['tunnelIPAddress']=='fd00::1'
`;
  const result=require('node:child_process').spawnSync(process.platform==='win32'?'python':'python3',['-c',code],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('bundled IPA rejects an expired profile or an unregistered iPhone before installation',()=>{
  const source=startScript('00008140-0000000000000001');
  const validation=source.slice(source.indexOf('profile=plistlib.loads'),source.indexOf('pidfile=tools/'));
  const manifest=require('../vendor/wda/manifest.json');
  const code=`import plistlib,subprocess,datetime,tempfile,pathlib,os
from unittest.mock import patch
os.environ['MIRROR_DEVICE_UDID']='phone'
with tempfile.TemporaryDirectory() as folder:
 app=bundle=pathlib.Path(folder)
 (app/'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':${JSON.stringify(manifest.bundleId)}}))
 (bundle/'WebDriverAgentRunner.xctestrun').write_bytes(plistlib.dumps({'WebDriverAgentRunner':{'EnvironmentVariables':{}}}))
 for devices,days,expected in [(['phone'],30,None),(['other'],30,'not signed for this iPhone'),(['phone'],-1,'expired')]:
  profile={'ExpirationDate':datetime.datetime.now()+datetime.timedelta(days=days),'ProvisionedDevices':devices,'TeamIdentifier':[${JSON.stringify(manifest.teamId)}]}
  with patch.object(subprocess,'check_output',return_value=plistlib.dumps(profile)):
   scope={'app':app,'bundle':bundle,'plistlib':plistlib,'subprocess':subprocess,'datetime':datetime,'os':os,'device':{'deviceProperties':{'osVersionNumber':'27.0'}},'binding':'127.0.0.1','wifi':False}
   try:
    exec(${JSON.stringify(validation)},scope)
    assert expected is None
   except SystemExit as error:
    assert expected and expected in str(error),str(error)
`;
  const result=require('node:child_process').spawnSync(process.platform==='win32'?'python':'python3',['-c',code],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('real device identifiers and input reject injection and invalid coordinates',()=>{
  assert.equal(validateRealUdid('00008140-0000000000000001'),'00008140-0000000000000001');
  assert.throws(()=>startScript('00008140-0000000000000001;whoami'));
  assert.match(startScript('00008140-0000000000000001'),/'appium:wdaBindingIP':binding/);
  assert.match(startScript('00008140-0000000000000001'),/binding\.lower\(\)\.startswith\('fd'\)/);
  for(const bad of [{type:'tap',x:-1,y:0},{type:'tap',x:NaN,y:1},{type:'swipe',x1:0,y1:0,x2:Infinity,y2:1},{type:'shell',command:'whoami'},{type:'key',key:'x'.repeat(33)}])assert.throws(()=>validateInput(bad));
});

test('touch coordinates use the current iPhone point dimensions, including screen edges',async()=>{
  const original=global.fetch,requests=[];
  global.fetch=async(url,options)=>{
    requests.push({url,body:options.body?JSON.parse(options.body):null});
    return {ok:true,json:async()=>({value:url.endsWith('/window/rect')?{x:0,y:0,width:440,height:956}:{}})};
  };
  try{
    await input('http://127.0.0.1:1',session,{type:'tap',x:1,y:1});
    assert.deepEqual(requests[1].body,{script:'mobile: tap',args:[{x:439,y:955}]});
    await input('http://127.0.0.1:1',session,{type:'swipe',x1:0,y1:1,x2:1,y2:0,duration:99});
    assert.equal(requests[3].body.args[0].duration,2);
    assert.equal(requests[3].body.args[0].fromY,955);
  }finally{global.fetch=original;}
});

test('Home and keyboard use limited Appium commands',async()=>{
  const original=global.fetch,requests=[];
  global.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return{ok:true,json:async()=>({value:{}})}};
  try{
    await input('http://127.0.0.1:1',session,{type:'home'});
    assert.equal(requests[0].body.script,'mobile: pressButton');
    await input('http://127.0.0.1:1',session,{type:'key',key:'Backspace'});
    assert.equal(requests[1].body.actions[0].actions[0].value,'\uE003');
    assert.ok(requests[1].url.endsWith('/actions'));
  }finally{global.fetch=original;}
});
