const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events'),{createRequire}=require('node:module');
const nativeRequire=createRequire(path.resolve('app/main.cjs'));
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('desktop switches input live and automatically yields only after the viewer gates input',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mirror-mode-')),ipc=new EventEmitter(),handlers=new Map(),events=[],windows=[],views=[],takeovers=[],dialogs=[];
  let refuseClaim=false;
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
    getContentSize(){return[376,850]} async loadURL(){}show(){}isDestroyed(){return false;}
  }
  class View {constructor(){this.webContents=new Page();views.push(this);}setBounds(){}setVisible(){}}
  const app=new EventEmitter();app.getPath=()=>directory;app.whenReady=()=>Promise.resolve();
  const conn={close(){},run:async script=>'MIRROR_JSON='+JSON.stringify(script==='start'?{url:'https://app.simbeam.dev/#daemon=d&pair=p'}:{devices:[{udid:'8AA89128-E540-44BB-82FD-43999DDC6838',kind:'simulator'}]})};
  const electron={app,BrowserWindow:Window,WebContentsView:View,ipcMain:ipc,protocol:{registerSchemesAsPrivileged(){},handle(){}},session:{fromPartition:()=>({protocol:{handle(){}}})},dialog:{showMessageBox:async(_window,options)=>{dialogs.push(options);return{response:0};}},Menu:{},screen:{}};
  const customRequire=name=>{
    if(name==='electron')return electron;
    if(name==='./connections.cjs')return{connect:async()=>conn};
    if(name==='./remote.cjs')return{probe:'probe',startScript:()=> 'start',installScript:()=> 'install',prepare:'prepare'};
    if(name==='./automation/simulator-runtime.cjs')return{ensureSimulatorRuntime:async()=>{}};
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
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
