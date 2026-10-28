const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const toml=require('smol-toml'),jsonc=require('jsonc-parser');
const setup=require('../app/mcp/client-setup.cjs');
const server=setup.launch('C:/Program Files/iPhone Mirror/resources/app.asar','C:/Program Files/iPhone Mirror/iPhone Mirror.exe','C:/Users/test/.iphone-mirror/automation.json');
function temporary(fn){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mirror-client-'));try{return fn(directory);}finally{fs.rmSync(directory,{recursive:true,force:true});}}

test('manual client snippets use the bundled runtime and client-specific schemas',()=>{
  const codex=toml.parse(setup.snippet('codex',server)).mcp_servers['iphone-mirror'];
  assert.equal(codex.command,server.command);assert.equal(codex.env.ELECTRON_RUN_AS_NODE,'1');assert.equal(codex.tool_timeout_sec,720);
  const claude=JSON.parse(setup.snippet('claude',server)).mcpServers['iphone-mirror'];assert.equal(claude.type,'stdio');
  const open=JSON.parse(setup.snippet('opencode',server)).mcp['iphone-mirror'];assert.equal(open.type,'local');assert.deepEqual(open.command,[server.command,...server.args]);assert.equal(open.environment.IPHONE_MIRROR_CONFIG,server.env.IPHONE_MIRROR_CONFIG);
  assert.throws(()=>setup.snippet('../other',server),/Choose/);
});
test('one-click setup preserves existing client settings, creates a backup and supports repeat setup',()=>temporary(directory=>{
  const files={codex:path.join(directory,'config.toml'),claude:path.join(directory,'.claude.json'),opencode:path.join(directory,'opencode.jsonc')};
  fs.writeFileSync(files.codex,'# Existing preferences\nmodel = "keep-model"\n[mcp_servers.other]\ncommand = "keep-command"\n');
  fs.writeFileSync(files.claude,JSON.stringify({theme:'dark',mcpServers:{other:{command:'keep-command'}}}));
  fs.writeFileSync(files.opencode,'{\n // Keep this comment\n "model":"keep-model", "mcp":{"other":{"type":"local","command":["keep-command"]}},\n}');
  for(const client of Object.keys(files)){
    const before=fs.readFileSync(files[client],'utf8');const result=setup.installClient(client,server,files);
    assert.equal(fs.readFileSync(result.backup,'utf8'),before);
    const text=fs.readFileSync(files[client],'utf8');const value=client==='codex'?toml.parse(text):jsonc.parse(text);
    const entries=value[client==='codex'?'mcp_servers':client==='claude'?'mcpServers':'mcp'];
    assert(entries.other);assert(entries['iphone-mirror']);assert.equal(value.theme || value.model,client==='claude'?'dark':'keep-model');
    if(client==='opencode')assert(text.includes('// Keep this comment'));
    setup.installClient(client,server,files);
    const again=client==='codex'?toml.parse(fs.readFileSync(files[client],'utf8')):jsonc.parse(fs.readFileSync(files[client],'utf8'));
    assert.equal(Object.keys(again[client==='codex'?'mcp_servers':client==='claude'?'mcpServers':'mcp']).filter(k=>k==='iphone-mirror').length,1);
  }
}));
test('invalid client configuration is never overwritten',()=>temporary(directory=>{
  const files={codex:path.join(directory,'codex'),claude:path.join(directory,'claude'),opencode:path.join(directory,'open')};
  for(const client of Object.keys(files)){fs.writeFileSync(files[client],'{ invalid');assert.throws(()=>setup.installClient(client,server,files));assert.equal(fs.readFileSync(files[client],'utf8'),'{ invalid');}
}));
test('client setup preserves existing tool restrictions and refuses unrelated name collisions',()=>temporary(directory=>{
  const file=path.join(directory,'config.toml');
  const own=toml.parse(setup.snippet('codex',server));own.mcp_servers['iphone-mirror'].disabled_tools=['ios_tap'];own.mcp_servers['iphone-mirror'].default_tools_approval_mode='prompt';
  fs.writeFileSync(file,toml.stringify(own));setup.installClient('codex',server,{codex:file});
  const current=toml.parse(fs.readFileSync(file,'utf8')).mcp_servers['iphone-mirror'];assert.deepEqual(current.disabled_tools,['ios_tap']);assert.equal(current.default_tools_approval_mode,'prompt');
  fs.writeFileSync(file,'[mcp_servers.iphone-mirror]\ncommand = "other-service"\nargs = []\n');const before=fs.readFileSync(file,'utf8');assert.throws(()=>setup.installClient('codex',server,{codex:file}),/already used/);assert.equal(fs.readFileSync(file,'utf8'),before);
}));
test('MCP enrollment retains other hosts, excludes credentials and grants control only explicitly',()=>temporary(directory=>{
  const config=path.join(directory,'automation.json');const profile={kind:'mcp',hostId:'361c730b-9d5c-43ed-9c59-d628329ca7e9',name:'Mac',encryptedPassword:'secret'};
  fs.writeFileSync(config,JSON.stringify({hosts:[{kind:'mcp',id:'other',hostId:'11111111-1111-1111-1111-111111111111',control:false}]}));
  const first=setup.enroll(profile,false,config);assert.equal(first.control,false);assert(!fs.readFileSync(config,'utf8').includes('secret'));
  const second=setup.enroll({...profile,name:'Renamed Mac'},true,config);assert.equal(second.id,first.id);assert.equal(second.control,true);assert.equal(JSON.parse(fs.readFileSync(config)).hosts.length,2);
  assert.equal(setup.profileId(profile),setup.profileId({...profile,name:'Different name'}));
  assert.throws(()=>setup.enroll({kind:'manual',host:'mac.local',username:'user'},true,config),/verified SSH key/);
}));
