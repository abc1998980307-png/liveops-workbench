#!/usr/bin/env python3
"""Check JavaScript syntax, including the dashboard's inline script."""
from html.parser import HTMLParser
from pathlib import Path
import os
import shutil
import subprocess
import tempfile


class Scripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.inline = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            self.inline = not dict(attrs).get("src")

    def handle_endtag(self, tag):
        if tag == "script":
            self.inline = False
            self.parts.append("\n")

    def handle_data(self, data):
        if self.inline:
            self.parts.append(data)


def main():
    root = Path(__file__).resolve().parents[1]
    node = os.environ.get("LIVEOPS_NODE") or shutil.which("node")
    if not node:
        raise SystemExit("Node.js 24+ is required; set LIVEOPS_NODE or add node to PATH.")
    parser = Scripts()
    parser.feed((root / "直播操盘台.html").read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory() as directory:
        inline = Path(directory) / "dashboard.js"
        inline.write_text("".join(parser.parts), encoding="utf-8")
        for source in [inline, root / "rpa-ui.js", root / "feishu-ui.js", root / "dependency-ui.js", root / "hot-service-ui.js", root / "scripts/dailyhot_runner.mjs", root / "recording-sessions-ui.js", root / "keyword-ui.js", *sorted((root / "rpa").glob("*.mjs"))]:
            subprocess.run([node, "--check", str(source)], check=True)
    print("Frontend and collector JavaScript syntax passed.")


if __name__ == "__main__":
    main()
