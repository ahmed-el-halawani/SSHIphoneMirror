import asyncio
import contextlib
import importlib.util
import io
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, Mock

sys.dont_write_bytecode = True
if sys.platform == 'win32':
    sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *args: None)
root = pathlib.Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('driver', root / 'app/drivers/ios-command.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def namespace():
    scope = dict(driver.__dict__)
    exec((root / 'app/drivers/ios-worker.py').read_text(), scope)
    return scope


class WorkerTests(unittest.TestCase):
    def test_failed_sdk_connection_is_discarded_without_replaying_input(self):
        scope = namespace()
        broken = types.SimpleNamespace(runtime_id='runtime', call=Mock(side_effect=driver.Failure('DRIVER_ERROR', 'lost')), close=Mock())
        scope['bridge'] = broken
        fake = scope['WorkerSimulator'].__new__(scope['WorkerSimulator'])
        fake.runtime_id = 'runtime'
        with self.assertRaises(driver.Failure):
            fake.cli('ui', 'tap', 12, 34)
        broken.call.assert_called_once()
        broken.close.assert_called_once()
        self.assertIsNone(scope['bridge'])

    def test_uncertain_action_is_not_replayed_and_state_resets_for_next_read(self):
        scope = namespace()
        output = io.StringIO()
        requests = [dict(id=1, args=dict(action='tap')), dict(id=2, args=dict(action='get_ui_tree'))]
        scope['sys'] = types.SimpleNamespace(stdin=types.SimpleNamespace(buffer=io.BytesIO(''.join(json.dumps(r) + '\n' for r in requests).encode())), stdout=output)
        exec("calls=[]\ndef dispatch(args):\n global EXECUTED,STAGE\n calls.append(args['action'])\n if args['action']=='tap':\n  EXECUTED=None\n  STAGE='idb.ui.tap'\n  raise Failure('DRIVER_ERROR','interrupted')\n assert EXECUTED is False and STAGE=='prepare'\n return {'tree':{}}", scope)
        scope['serve']()
        results = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(scope['calls'], ['tap', 'get_ui_tree'])
        self.assertEqual(results[0]['result']['error']['code'], 'OUTCOME_UNKNOWN')
        self.assertIsNone(results[0]['result']['executed'])
        self.assertTrue(results[1]['result']['ok'])

    def test_invalid_or_oversized_input_never_reaches_dispatch(self):
        for content in [b'invalid\n', b'x' * 65537, b'{"id":true,"args":{}}\n']:
            scope, output = namespace(), io.StringIO()
            scope['sys'] = types.SimpleNamespace(stdin=types.SimpleNamespace(buffer=io.BytesIO(content)), stdout=output)
            scope['dispatch'] = lambda _: self.fail('Invalid input was dispatched')
            scope['serve']()
            self.assertEqual(output.getvalue(), '')

    def test_direct_sdk_preserves_ax_options_coordinates_text_and_session_reuse(self):
        scope = namespace()
        bridge = scope['IDBBridge'].__new__(scope['IDBBridge'])
        client = types.SimpleNamespace(accessibility_info=AsyncMock(return_value=types.SimpleNamespace(json='{"elements":[]}')), accessibility_set_value=AsyncMock(), tap=AsyncMock(), swipe=AsyncMock(), screenshot=AsyncMock(return_value=b'png-bytes'))
        entered = []
        @contextlib.asynccontextmanager
        async def session(udid):
            entered.append(udid)
            yield client
        bridge.Manager = lambda **_: types.SimpleNamespace(from_udid=session)
        bridge.clients, bridge.contexts, bridge.companion = {}, contextlib.AsyncExitStack(), 'companion'
        bridge.Backend = types.SimpleNamespace(AX='ax', AX_CORESIMULATOR='ax-coresimulator')
        bridge.ClientType, bridge.Format = types.SimpleNamespace(XCTEST='xctest'), types.SimpleNamespace(COMPLETE='complete')
        bridge.Options = bridge.Point = lambda **kwargs: types.SimpleNamespace(**kwargs)
        async def check():
            await bridge.execute('simulator', ('ui', 'describe-all', '--api', 'ax'))
            options = client.accessibility_info.call_args.kwargs['options']
            self.assertEqual((options.backend, options.format, options.client_type), ('ax', 'complete', 'xctest'))
            await bridge.execute('simulator', ('ui', 'describe-point', 12, 34, '--api', 'ax-coresimulator'))
            self.assertEqual(vars(client.accessibility_info.call_args.kwargs['target']), dict(x=12, y=34))
            text = 'تجربة 🙂'
            await bridge.execute('simulator', ('ui', 'set-value', 12, 34, '--api', 'ax', '--value', text))
            self.assertEqual(client.accessibility_set_value.call_args.kwargs['value'], text)
            await bridge.execute('simulator', ('ui', 'tap', 12, 34, '--duration', 1.2))
            client.tap.assert_awaited_once_with(x=12, y=34, duration=1.2)
            await bridge.execute('simulator', ('ui', 'swipe', 10, 20, 30, 40, '--duration', 0.4))
            client.swipe.assert_awaited_once_with(p_start=(10, 20), p_end=(30, 40), duration=0.4)
            with tempfile.TemporaryDirectory() as folder:
                file = pathlib.Path(folder) / 'image.png'
                await bridge.execute('simulator', ('screenshot', str(file)))
                self.assertEqual(file.read_bytes(), b'png-bytes')
            self.assertEqual(entered, ['simulator'])
            await bridge.contexts.aclose()
        asyncio.run(check())


unittest.main()
