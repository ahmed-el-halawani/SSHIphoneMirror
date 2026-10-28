const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const {loadCatalog,ensureSimulatorRuntime}=require('../app/automation/simulator-runtime.cjs');
test('shipped runtime archive matches its pinned catalog',()=>{
  for(const bundle of loadCatalog().bundles){const bytes=fs.readFileSync(path.join('vendor/idb',bundle.archive));assert.equal(bytes.length,bundle.archiveBytes);assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),bundle.archiveSha256);assert.equal(bundle.commit,'1387b360a9dcad34573cb1d9f277e5a0eacfd804');}
});
test('a verified installed runtime is reused without transferring an archive',async()=>{
  let calls=0;const value=await ensureSimulatorRuntime({run:async(_script,_timeout,_signal,options)=>{calls++;assert.equal(options.inputFile,undefined);return '{"ok":true,"ready":true,"bundleId":"ready"}';}});
  assert.equal(value.reused,true);assert.equal(calls,1);
});
test('unsupported platforms fail without attempting installation',async()=>{
  let calls=0;await assert.rejects(ensureSimulatorRuntime({run:async()=>{calls++;return '{"ok":false,"code":"UNSUPPORTED_RUNTIME","message":"Unsupported Mac"}';}}),error=>error.code==='UNSUPPORTED_RUNTIME');assert.equal(calls,1);
});
test('runtime extraction rejects traversal and verifies payload checksums',()=>{
  const result=spawnSync(process.platform==='win32'?'python':'python3',['tests/runtime.test.py'],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);
});
