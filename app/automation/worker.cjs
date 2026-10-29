const { readFileSync } = require('node:fs');
const path = require('node:path');
const source = readFileSync(path.join(__dirname, '../drivers/ios-command.py'), 'utf8') + '\n' + readFileSync(path.join(__dirname, '../drivers/ios-worker.py'), 'utf8');
const command = `exec "$HOME/.local/share/iphone-mirror/idb/current/python/bin/python" -I -u -B -c 'import base64,sys;exec(base64.b64decode(sys.stdin.buffer.readline(262144)),{"__name__":"iphone_mirror_worker"})'`;

class Worker {
  constructor(conn) {
    this.conn = conn;
    // shortcut: one serialized worker per host; split by device when parallel Simulator control is needed.
    this.queue = Promise.resolve();
    this.sequence = 0;
    this.stream = null;
    this.pending = null;
    this.closed = false;
  }

  request(action, args, timeout, signal) {
    const deadline = Date.now() + timeout;
    const result = this.queue.then(() => this.perform(action, args, deadline, signal));
    this.queue = result.catch(() => {});
    return result;
  }

  perform(action, args, deadline, signal) {
    if (this.closed || signal?.aborted || Date.now() >= deadline) return Promise.reject(Error('Worker request cancelled or expired before dispatch.'));
    const id = ++this.sequence;
    const payload = JSON.stringify({ id, args: { action, ...args } }) + '\n';
    if (Buffer.byteLength(payload) > 65536) return Promise.reject(Error('Worker request exceeds its size limit.'));
    return new Promise((resolve, reject) => {
      const abort = () => this.drop(Error('Worker request interrupted; inspect state before retrying.'));
      const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
      const finish = (error, value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending = null;
        error ? reject(error) : resolve(value);
      };
      this.pending = { id, finish, chunks: [], bytes: 0, limit: action === 'screenshot' ? 24 * 1024 * 1024 : 4 * 1024 * 1024 };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const send = stream => {
        if (this.pending?.id !== id) { stream.destroy(); return; }
        stream.write(payload, error => { if (error && this.pending?.id === id && this.stream === stream) this.drop(Error('Worker input failed.')); });
      };
      if (this.stream) { send(this.stream); return; }
      Promise.resolve().then(() => this.conn.open(command)).then(stream => {
        if (this.closed || this.pending?.id !== id) { stream.destroy(); return; }
        this.stream = stream;
        stream.on('data', data => { if (this.stream === stream) this.receive(data); });
        stream.on('error', () => { if (this.stream === stream) this.drop(Error('Worker connection failed.')); });
        stream.on('close', () => { if (this.stream === stream) this.drop(Error('Worker connection closed.')); });
        stream.stderr?.resume();
        stream.write(Buffer.from(source).toString('base64') + '\n');
        send(stream);
      }).catch(() => { if (this.pending?.id === id) this.drop(Error('Could not open the Mac automation worker.')); });
    });
  }

  receive(data) {
    const pending = this.pending;
    if (!pending) { this.drop(Error('Unexpected worker output.')); return; }
    pending.bytes += data.length;
    if (pending.bytes > pending.limit) { this.drop(Error('Worker response exceeds its size limit.')); return; }
    pending.chunks.push(data);
    const newline = data.indexOf(10);
    if (newline < 0) return;
    try {
      if (newline !== data.length - 1) throw Error();
      const response = JSON.parse(Buffer.concat(pending.chunks).toString('utf8'));
      if (response.id !== pending.id || !response.result || typeof response.result.ok !== 'boolean') throw Error();
      pending.finish(null, JSON.stringify(response.result));
    } catch { this.drop(Error('Invalid worker response.')); }
  }

  drop(error) {
    const stream = this.stream;
    this.stream = null;
    this.pending?.finish(error);
    stream?.destroy();
  }

  close() {
    this.closed = true;
    this.drop(Error('Mac automation worker closed.'));
  }
}

module.exports = { Worker };
