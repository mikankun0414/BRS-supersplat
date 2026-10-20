from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.orchestration import team_control as t

FIX = Path(__file__).resolve().parent / 'fixtures'


def settled(dispatch_id, outcome='succeeded'):
    return {'dispatchId': dispatch_id, 'taskId': 'task_' + dispatch_id,
            'projection': {'outcome': outcome, 'workspace': {'id': 'x::' + str(t.ROOT)},
                           'attention': {'requiresAction': False}}}


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = patch.object(t, 'ROOT', Path(self.tmp.name))
        self.root.start()

    def tearDown(self):
        self.root.stop(); self.tmp.cleanup()

    def lines(self):
        return [json.loads(l) for l in (t.ROOT / t.HISTORY_REL).read_text(encoding='utf-8').splitlines()]

    def test_work_type_from_task_or_guessed_from_role(self):
        self.assertEqual(t.work_type({'role': 'coder', 'work_type': 'ue-cpp'}), ('ue-cpp', False))
        self.assertEqual(t.work_type({'role': 'reviewer'}), ('review', True))
        self.assertEqual(t.work_type({'role': 'unknown-role'}), ('other', True))

    def test_launch_writes_start_event(self):
        task = t.read_json(FIX / 'smoke.json') | {'work_type': 'docs'}
        route = {'agent': 'cursor', 'model': 'composer-2.5', 'effort': None, 'origin': 'cursor', 'class': 'FAST', 'role': 'tester',
                 'assigned_unavailable': {'assigned': {'agent': 'claude'}, 'rejected': [{'reason': 'provider auth or quota unavailable'}]}}
        receipt = {'ok': True, 'exit_code': 0, 'result': {'state': 'ready', 'runId': 'run_1', 'taskId': 'task_a', 'dispatchId': 'ctx_a'}}
        with patch.object(t, 'cli', return_value=receipt), patch.object(t, 'board_set', return_value={}), \
                patch.object(t, 'load_config', return_value={}):
            t.dispatch(task, route, 'run_1', True)
        event = self.lines()[0]
        self.assertEqual(event['event'], 'start')
        self.assertEqual((event['dispatch_id'], event['work_type'], event['work_type_guessed']), ('ctx_a', 'docs', False))
        self.assertEqual(event['used']['model'], 'composer-2.5')
        self.assertEqual(event['assigned'], {'agent': 'claude'})
        self.assertEqual(event['fallback_reason'], ['provider auth or quota unavailable'])
        self.assertEqual(event['launch_state'], 'ready')
        self.assertEqual(event['workflow'], {'mode': 'normal'})

    def test_failed_launch_is_recorded_as_launch_failed(self):
        task = t.read_json(FIX / 'smoke.json')
        route = {'agent': 'codex', 'model': 'gpt-6-luna', 'effort': 'medium', 'origin': 'openai', 'class': 'FAST', 'role': 'tester'}
        with patch.object(t, 'cli', return_value={'ok': False, 'exit_code': 1}), patch.object(t, 'load_config', return_value={}):
            t.dispatch(task, route, 'run_1', True)
        kinds = [(e['event'], e.get('outcome')) for e in self.lines()]
        self.assertEqual(kinds, [('start', None), ('result', 'launch_failed')])

    def test_result_written_once_per_dispatch_with_duration(self):
        t.history_append({'event': 'start', 'dispatch_id': 'ctx_a', 'run_id': 'run_1', 'at': '2026-10-01T00:00:00+00:00'})
        with patch.object(t, 'now', return_value=t.dt.datetime(2026, 10, 1, 0, 30, tzinfo=t.UTC)):
            self.assertEqual(t.record_results([settled('ctx_a')]), 1)
            self.assertEqual(t.record_results([settled('ctx_a')]), 0)
        results = [e for e in self.lines() if e['event'] == 'result']
        self.assertEqual(len(results), 1)
        self.assertEqual((results[0]['outcome'], results[0]['duration_min']), ('succeeded', 30.0))

    def test_unsettled_worker_not_recorded(self):
        self.assertEqual(t.record_results([settled('ctx_b', outcome=None)]), 0)

    def test_rating_applies_to_every_dispatch_of_run(self):
        for d in ('ctx_a', 'ctx_b'):
            t.history_append({'event': 'start', 'dispatch_id': d, 'run_id': 'run_1'})
        t.history_append({'event': 'start', 'dispatch_id': 'ctx_c', 'run_id': 'run_2'})
        self.assertEqual(t.record_rating('run_1', 'good', '速くて正確'), 2)
        ratings = [e for e in self.lines() if e['event'] == 'rating']
        self.assertEqual({e['dispatch_id'] for e in ratings}, {'ctx_a', 'ctx_b'})
        with self.assertRaises(ValueError):
            t.record_rating('run_1', 'great', '')

class SuggestTests(unittest.TestCase):
    setUp = HistoryTests.setUp
    tearDown = HistoryTests.tearDown
    lines = HistoryTests.lines
    def events(self, outcome='succeeded', duration=5, work='code'):
        return [
            {'event': 'start', 'dispatch_id': 'old', 'run_id': 'old', 'work_type': work, 'used': {'agent': 'codex', 'model': 'm'}},
            {'event': 'result', 'dispatch_id': 'old', 'outcome': 'succeeded', 'duration_min': 10},
            {'event': 'start', 'dispatch_id': 'different', 'run_id': 'old2', 'work_type': 'video', 'used': {'agent': 'codex', 'model': 'm'}},
            {'event': 'result', 'dispatch_id': 'different', 'outcome': 'succeeded', 'duration_min': 100},
            {'event': 'start', 'dispatch_id': 'now', 'run_id': 'R', 'work_type': work, 'used': {'agent': 'codex', 'model': 'm'}},
            {'event': 'result', 'dispatch_id': 'now', 'outcome': outcome, 'duration_min': duration}]
    def test_suggest_outcome_duration_median_without_writing(self):
        with patch.object(t, 'history_events', return_value=self.events()):
            result = t.suggest_rating('R')
        self.assertEqual(result['suggested_rating'], 'good')
        self.assertEqual(result['dispatches'][0]['median_min'], 10)
        self.assertFalse((t.ROOT / t.HISTORY_REL).exists())
        with patch.object(t, 'history_events', return_value=self.events('failed')):
            self.assertEqual(t.suggest_rating('R')['suggested_rating'], 'bad')
        with patch.object(t, 'history_events', return_value=self.events(duration=25)):
            self.assertEqual(t.suggest_rating('R')['suggested_rating'], 'ok')
    def test_review_fixed_count_report_and_unknown(self):
        report = t.ROOT / 'review.json'
        report.write_text(json.dumps({'findings': [{'status': 'fixed'}, {'status': 'open'}, {'fixed': True}]}), encoding='utf-8')
        with patch.object(t, 'history_events', return_value=self.events(work='review')):
            result = t.suggest_rating('R', str(report))
            self.assertEqual(result['review_findings_fixed'], 2)
            self.assertEqual(result['suggested_rating'], 'good')
            self.assertIsNone(t.suggest_rating('R')['review_findings_fixed'])
        report.write_text('### 1. A\n状態: FIXED\n### 2. B\n状態: OPEN\n', encoding='utf-8')
        self.assertEqual(t.fixed_findings(report), 1)
        report.write_text('### 1. A\n修正案: ...\n', encoding='utf-8')
        self.assertIsNone(t.fixed_findings(report))
    def test_missing_result_or_run_does_not_assume_success(self):
        with patch.object(t, 'history_events', return_value=self.events()[:-1]):
            self.assertEqual(t.suggest_rating('R')['suggested_rating'], 'ok')
        with patch.object(t, 'history_events', return_value=[]):
            with self.assertRaises(ValueError): t.suggest_rating('missing')
    def test_rating_source_and_cli_no_answer(self):
        import io
        t.history_append({'event': 'start', 'dispatch_id': 'd', 'run_id': 'R'})
        t.record_rating('R', 'good', 'accepted', 'ai-suggested')
        self.assertEqual(self.lines()[-1]['rating_source'], 'ai-suggested')
        with self.assertRaises(ValueError): t.record_rating('R', 'good', '', 'automatic')
        before = (t.ROOT / t.HISTORY_REL).read_bytes()
        with patch.object(sys, 'argv', ['team_control.py', 'board', 'done', '--run', 'R', '--rating-source', 'ai-suggested']), \
                patch.object(t, 'board_set', return_value={}), patch('sys.stdout', new_callable=io.StringIO):
            t.main()
        self.assertEqual((t.ROOT / t.HISTORY_REL).read_bytes(), before)
    def test_suggest_cli(self):
        import io
        with patch.object(t, 'history_events', return_value=self.events()), \
                patch.object(sys, 'argv', ['team_control.py', 'history', 'suggest', '--run', 'R']), \
                patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(t.main(), 0)
            self.assertEqual(json.loads(out.getvalue())['suggested_rating'], 'good')
