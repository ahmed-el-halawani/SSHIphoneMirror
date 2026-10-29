const { app, BrowserWindow, WebContentsView, ipcMain, dialog, protocol, net, safeStorage, session, Menu, screen, clipboard, Tray } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validateProfile, validateUdid, resultJSON, viewerURL, viewerBounds } = require('./core.cjs');
const connections = require('./connections.cjs');
const remote = require('./remote.cjs');
const real = require('./real-device.cjs');
const { reserveViewer } = require('./automation/viewer-reservation.cjs');
const { execute } = require('./automation/command-executor.cjs');
const { ensureSimulatorRuntime } = require('./automation/simulator-runtime.cjs');
const clientSetup = require('./mcp/client-setup.cjs');
const profiles = require('./automation/connection-profiles.cjs');
const { serveDesktop } = require('./automation/desktop-viewer.cjs');
let tray, quitting = false, traySuspended = false, closingView = null, agentTarget = null, closeDesktop;
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => { if (window) restoreWindow(); });
let readOnlyViewer = process.env.IPHONE_MIRROR_VIEWER_READ_ONLY === '1';
let releaseViewer;
let viewerDeviceId='',modeTask=null,noticeOpen=false;
const realInputs=new Set();

protocol.registerSchemesAsPrivileged([{ scheme: 'mirror', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let window, viewer, active, busy = false, storeWritable = true;
let panelOpen = false;
let realSession = null;
let pendingStart=null;
async function closeReal() {
  const current=realSession;realSession=null;
  if(!current)return;
  current.tunnel.close();current.conn.close();
}
let store = { profiles: [] };
const storePath = () => path.join(app.getPath('userData'), 'connections.json');
function save() {
  if (!storeWritable) throw Error('Restore the unreadable connections.json file before saving a connection.');
  const temporary = storePath() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, storePath());
}
function publicProfile(p) { const { encryptedPassword, fingerprint, ...safe } = p; return safe; }
function log(message) {
  if (window && !window.isDestroyed()) window.webContents.send('mirror:progress', String(message).slice(-4000));
}
function savedFor(p) {
  return store.profiles.find(x => p.kind === 'mcp' ? x.kind === 'mcp' && x.hostId === p.hostId :
    x.kind === 'manual' && x.host === p.host && x.username === p.username && x.port === p.port && x.keyPath === p.keyPath);
}
async function runner() {
  if (!active) throw Error('Connect to a Mac first.');
  if (active.automation) return profiles.connectHost(profiles.loadConfig(), active.hostId);
  return connections.connect(active.profile, active.password, async fingerprint => {
    const previous = savedFor(active.profile);
    if (previous?.fingerprint) {
      if (previous.fingerprint !== fingerprint) throw Error('The Mac SSH fingerprint changed. Verify its identity before creating a new connection.');
      return true;
    }
    const result = await dialog.showMessageBox(window, {
      type: 'warning', title: 'Verify this Mac', buttons: ['Cancel', 'Trust this Mac'], defaultId: 0, cancelId: 0,
      message: `First connection to ${active.profile.host}:${active.profile.port}`,
      detail: `Compare this SSH fingerprint with one read directly from your Mac before trusting it.\n\n${fingerprint}\n\nOnly continue if they match.`
    });
    if (result.response !== 1) return false;
    active.fingerprint = fingerprint;
    return true;
  }, log);
}
async function usingRunner(fn) { const conn = await runner(); try { return await fn(conn); } finally { conn.close(); } }
async function hideViewer() {
  viewerDeviceId='';
  if (viewer) { if(window)window.contentView.removeChildView(viewer); if(!viewer.webContents.isDestroyed())viewer.webContents.close(); viewer = null; }
  await Promise.allSettled([...realInputs]);
  const release=releaseViewer;
  if(release){await release();if(releaseViewer===release)releaseViewer=null;}
}
function applyViewerMode(next) {
  if(!viewer)return Promise.resolve();
  const page=viewer.webContents,token=require('node:crypto').randomUUID();
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);ipcMain.removeListener('mirror:viewer-mode-applied',applied);page.removeListener('destroyed',closed);error?reject(error):resolve();};
    const applied=(event,value)=>{if(event.sender===page&&value===token)finish();};
    const closed=()=>finish(Error('Viewer closed while changing control mode.'));
    const timer=setTimeout(()=>finish(Error('Viewer did not confirm its input mode. Reconnect before using agent control.')),5000);
    ipcMain.on('mirror:viewer-mode-applied',applied);page.once('destroyed',closed);
    try{page.send('mirror:viewer-mode',{readOnly:next,token});}catch(error){finish(error);}
  });
}
async function claimViewerControl(deviceId,existingConnection) {
  const conn=existingConnection || await runner();let owned;
  try {
    const release=await reserveViewer(conn,deviceId,async()=>{
      if(pendingStart)await pendingStart.done;
      if(viewerDeviceId===deviceId&&releaseViewer===owned)await setViewerMode(true);
    });
    owned=async()=>{await release();if(!existingConnection)conn.close();};
    return owned;
  } catch(error) {if(!existingConnection)conn.close();throw error;}
}
async function setViewerMode(next) {
  if(modeTask)return modeTask.then(()=>setViewerMode(next));
  modeTask=(async()=>{
    if(next) {
      readOnlyViewer=true;
      window?.webContents.send('mirror:viewer-mode',true);
      await applyViewerMode(true);
      await Promise.allSettled([...realInputs]);
      const release=releaseViewer;
      if(release){await release();if(releaseViewer===release)releaseViewer=null;}
    } else {
      const claimed=viewerDeviceId&&!releaseViewer?await claimViewerControl(viewerDeviceId):null;
      if(claimed)releaseViewer=claimed;
      try {await applyViewerMode(false);}
      catch(error){if(claimed){await claimed();if(releaseViewer===claimed)releaseViewer=null;}throw error;}
      readOnlyViewer=false;
      window?.webContents.send('mirror:viewer-mode',false);
    }
    store.watchAgent=next;
    try{save();}catch{log('Control mode changed, but its preference could not be saved.');}
    log(next?'Watch agent enabled: video stays visible; the agent controls the device.':'Manual control enabled: you control the device.');
    return next;
  })();
  try{return await modeTask;}finally{modeTask=null;}
}
async function realInput(input) {
  const task=real.input(realSession.base,realSession.sessionId,input);realInputs.add(task);
  try{return await task;}finally{realInputs.delete(task);}
}
function layoutViewer() {
  if (!viewer || !window) return;
  const [width, height] = window.getContentSize();
  viewer.setBounds(viewerBounds(width, height));
  viewer.setVisible(!panelOpen);
}
function openPanel(name) {
  panelOpen = true;
  if (viewer) viewer.setVisible(false);
  window.webContents.send('mirror:panel', name);
}
async function deviceControl(command) {
  if (readOnlyViewer) throw Error('This viewer is read-only.');
  if (!viewer) throw Error('Attach a device first.');
  if (!['home', 'shake'].includes(command)) throw Error('Unknown device control.');
  if(realSession) {
    if(command==='shake')throw Error('Shake is available for simulators only.');
    return realInput({type:command});
  }
  await viewer.webContents.executeJavaScript(`sendControl({type:${JSON.stringify(command)}})`);
  viewer.webContents.focus();
}
async function screenshot() {
  if (!viewer) throw Error('Attach a device first.');
  const data = realSession ? 'data:image/png;base64,'+await real.request(realSession.base,realSession.sessionId,'/screenshot') : await viewer.webContents.executeJavaScript(`(() => {
    const v=document.getElementById('screenVid');
    if(!v.videoWidth) throw Error('Video is not ready yet.');
    const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;
    c.getContext('2d').drawImage(v,0,0);return c.toDataURL('image/png');
  })()`);
  if (typeof data !== 'string' || !data.startsWith('data:image/png;base64,') || data.length > 32e6) throw Error('Invalid screenshot.');
  const result = await dialog.showSaveDialog(window, { title: 'Save device screenshot', defaultPath: 'iPhone Screenshot.png', filters: [{ name: 'PNG image', extensions: ['png'] }] });
  if (!result.canceled) { fs.writeFileSync(result.filePath, Buffer.from(data.split(',')[1], 'base64')); log('Screenshot saved.'); }
}
function zoomWindow(direction) {
  const [width, height] = window.getSize();
  const area = screen.getDisplayMatching(window.getBounds()).workAreaSize;
  const scale = direction === 'fit' ? Math.min(1, area.height / 850) : direction === 'in' ? 1.1 : 1 / 1.1;
  window.setSize(Math.max(320, Math.min(area.width, Math.round(direction === 'fit' ? 376 * scale : width * scale))),
    Math.max(600, Math.min(area.height, Math.round(direction === 'fit' ? 850 * scale : height * scale))));
}
async function showViewer(url, physical=false, signal) {
  viewer = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'persist:simulator',preload:path.join(__dirname,'viewer-preload.cjs') } });
  viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  viewer.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  viewer.webContents.session.setPermissionCheckHandler(() => false);
  const allowed = value => { try { const u = new URL(value); return u.protocol === 'mirror:' && u.host === 'viewer'; } catch { return false; } };
  viewer.webContents.on('will-navigate', (event, target) => { if (!allowed(target)) event.preventDefault(); });
  viewer.webContents.on('will-redirect', (event, target) => { if (!allowed(target)) event.preventDefault(); });
  viewer.webContents.on('console-message', details => {
    // Only our fixed status messages cross into the privileged app.
    const message = typeof details === 'object' ? details.message : '';
    if (message === 'MIRROR_STREAM_READY') log(readOnlyViewer ? 'Live video connected. This viewer is read-only.' : 'Live video connected. Click the screen to control the device.');
    if (message === 'MIRROR_STREAM_DISCONNECTED') log('Video disconnected. Reconnect if it does not recover.');
  });
  window.contentView.addChildView(viewer);
  layoutViewer();
  try {
    await new Promise((resolve,reject)=>{
      const page=viewer.webContents;
      let settled=false;
      const abort=()=>finish(Error('Connection cancelled.'));
      const ready=()=>finish();
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);page.removeListener('dom-ready',ready);error?reject(error):resolve();};
      const timer=setTimeout(()=>finish(Error('Viewer did not load in time.')),15000);
      page.once('dom-ready',ready);signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted){abort();return;}
      page.loadURL(url).catch(finish);
    });
  }
  catch { await hideViewer(); throw Error(signal?.aborted ? 'Connection cancelled.' : 'The device viewer could not load. Try Reconnect again.'); }
  viewer.webContents.focus();
  await applyViewerMode(readOnlyViewer);
  if(readOnlyViewer)log('Read-only viewer: video is connected; use the automation client for control.');
}

function handle(name, fn, exclusive = true) {
  ipcMain.handle(`mirror:${name}`, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== 'mirror://app/index.html') throw Error('Untrusted app request.');
    if (exclusive && busy) throw Error('A Mac operation is already running. Wait for it to finish.');
    if (exclusive) busy = true;
    try { return await fn(...args); }
    finally { if (exclusive) busy = false; }
  });
}

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  try { store = JSON.parse(fs.readFileSync(storePath(), 'utf8')); if (!Array.isArray(store.profiles)) throw Error('Invalid connections file'); }
  catch (e) { if (e.code !== 'ENOENT') { storeWritable = false; store = { profiles: [] }; dialog.showErrorBox('Saved connections could not be loaded', 'Your connections file could not be read. It will not be overwritten. Restore connections.json before saving new profiles.'); } }
  readOnlyViewer = readOnlyViewer || store.watchAgent === true;
  const serveResource = async request => {
    const url = new URL(request.url);
    const name = url.pathname.slice(1);
    if(url.host==='viewer' && name==='real-stream') {
      if(!realSession)return new Response('No iPhone connected',{status:409});
      try {
        const response=await fetch(realSession.stream,{signal:request.signal});
        if(!response.ok)return new Response('iPhone stream unavailable',{status:502});
        return new Response(response.body,{headers:{'Content-Type':response.headers.get('content-type')||'multipart/x-mixed-replace','Cache-Control':'no-store'}});
      } catch {return new Response('iPhone stream unavailable',{status:502});}
    }
    const allowed = url.host === 'app' ? ['index.html', 'renderer.js', 'style.css'] : url.host === 'viewer' ? ['client.html', 'client.js','real.html','real.js','real.css'] : [];
    if (!allowed.includes(name)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(__dirname, url.host === 'app' || name.startsWith('real.') ? '' : '../vendor/simbeam', name)).href);
  };
  protocol.handle('mirror', serveResource);
  session.fromPartition('persist:simulator').protocol.handle('mirror', serveResource);
  window = new BrowserWindow({ width: 376, height: 850, minWidth: 320, minHeight: 600, title: 'iPhone Mirror',
    frame: false, backgroundColor: '#191919', autoHideMenuBar: true, icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if (target !== 'mirror://app/index.html') event.preventDefault(); });
  window.on('resize', layoutViewer);
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    traySuspended = true;
    window.hide();
    closingView = (async () => {
      const pending = pendingStart;
      pending?.controller.abort();
      if (pending) await pending.done;
      try { await hideViewer(); } finally { await closeReal(); }
      window.webContents.send('mirror:agent-view', { disconnected: true });
      log('Viewer disconnected to tray. Agent automation continues.');
    })().catch(error => log(error.message)).finally(() => { closingView = null; });
  });
  window.on('closed', () => { window = null; });
  tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));
  tray.setToolTip('iPhone Mirror — agent automation continues in the tray');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show iPhone Mirror', click: () => restoreWindow() },
    { type: 'separator' },
    { label: 'Quit iPhone Mirror', click: () => app.quit() }
  ]));
  tray.on('double-click', () => restoreWindow());

  handle('profiles', () => store.profiles.map(publicProfile), false);
  const automationFile=()=>process.env.IPHONE_MIRROR_CONFIG || path.join(require('node:os').homedir(),'.iphone-mirror','automation.json');
  const mcpLaunch=()=>clientSetup.launch(app.getAppPath(),process.execPath,automationFile());
  handle('mcp-info',()=>{
    const config=require('./automation/connection-profiles.cjs').loadConfig(automationFile());
    const profiles=store.profiles.filter(p=>p.kind==='mcp' || p.keyPath&&p.fingerprint).map(p=>({id:clientSetup.profileId(p),name:p.name,control:config.hosts.some(h=>clientSetup.profileId(h)===clientSetup.profileId(p)&&h.control)}));
    const server=mcpLaunch();
    return {profiles,selected:active?clientSetup.profileId(active.profile):profiles[0]?.id,files:clientSetup.locations(),snippets:Object.fromEntries(['claude','codex','opencode'].map(client=>[client,clientSetup.snippet(client,server)]))};
  },false);
  function prepareMcp(input) {
    if(!input || !['claude','codex','opencode'].includes(input.client) || typeof input.control!=='boolean')throw Error('Invalid MCP setup request.');
    const profile=store.profiles.find(p=>clientSetup.profileId(p)===input.profileId);
    if(!profile)throw Error('Connect to a Mac with SSH Resource Manager or a verified SSH key first.');
    clientSetup.enroll(profile,input.control,automationFile());
    return mcpLaunch();
  }
  handle('mcp-add',input=>{
    const server=prepareMcp(input);
    return clientSetup.installClient(input.client,server);
  });
  handle('mcp-copy',input=>{
    const server=prepareMcp(input);
    clipboard.writeText(clientSetup.snippet(input.client,server));
    return {copied:true};
  });
  ipcMain.handle('mirror:real-input',async(event,input)=>{
    if(readOnlyViewer)throw Error('This viewer is read-only.');
    if(!viewer || event.sender!==viewer.webContents || event.senderFrame?.url!=='mirror://viewer/real.html' || !realSession)throw Error('No authorized iPhone viewer.');
    return realInput(input);
  });
  ipcMain.on('mirror:read-only-attempt',async event=>{
    if(!viewer||event.sender!==viewer.webContents||!readOnlyViewer||noticeOpen)return;
    let url;try{url=new URL(event.senderFrame?.url || 'about:blank');}catch{return;}
    if(url.protocol!=='mirror:'||url.host!=='viewer'||!['/client.html','/real.html'].includes(url.pathname))return;
    noticeOpen=true;
    try {
      const result=await dialog.showMessageBox(window,{type:'info',title:'Watch agent mode',message:'You are viewing the device in read-only mode.',detail:'To tap or type yourself, open View and uncheck “Watch agent (read-only)”, or choose Switch to manual below. An agent can switch it back to view-only when it needs control.',buttons:['Keep watching','Switch to manual'],defaultId:0,cancelId:0});
      if(result.response===1)await setViewerMode(false);
    } catch(error){log(error.message);}
    finally{noticeOpen=false;}
  });
  handle('panel', visible => {
    if (typeof visible !== 'boolean') throw Error('Invalid panel state.');
    panelOpen = visible;
    if (viewer) viewer.setVisible(!visible);
  }, false);
  handle('window', command => {
    if (command === 'close') window.close();
    else if (command === 'maximize') window.isMaximized() ? window.unmaximize() : window.maximize();
    else if (command === 'minimize') window.minimize();
    else throw Error('Unknown window action.');
  }, false);
  handle('zoom', direction => {
    if (!['in', 'out', 'fit'].includes(direction)) throw Error('Invalid zoom action.');
    zoomWindow(direction);
  }, false);
  handle('control', deviceControl);
  handle('watch-agent', () => setViewerMode(!readOnlyViewer));
  handle('screenshot', screenshot);
  handle('menu', (name, canShutdown) => {
    const send = action => window.webContents.send('mirror:action', action);
    const menus = {
      Edit: [{ label: 'Connection settings…', click: () => openPanel('connection') }, { label: 'Activity log', click: () => openPanel('activity') }, { type: 'separator' }, { role: 'quit' }],
      Device: [{ label: 'Attach / reconnect device', click: () => send('reconnect') }, { label: 'Refresh device list', enabled: !!active, click: () => send('refresh') }, { label: 'Shut down selected simulator', enabled: !!active && canShutdown === true, click: () => send('shutdown') }, { type: 'separator' }, { label: 'Home', enabled: !!viewer, click: () => send('home') }, { label: 'Shake', enabled: !!viewer && !realSession, click: () => send('shake') }, { type: 'separator' }, { label: 'Save screenshot…', enabled: !!viewer, click: () => send('screenshot') }, { label: 'Disconnect viewer', enabled: !!viewer, click: () => send('disconnect') }, { label: 'Stop streaming on Mac', enabled: !!active, click: () => send('stop') }],
      View: [{ label: 'Watch agent (read-only)', type: 'checkbox', checked: readOnlyViewer, enabled: !busy, click: () => send('watch-agent') }, { type: 'separator' }, { label: 'Zoom in', click: () => zoomWindow('in') }, { label: 'Zoom out', click: () => zoomWindow('out') }, { label: 'Fit window', click: () => zoomWindow('fit') }, { type: 'separator' }, { label: 'Always on top', type: 'checkbox', checked: window.isAlwaysOnTop(), click: item => window.setAlwaysOnTop(item.checked) }, { label: 'Minimize', click: () => window.minimize() }]
    };
    if (!Object.hasOwn(menus, name)) throw Error('Unknown menu.');
    Menu.buildFromTemplate(menus[name]).popup({ window });
  }, false);
  handle('import', async () => connections.listManagerHosts());
  handle('key', async () => {
    const result = await dialog.showOpenDialog(window, { title: 'Choose SSH private key', properties: ['openFile'] });
    return result.canceled ? '' : result.filePaths[0];
  });
  handle('setup', async input => {
    const profile = validateProfile(input);
    const previous = savedFor(profile);
    let password = typeof input.password === 'string' ? input.password : '';
    if (!password && previous?.encryptedPassword) {
      if (!safeStorage.isEncryptionAvailable()) throw Error('Windows credential encryption is unavailable. Enter the password again.');
      password = safeStorage.decryptString(Buffer.from(previous.encryptedPassword, 'base64'));
    }
    await hideViewer();
    await closeReal();
    active = { profile, password, fingerprint: previous?.fingerprint };
    log('Connecting over SSH and checking macOS / Xcode…');
    const info = await usingRunner(async conn => {
      let info = resultJSON(await conn.run(remote.probe));
      log(`${info.os} · ${info.arch} · ${info.xcode}`);
      log('Checking and installing missing SimBeam helpers…');
      await conn.run(remote.installScript(), 600000);
      if (!info.devices.length) {
        log('Preparing an iOS runtime and iPhone simulator. A missing runtime can require a multi-GB download…');
        await conn.run(remote.prepareRuntime, 1800000);
        info = resultJSON(await conn.run(remote.probe));
      }
      if (!info.devices.length) throw Error('No available iPhones. Connect a trusted real iPhone or create a simulator in Xcode and retry.');
      if(info.devices.some(device=>device.kind==='simulator')) {
        try {await ensureSimulatorRuntime(conn,log);}
        catch(error) {if(error.code!=='UNSUPPORTED_RUNTIME')throw error;log('Mirroring is ready. Simulator automation needs a compatible runtime for this Mac and Xcode.');}
      }
      return info;
    });
    const stored = { ...profile, ...(active.fingerprint ? { fingerprint: active.fingerprint } : {}) };
    if (profile.kind === 'manual' && input.remember && password) {
      if (!safeStorage.isEncryptionAvailable()) throw Error('Windows credential encryption is unavailable. Uncheck Remember password and retry.');
      stored.encryptedPassword = safeStorage.encryptString(password).toString('base64');
    }
    store.profiles = store.profiles.filter(x => x !== previous);
    store.profiles.push(stored); save();
    log('Mac ready. Choose a real iPhone or simulator.');
    return info;
  });
  async function startDevice(udid) {
    const controller=new AbortController();
    const pending={controller,physical:typeof udid==='string'&&udid.startsWith('real:')};
    pending.done=new Promise(resolve=>{pending.resolve=resolve;});pendingStart=pending;
    try {
    if(typeof udid==='string' && udid.startsWith('real:')) {
      const device=real.validateRealUdid(udid.slice(5));
      await hideViewer();await closeReal();
      viewerDeviceId='real:'+device;
      const conn=await runner();let tunnel;
      try {
        if(!readOnlyViewer)releaseViewer=await claimViewerControl('real:'+device,conn);
        let info;
        if(readOnlyViewer)info=resultJSON(await conn.run(real.attachScript(device),30000,controller.signal));
        else {
        log('Installing real-iPhone tools if needed…');
        await conn.run(real.install,600000,controller.signal);
        log('Signing, installing and starting WebDriverAgent. Keep the iPhone unlocked; first setup can take several minutes…');
        info=resultJSON(await conn.runSigned(real.startScript(device),720000,controller.signal));
        }
        tunnel=await conn.forward([17425,19100],controller.signal);
        if(controller.signal.aborted)throw Error('Connection cancelled.');
        realSession={...info,conn,tunnel,base:`http://127.0.0.1:${tunnel.ports[0]}`,stream:`http://127.0.0.1:${tunnel.ports[1]}`};
        await real.request(realSession.base,info.sessionId,'/window/rect');
        await showViewer('mirror://viewer/real.html',true,controller.signal);
        return {connected:true,kind:'real'};
      } catch(e) {await hideViewer();tunnel?.close();if(!readOnlyViewer)await conn.run(real.cancel,15000).catch(()=>{});conn.close();realSession=null;throw e;}
    }
    validateUdid(udid);
    await hideViewer();
    await closeReal();
    viewerDeviceId=udid;
    log('Booting the simulator and starting its stream. First boot can take a few minutes…');
    if(!readOnlyViewer)releaseViewer=await claimViewerControl(udid);
    const data = await usingRunner(async conn => resultJSON(await conn.run(remote.startScript(udid), 600000,controller.signal)));
    await showViewer(viewerURL(data.url, udid),false,controller.signal);
    return { connected: true };
    } catch(e) {await hideViewer();throw e;}
    finally {if(pendingStart===pending)pendingStart=null;pending.resolve();}
  }
  handle('start', startDevice);
  handle('cancel-start', async()=>{
    const pending=pendingStart;
    if(!pending)return;
    pending.controller.abort();await pending.done;
    await hideViewer();await closeReal();
    if(pending.physical&&!readOnlyViewer)await usingRunner(conn=>conn.run(real.cancel,15000));
    log('Connection cancelled. You can choose another device.');
  },false);
  handle('devices', () => usingRunner(async conn => resultJSON(await conn.run(remote.probe))));
  handle('shutdown', async udid => {
    if(readOnlyViewer)throw Error('This viewer is read-only.');
    validateUdid(udid);
    // Shutting down one simulator never quits Simulator.app or the other devices.
    await usingRunner(conn => execute(conn,'shutdown_simulator',{deviceId:udid}));
    log('Selected simulator shut down. Other devices remain running.');
  });
  handle('disconnect', async () => { await hideViewer(); await closeReal(); log('Viewer disconnected. Your devices remain open.'); });
  handle('stop', async () => { await hideViewer(); await closeReal(); await usingRunner(conn => conn.run(remote.stop)); log('Streaming stopped.'); });
  await window.loadURL('mirror://app/index.html');
  window.webContents.send('mirror:viewer-mode',readOnlyViewer);
  window.show();
  closeDesktop = await serveDesktop(watchAgentDevice);

  async function watchAgentDevice(request) {
    if (closingView) await closingView;
    if (request.hostId && (request.deviceId || agentTarget?.hostId !== request.hostId)) agentTarget = { ...request };
    if (traySuspended) return { hidden: true };
    if (window.isMinimized()) window.restore();
    window.show();
    if (!request.hostId) return {};
    const idleDeadline = Date.now() + 30000;
    while (busy && Date.now() < idleDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (traySuspended) return { hidden: true };
    }
    if (busy) throw Error('The desktop is changing devices. Wait for it to finish.');
    busy = true;
    try {
      const config = profiles.loadConfig();
      const host = config.hosts.find(h => h.id === request.hostId) || (config.discoverManager && (await profiles.listHosts(config)).find(h => h.hostId === request.hostId));
      if (!host) throw Error('This Mac is not enrolled in the local automation configuration.');
      if (!readOnlyViewer) await setViewerMode(true);
      let info;
      if (!active?.automation || active.hostId !== request.hostId) {
        await hideViewer(); await closeReal();
        active = { automation: true, hostId: request.hostId, profile: host };
      }
      if (request.deviceId && viewerDeviceId === request.deviceId && viewer) return {};
      if (!request.deviceId && viewer) return {};
      info = await usingRunner(async conn => resultJSON(await conn.run(remote.probe)));
      const waitingForSession = request.action === 'start_session' && request.phase === 'before';
      if (waitingForSession) { await hideViewer(); await closeReal(); log('Waiting for the agent to start the iPhone session…'); }
      window.webContents.send('mirror:agent-view', { devices: info.devices, deviceId: request.deviceId || '', connected: false, connecting: !!request.deviceId });
      if (request.deviceId && !waitingForSession && !traySuspended) {
        if (!request.deviceId.startsWith('real:')) await usingRunner(conn => conn.run(remote.installScript(), 600000));
        await startDevice(request.deviceId);
        if (traySuspended) { await hideViewer(); await closeReal(); return { hidden: true }; }
        panelOpen = false; layoutViewer();
        window.webContents.send('mirror:agent-view', { devices: info.devices, deviceId: request.deviceId, connected: true });
      }
      return {};
    } catch (error) {
      if (traySuspended) return { hidden: true };
      window.webContents.send('mirror:agent-view', { disconnected: true });
      log(error.message);
      throw error;
    } finally { busy = false; }
  }
  restoreWindow = async () => {
    traySuspended = false;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
    try { if (agentTarget) await watchAgentDevice({ ...agentTarget, phase: 'after' }); }
    catch (error) { log(error.message); }
  };
});
let restoreWindow = () => { if (window) { window.show(); window.focus(); } };
app.on('window-all-closed', () => app.quit());
app.on('before-quit',event=>{
  quitting = true;
  closeDesktop?.(); closeDesktop = null;
  if(!realSession&&!pendingStart&&!releaseViewer)return;
  event.preventDefault();
  const pending=pendingStart;pending?.controller.abort();
  (async()=>{
    if(pending){await pending.done;if(pending.physical&&!readOnlyViewer)await usingRunner(conn=>conn.run(real.cancel,15000)).catch(()=>{});}
    await hideViewer();await closeReal();
  })().catch(error=>log(error.message)).finally(()=>{releaseViewer=null;app.quit();});
});
