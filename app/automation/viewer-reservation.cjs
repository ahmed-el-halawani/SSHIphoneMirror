const { randomUUID } = require('node:crypto');
const { execute } = require('./command-executor.cjs');
async function reserveViewer(conn, deviceId, onTakeover) {
  const token = randomUUID();
  await execute(conn, 'reserve_viewer', { deviceId, token, handoff: !!onTakeover });
  let closed=false;const watcher=new AbortController();
  if(onTakeover)(async()=>{
    while(!closed) {
      try {
        const state=await execute(conn,'wait_viewer',{deviceId,token,timeoutMs:30000},watcher.signal);
        if(!closed&&state.requested)await onTakeover();
      } catch(error) {
        if(closed)break;
        if(error.code==='RESERVATION_LOST')await onTakeover();
        else await new Promise(resolve=>setTimeout(resolve,1000));
      }
    }
  })().catch(()=>{});
  return async () => {closed=true;watcher.abort();await execute(conn, 'release_viewer', { deviceId, token });};
}
async function requestAgentControl(conn,deviceId,signal) {
  const timeout=AbortSignal.timeout(15000);
  const combined=signal?AbortSignal.any([signal,timeout]):timeout;
  try {
    while(!combined.aborted) {
      if((await execute(conn,'request_control',{deviceId},combined)).ready)return;
      await new Promise(resolve=>{const timer=setTimeout(done,250);function done(){clearTimeout(timer);combined.removeEventListener('abort',done);resolve();}combined.addEventListener('abort',done,{once:true});});
    }
  } catch(error) {if(!timeout.aborted)throw error;}
  throw Object.assign(Error('The viewer did not confirm Watch agent mode. No device action was sent. Reconnect or switch the viewer manually.'),{code:'DEVICE_BUSY',executed:false});
}
module.exports = { reserveViewer, requestAgentControl };
