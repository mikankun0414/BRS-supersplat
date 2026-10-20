"""Pure Task contract validation; no routing, model calls, or quality verdicts."""
from __future__ import annotations
import math
from pathlib import Path

QUALITY_STATUSES = ('VERIFIED', 'UNREVIEWED', 'OPEN', 'FIXED_PENDING_QC')


def _placeholder(text):
    return text.lstrip().lower().startswith('replace with')


def _filled(text):
    return isinstance(text, str) and bool(text.strip()) and not _placeholder(text)


def _origin(value):
    return value['origin'].strip().lower()


def member(value, label, origins=None):
    """An AI the user confirmed: agent, model and origin (provider family from config)."""
    if not isinstance(value, dict):
        raise ValueError(label + ' must be an object with agent, model, origin')
    for key in ('agent', 'model', 'origin'):
        if not _filled(value.get(key)):
            raise ValueError(f'{label}.{key} must name the AI confirmed with the user')
    if origins and _origin(value) not in origins:
        raise ValueError(f'{label}.origin は config/ai-team.json の origin ({" / ".join(sorted(origins))}) '
                         'から書く。Antigravity の Gemini は google。エージェント名は書かない')
    return value


def _same(a, b):
    return all(a[k].strip().lower() == b[k].strip().lower() for k in ('agent', 'model', 'origin'))


def workflow_contract(task, finishing=False, origins=None):
    if not isinstance(task, dict):
        raise ValueError('Task must be an object')
    if task.get('template', False) is not False:
        raise ValueError('Example Task: replace placeholders and remove template before execution')
    value = task.get('workflow', {'mode': 'normal'})
    if not isinstance(value, dict):
        raise ValueError('Task workflow must be an object')
    mode = value.get('mode')
    if mode not in ('normal', 'rd'):
        raise ValueError('Task workflow.mode must be normal or rd; consultation does not dispatch')
    fields = {'mode', 'criteria', 'baseline', 'controls', 'max_iterations', 'max_minutes',
              'iterations_used', 'minutes_used', 'stop_conditions', 'approval', 'team'}
    if set(value) - fields:
        raise ValueError('Unknown workflow fields: ' + ', '.join(sorted(set(value) - fields)))
    if mode == 'normal' and set(value) != {'mode'}:
        raise ValueError('normal accepts only mode; archive R&D state before switching')
    if mode == 'rd':
        # R&D starts only on the user's words; the AI never switches itself.
        if not _filled(value.get('approval')):
            raise ValueError('R&D requires approval: ユーザーがR&Dを始めると言った日時と言葉を '
                             'workflow.approval に書く (AIが自分でrdにしない)')
        team = value.get('team')
        if not isinstance(team, dict) or set(team) - {'lead', 'quality', 'same_origin_approved'}:
            raise ValueError('R&D requires team: ユーザーに確認した主担当と品質担当を '
                             'workflow.team {lead, quality} に agent / model / origin で書く')
        lead = member(team.get('lead'), 'R&D team.lead', origins)
        quality = member(team.get('quality'), 'R&D team.quality', origins)
        # Same origin needs the user's own words, never a flag the AI can set.
        if _origin(lead) == _origin(quality) and not _filled(team.get('same_origin_approved')):
            raise ValueError('R&D team.quality は主担当と別出自にする。同じ出自で進めるなら、'
                             'ユーザーが了承した言葉を same_origin_approved に書く')
        for name in ('criteria', 'controls', 'stop_conditions'):
            items = value.get(name)
            if not isinstance(items, list) or not items or any(
                    not isinstance(item, str) or not item.strip() for item in items):
                raise ValueError('R&D workflow requires nonempty string list: ' + name)
            if any(_placeholder(item) for item in items):
                raise ValueError('Replace R&D example placeholders: ' + name)
        baseline = value.get('baseline')
        if not isinstance(baseline, str) or not baseline.strip():
            raise ValueError('R&D workflow requires a baseline or an explicit first-baseline plan')
        if _placeholder(baseline):
            raise ValueError('Replace R&D example baseline')
        count = value.get('max_iterations')
        if type(count) is not int or count < 1:
            raise ValueError('R&D max_iterations must be a positive integer')
        minutes = value.get('max_minutes')
        if type(minutes) not in (int, float) or (type(minutes) is float and not math.isfinite(minutes)) or minutes <= 0:
            raise ValueError('R&D max_minutes must be a finite positive number')
        # Starting needs room for one more trial; finishing may have used the whole budget.
        used = value.get('iterations_used')
        if type(used) is not int or not (0 <= used <= count if finishing else 0 <= used < count):
            raise ValueError('R&D iterations_used must be nonnegative and below max_iterations')
        elapsed = value.get('minutes_used')
        if (type(elapsed) not in (int, float)
                or (type(elapsed) is float and not math.isfinite(elapsed))
                or not (0 <= elapsed <= minutes if finishing else 0 <= elapsed < minutes)):
            raise ValueError('R&D minutes_used must be nonnegative and below max_minutes')
    return dict(value)


def _report_file(root, raw, task_file=None):
    """A nonempty report under <root>/.ai/reports/ (never the Task JSON itself)."""
    if not _filled(raw):
        return None
    reports = (Path(root) / '.ai' / 'reports').resolve()
    path = Path(raw)
    path = (path if path.is_absolute() else Path(root) / path).resolve()
    if reports not in path.parents or (task_file and path == Path(task_file).resolve()):
        return None
    return path if path.is_file() and path.stat().st_size > 0 else None


def finish_check(task, root, origins=None, task_file=None):
    """Evidence needed before the lead reports a change as done or moves the card to review.

    ok means the record is filled in. It does not judge the review or the quality.
    """
    missing = []
    workflow = None
    origins = {o.strip().lower() for o in origins} if origins else None
    try:
        workflow = workflow_contract(task, finishing=True, origins=origins)
    except ValueError as exc:
        missing.append('workflow: ' + str(exc))
    task = task if isinstance(task, dict) else {}
    rd = bool(workflow) and workflow.get('mode') == 'rd'
    team = workflow.get('team', {}) if rd else {}
    lead = None
    try:
        lead = member(task.get('lead', team.get('lead')), 'lead', origins)
        if rd and not _same(lead, team['lead']):
            missing.append('lead が workflow.team.lead と違う。作業したAIを確認して合わせる')
    except ValueError as exc:
        missing.append(str(exc) + ' (作業したAI)')
    important = task.get('important')
    if type(important) is not bool:
        missing.append('important を true / false で書く。kit・共通スクリプト・並列化・設計変更は true (レビュー2件)')
    review = task.get('review') if isinstance(task.get('review'), dict) else {}
    # Only an explicitly unimportant change may skip review: typo/format, or an R&D trial without code change.
    skip = important is False and _filled(review.get('skip_reason'))
    required = 0 if skip else 2 if important is True else 1
    origins_seen, paths, notes = [], set(), []
    reports = review.get('reports', [])
    for index, report in enumerate(reports if isinstance(reports, list) else []):
        label = f'review.reports[{index}]'
        try:
            member(report, label, origins)
        except ValueError as exc:
            notes.append(str(exc))
            continue
        path = _report_file(root, report.get('path'), task_file)
        if not path:
            notes.append(f'{label}: .ai/reports/ の下に空でないreportがない ({report.get("path")})')
            continue
        origin = _origin(report)
        if path in paths:
            notes.append(f'{label}: 同じreportファイルは1件として数える')
        elif lead and origin == _origin(lead):
            notes.append(f'{label}: 作業したAIと同じ出自 ({origin}) は独立レビューに数えない')
        elif origin in origins_seen:
            notes.append(f'{label}: 同じ出自 ({origin}) は1件として数える')
        else:
            origins_seen.append(origin)
        paths.add(path)
    if len(origins_seen) < required:
        kind = '重要変更なので別出自2モデル' if important is True else '別出自1モデル'
        missing.append(f'独立レビューが足りない: {kind}のreportが必要 (今 {len(origins_seen)} 件)')
        missing.extend(notes)
    quality_status = None
    if rd:
        quality = task.get('quality') if isinstance(task.get('quality'), dict) else {}
        quality_status = quality.get('status')
        if quality_status not in QUALITY_STATUSES:
            missing.append('quality.status は ' + ' / '.join(QUALITY_STATUSES) + ' のどれか')
        try:
            member(quality, 'quality', origins)
            if not _same(quality, team['quality']):
                missing.append('quality の agent / model / origin が workflow.team.quality と違う')
        except ValueError as exc:
            missing.append(str(exc) + ' (品質を見たAI)')
        if not _report_file(root, quality.get('report'), task_file):
            missing.append('quality.report: 品質担当が実物・計測を見たreportが .ai/reports/ にない')
    if missing:
        note = '未完了: missing を直す'
    elif rd and quality_status != 'VERIFIED':
        note = f'記録はそろった。品質は {quality_status} なので成功とは言わない'
    else:
        note = '記録はそろった'
    return {'ok': not missing, 'missing': missing, 'review_required': required,
            'quality_status': quality_status,
            'note': note + '。これは記録の確認だけで、レビュー内容や品質の合否は判定しない。'}
