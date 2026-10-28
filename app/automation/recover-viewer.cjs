const profiles = require('./connection-profiles.cjs');
const { execute } = require('./command-executor.cjs');
const { validateUdid } = require('../core.cjs');
const { validateRealUdid } = require('../real-device.cjs');
async function main() {
  const [hostId, deviceId, confirm] = process.argv.slice(2);
  if(confirm!=='--viewer-is-closed')throw Error('Close every viewer first. Usage: node app/automation/recover-viewer.cjs HOST_ID DEVICE_ID --viewer-is-closed');
  if(deviceId?.startsWith('real:'))validateRealUdid(deviceId.slice(5));else validateUdid(deviceId);
  const conn=await profiles.connectHost(profiles.loadConfig(),hostId);
  try {await execute(conn,'recover_viewer',{deviceId});}
  finally{conn.close();}
}
if(require.main===module)main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=1;});
