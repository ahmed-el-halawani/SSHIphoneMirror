"""One bounded SSH command, not a daemon. No input is interpreted as shell code."""
import base64
import contextlib
import fcntl
import hashlib
import json
import math
import os
import pathlib
import platform
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error

PIN = '1387b360a9dcad34573cb1d9f277e5a0eacfd804'
LIMIT = 16 * 1024 * 1024
EXECUTED = False
STAGE = 'prepare'


def mutate(operation, *args):
    global EXECUTED
    EXECUTED = None
    result = operation(*args)
    EXECUTED = True
    return result


class Failure(Exception):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def fail(code, message):
    raise Failure(code, message)


def nodes(value):
    if isinstance(value, list):
        for child in value:
            yield from nodes(child)
    elif isinstance(value, dict):
        if 'frame' in value:
            yield value
        for key in ('elements', 'children'):
            yield from nodes(value.get(key, []))


def resolve(tree, selector):
    if not isinstance(selector, dict) or not any(selector.get(k) for k in ('identifier', 'label')):
        fail('INVALID_ARGUMENT', 'An exact identifier or label is required.')
    pool = list(nodes(tree))
    if selector.get('container'):
        parents = [n for n in pool if n.get('identifier') == selector['container']]
        if len(parents) != 1:
            fail('AMBIGUOUS_ELEMENT', 'Container must match exactly one element.')
        pool = list(nodes(parents[0].get('children', [])))
    matches = [n for n in pool if all(n.get(k) == v for k, v in selector.items() if k in ('identifier', 'label', 'type'))]
    if len(matches) > 1:
        fail('AMBIGUOUS_ELEMENT', 'More than one element matches the exact selector.')
    if not matches:
        fail('ELEMENT_NOT_FOUND', 'No element matches the exact selector.')
    return matches[0]


def center(tree, node):
    f, s = node.get('frame', {}), tree.get('screen', {})
    if node.get('enabled') is False or node.get('visible') is False:
        fail('ELEMENT_NOT_INTERACTABLE', 'Element is disabled or hidden.')
    if not all(isinstance(f.get(k), (int, float)) and math.isfinite(f[k]) for k in ('x', 'y', 'width', 'height')) or f['width'] <= 0 or f['height'] <= 0:
        fail('ELEMENT_NOT_INTERACTABLE', 'Element has no usable bounds.')
    x, y = f['x'] + f['width'] / 2, f['y'] + f['height'] / 2
    if not (0 <= x < s.get('width', 0) and 0 <= y < s.get('height', 0)):
        fail('ELEMENT_NOT_INTERACTABLE', 'Element is outside the viewport; scroll first.')
    return x, y


def redact(tree, secure=False):
    if isinstance(tree, list):
        for child in tree:
            redact(child, secure)
    elif isinstance(tree, dict):
        secure = secure or 'secure' in str(tree.get('type', '')).lower() or tree.get('secure') is True
        if secure:
            for key in ('value', 'label', 'title', 'AXValue', 'AXLabel'):
                if key in tree:
                    tree[key] = '[redacted]'
        for key in ('elements', 'children'):
            redact(tree.get(key, []), secure)
    return tree


@contextlib.contextmanager
def device_lock(device):
    root = pathlib.Path.home() / '.local/share/iphone-mirror/locks'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    # shortcut: one real iPhone per Mac; allocate ports and session files before supporting multiple phones.
    name = 'real-iphone' if device.startswith('real:') else device
    fd = os.open(str(root / (name + '.lock')), os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fail('DEVICE_BUSY', 'Another client controls this device. Retry after it finishes.')
        yield


def reservation_path(device):
    # shortcut: crash reservations require explicit recovery; use a process lease once crash recovery is qualified.
    name = 'real-iphone' if device.startswith('real:') else device
    return pathlib.Path.home() / '.local/share/iphone-mirror/locks' / (name + '.viewer.json')


def session_directory(runtime_id):
    # Keep Unix socket paths below macOS's limit and separate from other IDB installs.
    identity = hashlib.sha256((str(pathlib.Path.home()) + ':' + runtime_id).encode()).hexdigest()[:16]
    root = pathlib.Path('/tmp') / ('im-idb-' + str(os.getuid()) + '-' + identity)
    try:
        root.mkdir(mode=0o700)
    except FileExistsError:
        pass
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        fail('ENGINE_NOT_READY', 'The app-owned IDB session directory is not private. Check its ownership and permissions.')
    return root


class Simulator:
    def __init__(self, device, deadline):
        self.device, self.deadline, self.api = device, deadline, 'ax'
        self.root = pathlib.Path.home() / '.local/share/iphone-mirror/idb/current'
        self.idb = str(self.root / 'python/bin/idb')
        if not pathlib.Path(self.idb).is_file():
            fail('ENGINE_NOT_READY', 'Reconnect to let iPhone Mirror prepare its bundled Simulator runtime.')
        manifest = json.loads((self.root / 'compatibility.json').read_text())
        companion = self.root / 'bin/idb_companion'
        expected_hash = manifest['companionSha256']
        self.runtime_id = manifest['bundleId']
        if manifest.get('commit') != PIN or manifest.get('architecture') != platform.machine() or manifest.get('macOS') != platform.mac_ver()[0] or self.run(['xcodebuild', '-version']).decode().strip() != manifest.get('xcode'):
            fail('COMPATIBILITY_MISMATCH', 'macOS, architecture or Xcode changed. Requalify the pinned IDB build before automation.')
        with companion.open('rb') as binary:
            digest = hashlib.sha256()
            for block in iter(lambda: binary.read(1024 * 1024), b''):
                digest.update(block)
            actual_hash = digest.hexdigest()
        if actual_hash != expected_hash:
            fail('COMPATIBILITY_MISMATCH', 'IDB companion checksum changed. Verify the pinned build before automation.')
        self.companion = companion
        self.session = session_directory(self.runtime_id)

    def run(self, args, data=None):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            fail('TIMEOUT', 'Device operation reached its deadline.')
        env = dict(os.environ)
        env['PATH'] = str(self.root / 'python/bin') + ':/usr/bin:/bin:/usr/sbin:/sbin'
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            proc = subprocess.Popen(args, stdin=subprocess.PIPE if data is not None else subprocess.DEVNULL, stdout=output, stderr=errors, env=env, start_new_session=True)
            try:
                proc.communicate(data, timeout=remaining)
            except subprocess.TimeoutExpired:
                import signal
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                fail('TIMEOUT', 'Device operation reached its deadline; inspect state before retrying actions.')
            output.seek(0, 2)
            if output.tell() > LIMIT:
                fail('OUTPUT_TOO_LARGE', 'Device output exceeds 16 MiB.')
            output.seek(0)
            result = output.read()
            if proc.returncode:
                # CLI errors can echo text values; never return their raw output.
                fail('DRIVER_ERROR', 'The device command failed. Check engine health and inspect state before retrying actions.')
            return result

    def cli(self, *args):
        global STAGE
        STAGE = 'idb.' + args[0] + ('.' + args[1] if args[0] == 'ui' else '')
        argv = [self.idb, '--companion-path', str(self.companion), *map(str, args), '--udid', self.device]
        # Keep field values out of process listings while using the installed CLI unchanged.
        payload = base64.b64encode(json.dumps({'argv': argv, 'session': str(self.session)}).encode()).decode()
        # Override constants before IDB imports its registry and companion managers.
        bootstrap = "import base64,json,runpy,sys;import idb.common.constants as c;p=json.loads(base64.b64decode('" + payload + "'));sys.argv=p['argv'];c.BASE_IDB_FILE_PATH=p['session'];c.IDB_STATE_FILE_PATH=p['session']+'/state';c.IDB_LOGS_PATH=p['session']+'/logs';c.IDB_PID_PATH=p['session']+'/pid';runpy.run_path(sys.argv[0],run_name='__main__')"
        return self.run([str(pathlib.Path(self.idb).with_name('python')), '-I', '-X', 'pycache_prefix=' + str(self.session / 'pycache'), '-'], bootstrap.encode())

    def tree(self, point=None):
        args = ['ui', 'describe-point', *[str(round(v)) for v in point]] if point else ['ui', 'describe-all']
        for api in (self.api, 'ax-coresimulator'):
            try:
                value = json.loads(self.cli(*args, '--api', api, '--client-type', 'xctest', '--format', 'complete'))
                if not isinstance(value, dict) or 'elements' not in value or (not point and not value.get('screen')) or value.get('truncated'):
                    fail('INVALID_TREE', 'Accessibility returned an incomplete tree.')
                self.api = api
                return redact(value)
            except Failure as error:
                if error.code not in ('DRIVER_ERROR', 'INVALID_TREE') or api == 'ax-coresimulator':
                    raise
        fail('ENGINE_NOT_READY', 'Neither host AX backend is available.')

    def tap(self, x, y, duration=None):
        args = ['ui', 'tap', round(x), round(y)]
        if duration is not None:
            args += ['--duration', duration]
        self.cli(*args)

    def swipe(self, args):
        self.cli('ui', 'swipe', *[round(args[k]) for k in ('x1', 'y1', 'x2', 'y2')], '--duration', args.get('duration', 0.3))

    def screenshot(self):
        with tempfile.TemporaryDirectory(prefix='iphone-mirror-') as folder:
            file = pathlib.Path(folder) / 'screen.png'
            self.cli('screenshot', str(file))
            if file.stat().st_size > LIMIT:
                fail('OUTPUT_TOO_LARGE', 'Screenshot exceeds 16 MiB.')
            return base64.b64encode(file.read_bytes()).decode()

    def lifecycle(self, action, value):
        self.cli({'launch_app': 'launch', 'terminate_app': 'terminate', 'install_app': 'install'}[action], value)

    def text(self, text, selector, allow_clipboard):
        if selector:
            tree = self.tree()
            node = resolve(tree, selector)
            x, y = center(tree, node)
            self.hit_test(node, x, y)
            # Do not fall back after an AX action fails: execution may be uncertain.
            mutate(self.cli, 'ui', 'set-value', round(x), round(y), '--api', self.api, '--value', text)
            return 'ax-set-value'
        if text.isascii():
            mutate(self.cli, 'ui', 'text', text)
            return 'hid-text'
        if not allow_clipboard:
            fail('CLIPBOARD_PERMISSION_REQUIRED', 'Unicode without a selector requires explicit allowClipboard=true and changes the Simulator clipboard.')
        mutate(self.run, ['xcrun', 'simctl', 'pbcopy', self.device], text.encode())
        mutate(self.cli, 'ui', 'key', '--command', 25)
        return 'pasteboard'

    def hit_test(self, node, x, y):
        hit = self.tree((x, y))
        selected = [n for n in nodes(hit) if node.get('identifier') and n.get('identifier') == node['identifier'] or not node.get('identifier') and node.get('label') and n.get('label') == node['label'] and n.get('type') == node.get('type')]
        if not selected:
            fail('STALE_ELEMENT', 'The target moved or is blocked. Inspect the screen again.')


class RealPhone:
    def __init__(self, device, deadline):
        self.device, self.deadline = device, deadline
        try:
            state = json.loads((pathlib.Path.home() / '.local/share/iphone-mirror-tools/current-session.json').read_text())
        except (OSError, ValueError):
            fail('SESSION_REQUIRED', 'Start a real-device session explicitly with the desktop app, then detach the viewer.')
        if state.get('udid') != device[5:] or not re.fullmatch(r'[a-fA-F0-9-]{36}', state.get('sessionId', '')):
            fail('SESSION_CONFLICT', 'A different real iPhone owns the single Appium session.')
        self.session = state['sessionId']

    def request(self, suffix, body=None):
        timeout = self.deadline - time.monotonic()
        if timeout <= 0:
            fail('TIMEOUT', 'Device operation reached its deadline.')
        request = urllib.request.Request('http://127.0.0.1:17425/session/' + self.session + suffix, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = response.read(24 * 1024 * 1024 + 1)
                if len(data) > 24 * 1024 * 1024:
                    fail('OUTPUT_TOO_LARGE', 'Appium response exceeds its size limit.')
                value = json.loads(data)['value']
                if isinstance(value, dict) and value.get('error'):
                    fail('SESSION_LOST', 'Appium rejected the operation. Inspect session health.')
                return value
        except (urllib.error.URLError, ValueError, KeyError):
            fail('SESSION_LOST', 'Appium session is unavailable. Reconnect explicitly; actions are never retried.')

    def mobile(self, name, args):
        return self.request('/execute/sync', {'script': 'mobile: ' + name, 'args': [args]})

    def tree(self, point=None):
        if point:
            fail('UNSUPPORTED', 'WDA hit testing is handled by element click.')
        # XML is parsed by the standard library; it retains WDA identifier vs label.
        import xml.etree.ElementTree as ET
        root = ET.fromstring(self.request('/source'))
        def convert(e):
            a = e.attrib
            return {'identifier': a.get('name'), 'label': a.get('label'), 'value': a.get('value'), 'type': a.get('type', '').replace('XCUIElementType', ''), 'enabled': a.get('enabled') != 'false', 'visible': a.get('visible') != 'false', 'frame': {k: float(a.get(k, 0)) for k in ('x', 'y', 'width', 'height')}, 'children': [convert(c) for c in e]}
        rect = self.request('/window/rect')
        return redact({'elements': [convert(e) for e in root], 'screen': rect, 'backend': 'wda'})

    def element(self, selector):
        # Resolve ambiguity before asking WDA for a concrete element handle.
        resolve(self.tree(), selector)
        key = selector.get('identifier') or selector.get('label')
        matches = self.request('/elements', {'using': 'accessibility id', 'value': key})
        if len(matches) != 1:
            fail('AMBIGUOUS_ELEMENT', 'WDA did not return one unique element handle.')
        return next(iter(matches[0].values()))

    def tap(self, x, y, duration=None):
        self.mobile('touchAndHold' if duration else 'tap', {'x': x, 'y': y, **({'duration': duration} if duration else {})})

    def swipe(self, args):
        self.mobile('dragFromToForDuration', {'fromX': args['x1'], 'fromY': args['y1'], 'toX': args['x2'], 'toY': args['y2'], 'duration': args.get('duration', 0.3)})

    def screenshot(self):
        return self.request('/screenshot')

    def lifecycle(self, action, value):
        self.mobile({'launch_app': 'launchApp', 'terminate_app': 'terminateApp', 'install_app': 'installApp'}[action], {'app' if action == 'install_app' else 'bundleId': value})

    def text(self, text, selector, allow_clipboard):
        if not selector:
            fail('INVALID_ARGUMENT', 'Real iPhone text input requires an exact selector.')
        element = self.element(selector)
        mutate(self.request, '/element/' + element + '/value', {'text': text})
        return 'wda-send-keys'


def wait_for(driver, args):
    while True:
        try:
            tree = driver.tree()
            node = resolve(tree, args['selector'])
            if args.get('value') is not None and ('secure' in str(node.get('type', '')).lower() or node.get('secure')):
                fail('UNSUPPORTED', 'Secure field values cannot be inspected for verification.')
            found = args.get('value') is None or node.get('label') == args['value'] or node.get('value') == args['value']
            if args.get('state', 'visible') == 'visible':
                try:
                    center(tree, node)
                except Failure as e:
                    if e.code != 'ELEMENT_NOT_INTERACTABLE':
                        raise
                    found = False
        except Failure as error:
            if error.code != 'ELEMENT_NOT_FOUND':
                raise
            found = False
        if found != (args.get('state') == 'absent'):
            return {'verified': True}
        remaining = driver.deadline - time.monotonic()
        if remaining <= 0:
            fail('TIMEOUT', 'Expected UI state was not observed before the deadline.')
        time.sleep(min(0.1, remaining))


def dispatch(args):
    action, device = args['action'], args.get('deviceId', '')
    if action == 'list_devices':
        data = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '--json'], timeout=20))
        devices = [{**d, 'deviceId': d['udid'], 'kind': 'simulator', 'runtime': runtime} for runtime, group in data['devices'].items() for d in group]
        with tempfile.TemporaryDirectory() as folder:
            try:
                subprocess.run(['xcrun', 'devicectl', 'list', 'devices', '--json-output', folder + '/devices.json', '--timeout', '10'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
                for d in json.loads(pathlib.Path(folder + '/devices.json').read_text())['result']['devices']:
                    udid = d.get('hardwareProperties', {}).get('udid')
                    if udid:
                        devices.append({'deviceId': 'real:' + udid, 'kind': 'real', 'name': d.get('deviceProperties', {}).get('name', 'iPhone')})
            except (subprocess.SubprocessError, OSError, ValueError, KeyError):
                return {'devices': devices, 'warnings': ['Real-device discovery unavailable.']}
        return {'devices': devices}
    if not re.fullmatch(r'(?:[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}|real:(?:[a-fA-F0-9]{8}-[a-fA-F0-9]{16}|[a-fA-F0-9]{40}))', device):
        fail('INVALID_ARGUMENT', 'Invalid device identifier.')
    deadline = time.monotonic() + args.get('timeoutMs', 30000) / 1000
    if action == 'wait_viewer':
        # One bounded SSH wait avoids starting a new Python process every second.
        while True:
            try:
                state = json.loads(reservation_path(device).read_text())
                if state.get('token') != args['token']:
                    fail('RESERVATION_LOST', 'Another viewer owns the control reservation.')
                if state.get('requestedUntil', 0) > time.time():
                    return {'requested': True}
            except FileNotFoundError:
                fail('RESERVATION_LOST', 'Manual control reservation was released.')
            except json.JSONDecodeError:
                pass
            if time.monotonic() >= deadline:
                return {'requested': False}
            time.sleep(0.25)
    with device_lock(device):
        reservation = reservation_path(device)
        if action == 'reserve_viewer':
            if reservation.exists():
                fail('DEVICE_BUSY', 'A manual viewer already owns this device. Close it or recover its stale reservation explicitly.')
            reservation.write_text(json.dumps({'token': args['token'], 'created': time.time(), 'handoff': args.get('handoff') is True}))
            os.chmod(reservation, 0o600)
            return {'reserved': True}
        if action == 'request_control':
            if not reservation.exists():
                return {'ready': True}
            state = json.loads(reservation.read_text())
            if state.get('handoff') is not True:
                fail('DEVICE_BUSY', 'This viewer cannot switch automatically. Update iPhone Mirror or choose View > Watch agent (read-only).')
            state['requestedUntil'] = time.time() + 20
            reservation.write_text(json.dumps(state))
            return {'ready': False}
        if action == 'viewer_status':
            if not reservation.exists():
                fail('RESERVATION_LOST', 'Manual control reservation was released.')
            state = json.loads(reservation.read_text())
            if state.get('token') != args['token']:
                fail('RESERVATION_LOST', 'Another viewer owns the control reservation.')
            return {'requested': state.get('requestedUntil', 0) > time.time()}
        if action == 'release_viewer':
            if reservation.exists() and json.loads(reservation.read_text()).get('token') == args['token']:
                reservation.unlink()
            return {'released': True}
        if action == 'recover_viewer':
            reservation.unlink(missing_ok=True)
            return {'released': True}
        if reservation.exists() and action not in ('get_capabilities', 'get_ui_tree', 'screenshot', 'wait_for', 'get_device_logs'):
            if json.loads(reservation.read_text()).get('handoff') is True:
                fail('VIEWER_HANDOFF_REQUIRED', 'Switch the attached viewer to Watch agent before sending input.')
            fail('DEVICE_BUSY', 'A manual viewer owns device control. In iPhone Mirror choose View > Watch agent (read-only) to watch while the agent controls the device, or detach the viewer.')
        if action == 'shutdown_simulator':
            if device.startswith('real:'):
                fail('INVALID_ARGUMENT', 'Only simulators support shutdown here.')
            mutate(lambda: subprocess.run(['xcrun', 'simctl', 'shutdown', device], check=True, capture_output=True, timeout=20))
            return {'executed': True, 'verified': False}
        if action == 'start_session':
            if not device.startswith('real:'):
                fail('INVALID_ARGUMENT', 'Explicit session startup applies to real iPhones only.')
            state_file = pathlib.Path.home() / '.local/share/iphone-mirror-tools/current-session.json'
            if state_file.exists():
                state = json.loads(state_file.read_text())
                if state.get('udid') != device[5:]:
                    fail('SESSION_CONFLICT', 'A different iPhone owns this Mac Appium session. Use the desktop app to switch to the requested iPhone first.')
                try:
                    RealPhone(device, time.monotonic() + 5).request('/window/rect')
                    return {'executed': False, 'verified': True, 'reused': True}
                except Failure:
                    pass
            proc = subprocess.run(['/bin/sh'], input=args['sessionScript'].encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=690)
            if proc.returncode:
                fail('SESSION_START_FAILED', 'Real iPhone startup failed; check signing, tools and the Mac Appium log.')
            return {'executed': True, 'verified': True}
        driver = RealPhone(device, deadline) if device.startswith('real:') else Simulator(device, deadline)
        if action == 'get_capabilities':
            tree = driver.tree()
            return {'backend': tree.get('backend'), 'screen': tree['screen'], 'runtimeId': getattr(driver, 'runtime_id', None), 'capabilities': ['screenshot', 'ui_tree', 'tap', 'tap_element', 'swipe', 'type_text', 'wait_for', 'launch_app', 'terminate_app', 'install_app', 'long_press'], 'unicode': 'selector-based set-value; explicit clipboard fallback on Simulator', 'realDeviceLimit': 1 if device.startswith('real:') else None}
        if action == 'get_ui_tree':
            return {'tree': redact(driver.tree()), 'untrusted': True}
        if action == 'get_device_logs':
            if isinstance(driver, Simulator):
                output = driver.run(['xcrun', 'simctl', 'spawn', device, 'log', 'show', '--last', '1m', '--style', 'compact']).decode('utf-8', errors='replace')
                logs = output.splitlines()[-args.get('maxLines', 100):]
            else:
                logs = driver.request('/log', {'type': 'syslog'})[-args.get('maxLines', 100):]
            return {'logs': logs, 'untrusted': True}
        if action == 'screenshot':
            return {'image': driver.screenshot(), 'mimeType': 'image/png', 'untrusted': True}
        if action == 'wait_for':
            return wait_for(driver, args)
        if action in ('tap', 'long_press', 'swipe'):
            tree = driver.tree()
            s = tree['screen']
            for k in ('x1', 'y1', 'x2', 'y2') if action == 'swipe' else ('x', 'y'):
                if not isinstance(args.get(k), (int, float)) or not math.isfinite(args[k]) or not 0 <= args[k] < s['width' if k.startswith('x') else 'height']:
                    fail('INVALID_ARGUMENT', 'Coordinates must be screen points inside the current viewport.')
            if action == 'swipe':
                mutate(driver.swipe, args)
            else:
                mutate(driver.tap, args['x'], args['y'], args.get('duration', 1) if action == 'long_press' else None)
        elif action == 'tap_element':
            for attempt in range(args.get('maxScrolls', 0) + 1):
                tree = driver.tree()
                try:
                    node = resolve(tree, args['selector'])
                    x, y = center(tree, node)
                    if isinstance(driver, Simulator):
                        driver.hit_test(node, x, y)
                    break
                except Failure as error:
                    if error.code not in ('ELEMENT_NOT_FOUND', 'ELEMENT_NOT_INTERACTABLE', 'STALE_ELEMENT') or attempt >= args.get('maxScrolls', 0):
                        raise
                    s = tree['screen']
                    blocked_at_top = error.code == 'STALE_ELEMENT' and y < s['height'] / 3
                    mutate(driver.swipe, {'x1': s['width'] * 0.5, 'x2': s['width'] * 0.5, 'y1': s['height'] * (0.5 if blocked_at_top else 0.75), 'y2': s['height'] * (0.65 if blocked_at_top else 0.3), 'duration': 1})
            if isinstance(driver, Simulator):
                mutate(driver.tap, x, y)
            else:
                mutate(driver.request, '/element/' + driver.element(args['selector']) + '/click', {})
        elif action == 'type_text':
            method = driver.text(args['text'], args.get('selector'), args.get('allowClipboard', False))
            return {'executed': True, 'verified': False, 'method': method}
        elif action in ('launch_app', 'terminate_app', 'install_app'):
            value = args.get('appPath') if action == 'install_app' else args.get('bundleId')
            if action == 'install_app':
                if not isinstance(value, str) or not value.startswith('/') or not value.endswith(('.app', '.ipa')) or not pathlib.Path(value).exists():
                    fail('INVALID_ARGUMENT', 'appPath must be an existing absolute Mac .app or .ipa path.')
            elif not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,254}', value):
                fail('INVALID_ARGUMENT', 'Invalid app bundle ID.')
            mutate(driver.lifecycle, action, value)
        else:
            fail('UNSUPPORTED', 'Unknown automation action.')
        result = {'executed': True, 'verified': False}
        if args.get('expected'):
            try:
                result.update(wait_for(driver, args['expected']))
            except Failure as error:
                return {'ok': False, 'executed': True, 'verified': False, 'error': {'code': error.code, 'message': str(error)}}
        return result


def main():
    try:
        args = json.loads(base64.b64decode(sys.argv[1], validate=True))
        result = dispatch(args)
        print(json.dumps({'ok': True, **result}, ensure_ascii=True))
    except Failure as error:
        print(json.dumps({'ok': False, 'executed': EXECUTED, 'verified': False, 'error': {'code': 'OUTCOME_UNKNOWN' if EXECUTED is None else error.code, 'causeCode': error.code, 'stage': STAGE, 'message': 'An action may have executed. Inspect state before retrying.' if EXECUTED is None else str(error)}}))
    except Exception:
        # Neither subprocess diagnostics nor text/field values cross this boundary.
        print(json.dumps({'ok': False, 'executed': EXECUTED, 'verified': False, 'error': {'code': 'OUTCOME_UNKNOWN' if EXECUTED is None else 'DRIVER_ERROR', 'message': 'Device operation failed. Inspect state before retrying actions.'}}))


if __name__ == '__main__':
    main()
