import io
import os
import shlex
import subprocess
import sys
import unittest
from unittest.mock import patch
from scripts.orchestration import team_control as t


def guard_real_push(event, args):
    if event == 'subprocess.Popen':
        words = shlex.split(args[1]) if isinstance(args[1], str) else list(args[1])
        if words and os.path.basename(str(words[0])).lower() in ('git', 'git.exe') and 'push' in words[1:]:
            raise AssertionError('tests must mock git push before subprocess execution')


sys.addaudithook(guard_real_push)


class DispatchRatingTests(unittest.TestCase):
    def test_real_push_is_blocked_in_kit_suite(self):
        with self.assertRaisesRegex(AssertionError, 'git push'):
            subprocess.run(['git', 'push', 'origin', 'main'])

    def test_doctor_preserves_required_port_metadata(self):
        specs = [{'name': 'service', 'port': 8188}, {'name': 'required', 'port': 1, 'required': True},
                 {'name': 'file', 'path': 'missing'}]
        with patch.object(t, 'cli', return_value={'result': {'runtime': {'state': 'ready'}}}), \
                patch('socket.socket') as socket, patch.object(t, 'resolve_check_path') as path:
            socket.return_value.__enter__.return_value.connect_ex.return_value = 1
            path.return_value.exists.return_value = False
            data = t.doctor({'doctor_checks': specs})
        self.assertEqual(data['checks'], {'service': False, 'required': False, 'file': False})
        self.assertEqual(data['check_specs']['required']['required'], True)

    def events(self):
        return [{'event': 'start', 'dispatch_id': d, 'run_id': 'R', 'work_type': work,
                 'used': {'agent': d, 'model': d}} for d, work in [('a', 'code'), ('b', 'review')]] + [
                    {'event': 'result', 'dispatch_id': 'a', 'outcome': 'failed'},
                    {'event': 'result', 'dispatch_id': 'b', 'outcome': 'succeeded'}]

    def test_separate_suggestions_and_reasons(self):
        with patch.object(t, 'history_events', return_value=self.events()), patch.object(t, 'fixed_findings', return_value=2):
            rows = t.suggest_rating('R', 'mock-report')['dispatches']
        self.assertEqual([r['suggested_rating'] for r in rows], ['bad', 'good'])
        self.assertTrue(all(r['reasons'] for r in rows))
        self.assertFalse(any('b:' in reason for reason in rows[0]['reasons']))

    def test_repeated_rate_cli_and_invalid_selection_is_atomic(self):
        with patch.object(t, 'history_events', return_value=self.events()), \
                patch.object(t, 'history_append') as append, \
                patch.object(t, 'board_set', return_value={'moved': True, 'to': 'completed'}), \
                patch.object(t, 'write_board_state'), \
                patch.object(sys, 'argv', ['team_control.py', 'board', 'done', '--run', 'R',
                    '--rate', 'a=bad', '--rate', 'b=good', '--rating-source', 'ai-suggested']), \
                patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(t.main(), 0)
        self.assertEqual([(c.args[0]['dispatch_id'], c.args[0]['rating']) for c in append.call_args_list], [('a', 'bad'), ('b', 'good')])
        with patch.object(t, 'history_events', return_value=self.events()), \
                patch.object(t, 'history_append') as append, patch.object(t, 'board_set', return_value={}), \
                patch.object(sys, 'argv', ['team_control.py', 'board', 'done', '--run', 'R', '--rating', 'good']), \
                patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(t.main(), 2)
            append.assert_not_called()
        with patch.object(t, 'history_events', return_value=self.events()), patch.object(t, 'history_append') as append:
            with self.assertRaises(ValueError):
                t.record_dispatch_ratings('R', ['a=good', 'unknown=bad'])
            append.assert_not_called()

    def test_invalid_rate_with_successful_move_mock_skips_board_and_history(self):
        """H4: CLI validates ratings before board_set even when move would succeed."""
        with patch.object(t, 'history_events', return_value=self.events()), \
                patch.object(t, 'history_append') as append, \
                patch.object(t, 'board_set', return_value={'moved': True, 'to': 'completed'}) as move, \
                patch.object(t, 'write_board_state') as write_state, \
                patch.object(sys, 'argv', ['team_control.py', 'board', 'done', '--run', 'R', '--rate', 'nope=bad']), \
                patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(t.main(), 2)
        move.assert_not_called()
        append.assert_not_called()
        write_state.assert_not_called()
