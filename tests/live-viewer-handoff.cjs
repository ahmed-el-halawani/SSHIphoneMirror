// Opt-in: exercise handoff using a test-owned reservation; never sends device input.
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {connect}=require('../app/connections.cjs');
const {reserveViewer,requestAgentControl}=require('../app/automation/viewer-reservation.cjs');
const hostId=process.env.MIRROR_TEST_HOST;assert(hostId,'Set MIRROR_TEST_HOST explicitly.');
(async()=>{
  const conn=await connect({kind:'mcp',hostId},null,null,()=>{}),deviceId=randomUUID();let gated=false,release;
  try {
    release=await reserveViewer(conn,deviceId,async()=>{gated=true;await release();});
    const start=Date.now();await requestAgentControl(conn,deviceId);
    assert(gated);console.log('PASS: SSH handoff waited for input gating and owner release ('+(Date.now()-start)+' ms); no Simulator input sent.');
  }finally{if(release)await release();conn.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
