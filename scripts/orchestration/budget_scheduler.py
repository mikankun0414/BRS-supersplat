"""v2 quota scheduler: normalized windows, burn pace, expiry and reset advice.

No reset action or purchase is performed here. All scores are policy heuristics,
not estimates of a model task's token consumption.
"""
import math

def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

def epoch(value):
    if not number(value) or value <= 0:
        return None
    return value / 1000 if value > 100_000_000_000 else value

def evaluate_budget(provider, targets, task_minutes, recent, agent, important, timestamp):
    credits = provider.get('banked_resets', {})
    available = []
    for credit in credits.get('credits', []):
        expiry = epoch(credit.get('expires_at'))
        if credit.get('status') == 'available' and expiry and expiry > timestamp:
            available.append(expiry)
    count = len(available)
    if not credits.get('credits') and number(credits.get('available_count')):
        expiry = epoch(credits.get('next_expires_at'))
        if expiry and expiry > timestamp:
            count = max(0, int(credits['available_count']))
            available = [expiry] if count else []
    next_expiry = min(available) if available else None
    expiry_hours = (next_expiry-timestamp)/3600 if next_expiry else None
    raw_short = next((w for w in provider.get('windows', []) if w.get('window','session')=='session'), {})
    raw_weekly = next((w for w in provider.get('windows', []) if w.get('window')=='weekly'), {})
    natural_reset = epoch(raw_short.get('resets_at'))
    short_used = raw_short.get('used_percent')
    weekly_used = raw_weekly.get('used_percent')
    reset_review = bool(count and important and number(short_used) and short_used>=94 and
        number(weekly_used) and weekly_used>=88 and expiry_hours is not None and expiry_hours<48 and
        natural_reset and (natural_reset-timestamp)/60>30)
    def blocked(reason):
        return {'blocked':True,'reason':reason,'score':0,'banked_reset_available':count>0,
            'banked_reset_count':count,'ticket_expires_in_hours':expiry_hours,
            'reset_review_recommended':reset_review,'reset_action':'none','paid_reset_purchase':'never_automatic'}
    if not number(task_minutes) or task_minutes <= 0:
        return blocked('positive task duration estimate required')
    windows = []
    score = 0.0
    safety = 1.0
    for raw in provider.get('windows', []):
        name = raw.get('window', 'session')
        kind = 'monthly' if name == 'monthly' else 'weekly' if name in ('weekly', 'fableWeekly') else 'short_window'
        used_percent = raw.get('used_percent')
        if not number(used_percent) or not 0 <= used_percent <= 100:
            return blocked('invalid quota percentage')
        used = used_percent / 100
        policy = targets[kind]
        hard_stop = policy['hard_stop']
        if used >= hard_stop:
            return blocked(f'{name} reached {hard_stop:.0%} hard stop')
        reset = epoch(raw.get('resets_at'))
        minutes = (reset - timestamp)/60 if reset else None
        if minutes is not None and minutes <= 0:
            return blocked(f'{name} reset passed; refresh quota')
        # Short jobs may consume the last few percent; long jobs may not.
        # A 100% hard stop means "use it up": keep the chosen AI instead of handing off early.
        if kind == 'short_window' and hard_stop < 1 and used >= .95 and task_minutes > 15:
            return blocked('short quota >=95%; avoid a new long task')
        duration = raw.get('window_minutes')
        start = epoch(raw.get('starts_at'))
        if start and reset and reset > start:
            duration = (reset-start)/60
        progress = None
        if number(duration) and duration > 0 and minutes is not None:
            progress = max(0.0, min(1.0, 1-minutes/duration))
        pace_delta = used-progress if progress is not None else None
        target_pace_delta = used-policy['target']*progress if progress is not None else None
        reserve = targets.get('reserve', {}).get(kind, 0)
        usable = max(0.0, min(hard_stop-used, 1-used-reserve))
        headroom = max(.02, min(1, usable/max(.01, policy['target'])))
        if kind != 'short_window':
            safety = min(safety, headroom)
        underuse = max(-1.0,min(1.0,-target_pace_delta)) if target_pace_delta is not None else 0
        # Monthly pools have little immediate expiry value; do not compare raw remaining%.
        urgency = min(8.0, usable/max(.1,minutes/60)) if minutes is not None else 0
        window_score = 0.0
        if kind == 'short_window':
            window_score = 20*urgency + 12*underuse
            if used > policy['target']:
                window_score -= 8*(used-policy['target'])/(hard_stop-policy['target'])
        elif kind == 'weekly':
            window_score = 3*urgency + 10*underuse
        else:
            window_score = urgency + 18*underuse
        score += window_score
        windows.append({'window':name,'kind':kind,'usage':used,'remaining':1-used,
            'target':policy['target'],'hard_stop':hard_stop,'reserve':reserve,
            'time_to_reset_min':minutes,'period_progress':progress,'pace_delta':pace_delta,
            'target_pace_delta':target_pace_delta,'pace_known':progress is not None,
            'expiry_urgency':urgency,'usable_budget':usable})
    if not windows:
        return blocked('no measured quota windows')
    score = (10+score)*safety
    repeats = sum(1 for value in recent[-5:] if value == agent)
    diversity_penalty = .25 * repeats
    score -= diversity_penalty
    # Tickets never override a current hard stop or turn already spent quota into capacity.
    reset_opportunity_bonus = 1.0 if count and expiry_hours is not None and expiry_hours < 48 else 0
    score += reset_opportunity_bonus
    bottleneck = min(windows,key=lambda w:w['usable_budget'])['window']
    descriptions=[]
    for w in windows:
        pace='under target pace' if w['target_pace_delta'] is not None and w['target_pace_delta']<0 else 'ahead of target pace' if w['target_pace_delta'] is not None else 'pace unknown'
        descriptions.append(f"{w['window']} {w['usage']:.0%}, {pace}"+
            (f", resets in {w['time_to_reset_min']:.0f}m" if w['time_to_reset_min'] is not None else ', reset unknown'))
    return {'blocked':False,'reason':'; '.join(descriptions)+f'; safety bottleneck={bottleneck}',
        'score':round(score,6),'windows':windows,'bottleneck':bottleneck,
        'provider_diversity_penalty':diversity_penalty,'banked_reset_available':count>0,
        'banked_reset_count':count,'ticket_expires_in_hours':expiry_hours,
        'reset_opportunity_bonus':reset_opportunity_bonus,
        'reset_review_recommended':reset_review,'reset_action':'none',
        'paid_reset_purchase':'never_automatic',
        'estimate_note':'task duration is an estimate; task token cost is unknown'}
