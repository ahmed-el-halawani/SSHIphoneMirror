const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {reserveViewer,requestAgentControl}=require('../app/automation/viewer-reservation.cjs');
const {Controller}=require('../app/automation/controller.cjs');
const profiles=require('../app/automation/connection-profiles.cjs');
const deviceId='8AA89128-E540-44BB-82FD-43999DDC6838';
const payload=script=>JSON.parse(Buffer.from(script.match(/sys.argv.append\('([^']+)'\)/)[1],'base64'));

test('viewer input starts blocked, switches live, cancels gestures and explains read-only touches',async()=>{
  const ipc=new EventEmitter(),sent=[],handlers={},exposed={};let cancelled=0;
  ipc.send=(...args)=>sent.push(args);ipc.invoke=async()=>{sent.push(['real-input']);};
  vm.runInNewContext(fs.readFileSync('app/viewer-preload.cjs','utf8'),{
    require:()=>({ipcRenderer:ipc,contextBridge:{exposeInMainWorld:(name,value)=>exposed[name]=value}}),
    window:{addEventListener:(name,fn)=>handlers[name]=fn},document:{querySelectorAll:()=>[{dispatchEvent:()=>cancelled++}]},Event:class{},Error,Promise
  });
  const touch=()=>{let blocked=false;handlers.pointerdown({preventDefault(){blocked=true},stopImmediatePropagation(){}});return blocked;};
  assert.equal(touch(),true);assert.equal(sent.at(-1)[0],'mirror:read-only-attempt');
  await assert.rejects(exposed.realPhone.send({type:'tap'}),/Watch agent/);
  ipc.emit('mirror:viewer-mode',{}, {readOnly:false,token:'manual'});
  assert.equal(touch(),false);await exposed.realPhone.send({type:'tap'});assert.equal(sent.at(-1)[0],'real-input');
  ipc.emit('mirror:viewer-mode',{}, {readOnly:true,token:'watch'});
  assert.equal(touch(),true);assert.equal(cancelled,2);assert(sent.some(args=>args[0]==='mirror:viewer-mode-applied'&&args[1]==='watch'));
});

test('agent takeover waits for the viewer to disable input and acknowledge release',async()=>{
  let reserved=false,requested=false,gated=false,actions=0;
  const conn={run:async script=>{const p=payload(script);actions++;
    if(p.action==='reserve_viewer'){reserved=true;assert.equal(p.handoff,true);}
    if(p.action==='request_control'){requested=true;return JSON.stringify({ok:true,ready:!reserved});}
    if(p.action==='wait_viewer'){await new Promise(resolve=>setTimeout(resolve,10));return JSON.stringify({ok:true,requested});}
    if(p.action==='release_viewer'){assert.equal(gated,true);reserved=false;}
    return '{"ok":true}';
  }};
  let release;
  release=await reserveViewer(conn,deviceId,async()=>{gated=true;await release();});
  try{await requestAgentControl(conn,deviceId);assert.equal(gated,true);assert.equal(reserved,false);assert(actions>=4);}
  finally{await release();}
});

test('MCP only continues an action rejected before dispatch; unknown outcomes are never retried',async()=>{
  const original=profiles.connectHost;
  try {
    for(const code of ['VIEWER_HANDOFF_REQUIRED','OUTCOME_UNKNOWN','DEVICE_BUSY']) {
      const calls=[];
      profiles.connectHost=async()=>({close(){},run:async script=>{const p=payload(script);calls.push(p.action);
        if(p.action==='request_control')return '{"ok":true,"ready":true}';
        if(calls.length===1)return JSON.stringify({ok:false,executed:code==='OUTCOME_UNKNOWN'?null:false,error:{code,message:code}});
        return '{"ok":true,"executed":true,"verified":false}';
      }});
      const controller=new Controller({hosts:[{id:'mac',control:true}]});controller.readyHosts.add('mac');
      const result=await controller.call('tap',{hostId:'mac',deviceId,x:1,y:1});
      assert.equal(result.ok,code==='VIEWER_HANDOFF_REQUIRED');
      assert.deepEqual(calls,code==='VIEWER_HANDOFF_REQUIRED'?['tap','request_control','tap']:['tap']);
    }
  }finally{profiles.connectHost=original;}
});

test('a missing viewer acknowledgment never releases control or dispatches an action',async()=>{
  const abort=new AbortController(),calls=[];
  const conn={run:async script=>{calls.push(payload(script).action);return '{"ok":true,"ready":false}';}};
  const timer=setTimeout(()=>abort.abort(),20);
  try{await assert.rejects(requestAgentControl(conn,deviceId,abort.signal),e=>e.code==='DEVICE_BUSY'&&e.executed===false);assert.deepEqual(calls,['request_control']);}
  finally{clearTimeout(timer);}
});
