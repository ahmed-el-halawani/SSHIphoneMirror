import copy
import contextlib
import importlib.util
import pathlib
import sys
import tempfile
import time
import types
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
if sys.platform == 'win32':
    sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *args: None)
spec = importlib.util.spec_from_file_location('driver', pathlib.Path(__file__).parents[1] / 'app/drivers/ios-command.py')
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


def element(identifier='button', **values):
    return dict(identifier=identifier, label='Button', type='Button', enabled=True, frame=dict(x=0, y=0, width=40, height=40), **values)


class CompactTests(unittest.TestCase):
    def setUp(self):
        d.SNAPSHOTS.clear()
        d.ACTIVE_DEVICE = 'sim'
        d.EXECUTED = False
        self.tree = dict(screen=dict(width=400, height=800), elements=[element(), dict(identifier='count', label='Count: 0', type='StaticText', frame=dict(x=0, y=50, width=100, height=30))])
        self.driver = types.SimpleNamespace(tree=lambda: copy.deepcopy(self.tree), deadline=time.monotonic() + 10, tap=Mock(), hit_test=Mock(), swipe=Mock(), cli=Mock(), api='ax')

    def snapshot(self):
        result = d.snapshot_result('sim', copy.deepcopy(self.tree))
        ref = next(iter(d.SNAPSHOTS['sim']['refs']))
        return result, ref

    def test_compact_diff_preserves_unchanged_refs_and_removes_changed_refs(self):
        full, ref = self.snapshot()
        previous = d.SNAPSHOTS['sim']
        old_count = list(previous['refs'])[1]
        self.tree['elements'][1]['label'] = 'Count: 1'
        diff = d.snapshot_result('sim', self.tree, previous, True)
        self.assertEqual(diff['baseSnapshotId'], full['snapshotId'])
        self.assertIn(ref, d.SNAPSHOTS['sim']['refs'])
        self.assertIn('- ' + old_count, diff['text'])
        self.assertIn('Count: 1', diff['text'])
        self.assertNotIn('id="button"', diff['text'])

    def test_changed_ui_wrong_snapshot_expired_or_unknown_ref_sends_no_input(self):
        for change in ('frame', 'label', 'screen', 'snapshot', 'expired', 'ref'):
            self.setUp()
            snapshot, ref = self.snapshot()
            args = dict(operation='tap', snapshotId=snapshot['snapshotId'], ref=ref)
            if change == 'frame': self.tree['elements'][0]['frame']['x'] = 100
            if change == 'label': self.tree['elements'][0]['label'] = 'Different action'
            if change == 'screen': self.tree['screen']['width'] = 800
            if change == 'snapshot': args['snapshotId'] = 'wrong'
            if change == 'expired': d.SNAPSHOTS['sim']['time'] -= 61
            if change == 'ref': args['ref'] = '@e999~12345678'
            with self.assertRaises(d.Failure): d.compact_action(self.driver, 'sim', args)
            self.driver.tap.assert_not_called()
            self.assertFalse(d.EXECUTED)

    def test_act_dispatches_once_and_returns_settled_diff(self):
        snapshot, ref = self.snapshot()
        self.driver.tap.side_effect = lambda *_: self.tree['elements'][1].update(label='Count: 1')
        result = d.compact_action(self.driver, 'sim', dict(operation='tap', snapshotId=snapshot['snapshotId'], ref=ref))
        self.driver.tap.assert_called_once()
        self.assertTrue(result['executed'])
        self.assertFalse(result['verified'])
        self.assertTrue(result['snapshot']['settled'])
        self.assertIn('Count: 1', result['snapshot']['text'])
        self.assertNotEqual(result['snapshot']['snapshotId'], snapshot['snapshotId'])

    def test_uncertain_input_invalidates_refs_and_is_never_replayed(self):
        snapshot, ref = self.snapshot()
        self.driver.tap.side_effect = d.Failure('DRIVER_ERROR', 'lost')
        with self.assertRaises(d.Failure): d.compact_action(self.driver, 'sim', dict(operation='tap', snapshotId=snapshot['snapshotId'], ref=ref))
        self.assertIsNone(d.EXECUTED)
        self.assertNotIn('sim', d.SNAPSHOTS)
        self.driver.tap.assert_called_once()

    def test_post_action_read_failure_keeps_executed_true(self):
        snapshot, ref = self.snapshot()
        self.driver.tap.side_effect = lambda *_: setattr(self.driver, 'tree', Mock(side_effect=d.Failure('TIMEOUT', 'read failed')))
        result = d.compact_action(self.driver, 'sim', dict(operation='tap', snapshotId=snapshot['snapshotId'], ref=ref))
        self.assertFalse(result['ok'])
        self.assertTrue(result['executed'])
        self.driver.tap.assert_called_once()

    def test_secure_redaction_hidden_nodes_and_payload_limit(self):
        self.tree['elements'] += [dict(type='SecureTextField', label='secret', value='secret', frame=dict(x=0, y=100, width=100, height=30)), dict(identifier='hidden', visible=False, frame=dict(x=0, y=150, width=100, height=30)), dict(identifier='offscreen', frame=dict(x=0, y=900, width=100, height=30))]
        snapshot, _ = self.snapshot()
        for text in ('secret', 'hidden', 'offscreen'): self.assertNotIn(text, snapshot['text'])
        self.tree['elements'] = [element(str(i)) for i in range(501)]
        with self.assertRaises(d.Failure): self.snapshot()
        self.tree['elements'] = [element(str(i), value='x' * 10000) for i in range(300)]
        with self.assertRaises(d.Failure): self.snapshot()

    def test_large_text_is_explicitly_shortened_without_changing_ref_identity(self):
        self.tree['elements'][1]['value'] = 'x' * 10000
        snapshot, _ = self.snapshot()
        self.assertIn('[truncated]', snapshot['text'])
        self.assertLess(len(snapshot['text']), 1000)
        self.assertEqual(len(list(d.SNAPSHOTS['sim']['refs'].values())[1]['value']), 10000)

    def test_fill_checks_type_hit_test_and_preserves_unicode(self):
        self.tree['elements'][0]['type'] = 'TextField'
        snapshot, ref = self.snapshot()
        text = 'تجربة 🙂'
        result = d.compact_action(self.driver, 'sim', dict(operation='fill', snapshotId=snapshot['snapshotId'], ref=ref, text=text))
        self.driver.hit_test.assert_called_once()
        self.assertEqual(self.driver.cli.call_args.args[-1], text)
        self.assertTrue(result['executed'])

    def test_existing_mutation_invalidates_snapshot(self):
        self.snapshot()
        d.mutate(lambda: None)
        self.assertNotIn('sim', d.SNAPSHOTS)

    def test_startup_missing_geometry_repeats_only_the_read(self):
        driver = d.Simulator.__new__(d.Simulator)
        driver.api, driver.deadline = 'ax', time.monotonic() + 10
        driver.cli = Mock(side_effect=['{"elements":[],"screen":null}', '{"elements":[],"screen":{"width":400,"height":800}}'])
        self.assertEqual(driver.tree()['screen']['width'], 400)
        self.assertEqual(driver.cli.call_count, 2)
        self.assertTrue(all(call.args[1] == 'describe-all' for call in driver.cli.call_args_list))

    def test_expected_verification_reuses_its_capture_for_settling(self):
        self.driver.tree = Mock(return_value=copy.deepcopy(self.tree))
        result = d.settled_snapshot(self.driver, 'sim', None, dict(selector=dict(identifier='count'), value='Count: 0'))
        self.assertTrue(result['verified'])
        self.assertTrue(result['snapshot']['settled'])
        self.assertEqual(self.driver.tree.call_count, 2)

    def test_transient_scroll_indicators_do_not_invalidate_content(self):
        before = d.compact_rows(copy.deepcopy(self.tree))
        self.tree['elements'].append(dict(type='Slider', label='Vertical scroll bar, 2 pages', frame=dict(x=380, y=100, width=10, height=100)))
        self.assertEqual(d.compact_rows(self.tree), before)

    def test_hit_test_accepts_actual_descendant_but_rejects_other_same_label(self):
        child = dict(type='StaticText', label='Open', frame=dict(x=10, y=10, width=30, height=20))
        parent = element(children=[child])
        driver = d.Simulator.__new__(d.Simulator)
        driver.tree = Mock(return_value=dict(elements=[copy.deepcopy(child)]))
        driver.hit_test(parent, 20, 20)
        wrong = copy.deepcopy(child)
        wrong['frame']['y'] = 100
        driver.tree.return_value = dict(elements=[wrong])
        with self.assertRaises(d.Failure): driver.hit_test(parent, 20, 20)

    def test_header_reposition_happens_before_first_tap(self):
        snapshot, ref = self.snapshot()
        self.driver.hit_test.side_effect = [d.Failure('STALE_ELEMENT', 'header'), None]
        result = d.compact_action(self.driver, 'sim', dict(operation='tap', snapshotId=snapshot['snapshotId'], ref=ref))
        self.driver.swipe.assert_called_once()
        self.driver.tap.assert_called_once()
        self.assertTrue(result['executed'])

    def test_snapshot_is_read_only_but_act_respects_manual_viewer_handoff(self):
        device = '8AA89128-E540-44BB-82FD-43999DDC6838'
        with tempfile.TemporaryDirectory() as folder, patch.object(d, 'device_lock', return_value=contextlib.nullcontext()), patch.object(d, 'reservation_path', return_value=pathlib.Path(folder) / 'viewer.json'), patch.object(d, 'Simulator', return_value=self.driver):
            (pathlib.Path(folder) / 'viewer.json').write_text('{"handoff":true}')
            result = d.dispatch(dict(action='snapshot', deviceId=device))
            self.assertEqual(result['snapshot']['mode'], 'full')
            with self.assertRaises(d.Failure) as error:
                d.dispatch(dict(action='act', deviceId=device))
            self.assertEqual(error.exception.code, 'VIEWER_HANDOFF_REQUIRED')
            self.driver.tap.assert_not_called()

    def test_toggle_targets_native_control_instead_of_inert_row_center(self):
        child = dict(type='CheckBox', value='0', frame=dict(x=300, y=10, width=60, height=30))
        parent = dict(identifier='toggle', type='CheckBox', label='Enable', frame=dict(x=0, y=0, width=370, height=50), children=[child])
        self.assertEqual(d.center(self.tree, parent), (330, 25))
        driver = d.Simulator.__new__(d.Simulator)
        driver.tree = Mock(return_value=dict(elements=[child]))
        driver.hit_test(parent, 330, 25)

    def test_external_state_change_refuses_without_dispatch(self):
        snapshot, ref = self.snapshot()
        self.tree['elements'][1]['label'] = 'Count: 1'
        with self.assertRaises(d.Failure) as error:
            d.compact_action(self.driver, 'sim', dict(operation='tap', snapshotId=snapshot['snapshotId'], ref=ref))
        self.assertEqual(error.exception.code, 'STALE_SNAPSHOT')
        self.driver.tap.assert_not_called()

    def test_different_screen_heading_refuses_even_when_target_is_unchanged(self):
        self.tree['elements'][1]['type'] = 'Heading'
        snapshot, ref = self.snapshot()
        self.tree['elements'][1]['label'] = 'Other screen'
        with self.assertRaises(d.Failure): d.compact_action(self.driver, 'sim', dict(operation='tap', snapshotId=snapshot['snapshotId'], ref=ref))
        self.driver.tap.assert_not_called()

    def test_switch_thumb_hit_requires_native_bounds_and_same_process(self):
        native = dict(type='CheckBox', subrole='AXSwitch', pid=123, frame=dict(x=300, y=10, width=60, height=30))
        parent = dict(identifier='toggle', type='CheckBox', subrole='AXSwitch', pid=123, frame=dict(x=0, y=0, width=370, height=50), children=[native])
        thumb = dict(type='Group', pid=123, frame=dict(x=310, y=12, width=35, height=24))
        driver = d.Simulator.__new__(d.Simulator)
        driver.tree = Mock(return_value=dict(elements=[thumb]))
        driver.hit_test(parent, 330, 25)
        for wrong in [dict(thumb, pid=999), dict(thumb, frame=dict(x=280, y=12, width=65, height=24))]:
            driver.tree.return_value = dict(elements=[wrong])
            with self.assertRaises(d.Failure): driver.hit_test(parent, 330, 25)

    def test_native_switch_gets_the_qualified_touch_duration(self):
        self.tree['elements'][0].update(type='CheckBox', subrole='AXSwitch')
        snapshot, ref = self.snapshot()
        d.compact_action(self.driver, 'sim', dict(operation='tap', snapshotId=snapshot['snapshotId'], ref=ref))
        self.assertEqual(self.driver.tap.call_args.args[-1], .1)

    def test_refs_address_duplicate_native_alert_nodes_by_occurrence(self):
        self.tree['elements'] = [element(), element()]
        snapshot, _ = self.snapshot()
        ref = list(d.SNAPSHOTS['sim']['refs'])[1]
        d.compact_action(self.driver, 'sim', dict(operation='tap', snapshotId=snapshot['snapshotId'], ref=ref))
        self.driver.tap.assert_called_once()

    def test_initial_capture_waits_through_a_scene_transition_without_input(self):
        loading = dict(screen=dict(width=400, height=800), elements=[dict(identifier='loading', label='Loading', type='Heading', frame=dict(x=0, y=0, width=100, height=30))])
        self.driver.tree = Mock(side_effect=[loading, copy.deepcopy(self.tree), copy.deepcopy(self.tree)])
        tree, settled = d.settled_tree(self.driver)
        self.assertTrue(settled)
        self.assertEqual(d.compact_rows(tree), d.compact_rows(self.tree))
        self.assertEqual(self.driver.tree.call_count, 3)
        self.driver.tap.assert_not_called()

    def test_transient_acquisition_recovers_only_the_read_within_its_deadline(self):
        driver = d.Simulator.__new__(d.Simulator)
        driver.deadline = time.monotonic() + 5
        driver.read_tree = Mock(side_effect=[d.Failure('DRIVER_ERROR', 'reconnect'), self.tree])
        self.assertEqual(driver.tree(), self.tree)
        self.assertEqual(driver.read_tree.call_count, 2)
        driver.read_tree = Mock(side_effect=d.Failure('TIMEOUT', 'expired'))
        with self.assertRaises(d.Failure): driver.tree()
        driver.read_tree.assert_called_once()

    def test_ref_keeps_the_capture_backend_during_revalidation(self):
        result = d.snapshot_result('sim', copy.deepcopy(self.tree), api='ax-coresimulator')
        ref = next(iter(d.SNAPSHOTS['sim']['refs']))
        d.compact_action(self.driver, 'sim', dict(operation='tap', snapshotId=result['snapshotId'], ref=ref))
        self.assertEqual(self.driver.api, 'ax-coresimulator')

    def test_scroll_uses_controlled_duration_instead_of_flinging_past_targets(self):
        result, _ = self.snapshot()
        d.compact_action(self.driver, 'sim', dict(operation='scroll', direction='down', snapshotId=result['snapshotId']))
        self.driver.swipe.assert_called_once()
        self.assertEqual(self.driver.swipe.call_args.args[0]['duration'], 1)


unittest.main()
