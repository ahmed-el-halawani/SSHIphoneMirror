const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { serveDesktop, requestDesktop } = require('../app/automation/desktop-viewer.cjs');
const { Controller } = require('../app/automation/controller.cjs');

test('desktop bridge authenticates, serializes viewer changes and rejects invalid targets', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-desktop-'));
  const file = path.join(folder, 'desktop.json'), calls = [];
  let running = 0;
  const close = await serveDesktop(async request => {
    assert.equal(running++, 0);
    await new Promise(resolve => setTimeout(resolve, 10));
    calls.push(request.action); running--; return { hidden: true };
  }, file);
  try {
    const results = await Promise.all(['screenshot', 'get_ui_tree'].map(action => requestDesktop({ action, phase: 'before' }, file)));
    assert(results.every(r => r.ok && r.hidden)); assert.equal(calls.length, 2);
    await assert.rejects(requestDesktop({ action: 'tap', phase: 'before', deviceId: 'injected-command' }, file), /Invalid desktop/);
    const state = JSON.parse(fs.readFileSync(file));
    const unauthorized = await new Promise((resolve, reject) => {
      const socket = net.connect(state.pipe); let output = '';
      socket.on('connect', () => socket.write(JSON.stringify({ token: 'wrong', action: 'screenshot', phase: 'before' }) + '\n'));
      socket.on('data', data => { output += data; }); socket.on('end', () => resolve(JSON.parse(output))); socket.on('error', reject);
    });
    assert.match(unauthorized.error, /Invalid desktop/); assert.equal(calls.length, 2);
  } finally { close(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test('desktop is opened before dispatch and a successful real session is never replayed after a viewer failure', async () => {
  const calls = [], deviceId = 'real:00008140-001645D80A10801C';
  const desktop = async (action, _args, phase = 'before') => {
    calls.push(phase + ':' + action);
    if (phase === 'after') throw Error('Video unavailable');
  };
  const controller = new Controller({ hosts: [{ id: 'mac', control: true }] }, desktop);
  controller.getHostConnection = async () => ({ runSigned: async () => { calls.push('dispatch'); return '{"ok":true}'; } });
  const result = await controller.call('start_session', { hostId: 'mac', deviceId });
  assert.equal(result.ok, true); assert.equal(result.viewerWarning, 'Video unavailable');
  assert.deepEqual(calls, ['before:start_session', 'dispatch', 'after:start_session']);
  calls.length = 0;
  const denied = new Controller({ hosts: [] }, desktop);
  assert.equal((await denied.call('tap', { hostId: 'mac', deviceId, x: 1, y: 1 })).error.code, 'PERMISSION_DENIED');
  assert.deepEqual(calls, [], 'permission rejection must happen before desktop startup');
});
