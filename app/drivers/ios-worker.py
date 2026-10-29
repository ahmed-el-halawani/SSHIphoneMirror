"""Connection-scoped worker: JSON on SSH stdio, no service or listening socket."""
import asyncio
import concurrent.futures
import logging
import signal
import threading


class IDBBridge:
    def __init__(self, driver):
        sys.pycache_prefix = str(driver.session / 'pycache')
        sys.dont_write_bytecode = False
        import idb.common.constants as constants
        constants.BASE_IDB_FILE_PATH = str(driver.session)
        constants.IDB_STATE_FILE_PATH = str(driver.session / 'state')
        constants.IDB_LOGS_PATH = str(driver.session / 'logs')
        constants.IDB_PID_PATH = str(driver.session / 'pid')
        from idb.grpc.management import ClientManager
        from idb.common.types import AccessibilityBackend, AccessibilityClientType, AccessibilityInfoOptions, AccessibilityOutputFormat, AccessibilityPoint
        self.Manager = ClientManager
        self.Backend, self.ClientType = AccessibilityBackend, AccessibilityClientType
        self.Options, self.Format, self.Point = AccessibilityInfoOptions, AccessibilityOutputFormat, AccessibilityPoint
        self.runtime_id = driver.runtime_id
        self.companion = str(driver.companion)
        self.clients = {}
        self.contexts = contextlib.AsyncExitStack()
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)
        self.thread.start()

    async def execute(self, device, args):
        if device not in self.clients:
            manager = self.Manager(companion_path=self.companion, logger=logging.getLogger('iphone-mirror'))
            self.clients[device] = await self.contexts.enter_async_context(manager.from_udid(udid=device))
        client = self.clients[device]
        if args[0] == 'screenshot':
            image = await client.screenshot()
            if len(image) > LIMIT:
                fail('OUTPUT_TOO_LARGE', 'Screenshot exceeds 16 MiB.')
            pathlib.Path(args[1]).write_bytes(image)
            return b''
        verb = args[1]
        if verb in ('describe-all', 'describe-point', 'set-value'):
            api = args[args.index('--api') + 1]
            backend = self.Backend.AX if api == 'ax' else self.Backend.AX_CORESIMULATOR
            point = self.Point(x=int(args[2]), y=int(args[3])) if verb != 'describe-all' else None
            if verb == 'set-value':
                await client.accessibility_set_value(target=point, value=args[args.index('--value') + 1], backend=backend)
                return b''
            options = self.Options(backend=backend, format=self.Format.COMPLETE, client_type=self.ClientType.XCTEST)
            result = await client.accessibility_info(target=point, options=options)
            encoded = result.json.encode()
            if len(encoded) > LIMIT:
                fail('OUTPUT_TOO_LARGE', 'Accessibility output exceeds 16 MiB.')
            return encoded
        if verb == 'tap':
            duration = float(args[args.index('--duration') + 1]) if '--duration' in args else None
            await client.tap(x=int(args[2]), y=int(args[3]), duration=duration)
        elif verb == 'swipe':
            await client.swipe(p_start=(int(args[2]), int(args[3])), p_end=(int(args[4]), int(args[5])), duration=float(args[args.index('--duration') + 1]))
        return b''

    def call(self, driver, args):
        remaining = driver.deadline - time.monotonic()
        if remaining <= 0:
            fail('TIMEOUT', 'Device operation reached its deadline.')
        task = asyncio.run_coroutine_threadsafe(asyncio.wait_for(self.execute(driver.device, args), remaining), self.loop)
        try:
            return task.result(timeout=remaining + 1)
        except (concurrent.futures.TimeoutError, asyncio.TimeoutError):
            task.cancel()
            fail('TIMEOUT', 'Device operation reached its deadline; inspect state before retrying actions.')
        except Failure:
            raise
        except Exception:
            fail('DRIVER_ERROR', 'The device command failed. Inspect state before retrying actions.')

    def close(self):
        try:
            asyncio.run_coroutine_threadsafe(self.contexts.aclose(), self.loop).result(timeout=3)
        finally:
            self.loop.call_soon_threadsafe(self.loop.stop)
            self.thread.join(timeout=3)
            if not self.thread.is_alive():
                self.loop.close()


bridge = None


class WorkerSimulator(Simulator):
    def cli(self, *args):
        global bridge, STAGE
        if args[0] != 'screenshot' and not (args[0] == 'ui' and args[1] in ('describe-all', 'describe-point', 'tap', 'swipe', 'set-value')):
            return super().cli(*args)
        STAGE = 'idb.' + args[0] + ('.' + args[1] if args[0] == 'ui' else '')
        if bridge is None:
            bridge = IDBBridge(self)
        if bridge.runtime_id != self.runtime_id:
            fail('COMPATIBILITY_MISMATCH', 'Simulator runtime changed; reconnect the automation worker.')
        try:
            return bridge.call(self, args)
        except Failure as error:
            if error.code in ('DRIVER_ERROR', 'TIMEOUT'):
                broken, bridge = bridge, None
                try:
                    broken.close()
                except Exception:
                    pass
            raise


def serve():
    global EXECUTED, STAGE, Simulator
    Simulator = WorkerSimulator
    logging.disable(logging.CRITICAL)
    try:
        while True:
            line = sys.stdin.buffer.readline(65537)
            if not line:
                break
            if len(line) > 65536 or not line.endswith(b'\n'):
                break
            EXECUTED, STAGE = False, 'prepare'
            try:
                request = json.loads(line)
            except (ValueError, UnicodeError):
                break
            if not isinstance(request, dict) or type(request.get('id')) is not int or not isinstance(request.get('args'), dict):
                break
            try:
                args = request['args']
                if args.get('action') in ('start_session', 'wait_viewer') or str(args.get('deviceId', '')).startswith('real:'):
                    fail('UNSUPPORTED', 'This worker handles Simulator commands only.')
                result = {'ok': True, **dispatch(args)}
            except Failure as error:
                result = {'ok': False, 'executed': EXECUTED, 'verified': False, 'error': {'code': 'OUTCOME_UNKNOWN' if EXECUTED is None else error.code, 'causeCode': error.code, 'stage': STAGE, 'message': 'An action may have executed. Inspect state before retrying.' if EXECUTED is None else str(error)}}
            except Exception:
                result = {'ok': False, 'executed': EXECUTED, 'verified': False, 'error': {'code': 'OUTCOME_UNKNOWN' if EXECUTED is None else 'DRIVER_ERROR', 'message': 'Device operation failed. Inspect state before retrying actions.'}}
            sys.stdout.write(json.dumps({'id': request['id'], 'result': result}, ensure_ascii=True) + '\n')
            sys.stdout.flush()
    finally:
        if bridge is not None:
            bridge.close()


if __name__ == 'iphone_mirror_worker':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    signal.signal(signal.SIGHUP, lambda *_: sys.exit(0))
    serve()
