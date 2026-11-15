"""Shared data location; an explicit root keeps installation checks isolated."""
import os
import sys
from pathlib import Path


def data_root(platform=None, environ=None, home=None):
    platform = platform or sys.platform
    environ = os.environ if environ is None else environ
    home = Path.home() if home is None else Path(home)
    value = environ.get("LIVEOPS_DATA_ROOT")
    if value:
        root = Path(value).expanduser()
    elif platform == "win32":
        appdata = environ.get("APPDATA")
        if not appdata:
            raise ValueError("Windows 需要 APPDATA 或 LIVEOPS_DATA_ROOT")
        root = Path(appdata) / "LiveOps"
    else:
        root = home / "Library/Application Support/LiveOps"
    if not root.is_absolute():
        raise ValueError("LIVEOPS_DATA_ROOT 必须是绝对路径")
    return root.resolve()


DATA_ROOT = data_root()
MANAGED_NODE = DATA_ROOT / ("tools/node/node.exe" if sys.platform == "win32" else "tools/node/bin/node")
MANAGED_PLAYWRIGHT = DATA_ROOT / "tools/collector/node_modules/playwright-core/index.mjs"
