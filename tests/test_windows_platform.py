import os
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import platform_support
import runtime_config
import start_dashboard
from recorder_service import RecorderManager


class PlatformPathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def test_data_root_uses_mac_existing_location_and_windows_roaming_appdata(self):
        home = self.root / "home"
        appdata = self.root / "AppData/Roaming"
        self.assertEqual(runtime_config.data_root("darwin", {}, home),
                         home / "Library/Application Support/LiveOps")
        self.assertEqual(runtime_config.data_root("win32", {"APPDATA": str(appdata)}, home),
                         appdata / "LiveOps")
        self.assertFalse(appdata.exists())

    def test_override_precedes_platform_defaults_and_rejects_relative_path(self):
        override = self.root / "自定义数据"
        for platform in ("darwin", "win32"):
            with self.subTest(platform=platform):
                self.assertEqual(runtime_config.data_root(platform, {"LIVEOPS_DATA_ROOT": str(override)}), override)
                with self.assertRaisesRegex(ValueError, "绝对路径"):
                    runtime_config.data_root(platform, {"LIVEOPS_DATA_ROOT": "relative"})
        with self.assertRaisesRegex(ValueError, "APPDATA"):
            runtime_config.data_root("win32", {})

    def test_tool_paths_preserve_mac_and_resolve_windows_overrides_and_path(self):
        ffmpeg = self.root / "external/ffmpeg.exe"
        self.assertEqual(platform_support.tool_path("ffmpeg", "darwin", {}, self.root),
                         self.root / "tools/imageio-ffmpeg/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1")
        self.assertEqual(platform_support.tool_path("ffmpeg", "win32", {"LIVEOPS_FFMPEG": str(ffmpeg)}, self.root), ffmpeg)
        self.assertEqual(platform_support.tool_path("ffmpeg", "win32", {}, self.root,
                                                     finder=lambda name: str(ffmpeg) if name == "ffmpeg.exe" else None), ffmpeg)
        self.assertEqual(platform_support.tool_path("node", "win32", {}, self.root, finder=lambda _: None),
                         self.root / "tools/node/node.exe")

    def test_browser_lookup_finds_windows_chrome_edge_and_explicit_override(self):
        program_files = self.root / "Program Files"
        edge = program_files / "Microsoft/Edge/Application/msedge.exe"
        edge.parent.mkdir(parents=True)
        edge.touch()
        env = {"PROGRAMFILES": str(program_files)}
        self.assertEqual(platform_support.browser_path("win32", env), edge)
        chrome = program_files / "Google/Chrome/Application/chrome.exe"
        chrome.parent.mkdir(parents=True)
        chrome.touch()
        self.assertEqual(platform_support.browser_path("win32", env), chrome)
        self.assertIsNone(platform_support.browser_path("win32", {**env, "LIVEOPS_CHROME": str(self.root / "missing.exe")}))

    def test_windows_manifest_uses_windows_binaries_and_shared_pinned_sources(self):
        scripts = Path(__file__).resolve().parents[1] / "scripts"
        windows = json.loads((scripts / "dependencies-windows.json").read_text(encoding="utf-8"))
        mac = json.loads((scripts / "dependencies.json").read_text(encoding="utf-8"))
        self.assertEqual(windows["platform"], "win32-amd64")
        for name in ("node", "ffmpeg", "recorder", "cmake", "whisper"):
            self.assertTrue(windows[name]["binary"].endswith(".exe"))
        for name in ("whisper", "model", "dailyhot"):
            self.assertEqual(windows[name]["sha256"], mac[name]["sha256"])


class WindowsStartupTests(unittest.TestCase):
    def test_windows_launcher_never_invokes_launchctl_and_passes_python_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            installed = Path(directory) / "dashboard"
            installed.mkdir()
            (installed / "server.py").touch()
            child = mock.Mock()
            child.poll.return_value = None
            with mock.patch.object(start_dashboard.sys, "platform", "win32"), \
                    mock.patch.object(start_dashboard.subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200, create=True), \
                    mock.patch.object(start_dashboard, "DATA_ROOT", Path(directory)), \
                    mock.patch.object(start_dashboard, "INSTALLED", installed), \
                    mock.patch.object(start_dashboard, "ready", side_effect=[False, True]), \
                    mock.patch.object(start_dashboard, "port_in_use", return_value=False), \
                    mock.patch.object(start_dashboard.subprocess, "Popen", return_value=child) as spawn, \
                    mock.patch.object(start_dashboard.subprocess, "run") as run, \
                    mock.patch.object(start_dashboard.webbrowser, "open") as browser, \
                    mock.patch("builtins.print") as report:
                start_dashboard.main()
            run.assert_not_called()
            self.assertEqual(spawn.call_args.args[0], [sys.executable, str(start_dashboard.ROOT / "server.py")])
            self.assertEqual(spawn.call_args.kwargs["env"]["PYTHONUNBUFFERED"], "1")
            self.assertEqual(spawn.call_args.kwargs["creationflags"], 0x200)
            self.assertFalse(spawn.call_args.kwargs["start_new_session"])
            browser.assert_called_once_with(start_dashboard.URL + "/#business")
            report.assert_called_once_with("直播操盘台已打开：" + start_dashboard.URL + "/#business")

    def test_windows_recorder_identity_uses_powershell_for_exact_pid(self):
        response = mock.Mock(returncode=0, stdout="20261115010000\nrecorder.exe --config=test.yml\n")
        with mock.patch("recorder_service.sys.platform", "win32"), \
                mock.patch("recorder_service.subprocess.run", return_value=response) as run:
            identity = RecorderManager._identity(123)
        self.assertIn("recorder.exe", identity)
        self.assertEqual(run.call_args.args[0][:3], ["powershell.exe", "-NoProfile", "-Command"])
        self.assertIn("ProcessId=123", run.call_args.args[0][-1])

    def test_windows_external_recorder_uses_adjacent_config_template(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            external = root / "external/recorder.exe"
            external.parent.mkdir()
            external.touch()
            (external.parent / "config.yml").write_text("rpc:\n  enable: false\n", encoding="utf-8")
            ffmpeg = root / "ffmpeg.exe"
            ffmpeg.touch()
            with mock.patch("recorder_service.sys.platform", "win32"), \
                    mock.patch.dict(os.environ, {"LIVEOPS_RECORDER": str(external), "LIVEOPS_FFMPEG": str(ffmpeg)}):
                manager = RecorderManager(root)
                manager._write_runtime()
            self.assertTrue(manager.runtime_file.is_file())
            self.assertIn("rpc:", manager.runtime_file.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
