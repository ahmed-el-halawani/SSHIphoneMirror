const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Client: SSHClient } = require('ssh2');
const { parse } = require('smol-toml');
const { fingerprint } = require('./core.cjs');

async function managerClient() {
  const config = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  let entry;
  try { entry = parse(fs.readFileSync(config, 'utf8')).mcp_servers?.['ssh-resource-manager']; }
  catch { throw Error('Could not read Codex config.toml. Configure SSH Resource Manager there, or use manual SSH.'); }
  if (!entry?.command || !Array.isArray(entry.args)) throw Error('SSH Resource Manager is not configured as a local MCP server. Use manual SSH or configure it in Codex.');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'iphone-mirror', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args,
    env: { ...process.env, ...entry.env, ELECTRON_RUN_AS_NODE: '1', SSHRM_NO_GUI: '1' }, stderr: 'pipe' });
  try { await client.connect(transport, { timeout: 20000 }); }
  catch (e) { await transport.close().catch(() => {}); throw Error(`Could not start SSH Resource Manager: ${e.message}`); }
  return client;
}

async function tool(client, name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 });
  const data = result.structuredContent || JSON.parse(result.content.find(c => c.type === 'text').text);
  if (result.isError || data.error) throw Error(data.error?.message || 'SSH Resource Manager rejected the request.');
  return data;
}

async function listManagerHosts() {
  const client = await managerClient();
  try {
    let hosts = [], cursor;
    do {
      const data = await tool(client, 'ssh_hosts_list', { enabled: true, limit: 100, ...(cursor ? { cursor } : {}) });
      hosts.push(...data.hosts); cursor = data.next_cursor;
    } while (cursor && hosts.length < 1000);
    return hosts.filter(h => h.declared_os === 'macos' || h.observed_os === 'macos').map(h => ({ kind: 'mcp', hostId: h.id, name: h.name, target: h.target }));
  } finally { await client.close(); }
}

function openSSHRunner(recipe, log) {
  if (recipe.executable !== 'ssh' || !Array.isArray(recipe.argv) || recipe.argv[0] !== 'ssh') throw Error('Unsupported SSH connection recipe.');
  return {
    close() {},
    run(script, timeout = 180000) {
      return new Promise((resolve, reject) => {
        const child = spawn('ssh', [...recipe.argv.slice(1), 'sh -s'], {
          windowsHide: true, shell: false, env: { ...process.env, ...recipe.env }, stdio: ['pipe', 'pipe', 'pipe']
        });
        let out = '', err = '', settled = false;
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => { child.kill(); finish(Error('The Mac command timed out. The simulator or download may still be running; check the Mac and retry.')); }, timeout);
        child.stdout.on('data', d => { out += d; if (out.length > 4e6) { child.kill(); finish(Error('Mac response exceeded the size limit.')); } });
        child.stderr.on('data', d => { err = (err + d).slice(-16000); });
        child.on('error', e => finish(e));
        child.stdin.on('error', () => {});
        child.on('close', code => {
          const visible = out.split(/\r?\n/).filter(l => !l.startsWith('MIRROR_JSON=')).join('\n').trim();
          if (visible) log(visible.slice(-3000));
          finish(code === 0 ? null : Error(err.trim() || `Mac command failed (${code}). ${visible.slice(-1000)}`), out);
        });
        child.stdin.end(script.replace(/\r\n/g, '\n') + '\n');
      });
    }
  };
}

async function connect(profile, password, trust, log) {
  if (profile.kind === 'mcp') {
    const client = await managerClient();
    try { return openSSHRunner(await tool(client, 'ssh_hosts_get_connection_recipe', {
      host_id: profile.hostId, caller_environment: 'windows-native', purpose: 'shell'
    }), log); }
    finally { await client.close(); }
  }
  const conn = new SSHClient();
  let privateKey;
  if (profile.keyPath) privateKey = fs.readFileSync(profile.keyPath);
  await new Promise((resolve, reject) => {
    conn.once('ready', resolve);
    conn.once('error', reject);
    conn.connect({ host: profile.host, port: profile.port, username: profile.username,
      ...(privateKey ? { privateKey, passphrase: password || undefined } : { password }),
      readyTimeout: 20000, keepaliveInterval: 10000,
      hostVerifier: (key, cb) => { Promise.resolve(trust(fingerprint(key))).then(cb, () => cb(false)); }
    });
  }).catch(e => { conn.end(); throw e; });
  return {
    close() { conn.end(); },
    run(script, timeout = 180000) {
      return new Promise((resolve, reject) => {
        conn.exec('sh -s', (error, stream) => {
          if (error) return reject(error);
          let out = '', err = '', settled = false;
          const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
          const timer = setTimeout(() => { stream.close(); finish(Error('Mac command timed out. Check the Mac before retrying.')); }, timeout);
          stream.on('data', d => { out += d; if (out.length > 4e6) { stream.close(); finish(Error('Mac response exceeded the size limit.')); } });
          stream.stderr.on('data', d => { err = (err + d).slice(-16000); });
          stream.on('error', e => finish(e));
          stream.on('close', code => {
            const visible = out.split(/\r?\n/).filter(l => !l.startsWith('MIRROR_JSON=')).join('\n').trim();
            if (visible) log(visible.slice(-3000));
            finish(code === 0 ? null : Error(err.trim() || `Mac command failed (${code}). ${visible.slice(-1000)}`), out);
          });
          stream.end(script.replace(/\r\n/g, '\n') + '\n');
        });
      });
    }
  };
}

module.exports = { listManagerHosts, connect };
