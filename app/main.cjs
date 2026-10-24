const { app, BrowserWindow, WebContentsView, ipcMain, dialog, protocol, net, safeStorage, session, Menu, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { validateProfile, validateUdid, resultJSON, viewerURL, viewerBounds } = require('./core.cjs');
const connections = require('./connections.cjs');
const remote = require('./remote.cjs');

protocol.registerSchemesAsPrivileged([{ scheme: 'mirror', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
let window, viewer, active, busy = false, storeWritable = true;
let panelOpen = false;
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
function hideViewer() { if (viewer) { window.contentView.removeChildView(viewer); viewer.webContents.close(); viewer = null; } }
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
  if (!viewer) throw Error('Attach a simulator first.');
  if (!['home', 'shake'].includes(command)) throw Error('Unknown device control.');
  await viewer.webContents.executeJavaScript(`sendControl({type:${JSON.stringify(command)}})`);
  viewer.webContents.focus();
}
async function screenshot() {
  if (!viewer) throw Error('Attach a simulator first.');
  const data = await viewer.webContents.executeJavaScript(`(() => {
    const v=document.getElementById('screenVid');
    if(!v.videoWidth) throw Error('Video is not ready yet.');
    const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;
    c.getContext('2d').drawImage(v,0,0);return c.toDataURL('image/png');
  })()`);
  if (typeof data !== 'string' || !data.startsWith('data:image/png;base64,') || data.length > 32e6) throw Error('Invalid screenshot.');
  const result = await dialog.showSaveDialog(window, { title: 'Save simulator screenshot', defaultPath: 'iPhone Screenshot.png', filters: [{ name: 'PNG image', extensions: ['png'] }] });
  if (!result.canceled) { fs.writeFileSync(result.filePath, Buffer.from(data.split(',')[1], 'base64')); log('Screenshot saved.'); }
}
function zoomWindow(direction) {
  const [width, height] = window.getSize();
  const area = screen.getDisplayMatching(window.getBounds()).workAreaSize;
  const scale = direction === 'fit' ? Math.min(1, area.height / 850) : direction === 'in' ? 1.1 : 1 / 1.1;
  window.setSize(Math.max(320, Math.min(area.width, Math.round(direction === 'fit' ? 376 * scale : width * scale))),
    Math.max(600, Math.min(area.height, Math.round(direction === 'fit' ? 850 * scale : height * scale))));
}
async function showViewer(url) {
  hideViewer();
  viewer = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'persist:simulator' } });
  viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  viewer.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  viewer.webContents.session.setPermissionCheckHandler(() => false);
  const allowed = value => { try { const u = new URL(value); return u.protocol === 'mirror:' && u.host === 'viewer'; } catch { return false; } };
  viewer.webContents.on('will-navigate', (event, target) => { if (!allowed(target)) event.preventDefault(); });
  viewer.webContents.on('will-redirect', (event, target) => { if (!allowed(target)) event.preventDefault(); });
  viewer.webContents.on('console-message', details => {
    // Only our fixed status messages cross into the privileged app.
    const message = typeof details === 'object' ? details.message : '';
    if (message === 'MIRROR_STREAM_READY') log('Live video connected. Click the screen to control the simulator.');
    if (message === 'MIRROR_STREAM_DISCONNECTED') log('Video disconnected. Reconnect if it does not recover.');
  });
  window.contentView.addChildView(viewer);
  layoutViewer();
  try { await viewer.webContents.loadURL(url); }
  catch { hideViewer(); throw Error('The simulator viewer could not load. Try Open simulator again.'); }
  viewer.webContents.focus();
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
  try { store = JSON.parse(fs.readFileSync(storePath(), 'utf8')); if (!Array.isArray(store.profiles)) throw Error('Invalid connections file'); }
  catch (e) { if (e.code !== 'ENOENT') { storeWritable = false; store = { profiles: [] }; dialog.showErrorBox('Saved connections could not be loaded', 'Your connections file could not be read. It will not be overwritten. Restore connections.json before saving new profiles.'); } }
  const serveResource = request => {
    const url = new URL(request.url);
    const name = url.pathname.slice(1);
    const allowed = url.host === 'app' ? ['index.html', 'renderer.js', 'style.css'] : url.host === 'viewer' ? ['client.html', 'client.js'] : [];
    if (!allowed.includes(name)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(__dirname, url.host === 'app' ? '' : '../vendor/simbeam', name)).href);
  };
  protocol.handle('mirror', serveResource);
  session.fromPartition('persist:simulator').protocol.handle('mirror', serveResource);
  window = new BrowserWindow({ width: 376, height: 850, minWidth: 320, minHeight: 600, title: 'iPhone Mirror',
    frame: false, backgroundColor: '#191919', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if (target !== 'mirror://app/index.html') event.preventDefault(); });
  window.on('resize', layoutViewer);
  window.on('closed', () => { if (viewer) viewer.webContents.close(); viewer = null; window = null; });

  handle('profiles', () => store.profiles.map(publicProfile), false);
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
  handle('screenshot', screenshot);
  handle('menu', name => {
    const send = action => window.webContents.send('mirror:action', action);
    const menus = {
      Edit: [{ label: 'Connection settings…', click: () => openPanel('connection') }, { label: 'Activity log', click: () => openPanel('activity') }, { type: 'separator' }, { role: 'quit' }],
      Device: [{ label: 'Attach / reconnect simulator', click: () => send('reconnect') }, { label: 'Home', enabled: !!viewer, click: () => send('home') }, { label: 'Shake', enabled: !!viewer, click: () => send('shake') }, { type: 'separator' }, { label: 'Save screenshot…', enabled: !!viewer, click: () => send('screenshot') }, { label: 'Disconnect viewer', enabled: !!viewer, click: () => send('disconnect') }, { label: 'Stop streaming on Mac', enabled: !!active, click: () => send('stop') }],
      View: [{ label: 'Zoom in', click: () => zoomWindow('in') }, { label: 'Zoom out', click: () => zoomWindow('out') }, { label: 'Fit window', click: () => zoomWindow('fit') }, { type: 'separator' }, { label: 'Always on top', type: 'checkbox', checked: window.isAlwaysOnTop(), click: item => window.setAlwaysOnTop(item.checked) }, { label: 'Minimize', click: () => window.minimize() }]
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
    hideViewer();
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
      if (!info.devices.length) throw Error('No available iPhone simulators. Create one in Xcode and retry.');
      return info;
    });
    const stored = { ...profile, ...(active.fingerprint ? { fingerprint: active.fingerprint } : {}) };
    if (profile.kind === 'manual' && input.remember && password) {
      if (!safeStorage.isEncryptionAvailable()) throw Error('Windows credential encryption is unavailable. Uncheck Remember password and retry.');
      stored.encryptedPassword = safeStorage.encryptString(password).toString('base64');
    }
    store.profiles = store.profiles.filter(x => x !== previous);
    store.profiles.push(stored); save();
    log('Mac ready. Choose a simulator or use the selected one.');
    return info;
  });
  handle('start', async udid => {
    validateUdid(udid);
    log('Booting the simulator and starting its stream. First boot can take a few minutes…');
    const data = await usingRunner(async conn => resultJSON(await conn.run(remote.startScript(udid), 600000)));
    await showViewer(viewerURL(data.url, udid));
    return { connected: true };
  });
  handle('disconnect', () => { hideViewer(); log('Viewer disconnected. The Mac service and simulator remain available.'); });
  handle('stop', async () => { hideViewer(); await usingRunner(conn => conn.run(remote.stop)); log('Mac streaming service stopped.'); });
  await window.loadURL('mirror://app/index.html');
  window.show();
});
app.on('window-all-closed', () => app.quit());
