import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import rpa_bridge as bridge


class RuntimeDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory())).resolve()
        self.runtime = self.root / "runtime"
        self.stack.enter_context(mock.patch.object(bridge, "ROOT", self.root))
        self.stack.enter_context(mock.patch.object(bridge, "RUNTIME", self.runtime))
        self.stack.enter_context(mock.patch.object(bridge, "MANAGED_NODE", self.root / "managed/bin/node"))
        self.stack.enter_context(mock.patch.object(bridge, "MANAGED_PLAYWRIGHT", self.root / "managed/index.mjs"))
        self.stack.enter_context(mock.patch.dict(bridge.os.environ, {}, clear=True))
        self.which = self.stack.enter_context(mock.patch.object(bridge.shutil, "which", return_value=None))
        self.run = self.stack.enter_context(mock.patch.object(bridge.subprocess, "run"))
        self.run.return_value = subprocess.CompletedProcess([], 0, stdout="v24.2.0\n", stderr="")

    def file(self, relative, executable=False):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture")
        if executable:
            path.chmod(0o700)
        return path

    def test_explicit_node_wins_and_invalid_override_does_not_fall_back(self):
        explicit = self.file("custom/node", True)
        self.which.return_value = str(self.file("path/node", True))
        self.file("runtime/bin/node", True)
        with mock.patch.dict(bridge.os.environ, {"LIVEOPS_NODE": str(explicit)}):
            self.assertEqual(bridge.discover_node(), str(explicit))
            self.which.assert_not_called()
            self.run.return_value.stdout = "v22.9.0"
            with self.assertRaisesRegex(RuntimeError, "LIVEOPS_NODE"):
                bridge.discover_node()

    def test_compatible_path_node_precedes_bundled_fallback(self):
        path_node = self.file("path/node", True)
        self.which.return_value = str(path_node)
        self.file("runtime/bin/node", True)
        self.assertEqual(bridge.discover_node(), str(path_node))
        self.assertEqual(self.run.call_args.args[0], [str(path_node), "--version"])

    def test_old_or_broken_path_node_uses_compatible_fallback(self):
        path_node = self.file("path/node", True)
        fallback = self.file("runtime/bin/node", True)
        self.which.return_value = str(path_node)
        for first in (subprocess.CompletedProcess([], 0, stdout="v22.9.0", stderr=""),
                      subprocess.TimeoutExpired("node", 5)):
            self.run.side_effect = [first, subprocess.CompletedProcess([], 0, stdout="v24.2.0", stderr="")]
            self.assertEqual(bridge.discover_node(), str(fallback))

    def test_managed_install_precedes_codex_fallback(self):
        managed = self.file("managed/bin/node", True)
        self.file("runtime/bin/node", True)
        self.assertEqual(bridge.discover_node(), str(managed))
        self.file("runtime/node_modules/playwright-core/index.mjs")
        module = self.file("managed/index.mjs")
        self.assertEqual(bridge.discover_playwright(), str(module))

    def test_node_missing_and_nonexecutable_fail_without_launch(self):
        self.which.return_value = str(self.file("path/node"))
        with self.assertRaisesRegex(RuntimeError, "Node.js 24"):
            bridge.discover_node()
        self.run.assert_not_called()

    def test_local_playwright_precedes_runtime_and_explicit_path_is_authoritative(self):
        fallback = self.file("runtime/node_modules/playwright-core/index.mjs")
        self.assertEqual(bridge.discover_playwright(), str(fallback))
        local = self.file("node_modules/playwright-core/index.mjs")
        self.assertEqual(bridge.discover_playwright(), str(local))
        explicit = self.file("custom/index.mjs")
        with mock.patch.dict(bridge.os.environ, {"LIVEOPS_PLAYWRIGHT_MODULE": str(explicit)}):
            self.assertEqual(bridge.discover_playwright(), str(explicit))
            explicit.unlink()
            with self.assertRaisesRegex(RuntimeError, "LIVEOPS_PLAYWRIGHT_MODULE"):
                bridge.discover_playwright()
        self.run.assert_not_called()

    def test_missing_playwright_explains_checkout_install(self):
        with self.assertRaisesRegex(RuntimeError, "npm ci"):
            bridge.discover_playwright()


if __name__ == "__main__":
    unittest.main()
