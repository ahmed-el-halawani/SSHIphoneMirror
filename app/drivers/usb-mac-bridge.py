"""Experimental CoreDevice relays over an SSH stdio channel (Python 3.9+)."""
import asyncio
import base64
import contextlib
import ipaddress
import json
import re
import sys
import time


def valid_port(port):
    return type(port) is int and 49152 <= port <= 65535


class Bridge:
    def __init__(self, config):
        self.bind = str(ipaddress.IPv4Address(config['bind']))
        self.record = config['record']
        self.mobile = config.get('mobile', [])
        self.streams = {}
        self.servers = {}
        self.seen = {}
        self.stream_ports = {}
        self.next_id = 0
        self.children = []

    def send(self, **message):
        print(json.dumps(message), flush=True)

    def identity(self):
        self.next_id += 1
        return self.next_id

    async def accept(self, port, reader, writer):
        peer = writer.get_extra_info('peername')[0]
        if peer not in (self.bind, '127.0.0.1') or len(self.streams) >= 128:
            writer.close()
            return
        key = self.identity()
        self.streams[key] = writer
        self.stream_ports[key] = port
        self.send(op='open', id=key, port=port)
        try:
            while True:
                chunk = await reader.read(32768)
                if not chunk:
                    self.send(op='end', id=key)
                    break
                self.send(op='data', id=key, data=base64.b64encode(chunk).decode())
            await writer.wait_closed()
        except (OSError, ConnectionError):
            pass
        finally:
            self.streams.pop(key, None)
            self.stream_ports.pop(key, None)
            self.seen[port] = time.monotonic()
            writer.close()
            self.send(op='close', id=key)

    async def listen(self, port):
        self.seen[port] = time.monotonic()
        mobile_port = type(port) is int and 1024 <= port <= 65535 and any(item['port'] == port for item in self.mobile)
        if not (valid_port(port) or mobile_port) or port in self.servers or len(self.servers) >= 64:
            return
        server = await asyncio.start_server(lambda r, w: self.accept(port, r, w), self.bind, port)
        self.servers[port] = server
        self.send(op='status', message='TCP relay listening', port=port)

    async def reap(self):
        while True:
            await asyncio.sleep(30)
            for port, server in list(self.servers.items()):
                if port not in [self.record['port']] + [item['port'] for item in self.mobile] and port not in self.stream_ports.values() and time.monotonic() - self.seen[port] > 120:
                    server.close()
                    await server.wait_closed()
                    del self.servers[port]
                    self.seen.pop(port, None)

    async def endpoints(self):
        pattern = re.compile(re.escape(self.bind) + r':(\d+)')
        child = await asyncio.create_subprocess_exec(
            '/usr/bin/log', 'stream', '--style', 'ndjson', '--predicate',
            'eventMessage CONTAINS "tunnel endpoint"',
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        self.children.append(child)
        async for line in child.stdout:
            for match in pattern.finditer(line.decode('utf-8', 'replace')):
                port = int(match.group(1))
                for candidate in range(port, port + 5):
                    try:
                        await self.listen(candidate)
                    except OSError:
                        self.send(op='status', message='Tunnel port is already in use', port=candidate)

    async def seed_endpoints(self):
        # Reuse recent endpoint observations so the first reconnect need not fail to reveal its port.
        child = await asyncio.create_subprocess_exec(
            '/usr/bin/log', 'show', '--last', '60s', '--style', 'compact', '--predicate',
            'eventMessage CONTAINS "tunnel endpoint"',
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        try:
            output, _ = await asyncio.wait_for(child.communicate(), 5)
            ports = re.findall(re.escape(self.bind) + r':(\d+)', output.decode('utf-8', 'replace'))
            for port in sorted({int(port) for port in ports})[-4:]:
                for candidate in range(port, port + 5):
                    with contextlib.suppress(OSError):
                        await self.listen(candidate)
        finally:
            if child.returncode is None:
                child.kill()
                await child.wait()

    async def incoming(self):
        loop = asyncio.get_running_loop()
        while True:
            line = await loop.run_in_executor(None, sys.stdin.buffer.readline, 100000)
            if not line:
                return
            if not line.endswith(b'\n'):
                raise ValueError('Oversized bridge message')
            message = json.loads(line)
            await self.dispatch(message)

    async def dispatch(self, message):
        writer = self.streams.get(message.get('id'))
        if writer is None:
            return
        try:
            if message.get('op') == 'data':
                writer.write(base64.b64decode(message['data'], validate=True))
                await writer.drain()
            elif message.get('op') == 'end':
                if writer.can_write_eof() and not writer.is_closing():
                    writer.write_eof()
            elif message.get('op') == 'close':
                writer.close()
        except (OSError, ConnectionError):
            writer.close()

    async def run(self):
        watcher = asyncio.create_task(self.endpoints())
        reaper = asyncio.create_task(self.reap())
        try:
            await self.listen(self.record['port'])
            await self.seed_endpoints()
            record = self.record
            instance = record['instance'].split('._remotepairing._tcp.')[0]
            # Publish the captured identity; pairing is still verified by Apple's tools.
            child = await asyncio.create_subprocess_exec(
                '/usr/bin/dns-sd', '-P', instance, '_remotepairing._tcp', 'local',
                str(record['port']), 'iphone-mirror-usb.local', self.bind,
                *[str(key) + '=' + str(value) for key, value in record['properties'].items()],
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            self.children.append(child)
            for mobile in self.mobile:
                await self.listen(mobile['port'])
                instance = mobile['instance'].split('._apple-mobdev2._tcp.')[0]
                child = await asyncio.create_subprocess_exec(
                    '/usr/bin/dns-sd', '-P', instance, '_apple-mobdev2._tcp', 'local',
                    str(mobile['port']), 'iphone-mirror-usb.local', self.bind,
                    *[str(key) + '=' + str(value) for key, value in mobile['properties'].items()],
                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                self.children.append(child)
            self.send(op='status', message='USB phone advertised to CoreDevice')
            await self.incoming()
        finally:
            watcher.cancel()
            reaper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher
            with contextlib.suppress(asyncio.CancelledError):
                await reaper
            for writer in list(self.streams.values()):
                writer.close()
            for server in self.servers.values():
                server.close()
                await server.wait_closed()
            for child in self.children:
                if child.returncode is None:
                    with contextlib.suppress(ProcessLookupError):
                        child.terminate()
                    await child.wait()


if __name__ == '__main__':
    config = json.loads(sys.stdin.buffer.readline(65536))
    asyncio.run(Bridge(config).run())
