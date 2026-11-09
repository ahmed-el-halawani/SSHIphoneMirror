const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

test('compact snapshots, stale references, settling, privacy and no-replay checks', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['tests/compact.test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('compact MCP validates operations and requires host control', async () => {
  const { contracts } = await import('../app/mcp/tools.mjs');
  const { Controller } = require('../app/automation/controller.cjs');
  const args = { hostId: 'mac', deviceId: '8AA89128-E540-44BB-82FD-43999DDC6838', snapshotId: '0123456789abcdef', operation: 'tap', ref: '@e1~01234567' };
  assert(contracts.act.schema.safeParse(args).success);
  for (const bad of [{ ...args, ref: undefined }, { ...args, operation: 'fill' }, { ...args, operation: 'scroll' }, { ...args, deviceId: 'real:00008140-001645D80A10801C' }, { ...args, command: 'anything' }]) {
    assert.equal(contracts.act.schema.safeParse(bad).success, false);
  }
  const controller = new Controller({ hosts: [{ id: 'mac', control: false }] });
  controller.getHostConnection = () => assert.fail('Denied actions must not connect');
  const result = await controller.call('act', args);
  assert.equal(result.error.code, 'PERMISSION_DENIED');
});
