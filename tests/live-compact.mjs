// Opt-in real MCP/SSH validation, restricted to the disposable CompactFixture application.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const hostId = process.env.MIRROR_TEST_HOST;
const deviceId = process.env.MIRROR_TEST_DEVICE;
assert(hostId && deviceId && !deviceId.startsWith('real:'), 'Set an explicit test Mac and Simulator.');
const bundleId = 'com.evaluation.CompactFixture';
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-compact-'));
const config = path.join(folder, 'automation.json');
fs.writeFileSync(config, JSON.stringify({ hosts: [{ id: hostId, kind: 'mcp', hostId, control: true }] }));
const source = `import {serveStdio} from '@modelcontextprotocol/server/stdio'; import {createServer} from './app/mcp/server.mjs'; import core from './app/automation/controller.cjs'; const c=new core.Controller(); const h=serveStdio(()=>createServer(c)); process.stdin.once('end',()=>{c.closeAll();void h.close()});`;
const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '-e', source], env: { ...process.env, IPHONE_MIRROR_CONFIG: config }, stderr: 'pipe' });
// Drain audit output so a long run cannot fill the Windows child-process pipe.
transport.stderr?.resume();
const client = new Client({ name: 'compact-live-validation', version: '1.0' });
const samples = [], corpus = [], checks = [];
let snapshot, view = new Map();
async function call(action, args = {}, errorCode) {
  const start = performance.now();
  const result = await client.callTool({ name: `ios_${action}`, arguments: { hostId, deviceId, timeoutMs: 30000, ...args } }, undefined, { timeout: 150000 });
  const data = result.structuredContent;
  samples.push({ action, wallMs: Math.round(performance.now() - start), driverMs: data.durationMs, responseBytes: Buffer.byteLength(JSON.stringify(result)), ok: data.ok, expectedError: errorCode || null });
  corpus.push({ kind: action, json: JSON.stringify(result), request: JSON.stringify({ name: `ios_${action}`, arguments: { hostId, deviceId, timeoutMs: 30000, ...args } }) });
  if (errorCode) { assert.equal(data.error?.code, errorCode, JSON.stringify(data)); assert.equal(data.executed, false); return data; }
  assert.equal(result.isError, false, JSON.stringify(data));
  return data;
}
function accept(next) {
  if (next.mode === 'full') view.clear();
  else assert.equal(next.baseSnapshotId, snapshot.snapshotId, 'Diff must name the exact baseline');
  for (const line of next.text.split('\n').filter(Boolean)) {
    if (line.startsWith('- ')) view.delete(line.slice(2));
    else { const text = line.replace(/^\+ /, ''); view.set(text.split(' ')[0], text); }
  }
  snapshot = next;
}
const text = () => [...view.values()].join('\n').replace(/[\u2066-\u2069]/g, '');
const find = id => [...view].find(([, line]) => line.includes(`id=${JSON.stringify(id)}`))?.[0];
async function read() { accept((await call('snapshot')).snapshot); }
async function act(operation, args = {}) {
  const result = await call('act', { snapshotId: snapshot.snapshotId, operation, ...args });
  assert(result.executed);
  assert(result.snapshot, 'Every successful act must return a snapshot');
  accept(result.snapshot);
  return result;
}
async function tap(id, expected) {
  const ref = find(id);
  assert(ref, `Missing ${id} in compact view:\n${text()}`);
  return act('tap', { ref, ...(expected ? { expected } : {}) });
}
const expectValue = (identifier, value) => ({ selector: { identifier }, value });
async function reset() {
  await call('terminate_app', { bundleId });
  await call('launch_app', { bundleId });
  // Fixture startup is outside the timed interaction sample.
  await new Promise(resolve => setTimeout(resolve, 600));
  await read();
}
async function reveal(id, direction = 'down') {
  for (let i = 0; !find(id) && i < 20; i++) await act('scroll', { direction });
  assert(find(id), `Could not reveal ${id}`);
}
async function lab() {
  await reset();
  await reveal('nav_link');
  await tap('nav_link', { selector: { identifier: 'lab_link' } });
  await tap('lab_link', { selector: { identifier: 'lab_toggle' } });
}
function pass(name) { checks.push(name); console.log('PASS ' + name); }
function save(benchmark, rounds, complete = false) {
  const sourceSha256 = Object.fromEntries(['app/drivers/ios-command.py', 'app/mcp/tools.mjs', 'app/automation/command-executor.cjs', 'app/mcp/server.mjs'].map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
  fs.writeFileSync('.research/compact-report.json', JSON.stringify({ date: new Date().toISOString(), hostId, deviceId, bundleId, rounds, checks, benchmark, samples, sourceSha256, complete }, null, 2));
  fs.writeFileSync('.research/compact-token-corpus.json', JSON.stringify(corpus));
}
try {
  await client.connect(transport);
  fs.mkdirSync('.research', { recursive: true });
  fs.writeFileSync('.research/compact-tool-catalog.json', JSON.stringify(await client.listTools()));
  if (process.env.MIRROR_TEST_PHASE === 'current') await read(); else await reset();
  if (['inspect', 'current'].includes(process.env.MIRROR_TEST_PHASE)) { console.log(text()); }
  else {
    const rounds = Number(process.env.MIRROR_TEST_ROUNDS || 30);
    assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 1000, 'MIRROR_TEST_ROUNDS must be an integer from 1 to 1000');
    const benchmark = [];
    // Alternate order to reduce warm-up and host-load bias.
    for (const mode of (['flows', 'lab'].includes(process.env.MIRROR_TEST_PHASE) ? [] : ['baseline', 'compact', 'compact', 'baseline'])) {
      await reset();
      const first = samples.length;
      const started = performance.now();
      const corpusStart = corpus.length;
      if (mode === 'compact') { const r = await call('snapshot'); accept(r.snapshot); }
      for (let i = 1; i <= rounds; i++) {
        const expected = expectValue('counter_label', `Count: ${i}`);
        if (mode === 'baseline') {
          await call('get_ui_tree');
          await call('tap_element', { selector: { identifier: 'counter_button' }, expected });
        } else {
          const r = await tap('counter_button', expected);
          assert(text().includes(`Count: ${i}`));
        }
      }
      const calls = samples.slice(first);
      benchmark.push({ mode, rounds, wallMs: Math.round(performance.now() - started), calls: calls.length, responseBytes: calls.reduce((n, s) => n + s.responseBytes, 0), corpusStart, corpusEnd: corpus.length, actionMs: calls.filter(s => ['act', 'tap_element'].includes(s.action)).map(s => s.wallMs) });
      pass(`${mode} ${rounds} first-attempt counter actions`);
      save(benchmark, rounds);
    }
    const unicode = 'IDBTest \u062A\u062C\u0631\u0628\u0629 \u0627\u0644\u0623\u062A\u0645\u062A\u0629 \u{1F642}';
    assert.equal(unicode.codePointAt(8), 0x062A, 'Fixture literal must contain real Arabic, not mojibake');
    assert(unicode.endsWith(String.fromCodePoint(0x1F642)), 'Fixture literal must contain the actual emoji');
    if (process.env.MIRROR_TEST_PHASE !== 'lab') {
      await reset();
      await act('fill', { ref: find('text_field'), text: unicode });
      await tap('submit_text_button');
      assert(text().includes(unicode));
      pass('Unicode fill and submit');

      await reset();
      const stale = snapshot;
      const staleRef = find('counter_button');
      await tap('counter_button', expectValue('counter_label', 'Count: 1'));
      await call('act', { operation: 'tap', snapshotId: stale.snapshotId, ref: staleRef }, 'STALE_SNAPSHOT');
      await read();
      assert(text().includes('Count: 1'));
      pass('stale snapshot refused without duplicate tap');

      await reveal('async_button');
      await tap('async_button', expectValue('async_result_label', 'Task Completed Successfully'));
      assert(text().includes('Task Completed Successfully'));
      pass('delayed async completion verified');

      await reset();
      await reveal('open_list_link');
      await tap('open_list_link', { selector: { identifier: 'selected_row_label' } });
      await reveal('row_item_45');
      await tap('row_item_45', expectValue('selected_row_label', 'Selected: Row 45'));
      pass('long list scroll and first-attempt row selection');
    }

    await lab();
    for (let i = 1; i <= 10; i++) await tap('lab_toggle', expectValue('toggle_result', i % 2 ? 'Option: On' : 'Option: Off'));
    pass('ten first-attempt toggle actions');
    await act('fill', { ref: find('lab_text'), text: unicode });
    await act('fill', { ref: find('lab_secure'), text: 'test-only-secret' });
    assert(!text().includes('test-only-secret'));
    await tap('lab_submit');
    assert(text().includes('length: 16'));
    pass('secure input redacted and correct length submitted');
    for (let i = 0; i < 5; i++) {
      await tap('duplicate_first', expectValue('lab_result', 'First duplicate'));
      await tap('duplicate_second', expectValue('lab_result', 'Second duplicate'));
    }
    pass('ten duplicate-label actions select the correct identifier');
    await reveal('disabled_button');
    await call('act', { operation: 'tap', snapshotId: snapshot.snapshotId, ref: find('disabled_button') }, 'ELEMENT_NOT_INTERACTABLE');
    pass('disabled target refused without input');
    await reveal('long_press_target');
    await act('long_press', { ref: find('long_press_target'), duration: 1, expected: expectValue('long_press_target', 'Long press: Done') });
    pass('long press');
    await reveal('sheet_button');
    await tap('sheet_button', { selector: { identifier: 'modal_title' } });
    await tap('modal_close', { selector: { identifier: 'modal_title' }, state: 'absent' });
    pass('modal sheet open and close');
    await reveal('alert_button');
    await tap('alert_button');
    const confirm = find('alert_confirm') || [...view].find(([, line]) => line.includes('"Confirm"'))?.[0];
    assert(confirm, 'Alert confirmation must be discoverable');
    await act('tap', { ref: confirm, expected: { ...expectValue('lab_result', 'Alert confirmed'), state: 'present' } });
    pass('system alert confirm');
    const image = await client.callTool({ name: 'ios_screenshot', arguments: { hostId, deviceId } });
    fs.mkdirSync('.research', { recursive: true });
    fs.writeFileSync('.research/compact-final.png', Buffer.from(image.content.find(c => c.type === 'image').data, 'base64'));
    save(benchmark, rounds, true);
    console.log(JSON.stringify({ checks, benchmark }, null, 2));
  }
} finally {
  await Promise.race([client.close(), new Promise(resolve => setTimeout(resolve, 2000))]);
  assert.equal(path.dirname(path.resolve(folder)), path.resolve(os.tmpdir()));
  fs.rmSync(folder, { recursive: true, force: true });
}
