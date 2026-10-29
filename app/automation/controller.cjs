const profiles = require('./connection-profiles.cjs');
const { execute, MUTATIONS } = require('./command-executor.cjs');
const { ensureSimulatorRuntime } = require('./simulator-runtime.cjs');
const { requestAgentControl } = require('./viewer-reservation.cjs');

class Controller {
  constructor(config = profiles.loadConfig()) {
    this.config = config;
    this.readyHosts = new Set();
    this.connections = new Map();
  }

  async getHostConnection(hostId) {
    const existing = this.connections.get(hostId);
    if (existing && existing.conn) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.closeHost(hostId), 60000);
      existing.timer.unref?.();
      return existing.conn;
    }
    const conn = await profiles.connectHost(this.config, hostId);
    const timer = setTimeout(() => this.closeHost(hostId), 60000);
    timer.unref?.();
    const entry = { conn, timer };
    this.connections.set(hostId, entry);
    return conn;
  }

  closeHost(hostId) {
    const entry = this.connections.get(hostId);
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      this.connections.delete(hostId);
      try { entry.conn?.close(); } catch {}
    }
  }

  closeAll() {
    for (const hostId of Array.from(this.connections.keys())) {
      this.closeHost(hostId);
    }
  }

  async call(action, args = {}, signal) {
    const start = performance.now();
    const metadata = { hostId: args.hostId || null, deviceId: args.deviceId || null, driver: args.deviceId?.startsWith('real:') ? 'wda' : 'idb', action };
    let conn;
    try {
      const { contracts } = await import('../mcp/tools.mjs');
      if(!contracts[action])throw Object.assign(Error('Unknown automation action.'),{code:'UNSUPPORTED'});
      const parsed=contracts[action].schema.safeParse(args);
      if(!parsed.success)throw Object.assign(Error('Invalid automation arguments.'),{code:'INVALID_ARGUMENT'});
      args=parsed.data;
      if (action === 'list_hosts') return { ...metadata, ok: true, status: 'success', hosts: await profiles.listHosts(this.config), durationMs: Math.round(performance.now() - start) };
      if (MUTATIONS.has(action) && !this.config.hosts.some(h => h.id === args.hostId && h.control)) throw Object.assign(Error('Device control is disabled. Enable control for this host in the local automation configuration.'), { code: 'PERMISSION_DENIED' });
      conn = await this.getHostConnection(args.hostId);
      if(args.deviceId && !args.deviceId.startsWith('real:') && !this.readyHosts.has(args.hostId)) {
        await ensureSimulatorRuntime(conn,()=>{},signal);
        this.readyHosts.add(args.hostId);
      }
      let result;
      try {result=await execute(conn, action, args, signal);}
      catch(error) {
        if(!MUTATIONS.has(action)||error.code!=='VIEWER_HANDOFF_REQUIRED'||error.executed!==false) {
          if (error.code === 'CONNECTION_FAILED') {
            this.closeHost(args.hostId);
          }
          throw error;
        }
        await requestAgentControl(conn,args.deviceId,signal);
        // The first attempt stopped at the reservation check, before dispatch.
        result=await execute(conn,action,args,signal);
      }
      return { ...metadata, ...result, status: 'success', durationMs: Math.round(performance.now() - start) };
    } catch (error) {
      return { ...metadata, ok: false, status: 'error', executed: error.executed ?? (error.code==='OUTCOME_UNKNOWN'?null:false), verified: error.verified ?? false, error: { code: error.code || 'CONFIGURATION_ERROR', message: error.message, ...(error.causeCode?{causeCode:error.causeCode}:{}), ...(error.stage?{stage:error.stage}:{}) }, durationMs: Math.round(performance.now() - start) };
    }
  }
}
module.exports = { Controller };
