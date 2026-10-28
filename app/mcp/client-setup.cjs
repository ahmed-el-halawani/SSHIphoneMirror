const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const toml = require('smol-toml');
const jsonc = require('jsonc-parser');
const { validateProfile } = require('../core.cjs');

const NAME = 'iphone-mirror';
const profileId = profile => {const {name,...identity}=validateProfile(profile);return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,24);};
function atomic(file, original, text) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const latest=fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
  if(latest!==original)throw Error('Configuration changed while it was being prepared. Try again.');
  if(text===original)return {changed:false};
  const suffix=crypto.randomUUID();
  const backup=original===null?null:file+'.iphone-mirror-'+suffix+'.bak';
  if(backup)fs.writeFileSync(backup,original,{flag:'wx',mode:0o600});
  const temporary=file+'.iphone-mirror-'+suffix+'.tmp';
  try {
    fs.writeFileSync(temporary,text,{flag:'wx',mode:0o600});
    if((fs.existsSync(file)?fs.readFileSync(file,'utf8'):null)!==original)throw Error('Configuration changed. Try again.');
    fs.renameSync(temporary,file);
  } finally {if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return {changed:true,backup};
}
function read(file) {try{return fs.readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function locations(home=os.homedir(),env=process.env) {
  const openDirectory=path.join(env.XDG_CONFIG_HOME || path.join(home,'.config'),'opencode');
  return {
    codex:path.join(env.CODEX_HOME || path.join(home,'.codex'),'config.toml'),
    claude:path.join(home,'.claude.json'),
    opencode:env.OPENCODE_CONFIG || path.join(openDirectory,fs.existsSync(path.join(openDirectory,'opencode.jsonc'))?'opencode.jsonc':'opencode.json')
  };
}
function launch(appPath,executable,config) {
  return {command:executable,args:[path.join(appPath,'app/mcp/server.mjs')],env:{ELECTRON_RUN_AS_NODE:'1',IPHONE_MIRROR_CONFIG:config}};
}
function entry(client,server) {
  if(client==='codex')return {...server,enabled:true,startup_timeout_sec:30,tool_timeout_sec:720};
  if(client==='claude')return {type:'stdio',...server};
  if(client==='opencode')return {type:'local',command:[server.command,...server.args],environment:server.env,enabled:true,timeout:720000};
  throw Error('Choose Claude Code, Codex or OpenCode.');
}
function snippet(client,server) {
  const value=entry(client,server);
  return client==='codex'?toml.stringify({mcp_servers:{[NAME]:value}}):JSON.stringify({[client==='opencode'?'mcp':'mcpServers']:{[NAME]:value}},null,2);
}
function installClient(client,server,files=locations()) {
  let value=entry(client,server);const file=files[client];
  const original=read(file);
  function merge(previous) {
    if(previous===undefined)return value;
    const args=client==='opencode'?previous?.command?.slice(1):previous?.args;
    if(!previous || typeof previous!=='object' || !Array.isArray(args) || !args.some(arg=>typeof arg==='string'&&arg.replaceAll('\\','/').endsWith('/app/mcp/server.mjs')))throw Error('The iphone-mirror server name is already used by another entry. Use manual setup to choose a different name.');
    const key=client==='opencode'?'environment':'env';
    return {...previous,...value,[key]:{...previous[key],...value[key]}};
  }
  let updated;
  if(client==='codex') {
    const data=toml.parse(original || '');
    if(data.mcp_servers!==undefined && (!data.mcp_servers || typeof data.mcp_servers!=='object' || Array.isArray(data.mcp_servers)))throw Error('Codex MCP configuration is not a table.');
    data.mcp_servers={...data.mcp_servers,[NAME]:merge(data.mcp_servers?.[NAME])};
    updated=toml.stringify(data);
  } else {
    const errors=[];
    const data=jsonc.parse(original || '{}',errors,{allowTrailingComma:client==='opencode',disallowComments:client!=='opencode'});
    if(errors.length || !data || typeof data!=='object' || Array.isArray(data))throw Error('Client configuration is unreadable. It has not been overwritten.');
    const key=client==='opencode'?'mcp':'mcpServers';
    if(data[key]!==undefined && (!data[key] || typeof data[key]!=='object' || Array.isArray(data[key])))throw Error('Client MCP settings must be an object.');
    value=merge(data[key]?.[NAME]);
    updated=jsonc.applyEdits(original || '{}',jsonc.modify(original || '{}',[key,NAME],value,{formattingOptions:{insertSpaces:true,tabSize:2,eol:'\n'}}));
  }
  return {file,...atomic(file,original,updated)};
}
function enroll(profile,control,config) {
  const safe=validateProfile(profile);
  if(safe.kind!=='mcp' && (!safe.keyPath || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(profile.fingerprint || '')))throw Error('Headless MCP needs SSH Resource Manager or a verified SSH key. Password-only connections stay in the desktop app.');
  const original=read(config);
  const data=JSON.parse(original || '{"hosts":[]}');
  if(!data || !Array.isArray(data.hosts))throw Error('Automation configuration is unreadable. It has not been overwritten.');
  const matching=host=>safe.kind==='mcp'?host.kind==='mcp'&&host.hostId===safe.hostId:host.host===safe.host&&host.username===safe.username&&Number(host.port || 22)===safe.port&&host.keyPath===safe.keyPath;
  const previous=data.hosts.find(matching);
  const host={...safe,id:previous?.id || (safe.kind==='mcp'?safe.hostId:profileId(safe)),...(profile.fingerprint?{fingerprint:profile.fingerprint}:{}),control:control===true};
  data.hosts=data.hosts.filter(host=>!matching(host));data.hosts.push(host);
  atomic(config,original,JSON.stringify(data,null,2)+'\n');
  return host;
}
module.exports={profileId,locations,launch,snippet,installClient,enroll};
