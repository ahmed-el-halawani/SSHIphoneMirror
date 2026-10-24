const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { validateProfile, validateUdid, quote, resultJSON, viewerURL, fingerprint, viewerBounds } = require('../app/core.cjs');
const { probe, startScript, installScript, stop } = require('../app/remote.cjs');
const udid = '8AA89128-E540-44BB-82FD-43999DDC6838';

test('manual connection validates trust-boundary fields and excludes secrets', () => {
  const p = validateProfile({ host: '192.168.1.20', username: 'ahmed', password: 'secret' });
  assert.equal(p.port, 22); assert.equal(p.password, undefined);
  for (const host of ['-oProxyCommand=bad', 'host;rm', '$(whoami)', 'ssh://host', 'host\nother']) {
    assert.throws(() => validateProfile({ host, username: 'ahmed' }));
  }
  assert.throws(() => validateProfile({ host: 'mac.local', username: 'user;whoami' }));
  assert.throws(() => validateProfile({ host: 'mac.local', username: 'user', port: 65536 }));
  assert.throws(() => validateProfile({ kind: 'mcp', hostId: '--bad' }));
});
test('shell quoting and simulator validation reject command injection', () => {
  assert.equal(quote("a'b"), "'a'\"'\"'b'");
  assert.equal(validateUdid(udid), udid);
  assert.throws(() => startScript(`${udid};touch /tmp/pwn`));
  assert.match(startScript(udid), /127\.0\.0\.1:18080/);
});
test('pairing is local to the isolated viewer with a fixed signaling broker', () => {
  const target = new URL(viewerURL('https://app.simbeam.dev/#daemon=abc&pair=xyz&signal=wss://evil.test', udid));
  assert.equal(target.protocol, 'mirror:'); assert.equal(target.host, 'viewer');
  assert.equal(new URLSearchParams(target.hash.slice(1)).get('signal'), 'wss://signal.simbeam.dev/ws');
  for (const url of ['http://app.simbeam.dev/#daemon=a&pair=b','https://evil.test/#daemon=a&pair=b','https://app.simbeam.dev/','https://app.simbeam.dev/evil#daemon=a&pair=b']) assert.throws(() => viewerURL(url, udid));
});
test('remote result parsing ignores incidental logs', () => {
  assert.deepEqual(resultJSON('log\r\nMIRROR_JSON={"devices":[]}\r\n'), { devices: [] });
  assert.throws(() => resultJSON('download failed'));
});
test('host fingerprints match OpenSSH SHA256 format', () => {
  assert.match(fingerprint(Buffer.from('host key')), /^SHA256:[A-Za-z0-9+/]{43}$/);
});
test('compact viewer leaves the menus and bottom controls reachable at every window size', () => {
  assert.deepEqual(viewerBounds(376, 850), { x: 0, y: 90, width: 376, height: 696 });
  const small = viewerBounds(320, 600);
  assert.equal(small.y + small.height, 536);
  assert.equal(viewerBounds(0, 0).height, 1);
});
test('installation verifies releases and does not install a login service', () => {
  const script = installScript();
  assert.match(script, /SIMBEAM_NO_SERVICE=1/); assert.match(script, /checksum mismatch/);
  assert.match(probe, /full Xcode/); assert.match(stop, /pkill -TERM/);
});
test('viewer keeps signature authentication and starts the selected simulator', () => {
  const script = readFileSync('vendor/simbeam/client.js', 'utf8');
  assert.match(script, /crypto\.subtle\.verify/); assert.match(script, /if \(!ok\) \{ showAuthFail\(\); teardown\(\); return; \}/);
  assert.match(script, /sims\.find\(s => s\.udid === wanted\)/);
  assert.match(script, /dc\.onopen = \(\) => pickRTC/);
  assert.doesNotMatch(script, /dc\.send\(JSON\.stringify\(\{type: 'list'\}\)\)/);
  assert.doesNotMatch(script, /setupStartPanel\(\)|applySubscription\(|SIMCAST_APP_SECRET/);
  assert.doesNotMatch(script, /refreshTurnIndicator\(/);
});
