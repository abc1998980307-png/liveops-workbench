#!/usr/bin/env python3
"""Open the dashboard without mistaking a collector failure for an offline website."""
from pathlib import Path
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser
from runtime_config import DATA_ROOT

ROOT = Path(__file__).resolve().parent
INSTALLED = DATA_ROOT / 'dashboard'
LABEL = 'com.liyida.liveops-dashboard'
PORT = int(os.environ.get('LIVEOPS_PORT', '8765'))
URL = f'http://127.0.0.1:{PORT}'


def ready():
    try:
        with urllib.request.urlopen(URL + '/api/health', timeout=2) as response:
            return json.load(response).get('service') == 'liveops-dashboard'
    except (OSError, ValueError):
        return False


def port_in_use():
    try:
        with socket.create_connection(('127.0.0.1', PORT), timeout=1):
            return True
    except OSError:
        return False


def main():
    if not ready():
        if port_in_use():
            raise SystemExit(f'{PORT} 端口已有服务但工作台尚未响应，请稍后重试或检查日志；未重复启动。')
        loaded = False
        if sys.platform == 'darwin' and not os.environ.get('LIVEOPS_DATA_ROOT') and PORT == 8765:
            service = f'gui/{os.getuid()}/{LABEL}'
            loaded = subprocess.run(['/bin/launchctl', 'print', service], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
        if loaded:
            subprocess.run(['/bin/launchctl', 'kickstart', service], check=True)
        else:
            app_root = INSTALLED if sys.platform == 'darwin' and (INSTALLED / 'server.py').is_file() else ROOT
            logdir = DATA_ROOT / 'logs'
            logdir.mkdir(parents=True, exist_ok=True)
            with (logdir / 'dashboard.log').open('ab') as log:
                process = subprocess.Popen([sys.executable, str(app_root / 'server.py')], cwd=app_root,
                                           stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                           start_new_session=sys.platform != 'win32',
                                           creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == 'win32' else 0,
                                           env={**os.environ, 'PYTHONUNBUFFERED': '1'})
        for _ in range(60):
            if ready():
                break
            if not loaded and process.poll() is not None:
                raise SystemExit(f'工作台启动失败，请查看 {DATA_ROOT / "logs/dashboard.log"}')
            time.sleep(.5)
        else:
            raise SystemExit(f'工作台启动超时，请查看 {DATA_ROOT / "logs/dashboard.log"}')
    webbrowser.open(URL + '/#business')
    print('直播操盘台已打开：' + URL + '/#business')


if __name__ == '__main__':
    main()
