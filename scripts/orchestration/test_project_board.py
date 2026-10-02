"""Project-wide card: the card shows In progress while any Run of the project works."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.orchestration import team_control as t


def worker(outcome=None, space=None):
    space = space or 'x::' + str(t.ROOT)
    return {'projection': {'outcome': outcome, 'workspace': {'id': space},
                           'attention': {'requiresAction': False}}}


class ProjectStateCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = patch.object(t, 'state_root', return_value=Path(self.tmp.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.moves = []

    def fake_set(self, status, note=None, config=None):
        self.moves.append((status, note))
        return {'moved': True, 'to': status}

    def sync(self, run_id, workers):
        with patch.object(t, 'run_workers', return_value=workers), \
             patch.object(t, 'record_results', return_value=0), \
             patch.object(t, 'board_set', side_effect=self.fake_set):
            return t.board_sync(run_id)


class ProjectBoardTests(ProjectStateCase):
    def test_card_stays_in_progress_until_every_run_finishes(self):
        t.write_board_state('run_a', 'launch', 'in-progress', None)
        t.write_board_state('run_b', 'launch', 'in-progress', None)
        self.sync('run_b', [worker('succeeded')])
        self.assertEqual(self.moves[-1][0], 'in-progress')
        self.assertEqual(t.read_board_state()['runs']['run_b']['status'], 'in-review')
        self.sync('run_a', [worker('succeeded')])
        self.assertEqual(self.moves[-1][0], 'in-review')

    def test_review_of_one_run_keeps_card_in_progress_while_another_works(self):
        t.write_board_state('run_b', 'launch', 'in-progress', None)
        with patch.object(t, 'board_set', side_effect=self.fake_set):
            t.board_review('確認待ち', 'run_a')
        self.assertEqual(self.moves[-1][0], 'in-progress')
        self.assertEqual(t.read_board_state()['runs']['run_a']['kind'], 'explicit-review')

    def test_pending_while_another_run_works_shows_waiting_note(self):
        t.write_board_state('run_b', 'launch', 'in-progress', None)
        with patch.object(t, 'load_config', return_value={}), \
             patch.object(t, 'board_set', side_effect=self.fake_set):
            t.board_pending('承認待ち', 'run_a')
        self.assertEqual(self.moves[-1][0], 'in-progress')
        self.assertIn('判断待ち', self.moves[-1][1])

    def test_done_of_one_run_does_not_complete_card_while_another_works(self):
        t.write_board_state('run_b', 'launch', 'in-progress', None)
        argv = ['team_control.py', 'board', 'done', '--run', 'run_a']
        with patch.object(t, 'board_set', side_effect=self.fake_set), patch.object(sys, 'argv', argv):
            code = t.main()
        self.assertEqual(code, 0)
        self.assertEqual(self.moves[-1][0], 'in-progress')

    def test_done_completes_card_when_nothing_else_is_open(self):
        t.write_board_state('run_a', 'explicit-review', 'in-review', None)
        argv = ['team_control.py', 'board', 'done', '--run', 'run_a']
        with patch.object(t, 'board_set', side_effect=self.fake_set), patch.object(sys, 'argv', argv):
            self.assertEqual(t.main(), 0)
        self.assertEqual(self.moves[-1][0], 'completed')

    def test_launch_is_not_blocked_by_another_runs_newer_explicit_state(self):
        task = {'role': 'coder', 'target': 't', 'change': 'c', 'constraints': 'x', 'ownership': 'o', 'acceptance': 'a'}
        route = {'agent': 'cursor', 'model': 'composer', 'role': 'coder', 'class': 'STANDARD'}
        receipt = {'ok': True, 'exit_code': 0, 'result': {'state': 'ready', 'dispatchId': 'd1', 'taskId': 't1'}}
        t.write_board_state('run_other', 'explicit-review', 'in-review', None)
        with patch.object(t, 'cli', return_value=receipt), \
             patch.object(t, 'history_append'), \
             patch.object(t, 'board_set', side_effect=self.fake_set):
            real_now = t.now
            first = [True]

            def fake_now():
                if first[0]:
                    first[0] = False
                    return t.dt.datetime(2000, 1, 1, tzinfo=t.dt.timezone.utc)
                return real_now()
            with patch.object(t, 'now', side_effect=fake_now):
                result = t.dispatch(task, route, 'run_new', execute=True)
        self.assertEqual(self.moves[-1][0], 'in-progress')
        self.assertFalse(result['board'].get('skipped'))

    def test_legacy_single_run_state_is_read_as_one_run(self):
        t.save_json(Path(self.tmp.name) / t.BOARD_STATE_REL,
                    {'run_id': 'run_old', 'kind': 'sync', 'status': 'in-review', 'at': t.now().isoformat()})
        self.assertEqual(list(t.board_runs(t.read_board_state())), ['run_old'])

    def test_completed_runs_are_pruned(self):
        t.write_board_state('run_a', 'explicit-done', 'completed', None)
        t.write_board_state('run_b', 'launch', 'in-progress', None)
        self.assertEqual(list(t.read_board_state()['runs']), ['run_b'])

    def test_busy_note_names_the_working_runs(self):
        t.write_board_state('run_b', 'launch', 'in-progress', None)
        with patch.object(t, 'board_set', side_effect=self.fake_set):
            t.board_review('確認待ち', 'run_a')
        self.assertIn('run_b', self.moves[-1][1])
        self.assertIn('確認待ち', self.moves[-1][1])

    def test_sync_keeps_its_own_result_in_the_note_while_another_works(self):
        t.write_board_state('run_a', 'launch', 'in-progress', None)
        t.write_board_state('run_b', 'launch', 'in-progress', None)
        self.sync('run_b', [worker('succeeded')])
        self.assertIn('1件成功', self.moves[-1][1])

    def test_launch_keeps_another_runs_question_in_the_note(self):
        t.write_board_state('run_q', 'explicit-pending', 'in-review', 'API方針')
        task = {'role': 'coder', 'target': 't', 'change': 'c', 'constraints': 'x', 'ownership': 'o', 'acceptance': 'a'}
        receipt = {'ok': True, 'exit_code': 0, 'result': {'state': 'ready', 'dispatchId': 'd1', 'taskId': 't1'}}
        with patch.object(t, 'cli', return_value=receipt), patch.object(t, 'history_append'), \
             patch.object(t, 'board_set', side_effect=self.fake_set):
            t.dispatch(task, {'agent': 'cursor', 'model': 'm'}, 'run_new', execute=True)
        self.assertEqual(self.moves[-1][0], 'in-progress')
        self.assertIn('判断待ち', self.moves[-1][1])
        self.assertIn('API方針', self.moves[-1][1])

    def test_failed_keeps_another_runs_question_in_the_note(self):
        t.write_board_state('run_q', 'explicit-pending', 'in-review', 'API方針')
        with patch.object(t, 'board_set', side_effect=self.fake_set):
            t.board_failed('テスト失敗', 'run_a')
        self.assertIn('中断: テスト失敗', self.moves[-1][1])
        self.assertIn('API方針', self.moves[-1][1])

    def test_explicit_action_that_cannot_record_exits_2(self):
        for argv in (['board', 'review', '--run', 'run_a'],
                     ['board', 'pending', '--run', 'run_a', '--reason', 'r'],
                     ['board', 'failed', '--run', 'run_a', '--reason', 'r']):
            with self.subTest(argv=argv), \
                 patch.object(t, 'board_set', return_value={'moved': False, 'reason': 'workspace card not found'}), \
                 patch.object(sys, 'argv', ['team_control.py', *argv]):
                self.assertEqual(t.main(), 2)

    def test_sync_keeps_another_runs_question_in_the_note(self):
        t.write_board_state('run_q', 'explicit-pending', 'user-pending', 'API方針')
        t.write_board_state('run_b', 'launch', 'in-progress', None)
        self.sync('run_b', [worker('succeeded')])
        self.assertEqual(self.moves[-1][0], 'in-review')
        self.assertIn('API方針', self.moves[-1][1])

    def test_history_goes_to_the_main_checkout(self):
        t.history_append({'event': 'x'})
        self.assertTrue((Path(self.tmp.name) / t.HISTORY_REL).exists())

    def test_unregistered_run_still_cannot_move_card(self):
        t.write_board_state('run_a', 'launch', 'in-progress', None)
        result = self.sync('run_old', [worker('succeeded')])
        self.assertTrue(result['skipped'])
        self.assertEqual(self.moves, [])


class AggregateTests(unittest.TestCase):
    def test_aggregate(self):
        e = lambda s: {'status': s}
        self.assertEqual(t.project_status({}), 'completed')
        self.assertEqual(t.project_status({'a': e('in-review'), 'b': e('in-progress')}), 'in-progress')
        self.assertEqual(t.project_status({'a': e('in-review'), 'b': e('completed')}), 'in-review')
        self.assertEqual(t.project_status({'a': e('user-pending')}), 'user-pending')
        self.assertEqual(t.project_status({'a': e('user-pending'), 'b': e('in-review')}), 'in-review')


class WorktreeTests(unittest.TestCase):
    def test_new_worktree_task_uses_new_child(self):
        task = {'role': 'coder', 'title': 'x', 'target': 't', 'change': 'c', 'constraints': 'x',
                'ownership': 'o', 'acceptance': 'a', 'worktree': 'new'}
        argv = t.dispatch(task, {'agent': 'cursor', 'model': 'composer'}, 'run_20261002_speedup')['argv']
        self.assertEqual(argv[argv.index('--worktree') + 1], 'new-child')
        self.assertTrue(argv[argv.index('--name') + 1].startswith('ai-'))

    def test_default_task_stays_in_this_folder(self):
        task = {'role': 'reviewer', 'target': 't', 'change': 'c', 'constraints': 'x', 'ownership': 'o', 'acceptance': 'a'}
        argv = t.dispatch(task, {'agent': 'cursor', 'model': 'm'}, 'run_x')['argv']
        self.assertEqual(argv[argv.index('--worktree') + 1], 'path:' + str(t.ROOT))
        self.assertNotIn('--name', argv)

    def test_unknown_worktree_value_is_rejected(self):
        task = {'role': 'coder', 'target': 't', 'change': 'c', 'constraints': 'x', 'ownership': 'o',
                'acceptance': 'a', 'worktree': 'somewhere'}
        with self.assertRaises(ValueError):
            t.dispatch(task, {'agent': 'cursor', 'model': 'm'}, 'run_x')

    def test_reviewer_cannot_ask_for_a_new_worktree(self):
        task = {'role': 'reviewer', 'target': 't', 'change': 'c', 'constraints': 'x', 'ownership': 'o',
                'acceptance': 'a', 'worktree': 'new'}
        with self.assertRaises(ValueError):
            t.dispatch(task, {'agent': 'cursor', 'model': 'm'}, 'run_x')

    def test_separate_git_dir_falls_back_to_own_folder(self):
        # git itself does not record the main folder of a --separate-git-dir repository.
        with tempfile.TemporaryDirectory() as tmp:
            main, child, gitdir = Path(tmp) / 'main', Path(tmp) / 'child', Path(tmp) / 'separate.git'
            main.mkdir()

            def git(*args):
                subprocess.run(['git', *args], cwd=main, check=True, capture_output=True)
            git('init', '-q', '--separate-git-dir', str(gitdir))
            git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x')
            git('worktree', 'add', '-q', str(child))
            with patch.object(t, 'ROOT', child.resolve()):
                self.assertEqual(t.norm_path(t.state_root()), t.norm_path(child))

    def test_workers_in_other_worktrees_of_the_project_count(self):
        rows = [worker('succeeded'), worker('succeeded', space='x::Z:/wt/child'), worker(None, space='x::Z:/other')]
        with patch.object(t, 'project_paths', return_value={t.norm_path(t.ROOT), t.norm_path('Z:/wt/child')}), \
             patch.object(t, 'cli', return_value={'result': {'workers': rows, 'page': {}}}):
            self.assertEqual(len(t.run_workers('run_x')), 2)

    def test_state_root_of_a_worktree_is_the_main_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            main, child = Path(tmp) / 'main', Path(tmp) / 'child'
            main.mkdir()

            def git(*args):
                subprocess.run(['git', *args], cwd=main, check=True, capture_output=True)
            git('init', '-q')
            git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x')
            git('worktree', 'add', '-q', str(child))
            with patch.object(t, 'ROOT', child.resolve()):
                self.assertEqual(t.norm_path(t.state_root()), t.norm_path(main))
                self.assertIn(t.norm_path(child), t.project_paths())
            with patch.object(t, 'ROOT', main.resolve()):
                self.assertEqual(t.norm_path(t.state_root()), t.norm_path(main))

    def test_subfolder_layout_finds_card_and_child_workers(self):
        with tempfile.TemporaryDirectory() as tmp:
            main, child = Path(tmp) / 'main', Path(tmp) / 'child'
            (main / 'sub').mkdir(parents=True)

            def git(*args):
                subprocess.run(['git', *args], cwd=main, check=True, capture_output=True)
            git('init', '-q')
            git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x')
            git('worktree', 'add', '-q', str(child))
            with patch.object(t, 'ROOT', (main / 'sub').resolve()):
                self.assertIn(t.norm_path(child), t.project_paths())
                listing = {'result': {'worktrees': [{'id': 'w1', 'path': str(main)}]}}
                with patch.object(t, 'cli', return_value=listing):
                    self.assertEqual(t.board_card()['id'], 'w1')

    def test_state_root_outside_git_is_root(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(t, 'ROOT', Path(tmp)):
            self.assertEqual(t.norm_path(t.state_root()), t.norm_path(tmp))


if __name__ == '__main__':
    unittest.main()
