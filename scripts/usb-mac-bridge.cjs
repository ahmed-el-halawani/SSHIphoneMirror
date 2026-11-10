const bridge = require('../app/automation/usb-bridge.cjs');
if (require.main === module) bridge.main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = bridge;
