const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Server } = require('ssh2');
const { connect } = require('../app/connections.cjs');
const net=require('node:net');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');

test('SSH streams binary uploads without treating their bytes as a script',async()=>{
  const key=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
  const bytes=crypto.randomBytes(1024*1024+17),chunks=[];
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'mirror-upload-')),file=path.join(folder,'archive');fs.writeFileSync(file,bytes);
  const server=new Server({hostKeys:[key]},client=>{
    client.on('authentication',ctx=>ctx.accept());client.on('error',()=>{});
    client.on('ready',()=>client.on('session',accept=>accept().on('exec',(accept,_reject,info)=>{
      assert.match(info.command,/^sh -c /);const stream=accept();stream.on('data',data=>chunks.push(data));
      stream.on('end',()=>{stream.write('uploaded');stream.exit(0);stream.end();});
    })));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let conn;
  try{conn=await connect({kind:'manual',host:'127.0.0.1',port:server.address().port,username:'tester'},'test-only',async()=>true,()=>{});
    assert.equal(await conn.run('cat > /test/archive',30000,undefined,{inputFile:file,quiet:true}),'uploaded');assert.deepEqual(Buffer.concat(chunks),bytes);
  }finally{conn?.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(folder,{recursive:true,force:true});}
});

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

test('real-device SSH forwarding binds loopback and restricts destination ports',async()=>{
  const key=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
  const server=new Server({hostKeys:[key]},client=>{
    client.on('authentication',ctx=>ctx.accept());client.on('error',()=>{});
    client.on('tcpip',(accept,_reject,info)=>{assert.equal(info.destIP,'127.0.0.1');assert.equal(info.destPort,17425);const stream=accept();stream.pipe(stream);});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let conn,tunnel;
  try{
    conn=await connect({kind:'manual',host:'127.0.0.1',port:server.address().port,username:'tester'},'test-only',async()=>true,()=>{});
    await assert.rejects(conn.forward([22]),/Unsupported device port/);
    tunnel=await conn.forward([17425]);
    const response=await new Promise((resolve,reject)=>{
      const socket=net.connect(tunnel.ports[0],'127.0.0.1',()=>socket.write('tunnel-test'));
      socket.on('data',data=>{resolve(data.toString());socket.destroy()});socket.on('error',reject);
    });
    assert.equal(response,'tunnel-test');
  }finally{tunnel?.close();conn?.close();await new Promise(resolve=>server.close(resolve));}
});
