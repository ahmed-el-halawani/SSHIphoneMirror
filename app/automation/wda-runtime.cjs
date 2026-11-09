const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { quote } = require('../core.cjs');
const directory = path.join(__dirname, '../../vendor/wda');

function loadBundle() {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.formatVersion !== 1 || manifest.archive !== 'WebDriverAgentRunner.ipa' || !/^[a-f0-9]{64}$/.test(manifest.sha256) || !/^[A-Z0-9]{10}$/.test(manifest.teamId) || !/^[a-zA-Z0-9.-]+\.xctrunner$/.test(manifest.bundleId)) throw Error('Invalid bundled WebDriverAgent manifest. Reinstall iPhone Mirror.');
  return manifest;
}

async function prepareWda(conn, signal) {
  const manifest = loadBundle();
  const archive = path.join(directory, manifest.archive);
  const bytes = fs.readFileSync(archive);
  if (bytes.length !== manifest.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw Error('Bundled WebDriverAgent failed its checksum check. Reinstall iPhone Mirror.');
  const root = `"$HOME/.local/share/iphone-mirror-tools/wda/${manifest.sha256}"`;
  const ready = await conn.run(`test -f ${root}/Payload/WebDriverAgentRunner-Runner.app/Info.plist && test -f ${root}/WebDriverAgentRunner.xctestrun && echo ready || echo missing`, 15000, signal, { quiet: true });
  if (ready.trim() === 'ready') return;
  const upload = '.wda-upload-' + crypto.randomUUID() + '.ipa';
  try {
    await conn.run(`umask 077\nmkdir -p "$HOME/.local/share/iphone-mirror-tools/wda"\ncat > "$HOME/.local/share/iphone-mirror-tools/wda/${upload}"`, 180000, signal, { quiet: true, inputFile: archive });
    await conn.run(`/usr/bin/python3 - <<'PY'
import hashlib,pathlib,subprocess,tempfile,os,zipfile
root=pathlib.Path.home()/'.local/share/iphone-mirror-tools/wda'
archive=root/${quote(upload)}
if hashlib.sha256(archive.read_bytes()).hexdigest()!=${quote(manifest.sha256)}: raise SystemExit('WebDriverAgent transfer checksum mismatch.')
with zipfile.ZipFile(archive) as package:
 for entry in package.infolist():
  name=pathlib.PurePosixPath(entry.filename)
  if name.is_absolute() or '..' in name.parts or '\\\\' in entry.filename: raise SystemExit('Unsafe WebDriverAgent archive path.')
with tempfile.TemporaryDirectory(prefix='.extract-',dir=root) as folder:
 subprocess.run(['ditto','-x','-k',str(archive),folder],check=True)
 app=pathlib.Path(folder)/'Payload/WebDriverAgentRunner-Runner.app'
 subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True)
 if not (pathlib.Path(folder)/'WebDriverAgentRunner.xctestrun').is_file(): raise SystemExit('Bundled WebDriverAgent launch file is missing.')
 destination=root/${quote(manifest.sha256)}
 if destination.exists():
  if not (destination/'Payload/WebDriverAgentRunner-Runner.app/Info.plist').is_file() or not (destination/'WebDriverAgentRunner.xctestrun').is_file(): raise SystemExit('Incomplete WebDriverAgent cache. Remove '+str(destination)+' and retry.')
 else: os.rename(folder,destination)
PY`, 60000, signal, { quiet: true });
  } finally {
    await conn.run(`rm -f "$HOME/.local/share/iphone-mirror-tools/wda/${upload}"`, 10000, undefined, { quiet: true }).catch(() => {});
  }
}

module.exports = { loadBundle, prepareWda };
