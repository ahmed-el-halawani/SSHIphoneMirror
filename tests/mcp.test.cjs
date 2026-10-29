const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('standalone MCP negotiates stdio, lists tools, returns structured results and closes', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'mirror-test', version: '1.0' });
  const source = `import {serveStdio} from '@modelcontextprotocol/server/stdio'; import {createServer} from './app/mcp/server.mjs'; const handle=serveStdio(()=>createServer()); process.stdin.once('end',()=>handle.close());`;
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--input-type=module', '-e', source], env: { ...process.env, IPHONE_MIRROR_CONFIG: path.join(require('node:os').tmpdir(), 'absent-mirror-test-config.json') }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 16);
    assert.equal(tools.some(t => /shell|uninstall|erase|reset/.test(t.name)), false);
    const hosts = await client.callTool({ name: 'ios_list_hosts', arguments: {} });
    assert.deepEqual(hosts.structuredContent.hosts, []);
    assert.equal(hosts.structuredContent.ok, true);
    const denied = await client.callTool({ name: 'ios_tap', arguments: { hostId: 'mac', deviceId: '8AA89128-E540-44BB-82FD-43999DDC6838', x: 1, y: 1 } });
    assert.equal(denied.isError, true);
    assert.equal(denied.structuredContent.error.code, 'PERMISSION_DENIED');
  } finally { await client.close(); }
});
