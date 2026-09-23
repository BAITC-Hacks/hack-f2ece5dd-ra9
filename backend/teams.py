"""Open a Teams meeting in a guest browser window; never pretend it joined."""
from pathlib import Path
import os
import subprocess
import re
from urllib.parse import urlsplit


def validate_meeting_url(url: str) -> str:
    url = url.strip()
    try:
        parts = urlsplit(url)
        host = parts.hostname or ''
        teams = host in {'teams.microsoft.com', 'teams.live.com', 'teams.cloud.microsoft'} and parts.path.startswith(('/l/meetup-join/', '/meet/', '/v2/meet/', '/dl/launcher/'))
        meet = host == 'meet.google.com' and bool(re.fullmatch(r'/[a-z]{3}-[a-z]{4}-[a-z]{3}/?', parts.path))
        zoom = (host == 'zoom.us' or host.endswith('.zoom.us') or host == 'zoom.com' or host.endswith('.zoom.com')) and bool(re.match(r'^/(?:j/\d+|wc/\d+/join)', parts.path))
        if (parts.scheme != 'https' or not (teams or meet or zoom) or parts.username
                or parts.password or parts.port not in (None, 443) or any(ord(c) < 32 for c in url)):
            raise ValueError
    except ValueError:
        raise ValueError('Нужна HTTPS-ссылка на встречу Teams, Google Meet или Zoom.') from None
    return url


def meeting_platform(url: str) -> str:
    host = urlsplit(validate_meeting_url(url)).hostname
    return 'Google Meet' if host == 'meet.google.com' else 'Zoom' if 'zoom.' in host else 'Teams'


def open_guest_window(url: str):
    url = validate_meeting_url(url)
    candidates = [
        (Path(os.environ.get('PROGRAMFILES(X86)', 'C:/Program Files (x86)')) / 'Microsoft/Edge/Application/msedge.exe', '-inprivate'),
        (Path(os.environ.get('PROGRAMFILES', 'C:/Program Files')) / 'Microsoft/Edge/Application/msedge.exe', '-inprivate'),
        (Path(os.environ.get('PROGRAMFILES', 'C:/Program Files')) / 'Google/Chrome/Application/chrome.exe', '--incognito'),
    ]
    for executable, private_flag in candidates:
        if executable.is_file():
            # User-visible guest browser is intentional. No shell, credentials or profile changes.
            subprocess.Popen([str(executable), private_flag, '--new-window', url],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return {'status': 'browser_opened', 'joined': False,
                    'message': 'Открыто гостевое окно. Выберите вход в браузере, имя AI Протоколист, выключите микрофон и камеру. После допуска во встречу вернитесь и начните запись.'}
    raise RuntimeError('Установите Microsoft Edge или Google Chrome для гостевого входа в Teams.')
