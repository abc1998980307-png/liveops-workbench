"""Shared data location; an explicit root keeps installation checks isolated."""
import os
from pathlib import Path


def data_root():
    value = os.environ.get("LIVEOPS_DATA_ROOT")
    root = Path(value).expanduser() if value else Path.home() / "Library/Application Support/LiveOps"
    if not root.is_absolute():
        raise ValueError("LIVEOPS_DATA_ROOT 必须是绝对路径")
    return root.resolve()


DATA_ROOT = data_root()
MANAGED_NODE = DATA_ROOT / "tools/node/bin/node"
MANAGED_PLAYWRIGHT = DATA_ROOT / "tools/collector/node_modules/playwright-core/index.mjs"
