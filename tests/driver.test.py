import importlib.util
import contextlib
import pathlib
import sys
import types
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True

# Production uses macOS flock; Windows runs the same parser and state-machine tests.
if sys.platform == 'win32':
    sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *args: None)
spec = importlib.util.spec_from_file_location('driver', pathlib.Path(__file__).parents[1] / 'app/drivers/ios-command.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def element(identifier='button', **values):
    return {'identifier': identifier, 'label': 'Button', 'type': 'Button', 'enabled': True, 'frame': {'x': 0, 'y': 0, 'width': 30, 'height': 30}, **values}


class DriverTests(unittest.TestCase):
    def test_exact_and_ambiguous(self):
        tree = {'elements': [element(), element('button_more')]}
        self.assertEqual(driver.resolve(tree, {'identifier': 'button'})['identifier'], 'button')
        with self.assertRaisesRegex(driver.Failure, 'More than one'):
            driver.resolve({'elements': [element(), element()]}, {'identifier': 'button'})
        with self.assertRaisesRegex(driver.Failure, 'No element'):
            driver.resolve(tree, {'identifier': 'but'})

    def test_scoped_match(self):
        a = element('container', children=[element()])
        self.assertEqual(driver.resolve({'elements': [a, element()]}, {'identifier': 'button', 'container': 'container'})['identifier'], 'button')

    def test_bounds_and_hidden(self):
        tree = {'screen': {'width': 100, 'height': 100}}
        self.assertEqual(driver.center(tree, element()), (15, 15))
        for e in [element(enabled=False), element(visible=False), element(frame={'x': 0, 'y': 200, 'width': 30, 'height': 30}), element(frame={'x': float('nan'), 'y': 0, 'width': 30, 'height': 30})]:
            with self.assertRaises(driver.Failure):
                driver.center(tree, e)

    def test_redacts_secure_values(self):
        tree = {'elements': [element(type='SecureTextField', value='secret', label='secret', children=[element(label='secret', value='secret')])]}
        self.assertNotIn('secret', str(driver.redact(tree)))

    def test_unknown_action_outcome_remains_unknown(self):
        def interrupted():
            raise driver.Failure('DRIVER_ERROR', 'interrupted')
        with self.assertRaises(driver.Failure):
            driver.mutate(interrupted)
        self.assertIsNone(driver.EXECUTED)

    def test_deadline_and_ambiguity_not_retried(self):
        fake = types.SimpleNamespace(tree=lambda: {'elements': []}, deadline=0)
        with self.assertRaisesRegex(driver.Failure, 'deadline'):
            driver.wait_for(fake, {'selector': {'identifier': 'button'}})
        fake.tree = lambda: {'elements': [element(), element()]}
        with self.assertRaisesRegex(driver.Failure, 'More than one'):
            driver.wait_for(fake, {'selector': {'identifier': 'button'}})

    def test_clipboard_requires_explicit_consent(self):
        fake = driver.Simulator.__new__(driver.Simulator)
        with self.assertRaisesRegex(driver.Failure, 'allowClipboard'):
            fake.text('تجربة🙂', None, False)

    def test_text_is_not_passed_in_process_arguments(self):
        fake = driver.Simulator.__new__(driver.Simulator)
        fake.idb = '/test/venv/bin/idb'
        fake.companion = '/test/companion'
        fake.device = 'simulator'
        fake.run = unittest.mock.Mock(return_value=b'')
        fake.cli('ui', 'text', 'sensitive value')
        argv, data = fake.run.call_args.args
        self.assertEqual(pathlib.Path(argv[0]).name, 'python')
        self.assertEqual(argv[1:], ['-I', '-B', '-'])
        self.assertNotIn('sensitive value', str(argv))
        self.assertNotIn(b'sensitive value', data)

    def test_real_devices_share_one_host_lock(self):
        self.assertEqual(driver.reservation_path('real:a'), driver.reservation_path('real:b'))

    def test_manual_shutdown_uses_lock_and_never_shell_interprets_device(self):
        device = '8AA89128-E540-44BB-82FD-43999DDC6838'
        with patch.object(driver, 'device_lock', return_value=contextlib.nullcontext()) as lock, patch.object(driver, 'reservation_path') as reservation, patch.object(driver.subprocess, 'run') as run:
            reservation.return_value.exists.return_value = False
            result = driver.dispatch({'action': 'shutdown_simulator', 'deviceId': device})
            self.assertTrue(result['executed'])
            lock.assert_called_once_with(device)
            run.assert_called_once_with(['xcrun', 'simctl', 'shutdown', device], check=True, capture_output=True, timeout=20)


unittest.main()
