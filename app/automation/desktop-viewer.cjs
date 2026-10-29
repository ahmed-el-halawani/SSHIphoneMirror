const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const stateFile = () => path.join(os.homedir(), '.iphone-mirror', 'desktop.json');
async function serveDesktop(watch, file = stateFile()) {
  const token = randomUUID();
  const pipe = process.platform === 'win32' ? '\\\\.\\pipe\\iphone-mirror-' + token : path.join(os.tmpdir(), 'iphone-mirror-' + token + '.sock');
  let queue = Promise.resolve();
  const server = net.createServer(socket => {
    let input = '', accepted = false;
    socket.setTimeout(750000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (accepted) return;
      input += chunk;
      if (input.length > 4096) { socket.destroy(); return; }
      if (!input.includes('\n')) return;
      accepted = true;
      let request;
      try {
        request = JSON.parse(input.trim());
        if (request.token !== token || !['before', 'after'].includes(request.phase) || typeof request.action !== 'string' || request.action.length > 40 || (request.hostId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(request.hostId)) || (request.deviceId !== undefined && !/^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|real:(?:[a-f0-9]{8}-[a-f0-9]{16}|[a-f0-9]{40}))$/i.test(request.deviceId))) throw Error('Invalid desktop request.');
      } catch { socket.end(JSON.stringify({ error: 'Invalid desktop request.' }) + '\n'); return; }
      const task = queue.then(() => watch(request));
      queue = task.catch(() => {});
      task.then(result => socket.end(JSON.stringify({ ok: true, ...result }) + '\n'), error => socket.end(JSON.stringify({ error: error.message }) + '\n'));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(pipe, resolve); });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ pipe, token }), { mode: 0o600 });
  return () => {
    try { if (JSON.parse(fs.readFileSync(file)).token === token) fs.unlinkSync(file); } catch {}
    server.close();
  };
}
function requestDesktop(request, file = stateFile()) {
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const socket = net.connect(state.pipe);
    let output = '';
    socket.setTimeout(735000, () => socket.destroy(Error('Desktop viewer timed out.')));
    socket.on('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify({ ...request, token: state.token }) + '\n'));
    socket.on('data', chunk => { output += chunk; if (output.length > 8192) socket.destroy(Error('Invalid desktop response.')); });
    socket.on('end', () => {
      try { const result = JSON.parse(output); if (!result.ok) throw Error(result.error || 'Desktop request failed.'); resolve(result); }
      catch (error) { reject(error); }
    });
  });
}
function desktopViewer() {
  let startup;
  return async (action, args, phase = 'before') => {
    const request = { action, hostId: args.hostId, deviceId: args.deviceId, phase };
    try { return await requestDesktop(request); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    }
    if (!startup) startup = (async () => {
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      let executable = process.execPath;
      if (!process.versions.electron || !__dirname.includes('app.asar')) {
        const electronFolder = path.dirname(require.resolve('electron/package.json'));
        executable = path.join(electronFolder, 'dist', fs.readFileSync(path.join(electronFolder, 'path.txt'), 'utf8').trim());
      }
      const child = spawn(executable, [path.resolve(__dirname, '../..')], { env, detached: true, stdio: 'ignore', windowsHide: false });
      let launchError;
      child.on('error', error => { launchError = error; }); child.unref();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (launchError) throw launchError;
        try { await requestDesktop({ action: 'list_hosts', phase: 'before' }); return; }
        catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw Error('iPhone Mirror did not open. Start the desktop app and retry.');
    })().finally(() => { startup = null; });
    await startup;
    return requestDesktop(request);
  };
}
module.exports = { serveDesktop, requestDesktop, desktopViewer };
