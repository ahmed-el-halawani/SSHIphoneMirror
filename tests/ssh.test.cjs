const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Server } = require('ssh2');
const { connect } = require('../app/connections.cjs');

test('manual SSH verifies host identity, authenticates, and executes scripts without a local shell', async () => {
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  let received = '', verified = false;
  const server = new Server({ hostKeys: [key] }, client => {
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'test-only') ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      accept().on('exec', (accept, _reject, info) => {
        assert.equal(info.command, 'sh -s');
        const stream = accept();
        stream.on('data', data => { received += data; });
        stream.on('end', () => { stream.write('MIRROR_JSON={"ok":true}\n'); stream.exit(0); stream.end(); });
      });
    }));
    client.on('error', () => {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let connection;
  try {
    connection = await connect({ kind: 'manual', host: '127.0.0.1', port: server.address().port, username: 'tester' },
      'test-only', async hash => { assert.match(hash, /^SHA256:/); verified = true; return true; }, () => {});
    assert.match(await connection.run('echo "test"'), /"ok":true/);
    assert.equal(received, 'echo "test"\n'); assert.equal(verified, true);
  } finally { connection?.close(); await new Promise(resolve => server.close(resolve)); }
});

test('manual SSH refuses an untrusted host key', async () => {
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const server = new Server({ hostKeys: [key] }, client => client.on('error', () => {}));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(connect({ kind: 'manual', host: '127.0.0.1', port: server.address().port, username: 'tester' },
      'test-only', async () => false, () => {}), /verification failed/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
