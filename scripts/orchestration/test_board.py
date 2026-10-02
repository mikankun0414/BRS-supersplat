from pathlib import Path
import os
import sys
import threading
import time
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.orchestration import team_control as t
import tempfile


def setUpModule():
    # Keep board state out of the real checkout.
    global _tmp, _patcher
    _tmp = tempfile.TemporaryDirectory()
    _patcher = patch.object(t, 'state_root', return_value=Path(_tmp.name))
    _patcher.start()


def tearDownModule():
    _patcher.stop()
    _tmp.cleanup()


def worker(outcome=None, action=False, space=None):
    space = space or 'x::' + str(t.ROOT)
    return {'projection': {'outcome': outcome, 'workspace': {'id': space},
                           'attention': {'requiresAction': action}}}


class BoardStatusTests(unittest.TestCase):
    def test_all_succeeded_goes_to_review(self):
        status, note = t.board_status([worker('succeeded'), worker('succeeded')])
        self.assertEqual(status, 'in-review')
        self.assertIn('2件成功', note)

    def test_unsettled_failed_or_attention_stays_in_progress(self):
        self.assertEqual(t.board_status([worker('succeeded'), worker(None)])[0], 'in-progress')
        self.assertEqual(t.board_status([worker('succeeded'), worker('failed')]),
                         ('in-progress', '確認待ち: 失敗 1件'))
        self.assertEqual(t.board_status([worker('succeeded', action=True)])[0], 'in-progress')
        self.assertEqual(t.board_status([])[0], 'in-progress')

    def test_only_this_workspace_counts(self):
        rows = [worker('succeeded'), worker(None, space='x::Z:/elsewhere')]
        with patch.object(t, 'cli', return_value={'result': {'workers': rows, 'page': {}}}):
            self.assertEqual(len(t.run_workers('run_x')), 1)


class BoardSetTests(unittest.TestCase):
    def card(self, comment):
        return {'id': 'w1', 'path': str(t.ROOT), 'comment': comment, 'workspaceStatus': 'in-progress'}

    def test_user_note_is_kept(self):
        calls = []
        with patch.object(t, 'board_card', return_value=self.card('ユーザーのメモ')), \
             patch.object(t, 'cli', side_effect=lambda argv: calls.append(argv) or {'ok': True}):
            t.board_set('in-review', 'AI作業完了')
        self.assertNotIn('--comment', calls[0])
        self.assertIn('in-review', calls[0])

    def test_own_note_is_replaced(self):
        calls = []
        with patch.object(t, 'board_card', return_value=self.card('[AI] 古いメモ')), \
             patch.object(t, 'cli', side_effect=lambda argv: calls.append(argv) or {'ok': True}):
            t.board_set('completed', '')
        self.assertEqual(calls[0][calls[0].index('--comment') + 1], '')

    def test_missing_card_does_not_fail(self):
        with patch.object(t, 'board_card', return_value=None):
            self.assertFalse(t.board_set('in-review')['moved'])
        with self.assertRaises(ValueError):
            t.board_set('done')


class BoardTransitionTests(unittest.TestCase):
    def card(self):
        return {'id': 'w1', 'path': str(t.ROOT), 'comment': '', 'workspaceStatus': 'in-progress'}

    def test_pending_requires_reason(self):
        with self.assertRaises(ValueError):
            t.board_pending('', 'run_x')

    def test_pending_uses_configured_column(self):
        calls = []
        config = {'orca_board': {'pending_status': 'user-pending'}}
        with patch.object(t, 'load_config', return_value=config), \
             patch.object(t, 'board_card', return_value=self.card()), \
             patch.object(t, 'cli', side_effect=lambda argv: calls.append(argv) or {'ok': True}), \
             patch.object(t, 'write_board_state') as write_state:
            result = t.board_pending('ユーザー回答待ち', 'run_new')
        self.assertTrue(result['used_pending_column'])
        self.assertIn('user-pending', calls[0])
        write_state.assert_called_once()

    def test_pending_falls_back_without_column(self):
        calls = []
        with patch.object(t, 'load_config', return_value={}), \
             patch.object(t, 'board_card', return_value=self.card()), \
             patch.object(t, 'cli', side_effect=lambda argv: calls.append(argv) or {'ok': True}), \
             patch.object(t, 'write_board_state'):
            result = t.board_pending('承認待ち', 'run_a')
        self.assertFalse(result['used_pending_column'])
        self.assertTrue(result['fallback'])
        self.assertIn('in-review', calls[-1])
        self.assertIn('判断待ち: 承認待ち', calls[-1][calls[-1].index('--comment') + 1])

    def test_pending_falls_back_when_column_move_fails(self):
        calls = []
        config = {'orca_board': {'pending_status': 'missing-pending'}}
        responses = [{'ok': False}, {'ok': True}]

        def fake_cli(argv):
            calls.append(argv)
            return responses.pop(0) if responses else {'ok': True}

        with patch.object(t, 'load_config', return_value=config), \
             patch.object(t, 'board_card', return_value=self.card()), \
             patch.object(t, 'cli', side_effect=fake_cli), \
             patch.object(t, 'write_board_state'):
            result = t.board_pending('待ち', 'run_a')
        self.assertFalse(result['used_pending_column'])
        self.assertIn('in-review', calls[-1])

    def test_review_explicit_in_review(self):
        calls = []
        with patch.object(t, 'board_card', return_value=self.card()), \
             patch.object(t, 'cli', side_effect=lambda argv: calls.append(argv) or {'ok': True}), \
             patch.object(t, 'write_board_state'):
            t.board_review('確認だけ完了', 'run_r')
        self.assertIn('in-review', calls[0])

    def test_sync_skips_without_current_run_record(self):
        """A finished old Run must not move the card when no current Run is recorded."""
        workers = [worker('succeeded')] * 4
        for state in (None, {'run_id': '', 'kind': 'sync', 'status': 'in-progress',
                             'at': '2026-10-01T12:00:00+00:00'}):
            with patch.object(t, 'run_workers', return_value=workers),                  patch.object(t, 'record_results', return_value=0),                  patch.object(t, 'read_board_state', return_value=state),                  patch.object(t, 'board_set') as move:
                result = t.board_sync('run_old')
            self.assertTrue(result['skipped'])
            self.assertIn('current run', result['skip_reason'])
            move.assert_not_called()

    def test_sync_skips_when_state_is_other_run(self):
        workers = [worker('succeeded')]
        with patch.object(t, 'run_workers', return_value=workers), \
             patch.object(t, 'record_results', return_value=0), \
             patch.object(t, 'read_board_state', return_value={'run_id': 'run_newer', 'kind': 'explicit-pending'}), \
             patch.object(t, 'board_set') as move:
            result = t.board_sync('run_older')
        self.assertTrue(result['skipped'])
        move.assert_not_called()

    def test_sync_skips_pending_on_same_run(self):
        workers = [worker('succeeded')]
        with patch.object(t, 'run_workers', return_value=workers), \
             patch.object(t, 'record_results', return_value=0), \
             patch.object(t, 'read_board_state', return_value={'run_id': 'run_x', 'kind': 'explicit-pending'}), \
             patch.object(t, 'board_set') as move:
            result = t.board_sync('run_x')
        self.assertTrue(result['skipped'])
        move.assert_not_called()

    def test_sync_skips_after_explicit_done_same_run(self):
        workers = [worker('succeeded')]
        state = {'run_id': 'run_a', 'kind': 'explicit-done', 'status': 'completed', 'at': '2026-10-01T12:00:00+00:00'}
        with patch.object(t, 'run_workers', return_value=workers), \
             patch.object(t, 'record_results', return_value=0), \
             patch.object(t, 'read_board_state', return_value=state), \
             patch.object(t, 'board_set') as move:
            result = t.board_sync('run_a')
        self.assertTrue(result['skipped'])
        move.assert_not_called()

    def test_sync_skips_after_explicit_failed_same_run(self):
        workers = [worker('succeeded')]
        state = {'run_id': 'run_a', 'kind': 'explicit-failed', 'status': 'in-progress', 'at': '2026-10-01T12:00:00+00:00'}
        with patch.object(t, 'run_workers', return_value=workers), \
             patch.object(t, 'record_results', return_value=0), \
             patch.object(t, 'read_board_state', return_value=state), \
             patch.object(t, 'board_set') as move:
            result = t.board_sync('run_a')
        self.assertTrue(result['skipped'])
        move.assert_not_called()

    def test_sync_skips_explicit_review_when_workers_still_in_progress(self):
        workers = [worker('succeeded'), worker(None)]
        state = {'run_id': 'run_x', 'kind': 'explicit-review', 'status': 'in-review', 'at': '2026-10-01T12:00:00+00:00'}
        with patch.object(t, 'run_workers', return_value=workers), \
             patch.object(t, 'record_results', return_value=0), \
             patch.object(t, 'read_board_state', return_value=state), \
             patch.object(t, 'board_set') as move:
            result = t.board_sync('run_x')
        self.assertTrue(result['skipped'])
        move.assert_not_called()

    def test_new_run_sync_after_launch_claims_ownership(self):
        workers = [worker('succeeded')]
        state = {'run_id': 'run_new', 'kind': 'launch', 'status': 'in-progress', 'at': '2020-01-01T00:00:00+00:00'}
        with patch.object(t, 'run_workers', return_value=workers), \
             patch.object(t, 'record_results', return_value=0), \
             patch.object(t, 'read_board_state', return_value=state), \
             patch.object(t, 'board_set', return_value={'moved': True}) as move, \
             patch.object(t, 'write_board_state') as write_state:
            result = t.board_sync('run_new')
        self.assertFalse(result.get('skipped'))
        move.assert_called_once()
        write_state.assert_called_once()

    def test_stale_run_sync_skipped_after_newer_launch(self):
        workers = [worker('succeeded')]
        state = {'run_id': 'run_new', 'kind': 'launch', 'status': 'in-progress', 'at': '2026-10-01T14:00:00+00:00'}
        with patch.object(t, 'run_workers', return_value=workers), \
             patch.object(t, 'record_results', return_value=0), \
             patch.object(t, 'read_board_state', return_value=state), \
             patch.object(t, 'board_set') as move:
            result = t.board_sync('run_old')
        self.assertTrue(result['skipped'])
        move.assert_not_called()

    def test_dispatch_start_claims_board_state_on_move(self):
        task = {'role': 'coder', 'target': 't', 'change': 'c', 'constraints': 'x', 'ownership': 'o', 'acceptance': 'a'}
        route = {'agent': 'cursor', 'model': 'composer', 'role': 'coder', 'class': 'STANDARD'}
        receipt = {'ok': True, 'exit_code': 0, 'result': {'state': 'ready', 'dispatchId': 'd1', 'taskId': 't1'}}
        with patch.object(t, 'cli', return_value=receipt), \
             patch.object(t, 'save_json'), \
             patch.object(t, 'history_append'), \
             patch.object(t, 'board_set', return_value={'moved': True}) as move, \
             patch.object(t, 'write_board_state') as write_state, \
             patch.object(t, 'read_board_state', return_value=None):
            result = t.dispatch(task, route, 'run_claim', execute=True)
        self.assertTrue(result['started'])
        move.assert_called_once()
        write_state.assert_called_once_with('run_claim', 'launch', 'in-progress', None)

    def test_dispatch_records_current_run_when_board_move_fails(self):
        """Ready launch owns the Run even if the column move failed, so a later sync can recover."""
        task = {'role': 'coder', 'target': 't', 'change': 'c', 'constraints': 'x', 'ownership': 'o', 'acceptance': 'a'}
        route = {'agent': 'cursor', 'model': 'composer', 'role': 'coder', 'class': 'STANDARD'}
        receipt = {'ok': True, 'exit_code': 0, 'result': {'state': 'ready', 'dispatchId': 'd1', 'taskId': 't1'}}
        for move_result in ({'moved': False, 'error': 'busy'}, {'moved': False, 'outcome_unknown': True}):
            with patch.object(t, 'cli', return_value=receipt), \
                 patch.object(t, 'save_json'), \
                 patch.object(t, 'history_append'), \
                 patch.object(t, 'board_set', return_value=move_result), \
                 patch.object(t, 'write_board_state') as write_state, \
                 patch.object(t, 'read_board_state', return_value=None):
                t.dispatch(task, route, 'run_fail', execute=True)
            write_state.assert_called_once_with('run_fail', 'launch', 'in-progress', None)

    def test_dispatch_skips_board_when_done_arrives_during_worker_start(self):
        """M4: explicit-done after launch intent must not move or overwrite state."""
        task = {'role': 'coder', 'target': 't', 'change': 'c', 'constraints': 'x', 'ownership': 'o', 'acceptance': 'a'}
        route = {'agent': 'cursor', 'model': 'composer', 'role': 'coder', 'class': 'STANDARD'}
        receipt = {'ok': True, 'exit_code': 0, 'result': {'state': 'ready', 'dispatchId': 'd1', 'taskId': 't1'}}
        intent = t.dt.datetime(2026, 10, 1, 12, 0, 0, tzinfo=t.dt.timezone.utc)
        done_state = {'run_id': 'run_done', 'kind': 'explicit-done', 'status': 'completed',
                      'at': '2026-10-01T12:05:00+00:00'}
        with patch.object(t, 'cli', return_value=receipt), \
             patch.object(t, 'save_json'), \
             patch.object(t, 'history_append'), \
             patch.object(t, 'now', return_value=intent), \
             patch.object(t, 'read_board_state', return_value=done_state), \
             patch.object(t, 'board_set') as move, \
             patch.object(t, 'write_board_state') as write_state:
            result = t.dispatch(task, route, 'run_done', execute=True)
        self.assertTrue(result['started'])
        self.assertTrue(result['board']['skipped'])
        move.assert_not_called()
        write_state.assert_not_called()

    def test_dispatch_reclaims_board_after_older_explicit_done(self):
        """M4: launch intent newer than explicit-done may move to in-progress again."""
        task = {'role': 'coder', 'target': 't', 'change': 'c', 'constraints': 'x', 'ownership': 'o', 'acceptance': 'a'}
        route = {'agent': 'cursor', 'model': 'composer', 'role': 'coder', 'class': 'STANDARD'}
        receipt = {'ok': True, 'exit_code': 0, 'result': {'state': 'ready', 'dispatchId': 'd1', 'taskId': 't1'}}
        intent = t.dt.datetime(2026, 10, 1, 14, 0, 0, tzinfo=t.dt.timezone.utc)
        done_state = {'run_id': 'run_old', 'kind': 'explicit-done', 'status': 'completed',
                      'at': '2026-10-01T12:00:00+00:00'}
        with patch.object(t, 'cli', return_value=receipt), \
             patch.object(t, 'save_json'), \
             patch.object(t, 'history_append'), \
             patch.object(t, 'now', return_value=intent), \
             patch.object(t, 'read_board_state', return_value=done_state), \
             patch.object(t, 'board_set', return_value={'moved': True}) as move, \
             patch.object(t, 'write_board_state') as write_state:
            result = t.dispatch(task, route, 'run_new', execute=True)
        self.assertTrue(result['started'])
        move.assert_called_once()
        write_state.assert_called_once_with('run_new', 'launch', 'in-progress', None)

    def test_dispatch_skips_board_when_newer_explicit_state_arrives_during_worker_start(self):
        """L4: worker-start predating newer explicit state (pending/review/working/failed) must skip move."""
        task = {'role': 'coder', 'target': 't', 'change': 'c', 'constraints': 'x', 'ownership': 'o', 'acceptance': 'a'}
        route = {'agent': 'cursor', 'model': 'composer', 'role': 'coder', 'class': 'STANDARD'}
        receipt = {'ok': True, 'exit_code': 0, 'result': {'state': 'ready', 'dispatchId': 'd1', 'taskId': 't1'}}
        intent = t.dt.datetime(2026, 10, 1, 12, 0, 0, tzinfo=t.dt.timezone.utc)
        explicit_cases = [
            ('explicit-pending', 'user-pending'),
            ('explicit-review', 'in-review'),
            ('explicit-working', 'in-progress'),
            ('explicit-failed', 'in-progress'),
        ]
        for kind, status in explicit_cases:
            with self.subTest(kind=kind):
                # The guard is per Run: another Run's newer state no longer blocks this launch.
                state = {'run_id': 'run_stale', 'kind': kind, 'status': status,
                         'at': '2026-10-01T12:05:00+00:00'}
                with patch.object(t, 'cli', return_value=receipt), \
                     patch.object(t, 'save_json'), \
                     patch.object(t, 'history_append'), \
                     patch.object(t, 'now', return_value=intent), \
                     patch.object(t, 'read_board_state', return_value=state), \
                     patch.object(t, 'board_set') as move, \
                     patch.object(t, 'write_board_state') as write_state:
                    result = t.dispatch(task, route, 'run_stale', execute=True)
                self.assertTrue(result['started'])
                self.assertTrue(result['board']['skipped'])
                move.assert_not_called()
                write_state.assert_not_called()

    def test_dispatch_reclaims_board_after_older_explicit_states(self):
        """L4: launch intent newer than explicit state may move to in-progress again."""
        task = {'role': 'coder', 'target': 't', 'change': 'c', 'constraints': 'x', 'ownership': 'o', 'acceptance': 'a'}
        route = {'agent': 'cursor', 'model': 'composer', 'role': 'coder', 'class': 'STANDARD'}
        receipt = {'ok': True, 'exit_code': 0, 'result': {'state': 'ready', 'dispatchId': 'd1', 'taskId': 't1'}}
        intent = t.dt.datetime(2026, 10, 1, 14, 0, 0, tzinfo=t.dt.timezone.utc)
        explicit_cases = [
            ('explicit-pending', 'user-pending'),
            ('explicit-review', 'in-review'),
            ('explicit-working', 'in-progress'),
            ('explicit-failed', 'in-progress'),
        ]
        for kind, status in explicit_cases:
            with self.subTest(kind=kind):
                state = {'run_id': 'run_old', 'kind': kind, 'status': status,
                         'at': '2026-10-01T12:00:00+00:00'}
                with patch.object(t, 'cli', return_value=receipt), \
                     patch.object(t, 'save_json'), \
                     patch.object(t, 'history_append'), \
                     patch.object(t, 'now', return_value=intent), \
                     patch.object(t, 'read_board_state', return_value=state), \
                     patch.object(t, 'board_set', return_value={'moved': True}) as move, \
                     patch.object(t, 'write_board_state') as write_state:
                    result = t.dispatch(task, route, 'run_new', execute=True)
                self.assertTrue(result['started'])
                move.assert_called_once()
                write_state.assert_called_once_with('run_new', 'launch', 'in-progress', None)

    def test_dispatch_skips_board_when_timestamp_malformed_fails_closed(self):
        """L2/L5: missing, invalid, or timezone-naive timestamp fails closed without traceback."""
        task = {'role': 'coder', 'target': 't', 'change': 'c', 'constraints': 'x', 'ownership': 'o', 'acceptance': 'a'}
        route = {'agent': 'cursor', 'model': 'composer', 'role': 'coder', 'class': 'STANDARD'}
        receipt = {'ok': True, 'exit_code': 0, 'result': {'state': 'ready', 'dispatchId': 'd1', 'taskId': 't1'}}
        intent = t.dt.datetime(2026, 10, 1, 14, 0, 0, tzinfo=t.dt.timezone.utc)
        malformed_states = [
            {'run_id': 'run_stale', 'kind': 'explicit-done', 'status': 'completed'},  # missing at
            {'run_id': 'run_stale', 'kind': 'explicit-done', 'status': 'completed', 'at': None},  # None at
            {'run_id': 'run_stale', 'kind': 'explicit-pending', 'status': 'user-pending', 'at': 'corrupt'},  # invalid at
            {'run_id': 'run_stale', 'kind': 'explicit-review', 'status': 'in-review', 'at': '2026-10-01T12:05:00'},  # naive at
            {'run_id': 'run_stale', 'kind': 'explicit-working', 'status': 'in-progress', 'at': '2026-10-01T12:05:00'},  # naive at
            {'run_id': 'run_stale', 'kind': 'explicit-failed', 'status': 'in-progress', 'at': '2026-10-01T12:05:00'},  # naive at
        ]
        for state in malformed_states:
            with self.subTest(state=state):
                with patch.object(t, 'cli', return_value=receipt), \
                     patch.object(t, 'save_json'), \
                     patch.object(t, 'history_append'), \
                     patch.object(t, 'now', return_value=intent), \
                     patch.object(t, 'read_board_state', return_value=state), \
                     patch.object(t, 'board_set') as move, \
                     patch.object(t, 'write_board_state') as write_state:
                    result = t.dispatch(task, route, 'run_stale', execute=True)
                self.assertTrue(result['started'])
                self.assertTrue(result['board']['skipped'])
                move.assert_not_called()
                write_state.assert_not_called()

    def test_sync_skips_safely_when_state_timestamp_is_naive(self):
        """L2: non-explicit state with naive timestamp must not raise TypeError during sync."""
        workers = [worker('succeeded')]
        state = {'run_id': 'run_x', 'kind': 'launch', 'status': 'in-progress',
                 'at': '2026-10-01T12:00:00'}
        with patch.object(t, 'run_workers', return_value=workers), \
             patch.object(t, 'record_results', return_value=0), \
             patch.object(t, 'read_board_state', return_value=state), \
             patch.object(t, 'board_set', return_value={'moved': True}) as move, \
             patch.object(t, 'write_board_state'):
            result = t.board_sync('run_x')
        # Does not crash with TypeError
        self.assertIsNotNone(result)

    def test_board_state_at_unit(self):
        """L2: board_state_at returns aware datetime or None."""
        self.assertIsNone(t.board_state_at(None))
        self.assertIsNone(t.board_state_at('not-a-dict'))
        self.assertIsNone(t.board_state_at({}))
        self.assertIsNone(t.board_state_at({'at': None}))
        self.assertIsNone(t.board_state_at({'at': 'corrupt'}))
        self.assertIsNone(t.board_state_at({'at': '2026-10-01T12:00:00'}))  # naive
        aware = t.board_state_at({'at': '2026-10-01T12:00:00+00:00'})
        self.assertIsNotNone(aware)
        self.assertIsNotNone(aware.tzinfo)
        aware_z = t.board_state_at({'at': '2026-10-01T12:00:00Z'})
        self.assertIsNotNone(aware_z)
        self.assertIsNotNone(aware_z.tzinfo)

    def test_launch_should_skip_board_move_unit(self):
        """L2/L4/L5: unit tests for launch_should_skip_board_move across all kinds and timestamp states."""
        intent = t.dt.datetime(2026, 10, 1, 12, 0, 0, tzinfo=t.dt.timezone.utc)
        all_explicit = ['explicit-pending', 'explicit-review', 'explicit-working',
                        'explicit-done', 'explicit-failed']

        # Non-explicit or empty state does not skip
        self.assertEqual(t.launch_should_skip_board_move(None, intent), (False, None))
        self.assertEqual(t.launch_should_skip_board_move({'kind': 'launch'}, intent), (False, None))
        self.assertEqual(t.launch_should_skip_board_move({'kind': 'sync'}, intent), (False, None))

        for kind in all_explicit:
            with self.subTest(kind=kind):
                # Missing / invalid / naive timestamp -> fails closed
                skip, reason = t.launch_should_skip_board_move({'kind': kind}, intent)
                self.assertTrue(skip)
                self.assertIn('missing or invalid timestamp', reason)

                skip, reason = t.launch_should_skip_board_move({'kind': kind, 'at': 'corrupt'}, intent)
                self.assertTrue(skip)
                self.assertIn('missing or invalid timestamp', reason)

                skip, reason = t.launch_should_skip_board_move({'kind': kind, 'at': '2026-10-01T12:05:00'}, intent)
                self.assertTrue(skip)
                self.assertIn('missing or invalid timestamp', reason)

                # Newer explicit state -> skip
                skip, reason = t.launch_should_skip_board_move(
                    {'kind': kind, 'at': '2026-10-01T12:05:00+00:00'}, intent)
                self.assertTrue(skip)
                self.assertTrue('after launch intent' in reason or 'terminal' in reason)

                # Older explicit state -> do not skip (reclaim)
                skip, reason = t.launch_should_skip_board_move(
                    {'kind': kind, 'at': '2026-10-01T11:55:00+00:00'}, intent)
                self.assertFalse(skip)
                self.assertIsNone(reason)

        # Protected state with naive launch_intent_at -> fail closed without traceback
        naive_intent = t.dt.datetime(2026, 10, 1, 12, 0, 0)
        skip, reason = t.launch_should_skip_board_move(
            {'kind': 'explicit-done', 'at': '2026-10-01T12:05:00+00:00'}, naive_intent)
        self.assertTrue(skip)

    def test_pending_rejects_builtin_completed_id(self):
        config = {'orca_board': {'pending_status': 'completed'}}
        calls = []
        with patch.object(t, 'load_config', return_value=config), \
             patch.object(t, 'board_card', return_value=self.card()), \
             patch.object(t, 'cli', side_effect=lambda argv: calls.append(argv) or {'ok': True}), \
             patch.object(t, 'write_board_state') as write_state:
            result = t.board_pending('待ち', 'run_a')
        self.assertFalse(result['used_pending_column'])
        self.assertTrue(result['fallback'])
        self.assertNotIn('completed', str(calls[0]))
        write_state.assert_called_once()

    def test_pending_timeout_does_not_fallback_or_write_state(self):
        config = {'orca_board': {'pending_status': 'user-pending'}}
        calls = []

        def fake_cli(argv):
            calls.append(argv)
            return {'ok': False, 'outcome_unknown': True}

        with patch.object(t, 'load_config', return_value=config), \
             patch.object(t, 'board_card', return_value=self.card()), \
             patch.object(t, 'cli', side_effect=fake_cli), \
             patch.object(t, 'write_board_state') as write_state:
            result = t.board_pending('待ち', 'run_a')
        self.assertEqual(len(calls), 1)
        write_state.assert_not_called()
        self.assertFalse(result.get('moved'))

    def test_pending_no_state_when_card_missing(self):
        with patch.object(t, 'load_config', return_value={}), \
             patch.object(t, 'board_card', return_value=None), \
             patch.object(t, 'write_board_state') as write_state:
            result = t.board_pending('理由', 'run_a')
        self.assertFalse(result['moved'])
        write_state.assert_not_called()

    def test_review_no_state_when_card_missing(self):
        with patch.object(t, 'board_card', return_value=None), \
             patch.object(t, 'write_board_state') as write_state:
            result = t.board_review('note', 'run_a')
        self.assertFalse(result['moved'])
        write_state.assert_not_called()

    def test_board_actions_require_run(self):
        with self.assertRaises(ValueError):
            t.board_pending('reason', None)
        with self.assertRaises(ValueError):
            t.board_review(note='n', run_id=None)
        with self.assertRaises(ValueError):
            t.board_working(None)
        with self.assertRaises(ValueError):
            t.board_failed('reason', None)


class BoardLifecycleConcurrencyTests(unittest.TestCase):
    def card(self):
        return {'id': 'w1', 'path': str(t.ROOT), 'comment': '', 'workspaceStatus': 'in-progress'}

    def test_sync_skips_when_explicit_done_arrives_before_move(self):
        """H3: explicit-done written before sync moves must not call board_set."""
        workers = [worker('succeeded')]
        state = {'run_id': 'run_a', 'kind': 'explicit-done', 'status': 'completed',
                 'at': '2026-10-01T12:00:00+00:00'}
        with patch.object(t, 'run_workers', return_value=workers), \
             patch.object(t, 'record_results', return_value=0), \
             patch.object(t, 'read_board_state', return_value=state), \
             patch.object(t, 'board_set') as move:
            result = t.board_sync('run_a')
        self.assertTrue(result['skipped'])
        move.assert_not_called()

    def test_sync_serializes_with_concurrent_done_state(self):
        """H3: explicit state cannot change while sync holds the lifecycle lock during board_set."""
        workers = [worker('succeeded')]
        stored = {'state': {'run_id': 'run_a', 'kind': 'sync', 'status': 'in-review',
                            'at': '2020-01-01T00:00:00+00:00'}}
        sync_in_set = threading.Event()
        allow_sync = threading.Event()
        waited = []

        def read_state():
            return stored['state']

        def slow_set(*args, **kwargs):
            sync_in_set.set()
            allow_sync.wait(timeout=5)
            return {'moved': True, 'from': 'in-progress', 'to': args[0]}

        def try_write_done_state():
            sync_in_set.wait(timeout=5)
            start = time.monotonic()
            with t.board_lifecycle_lock():
                stored['state'] = {'run_id': 'run_a', 'kind': 'explicit-done', 'status': 'completed',
                                   'at': '2026-10-01T12:00:00+00:00'}
            waited.append(time.monotonic() - start)

        with patch.object(t, 'run_workers', return_value=workers), \
             patch.object(t, 'record_results', return_value=0), \
             patch.object(t, 'read_board_state', side_effect=read_state), \
             patch.object(t, 'board_set', side_effect=slow_set), \
             patch.object(t, 'write_board_state') as write_sync:
            thread = threading.Thread(target=try_write_done_state)
            thread.start()
            try:
                result = t.board_sync('run_a')
            finally:
                allow_sync.set()
                thread.join(timeout=5)
        self.assertFalse(result.get('skipped'))
        write_sync.assert_called_once()
        self.assertGreaterEqual(waited[0], 0.05)
        self.assertEqual(stored['state']['kind'], 'explicit-done')

    def test_lifecycle_lock_released_on_error(self):
        lock_path = t.ROOT / t.BOARD_LOCK_REL
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with self.assertRaises(ValueError):
            with t.board_lifecycle_lock():
                raise ValueError('boom')
        with t.board_lifecycle_lock():
            pass

    def test_lifecycle_lock_closes_fd_on_acquire_timeout(self):
        """L3: lock fd must close when acquisition times out."""
        with patch.object(os, 'open', return_value=42), \
             patch.object(t, '_acquire_board_lock', side_effect=TimeoutError('board lifecycle lock timeout')), \
             patch.object(os, 'close') as close_fd:
            with self.assertRaises(TimeoutError):
                with t.board_lifecycle_lock(timeout_sec=0.3):
                    pass
        close_fd.assert_called_once_with(42)

    def test_board_done_main_rejects_invalid_rate_before_move(self):
        """H4: invalid --rate must not call board_set or write history."""
        argv = ['team_control.py', 'board', 'done', '--run', 'run_a', '--rate', 'nope=bad']
        with patch.object(t, 'history_events', return_value=[
            {'event': 'start', 'dispatch_id': 'd1', 'run_id': 'run_a'}]), \
             patch.object(t, 'board_set') as move, \
             patch.object(t, 'history_append') as append, \
             patch.object(t, 'write_board_state') as write_state, \
             patch.object(sys, 'argv', argv):
            code = t.main()
        self.assertEqual(code, 2)
        move.assert_not_called()
        append.assert_not_called()
        write_state.assert_not_called()

    def test_sync_after_working_same_run_moves_to_review(self):
        """Rules call working on resume; the same Run's all-success sync must still reach In review."""
        workers = [worker('succeeded')]
        state = {'run_id': 'run_x', 'kind': 'explicit-working', 'status': 'in-progress',
                 'at': '2026-10-01T12:00:00+00:00'}
        with patch.object(t, 'run_workers', return_value=workers), \
             patch.object(t, 'record_results', return_value=0), \
             patch.object(t, 'read_board_state', return_value=state), \
             patch.object(t, 'board_set', return_value={'moved': True}) as move, \
             patch.object(t, 'write_board_state'):
            result = t.board_sync('run_x')
        self.assertFalse(result.get('skipped'))
        self.assertEqual(move.call_args[0][0], 'in-review')

    def test_sync_after_working_other_run_is_skipped(self):
        workers = [worker('succeeded')]
        state = {'run_id': 'run_new', 'kind': 'explicit-working', 'status': 'in-progress',
                 'at': '2026-10-01T12:00:00+00:00'}
        with patch.object(t, 'run_workers', return_value=workers), \
             patch.object(t, 'record_results', return_value=0), \
             patch.object(t, 'read_board_state', return_value=state), \
             patch.object(t, 'board_set') as move:
            result = t.board_sync('run_old')
        self.assertTrue(result['skipped'])
        move.assert_not_called()

    def test_working_records_current_run_even_when_move_fails(self):
        """A failed column move must not stop later syncs of the current Run from recovering."""
        with patch.object(t, 'board_set', return_value={'moved': False, 'error': 'busy'}), \
             patch.object(t, 'write_board_state') as write_state:
            t.board_working('run_w')
        write_state.assert_called_once_with('run_w', 'explicit-working', 'in-progress', None)

    def test_board_done_main_fails_without_ratings_on_unknown_move(self):
        argv = ['team_control.py', 'board', 'done', '--run', 'run_a', '--rating', 'good']
        with patch.object(t, 'board_set', return_value={'moved': False, 'outcome_unknown': True}), \
             patch.object(t, 'record_dispatch_ratings') as rated, \
             patch.object(t, 'write_board_state') as write_state, \
             patch.object(sys, 'argv', argv):
            code = t.main()
        self.assertEqual(code, 2)
        rated.assert_not_called()
        write_state.assert_not_called()

    def test_board_done_main_records_ratings_only_after_move(self):
        argv = ['team_control.py', 'board', 'done', '--run', 'run_a', '--rating', 'good']
        order = []

        def move(*args, **kwargs):
            order.append('move')
            return {'moved': True, 'to': 'completed'}

        def rate(*args, **kwargs):
            order.append('rate')
            return 1

        with patch.object(t, 'board_set', side_effect=move), \
             patch.object(t, 'record_dispatch_ratings', side_effect=rate), \
             patch.object(t, 'write_board_state') as write_state, \
             patch.object(sys, 'argv', argv):
            code = t.main()
        self.assertEqual(code, 0)
        self.assertEqual(order, ['move', 'rate'])
        write_state.assert_called_once_with('run_a', 'explicit-done', 'completed', '')


class PaginationTests(unittest.TestCase):
    def test_missing_or_repeated_cursor_stops_with_reason(self):
        for cursor in (None, 'same'):
            with self.subTest(cursor=cursor), patch.object(t, 'cli', side_effect=[
                {'result': {'workers': [], 'page': {'hasMore': True, 'nextCursor': cursor}}},
                {'result': {'workers': [], 'page': {'hasMore': True, 'nextCursor': cursor}}},
                RuntimeError('infinite loop')]):
                rows = t.run_workers('run')
                self.assertTrue(rows.reason)


if __name__ == '__main__':
    unittest.main()
