#!/usr/bin/env python3
"""Install pinned tools into LiveOps; never start services or replace existing tools."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

PROJECT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((Path(__file__).with_name("dependencies.json")).read_text())
COMPONENTS = ("node", "collector", "ffmpeg", "recorder", "cmake", "whisper", "model", "dailyhot")


class InstallError(RuntimeError):
    pass


def checksum(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def child(root, relative):
    parts = PurePosixPath(relative)
    if parts.is_absolute() or ".." in parts.parts or "\\" in relative:
        raise InstallError("安装包包含不安全路径")
    path = root.joinpath(*parts.parts)
    if not path.resolve().is_relative_to(root.resolve()):
        raise InstallError("安装包路径超出暂存目录")
    return path


def unpack(archive, destination, kind):
    """Extract only bounded regular files/directories and safe internal symlinks."""
    total = 0
    links = []
    seen = set()

    def write(name, size, mode, stream=None, link=None, directory=False):
        nonlocal total
        path = child(destination, name)
        if path in seen or path.is_symlink():
            raise InstallError("安装包含重复路径")
        seen.add(path)
        total += size
        if total > 3 * 1024 ** 3 or len(seen) > 100000:
            raise InstallError("安装包展开大小超出限制")
        if directory:
            path.mkdir(parents=True, exist_ok=True)
        elif link is not None:
            target = PurePosixPath(link)
            if target.is_absolute() or "\\" in link:
                raise InstallError("安装包包含不安全链接")
            resolved = (path.parent / link).resolve()
            if not resolved.is_relative_to(destination.resolve()):
                raise InstallError("安装包链接超出暂存目录")
            links.append((path, link))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("xb") as output:
                shutil.copyfileobj(stream, output)
            path.chmod(0o755 if mode & 0o111 else 0o644)

    if kind == "tar":
        with tarfile.open(archive, "r:gz") as source:
            for item in source:
                if item.isdir():
                    write(item.name, 0, item.mode, directory=True)
                elif item.isfile():
                    with source.extractfile(item) as stream:
                        write(item.name, item.size, item.mode, stream=stream)
                elif item.issym():
                    write(item.name, 0, item.mode, link=item.linkname)
                else:
                    raise InstallError("安装包包含不支持的特殊文件")
    elif kind == "zip":
        with zipfile.ZipFile(archive) as source:
            for item in source.infolist():
                mode = item.external_attr >> 16
                if item.is_dir():
                    write(item.filename, 0, mode, directory=True)
                elif stat.S_ISLNK(mode):
                    if item.file_size > 4096:
                        raise InstallError("安装包链接内容过长")
                    write(item.filename, 0, mode, link=source.read(item).decode())
                elif stat.S_IFMT(mode) not in (0, stat.S_IFREG):
                    raise InstallError("安装包包含不支持的特殊文件")
                else:
                    with source.open(item) as stream:
                        write(item.filename, item.file_size, mode, stream=stream)
    else:
        raise InstallError("不支持的安装包格式")
    # Create links last, so no archive write can traverse one.
    for path, link in links:
        if path.exists():
            raise InstallError("安装包链接与已有路径冲突")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.symlink_to(link)
    for path, _ in links:
        if not path.resolve().is_relative_to(destination.resolve()):
            raise InstallError("安装包链式链接超出暂存目录")


def download(spec, cache, rate_kib=1024):
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / (spec["sha256"] + ".download")
    if target.is_file() and checksum(target) == spec["sha256"]:
        return target
    parsed = urllib.parse.urlsplit(spec["url"])
    if parsed.scheme != "https" or parsed.username or parsed.password:
        raise InstallError("依赖必须使用官方 HTTPS 下载地址")
    request = urllib.request.Request(spec["url"], headers={"User-Agent": "LiveOps-Workbench-Installer/0.1"})
    temporary = None
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            if urllib.parse.urlsplit(response.url).scheme != "https":
                raise InstallError("下载被重定向到非 HTTPS 地址")
            with tempfile.NamedTemporaryFile(dir=cache, prefix="download-", delete=False) as output:
                temporary = Path(output.name)
                size, started, last_report = 0, time.monotonic(), time.monotonic()
                while True:
                    chunk = response.read(128 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    size += len(chunk)
                    if size > 2 * 1024 ** 3:
                        raise InstallError("下载超过 2 GiB 限制")
                    if time.monotonic() - started > 3600:
                        raise InstallError("下载超过一小时，请重试")
                    delay = size / (rate_kib * 1024) - (time.monotonic() - started)
                    if delay > 0:
                        time.sleep(min(delay, 1))
                    if time.monotonic() - last_report > 20:
                        print(f"  已下载 {size // (1024 * 1024)} MiB", flush=True)
                        last_report = time.monotonic()
        if checksum(temporary) != spec["sha256"]:
            raise InstallError("下载校验失败，未安装；请检查网络后重试")
        temporary.replace(target)
        return target
    except (OSError, urllib.error.URLError) as error:
        raise InstallError("依赖下载失败：" + str(error)) from error
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def probe(binary, args):
    if not binary.is_file() or not os.access(binary, os.X_OK):
        return False
    try:
        result = subprocess.run([str(binary), *args], capture_output=True, timeout=15)
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


@contextlib.contextmanager
def installation_lock(root):
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".install.lock").open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise InstallError("此目录已有安装任务，请等待完成") from error
        yield


class Installer:
    def __init__(self, root, cache, rate_kib=1024):
        self.root, self.cache, self.rate_kib = root, cache, rate_kib
        self.logs = root / "logs/install"
        self.logs.mkdir(parents=True, exist_ok=True)

    def run(self, command, log_name, cwd=None, timeout=1800, env=None):
        log = self.logs / log_name
        print(f"  执行检查 / 构建，日志：{log}", flush=True)
        try:
            with log.open("ab") as output:
                result = subprocess.run([str(x) for x in command], cwd=cwd, env=env,
                                        stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
            if result.returncode:
                raise InstallError(f"执行失败（{result.returncode}），详情：{log}")
        except (OSError, subprocess.TimeoutExpired) as error:
            raise InstallError(f"执行失败，请查看 {log}：{error}") from error

    def present(self, name):
        spec = MANIFEST[name]
        target = self.root / spec["target"]
        if not target.exists():
            return False
        if name == "model":
            valid = target.is_file() and checksum(target) == spec["sha256"]
        else:
            valid = probe(target / spec["binary"], spec["args"])
        if valid and name == "node":
            output = subprocess.run([str(target / spec["binary"]), "--version"], capture_output=True, text=True, timeout=15)
            version = re.fullmatch(r"v(\d+)\.\d+\.\d+", output.stdout.strip())
            valid = bool(version and int(version[1]) >= 24)
        if name == "recorder":
            archive = target / "v0.8.3-darwin-arm64.tar.gz"
            valid = valid and archive.is_file() and checksum(archive) == spec["sha256"]
        if valid:
            print(f"[已存在] {name}，保留现有安装", flush=True)
            return True
        # Existing user tools/configuration may be in use. Never overwrite them.
        raise InstallError(f"{name} 目标已存在但检查未通过，未覆盖：{target}")

    def install(self, name):
        if name == "collector":
            return self.collector()
        if name == "dailyhot":
            return self.dailyhot()
        if self.present(name):
            return
        spec = MANIFEST[name]
        print(f"[安装] {name} {spec['version']}", flush=True)
        archive = download(spec, self.cache, self.rate_kib)
        target = self.root / spec["target"]
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".liveops-install-", dir=target.parent) as directory:
            stage = Path(directory)
            if name == "model":
                staged_file = stage / "model.bin"
                shutil.copyfile(archive, staged_file)
                staged_file.rename(target)
                return
            unpack(archive, stage, spec["format"])
            content = stage / spec.get("prefix", "")
            if name == "whisper":
                compiler = subprocess.run(["xcrun", "--find", "clang"], capture_output=True)
                if compiler.returncode:
                    raise InstallError("请先运行 xcode-select --install 安装 Apple 命令行工具，再重试")
                cmake = self.root / MANIFEST["cmake"]["target"] / MANIFEST["cmake"]["binary"]
                self.run([cmake, "-S", content, "-B", content / "build", "-DCMAKE_BUILD_TYPE=Release",
                          "-DBUILD_SHARED_LIBS=OFF", "-DGGML_METAL_EMBED_LIBRARY=ON",
                          "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_CURL=OFF"], "whisper.log")
                self.run([cmake, "--build", content / "build", "--config", "Release",
                          "--target", "whisper-cli", "-j", "2"], "whisper.log")
            if name == "recorder":
                shutil.copyfile(archive, content / "v0.8.3-darwin-arm64.tar.gz")
            binary = content / spec["binary"]
            if binary.is_file():
                binary.chmod(0o755)
            if not probe(binary, spec["args"]):
                raise InstallError(f"{name} 可执行检查失败，未发布安装")
            (content / ".liveops-install.json").write_text(json.dumps({"component": name, **spec}, indent=2))
            content.rename(target)
        print(f"[完成] {name}", flush=True)

    def validate_dailyhot(self, target):
        node = self.root / "tools/node/bin/node"
        package = json.loads((target / "package.json").read_text())
        if package.get("name") != "dailyhot-api" or package.get("version") != MANIFEST["dailyhot"]["version"]:
            raise InstallError("已有热点服务版本不匹配，未覆盖")
        env = dict(os.environ, NODE_ENV="production", USE_LOG_FILE="false")
        self.run([node, "--input-type=module", "-e",
                  "const {default:app}=await import('./dist/app.js'); const {config}=await import('./dist/config.js'); "
                  "if(typeof app.fetch!=='function' || typeof config.FILTER_WEIBO_ADVERTISEMENT!=='boolean') process.exit(1);"],
                 "dailyhot-check.log", cwd=target, env=env, timeout=30)

    def dailyhot(self):
        spec = MANIFEST["dailyhot"]
        target = self.root / spec["target"]
        if target.exists():
            self.validate_dailyhot(target)
            print("[已存在] dailyhot，保留现有安装和配置", flush=True)
            return
        print(f"[安装] dailyhot {spec['version']}", flush=True)
        archive = download(spec, self.cache, self.rate_kib)
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".liveops-hot-", dir=target.parent) as directory:
            stage = Path(directory)
            unpack(archive, stage, spec["format"])
            content = stage / spec["prefix"]
            shutil.copyfile(PROJECT / "scripts/dailyhot-package-lock.json", content / "package-lock.json")
            node = self.root / "tools/node/bin/node"
            npm = self.root / "tools/node/lib/node_modules/npm/bin/npm-cli.js"
            env = dict(os.environ, PATH=str(node.parent) + os.pathsep + os.environ.get("PATH", ""))
            self.run([node, npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
                     "dailyhot-install.log", cwd=content, env=env, timeout=900)
            self.run([node, content / "node_modules/typescript/bin/tsc", "--project", "tsconfig.json"],
                     "dailyhot-build.log", cwd=content, env=env, timeout=120)
            self.validate_dailyhot(content)
            (content / ".liveops-install.json").write_text(json.dumps({"component": "dailyhot", **spec}, indent=2))
            content.rename(target)
        print("[完成] dailyhot；可在网页启动热点服务", flush=True)

    def collector(self):
        target = self.root / "tools/collector"
        node = self.root / "tools/node/bin/node"
        npm = self.root / "tools/node/lib/node_modules/npm/bin/npm-cli.js"
        if target.exists():
            if not (target / "node_modules/playwright-core/index.mjs").is_file():
                raise InstallError(f"采集组件目录不完整，未覆盖：{target}")
            self.validate_collector(node, target)
            print("[已存在] collector，保留现有安装", flush=True)
            return
        print("[安装] Playwright Core（项目锁文件）", flush=True)
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix=".liveops-collector-", dir=target.parent) as directory:
            content = Path(directory) / "collector"
            content.mkdir()
            for name in ("package.json", "package-lock.json"):
                shutil.copyfile(PROJECT / name, content / name)
            env = dict(os.environ, PATH=str(node.parent) + os.pathsep + os.environ.get("PATH", ""))
            self.run([node, npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], "collector.log", cwd=content, env=env)
            self.validate_collector(node, content)
            content.rename(target)
        print("[完成] collector", flush=True)

    def validate_collector(self, node, target):
        expected = json.loads((PROJECT / "package.json").read_text())["dependencies"]["playwright-core"]
        script = ("import {chromium} from 'playwright-core'; import {createRequire} from 'node:module'; "
                  "const req=createRequire(import.meta.url); if (!chromium || req('playwright-core/package.json').version !== "
                  + json.dumps(expected) + ") process.exit(1);")
        self.run([node, "--input-type=module", "-e", script], "collector-check.log", cwd=target, timeout=30)


def expand_components(selected):
    requested = set(selected)
    if requested - set(COMPONENTS):
        raise InstallError("未知组件：" + ",".join(sorted(requested - set(COMPONENTS))))
    if "collector" in requested:
        requested.add("node")
    if "dailyhot" in requested:
        requested.add("node")
    if "whisper" in requested:
        requested.add("cmake")
    if "model" in requested:
        requested.update(("whisper", "cmake"))
    return [name for name in COMPONENTS if name in requested]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="执行安装；缺省只预览")
    parser.add_argument("--components", default="node,collector,ffmpeg,recorder,whisper,model,dailyhot")
    parser.add_argument("--data-root", type=Path, default=Path(os.environ.get("LIVEOPS_DATA_ROOT", str(Path.home() / "Library/Application Support/LiveOps"))))
    parser.add_argument("--cache", type=Path, help="已校验下载包缓存，可用于离线重试")
    parser.add_argument("--rate-kib", type=int, default=1024, help="下载限速 KiB/s，默认 1024")
    args = parser.parse_args()
    try:
        root = args.data_root.expanduser()
        if not root.is_absolute() or not 128 <= args.rate_kib <= 10240:
            raise InstallError("数据目录必须为绝对路径；限速范围 128—10240 KiB/s")
        root = root.resolve()
        selected = expand_components(args.components.split(","))
        cache = args.cache.expanduser().resolve() if args.cache else root / "downloads"
        print(f"安装目录：{root}\n组件：{', '.join(selected)}", flush=True)
        print("保留已有工具和业务配置；不启动服务、录制、账号登录或采集。", flush=True)
        if not args.apply:
            print("添加 --apply 执行。Chrome 请从 https://www.google.com/chrome/ 安装。")
            return 0
        if sys.platform != "darwin" or platform.machine() != "arm64":
            raise InstallError("此安装清单仅适用于 macOS Apple Silicon")
        with installation_lock(root):
            installer = Installer(root, cache, args.rate_kib)
            for name in selected:
                installer.install(name)
        print("安装完成。运行 python3 scripts/doctor.py --full 检查；自定义目录需设置 LIVEOPS_DATA_ROOT。")
        return 0
    except (InstallError, OSError, ValueError, tarfile.TarError, zipfile.BadZipFile) as error:
        print("安装未完成：" + str(error), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
