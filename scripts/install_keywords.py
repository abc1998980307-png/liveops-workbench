#!/usr/bin/env python3
"""Install pinned KeyBERT packages and multilingual model into a private environment."""
import argparse
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.install import InstallError, checksum, download, installation_lock
from keyword_service import save_json, stamp

PROJECT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((PROJECT / 'scripts/keyword-model.json').read_text())
LOCK = PROJECT / 'scripts/requirements-keywords.lock'


def check_environment(python):
    script = ('import keybert,jieba,torch,numpy,transformers; '
              'assert keybert.__version__ == "0.9.0"; '
              'assert numpy.__version__ == "1.26.4"; '
              'assert transformers.__version__ == "4.44.2"; '
              'assert torch.tensor([1.]).numpy().tolist()==[1.]')
    subprocess.run([str(python), '-c', script], check=True, timeout=90)


def install(root):
    envdir = root / 'tools/keywords-env'
    python = envdir / 'bin/python3'
    model = root / 'tools/keyword-model'
    with installation_lock(root):
        if envdir.exists():
            try:
                check_environment(python)
            except (OSError, subprocess.SubprocessError) as error:
                raise InstallError('已有关键词环境检查未通过，已保留原目录。请移走该目录后重试。') from error
            print('关键词环境检查通过，保留现有安装', flush=True)
        else:
            envdir.parent.mkdir(parents=True, exist_ok=True)
            # The venv must stay at its final path (its scripts embed that path).
            try:
                subprocess.run([sys.executable, '-m', 'venv', str(envdir)], check=True, timeout=120)
                subprocess.run([str(python), '-m', 'pip', 'install', '--require-hashes',
                                '-r', str(PROJECT / 'scripts/requirements-keywords-build.lock')], check=True, timeout=300)
                subprocess.run([str(python), '-m', 'pip', 'install', '--require-hashes',
                                '--no-build-isolation', '-r', str(LOCK)], check=True, timeout=1800)
                check_environment(python)
            except BaseException:
                # Remove only the incomplete environment created by this attempt.
                shutil.rmtree(envdir)
                raise
        if model.exists():
            if not all((model / f['path']).is_file() and checksum(model / f['path']) == f['sha256'] for f in MANIFEST['files']):
                raise InstallError('已有关键词模型校验失败，已保留原目录。请移走后重试。')
        else:
            model.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix='.keyword-model-', dir=model.parent) as temp:
                stage = Path(temp) / 'model'
                stage.mkdir()
                for item in MANIFEST['files']:
                    print('下载并校验：' + item['path'], flush=True)
                    source = download(item, root / 'downloads', rate_kib=1024)
                    destination = stage / item['path']
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, destination)
                stage.rename(model)
        # Offline load and a real encoding establish availability, not just paths.
        probe = ('from sentence_transformers import SentenceTransformer; '
                 'import sys,torch; torch.set_num_threads(2); '
                 'm=SentenceTransformer(sys.argv[1],device="cpu",local_files_only=True); '
                 'assert m.encode(["英语学习和自然拼读"]).shape[0]==1')
        subprocess.run([str(python), '-c', probe, str(model)], check=True, timeout=120,
                       env=dict(os.environ, HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1'))
        save_json(model / '.verified.json', {'verifiedAt': stamp(), 'revision': MANIFEST['revision'], 'requirementsSha256': checksum(LOCK)})
        print('KeyBERT 与中文模型已安装并通过离线分析检查。', flush=True)


def main():
    def interrupted(*_):
        raise SystemExit('安装已取消，未发布的文件已清理')
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path, default=Path.home() / 'Library/Application Support/LiveOps')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    root = args.data_root.expanduser()
    if not root.is_absolute():
        parser.error('数据目录必须是绝对路径')
    if not args.apply:
        print('将安装 KeyBERT 0.9.0、中文分词与约 480 MB 的固定版本多语言模型。添加 --apply 执行。')
        return
    if sys.platform != 'darwin' or platform.machine() != 'arm64' or not (3, 9) <= sys.version_info[:2] <= (3, 11):
        parser.error('需要 macOS Apple Silicon 和 Python 3.9—3.11')
    install(root.resolve())


if __name__ == '__main__':
    main()
