// Opt-in: exercise the production installer in a fresh, test-owned Mac directory.
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const path=require('node:path');
const app=process.env.MIRROR_TEST_APP || path.resolve(__dirname,'../app');
const {connect}=require(path.join(app,'connections.cjs'));
const {ensureSimulatorRuntime}=require(path.join(app,'automation/simulator-runtime.cjs'));
const hostId=process.env.MIRROR_TEST_HOST;assert(hostId,'Set MIRROR_TEST_HOST explicitly.');
const root='.local/share/iphone-mirror/idb-qa-'+crypto.randomUUID();
(async()=>{
  const conn=await connect({kind:'mcp',hostId},null,null,()=>{});let transfers=0,interrupt=true;
  const isolated={run:async(script,timeout,signal,options)=>{
    script=script.replace(/\.local\/share\/iphone-mirror\/idb(?!-qa-)/g,root);
    if(options?.inputFile){transfers++;if(interrupt){interrupt=false;throw Error('Injected interrupted upload');}}
    return conn.run(script,timeout,signal,options);
  }};
  const inspect=code=>conn.run(`/usr/bin/python3 - <<'PY'\nimport pathlib,json\np=pathlib.Path.home()/'${root}'\n${code}\nPY`,30000,undefined,{quiet:true});
  try{
    await assert.rejects(ensureSimulatorRuntime(isolated),/Injected interrupted upload/);
    assert.equal((await inspect("print(len(list(p.glob('.upload-*'))))")).trim(),'0');
    assert.equal((await inspect("print((p/'current').exists())")).trim(),'False');
    console.log('PASS interrupted upload cleaned; no partial runtime activated');
    const fresh=await ensureSimulatorRuntime(isolated,console.log);assert(fresh.ok);
    const count=transfers;assert((await ensureSimulatorRuntime(isolated)).reused);assert.equal(transfers,count);
    console.log('PASS fresh installation and verified reuse');
    await inspect("(p/'current'/'IDB-LICENSE').write_text('injected corruption')");
    assert((await ensureSimulatorRuntime(isolated,console.log)).ok);assert.equal(transfers,count+1);
    assert((await ensureSimulatorRuntime(isolated)).reused);
    console.log('PASS corrupted runtime repaired and verified');
  }finally{
    await inspect("import shutil\nassert p.name.startswith('idb-qa-') and p.parent == pathlib.Path.home()/'.local/share/iphone-mirror'\nshutil.rmtree(p,ignore_errors=True)");conn.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
