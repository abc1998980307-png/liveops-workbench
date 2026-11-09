"""Local transcript inventory and serialized KeyBERT jobs (no model in HTTP threads)."""
import json
import os
import re
import signal
import subprocess
import sys
import threading
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

MAX_FILES = 500
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_TOTAL_BYTES = 32 * 1024 * 1024
MAX_CHARACTERS = 500_000
MAX_ENTRIES = 10000
MAX_REFERENCES = 3
TIME = re.compile(r'^(\d{1,6}):(\d{2}):(\d{2})[,.](\d{1,3})$')


def stamp():
    return datetime.now(timezone.utc).isoformat()


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(path)


def read_json(path, default=None):
    try:
        if path.stat().st_size > 2 * 1024 * 1024:
            return default
        return json.loads(path.read_text(encoding='utf-8'))
    except (ValueError, OSError):
        return default


def seconds(value):
    match = TIME.fullmatch(value.strip())
    if not match or int(match[2]) >= 60 or int(match[3]) >= 60:
        raise ValueError('字幕时间无效')
    return int(match[1]) * 3600 + int(match[2]) * 60 + int(match[3]) + int(match[4].ljust(3, '0')) / 1000


def caption_units(text, suffix):
    if suffix == '.txt':
        return [{'text': line.strip(), 'timestamp': '', 'seconds': None} for line in text.splitlines() if line.strip()], 0
    units, invalid = [], 0
    for block in re.split(r'\n\s*\n', text.replace('\r\n', '\n').replace('\r', '\n')):
        if not block.strip():
            continue
        lines = block.strip().splitlines()
        index = 1 if lines[0].strip().isdigit() else 0
        try:
            start, end = lines[index].split('-->')
            begin, finish = seconds(start), seconds(end.strip().split()[0])
            caption = ' '.join(line.strip() for line in lines[index + 1:] if line.strip())
            if finish <= begin or not caption:
                raise ValueError('字幕段无效')
            units.append({'text': caption, 'timestamp': start.strip().replace('.', ','), 'seconds': begin})
        except (ValueError, IndexError):
            invalid += 1
    return units, invalid


def corpus(root):
    """Read newest files within explicit limits; SRT/TXT twins count once."""
    root = Path(root).resolve()
    inventory, warnings = [], []
    for index, path in enumerate(root.rglob('*')):
        if index >= MAX_ENTRIES:
            warnings.append('目录条目达到扫描上限')
            break
        if path.suffix.lower() not in ('.txt', '.srt') or path.is_symlink():
            continue
        try:
            resolved = path.resolve(strict=True)
            if resolved != path or not resolved.is_relative_to(root) or not resolved.is_file():
                continue
            stat = path.stat()
            relative = path.relative_to(root)
            parts = relative.parts
            # A re-transcription attempt supersedes an older attempt of the same job.
            key = ('job', parts[1], relative.stem) if len(parts) >= 5 and parts[0] == '_jobs' else ('file', str(relative.with_suffix('')))
            inventory.append((stat.st_mtime_ns, path, stat.st_size, key))
        except OSError:
            warnings.append('部分文件在扫描时不可读')
    # Prefer the newest attempt, then SRT over its sibling TXT (regardless of mtime).
    attempts = {}
    for mtime, path, size, key in inventory:
        parent = str(path.parent)
        attempt_key = (key, parent)
        attempts.setdefault(attempt_key, []).append((mtime, path, size))
    chosen = {}
    for (key, parent), group in attempts.items():
        latest = max(row[0] for row in group)
        if key not in chosen or latest > chosen[key][0]:
            chosen[key] = (latest, sorted(group, key=lambda row: row[1].suffix.lower() != '.srt'))
    documents, total_bytes, total_chars, duplicates = [], 0, 0, len(inventory) - len(chosen)
    for _latest, group in sorted(chosen.values(), key=lambda row: row[0], reverse=True):
        if len(documents) >= MAX_FILES:
            warnings.append('语料文件达到 500 份上限')
            break
        for _mtime, path, size in group:
            budget = min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total_bytes)
            if size > budget or budget <= 0:
                warnings.append('部分文件超过单份 4 MiB 或合计 32 MiB 上限')
                continue
            try:
                with path.open('rb') as handle:
                    raw = handle.read(budget + 1)
                if len(raw) > budget:
                    warnings.append('读取时文件增大，已跳过')
                    continue
                text = raw.decode('utf-8-sig')
            except (OSError, UnicodeError):
                warnings.append('部分文件不可读或不是 UTF-8')
                continue
            total_bytes += len(raw)
            units, invalid = caption_units(text, path.suffix.lower())
            if invalid:
                warnings.append('部分 SRT 段落格式或时间无效，已跳过')
            if not units:
                continue
            chars = sum(len(unit['text']) for unit in units)
            if total_chars + chars > MAX_CHARACTERS:
                warnings.append('语料超过 50 万字上限，部分文件未分析')
                continue
            relative = str(path.relative_to(root))
            documents.append({'file': relative, 'account': path.parent.name,
                              'sourceUrl': '/transcripts/' + urllib.parse.quote(relative), 'units': units})
            total_chars += chars
            break
    return {'documents': documents, 'filesScanned': len(documents), 'bytesScanned': total_bytes,
            'characters': total_chars, 'duplicatesSkipped': duplicates,
            'truncated': bool(warnings), 'warnings': sorted(set(warnings))}


class KeywordService:
    def __init__(self, root, project):
        self.root, self.project = Path(root), Path(project)
        self.directory = self.root / 'keywords'
        self.python = self.root / 'tools/keywords-env/bin/python3'
        self.model = self.root / 'tools/keyword-model'
        self.process = None
        self.lock = threading.RLock()
        self.job = read_json(self.directory / 'job.json', {})
        if self.job.get('status') == 'running':
            self.job.update(status='interrupted', error='上次任务被中断，可重新运行')

    def state(self):
        with self.lock:
            if self.process and self.process.poll() is not None:
                code = self.process.returncode
                if code == 0 and self.job.get('action') == 'analyze':
                    output = read_json(self.directory / 'result.json', {})
                    if output.get('mode') != 'keybert' or output.get('generatedAt', '') < self.job.get('startedAt', ''):
                        code = 1
                self.job.update(status='completed' if code == 0 else 'failed', finishedAt=stamp(),
                                error=None if code == 0 else '任务未完成，请查看日志后重试')
                save_json(self.directory / 'job.json', self.job)
                self.process = None
            installed = self.python.is_file() and (self.model / '.verified.json').is_file() and all(
                (self.model / name).is_file() for name in ('model.safetensors', 'tokenizer.json', 'modules.json', '1_Pooling/config.json'))
            result = read_json(self.directory / 'result.json')
            tail = ''
            try:
                with (self.directory / 'worker.log').open('rb') as handle:
                    handle.seek(max(0, os.fstat(handle.fileno()).st_size - 2500))
                    tail = handle.read(2500).decode('utf-8', errors='replace')
            except OSError:
                pass
            return {'installed': installed, 'busy': bool(self.process), 'job': dict(self.job),
                    'result': result, 'log': tail, 'engine': 'KeyBERT 0.9.0',
                    'model': 'paraphrase-multilingual-MiniLM-L12-v2',
                    'canInstall': sys.platform == 'darwin' and os.uname().machine == 'arm64' and (3, 9) <= sys.version_info[:2] <= (3, 11)}

    def start(self, action):
        with self.lock:
            if action == 'cancel':
                self.close()
                return self.state()
            state = self.state()
            if state['busy']:
                return state
            if action == 'install':
                if not state['canInstall']:
                    raise ValueError('关键词组件需要 macOS Apple Silicon 和 Python 3.9—3.11')
                command = [sys.executable, str(self.project / 'scripts/install_keywords.py'), '--apply', '--data-root', str(self.root)]
            elif action == 'analyze':
                if not state['installed']:
                    raise ValueError('请先安装并验证 KeyBERT 和中文模型')
                command = [str(self.python), str(self.project / 'keyword_worker.py'), '--data-root', str(self.root)]
            else:
                raise ValueError('不支持的关键词操作')
            self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.job = {'status': 'running', 'action': action, 'startedAt': stamp(), 'error': None}
            save_json(self.directory / 'job.json', self.job)
            try:
                with (self.directory / 'worker.log').open('wb') as log:
                    self.process = subprocess.Popen(command, cwd=self.project, stdin=subprocess.DEVNULL,
                                                    stdout=log, stderr=log, start_new_session=True,
                                                    env=dict(os.environ, PYTHONUNBUFFERED='1'))
            except OSError:
                self.job.update(status='failed', error='无法启动关键词任务')
                save_json(self.directory / 'job.json', self.job)
                raise
            return self.state()

    def close(self):
        with self.lock:
            if self.process and self.process.poll() is None:
                # Installer children share this dedicated process group.
                os.killpg(self.process.pid, signal.SIGTERM)
                try:
                    self.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(self.process.pid, signal.SIGKILL)
                    self.process.wait(timeout=5)
                self.process = None
                self.job.update(status='interrupted', error='任务已停止，可重新运行')
                save_json(self.directory / 'job.json', self.job)
