const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { validPort, validTarget } = require('../scripts/usb-mac-bridge.cjs');
const fs = require('node:fs');
const vm = require('node:vm');

test('a failed preference save cannot enable USB sharing in memory', async () => {
  const source=fs.readFileSync(path.resolve(__dirname,'../app/main.cjs'),'utf8');
  const start=source.indexOf("  handle('usb-sharing',");
  const code=source.slice(start,source.indexOf('\n  });',start)+6);
  const store={usbSharing:false};let handler,started=0;
  vm.runInNewContext(code,{store,handle:(_name,fn)=>{handler=fn},save:()=>{throw Error('Disk full')},restartUSBBridge:async()=>{started++}});
  await assert.rejects(()=>handler(true),/Disk full/);
  assert.equal(store.usbSharing,false);assert.equal(started,0);
  await assert.rejects(()=>handler('true'),/Invalid USB/);
});

test('USB bridge only forwards developer ports to a USB Ethernet endpoint', () => {
  for (const port of [49152, 65535]) assert.equal(validPort(port), true);
  for (const port of [22, 27015, 49151, 65536, '49152', NaN]) assert.equal(validPort(port), false);
  for (const target of ['172.20.10.1', '169.254.9.191']) assert.equal(validTarget(target), true);
  for (const target of ['127.0.0.1', '192.168.8.61', 'example.com', '169.254.999.1', '172.20.10.2']) assert.equal(validTarget(target), false);
});

test('a closed device stream does not terminate the Mac bridge', () => {
  const code = `import asyncio,runpy
m=runpy.run_path(${JSON.stringify(path.resolve(__dirname, '../app/drivers/usb-mac-bridge.py'))})
assert m['valid_port'](49152) and not m['valid_port'](True)
class Writer:
 closed=False
 def can_write_eof(self): return True
 def is_closing(self): return False
 def write_eof(self): raise OSError('socket already disconnected')
 def close(self): self.closed=True
async def check():
 b=m['Bridge']({'bind':'127.0.0.1','record':{'port':49152}})
 w=Writer();b.streams[1]=w
 await b.dispatch({'op':'end','id':1})
 assert w.closed
 await b.dispatch({'op':'end','id':999})
 calls=[]
 class Server:
  pass
 async def start_server(handler,host,port):
  calls.append((host,port));return Server()
 original=asyncio.start_server;asyncio.start_server=start_server
 try:
  b=m['Bridge']({'bind':'127.0.0.1','record':{'port':49152},'mobile':[{'port':32498}]})
  b.send=lambda **message: None
  await b.listen(22)
  await b.listen(32497)
  await b.listen(32498)
  await b.listen(49152)
  assert calls == [('127.0.0.1',32498),('127.0.0.1',49152)]
 finally: asyncio.start_server=original
asyncio.run(check())
`;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('USB watcher selects only USB phones and checks supported iOS before preparing services', () => {
  const code = `import runpy
from types import SimpleNamespace as Device
m=runpy.run_path(${JSON.stringify(path.resolve(__dirname, '../app/drivers/usb-phone.py'))})
choose=m['choose_device']; supported=m['require_supported']
usb=lambda serial: Device(serial=serial,is_usb=True)
wifi=Device(serial='wifi',is_usb=False)
assert choose([]) is None
assert choose([wifi]) is None
assert choose([usb('a'),wifi]) == 'a'
assert choose([usb('a'),usb('a')]) == 'a'
assert choose([usb('a'),usb('b')],'b') == 'b'
assert choose([usb('b')],'a') is None
try: choose([usb('a'),usb('b')])
except ValueError: pass
else: raise AssertionError('ambiguous phone selected')
supported({'ProductType':'iPhone17,2','ProductVersion':'27.0'})
for info in [{},{'ProductType':'iPhone17,2','ProductVersion':'16.1'}, {'ProductType':'iPad16,1','ProductVersion':'27.0'}]:
 try: supported(info)
 except ValueError: pass
 else: raise AssertionError('unsupported device accepted')
`;
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
