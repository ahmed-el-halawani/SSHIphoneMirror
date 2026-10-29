const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{createRequire}=require('node:module');
const nativeRequire=createRequire(path.resolve('app/main.cjs'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('desktop switches input live and automatically yields only after the viewer gates input',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mirror-mode-')),ipc=new EventEmitter(),handlers=new Map(),events=[],windows=[],views=[],takeovers=[],dialogs=[];
  let refuseClaim=false,watch;
  ipc.handle=(name,fn)=>handlers.set(name,fn);
  class Page extends EventEmitter {
    constructor(){super();this.loads=0;this.session={setPermissionRequestHandler(){},setPermissionCheckHandler(){}};}
    setWindowOpenHandler(){} focus(){} isDestroyed(){return false;}
    send(name,value){if(name==='mirror:viewer-mode'&&value?.token){events.push('gate:'+value.readOnly);ipc.emit('mirror:viewer-mode-applied',{sender:this},value.token);}}
    async loadURL(url){this.url=url;this.loads++;setImmediate(()=>this.emit('dom-ready'));}
    close(){this.emit('destroyed');}
  }
  class Window extends EventEmitter {
    constructor(){super();this.webContents=new Page();this.contentView={addChildView(){},removeChildView(){events.push('detach')}};windows.push(this);}
    getContentSize(){return[376,850]} async loadURL(){}show(){events.push('show')}hide(){events.push('hide')}focus(){}isMinimized(){return false}isDestroyed(){return false;}
  }
  class View {constructor(){this.webContents=new Page();views.push(this);}setBounds(){}setVisible(){}}
  const app=new EventEmitter();app.getPath=()=>directory;app.whenReady=()=>Promise.resolve();app.requestSingleInstanceLock=()=>true;
  const conn={close(){},forward:async()=>({ports:[17425,19100],close(){events.push('close-view-tunnel')}}),run:async script=>{events.push('run:'+script);return 'MIRROR_JSON='+JSON.stringify(script==='start'?{url:'https://app.simbeam.dev/#daemon=d&pair=p'}:script==='attach-real'?{sessionId:'existing-session'}:{devices:[{udid:'8AA89128-E540-44BB-82FD-43999DDC6838',kind:'simulator'}]});}};
  const electron={app,Tray:class extends EventEmitter{setToolTip(){}setContextMenu(){}},BrowserWindow:Window,WebContentsView:View,ipcMain:ipc,protocol:{registerSchemesAsPrivileged(){},handle(){}},session:{fromPartition:()=>({protocol:{handle(){}}})},dialog:{showMessageBox:async(_window,options)=>{dialogs.push(options);return{response:0};}},Menu:{buildFromTemplate:items=>items},screen:{}};
  const customRequire=name=>{
    if(name==='electron')return electron;
    if(name==='./connections.cjs')return{connect:async()=>conn,listManagerHosts:async()=>{await new Promise(resolve=>setTimeout(resolve,20));return[];}};
    if(name==='./remote.cjs')return{probe:'probe',startScript:()=> 'start',installScript:()=> 'install',prepare:'prepare'};
    if(name==='./real-device.cjs')return{...nativeRequire(name),attachScript:()=> 'attach-real',request:async()=>({}),cancel:'cancel-wda'};
    if(name==='./automation/simulator-runtime.cjs')return{ensureSimulatorRuntime:async()=>{}};
    if(name==='./automation/desktop-viewer.cjs')return{serveDesktop:async fn=>{watch=fn;return()=>{};}};
    if(name==='./automation/connection-profiles.cjs')return{loadConfig:()=>({hosts:[{id:'mac',kind:'mcp',hostId:'361c730b-9d5c-43ed-9c59-d628329ca7e9'}]}),connectHost:async()=>conn};
    if(name==='./automation/viewer-reservation.cjs')return{reserveViewer:async(_conn,_id,takeover)=>{events.push('claim');if(refuseClaim)throw Error('Agent is using the device');takeovers.push(takeover);return async()=>events.push('release');}};
    return nativeRequire(name);
  };
  try {
    vm.runInNewContext(fs.readFileSync('app/main.cjs','utf8'),{require:customRequire,__dirname:path.resolve('app'),process:{...process,env:{...process.env,IPHONE_MIRROR_VIEWER_READ_ONLY:'0'}},setTimeout,clearTimeout,URL,Buffer,AbortController});
    await tick();
    const event={sender:windows[0].webContents,senderFrame:{url:'mirror://app/index.html'}};
    const call=(name,...args)=>handlers.get('mirror:'+name)(event,...args);
    await call('setup',{kind:'mcp',hostId:'361c730b-9d5c-43ed-9c59-d628329ca7e9'});
    await call('start','8AA89128-E540-44BB-82FD-43999DDC6838');
    assert.equal(views.length,1);assert.equal(views[0].webContents.loads,1);
    events.length=0;await call('watch-agent');assert.deepEqual(events,['gate:true','release']);
    ipc.emit('mirror:read-only-attempt',{sender:views[0].webContents,senderFrame:{url:views[0].webContents.url}});await tick();
    assert.equal(dialogs.length,1);assert.match(dialogs[0].detail,/View/);
    events.length=0;await call('watch-agent');assert.deepEqual(events,['claim','gate:false']);
    events.length=0;await takeovers.at(-1)();assert.deepEqual(events,['gate:true','release']);
    assert.equal(dialogs.length,1,'automatic takeover must not ask for approval');
    assert.equal(views.length,1);assert.equal(views[0].webContents.loads,1);assert(!events.includes('detach'));
    refuseClaim=true;events.length=0;await assert.rejects(call('watch-agent'),/Agent is using/);assert.deepEqual(events,['claim']);
    await call('disconnect');
    events.length=0;
    const importing=call('import');
    await watch({hostId:'mac',deviceId:'8AA89128-E540-44BB-82FD-43999DDC6838',action:'screenshot',phase:'before'});
    await importing;
    assert(events.includes('gate:true'));assert(!events.includes('claim'),'agent viewer must never reserve manual control');
    const realDevice={hostId:'mac',deviceId:'real:00008140-001645D80A10801C',action:'start_session'};
    events.length=0;await watch({...realDevice,phase:'before'});
    assert(!events.includes('run:attach-real'),'real viewer waits for the agent session');
    await watch({...realDevice,phase:'after'});
    assert(events.includes('run:attach-real'));assert(!events.includes('claim'));
    let prevented=false;windows[0].emit('close',{preventDefault(){prevented=true;}});await tick();
    assert(prevented);assert(events.includes('hide'));assert(events.includes('detach'));
    assert(events.includes('close-view-tunnel'));assert(!events.includes('run:cancel-wda'),'closing the viewer must not cancel WDA');
    events.length=0;
    assert.equal((await watch({hostId:'mac',deviceId:'8AA89128-E540-44BB-82FD-43999DDC6838',action:'tap',phase:'before'})).hidden,true);
    assert.deepEqual(events,[],'later MCP calls must not reopen the closed viewer');
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
