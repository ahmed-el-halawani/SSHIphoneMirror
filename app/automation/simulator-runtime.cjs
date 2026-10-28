const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { quote } = require('../core.cjs');
const directory = path.join(__dirname, '../../vendor/idb');
const source = fs.readFileSync(path.join(__dirname, 'install-runtime.py'), 'utf8');

function loadCatalog() {
  const catalog = JSON.parse(fs.readFileSync(path.join(directory, 'catalog.json'), 'utf8'));
  if(catalog.formatVersion!==1 || !Array.isArray(catalog.bundles) || !catalog.bundles.length)throw Error('No bundled Simulator runtimes are available.');
  for(const bundle of catalog.bundles) {
    if(!/^idb-[a-f0-9]{8}-[a-z0-9_]+-[a-f0-9]{16}$/.test(bundle.bundleId) || path.basename(bundle.archive)!==bundle.archive || !/^[a-f0-9]{64}$/.test(bundle.archiveSha256) || !/^[a-f0-9]{64}$/.test(bundle.manifestSha256) || !Number.isSafeInteger(bundle.archiveBytes) || bundle.archiveBytes<1 || bundle.archiveBytes>200*1024*1024)throw Error('Invalid Simulator runtime catalog.');
  }
  return catalog;
}
function script(payload) {
  return `/usr/bin/python3 - <<'MIRROR_RUNTIME_PY'\nimport sys\nsys.argv.append('${Buffer.from(JSON.stringify(payload)).toString('base64')}')\n${source}\nMIRROR_RUNTIME_PY\n`;
}
async function result(conn, payload, signal) {
  const response = JSON.parse((await conn.run(script(payload), 180000, signal, { quiet: true })).trim());
  if(!response.ok)throw Object.assign(Error(response.message),{code:response.code});
  return response;
}
async function ensureSimulatorRuntime(conn, log=()=>{}, signal) {
  const { bundles } = loadCatalog();
  const state = await result(conn, { action: 'probe', bundles }, signal);
  if(state.ready) { log('Simulator automation runtime is verified and ready.'); return {...state,reused:true}; }
  const bundle = bundles.find(b => b.bundleId===state.bundleId);
  const archive = path.join(directory,bundle.archive);
  const bytes = fs.readFileSync(archive);
  if(bytes.length!==bundle.archiveBytes || crypto.createHash('sha256').update(bytes).digest('hex')!==bundle.archiveSha256)throw Error('Bundled Simulator runtime failed its checksum check. Reinstall iPhone Mirror.');
  const name='.upload-'+crypto.randomUUID()+'.tar.gz';
  log('Installing the bundled Simulator automation runtime on this Mac…');
  const upload=JSON.parse((await conn.run(`/usr/bin/python3 - <<'PY'\nimport json,pathlib,os\np=pathlib.Path.home()/'.local/share/iphone-mirror/idb'\np.mkdir(parents=True,exist_ok=True,mode=0o700)\nf=p/${quote(name)}\nfd=os.open(str(f),os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)\nprint(json.dumps(str(f)))\nPY`,30000,signal,{quiet:true})).trim());
  try {
    await conn.run(`umask 077\ncat > ${quote(upload)}`,600000,signal,{quiet:true,inputFile:archive});
    log('Verifying the bundled Python, IDB CLI and native companion…');
    const installed=await result(conn,{action:'install',bundles,upload},signal);
    log('Simulator automation is ready.');
    return installed;
  } catch(error) {
    await conn.run(`/usr/bin/python3 - <<'PY'\nimport pathlib\np=pathlib.Path.home()/'.local/share/iphone-mirror/idb'/${quote(name)}\np.unlink(missing_ok=True)\nPY`,10000,undefined,{quiet:true}).catch(()=>{});
    throw error;
  }
}
module.exports={ensureSimulatorRuntime,loadCatalog,script};
