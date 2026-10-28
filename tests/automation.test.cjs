const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Controller } = require('../app/automation/controller.cjs');
const { loadConfig } = require('../app/automation/connection-profiles.cjs');
const { execute, scriptFor } = require('../app/automation/command-executor.cjs');

test('headless profiles require pinned key trust and never load Electron credentials', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-profiles-'));
  const file = path.join(folder, 'config.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ hosts: [{ id: 'mac', host: 'mac.local', username: 'tester', keyPath: 'key' }] }));
    assert.throws(() => loadConfig(file), /verified SHA256/);
    fs.writeFileSync(file, JSON.stringify({ hosts: [{ id: 'mac', kind: 'mcp', hostId: 'a'.repeat(36), encryptedPassword: 'never-read' }] }));
    assert.equal(loadConfig(file).hosts[0].control, false);
    assert.equal(loadConfig(file).hosts[0].encryptedPassword, undefined);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
test('enrollment excludes passwords and refuses to overwrite existing configuration',()=>{
  const {enroll}=require('../app/automation/enroll.cjs');
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'mirror-enroll-'));
  try {
    const source=path.join(folder,'connections.json'),dest=path.join(folder,'automation.json');
    fs.writeFileSync(source,JSON.stringify({profiles:[{kind:'manual',host:'mac.local',username:'tester',keyPath:'key',fingerprint:'SHA256:'+'a'.repeat(43),encryptedPassword:'secret'},{kind:'manual',host:'password.local',username:'tester',encryptedPassword:'secret'}]}));
    assert.deepEqual(enroll(source,dest),{imported:1,skipped:1});
    assert(!fs.readFileSync(dest,'utf8').includes('secret'));
    assert.equal(JSON.parse(fs.readFileSync(dest)).hosts[0].control,false);
    assert.throws(()=>enroll(source,dest),/exist/);
  } finally {fs.rmSync(folder,{recursive:true,force:true});}
});
test('mutations fail closed without host control permission, before connecting', async () => {
  const result = await new Controller({ hosts: [] }).call('tap', { hostId: 'unknown', deviceId: '8AA89128-E540-44BB-82FD-43999DDC6838', x: 1, y: 2 });
  assert.equal(result.error.code, 'PERMISSION_DENIED');
  assert.equal(result.executed, false);
});
test('command payloads cannot escape the fixed Python script or leak plaintext inputs', async () => {
  const text = "تجربة'; $(touch /tmp/unsafe)\nIPHONE_MIRROR_PY";
  const script = scriptFor('type_text', { text });
  assert.equal(script.includes(text), false);
  assert.match(script, /python3 - <<'/);
  const payload = JSON.parse(Buffer.from(script.match(/sys.argv.append\('([^']+)'\)/)[1], 'base64'));
  assert.equal(payload.text, text);
  let calls = 0;
  await assert.rejects(execute({ run: async () => { calls++; throw Error(text); } }, 'tap', {}), e => e.code === 'OUTCOME_UNKNOWN' && !e.message.includes(text));
  assert.equal(calls, 1);
});
test('screenshots have a separate bounded transfer budget and suppress SSH logging', async () => {
  await execute({ run: async (_script, _timeout, _signal, options) => {
    assert.equal(options.maxBytes, 24 * 1024 * 1024);
    assert.equal(options.quiet, true);
    return JSON.stringify({ok:true,image:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')});
  } }, 'screenshot', {});
});
test('manager recipes cannot turn off host verification',()=>{
  const {openSSHRunner}=require('../app/automation/ssh-transport.cjs');
  for(const mode of ['no','off','accept-new'])assert.throws(()=>openSSHRunner({executable:'ssh',argv:['ssh','-o','StrictHostKeyChecking='+mode,'mac']},()=>{}),/strict host-key/);
});
test('driver selector, deadline, redaction and lock checks', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['tests/driver.test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
test('MCP v2 schemas reject extra commands and unsafe arguments', async () => {
  const { contracts } = await import('../app/mcp/tools.mjs');
  assert.equal(contracts.tap.schema.safeParse({ hostId: 'mac', deviceId: 'bad', x: 1, y: 1 }).success, false);
  assert.equal(contracts.list_hosts.schema.safeParse({ command: 'rm -rf /' }).success, false);
  assert.equal(contracts.type_text.schema.safeParse({ hostId: 'mac', deviceId: '8AA89128-E540-44BB-82FD-43999DDC6838', text: 'a\0' }).success, false);
});
