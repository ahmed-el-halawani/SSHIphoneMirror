const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { loadBundle, prepareWda } = require('../app/automation/wda-runtime.cjs');

test('the signed WDA IPA is pinned and included in application packaging', () => {
  const manifest = loadBundle();
  const bytes = fs.readFileSync('vendor/wda/' + manifest.archive);
  assert.equal(bytes.length, manifest.bytes);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), manifest.sha256);
  assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  assert(require('../package.json').build.files.includes('vendor/**'));
});

test('a prepared Mac reuses the WDA package without uploading it again', async () => {
  let calls = 0;
  await prepareWda({ run: async (_script, _timeout, _signal, options) => {
    calls++;
    assert.equal(options.inputFile, undefined);
    return 'ready\n';
  } });
  assert.equal(calls, 1);
});

test('an interrupted WDA upload is cleaned up without attempting extraction', async () => {
  const calls = [];
  await assert.rejects(prepareWda({ run: async (script, _timeout, _signal, options) => {
    calls.push(script);
    if (calls.length === 1) return 'missing\n';
    if (options.inputFile) throw Error('Upload interrupted');
    return '';
  } }), /Upload interrupted/);
  assert.equal(calls.length, 3);
  assert.match(calls[2], /^rm -f /);
});
