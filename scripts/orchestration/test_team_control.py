import copy
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from scripts.orchestration import team_control as t
from scripts.orchestration.budget_scheduler import evaluate_budget
from scripts.orchestration import antigravity_quota

FIX = Path(__file__).resolve().parent / 'fixtures'

class RoutingTests(unittest.TestCase):
    def setUp(self):
        self.config = t.read_json(FIX / 'ai-team.json')
        self.data = {'checked_at':t.now().isoformat(), 'codex_models':[
            {'model':c['model'],'efforts':['medium']} for c in self.config['candidates'] if c['agent']=='codex'],
            'providers':{name:{'status':'ok','updated_at_ms':t.now().timestamp()*1000,
                'windows':[{'used_percent':value}]} for name,value in [('codex',43),('claude',18),('cursor',0),('antigravity',0)]}}
        # Codex gate tests must not pass through a fallback provider.
        self.codex_only=dict(self.config, candidates=[c for c in self.config['candidates'] if c['agent']=='codex'])

    def test_normal_development_prefers_grok_without_fast_variant(self):
        route = t.choose(self.data, self.config)
        self.assertEqual((route['agent'], route['model']), ('cursor', 'grok-4.7-high'))
        grok = next(c for c in self.config['candidates'] if c['model'] == 'grok-4.7-high')
        self.assertIn('STANDARD', grok['classes'])
        self.assertNotIn('FAST', grok['classes'])
        self.assertNotIn('-fast', route['model'])

    def test_lightweight_iteration_prefers_luna(self):
        self.assertEqual(t.choose(self.data, self.config, 'FAST', 'coder')['model'], 'gpt-6-luna')
        self.assertEqual(t.choose(self.data, self.config, 'FAST', 'research')['model'], 'gpt-6-luna')

    def test_quota_closed_and_no_auto_upgrade(self):
        self.data['providers']['codex']['windows'][0]['used_percent']=98
        self.assertTrue(t.choose(self.data,self.codex_only)['blocked'])

    def test_expiring_underused_short_window_prioritized(self):
        config=copy.deepcopy(self.config)
        config.pop('routing_preferences', None)
        c=copy.deepcopy(config['candidates'][0]); c.update(agent='cursor',model='composer-2.5',origin='cursor')
        config['candidates'].insert(0,c)
        self.data['providers']['cursor']['windows']=[{'window':'monthly','used_percent':55,
            'window_minutes':43200,'resets_at':(t.now().timestamp()+30240*60)*1000}]
        self.data['providers']['codex']['windows']=[{'window':'session','used_percent':30,
            'window_minutes':300,'resets_at':(t.now().timestamp()+30*60)*1000}]
        self.assertEqual(t.choose(self.data,config)['agent'],'codex')

    def test_cursor_routes_on_buckets_not_plan_total(self):
        reset=(t.now().timestamp()+27*24*3600)*1000
        rate={'status':'ok','updatedAt':t.now().timestamp()*1000,
            'monthly':{'usedPercent':100,'windowMinutes':43200,'resetsAt':reset},
            'buckets':[{'name':'Cursor Models','usedPercent':6,'windowMinutes':43200,'resetsAt':reset},
                       {'name':'Other Models','usedPercent':24,'windowMinutes':43200,'resetsAt':reset}]}
        with patch.object(t,'load_config',return_value=self.config), patch.object(t,'cli',return_value={'ok':True,'result':{'rateLimits':{'cursor':rate}}}), \
             patch.object(t.antigravity_quota,'probe',return_value={'status':'unknown','windows':[]}), patch.object(t, 'save_json'):
            cursor=t.snapshot()['providers']['cursor']
        self.assertEqual(cursor['windows'][0]['used_percent'],24)
        self.assertEqual(cursor['models']['composer-2.5'][0]['used_percent'],6)
        self.assertEqual(cursor['models']['grok-4.7-high'][0]['used_percent'],6)
        self.assertEqual(cursor['models']['claude-opus-5-5-high'][0]['used_percent'],24)
        self.assertEqual(t.model_provider({'providers':{'cursor':cursor}},
            {'agent':'cursor','model':'claude-fable-5-1-high'})['windows'][0]['used_percent'],24)

    def test_unknown_quota_not_zero(self):
        self.data['providers']['codex']['windows']=[]
        self.assertTrue(t.choose(self.data,self.codex_only)['blocked'])

    def test_stale_provider_and_environment_rejected(self):
        self.data['providers']['codex']['updated_at_ms']-=16*60*1000
        self.assertTrue(t.choose(self.data,self.codex_only)['blocked'])
        self.data['checked_at']=(t.now()-dt.timedelta(hours=25)).isoformat()
        self.assertTrue(t.choose(self.data,self.codex_only,role='reviewer')['blocked'])

    def test_auth_expired(self):
        self.data['providers']['codex']['status']='error'
        self.assertTrue(t.choose(self.data,self.codex_only)['blocked'])

    def test_catalog_and_effort_are_required(self):
        self.data['codex_models']=[]
        self.assertTrue(t.choose(self.data,self.codex_only)['blocked'])
        self.setUp(); self.data['codex_models'][0]['efforts']=[]
        self.assertTrue(t.choose(self.data,self.codex_only)['blocked'])

    def test_review_different_origin(self):
        result=t.choose(self.data,self.config,role='reviewer',exclude_origin='openai')
        self.assertNotEqual(result['origin'],'openai')
        for name in ('antigravity','cursor','claude'):
            self.data['providers'][name]['status']='error'
        self.assertTrue(t.choose(self.data,self.config,role='reviewer',exclude_origin='openai')['blocked'])

    def test_unavailable_assigned_candidate_falls_back(self):
        self.data['providers']['claude']['status']='error'
        result=t.choose(self.data,self.config,role='reviewer',pinned={'agent':'claude'})
        self.assertFalse(result['blocked'])
        self.assertNotEqual(result['agent'],'claude')
        self.assertEqual(result['assigned_unavailable']['assigned'],{'agent':'claude'})

    def test_expired_cursor_sign_in_falls_back_with_reason(self):
        self.data['providers']['cursor'].update(status='error',error='Cursor sign-in expired')
        result=t.choose(self.data,self.config,pinned={'agent':'cursor','model':'composer-2.5'})
        self.assertFalse(result['blocked'])
        self.assertNotEqual(result['agent'],'cursor')
        reasons=[r['reason'] for r in result['assigned_unavailable']['rejected']]
        self.assertIn('provider auth or quota unavailable: Cursor sign-in expired',reasons)

    def test_assigned_candidate_overrides_ranking(self):
        result=t.choose(self.data,self.config,pinned={'agent':'antigravity','model':'gemini-3.8-flash-medium'})
        self.assertEqual((result['agent'],result['model']),('antigravity','gemini-3.8-flash-medium'))

    def test_antigravity_quota_is_per_model(self):
        reset = (t.now() + dt.timedelta(hours=1)).isoformat()
        status={'userStatus':{'cascadeModelConfigData':{'clientModelConfigs':[
            {'modelId':'gemini-3.8-flash-high','quotaInfo':{'resetTime':reset}},
            {'modelId':'claude-sonnet-5-5-high','quotaInfo':{'remainingFraction':1,'resetTime':reset}}]}}}
        provider=antigravity_quota.parse_status(status,t.now().timestamp()*1000)
        self.assertEqual(provider['models']['gemini-3.8-flash-high'][0]['used_percent'],100)
        self.assertEqual(provider['models']['claude-sonnet-5-5-high'][0]['used_percent'],0)
        self.data['providers']['antigravity']=provider
        result=t.choose(self.data,self.config,role='reviewer',exclude_origin='openai')
        self.assertEqual((result['agent'],result['model']),('cursor','claude-opus-5-5-high'))
        rejected={r['model']:r['reason'] for r in result['rejected']}
        self.assertNotIn('provider auth', rejected['gemini-3.8-flash-high'])
        self.assertIn('claude-sonnet-5-5-high', {item['model'] for item in result['alternatives']})

    def test_antigravity_unreachable_is_unknown(self):
        self.assertEqual(antigravity_quota.parse_status({},1)['status'],'unknown')

    def test_kickoff_plan_task_routes_to_assigned_planner(self):
        task=t.read_json(FIX / 'plan-kickoff.json')
        t.task_spec(task)
        result=t.choose(self.data,self.config,task['class'],task['role'],pinned=task['assigned'])
        self.assertEqual((result['agent'],result['model']),('codex','gpt-6.1-sol'))

    def test_assigned_candidate_keeps_quota_gate(self):
        self.data['providers']['antigravity']['windows'][0]['used_percent']=99
        result=t.choose(self.data,self.config,pinned={'agent':'antigravity'})
        self.assertNotEqual(result.get('agent'),'antigravity')
        self.assertIn('assigned_unavailable',result)

    def test_max_requires_rationale(self):
        self.assertTrue(t.choose(self.data,self.config,'MAX',role='judge')['blocked'])
        self.assertFalse(t.choose(self.data,self.config,'MAX',role='judge',max_reason='Strong failed twice')['blocked'])

    def test_dry_run_does_not_call_cli(self):
        task=t.read_json(FIX / 'smoke.json')
        with patch.object(t,'cli') as mock:
            result=t.dispatch(task,t.choose(self.data,self.config),'example-run',False)
            self.assertTrue(result['dry_run']); mock.assert_not_called()

    def test_task_contract_missing_field(self):
        with self.assertRaises(ValueError): t.task_spec({'target':'x'})

    def test_failed_receipt_is_not_started_or_retried(self):
        task=t.read_json(FIX / 'smoke.json')
        with tempfile.TemporaryDirectory() as tmp, patch.object(t,'ROOT',Path(tmp)), patch.object(t,'cli',return_value={'ok':False,'outcome_unknown':True,'exit_code':1}) as mock:
            result=t.dispatch(task,t.choose(self.data,self.config),'example-run',True)
            self.assertFalse(result['started']); self.assertTrue(Path(result['receipt_path']).exists()); self.assertEqual(mock.call_count,1)

    def test_rpc_ok_failed_state_not_started(self):
        task=t.read_json(FIX / 'smoke.json')
        with tempfile.TemporaryDirectory() as tmp, patch.object(t,'ROOT',Path(tmp)), patch.object(t,'cli',return_value={'ok':True,'result':{'state':'failed'},'exit_code':0}) as mock:
            result=t.dispatch(task,t.choose(self.data,self.config),'example-run',True)
            self.assertFalse(result['started']); self.assertEqual(mock.call_count,1)

    def test_jev_missing_key_requires_coordinator(self):
        with patch.dict('os.environ',{},clear=True):
            answer=t.jev('classify-task','does-not-exist')
            self.assertTrue(answer['skipped']); self.assertTrue(answer['requires_coordinator_decision'])

    def test_present_unknown_upper_window_prevents_routing(self):
        for value in (None, 'unknown', 'missing'):
            with self.subTest(value=value), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                catalog = root / 'models_cache.json'
                catalog.write_text(json.dumps({'models': [{'slug': 'gpt-6-luna',
                    'supported_reasoning_levels': [{'effort': 'medium'}]}]}), encoding='utf-8')
                upper = {} if value == 'missing' else {'usedPercent': value}
                accounts = {'ok': True, 'result': {'rateLimits': {'codex': {'status': 'ok',
                    'updatedAt': t.now().timestamp()*1000, 'session': {'usedPercent': 30}, 'weekly': upper}}}}
                with patch.object(t, 'ROOT', root), patch.dict('os.environ', {'CODEX_HOME': tmp}), \
                        patch.object(t, 'cli', side_effect=[accounts, {'ok': True, 'result': {}}]), \
                        patch.object(t, 'save_json'), patch.object(t.antigravity_quota, 'probe', return_value={'status': 'unknown', 'windows': []}):
                    data = t.snapshot()
                self.assertEqual(len(data['providers']['codex']['windows']), 2)
                self.assertTrue(t.choose(data, self.config)['blocked'])

    def test_orca_cli_resolution_respects_platform_and_managed_context(self):
        cases = [('linux', {}, 'orca-ide'), ('linux', {'ORCA_TERMINAL_HANDLE': 'real-handle'}, 'orca'),
                 ('win32', {}, 'orca'), ('darwin', {}, 'orca'),
                 ('linux', {'ORCA_DEV_REPO_ROOT': '/dev'}, 'orca-dev'),
                 ('linux', {'ORCA_CLI_COMMAND': '/explicit/orca', 'ORCA_DEV_REPO_ROOT': '/dev'}, '/explicit/orca')]
        for platform, env, expected in cases:
            with self.subTest(platform=platform, env=env), patch.dict('os.environ', env, clear=True), \
                    patch.object(t.sys, 'platform', platform):
                self.assertEqual(t.cli_command(), expected)

    def test_external_decision_rejects_future_and_naive_dates_without_launch(self):
        task = t.read_json(FIX / 'smoke.json') | {'external_dependency': True, 'decision_id': 'example'}
        config = self.config
        timestamps = [(t.now()+dt.timedelta(days=10)).isoformat(), '2026-09-30T12:00:00', 'invalid', None]
        for checked_at in timestamps:
            decision = {'example': {'checked_at': checked_at, 'sources': ['local: test'], 'impact': 'test'},
                        'routing-baseline': {'checked_at': t.now().isoformat(), 'sources': ['local: test'], 'impact': 'test'}}
            def read(path):
                path = str(path)
                return decision if path.endswith('EXTERNAL_DECISIONS.json') else config if path.endswith('ai-team.json') else task
            argv = ['team_control.py', 'start', '--task-file', 'task.json', '--run', 'test-run', '--execute']
            with self.subTest(checked_at=checked_at), patch.object(t.sys, 'argv', argv), \
                    patch.object(t, 'read_json', side_effect=read), patch.object(t, 'load_config', return_value=config), patch.object(t, 'snapshot', return_value=self.data), \
                    patch.object(t, 'cli') as launch, patch('builtins.print'):
                self.assertEqual(t.main(), 2)
                launch.assert_not_called()

    def test_internal_task_still_requires_fresh_routing_decision(self):
        task = t.read_json(FIX / 'smoke.json')
        config = self.config
        for record, blocked in [({}, True), ({'checked_at': (t.now()-dt.timedelta(hours=25)).isoformat(),
                'sources': ['local: test'], 'impact': 'test'}, True),
                ({'checked_at': t.now().isoformat(), 'sources': ['local: test'], 'impact': 'test'}, False)]:
            def read(path):
                path = str(path)
                return {'routing-baseline': record} if path.endswith('EXTERNAL_DECISIONS.json') else config if path.endswith('ai-team.json') else task
            argv = ['team_control.py', 'start', '--task-file', 'task.json', '--run', 'test-run']
            with self.subTest(record=record), patch.object(t.sys, 'argv', argv), \
                    patch.object(t, 'read_json', side_effect=read), patch.object(t, 'load_config', return_value=config), patch.object(t, 'snapshot', return_value=self.data), \
                    patch.object(t, 'cli') as launch, patch('builtins.print'):
                self.assertEqual(t.main(), 2 if blocked else 0)
                launch.assert_not_called()

class ProjectConfigTests(unittest.TestCase):
    def test_task_rules_replace_studio_wording(self):
        task = t.read_json(FIX/'smoke.json')
        spec = t.task_spec(task, ['Preserve existing addons and dist/.', 'Verify with Blender 5.2 only.'])
        self.assertIn('Preserve existing addons and dist/. Verify with Blender 5.2 only.', spec)
        self.assertNotIn('MASTER', spec)
        self.assertIn('absolute path', spec)

    def test_doctor_reads_checks_from_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            present = Path(tmp) / 'tool.exe'; present.write_text('x')
            config = {'doctor_checks': [{'name': 'tool', 'path': str(present)},
                                        {'name': 'missing', 'path': str(Path(tmp) / 'no.exe')},
                                        {'name': 'comfy', 'port': 1}]}
            with patch.object(t, 'cli', return_value={'result': {'runtime': {'state': 'ready', 'appVersion': '1'}}}):
                result = t.doctor(config)
        self.assertEqual(result['checks'], {'tool': True, 'missing': False, 'comfy': False})
        self.assertFalse(result['generation_started'])

    def test_pipeline_placeholder_without_pipeline_is_unknown(self):
        with patch.dict(sys.modules, {'scripts.pipeline_config': None}):
            self.assertIsNone(t.resolve_check_path('{pipeline:blender_exe}'))

    def test_jev_model_default_comes_from_config(self):
        argv = ['team_control.py', 'jev', '--mode', 'classify-task', '--state-file', 'x']
        with patch.object(t.sys, 'argv', argv), patch.object(t, 'load_config', return_value={'jev_model': 'jev-1.13.0'}), \
                patch.object(t, 'jev', return_value={'skipped': True}) as call, patch('builtins.print'):
            t.main()
        self.assertEqual(call.call_args.args[2], 'jev-1.13.0')

    def test_quota_bucket_from_config_wins_over_name(self):
        self.assertEqual(t.cursor_bucket_name({'model': 'grok-4.7-high', 'quota_bucket': 'Other Models'}), 'Other Models')
        self.assertEqual(t.cursor_bucket_name({'model': 'grok-4.7-high'}), 'Cursor Models')
        self.assertEqual(t.cursor_bucket_name({'model': 'composer-2.5'}), 'Cursor Models')
        self.assertEqual(t.cursor_bucket_name({'model': 'claude-opus-5-5-high'}), 'Other Models')

class BudgetV2Tests(unittest.TestCase):
    def setUp(self):
        self.targets=t.read_json(FIX / 'ai-team.json')['budget_targets']
        self.clock=1900000000
    def evaluate(self,windows,minutes=5,credits=None,recent=None,important=False):
        return evaluate_budget({'windows':windows,'banked_resets':credits or {}},self.targets,minutes,recent or [],'codex',important,self.clock)
    def window(self,name,usage,reset_minutes=30,duration=300):
        return {'window':name,'used_percent':usage,'resets_at':(self.clock+60*reset_minutes)*1000,'window_minutes':duration}
    def test_short_93_percent_allowed(self):
        self.assertFalse(self.evaluate([self.window('session',93)])['blocked'])
    def test_short_97_allows_short_but_refuses_long(self):
        self.assertFalse(self.evaluate([self.window('session',97)])['blocked'])
        self.assertTrue(self.evaluate([self.window('session',97)],minutes=30)['blocked'])
    def test_short_98_weekly95_monthly95_stop(self):
        for name,usage in [('session',98),('weekly',95),('monthly',95)]:
            self.assertTrue(self.evaluate([self.window(name,usage)])['blocked'])
    def test_upper_window_constrains_short(self):
        result=self.evaluate([self.window('session',20),self.window('weekly',92,1440,10080)])
        self.assertEqual(result['bottleneck'],'weekly')
        safe=self.evaluate([self.window('session',20),self.window('weekly',40,1440,10080)])
        self.assertLess(result['score'],safe['score'])
    def test_pace_and_expiry(self):
        result=self.evaluate([self.window('session',30,60)])
        state=result['windows'][0]
        self.assertAlmostEqual(state['period_progress'],.8)
        self.assertAlmostEqual(state['pace_delta'],-.5)
        later=self.evaluate([self.window('session',30,240)])
        self.assertGreater(result['score'],later['score'])
    def test_monthly_burn_ahead_is_penalized(self):
        over=self.evaluate([self.window('monthly',55,30240,43200)])
        steady=self.evaluate([self.window('monthly',20,30240,43200)])
        self.assertGreater(over['windows'][0]['target_pace_delta'],0)
        self.assertLess(over['score'],steady['score'])
    def test_diversity_small_tie_penalty(self):
        normal=self.evaluate([self.window('session',30)])
        repeat=self.evaluate([self.window('session',30)],recent=['codex']*5)
        self.assertAlmostEqual(normal['score']-repeat['score'],1.25)
    def test_unknown_pace_is_not_fabricated(self):
        result=self.evaluate([{'window':'weekly','used_percent':40}])
        self.assertIsNone(result['windows'][0]['period_progress'])
        self.assertIsNone(result['windows'][0]['time_to_reset_min'])
    def test_reset_passed_and_invalid_percent(self):
        self.assertTrue(self.evaluate([self.window('session',5,-1)])['blocked'])
        self.assertTrue(self.evaluate([self.window('session',-1)])['blocked'])
    def test_ticket_advice_not_automatic_action(self):
        credits={'available_count':2,'credits':[{'status':'available','expires_at':(self.clock+3600)*1000},
            {'status':'available','expires_at':(self.clock-3600)*1000}]}
        result=self.evaluate([self.window('session',96,60),self.window('weekly',89,1440,10080)],credits=credits,important=True)
        self.assertEqual(result['banked_reset_count'],1)
        self.assertTrue(result['reset_review_recommended'])
        self.assertEqual(result['reset_action'],'none')
    def test_ticket_cannot_override_hard_stop(self):
        credits={'available_count':3,'next_expires_at':(self.clock+3600)*1000}
        self.assertTrue(self.evaluate([self.window('session',98)],credits=credits)['blocked'])

    def test_full_use_policy_runs_until_exhausted(self):
        """hard_stop 1.0: keep the chosen AI until its quota is really gone (no early hand-off)."""
        full={'short_window':{'target':.93,'hard_stop':1.0},'weekly':{'target':.88,'hard_stop':1.0},
              'monthly':{'target':.83,'hard_stop':1.0},'reserve':{'weekly':0,'monthly':0}}
        provider={'windows':[self.window('session',97,60),self.window('weekly',99,1440,10080)]}
        result=evaluate_budget(provider,full,30,[],'codex',False,self.clock)
        self.assertFalse(result['blocked'])
        provider={'windows':[self.window('weekly',100,1440,10080)]}
        self.assertTrue(evaluate_budget(provider,full,30,[],'codex',False,self.clock)['blocked'])

if __name__=='__main__': unittest.main()

class ReadOnlySnapshotTests(unittest.TestCase):
    def test_snapshot_no_save_leaves_runtime_absent(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(t, 'ROOT', Path(tmp)), \
                patch.object(t, 'cli', return_value={'ok': True, 'result': {}}), \
                patch.object(t.antigravity_quota, 'probe', return_value={'status': 'unknown', 'windows': []}):
            t.snapshot(save=False)
            self.assertFalse((Path(tmp) / '.ai/runtime').exists())
