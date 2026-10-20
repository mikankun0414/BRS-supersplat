"""Orca team preflight, routing and bounded dispatch. Standard library only."""
from __future__ import annotations
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import re
import statistics
import subprocess
import sys
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scripts.orchestration.budget_scheduler import evaluate_budget
from scripts.orchestration import antigravity_quota
from scripts.orchestration.workflow import finish_check, workflow_contract
UTC = dt.timezone.utc
CLASSES = ('FAST', 'STANDARD', 'STRONG', 'MAX')

def now():
    return dt.datetime.now(UTC)

def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))

def config_path():
    """config/ai-team.json, or Config/ai-team.json in projects that use that casing."""
    for name in ('config/ai-team.json', 'Config/ai-team.json'):
        if (ROOT / name).exists():
            return ROOT / name
    return ROOT / 'config/ai-team.json'

def load_config():
    # Tests point ROOT at an empty folder; a missing config means "no project settings".
    path = config_path()
    return read_json(path) if path.exists() else {}

def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    tmp.replace(path)

def cli_command():
    if os.environ.get('ORCA_CLI_COMMAND'):
        return os.environ['ORCA_CLI_COMMAND']
    if os.environ.get('ORCA_DEV_REPO_ROOT'):
        return 'orca-dev'
    if sys.platform.startswith('linux') and not os.environ.get('ORCA_TERMINAL_HANDLE'):
        return 'orca-ide'
    return 'orca'


# Bind once for this process. An unavailable executable must never silently fall back.
CLI_EXE = shutil.which(cli_command()) or cli_command()


def cli(argv, timeout=30):
    exe = CLI_EXE
    try:
        p = subprocess.run([exe, *argv], cwd=ROOT, capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=timeout)
        try:
            value = json.loads(p.stdout)
        except ValueError:
            value = {'ok': False, 'error': {'code': 'invalid_receipt'}}
        value['exit_code'] = p.returncode
        return value
    except subprocess.TimeoutExpired:
        return {'ok': False, 'outcome_unknown': True, 'error': {'code': 'timeout'}}
    except OSError:
        return {'ok': False, 'error': {'code': 'cli_unavailable'}}

def norm_path(path):
    try:
        path = Path(path).resolve()
    except OSError:
        path = Path(path)
    return os.path.normcase(os.path.normpath(str(path)))


def _git(args):
    try:
        p = subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True,
                           encoding='utf-8', errors='replace', timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return p.stdout.strip() if p.returncode == 0 and p.stdout.strip() else None


def _root_in_checkout():
    """(this checkout's top folder, ROOT relative to it), or (None, None) outside git."""
    top = _git(['rev-parse', '--show-toplevel'])
    if not top:
        return None, None
    try:
        return Path(top).resolve(), Path(ROOT).resolve().relative_to(Path(top).resolve())
    except (OSError, ValueError):
        return None, None


def state_root():
    """The same folder in the main checkout. A worktree shares the main checkout's board state and lock."""
    top, rel = _root_in_checkout()
    listing = _git(['worktree', 'list', '--porcelain']) if top else None
    # git lists the main worktree first (submodules too). With --separate-git-dir git lists the git
    # directory itself and does not know the main folder; then this checkout keeps its own state.
    for line in (listing or '').splitlines():
        if line.startswith('worktree '):
            main = Path(line[len('worktree '):])
            return main / rel if (main / '.git').exists() else ROOT
    return ROOT


def project_paths():
    """ROOT in every git worktree of this project (normalized)."""
    paths = {norm_path(ROOT)}
    top, rel = _root_in_checkout()
    listing = _git(['worktree', 'list', '--porcelain']) if top else None
    for line in (listing or '').splitlines():
        if line.startswith('worktree '):
            # Orca names a worker's workspace by its checkout top, which differs from ROOT in a subfolder layout.
            top_path = Path(line[len('worktree '):])
            paths.update({norm_path(top_path), norm_path(top_path / rel)})
    return paths


def source_check(url):
    try:
        request = urllib.request.Request(url, headers={'User-Agent': 'Orca-MCP-Team/1.0'})
        with urllib.request.urlopen(request, timeout=15) as response:
            body = response.read(2_000_000).decode('utf-8', errors='replace')
        # Retrieval alone is not a semantic freshness decision.
        return {'url': url, 'retrieved_at': now().isoformat(), 'reachable': True,
                'requires_coordinator_read': True, 'body': body}
    except Exception:
        return {'url': url, 'retrieved_at': now().isoformat(), 'reachable': False,
                'requires_coordinator_read': True}

def cursor_bucket_name(candidate):
    """Config "quota_bucket" wins; otherwise Composer and Grok are Cursor's own models."""
    if candidate.get('quota_bucket'):
        return candidate['quota_bucket']
    return 'Cursor Models' if candidate['model'].startswith(('composer', 'grok', 'cursor-grok')) else 'Other Models'

def cursor_buckets(buckets, config):
    """Cursor meters its own models ("Cursor Models") and third-party ("Other Models") separately.

    Orca's monthly "plan" total can read 100% while both buckets still have room
    (seen 2026-10-01: plan 100%, Cursor 6%, Other 24%), so route on the buckets.
    """
    def window(b):
        return [{'window': 'monthly', 'used_percent': b.get('usedPercent'),
                 'resets_at': b.get('resetsAt'), 'window_minutes': b.get('windowMinutes'),
                 'starts_at': b.get('startsAt')}]
    named = {b.get('name'): window(b) for b in buckets if isinstance(b, dict)}
    own, other = named.get('Cursor Models'), named.get('Other Models')
    if not (own and other):
        return {}
    # Use the stricter bucket for models without an explicit bucket.
    strict = max(own, other, key=lambda w: w[0]['used_percent'] or 0)
    models = {c['model']: named.get(cursor_bucket_name(c), strict)
              for c in config['candidates'] if c['agent'] == 'cursor'}
    return {'windows': strict, 'models': models}

def snapshot(fetch_sources=False, save=True):
    accounts = cli(['account', 'list', '--json'])
    status = cli(['status', '--json'])
    result = accounts.get('result', {}) if accounts.get('ok') else {}
    rates = result.get('rateLimits', {})
    providers = {}
    for name in ('codex', 'claude', 'cursor', 'antigravity'):
        rate = rates.get(name) or {}
        windows = []
        for key in ('session', 'weekly', 'monthly', 'fableWeekly'):
            w = rate.get(key)
            if isinstance(w, dict):
                # A present upper window with unknown usage is a safety constraint,
                # not an absent window. The scheduler will reject its invalid value.
                windows.append({'window': key, 'used_percent': w.get('usedPercent'),
                    'resets_at': w.get('resetsAt'), 'window_minutes': w.get('windowMinutes'),
                    'starts_at': w.get('startsAt')})
        providers[name] = {'status': rate.get('status', 'unknown'), 'windows': windows,
                           'updated_at_ms': rate.get('updatedAt'), 'error': rate.get('error')}
        if name == 'codex':
            credits = rate.get('rateLimitResetCredits') or {}
            providers[name]['banked_resets'] = {
                'available_count': credits.get('availableCount'),
                'next_expires_at': credits.get('nextExpiresAt'),
                'credits': [{'status': c.get('status'), 'expires_at': c.get('expiresAt')}
                    for c in credits.get('credits', [])]}
        if name == 'cursor' and rate.get('buckets'):
            providers[name].update(cursor_buckets(rate['buckets'], load_config()))
    # Orca has no Antigravity meter; read per-model quota from the running app.
    if not providers['antigravity']['windows']:
        providers['antigravity'] = antigravity_quota.probe(now().timestamp() * 1000)
    cache_path = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))) / 'models_cache.json'
    models = []
    try:
        cache = read_json(cache_path)
        age = (now().timestamp() - cache_path.stat().st_mtime) / 3600
        if 0 <= age < 24:
            models = [{'model': m['slug'], 'efforts': [e['effort'] for e in m.get('supported_reasoning_levels', [])],
                       'evidence': 'local_catalog_not_launch'} for m in cache.get('models', [])]
    except (OSError, ValueError, KeyError):
        pass
    data = {'checked_at': now().isoformat(), 'max_age_hours': 24, 'quota_max_age_minutes': 15,
            'runtime_ready': status.get('result', {}).get('runtime', {}).get('state') == 'ready',
            'runtime_version': status.get('result', {}).get('runtime', {}).get('appVersion'),
            'providers': providers, 'codex_models': models, 'sources': [],
            'antigravity_meter': 'local language server GetUserStatus; 5h per model, weekly not exposed',
            'jev_key_present': bool(os.environ.get('TYPESAFE_API_KEY')), 'recent_providers': []}
    old = ROOT / '.ai/runtime/latest.json'
    if fetch_sources:
        config = load_config()
        for i, url in enumerate(config['official_sources']):
            src = source_check(url)
            body = src.pop('body', None)
            if body:
                path = ROOT / '.ai/runtime' / f'source-{i}.txt'
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(body, encoding='utf-8')
                src['cached_file'] = str(path.relative_to(ROOT))
            data['sources'].append(src)
    elif old.exists():
        data['sources'] = read_json(old).get('sources', [])
    dispatch_dir = ROOT / '.ai/runtime/dispatches'
    if dispatch_dir.exists():
        for path in sorted(dispatch_dir.glob('*.json'), key=lambda p:p.stat().st_mtime, reverse=True):
            rec = read_json(path)
            receipt = rec.get('receipt', {})
            if receipt.get('result', {}).get('state') == 'ready':
                data['recent_providers'].append(rec.get('route', {}).get('agent'))
            if len(data['recent_providers']) >= 5:
                break
    if save:
        save_json(old, data)
    return data

def age_hours(timestamp):
    try:
        return (now() - dt.datetime.fromisoformat(timestamp)).total_seconds() / 3600
    except (TypeError, ValueError):
        return float('inf')

def model_provider(data, candidate):
    """Provider state for one candidate; Antigravity meters each model separately."""
    provider = data.get('providers', {}).get(candidate['agent'], {})
    windows = provider.get('models', {}).get(candidate['model'])
    return {**provider, 'windows': windows} if windows else provider

def preference_rank(config, task_class, role, candidate):
    """Approved first choice for this class and role sorts first. Unlisted models tie after them."""
    prefs = config.get('routing_preferences') or []
    for index, pref in enumerate(prefs):
        if pref.get('class') != task_class or role not in pref.get('roles', ()):
            continue
        if pref.get('agent') == candidate.get('agent') and pref.get('model') == candidate.get('model'):
            return index
    return len(prefs)


def choose(data, config, task_class='STANDARD', role='coder', exclude_origin=None, max_reason=None,
           task_minutes=30, important=False, pinned=None):
    if task_class not in CLASSES:
        raise ValueError('invalid class')
    if role in ('reviewer', 'judge', 'expert') and CLASSES.index(task_class) < 2:
        task_class = 'STRONG'
    if task_class == 'MAX' and not max_reason:
        return {'blocked': True, 'class': task_class, 'reason': 'MAX requires an explicit coordinator rationale'}
    if not 0 <= age_hours(data.get('checked_at')) < 24:
        return {'blocked': True, 'class': task_class, 'reason': 'environment snapshot expired'}
    candidates, rejected = [], []
    catalog = {m['model']: m for m in data.get('codex_models', [])}
    for index, c in enumerate(config['candidates']):
        if task_class not in c['classes'] or role not in c['roles']:
            continue
        # The user picked this role's AI at kickoff; keep the safety gates below.
        if pinned and any(pinned.get(k) and pinned[k] != c.get(k) for k in ('agent', 'model')):
            continue
        provider = model_provider(data, c)
        reason = None
        if not c.get('enabled'):
            reason = 'candidate has no configured contract'
        elif exclude_origin and c['origin'] == exclude_origin:
            reason = 'same model origin excluded'
        elif provider.get('status') != 'ok':
            reason = 'provider auth or quota unavailable' + (': ' + provider['error'] if provider.get('error') else '')
        elif c['agent'] == 'codex' and c['model'] not in catalog:
            reason = 'model absent from fresh local catalog'
        elif c['agent'] == 'codex' and c.get('effort') not in catalog[c['model']]['efforts']:
            reason = 'unsupported effort'
        windows = provider.get('windows', [])
        used = max((w['used_percent'] for w in windows if
                    isinstance(w.get('used_percent'), (int, float)) and not isinstance(w.get('used_percent'), bool)), default=None)
        timestamp = provider.get('updated_at_ms')
        quota_fresh = isinstance(timestamp, (int, float)) and 0 <= now().timestamp() * 1000 - timestamp < 15 * 60 * 1000
        if not reason and (used is None or not quota_fresh):
            reason = 'quota unknown or older than 15 minutes'
        budget = evaluate_budget(provider, config['budget_targets'], task_minutes,
            data.get('recent_providers', []), c['agent'], important, now().timestamp())
        if not reason and budget['blocked']:
            reason = budget['reason']
        if reason:
            rejected.append({'agent': c['agent'], 'model': c['model'], 'reason': reason,
                             'budget_state':budget if budget.get('blocked') else None})
            continue
        # Approved route first, then fit, then expiring underused budgets, upper-window safety, diversity.
        rank = preference_rank(config, task_class, role, c)
        candidates.append((rank, -c.get('suitability', {}).get(role, 1), -budget['score'], index, c, budget))
    candidates.sort(key=lambda item: item[:4])
    if not candidates and pinned:
        # The assigned AI is temporarily unusable (expired sign-in, closed quota...).
        # Move to the next eligible candidate for the same role and say why.
        result = choose(data, config, task_class, role, exclude_origin, max_reason, task_minutes, important)
        return {**result, 'assigned_unavailable': {'assigned': pinned, 'rejected': rejected}}
    if not candidates:
        return {'blocked': True, 'class': task_class, 'role': role, 'reason': 'no eligible candidate in class', 'rejected': rejected}
    _, _, _, _, c, budget = candidates[0]
    used = max(w['used_percent'] for w in model_provider(data, c)['windows'])
    return {'blocked': False, 'class': task_class, 'role': role,
            **{key: c.get(key) for key in ('agent', 'model', 'effort', 'origin')},
            'selected': {key:c.get(key) for key in ('agent','model','effort')},
            'used_percent': used, 'launch_verified': False, 'budget_reason': budget['reason'],
            'budget_state': budget, 'alternatives': [
                {key:item[4].get(key) for key in ('agent','model','effort')} | {'budget_reason':item[5]['reason']}
                for item in candidates[1:]], 'rejected': rejected}

def jev(mode, state_path, model='jev-latest'):
    key = os.environ.get('TYPESAFE_API_KEY')
    if not key:
        return {'skipped': True, 'reason': 'no_key', 'requires_coordinator_decision': True}
    raw = Path(state_path).read_text(encoding='utf-8-sig')
    if len(raw.encode('utf-8')) > 48000:
        return {'skipped': True, 'reason': 'summarize_state_under_48KB', 'requires_coordinator_decision': True}
    questions = read_json(ROOT / '.ai/JEV_QUESTIONS.json')[mode]
    body = json.dumps({'model': model, 'state': raw, 'questions': questions}).encode('utf-8')
    req = urllib.request.Request('https://api.typesafe.ai/v1/systemone', data=body,
        headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            answer = json.load(response)
        answers = answer.get('answers', {})
        needs = []
        for name, question in questions.items():
            item = answers.get(name, {})
            if item.get('type') != question['type']:
                needs.append(name)
            elif item['type'] == 'noul':
                if not isinstance(item.get('noul'), (int, float)) or .15 < item['noul'] < .85:
                    needs.append(name)
            elif item.get('confidence', 0) < .75:
                needs.append(name)
        return {'skipped': False, 'mode': mode, 'model': answer.get('model'), 'answers': answers,
                'requires_coordinator_decision': bool(needs), 'uncertain_questions': needs}
    except Exception:
        return {'skipped': True, 'reason': 'api_unavailable', 'requires_coordinator_decision': True}

def task_spec(task, rules=()):
    workflow = workflow_contract(task)
    for field in ('target', 'change', 'constraints', 'ownership', 'acceptance', 'role'):
        if not isinstance(task.get(field), str) or not task[field].strip():
            raise ValueError('Task requires nonempty ' + field)
    state = '\n'.join(f'{field.title()}: {task[field]}' for field in ('target', 'change', 'constraints', 'ownership', 'acceptance'))
    project_rules = ' '.join(r.strip() for r in rules if r.strip())
    return ('Read AGENTS.md and .ai/{GOAL,LATEST,PLAN,HANDOFF,REVIEW}.md first.\n' + state +
        '\nWorkflow contract: ' + json.dumps(workflow, ensure_ascii=False) +
        '\nRead prompts/rd-team.md for rd mode, prompts/run-team.md for normal mode. '
        'Unobserved visual quality is UNREVIEWED. This contract is not permission to generate, '
        'spend, overwrite, publish, or extend iteration limits. Follow Task ownership and acceptance. ' +
        '\nUse the authoritative injected Task/Dispatch preamble. ' + (project_rules + ' ' if project_rules else '') +
        'Report tests, modified files, unverified results and next step. '
        'Show every output file as a clickable absolute path. Do not launch additional workers.')

def dispatch(task, route, run_id, execute=False, coordinator_handle=None):
    spec = task_spec(task, load_config().get('task_rules', []))
    place = task.get('worktree', 'here')
    if place not in ('here', 'new'):
        raise ValueError('Task worktree must be "here" or "new"')
    if place == 'new' and task.get('role') in ('reviewer', 'judge'):
        raise ValueError('A read-only role stays in this folder; do not give it a new worktree')
    if route.get('blocked'):
        return {'started': False, 'route': route}
    # A writer that runs beside a reviewer gets its own worktree; readers stay in this folder.
    where = ['--worktree', 'path:' + str(ROOT)]
    uncommitted = []
    if place == 'new':
        slug = re.sub(r'[^a-z0-9]+', '-', run_id.lower()).strip('-')[-24:].strip('-')
        where = ['--worktree', 'new-child', '--name', 'ai-' + slug + '-' + uuid.uuid4().hex[:6]]
        # Start from this checkout's commit, not the remote branch, so the writer sees unpushed work
        # and the result merges back as a fast-forward.
        head = _git(['rev-parse', 'HEAD'])
        if not head:
            raise ValueError('A new worktree needs this checkout\'s commit (git rev-parse HEAD failed)')
        where += ['--base-branch', head]
        # Uncommitted edits stay behind and can block the fast-forward later. .ai/ records always change.
        for line in (_git(['status', '--porcelain']) or '').splitlines():
            path = line.split(None, 1)[-1]
            if not path.startswith('.ai/'):
                uncommitted.append(path)
    argv = ['orchestration', 'worker-start', '--spec', spec, '--task-title', task.get('title', task['role']),
            *where, '--run', run_id, '--agent', route['agent'],
            '--model', route['model']]
    if route.get('effort'):
        argv += ['--effort', route['effort']]
    if coordinator_handle:
        argv += ['--from', coordinator_handle]
    argv += ['--json']
    if not execute:
        return {'started': False, 'dry_run': True, 'route': route, 'argv': argv,
                **({'uncommitted': uncommitted} if uncommitted else {})}
    launch_intent_at = now()
    receipt = cli(argv, timeout=150)
    # Preserve full unknown/failed receipts. Never retry a launch automatically.
    path = ROOT / '.ai/runtime/dispatches' / (uuid.uuid4().hex + '.json')
    save_json(path, {'at': now().isoformat(), 'route': route, 'argv': argv, 'receipt': receipt,
                     'workflow': workflow_contract(task)})
    started = bool(receipt.get('ok') and receipt.get('exit_code') == 0 and
                   receipt.get('result', {}).get('state') == 'ready')
    result = {'started': started, 'receipt_path': str(path), 'receipt': receipt, 'route': route, 'argv': argv,
              **({'uncommitted': uncommitted} if uncommitted else {})}
    info = receipt.get('result') or {}
    kind, guessed = work_type(task)
    fallback = route.get('assigned_unavailable')
    dispatch_id = info.get('dispatchId') or 'launch-' + path.stem
    history_append({'event': 'start', 'dispatch_id': dispatch_id, 'task_id': info.get('taskId'), 'run_id': run_id,
                    'title': task.get('title'), 'work_type': kind, 'work_type_guessed': guessed,
                    'workflow': workflow_contract(task),
                    'role': route.get('role', task.get('role')), 'class': route.get('class', task.get('class')),
                    'assigned': (fallback or {}).get('assigned', task.get('assigned')),
                    'used': {k: route.get(k) for k in ('agent', 'model', 'effort', 'origin')},
                    'fallback_reason': [r.get('reason') for r in fallback['rejected']] if fallback else None,
                    'worktree': next((e.get('id') for e in info.get('effects') or []
                                      if e.get('kind') == 'worktree'), None) if place == 'new' else None,
                    'launch_state': info.get('state') or ('unknown' if receipt.get('outcome_unknown') else 'failed')})
    if started:
        with board_lifecycle_lock():
            entry = board_runs(read_board_state()).get(run_id)
            skip, skip_reason = launch_should_skip_board_move(entry, launch_intent_at)
            if skip:
                result['board'] = {'moved': False, 'skipped': True, 'reason': skip_reason}
            else:
                move = board_set('in-progress', with_questions(run_id))
                result['board'] = move
                # A ready launch owns the Run even if the column move failed, so a later sync can recover.
                write_board_state(run_id, 'launch', 'in-progress', None)
    elif not receipt.get('outcome_unknown'):
        history_append({'event': 'result', 'dispatch_id': dispatch_id, 'outcome': 'launch_failed',
                        'duration_min': None, 'review_findings': None})
    return result

BOARD_STATUSES = ('todo', 'in-progress', 'in-review', 'completed')
BOARD_NOTE = '[AI] '
BOARD_STATE_REL = '.ai/runtime/board-state.json'
BOARD_LOCK_REL = '.ai/runtime/board-lifecycle.lock'
EXPLICIT_BOARD_KINDS = frozenset({'explicit-pending', 'explicit-review', 'explicit-working',
                                   'explicit-failed', 'explicit-done'})
TERMINAL_EXPLICIT_KINDS = frozenset({'explicit-done', 'explicit-failed'})


def orca_board_config(config=None):
    cfg = config if config is not None else load_config()
    section = cfg.get('orca_board') or {}
    return section if isinstance(section, dict) else {}


def pending_status_id(config=None):
    value = orca_board_config(config).get('pending_status')
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip()
    if value in BOARD_STATUSES:
        return None
    return value


def read_board_state():
    path = state_root() / BOARD_STATE_REL
    if not path.exists():
        return None
    try:
        return read_json(path)
    except (OSError, ValueError, json.JSONDecodeError):
        return None


def board_runs(state):
    """{run_id: entry} for every open Run of the project. The old single-Run file reads as one Run."""
    if not isinstance(state, dict):
        return {}
    runs = state.get('runs')
    if isinstance(runs, dict):
        return {k: v for k, v in runs.items() if isinstance(v, dict)}
    return {state['run_id']: state} if state.get('run_id') else {}


def write_board_state(run_id, kind, status, reason=None):
    # Finished (completed) Runs are dropped so they can never move the card again.
    runs = {k: v for k, v in board_runs(read_board_state()).items()
            if k != run_id and v.get('status') != 'completed'}
    runs[run_id or ''] = {'run_id': run_id or '', 'at': now().isoformat(),
                          'kind': kind, 'status': status, 'reason': reason}
    save_json(state_root() / BOARD_STATE_REL, {'runs': runs, 'at': now().isoformat()})


def project_status(runs):
    """One card for the whole project: any working Run keeps it In progress."""
    statuses = [e.get('status') for e in runs.values()]
    if 'in-progress' in statuses:
        return 'in-progress'
    waiting = [s for s in statuses if s != 'completed']
    if not waiting:
        return 'completed'
    return 'in-review' if 'in-review' in waiting else waiting[0]


def project_target(run_id, own_status):
    """(card column, other Run ids still working) if this Run moves to own_status."""
    runs = dict(board_runs(read_board_state()))
    runs[run_id] = {'status': own_status}
    busy = sorted(k for k, e in runs.items() if k != run_id and e.get('status') == 'in-progress')
    return project_status(runs), busy


def busy_note(busy, note=''):
    text = '他のRunが作業中: ' + str(len(busy)) + '件 (' + ', '.join(busy) + ')' if busy else ''
    return ' / '.join(part for part in (text, note) if part)


def with_questions(run_id, note=''):
    """Keep other Runs' open questions visible when this Run rewrites the card note."""
    asks = ['判断待ち (' + k + '): ' + str(e.get('reason') or '')
            for k, e in sorted(board_runs(read_board_state()).items())
            if k != run_id and e.get('kind') == 'explicit-pending']
    return ' / '.join(part for part in (note, *asks) if part)


def _acquire_board_lock(fd, timeout_sec):
    deadline = time.monotonic() + timeout_sec
    while True:
        try:
            if sys.platform == 'win32':
                import msvcrt
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except OSError:
            if time.monotonic() >= deadline:
                raise TimeoutError('board lifecycle lock timeout')
            time.sleep(0.05)


def _release_board_lock(fd):
    try:
        if sys.platform == 'win32':
            import msvcrt
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_UN)
    except OSError:
        pass


class board_lifecycle_lock:
    """Cross-process lock for board read/move/state-write critical sections."""

    def __init__(self, timeout_sec=120):
        self.timeout_sec = timeout_sec
        self._fd = None

    def __enter__(self):
        lock_path = state_root() / BOARD_LOCK_REL
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR)
        try:
            _acquire_board_lock(fd, self.timeout_sec)
        except Exception:
            os.close(fd)
            raise
        self._fd = fd
        return self

    def __exit__(self, exc_type, exc, tb):
        if self._fd is not None:
            _release_board_lock(self._fd)
            os.close(self._fd)
            self._fd = None
        return False


def allowed_board_statuses(config=None):
    allowed = set(BOARD_STATUSES)
    pending_id = pending_status_id(config)
    if pending_id:
        allowed.add(pending_id)
    return allowed


def board_state_at(state):
    if not state or not isinstance(state, dict):
        return None
    try:
        val = dt.datetime.fromisoformat(state['at'])
        if val.tzinfo is None or val.tzinfo.utcoffset(val) is None:
            return None
        return val
    except (KeyError, TypeError, ValueError):
        return None


def launch_should_skip_board_move(state, launch_intent_at):
    """Do not roll back explicit lifecycle choices recorded while worker-start was in flight."""
    if not state or not isinstance(state, dict):
        return False, None
    kind = state.get('kind')
    if kind not in EXPLICIT_BOARD_KINDS:
        return False, None
    state_at = board_state_at(state)
    if not state_at:
        return True, f'{kind} missing or invalid timestamp'
    if (launch_intent_at is None or
            getattr(launch_intent_at, 'tzinfo', None) is None or
            launch_intent_at.tzinfo.utcoffset(launch_intent_at) is None):
        return True, f'{kind} protected; invalid launch intent timestamp'
    if state_at > launch_intent_at:
        if kind in TERMINAL_EXPLICIT_KINDS:
            return True, 'explicit terminal state after launch intent'
        return True, f'{kind} after launch intent'
    return False, None


def sync_should_skip_move(state, run_id, derived_status, sync_started_at=None):
    """state is this Run's own entry. Older sync must not roll back an explicit lifecycle choice."""
    # Only Runs registered in this project (launch / working / explicit) move the card; an unknown old Run must not.
    if not state or not isinstance(state, dict) or not state.get('run_id'):
        return True, 'no current run recorded for this workspace'
    kind = state.get('kind')
    if kind in TERMINAL_EXPLICIT_KINDS:
        return True, 'explicit terminal state blocks worker sync'
    if kind == 'explicit-pending':
        return True, 'explicit pending blocks worker sync'
    if kind == 'explicit-review':
        return True, 'explicit review blocks worker sync'
    # Working only guards against other Runs; the same Run's settled workers may move it to review.
    if kind == 'explicit-working' and state.get('run_id') != run_id:
        return True, 'explicit working blocks worker sync from run ' + str(run_id)
    state_at = board_state_at(state)
    if (sync_started_at and state_at and
            getattr(sync_started_at, 'tzinfo', None) is not None and
            sync_started_at.tzinfo.utcoffset(sync_started_at) is not None and
            state_at > sync_started_at):
        return True, 'board state newer than sync'
    if state.get('run_id') and state['run_id'] != run_id:
        return True, 'board state belongs to run ' + state['run_id']
    return False, None


def require_board_run(run_id, action):
    if not run_id or not str(run_id).strip():
        raise ValueError('board ' + action + ' requires --run')

HISTORY_REL = '.ai/history/model-usage.jsonl'
WORK_TYPE_BY_ROLE = {'coder': 'code', 'tester': 'test', 'reviewer': 'review', 'judge': 'review',
                     'expert': 'review', 'research': 'research', 'planner': 'plan',
                     'coordinator': 'coordination', 'blender': 'blender-3d', 'comfy': 'image-gen',
                     'export': 'export', 'previz-qa': 'visual-qa', 'visual-qa': 'visual-qa'}
RATINGS = ('good', 'ok', 'bad')

def history_append(event):
    path = state_root() / HISTORY_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    event = {'at': now().isoformat(), 'project': ROOT.name, **event}
    with path.open('a', encoding='utf-8', newline='\n') as stream:
        stream.write(json.dumps(event, ensure_ascii=False) + '\n')

def history_events():
    path = state_root() / HISTORY_REL
    if not path.exists():
        return []
    events = []
    for line in path.read_text(encoding='utf-8').splitlines():
        try:
            events.append(json.loads(line))
        except ValueError:
            continue  # a broken line must not stop routing
    return events

def work_type(task):
    if task.get('work_type'):
        return task['work_type'], False
    return WORK_TYPE_BY_ROLE.get(task.get('role'), 'other'), True

def record_results(workers):
    events = history_events()
    done = {e.get('dispatch_id') for e in events if e.get('event') == 'result'}
    started = {e.get('dispatch_id'): e.get('at') for e in events if e.get('event') == 'start'}
    written = 0
    for w in workers:
        outcome = w.get('projection', {}).get('outcome')
        dispatch_id = w.get('dispatchId')
        if outcome not in ('succeeded', 'failed') or not dispatch_id or dispatch_id in done:
            continue
        duration = None
        try:
            duration = round((now() - dt.datetime.fromisoformat(started[dispatch_id])).total_seconds() / 60, 1)
        except (KeyError, TypeError, ValueError):
            pass
        history_append({'event': 'result', 'dispatch_id': dispatch_id, 'task_id': w.get('taskId'),
                        'outcome': outcome, 'duration_min': duration, 'review_findings': None})
        done.add(dispatch_id)
        written += 1
    return written

def validate_dispatch_ratings(run_id, rates, rating_source='user', rating=None):
    if not run_id:
        raise ValueError('ratings require --run')
    if rating_source not in ('ai-suggested', 'user'):
        raise ValueError('invalid rating source')
    ids = list(dict.fromkeys(e['dispatch_id'] for e in history_events()
        if e.get('event') == 'start' and e.get('run_id') == run_id and e.get('dispatch_id')))
    if rating is not None and rating not in RATINGS:
        raise ValueError('rating must be one of ' + ', '.join(RATINGS))
    selected = {d: rating for d in ids} if rating is not None else {}
    seen = set()
    for spec in rates:
        dispatch_id, sep, value = spec.partition('=')
        if not sep or dispatch_id not in ids or value not in RATINGS or dispatch_id in seen:
            raise ValueError('invalid or duplicate dispatch rating: ' + spec)
        seen.add(dispatch_id)
        selected[dispatch_id] = value
    return selected


def record_dispatch_ratings(run_id, rates, note='', rating_source='user', rating=None):
    selected = validate_dispatch_ratings(run_id, rates, rating_source, rating)
    for dispatch_id, value in selected.items():
        history_append({'event': 'rating', 'dispatch_id': dispatch_id, 'run_id': run_id,
                        'rating': value, 'note': note, 'rating_source': rating_source})
    return len(selected)


def record_rating(run_id, rating, note='', rating_source='user'):
    return record_dispatch_ratings(run_id, [], note, rating_source, rating)


def fixed_findings(path):
    """Count explicit repair evidence, never infer a fix from a proposed remedy.

    JSON: {"findings": [{"id": "1", "status": "fixed"}]} or fixed: true.
    Markdown: one numbered ### finding per section and a status: FIXED /
    状態: FIXED line. A checked checklist item is also explicit evidence.
    Unknown repair evidence stays null.
    """
    text = Path(path).read_text(encoding='utf-8-sig')
    try:
        data = json.loads(text)
    except ValueError:
        sections = re.split(r'(?m)^###\s+', text)[1:]
        states = [re.search(r'(?im)^\s*(?:status|状態)\s*[:：]\s*(FIXED|VERIFIED|OPEN|UNFIXED|UNREVIEWED|FIXED_PENDING_QC)\s*$', s) for s in sections]
        if any(states):
            return sum(bool(m and m.group(1).upper() in ('FIXED', 'VERIFIED')) for m in states)
        items = re.findall(r'(?m)^\s*- \[([xX ])\] ', text)
        return sum(mark.lower() == 'x' for mark in items) if items else None
    findings = data.get('findings') if isinstance(data, dict) else data
    if not isinstance(findings, list):
        return None
    return sum(isinstance(f, dict) and (str(f['status']).lower() in ('fixed', 'verified')
               if 'status' in f else f.get('fixed') is True) for f in findings)


def suggest_rating(run_id, report=None):
    events = history_events()
    starts = {e.get('dispatch_id'): e for e in events if e.get('event') == 'start' and e.get('dispatch_id')}
    results = {e.get('dispatch_id'): e for e in events if e.get('event') == 'result' and e.get('dispatch_id')}
    selected = [(d, s) for d, s in starts.items() if s.get('run_id') == run_id]
    if not selected:
        raise ValueError('run has no start events: ' + run_id)
    rows, reasons, ratings = [], [], []
    review = any(s.get('work_type') == 'review' or s.get('role') in ('reviewer', 'judge', 'expert') for _, s in selected)
    fixed = fixed_findings(report) if report and review else None
    for dispatch_id, start in selected:
        reasons = []
        result = results.get(dispatch_id, {})
        outcome, duration = result.get('outcome'), result.get('duration_min')
        used = start.get('used') or {}
        key = (start.get('work_type'), used.get('agent'), used.get('model'))
        peer = [r.get('duration_min') for d, r in results.items() if d in starts and starts[d].get('run_id') != run_id
                and (starts[d].get('work_type'), (starts[d].get('used') or {}).get('agent'),
                     (starts[d].get('used') or {}).get('model')) == key
                and isinstance(r.get('duration_min'), (int, float)) and not isinstance(r.get('duration_min'), bool)
                and r['duration_min'] >= 0]
        median = float(statistics.median(peer)) if peer else None
        rating = 'bad' if outcome in ('failed', 'launch_failed') else 'ok'
        reasons.append(f'{dispatch_id}: outcome={outcome or "未確定"}')
        if isinstance(duration, (int, float)) and not isinstance(duration, bool) and median is not None:
            reasons.append(f'{dispatch_id}: {duration:g}分 / 同じ仕事・モデルの中央値 {median:g}分 ({len(peer)}件)')
            if outcome == 'succeeded' and duration <= median:
                rating = 'good'
        else:
            reasons.append(f'{dispatch_id}: 時間比較の証拠不足')
        is_review = start.get('work_type') == 'review' or start.get('role') in ('reviewer', 'judge', 'expert')
        if is_review:
            reasons.append('後で修正された指摘: ' + (str(fixed) + '件 (reportの明示記録)' if fixed is not None else '未確認'))
            if fixed and outcome == 'succeeded':
                rating = 'good'
        rows.append({'dispatch_id': dispatch_id, 'work_type': key[0], 'model': used,
                     'outcome': outcome, 'duration_min': duration, 'median_min': median,
                     'baseline_count': len(peer), 'suggested_rating': rating, 'reasons': reasons})
        ratings.append(rating)
    reasons = [reason for row in rows for reason in row['reasons']]
    suggested = 'bad' if 'bad' in ratings else 'ok' if 'ok' in ratings else 'good'
    return {'run_id': run_id, 'suggested_rating': suggested, 'reasons': reasons,
            'dispatches': rows, 'review_findings_fixed': fixed, 'report': str(report) if report else None,
            'rating_written': False, 'requires_user_acceptance': True}


def board_card():
    """The project's card (the main checkout) on Orca's Workspace Board, or None."""
    listing = cli(['worktree', 'list', '--json'])
    main = state_root()
    top, rel = _root_in_checkout()
    # The card is the main checkout; in a subfolder layout Orca lists the checkout top instead.
    wanted = [norm_path(main)]
    if rel is not None and rel != Path('.'):
        wanted.append(norm_path(Path(*main.parts[:len(main.parts) - len(rel.parts)])))
    worktrees = listing.get('result', {}).get('worktrees', [])
    for here in wanted:
        for w in worktrees:
            if w.get('path') and norm_path(w['path']) == here:
                return w
    return None

def board_set(status, note=None, config=None):
    """Move this workspace's card. Best effort: a board failure never blocks team work."""
    if status not in allowed_board_statuses(config):
        raise ValueError('invalid board status')
    card = board_card()
    if not card:
        return {'moved': False, 'reason': 'workspace card not found'}
    argv = ['worktree', 'set', '--worktree', 'id:' + card['id'], '--workspace-status', status, '--json']
    # Only our own notes are replaced; a note the user wrote is kept.
    current = card.get('comment') or ''
    if note is not None and (not current or current.startswith(BOARD_NOTE)):
        argv[-1:-1] = ['--comment', BOARD_NOTE + note if note else '']
    receipt = cli(argv)
    return {'moved': bool(receipt.get('ok')), 'from': card.get('workspaceStatus'), 'to': status,
            'note': note, 'error': receipt.get('error'),
            'outcome_unknown': bool(receipt.get('outcome_unknown'))}

class WorkerRows(list):
    reason = None


def run_workers(run_id):
    """Every Dispatch of the Run that belongs to this project, in any of its worktrees."""
    rows, cursor = WorkerRows(), None
    seen = set()
    here = project_paths()
    while True:
        argv = ['orchestration', 'worker-list', '--run', run_id, '--json'] + (['--cursor', cursor] if cursor else [])
        result = cli(argv).get('result', {})
        for w in result.get('workers', []):
            space = (w.get('projection', {}).get('workspace', {}).get('id') or '').split('::', 1)[-1]
            if space and norm_path(space) in here:
                rows.append(w)
        page = result.get('page') or {}
        if not page.get('hasMore'):
            return rows
        next_cursor = page.get('nextCursor')
        if not next_cursor or next_cursor == cursor or next_cursor in seen:
            rows.reason = 'worker-list pagination stopped: missing or repeated nextCursor'
            return rows
        seen.add(next_cursor)
        cursor = next_cursor

def board_status(workers):
    """Board column from settled facts only: unsettled or unclear work stays In progress."""
    if not workers:
        return 'in-progress', None
    settled = [w for w in workers if w.get('projection', {}).get('outcome') in ('succeeded', 'failed')]
    attention = [w for w in workers if w.get('projection', {}).get('attention', {}).get('requiresAction')]
    failed = [w for w in settled if w['projection']['outcome'] == 'failed']
    if len(settled) < len(workers) or attention:
        return 'in-progress', ('確認待ち: ' + str(len(attention)) + '件') if attention else None
    if failed:
        return 'in-progress', '確認待ち: 失敗 ' + str(len(failed)) + '件'
    return 'in-review', 'AI作業完了: ' + str(len(settled)) + '件成功。人の確認待ち'

def board_pending(reason, run_id):
    require_board_run(run_id, 'pending')
    if not reason or not str(reason).strip():
        raise ValueError('pending requires --reason')
    reason = str(reason).strip()
    config = load_config()
    pending_id = pending_status_id(config)
    with board_lifecycle_lock():
        target, busy = project_target(run_id, pending_id or 'in-review')
        if target == 'in-progress':
            # Another Run is still working: the card stays In progress and the note shows the question.
            result = board_set('in-progress', busy_note(busy, '判断待ち: ' + reason), config)
            if result.get('moved'):
                write_board_state(run_id, 'explicit-pending', pending_id or 'in-review', reason)
            return {**result, 'used_pending_column': False, 'state_written': bool(result.get('moved'))}
        if pending_id:
            attempt = board_set(pending_id, '判断待ち: ' + reason, config)
            if attempt.get('outcome_unknown'):
                return {**attempt, 'used_pending_column': False, 'state_written': False}
            if attempt.get('moved'):
                write_board_state(run_id, 'explicit-pending', pending_id, reason)
                return {**attempt, 'used_pending_column': True, 'state_written': True}
        # Waiting on the user's decision belongs in In review, not In progress.
        result = board_set('in-review', '判断待ち: ' + reason, config)
        if result.get('outcome_unknown'):
            return {**result, 'used_pending_column': False, 'state_written': False}
        if not result.get('moved'):
            return {**result, 'used_pending_column': False, 'state_written': False}
        write_board_state(run_id, 'explicit-pending', 'in-review', reason)
    return {**result, 'used_pending_column': False, 'fallback': True, 'state_written': True}


def board_review(note=None, run_id=None):
    require_board_run(run_id, 'review')
    note = (note or '').strip() or 'AI作業完了。人の確認待ち'
    with board_lifecycle_lock():
        target, busy = project_target(run_id, 'in-review')
        result = board_set(target, note if target == 'in-review' else busy_note(busy, note))
        if result.get('moved'):
            write_board_state(run_id, 'explicit-review', 'in-review', note)
    return result


def config_origins():
    """Origins named in config/ai-team.json; None when no config is readable."""
    try:
        return {c['origin'].strip().lower() for c in load_config().get('candidates', [])
                if isinstance(c, dict) and isinstance(c.get('origin'), str)} or None
    except (OSError, ValueError, KeyError):
        return None


def run_finish_check(task_file, root=None):
    return finish_check(read_json(task_file), root or ROOT, config_origins(), task_file)


GATE_HELP = ('PowerShell: scripts/board.ps1 <review|sync> -RunId <run> -TaskFile <Task JSON> '
             '(変更なしの相談・調査だけなら -NoChange "理由")。'
             'Python: --task-file <Task JSON> / --no-change "理由"')


def review_gate(task_file, no_change):
    """Moving the card to In review needs a passing finish-check, or a stated no-change reason."""
    if task_file:
        check = run_finish_check(task_file)
        return {'blocked': not check['ok'], 'finish_check': check,
                'reason': '' if check['ok'] else 'finish-check を通らないので In review にしない'}
    if isinstance(no_change, str) and no_change.strip():
        return {'blocked': False, 'no_change': no_change.strip()}
    return {'blocked': True, 'reason': 'In review にするには完了チェックが必要。' + GATE_HELP}


def board_working(run_id):
    require_board_run(run_id, 'working')
    with board_lifecycle_lock():
        result = board_set('in-progress', with_questions(run_id))
        # Record the current Run even if the move failed, so a later sync can recover.
        write_board_state(run_id, 'explicit-working', 'in-progress', None)
    return result


def board_failed(reason, run_id):
    require_board_run(run_id, 'failed')
    if not reason or not str(reason).strip():
        raise ValueError('failed requires --reason')
    reason = str(reason).strip()
    with board_lifecycle_lock():
        result = board_set('in-progress', with_questions(run_id, '中断: ' + reason))
        if result.get('moved'):
            write_board_state(run_id, 'explicit-failed', 'in-progress', reason)
    return result


def board_sync(run_id, review_ok=True):
    require_board_run(run_id, 'sync')
    sync_started_at = now()
    workers = run_workers(run_id)
    recorded = record_results(workers)
    status, note = board_status(workers)
    if status == 'in-review' and not review_ok:
        # Workers finished, but the change has not passed finish-check yet.
        status, note = 'in-progress', note.replace('人の確認待ち', '完了チェック待ち')
    pagination_reason = getattr(workers, 'reason', None)
    if pagination_reason:
        status, note = 'in-progress', pagination_reason
    with board_lifecycle_lock():
        entry = board_runs(read_board_state()).get(run_id)
        skip, skip_reason = sync_should_skip_move(entry, run_id, status, sync_started_at)
        if skip:
            return {'moved': False, 'skipped': True, 'skip_reason': skip_reason,
                    'history_results_written': recorded, 'reason': pagination_reason}
        target, busy = project_target(run_id, status)
        card_note = (note if note is not None else '') if target == status else busy_note(busy, note or '')
        card_note = with_questions(run_id, card_note)
        move = board_set(target, card_note)
        if not move.get('moved'):
            return {**move, 'history_results_written': recorded, 'reason': pagination_reason}
        entry = board_runs(read_board_state()).get(run_id)
        skip, skip_reason = sync_should_skip_move(entry, run_id, status, sync_started_at)
        if skip:
            revert = board_set(move.get('from') or 'in-progress', '')
            return {'moved': False, 'skipped': True, 'skip_reason': skip_reason,
                    'reverted': bool(revert.get('moved')), 'history_results_written': recorded,
                    'reason': pagination_reason}
        write_board_state(run_id, 'sync', status, note)
    return {**move, 'history_results_written': recorded, 'reason': pagination_reason}

def resolve_check_path(raw):
    """A literal path, or {pipeline:key} / {pipeline:section.key} from scripts.pipeline_config. None if unknown."""
    if raw.startswith('{pipeline:') and raw.endswith('}'):
        key = raw[len('{pipeline:'):-1]
        section, _, name = key.rpartition('.')
        try:
            from scripts.pipeline_config import load_config as load_pipeline
            return Path(load_pipeline()[section or 'paths'][name])
        except Exception:
            return None
    return Path(raw)

def doctor(config):
    import socket
    status = cli(['status', '--json'])
    runtime = status.get('result', {}).get('runtime', {})
    checks = {}
    check_specs = {}
    for check in config.get('doctor_checks', []):
        check_specs[check['name']] = check
        if 'port' in check:
            with socket.socket() as s:
                s.settimeout(2)
                checks[check['name']] = s.connect_ex(('127.0.0.1', int(check['port']))) == 0
        else:
            path = resolve_check_path(check['path'])
            checks[check['name']] = None if path is None else path.exists()
    return {'python': sys.executable, 'orca': {'ready': runtime.get('state') == 'ready',
            'version': runtime.get('appVersion'), 'error': status.get('error')},
            'checks': checks, 'check_specs': check_specs, 'generation_started': False}

def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='command', required=True)
    s = sub.add_parser('snapshot'); s.add_argument('--fetch-sources', action='store_true')
    b = sub.add_parser('budget'); b.add_argument('--class', dest='task_class', choices=CLASSES, default='STANDARD')
    b.add_argument('--role', default='coder'); b.add_argument('--exclude-origin'); b.add_argument('--max-reason')
    b.add_argument('--snapshot-file')
    b.add_argument('--no-save', action='store_true')
    b.add_argument('--task-minutes', type=float, default=30); b.add_argument('--important', action='store_true')
    j = sub.add_parser('jev'); j.add_argument('--mode', required=True); j.add_argument('--state-file', required=True)
    j.add_argument('--model')
    sub.add_parser('doctor')
    d = sub.add_parser('start'); d.add_argument('--task-file', required=True); d.add_argument('--run', required=True)
    d.add_argument('--from', dest='coordinator_handle')
    d.add_argument('--execute', action='store_true')
    f = sub.add_parser('workflow', help='Validate a Task locally; does not start work or judge quality')
    f.add_argument('--task-file', required=True)
    fc = sub.add_parser('finish-check', help='Before reporting done: check review / R&D quality evidence is recorded')
    fc.add_argument('--task-file', required=True)
    fc.add_argument('--root', help='Base folder for relative report paths (default: project root)')
    w = sub.add_parser('board', help='Move this workspace card on the Orca Workspace Board')
    w.add_argument('action', choices=['sync', 'done', 'pending', 'review', 'working', 'failed'])
    w.add_argument('--run', help='Run id for sync or lifecycle bookkeeping')
    w.add_argument('--reason', help='Required for pending and failed')
    w.add_argument('--rating', choices=RATINGS)
    w.add_argument('--rate', action='append', default=[], help='dispatch_id=good|ok|bad; repeat for each AI')
    w.add_argument('--rating-source', choices=['ai-suggested', 'user'], default='user')
    w.add_argument('--note', default='')
    w.add_argument('--task-file', help='review/sync: Task JSON that must pass finish-check')
    w.add_argument('--no-change', help='review/sync: why there is no change to check (question / investigation only)')
    h = sub.add_parser('history')
    h.add_argument('action', choices=['suggest'])
    h.add_argument('--run', required=True)
    h.add_argument('--report')
    a = p.parse_args()
    config = {} if a.command in ('workflow', 'finish-check') else load_config()
    if a.command == 'workflow':
        task = read_json(a.task_file)
        task_spec(task)
        result = {'valid': True, 'workflow': workflow_contract(task),
                  'quality_status': 'UNREVIEWED', 'started': False}
    elif a.command == 'finish-check':
        result = run_finish_check(a.task_file, Path(a.root) if a.root else None)
        if not result['ok']:
            result['blocked'] = True
    elif a.command == 'snapshot': result = snapshot(a.fetch_sources)
    elif a.command == 'budget':
        data = read_json(a.snapshot_file) if a.snapshot_file else snapshot(save=False) if a.no_save else snapshot()
        result = choose(data, config, a.task_class, a.role, a.exclude_origin, a.max_reason,
                        a.task_minutes, a.important)
    elif a.command == 'jev': result = jev(a.mode, a.state_file, a.model or config.get('jev_model', 'jev-latest'))
    elif a.command == 'doctor': result = doctor(config)
    elif a.command == 'history': result = suggest_rating(a.run, a.report)
    elif a.command == 'board':
        if a.action == 'sync':
            # Workers finishing is not the change being done: In review needs the same gate as review.
            gate = review_gate(a.task_file, a.no_change)
            result = board_sync(a.run, review_ok=not gate.get('blocked'))
            if gate.get('blocked'):
                result['review_gate'] = gate
        elif a.action == 'pending':
            result = board_pending(a.reason, a.run)
        elif a.action == 'review':
            # A finished change reaches review only with its evidence recorded.
            gate = review_gate(a.task_file, a.no_change)
            note = ('変更なし: ' + gate['no_change'] + ('。' + a.note if a.note else '')
                    if gate.get('no_change') else a.note)
            result = gate if gate.get('blocked') else board_review(note, a.run)
        elif a.action == 'working':
            result = board_working(a.run)
        elif a.action == 'failed':
            result = board_failed(a.reason, a.run)
        else:
            # Done is a human decision: run it after the user's OK or a push. Rating is optional.
            require_board_run(a.run, 'done')
            try:
                if a.rate or a.rating:
                    validate_dispatch_ratings(a.run, a.rate, a.rating_source, a.rating)
            except ValueError as exc:
                print(json.dumps({'blocked': True, 'reason': str(exc)}, ensure_ascii=False))
                return 2
            with board_lifecycle_lock():
                # Done closes this Run. The card reaches Done only when no other Run is still open.
                target, busy = project_target(a.run, 'completed')
                move = board_set(target, '' if target == 'completed' else
                                 busy_note(busy) or '確認待ちのRunあり')
                if not move.get('moved') or move.get('outcome_unknown'):
                    result = {**move, 'ratings_written': 0, 'done_recorded': False}
                else:
                    rated = (record_dispatch_ratings(a.run, a.rate, a.note, a.rating_source, a.rating)
                             if (a.rate or a.rating) else 0)
                    write_board_state(a.run, 'explicit-done', 'completed', a.note)
                    result = {**move, 'ratings_written': rated, 'done_recorded': True}
    else:
        task = read_json(a.task_file)
        task_spec(task)
        data = snapshot()
        route = choose(data, config, task.get('class', 'STANDARD'), task['role'], task.get('exclude_origin'),
                       task.get('max_reason'), task.get('estimated_minutes', 30), task.get('important', False),
                       task.get('assigned'))
        # Model selection always has an external dependency. A refreshed local
        # snapshot does not refresh the coordinator's official-source decision.
        decisions = read_json(ROOT / '.ai/EXTERNAL_DECISIONS.json')
        routing = decisions.get(task.get('routing_decision_id', 'routing-baseline'), {})
        if not 0 <= age_hours(routing.get('checked_at')) < 24 or not routing.get('sources') or not routing.get('impact'):
            route = {'blocked': True, 'reason': 'Freshness Gate requires a source-backed routing decision record'}
        # Task-specific external dependencies also require their own decision.
        if task.get('external_dependency', False):
            decision = decisions.get(task.get('decision_id'), {})
            if not 0 <= age_hours(decision.get('checked_at')) < 24 or not decision.get('sources') or not decision.get('impact'):
                route = {'blocked': True, 'reason': 'Freshness Gate requires a source-backed decision record'}
        result = dispatch(task, route, a.run, a.execute, a.coordinator_handle)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result.get('blocked'):
        return 2
    if a.command == 'start' and not result.get('started') and not result.get('dry_run'):
        return 2
    if a.command == 'board' and a.action == 'done' and not result.get('done_recorded'):
        return 2
    # review / pending / failed record nothing when the card did not move; the caller must retry.
    if a.command == 'board' and a.action in ('review', 'pending', 'failed') and not result.get('moved'):
        return 2
    return 0

if __name__ == '__main__':
    # Same output encoding as the PowerShell wrapper (python -X utf8) when run directly.
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TimeoutError) as exc:
        print(json.dumps({'blocked': True, 'reason': str(exc)}, ensure_ascii=False))
        raise SystemExit(2)
