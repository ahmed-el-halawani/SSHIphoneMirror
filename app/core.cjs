const crypto = require('node:crypto');

function validateProfile(input) {
  if (!input || typeof input !== 'object') throw Error('Choose a Mac connection.');
  if (input.kind === 'mcp') {
    if (!/^[a-f0-9-]{36}$/i.test(input.hostId || '')) throw Error('Invalid SSH Resource Manager host.');
    return { kind: 'mcp', hostId: input.hostId, name: String(input.name || 'Mac').slice(0, 100) };
  }
  const host = String(input.host || '').trim();
  const username = String(input.username || '').trim();
  const port = Number(input.port || 22);
  if (!/^[a-z0-9][a-z0-9.:-]{0,252}$/i.test(host)) throw Error('Enter a hostname or IP address, without ssh:// or a command.');
  if (!/^[a-z_][a-z0-9_.-]{0,63}$/i.test(username)) throw Error('Enter a valid SSH username.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('SSH port must be 1–65535.');
  const keyPath = String(input.keyPath || '');
  if (keyPath.includes('\0') || keyPath.length > 4096) throw Error('Invalid private key path.');
  return { kind: 'manual', host, username, port, keyPath, name: String(input.name || `${username}@${host}`).slice(0, 100) };
}

function validateUdid(value) {
  if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value || '')) throw Error('Choose an available iPhone simulator.');
  return value;
}

function quote(value) { return "'" + String(value).replaceAll("'", "'\"'\"'") + "'"; }

function resultJSON(output) {
  const line = output.split(/\r?\n/).reverse().find(x => x.startsWith('MIRROR_JSON='));
  if (!line) throw Error('The Mac did not return a setup result. See the activity log.');
  return JSON.parse(line.slice(12));
}

function viewerURL(pairURL, udid) {
  const url = new URL(pairURL);
  if (url.origin !== 'https://app.simbeam.dev' || url.pathname !== '/') throw Error('Unexpected pairing URL.');
  const params = new URLSearchParams(url.hash.slice(1));
  if (!params.get('daemon') || !params.get('pair')) throw Error('Incomplete pairing response.');
  params.set('signal', 'wss://signal.simbeam.dev/ws');
  return `mirror://viewer/client.html?udid=${encodeURIComponent(validateUdid(udid))}#${params}`;
}

function fingerprint(key) { return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, ''); }

function viewerBounds(width, height) {
  return { x: 0, y: 90, width: Math.max(1, width), height: Math.max(1, height - 154) };
}

module.exports = { validateProfile, validateUdid, quote, resultJSON, viewerURL, fingerprint, viewerBounds };
