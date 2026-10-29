// Read-only paired benchmark. Usage: node scripts/benchmark-simulator.cjs HOST_ID SIMULATOR_UDID
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, connectHost } = require('../app/automation/connection-profiles.cjs');
const { ensureSimulatorRuntime } = require('../app/automation/simulator-runtime.cjs');
const { execute } = require('../app/automation/command-executor.cjs');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function labels(value) {
  if (Array.isArray(value)) return value.flatMap(labels);
  if (!value || typeof value !== 'object') return [];
  return [JSON.stringify([value.identifier, value.label, value.type, value.value]), ...labels(value.elements || value.children || [])];
}

async function main() {
  const [hostId, deviceId] = process.argv.slice(2);
  const { contracts } = await import('../app/mcp/tools.mjs');
  assert(contracts.get_ui_tree.schema.safeParse({ hostId, deviceId }).success && !deviceId.startsWith('real:'), 'Supply a configured host ID and a Simulator UUID.');
  const conn = await connectHost(loadConfig(), hostId);
  const samples = [], args = { deviceId, timeoutMs: 120000 };
  const legacy = { run: conn.run.bind(conn) };
  try {
    await ensureSimulatorRuntime(conn);
    async function measure(mode, action, warmup = false) {
      const start = performance.now();
      const result = await execute(mode === 'worker' ? conn : legacy, action, args);
      const sample = { mode, action, warmup, durationMs: Math.round(performance.now() - start) };
      samples.push(sample); console.log(JSON.stringify(sample));
      return result;
    }
    for (const action of ['screenshot', 'get_ui_tree']) {
      await measure('legacy', action, true);
      await measure('worker', action, true);
      for (let round = 0; round < 3; round++) {
        const order = round % 2 ? ['worker', 'legacy'] : ['legacy', 'worker'];
        const results = {};
        for (const mode of order) results[mode] = await measure(mode, action);
        if (action === 'get_ui_tree') {
          assert.deepEqual(results.worker.tree.screen, results.legacy.tree.screen);
          assert.deepEqual(labels(results.worker.tree).sort(), labels(results.legacy.tree).sort(), 'Worker and CLI must return the same accessibility content. Keep the screen unchanged during this read-only test.');
        } else {
          assert.equal(results.worker.mimeType, results.legacy.mimeType);
        }
      }
    }
    const summary = ['screenshot', 'get_ui_tree'].map(action => {
      const legacyMs = median(samples.filter(s => s.action === action && s.mode === 'legacy' && !s.warmup).map(s => s.durationMs));
      const workerMs = median(samples.filter(s => s.action === action && s.mode === 'worker' && !s.warmup).map(s => s.durationMs));
      return { action, legacyMedianMs: legacyMs, workerMedianMs: workerMs, reductionPercent: Math.round((1 - workerMs / legacyMs) * 100) };
    });
    const output = path.join(__dirname, '../release/performance/worker-benchmark.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ recordedAt: new Date().toISOString(), samples, summary, accessibilityParity: true }, null, 2) + '\n');
    console.log(JSON.stringify({ summary, accessibilityParity: true, output }));
  } finally { conn.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
