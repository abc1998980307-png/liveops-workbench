import http.client
import json
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import keyword_service as keywords
from keyword_service import KeywordService, corpus
import server


class CorpusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def write(self, path, content):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content, encoding='utf-8')
        return file

    def srt(self, text='自然拼读与英语学习'):
        return f'1\n01:02:03,456 --> 01:02:05,000\n{text}\n\n'

    def test_txt_srt_pairs_count_once_and_keep_hour_timestamp(self):
        self.write('主播/场次.srt', self.srt())
        self.write('主播/场次.txt', '文本副本，不得重复计数')
        result = corpus(self.root)
        self.assertEqual(result['filesScanned'], 1)
        self.assertEqual(result['duplicatesSkipped'], 1)
        doc = result['documents'][0]
        self.assertEqual(doc['units'][0]['seconds'], 3723.456)
        self.assertIn('英语学习', doc['units'][0]['text'])
        self.assertTrue(doc['sourceUrl'].startswith('/transcripts/'))

    def test_latest_job_attempt_supersedes_old_text(self):
        old = self.write('_jobs/job/old/主播/场次.srt', self.srt('旧内容'))
        os.utime(old, (1, 1))
        self.write('_jobs/job/new/主播/场次.srt', self.srt('新内容'))
        result = corpus(self.root)
        self.assertEqual(result['filesScanned'], 1)
        self.assertEqual(result['documents'][0]['units'][0]['text'], '新内容')

    def test_malformed_srt_can_fall_back_to_txt_and_reports_partial(self):
        self.write('主播/场次.srt', '1\n00:60:00,000 --> 00:70:00,000\n错误字幕')
        self.write('主播/场次.txt', '保留的文本')
        result = corpus(self.root)
        self.assertTrue(result['truncated'])
        self.assertTrue(result['documents'][0]['file'].endswith('.txt'))
        self.assertEqual(result['documents'][0]['units'][0]['timestamp'], '')

    def test_file_character_and_entry_limits_visible(self):
        self.write('one.txt', '测试语料')
        self.write('two.txt', '另一份语料')
        with mock.patch.object(keywords, 'MAX_FILES', 1):
            data = corpus(self.root)
            self.assertEqual(data['filesScanned'], 1)
            self.assertTrue(data['truncated'])
        with mock.patch.object(keywords, 'MAX_CHARACTERS', 1):
            self.assertTrue(corpus(self.root)['truncated'])
        with mock.patch.object(keywords, 'MAX_ENTRIES', 1):
            self.assertTrue(corpus(self.root)['truncated'])

    def test_symbolic_file_or_parent_is_not_read(self):
        external = self.root.parent / (self.root.name + '-external')
        external.mkdir()
        self.addCleanup(lambda: __import__('shutil').rmtree(external))
        (external / 'secret.txt').write_text('敏感文本')
        (self.root / 'link.txt').symlink_to(external / 'secret.txt')
        (self.root / 'dir').symlink_to(external, target_is_directory=True)
        self.assertEqual(corpus(self.root)['filesScanned'], 0)

    def test_oversized_and_growing_files_are_bounded(self):
        self.write('one.txt', 'x' * 30)
        with mock.patch.object(keywords, 'MAX_FILE_BYTES', 10):
            result = corpus(self.root)
            self.assertEqual(result['filesScanned'], 0)
            self.assertTrue(result['truncated'])
        original = Path.open
        def grow(path, *args, **kwargs):
            if args == ('rb',):
                with original(path, 'a') as file: file.write('x' * 500)
            return original(path, *args, **kwargs)
        with mock.patch.object(keywords, 'MAX_FILE_BYTES', 100), mock.patch.object(Path, 'open', grow):
            result = corpus(self.root)
        self.assertEqual(result['filesScanned'], 0)
        self.assertTrue(result['truncated'])


class KeywordJobsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.service = KeywordService(self.root, Path(__file__).resolve().parents[1])
        self.service.python.parent.mkdir(parents=True)
        self.service.python.touch()
        keywords.save_json(self.service.model / '.verified.json', {'verifiedAt':'fixture'})
        for name in ('model.safetensors','tokenizer.json','modules.json','1_Pooling/config.json'):
            path = self.service.model / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()

    def test_repeated_actions_reuse_process_and_do_not_change_recording(self):
        child = mock.Mock()
        child.poll.return_value = None
        with mock.patch.object(keywords.subprocess, 'Popen', return_value=child) as spawn:
            first = self.service.start('analyze')
            self.assertTrue(first['busy'])
            self.service.start('analyze')
            spawn.assert_called_once()
            self.assertIn('keyword_worker.py', str(spawn.call_args.args[0]))
        child.poll.return_value = 1
        child.returncode = 1
        self.assertEqual(self.service.state()['job']['status'], 'failed')

    def test_interrupt_and_missing_install(self):
        keywords.save_json(self.service.directory / 'job.json', {'status':'running'})
        other = KeywordService(self.root, self.root)
        self.assertEqual(other.state()['job']['status'], 'interrupted')
        self.service.python.unlink()
        with self.assertRaisesRegex(ValueError, '先安装'):
            self.service.start('analyze')

    def test_failure_keeps_previous_result(self):
        keywords.save_json(self.service.directory / 'result.json', {'keywords':[{'term':'旧结果'}]})
        child = mock.Mock(returncode=1)
        child.poll.return_value = 1
        self.service.process = child
        state = self.service.state()
        self.assertEqual(state['result']['keywords'][0]['term'], '旧结果')
        self.assertEqual(state['job']['status'], 'failed')

    def test_success_without_fresh_result_is_failure(self):
        child = mock.Mock(returncode=0)
        child.poll.return_value = 0
        self.service.process = child
        self.service.job = {'action':'analyze','startedAt':keywords.stamp()}
        self.assertEqual(self.service.state()['job']['status'], 'failed')

    def test_cancel_stops_only_owned_process_group_and_preserves_result(self):
        child = mock.Mock(pid=999999)
        child.poll.return_value = None
        self.service.process = child
        with mock.patch.object(keywords.os, 'killpg') as kill:
            self.service.start('cancel')
            kill.assert_called_once_with(child.pid, keywords.signal.SIGTERM)
        self.assertEqual(self.service.state()['job']['status'], 'interrupted')


class KeywordHTTPTests(unittest.TestCase):
    def test_local_read_start_and_rejection(self):
        fake = mock.Mock()
        fake.state.return_value = {'installed':False, 'busy':False}
        fake.start.return_value = {'busy':True}
        httpd = server.LocalHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        port = httpd.server_port
        def request(method, path, payload=None, extra=None):
            connection = http.client.HTTPConnection('127.0.0.1',port)
            headers = {'Content-Type':'application/json', **(extra or {})}
            connection.request(method,path,body=json.dumps(payload) if payload is not None else None,headers=headers)
            response = connection.getresponse(); data=response.read(); connection.close()
            return response.status,json.loads(data)
        with mock.patch.object(server,'PORT',port), mock.patch.object(server,'KEYWORDS',fake):
            self.assertEqual(request('GET','/api/transcript-keywords')[0],200)
            self.assertEqual(request('POST','/api/transcript-keywords/analyze',{})[0],200)
            fake.start.assert_called_once_with('analyze')
            self.assertEqual(request('POST','/api/transcript-keywords/install',{'root':'/tmp'})[0],400)
            self.assertEqual(request('GET','/api/transcript-keywords',extra={'Host':'attacker.test'})[0],403)
            self.assertEqual(request('POST','/api/transcript-keywords/analyze',{}, {'Origin':'https://attacker.test'})[0],403)


if __name__ == '__main__':
    unittest.main()
