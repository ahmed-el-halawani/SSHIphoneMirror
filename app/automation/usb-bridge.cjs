// Experimental proof: transport one verified Windows USB iPhone to a saved Mac.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { listManagerHosts, connect } = require('../connections.cjs');
const root = path.resolve(__dirname, '../..');

function validPort(port) { return Number.isInteger(port) && port >= 49152 && port <= 65535; }
function validTarget(address) { return address === '172.20.10.1' || /^169\.254\.(?:\d{1,3})\.(?:\d{1,3})$/.test(address) && net.isIP(address) === 4; }

async function discover(udid, signal, presenceOnly = false) {
  const local = path.join(root, '.research/usb-bridge-env/Scripts/python.exe');
  const command = fs.existsSync(local) ? local : 'uv';
  const args = fs.existsSync(local) ? [] : ['run', '--script'];
  const diskRoot = root.endsWith('.asar') ? root + '.unpacked' : root;
  args.push(path.join(diskRoot, 'app/drivers/usb-phone.py'), presenceOnly ? '--check' : '--bridge-info');
  if (udid) args.push('--udid', udid);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, signal, stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    const timer = setTimeout(() => child.kill(), command === 'uv' ? 600000 : 60000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 65536) child.kill(); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const info = JSON.parse(output);
        if (presenceOnly) {
          if (code || !Array.isArray(info.devices)) throw Error(info.message || 'USB discovery failed.');
          resolve(info); return;
        }
        if (code || !validTarget(info.address)) throw Error(info.message || 'No verified USB Ethernet phone found.');
        resolve(info);
      } catch (error) { reject(error); }
    });
  });
}

async function bridge(host, info, signal, connectMac, log) {
  const conn = await connectMac();
  let channel;
  let monitor;
  let closing = false;
  let closeTimer;
  const sockets = new Map();
  const mobilePorts = new Set((info.mobile || []).map(record => record.port).filter(port => Number.isInteger(port) && port >= 1024 && port <= 65535));
  const close = () => {
    if (closing) return;
    closing = true;
    clearInterval(monitor);
    for (const socket of sockets.values()) socket.destroy();
    if (channel && !channel.destroyed) {
      // EOF lets the Mac helper remove its listeners and Bonjour record before SSH closes.
      channel.end();
      closeTimer = setTimeout(() => { channel.destroy(); conn.close(); }, 8000);
      closeTimer.unref();
    } else conn.close();
  };
  try {
    const route = await conn.run('/sbin/route -n get default', 10000, undefined, { quiet: true });
    const iface = route.match(/interface:\s*(\w+)/)?.[1];
    if (!iface) throw Error('Could not determine the Mac network interface.');
    const bind = (await conn.run('/usr/sbin/ipconfig getifaddr ' + iface, 10000, undefined, { quiet: true })).trim();
    if (net.isIP(bind) !== 4) throw Error('The Mac needs an IPv4 address for the proof bridge.');
    const source = fs.readFileSync(path.join(root, 'app/drivers/usb-mac-bridge.py')).toString('base64');
    channel = await conn.open(`/usr/bin/python3 -u -c "import base64;exec(base64.b64decode('${source}'))"`);
    const send = message => !channel.destroyed && channel.write(JSON.stringify(message) + '\n');
    send({ bind, record: info.record, mobile: info.mobile || [] });
    channel.stderr?.on('data', data => log(String(data).slice(-2000)));
    let input = '';
    channel.on('data', chunk => {
      input += chunk;
      if (input.length > 1048576) return close();
      while (input.includes('\n')) {
        const index = input.indexOf('\n');
        let message;
        try { message = JSON.parse(input.slice(0, index)); }
        catch { close(); return; }
        input = input.slice(index + 1);
        if (message.op === 'status') { log(message.message + (message.port ? ' ' + message.port : '')); continue; }
        const id = message.id;
        if (!Number.isSafeInteger(id) || id < 1) { close(); return; }
        if (message.op === 'open') {
          if ((!validPort(message.port) && !mobilePorts.has(message.port)) || sockets.has(id) || sockets.size >= 128) { send({ op: 'close', id }); continue; }
          const socket = net.connect({ host: info.address, port: message.port, allowHalfOpen: true });
          sockets.set(id, socket);
          socket.setTimeout(120000, () => socket.destroy());
          socket.on('data', data => {
            if (!send({ op: 'data', id, data: data.toString('base64') })) {
              socket.pause(); channel.once('drain', () => socket.resume());
            }
          });
          socket.on('end', () => send({ op: 'end', id }));
          socket.on('error', () => {});
          socket.on('close', () => { sockets.delete(id); send({ op: 'close', id }); });
        } else if (message.op === 'data') {
          if (typeof message.data !== 'string' || message.data.length > 90000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data)) { close(); return; }
          const socket = sockets.get(id);
          if (socket && !socket.write(Buffer.from(message.data, 'base64'))) {
            channel.pause();
            const resume = () => channel.resume();
            socket.once('drain', resume); socket.once('close', resume);
          }
        } else if (message.op === 'end') sockets.get(id)?.end();
        else if (message.op === 'close') sockets.get(id)?.destroy();
      }
    });
    const interrupted = () => close();
    signal.addEventListener('abort', interrupted, { once: true });
    if (signal.aborted) close();
    let checking = false;
    let discoveryFailures = 0;
    monitor = setInterval(async () => {
      if (checking || signal.aborted) return;
      checking = true;
      try {
        // A sleeping phone can stop advertising Bonjour while its established tunnel remains usable.
        const current = await discover(info.udid, signal, true);
        discoveryFailures = 0;
        if (!current.devices.includes(info.udid)) close();
      } catch {
        if (++discoveryFailures >= 3) close();
      }
      finally { checking = false; }
    }, 10000);
    log(`Sharing ${info.name} with ${host.name}. Refresh the Mac device list to connect.`);
    try {
      await new Promise((resolve, reject) => { channel.once('close', resolve); channel.once('error', reject); });
    } finally {
      signal.removeEventListener('abort', interrupted);
    }
  } finally { close(); clearTimeout(closeTimer); conn.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg, i) => i % 2 === 0 && !['--host', '--udid'].includes(arg)) || args.length % 2) throw Error('Usage: node scripts/usb-mac-bridge.cjs [--host HOST_ID] [--udid PHONE_UDID]');
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
  const hosts = await listManagerHosts();
  const host = options['--host'] ? hosts.find(host => host.hostId === options['--host']) : hosts.length === 1 ? hosts[0] : null;
  if (!host) throw Error('Choose a saved Mac with --host HOST_ID.');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await runUSBBridge(host, { udid: options['--udid'], signal: controller.signal }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

async function runUSBBridge(host, { udid, signal, log = console.log, connectMac = () => connect(host, '', () => false, log) }) {
  let previous;
  while (!signal.aborted) {
    try {
      const info = await discover(udid, signal);
      if (signal.aborted) break;
      await bridge(host, info, signal, connectMac, log);
      previous = undefined;
    } catch (error) {
      if (error.message !== previous) log(error.message);
      previous = error.message;
    }
    if (!signal.aborted) await new Promise(resolve => {
      const wake = () => { clearTimeout(timer); signal.removeEventListener('abort', wake); resolve(); };
      const timer = setTimeout(wake, 5000);
      signal.addEventListener('abort', wake, { once: true });
    });
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validPort, validTarget, main, runUSBBridge };
