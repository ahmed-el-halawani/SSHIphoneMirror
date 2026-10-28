const fs = require('node:fs');
const path = require('node:path');
const { quote } = require('../core.cjs');
const source = fs.readFileSync(path.join(__dirname, '../drivers/ios-command.py'), 'utf8');
const MUTATIONS = new Set(['tap', 'tap_element', 'swipe', 'type_text', 'launch_app', 'terminate_app', 'install_app', 'long_press', 'start_session', 'shutdown_simulator']);
function scriptFor(action, args) {
  const payload = Buffer.from(JSON.stringify({ action, ...args })).toString('base64');
  return `/usr/bin/python3 - <<'IPHONE_MIRROR_PY'\nimport sys\nsys.argv.append(${quote(payload)})\n${source}\nIPHONE_MIRROR_PY\n`;
}
async function execute(conn, action, args, signal) {
  let output;
  if(action==='start_session') {
    const real=require('../real-device.cjs');
    real.validateRealUdid(args.deviceId?.slice(5));
    args={...args,sessionScript:real.startScript(args.deviceId.slice(5))};
  }
  try { output = await (action==='start_session'?conn.runSigned.bind(conn):conn.run.bind(conn))(scriptFor(action, args), action==='start_session'?720000:Math.min(180000, (args.timeoutMs || 30000) + 15000), signal, { maxBytes: action === 'screenshot' ? 24 * 1024 * 1024 : 4 * 1024 * 1024, quiet: true }); }
  catch (error) {
    throw Object.assign(Error(MUTATIONS.has(action) ? 'Connection interrupted; the action may have executed. Inspect device state before retrying.' : 'Device connection failed.'), { code: MUTATIONS.has(action) ? 'OUTCOME_UNKNOWN' : 'CONNECTION_FAILED', cause: error });
  }
  let result;
  try { result = JSON.parse(output.trim()); } catch { throw Object.assign(Error('Invalid driver response.'), { code: MUTATIONS.has(action) ? 'OUTCOME_UNKNOWN' : 'INVALID_RESPONSE' }); }
  if (!result.ok) throw Object.assign(Error(result.error.message), { code: result.error.code, executed: result.executed, verified: result.verified });
  if(action==='screenshot') {
    if(typeof result.image!=='string' || result.image.length>Math.ceil(16*1024*1024/3)*4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.image) || !Buffer.from(result.image,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Object.assign(Error('Driver returned an invalid or oversized PNG.'),{code:'INVALID_RESPONSE'});
  }
  return result;
}
module.exports = { execute, scriptFor, MUTATIONS };
