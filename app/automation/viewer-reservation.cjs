const { randomUUID } = require('node:crypto');
const { execute } = require('./command-executor.cjs');
async function reserveViewer(conn, deviceId) {
  const token = randomUUID();
  await execute(conn, 'reserve_viewer', { deviceId, token });
  return async () => { await execute(conn, 'release_viewer', { deviceId, token }); };
}
module.exports = { reserveViewer };
