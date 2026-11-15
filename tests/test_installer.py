import io
import ast
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import install
from scripts import verify_install


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.out = self.root / "unpacked"
        self.out.mkdir()

    def tar(self, members):
        path = self.root / "fixture.tar.gz"
        with tarfile.open(path, "w:gz") as archive:
            for name, value, kind in members:
                item = tarfile.TarInfo(name)
                item.mode = 0o755
                if kind == "link":
                    item.type = tarfile.SYMTYPE
                    item.linkname = value
                    archive.addfile(item)
                else:
                    content = value.encode()
                    item.size = len(content)
                    archive.addfile(item, io.BytesIO(content))
        return path

    @unittest.skipIf(sys.platform == 'win32', 'Windows symlinks require developer privileges')
    def test_extracts_node_style_relative_links_and_preserves_executable(self):
        archive = self.tar([("node/lib/npm.js", "fixture", "file"),
                            ("node/bin/npm", "../lib/npm.js", "link")])
        install.unpack(archive, self.out, "tar")
        self.assertEqual((self.out / "node/bin/npm").read_text(), "fixture")
        self.assertTrue(os.access(self.out / "node/lib/npm.js", os.X_OK))

    def test_tar_traversal_and_link_escape_are_rejected(self):
        for members in [[("../escape", "bad", "file")], [("/escape", "bad", "file")],
                        [("link", "../escape", "link")],
                        [("sub/link", "../../escape", "link")]]:
            with self.subTest(members=members), self.assertRaises(install.InstallError):
                install.unpack(self.tar(members), self.out, "tar")
        self.assertFalse((self.root / "escape").exists())

    def test_duplicate_archive_paths_are_rejected(self):
        with self.assertRaises(install.InstallError):
            install.unpack(self.tar([("file", "one", "file"), ("file", "two", "file")]), self.out, "tar")

    def test_zip_traversal_is_rejected(self):
        archive = self.root / "fixture.zip"
        with zipfile.ZipFile(archive, "w") as source:
            source.writestr("../escape", "bad")
        with self.assertRaises(install.InstallError):
            install.unpack(archive, self.out, "zip")
        self.assertFalse((self.root / "escape").exists())

    def test_checksum_cache_is_reused_without_network_and_corruption_not_trusted(self):
        data = b"pinned fixture"
        digest = install.hashlib.sha256(data).hexdigest()
        spec = {"url": "https://example.test/tool", "sha256": digest}
        cache = self.root / (digest + ".download")
        cache.write_bytes(data)
        with mock.patch.object(install.urllib.request, "urlopen") as fetch:
            self.assertEqual(install.download(spec, self.root), cache)
            fetch.assert_not_called()
        cache.write_bytes(b"corrupt")
        response = io.BytesIO(b"wrong download")
        response.url = spec["url"]
        with mock.patch.object(install.urllib.request, "urlopen", return_value=response):
            with self.assertRaisesRegex(install.InstallError, "校验失败"):
                install.download(spec, self.root)
        self.assertFalse(list(self.root.glob("download-*")))

    def test_broken_existing_install_is_not_overwritten(self):
        instance = install.Installer(self.root, self.root / "cache")
        target = self.root / install.MANIFEST["ffmpeg"]["target"]
        target.mkdir(parents=True)
        original = target / "user-file"
        original.write_text("keep")
        with mock.patch.object(install, "download") as download:
            with self.assertRaisesRegex(install.InstallError, "未覆盖"):
                instance.install("ffmpeg")
            download.assert_not_called()
        self.assertEqual(original.read_text(), "keep")

    def test_outdated_node_is_not_reported_compatible_or_overwritten(self):
        binary = self.root / install.MANIFEST['node']['target'] / install.MANIFEST['node']['binary']
        binary.parent.mkdir(parents=True)
        binary.write_bytes(b'user-installed node')
        instance = install.Installer(self.root, self.root / 'cache')
        with mock.patch.object(install, 'probe', return_value=True), \
                mock.patch.object(install.subprocess, 'run', return_value=mock.Mock(stdout='v22.9.0')):
            with self.assertRaisesRegex(install.InstallError, '未覆盖'):
                instance.install('node')
        self.assertEqual(binary.read_bytes(), b'user-installed node')

    def test_lock_blocks_concurrent_installer_and_releases(self):
        with install.installation_lock(self.root):
            with self.assertRaisesRegex(install.InstallError, "已有安装任务"):
                with install.installation_lock(self.root):
                    self.fail("acquired twice")
        with install.installation_lock(self.root):
            pass

    def test_failed_binary_probe_never_publishes_target(self):
        archive = self.tar([("tool", "not executable content", "file")])
        spec = {"version": "fixture", "target": "tools/example", "format": "tar", "binary": "tool", "args": ["--version"]}
        instance = install.Installer(self.root, self.root / "cache")
        with mock.patch.dict(install.MANIFEST, {"example": spec}), mock.patch.object(install, "download", return_value=archive):
            with self.assertRaisesRegex(install.InstallError, "可执行检查失败"):
                instance.install("example")
        self.assertFalse((self.root / "tools/example").exists())
        self.assertFalse(list((self.root / "tools").glob(".liveops-install-*")))

    def test_preview_has_no_filesystem_effect(self):
        destination = self.root / "fresh"
        result = subprocess.run([sys.executable, str(install.PROJECT / "scripts/install.py"),
                                 "--data-root", str(destination)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(destination.exists())

    def test_component_dependencies_and_unknown_names(self):
        self.assertEqual(install.expand_components(["collector"]), ["node", "collector"])
        self.assertEqual(install.expand_components(["model"]), ["cmake", "whisper", "model"])
        with self.assertRaises(install.InstallError):
            install.expand_components(["unknown"])

    def test_root_override_is_shared_without_starting_services(self):
        root = self.root / "separate"
        env = dict(os.environ, LIVEOPS_DATA_ROOT=str(root))
        script = "import json,runtime_config,rpa_bridge,media_pipeline; print(json.dumps([str(runtime_config.DATA_ROOT),str(rpa_bridge.DATA),str(media_pipeline.DATA_ROOT)]))"
        result = subprocess.run([sys.executable, "-c", script], cwd=install.PROJECT, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), [str(root), str(root / "rpa"), str(root)])
        self.assertFalse(root.exists())

    def test_install_verifier_rejects_failures_even_with_python_optimization(self):
        verifier = install.PROJECT / "scripts/verify_install.py"
        source = verifier.read_text(encoding="utf-8")
        self.assertFalse(any(isinstance(node, ast.Assert) for node in ast.walk(ast.parse(source))))
        command = [sys.executable, "-O", "-c",
                   "from scripts.verify_install import require; require(False, 'synthetic failure')"]
        result = subprocess.run(command, cwd=install.PROJECT, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("安装验收失败：synthetic failure", result.stderr)

    @unittest.skipIf(sys.platform == 'win32', 'macOS verifier uses symbolic links')
    def test_install_verifier_creates_fresh_business_root_for_each_attempt(self):
        installed = self.root / "installed"
        for relative in verify_install.RUNTIME_COMPONENTS:
            path = installed / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            if relative.endswith(("playwright-core", "dailyhot-api")):
                path.mkdir()
            else:
                path.write_text("pinned tool fixture")
        first = verify_install.prepare_runtime_root(installed)
        (first / "recordings").mkdir()
        (first / "recordings" / "synthetic.flv").write_text("first attempt")
        second = verify_install.prepare_runtime_root(installed)
        self.assertNotEqual(first, second)
        self.assertFalse((second / "recordings").exists())
        for relative in verify_install.RUNTIME_COMPONENTS:
            self.assertTrue((second / relative).is_symlink())
            self.assertEqual((second / relative).resolve(), (installed / relative).resolve())
        self.assertEqual((first / "recordings" / "synthetic.flv").read_text(), "first attempt")
