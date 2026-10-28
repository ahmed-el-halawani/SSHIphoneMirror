// Explicit migration of verified key profiles only; encrypted passwords are never read.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { validateProfile } = require('../core.cjs');
function enroll(source, destination) {
  const input = JSON.parse(fs.readFileSync(source, 'utf8'));
  if(!Array.isArray(input.profiles))throw Error('Expected an Electron connections.json file.');
  const hosts = input.profiles.filter(p => p.kind==='mcp' || p.keyPath && /^SHA256:[A-Za-z0-9+/]{43}$/.test(p.fingerprint || '')).map(p => ({ ...validateProfile(p), id: randomUUID(), ...(p.fingerprint?{fingerprint:p.fingerprint}:{}), control: false }));
  fs.writeFileSync(destination, JSON.stringify({hosts}, null, 2)+'\n', { flag: 'wx', mode: 0o600 });
  return { imported: hosts.length, skipped: input.profiles.length-hosts.length };
}
if(require.main===module) {
  try {
    if(process.argv.length!==4)throw Error('Usage: node app/automation/enroll.cjs SOURCE_CONNECTIONS_JSON NEW_AUTOMATION_JSON');
    console.log(JSON.stringify(enroll(process.argv[2],process.argv[3])));
  } catch(e) {process.stderr.write(e.message+'\n');process.exitCode=1;}
}
module.exports={enroll};
