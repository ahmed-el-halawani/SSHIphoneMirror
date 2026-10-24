const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { Client: SSHClient } = require('ssh2');
const { parse } = require('smol-toml');
const { fingerprint } = require('./core.cjs');

function cancelled() { const error=Error('Connection cancelled.');error.name='AbortError';return error; }
function terminate(child) {
  if(child.exitCode!==null)return;
  if(process.platform==='win32' && child.pid) spawn('taskkill.exe',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'}).on('error',()=>child.kill());
  else child.kill();
}

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
    async forward(remotePorts, signal) {
      if(signal?.aborted)throw cancelled();
      for (const port of remotePorts) if (![17425,19100].includes(port)) throw Error('Unsupported device port.');
      const ports = [];
      for (const _port of remotePorts) ports.push(await new Promise((resolve,reject) => {
        const probe = net.createServer(); probe.on('error',reject);
        probe.listen(0,'127.0.0.1',()=>{const port=probe.address().port;probe.close(()=>resolve(port));});
      }));
      const forwards=remotePorts.flatMap((remote,i)=>['-L',`127.0.0.1:${ports[i]}:127.0.0.1:${remote}`]);
      const child=spawn('ssh',['-N','-o','ExitOnForwardFailure=yes',...forwards,...recipe.argv.slice(1)],{
        windowsHide:true,shell:false,env:{...process.env,...recipe.env},stdio:['ignore','ignore','pipe']
      });
      let failure='';child.stderr.on('data',d=>{failure=(failure+d).slice(-2000);});
      child.on('error',e=>{failure=e.message;});
      try {
        for(let attempt=0;attempt<80;attempt++) {
          if(signal?.aborted)throw cancelled();
          if(child.exitCode!==null || failure) throw Error(failure || 'SSH tunnel exited.');
          const connected=await new Promise(resolve=>{const s=net.connect(ports[0],'127.0.0.1');s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(false));});
          if(connected)return {ports,close:()=>child.kill()};
          await new Promise(resolve=>setTimeout(resolve,250));
        }
        throw Error('Timed out opening the device SSH tunnel.');
      } catch(e) {child.kill();throw e;}
    },
    runSigned(script, timeout=600000, signal) {
      if(signal?.aborted)return Promise.reject(cancelled());
      const signing=recipe.signing;
      if (!signing || signing.mode==='off') throw Error('Enable a signing mode for this Mac in SSH Resource Manager first.');
      const command=`printf %s '${Buffer.from(script).toString('base64')}' | base64 -D | /bin/sh`;
      let executable, args, env={...process.env,...signing.env};
      if(signing.command_env) {
        const [launcher,...rest]=signing.argv;
        if(!launcher.endsWith('sshrm-run.cmd') || /["\r\n%&|<>^]/.test(launcher) || rest.some(a=>!/^--host=[a-f0-9-]{36}$/i.test(a))) throw Error('Unsupported signing launcher.');
        env[signing.command_env]=command;
        executable=process.env.ComSpec || 'cmd.exe';
        args=['/d','/s','/c',`""${launcher}" ${rest.join(' ')}"`];
      } else { [executable,...args]=signing.argv; args.push(command); }
      return new Promise((resolve,reject)=>{
        const child=spawn(executable,args,{windowsHide:true,windowsVerbatimArguments:!!signing.command_env,env,stdio:['ignore','pipe','pipe']});
        let output='',error='',settled=false;
        const abort=()=>{terminate(child);finish(cancelled());};
        const finish=(e)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);e?reject(e):resolve(output);};
        const timer=setTimeout(()=>{child.kill();finish(Error('Device setup timed out. Check the activity log on the Mac before retrying.'));},timeout);
        signal?.addEventListener('abort',abort,{once:true});
        child.stdout.on('data',d=>{output+=d;if(output.length>4e6){child.kill();finish(Error('Device setup output exceeded its limit.'));}});
        child.stderr.on('data',d=>{error=(error+d).slice(-16000);});
        child.on('error',finish);
        child.on('close',code=>finish(code===0?null:Error(error.trim()||output.slice(-3000)||`Signing runner exited (${code}).`)));
      });
    },
    run(script, timeout = 180000, signal) {
      if(signal?.aborted)return Promise.reject(cancelled());
      return new Promise((resolve, reject) => {
        const child = spawn('ssh', [...recipe.argv.slice(1), 'sh -s'], {
          windowsHide: true, shell: false, env: { ...process.env, ...recipe.env }, stdio: ['pipe', 'pipe', 'pipe']
        });
        let out = '', err = '', settled = false;
        const abort=()=>{terminate(child);finish(cancelled());};
        const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer);signal?.removeEventListener('abort',abort); error ? reject(error) : resolve(value); };
        const timer = setTimeout(() => { child.kill(); finish(Error('The Mac command timed out. The simulator or download may still be running; check the Mac and retry.')); }, timeout);
        signal?.addEventListener('abort',abort,{once:true});
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
  const runner = {
    close() { conn.end(); },
    run(script, timeout = 180000, signal) {
      if(signal?.aborted)return Promise.reject(cancelled());
      return new Promise((resolve, reject) => {
        conn.exec('sh -s', (error, stream) => {
          if (error) return reject(error);
          let out = '', err = '', settled = false;
          const abort=()=>{stream.close();finish(cancelled());};
          const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer);signal?.removeEventListener('abort',abort); error ? reject(error) : resolve(result); };
          const timer = setTimeout(() => { stream.close(); finish(Error('Mac command timed out. Check the Mac before retrying.')); }, timeout);
          signal?.addEventListener('abort',abort,{once:true});
          if(signal?.aborted){abort();return;}
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
  runner.runSigned=runner.run;
  runner.forward=async(remotePorts,signal)=>{
    const servers=[];const ports=[];const sockets=new Set();
    try {
      for(const port of remotePorts) {
        if(signal?.aborted)throw cancelled();
        if(![17425,19100].includes(port))throw Error('Unsupported device port.');
        const server=net.createServer(socket=>{
          sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
          conn.forwardOut('127.0.0.1',socket.remotePort,'127.0.0.1',port,(error,stream)=>{
            if(error){socket.destroy();return;}
            socket.pipe(stream).pipe(socket);socket.on('error',()=>stream.destroy());stream.on('error',()=>socket.destroy());
            socket.on('close',()=>stream.destroy());
          });
        });
        await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
        servers.push(server);ports.push(server.address().port);
      }
      return {ports,close:()=>{sockets.forEach(socket=>socket.destroy());servers.forEach(server=>server.close());}};
    } catch(e) {servers.forEach(server=>server.close());throw e;}
  };
  return runner;
}

module.exports = { listManagerHosts, connect };
