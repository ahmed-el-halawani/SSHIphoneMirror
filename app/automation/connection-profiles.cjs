const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validateProfile } = require('../core.cjs');
const transport = require('./ssh-transport.cjs');

function loadConfig(file = process.env.IPHONE_MIRROR_CONFIG || path.join(os.homedir(), '.iphone-mirror', 'automation.json')) {
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { hosts: [] }; throw Error('Cannot read automation configuration.'); }
  if (!Array.isArray(config.hosts)) throw Error('Automation configuration requires hosts.');
  const ids = new Set();
  config.hosts = config.hosts.map(host => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(host.id) || ids.has(host.id)) throw Error('Host IDs must be unique and contain only letters, digits, _ or -.');
    ids.add(host.id);
    const profile = validateProfile(host);
    if (profile.kind !== 'mcp' && (!profile.keyPath || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(host.fingerprint || ''))) throw Error('Headless SSH requires a keyPath and a verified SHA256 fingerprint.');
    return { ...profile, id: host.id, fingerprint: host.fingerprint, control: host.control === true };
  });
  return config;
}

async function listHosts(config) {
  const hosts = config.hosts.map(({ id, name, kind, control }) => ({ hostId: id, name, kind, control }));
  if (config.discoverManager === true) {
    for (const h of await transport.listManagerHosts()) if (!hosts.some(x => x.hostId === h.hostId)) hosts.push({ hostId: h.hostId, name: h.name, kind: 'mcp', control: false });
  }
  return hosts;
}

async function connectHost(config, id) {
  let host = config.hosts.find(h => h.id === id);
  if (!host && config.discoverManager === true) host = (await transport.listManagerHosts()).find(h => h.hostId === id);
  if (!host) throw Object.assign(Error('Unknown host.'), { code: 'HOST_NOT_FOUND' });
  return transport.connect(host, undefined, hash => hash === host.fingerprint, () => {});
}
module.exports = { loadConfig, listHosts, connectHost };
