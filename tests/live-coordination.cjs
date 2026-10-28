const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { connect } = require('../app/connections.cjs');
const { execute } = require('../app/automation/command-executor.cjs');
async function main() {
  const hostId=process.env.MIRROR_TEST_HOST,deviceId=process.env.MIRROR_TEST_DEVICE;
  assert(hostId && deviceId,'Set MIRROR_TEST_HOST and MIRROR_TEST_DEVICE explicitly.');
  const conn=await connect({kind:'mcp',hostId},undefined,undefined,()=>{});
  const token=randomUUID();
  try {
    const source=Buffer.from(fs.readFileSync('app/drivers/ios-command.py')).toString('base64');
    const payload=Buffer.from(JSON.stringify(deviceId)).toString('base64');
    await conn.run(`/usr/bin/python3 - <<'PY'\nimport base64,types,subprocess,sys\nm=types.ModuleType('driver')\nexec(compile(base64.b64decode('${source}'),'driver.py','exec'),m.__dict__)\ndevice=__import__('json').loads(base64.b64decode('${payload}'))\nwith m.device_lock(device):\n path=m.reservation_path(device).with_name(device+'.lock')\n child='import fcntl,sys; f=open(sys.argv[1],"w"); fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)'\n result=subprocess.run([sys.executable,'-c',child,str(path)],capture_output=True)\n assert result.returncode!=0 and b'BlockingIOError' in result.stderr, result.stderr\nprint('PASS: second process cannot acquire the device lock')\nPY`,30000,undefined,{quiet:true});
    console.log('PASS: cross-process Mac flock');
    await execute(conn,'reserve_viewer',{deviceId,token});
    try {
      await assert.rejects(execute(conn,'tap',{deviceId,x:1,y:1}),error=>error.code==='DEVICE_BUSY');
      const read=await execute(conn,'get_ui_tree',{deviceId});
      assert(read.tree.elements.length);
      console.log('PASS: manual viewer blocks AI actions while accessibility reads remain available');
    } finally {await execute(conn,'release_viewer',{deviceId,token});}
    const large="/usr/bin/python3 -c 'import sys;sys.stdout.write(\"x\"*6000000)'";
    const output=await conn.run(large,30000,undefined,{quiet:true,maxBytes:8*1024*1024});
    assert.equal(output.length,6000000);
    await assert.rejects(conn.run(large,30000,undefined,{quiet:true}),/size limit/);
    console.log('PASS: bounded 6 MB SSH transfer and default 4 MB rejection');
  } finally {conn.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
