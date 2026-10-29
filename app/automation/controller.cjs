const profiles = require('./connection-profiles.cjs');
const { execute, MUTATIONS } = require('./command-executor.cjs');
const { ensureSimulatorRuntime } = require('./simulator-runtime.cjs');
const { requestAgentControl } = require('./viewer-reservation.cjs');

class Controller {
  constructor(config = profiles.loadConfig(), desktop = null) {
    this.config = config;
    this.desktop = desktop;
    this.readyHosts = new Map();
    this.connections = new Map();
    this.connecting = new Map();
  }

  async getHostConnection(hostId) {
    let entry = this.connections.get(hostId);
    if (!entry) {
      let pending = this.connecting.get(hostId);
      if (!pending) {
        pending = profiles.connectHost(this.config, hostId).then(conn => {
          if (this.connecting.get(hostId) !== pending) { conn.close(); throw Error('Connection closed before startup finished.'); }
          const ready = { conn, timer: null, active: 0 };
          this.connections.set(hostId, ready);
          return ready;
        }).finally(() => { if (this.connecting.get(hostId) === pending) this.connecting.delete(hostId); });
        this.connecting.set(hostId, pending);
      }
      entry = await pending;
    }
    if (this.connections.get(hostId) !== entry) throw Error('Connection closed before dispatch.');
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.active++;
    return entry.conn;
  }

  closeHost(hostId) {
    this.connecting.delete(hostId);
    const entry = this.connections.get(hostId);
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      this.connections.delete(hostId);
      try { entry.conn?.close(); } catch {}
    }
  }

  closeAll() {
    for (const hostId of new Set([...this.connections.keys(), ...this.connecting.keys()])) {
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
      if (MUTATIONS.has(action) && !this.config.hosts.some(h => h.id === args.hostId && h.control)) throw Object.assign(Error('Device control is disabled. Enable control for this host in the local automation configuration.'), { code: 'PERMISSION_DENIED' });
      if (this.desktop) await this.desktop(action, args);
      if (action === 'list_hosts') return { ...metadata, ok: true, status: 'success', hosts: await profiles.listHosts(this.config), durationMs: Math.round(performance.now() - start) };
      conn = await this.getHostConnection(args.hostId);
      if(args.deviceId && !args.deviceId.startsWith('real:')) {
        if (!this.readyHosts.has(args.hostId)) {
          const ready = ensureSimulatorRuntime(conn,()=>{},signal).catch(error => { this.readyHosts.delete(args.hostId); throw error; });
          this.readyHosts.set(args.hostId, ready);
        }
        await this.readyHosts.get(args.hostId);
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
      let viewerWarning;
      if (action === 'start_session' && this.desktop) {
        try { await this.desktop(action, args, 'after'); }
        catch (error) { viewerWarning = error.message; }
      }
      return { ...metadata, ...result, ...(viewerWarning ? { viewerWarning } : {}), status: 'success', durationMs: Math.round(performance.now() - start) };
    } catch (error) {
      return { ...metadata, ok: false, status: 'error', executed: error.executed ?? (error.code==='OUTCOME_UNKNOWN'?null:false), verified: error.verified ?? false, error: { code: error.code || 'CONFIGURATION_ERROR', message: error.message, ...(error.causeCode?{causeCode:error.causeCode}:{}), ...(error.stage?{stage:error.stage}:{}) }, durationMs: Math.round(performance.now() - start) };
    } finally {
      const entry = this.connections.get(args.hostId);
      if (conn && entry?.conn === conn && --entry.active === 0) {
        entry.timer = setTimeout(() => this.closeHost(args.hostId), 300000);
        entry.timer.unref?.();
      }
    }
  }
}
module.exports = { Controller };
