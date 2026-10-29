const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Duplex } = require('node:stream');
const { Worker } = require('../app/automation/worker.cjs');
const { execute } = require('../app/automation/command-executor.cjs');

test('Python worker resets state, bounds input and preserves direct SDK behavior', () => {
  const result = require('node:child_process').spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['tests/worker.test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

function connection(handler) {
  const requests = [], streams = [];
  return {
    requests, streams,
    async open(command) {
      assert.match(command, /python.*-I -u/);
      assert.match(command, /-B -c/);
      let buffer = '', booted = false;
      const stream = new Duplex({
        read() {},
        write(chunk, _encoding, done) {
          buffer += chunk.toString();
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!booted) { assert.match(Buffer.from(line, 'base64').toString(), /def serve\(\)/); booted = true; continue; }
            const request = JSON.parse(line); requests.push(request);
            handler(request, stream, streams.length);
          }
          done();
        }
      });
      streams.push(stream);
      return stream;
    }
  };
}
function reply(stream, id, result = { ok: true }) {
  const bytes = Buffer.from(JSON.stringify({ id, result }) + '\n');
  stream.push(bytes.subarray(0, 7));
  stream.push(bytes.subarray(7));
}

test('worker reuses one channel and serializes requests with intact Unicode', async () => {
  let active = 0;
  const conn = connection((request, stream) => {
    assert.equal(active++, 0);
    setImmediate(() => { active--; reply(stream, request.id, { ok: true, text: request.args.text }); });
  });
  const worker = new Worker(conn);
  try {
    const text = 'تجربة 🙂\n" $(not-a-shell-command)';
    const results = await Promise.all([worker.request('type_text', { text }, 1000), worker.request('get_ui_tree', {}, 1000)]);
    assert.equal(JSON.parse(results[0]).text, text);
    assert.equal(conn.streams.length, 1);
    assert.deepEqual(conn.requests.map(r => r.id), [1, 2]);
  } finally { worker.close(); }
});

test('worker disconnect never replays a mutation; a later read opens a new channel', async () => {
  const conn = connection((request, stream, count) => {
    setImmediate(() => count === 1 ? stream.destroy() : reply(stream, request.id));
  });
  try {
    await assert.rejects(execute(conn, 'tap', { deviceId: 'simulator', x: 1, y: 1 }), e => e.code === 'OUTCOME_UNKNOWN');
    assert.equal(conn.requests.length, 1);
    assert.equal((await execute(conn, 'get_ui_tree', { deviceId: 'simulator' })).ok, true);
    assert.equal(conn.requests.length, 2);
    assert.equal(conn.streams.length, 2);
  } finally { conn.automationWorker?.close(); }
});

test('worker timeout drops the channel and does not resend input', async () => {
  const conn = connection(() => {}), worker = new Worker(conn);
  try {
    await assert.rejects(worker.request('tap', {}, 20), /interrupted/);
    assert.equal(conn.requests.length, 1);
    assert.equal(conn.streams[0].destroyed, true);
  } finally { worker.close(); }
});

test('a late channel-open failure cannot cancel a later request', async () => {
  const conn = connection((request, stream) => setTimeout(() => reply(stream, request.id), 15));
  const open = conn.open.bind(conn);
  let failFirst, opens = 0;
  conn.open = command => ++opens === 1 ? new Promise((_resolve, reject) => { failFirst = reject; }) : open(command);
  const worker = new Worker(conn);
  try {
    await assert.rejects(worker.request('get_ui_tree', {}, 20), /interrupted/);
    const next = worker.request('get_ui_tree', {}, 1000);
    while (opens < 2) await new Promise(setImmediate);
    failFirst(Error('late failure'));
    assert.equal(JSON.parse(await next).ok, true);
    assert.equal(conn.requests.length, 1);
  } finally { worker.close(); }
});

test('cancelled queued actions are never dispatched and closing prevents restart', async () => {
  let complete;
  const conn = connection((request, stream) => { complete = () => reply(stream, request.id); });
  const worker = new Worker(conn), abort = new AbortController();
  const first = worker.request('get_ui_tree', {}, 1000);
  while (!complete) await new Promise(setImmediate);
  const second = worker.request('tap', {}, 1000, abort.signal);
  const rejected = assert.rejects(second, /before dispatch/);
  abort.abort(); complete();
  await first; await rejected;
  assert.equal(conn.requests.length, 1);
  worker.close();
  await assert.rejects(worker.request('tap', {}, 1000), /before dispatch/);
  assert.equal(conn.streams.length, 1);
});

test('worker rejects mismatched response IDs, oversized responses and requests', async () => {
  for (const handler of [
    (request, stream) => setImmediate(() => reply(stream, request.id + 1)),
    (_request, stream) => setImmediate(() => stream.push(Buffer.alloc(4 * 1024 * 1024 + 1)))
  ]) {
    const conn = connection(handler), worker = new Worker(conn);
    try { await assert.rejects(worker.request('get_ui_tree', {}, 1000), /Invalid worker response|size limit/); }
    finally { worker.close(); }
  }
  const conn = connection(() => {}), worker = new Worker(conn);
  await assert.rejects(worker.request('type_text', { text: 'x'.repeat(65536) }, 1000), /size limit/);
  assert.equal(conn.streams.length, 0);
  worker.close();
});
