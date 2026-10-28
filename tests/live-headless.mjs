// Opt-in: runs only against the disposable TestFixture app on the selected Simulator.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const hostId = process.env.MIRROR_TEST_HOST;
const deviceId = process.env.MIRROR_TEST_DEVICE;
assert(hostId && deviceId, 'Set MIRROR_TEST_HOST and MIRROR_TEST_DEVICE explicitly.');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-live-'));
const config = path.join(folder, 'automation.json');
fs.writeFileSync(config, JSON.stringify({ hosts: [{ id: hostId, kind: 'mcp', hostId, control: true }] }));
const client = new Client({ name: 'mirror-live-validation', version: '1.0' });
const transport = new StdioClientTransport({ command: process.env.MIRROR_TEST_EXECUTABLE || process.execPath, args: process.env.MIRROR_TEST_EXECUTABLE ? [path.join(path.dirname(process.env.MIRROR_TEST_EXECUTABLE), 'resources/app.asar/app/mcp/server.mjs')] : [path.resolve('app/mcp/server.mjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', IPHONE_MIRROR_CONFIG: config }, stderr: 'pipe' });
transport.stderr?.on('data', data => process.stderr.write(data));
const samples = [];
async function call(action, args = {}) {
  const result = await client.callTool({ name: `ios_${action}`, arguments: { hostId, deviceId, ...args } }, undefined, { timeout: 150000 });
  const data = result.structuredContent;
  assert.equal(result.isError, false, JSON.stringify(data));
  samples.push({ action, durationMs: data.durationMs });
  return result;
}
const tap = (identifier, extra = {}) => call('tap_element', { selector: { identifier }, ...extra });
const wait = (identifier, value) => call('wait_for', { selector: { identifier }, ...(value ? { value } : {}) });
const reset = async () => { await call('terminate_app', { bundleId: 'com.evaluation.TestFixture' }); await call('launch_app', { bundleId: 'com.evaluation.TestFixture' }); };
try {
  await client.connect(transport);
  assert((await client.listTools()).tools.length === 16);
  const hosts = await client.callTool({ name: 'ios_list_hosts', arguments: {} });
  assert(hosts.structuredContent.hosts.some(h => h.hostId === hostId));
  const devices = await client.callTool({ name: 'ios_list_devices', arguments: { hostId } });
  assert(devices.structuredContent.devices.some(d => d.deviceId === deviceId));
  const capabilities=(await call('get_capabilities')).structuredContent;
  const catalog=JSON.parse(fs.readFileSync('vendor/idb/catalog.json','utf8'));
  assert(catalog.bundles.some(bundle=>bundle.bundleId===capabilities.runtimeId),'Simulator must use a shipped runtime');
  await reset();
  await wait('counter_button');
  for (let i = 0; i < 10; i++) await tap('counter_button');
  await wait('counter_label', 'Count: 10');
  console.log('PASS A: ten exact element taps, verified Count: 10');
  const text = 'IDBTest تجربة الأتمتة 🙂';
  await call('type_text', { selector: { identifier: 'text_field' }, text });
  await tap('submit_text_button');
  // SwiftUI may wrap RTL substrings in Unicode isolation markers.
  const tree = (await call('get_ui_tree')).structuredContent.tree;
  function walk(value) { return Array.isArray(value) ? value.flatMap(walk) : value && typeof value === 'object' ? [value, ...walk(value.elements || value.children || [])] : []; }
  const submitted = walk(tree).find(n => n.identifier === 'submitted_text_label');
  assert(submitted?.label?.replace(/[\u2066-\u2069]/g, '').includes(text), 'Arabic/emoji submission must match');
  console.log('PASS B: Arabic and emoji through AX set-value, submitted and verified');
  await reset();
  await tap('nav_link');
  await wait('detail_screen_title', 'Detail Screen Content');
  await call('tap_element', { selector: { label: 'IDB Evaluation', type: 'Button' } });
  await wait('counter_button');
  console.log('PASS C: navigation push and back by element');
  await tap('open_list_link');
  await tap('row_item_45', { maxScrolls: 15, timeoutMs: 120000, expected: { selector: { identifier: 'selected_row_label' }, value: 'Selected: Row 45' } });
  console.log('PASS D: bounded scrolling to row 45 and verified selection');
  await reset();
  await tap('async_button', { expected: { selector: { identifier: 'async_result_label' }, value: 'Task Completed Successfully' } });
  console.log('PASS E: async operation verified within deadline');
  const image = (await call('screenshot')).content.find(c => c.type === 'image');
  assert(image && Buffer.from(image.data, 'base64').subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  if(process.env.MIRROR_TEST_SCREENSHOT)fs.writeFileSync(process.env.MIRROR_TEST_SCREENSHOT, Buffer.from(image.data, 'base64'));
  console.log(JSON.stringify({ passed: 5, samples }, null, 2));
} finally {
  await client.close();
  fs.rmSync(folder, { recursive: true, force: true });
}
