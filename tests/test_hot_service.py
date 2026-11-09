import http.client
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from hot_service import HotService, HotServiceError
from recorder_service import RecorderManager
from scripts import install
import server


class HotServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.service = HotService(self.root, Path(__file__).resolve().parents[1])

    def test_only_loopback_service_addresses_allowed(self):
        for url in ('https://127.0.0.1', 'http://remote.test', 'http://user@localhost', 'http://localhost/path'):
            with self.assertRaises(ValueError):
                HotService(self.root, self.root, url)

    def test_state_does_not_fetch_upstream_or_start_anything(self):
        with mock.patch.object(self.service, '_request', return_value={
                'service':'liveops-dailyhot', 'instance':'foreign', 'version':'2.0.8'}) as request, \
                mock.patch('hot_service.subprocess.Popen') as spawn:
            state = self.service.state()
        self.assertTrue(state['connected'])
        self.assertFalse(state['managed'])
        self.assertIsNone(state['dataReady'])
        self.assertFalse(state['canStop'])
        spawn.assert_not_called()
        self.assertEqual(request.call_args.args[0], '/__liveops_health')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_legacy_service_recognized_but_not_stopped(self):
        with mock.patch.object(self.service, '_request', side_effect=[
                ValueError('html'), {'code':200,'routes':[{'name':'douyin','path':'/douyin'}]},
                ValueError('html'), {'code':200,'routes':[{'name':'douyin','path':'/douyin'}]}]), \
                mock.patch('hot_service.os.kill') as kill:
            self.assertTrue(self.service.state()['connected'])
            with self.assertRaisesRegex(HotServiceError, '其他工具'):
                self.service.stop()
            kill.assert_not_called()

    def test_pid_reuse_is_not_owned(self):
        RecorderManager._write(self.service.owner_file, {'pid':98765,'identity':'old','instance':'a'*32,'port':16688})
        with mock.patch.object(RecorderManager, '_identity', return_value='new process'):
            self.assertIsNone(self.service._owned_pid())

    def test_live_ownership_requires_instance_port_and_arguments(self):
        identity = 'Mon Nov 9 ' + str(self.service.runner) + ' ' + str(self.service.plugin) + ' 16688 ' + 'a'*32
        owner = {'pid':98765, 'identity':identity, 'instance':'a'*32, 'port':16688}
        RecorderManager._write(self.service.owner_file, owner)
        with mock.patch.object(RecorderManager, '_identity', return_value=identity):
            self.assertEqual(self.service._owned_pid(), 98765)
            RecorderManager._write(self.service.owner_file, {**owner,'port':16689})
            self.assertIsNone(self.service._owned_pid())

    def test_existing_service_start_never_spawns_duplicate(self):
        with mock.patch.object(self.service, '_probe', return_value={'service':'dailyhot-api','legacy':True}), \
                mock.patch('hot_service.subprocess.Popen') as spawn:
            self.assertTrue(self.service.start()['connected'])
            spawn.assert_not_called()

    def test_busy_port_never_spawns_process(self):
        with mock.patch.object(self.service, '_probe', side_effect=OSError('no service')), \
                mock.patch.object(self.service, '_port_busy', return_value=True), \
                mock.patch('hot_service.subprocess.Popen') as spawn:
            with self.assertRaisesRegex(HotServiceError, '端口被占用'):
                self.service.start()
            spawn.assert_not_called()

    def test_configuration_separate_from_install_directory_and_pending_restart(self):
        self.service.settings_file.parent.mkdir(parents=True)
        self.service.settings_file.write_text('CACHE_TTL=600\nREQUEST_TIMEOUT=9000\nFILTER_WEIBO_ADVERTISEMENT=true\n')
        settings = self.service.desired_settings()
        self.assertEqual(settings, {'cacheTTL':600,'requestTimeout':9000,'filterWeiboAds':True})
        self.assertFalse(self.service.plugin.exists())
        with mock.patch.object(self.service, '_probe', return_value={'service':'liveops-dailyhot','settings':settings}):
            self.assertFalse(self.service.state()['pendingRestart'])
        with mock.patch.object(self.service, '_probe', return_value={'service':'liveops-dailyhot','settings':{'cacheTTL':120}}):
            self.assertTrue(self.service.state()['pendingRestart'])
        self.service.settings_file.write_text('CACHE_TTL=-1')
        with self.assertRaises(ValueError):
            self.service.desired_settings()

    def test_upstream_failure_does_not_turn_local_service_offline(self):
        with mock.patch.object(self.service, '_request', side_effect=OSError('upstream timeout')):
            with self.assertRaises(HotServiceError):
                self.service.hotwords(50)
        with mock.patch.object(self.service, '_probe', return_value={'service':'liveops-dailyhot'}):
            state = self.service.state()
            self.assertTrue(state['connected'])
            self.assertFalse(state['dataReady'])
            self.assertIn('upstream timeout', state['dataError'])

    def test_read_honors_cache_and_validates_actual_douyin_response(self):
        fixture = {'code':200,'name':'douyin','data':[{'title':'合成热点','hot':1}], 'updateTime':'2026-11-09T12:00:00Z'}
        with mock.patch.object(self.service, '_request', return_value=fixture) as request:
            self.assertEqual(self.service.hotwords(50), fixture)
            self.assertEqual(request.call_args.args[0], '/douyin?limit=50')
        for value in (0, 101, True, '50'):
            with self.assertRaises(ValueError):
                self.service.hotwords(value)
        for fixture in ({'code':200,'data':[]}, {'code':200,'name':'douyin','data':[{'wrong':'field'}]}):
            with mock.patch.object(self.service, '_request', return_value=fixture), self.assertRaises(HotServiceError):
                self.service.hotwords(50)

    def test_logs_are_bounded(self):
        self.service.log_file.parent.mkdir(parents=True)
        self.service.log_file.write_text('x'*10000+'end')
        self.assertEqual(len(self.service.log_tail()),6000)
        self.assertTrue(self.service.log_tail().endswith('end'))

    def test_hot_install_dependency_and_broken_existing_protection(self):
        self.assertEqual(install.expand_components(['dailyhot']), ['node','dailyhot'])
        target = self.root/'plugins/dailyhot-api'
        target.mkdir(parents=True)
        (target/'package.json').write_text('{"name":"dailyhot-api","version":"old"}')
        with mock.patch.object(install, 'download') as download, self.assertRaises(install.InstallError):
            install.Installer(self.root,self.root/'cache').install('dailyhot')
        download.assert_not_called()
        self.assertEqual(json.loads((target/'package.json').read_text())['version'],'old')


class HotProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        self.service = HotService(root, Path(__file__).resolve().parents[1], 'http://127.0.0.1:' + str(port))
        self.service.node.parent.mkdir(parents=True)
        self.service.plugin.mkdir(parents=True)
        self.installed = mock.patch.object(self.service, 'installed', return_value=True)
        self.installed.start()
        self.addCleanup(self.installed.stop)
        self.addCleanup(self.service.stop)
        self.service.node.write_text('#!' + sys.executable + '\n' + """
import json,os,sys
from http.server import HTTPServer,BaseHTTPRequestHandler
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_GET(self):
  body=json.dumps({'service':'liveops-dailyhot','instance':sys.argv[4], 'version':'fixture',
   'settings':{'cacheTTL':int(os.environ['CACHE_TTL']), 'requestTimeout':int(os.environ['REQUEST_TIMEOUT']),
   'filterWeiboAds':os.environ['FILTER_WEIBO_ADVERTISEMENT']=='true'}}).encode()
  self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
HTTPServer(('127.0.0.1',int(sys.argv[3])),Handler).serve_forever()
""")
        self.service.node.chmod(0o755)

    def test_real_process_lifecycle_and_restored_ownership(self):
        try:
            first = self.service.start()
        except HotServiceError as error:
            self.fail(f"Synthetic child startup failed: {error}; state={self.service.state()}")
        self.assertTrue(first['ownedConnection'])
        self.assertFalse(first['pendingRestart'])
        self.assertEqual(self.service.start()['pid'], first['pid'])
        restored = HotService(self.service.root, self.service.project, self.service.base_url)
        self.assertTrue(restored.state()['managed'])
        self.service.settings_file.write_text('CACHE_TTL=600\nREQUEST_TIMEOUT=7000\nFILTER_WEIBO_ADVERTISEMENT=true\n')
        self.assertTrue(self.service.state()['pendingRestart'])
        second = self.service.restart()
        self.assertNotEqual(second['pid'], first['pid'])
        self.assertFalse(second['pendingRestart'])
        self.assertEqual(second['settings']['cacheTTL'],600)
        self.assertFalse(self.service.stop()['connected'])
        self.assertFalse(self.service.owner_file.exists())

    def test_parallel_managers_do_not_duplicate_child(self):
        with self.service.operation():
            other = HotService(self.service.root,self.service.project,self.service.base_url)
            with self.assertRaisesRegex(HotServiceError,'另一个'):
                other.start()
        self.assertFalse(self.service.owner_file.exists())


class HotHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = server.LocalHTTPServer(('127.0.0.1',0),server.Handler)
        cls.port = cls.http.server_address[1]
        cls.original_port = server.PORT
        server.PORT = cls.port
        cls.thread = threading.Thread(target=cls.http.serve_forever,daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        server.PORT = cls.original_port

    def setUp(self):
        self.patch = mock.patch.object(server,'HOTWORDS')
        self.hot = self.patch.start()
        self.addCleanup(self.patch.stop)
        self.hot.state.return_value = {'connected':True,'dataReady':None}
        for name in ('start','stop','restart'):
            getattr(self.hot,name).return_value = {'ok':True}
        self.hot.hotwords.return_value = {'code':200,'data':[]}

    def request(self, path, method='GET', payload=None, headers=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.port,timeout=5)
        conn.request(method,path,json.dumps(payload) if method=='POST' else None,
                     {'Content-Type':'application/json',**(headers or {})})
        response=conn.getresponse()
        result=(response.status,json.loads(response.read()))
        conn.close()
        return result

    def test_actions_and_read(self):
        self.assertEqual(self.request('/api/hotwords/state')[0],200)
        for action in ('start','stop','restart'):
            self.assertEqual(self.request('/api/hotwords/'+action,'POST',{})[0],200)
            getattr(self.hot,action).assert_called_once_with()
        self.assertEqual(self.request('/api/hotwords?limit=25')[0],200)
        self.hot.hotwords.assert_called_with(25)
        with mock.patch.object(server,'DEPENDENCIES') as dependencies:
            dependencies.install.return_value={'busy':True}
            self.assertEqual(self.request('/api/hotwords/install','POST',{})[0],200)
            dependencies.install.assert_called_once_with(hotwords_only=True)

    def test_rejects_foreign_origins_hosts_and_custom_arguments(self):
        for action in ('install','start','stop','restart'):
            for header in ({'Origin':'https://foreign.test'}, {'Host':'foreign.test'}):
                self.assertEqual(self.request('/api/hotwords/'+action,'POST',{},header)[0],403)
            for payload in ([],{'command':'anything'},{'port':12345}):
                self.assertEqual(self.request('/api/hotwords/'+action,'POST',payload)[0],400)
        for path in ('/api/hotwords/state','/api/hotwords'):
            self.assertEqual(self.request(path,headers={'Host':'foreign.test'})[0],403)
        self.hot.start.assert_not_called()
        self.hot.hotwords.assert_not_called()

    def test_invalid_limit_and_failed_data_have_explicit_errors(self):
        self.assertEqual(self.request('/api/hotwords?limit=oops')[0],400)
        self.hot.hotwords.side_effect=HotServiceError('upstream')
        status,body=self.request('/api/hotwords')
        self.assertEqual(status,503)
        self.assertEqual(body['data'],[])
        self.assertIn('upstream',body['error'])


if __name__=='__main__':
    unittest.main()
