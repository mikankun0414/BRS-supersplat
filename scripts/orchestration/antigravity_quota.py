"""Read Antigravity per-model quota from its running local language server.

Orca does not report Antigravity usage, so the coordinator asks the local
language_server.exe (GetUserStatus) while the Antigravity app is running.
The CSRF token is read from the process command line and is never stored.
"""
import datetime as dt
import json
import re
import ssl
import subprocess
import urllib.request

ENDPOINT = '/exa.language_server_pb.LanguageServerService/GetUserStatus'
FIVE_HOURS = 300


def parse_status(status, now_ms):
    """Turn a GetUserStatus reply into per-model scheduler windows.

    A model without remainingFraction has used its whole short window; the
    Antigravity settings page shows that state as 0% remaining.
    """
    models = {}
    configs = status.get('userStatus', {}).get('cascadeModelConfigData', {}).get('clientModelConfigs', [])
    for c in configs:
        quota = c.get('quotaInfo')
        if not c.get('modelId') or not isinstance(quota, dict):
            continue
        remaining = quota.get('remainingFraction', 0)
        resets_at = None
        try:
            resets_at = dt.datetime.fromisoformat(quota['resetTime'].replace('Z', '+00:00')).timestamp() * 1000
        except (KeyError, AttributeError, ValueError):
            pass
        models[c['modelId']] = [{'window': 'session', 'used_percent': round((1 - remaining) * 100, 1),
                                 'resets_at': resets_at, 'window_minutes': FIVE_HOURS}]
    return {'status': 'ok' if models else 'unknown', 'windows': [], 'models': models,
            'updated_at_ms': now_ms if models else None,
            'weekly_window': 'not exposed by GetUserStatus'}


def _servers():
    script = ("Get-CimInstance Win32_Process -Filter \"Name like 'language_server%'\" | ForEach-Object { "
              "[pscustomobject]@{cmd=$_.CommandLine; ports=@((Get-NetTCPConnection -OwningProcess $_.ProcessId "
              "-State Listen -ErrorAction SilentlyContinue).LocalPort | Sort-Object -Unique)} } | ConvertTo-Json -Depth 3")
    out = subprocess.run(['powershell', '-NoProfile', '-Command', script], capture_output=True,
                         text=True, encoding='utf-8', timeout=30).stdout.strip()
    if not out:
        return []
    items = json.loads(out)
    return items if isinstance(items, list) else [items]


def probe(now_ms):
    unavailable = {'status': 'unknown', 'windows': [], 'models': {}, 'updated_at_ms': None,
                   'reason': 'Antigravity language server not reachable'}
    try:
        servers = _servers()
    except (OSError, ValueError, subprocess.SubprocessError):
        return unavailable
    context = ssl.create_default_context()
    # The local server uses a self-signed certificate on 127.0.0.1.
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    body = json.dumps({'metadata': {'ideName': 'antigravity', 'extensionName': 'antigravity', 'locale': 'en'}}).encode()
    for server in servers:
        cmd = server.get('cmd') or ''
        if 'antigravity' not in cmd.lower():
            continue
        token = re.search(r'--csrf_token[ =](\S+)', cmd)
        if not token:
            continue
        ports = server.get('ports') or []
        for port in ports if isinstance(ports, list) else [ports]:
            for scheme in ('https', 'http'):
                request = urllib.request.Request(f'{scheme}://127.0.0.1:{port}{ENDPOINT}', data=body, headers={
                    'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': token.group(1)})
                try:
                    with urllib.request.urlopen(request, timeout=5,
                                                context=context if scheme == 'https' else None) as response:
                        return parse_status(json.loads(response.read().decode('utf-8')), now_ms)
                except (OSError, ValueError):
                    continue
    return unavailable
